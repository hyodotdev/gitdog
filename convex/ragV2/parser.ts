/**
 * Code parser for extracting function/class-level chunks
 * Uses regex patterns for TypeScript/JavaScript/Python
 *
 * Future: Replace with Tree-sitter for better accuracy
 */

import {
  getUtf8ByteLength,
  MAX_RAG_CHUNK_CODE_BYTES,
  MAX_RAG_DOCSTRING_BYTES,
  MAX_RAG_EXPORTS_BYTES,
  MAX_RAG_IMPORTS_BYTES,
  MAX_RAG_LANGUAGE_BYTES,
  MAX_RAG_METADATA_ITEM_BYTES,
  MAX_RAG_PATH_BYTES,
  MAX_RAG_RETRIEVAL_TEXT_BYTES,
  MAX_RAG_SEARCHABLE_TEXT_BYTES,
  MAX_RAG_SIGNATURE_BYTES,
  MAX_RAG_SYMBOLS_BYTES,
  RAG_RETRIEVAL_OVERLAP_BYTES,
  splitUtf8,
  truncateUtf8,
  truncateUtf8Suffix,
} from "./chunkBudget";

export type CodeChunk = {
  chunkId: string;
  path: string;
  language: string;
  code: string;
  retrievalText?: string;
  startLine: number;
  endLine: number;
  symbols: string[];
  imports?: string[];
  exports?: string[];
  signature?: string;
  docstring?: string;
  contentHash: string;
  searchableText: string;
};

function contentHash(content: string): string {
  let hash = 2166136261; // FNV offset basis

  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash +=
      (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Deterministic 128-bit chunk identity. Four independently mixed lanes avoid
 * the practical birthday collisions of the former 32-bit FNV chunk IDs while
 * keeping synchronous parsing and stable incremental identities.
 */
export function stableChunkId(content: string): string {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;

  for (let index = 0; index < content.length; index++) {
    const codeUnit = content.charCodeAt(index);
    h1 = h2 ^ Math.imul(h1 ^ codeUnit, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ codeUnit, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ codeUnit, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ codeUnit, 2716044179);
  }

  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;

  return [h1, h2, h3, h4]
    .map((lane) => (lane >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

// Bound per-file parsing memory. The semantic parsers emit one overlapping
// window per declaration, so a large or declaration-dense source (for example
// a generated types or protocol file) can build an O(declarations x window)
// raw chunk array that exhausts the action's 64 MB heap before normalization
// can trim it. Above these bounds, chunking falls back to linear fixed-line
// windows whose peak memory stays proportional to the file size.
const MAX_SEMANTIC_PARSE_BYTES = 256 * 1024;
const MAX_SEMANTIC_PARSE_LINES = 5000;

// The size bounds above are a cheap pre-filter, but a file can stay under them
// and still expand into tens of MB of raw chunks when it is dense with
// declarations (each copies an overlapping window plus a second searchable-text
// copy). These output bounds cap the semantic array while it is being built; if
// either is crossed mid-parse, the partial chunks are discarded and the whole
// file is re-chunked with the linear fixed-line windower.
const MAX_SEMANTIC_CHUNK_COUNT = 1200;
const MAX_SEMANTIC_CHUNK_CODE_CHARS = 2 * 1024 * 1024;

const FIXED_CHUNK_LINE_COUNT = 150;
const FIXED_CHUNK_OVERLAP_LINE_COUNT = 30;

function createFixedLineChunks(
  path: string,
  language: string,
  lines: ReadonlyArray<string>,
  startLineIndex = 0,
  endLineIndex = lines.length,
  imports?: ReadonlyArray<string>,
): Array<CodeChunk> {
  const chunks: Array<CodeChunk> = [];
  const step = FIXED_CHUNK_LINE_COUNT - FIXED_CHUNK_OVERLAP_LINE_COUNT;

  for (let start = startLineIndex; start < endLineIndex; start += step) {
    const end = Math.min(start + FIXED_CHUNK_LINE_COUNT, endLineIndex);
    const chunkCode = lines.slice(start, end).join("\n");
    chunks.push({
      chunkId: stableChunkId(`${path}#${start + 1}#${end}`),
      path,
      language,
      code: chunkCode,
      startLine: start + 1,
      endLine: end,
      symbols: [],
      imports: imports && imports.length > 0 ? [...imports] : undefined,
      contentHash: contentHash(chunkCode),
      searchableText: chunkCode,
    });

    if (end === endLineIndex) {
      break;
    }
  }

  return chunks;
}

/** Add bounded fixed windows for every line not covered by semantic chunks. */
function fillUncoveredSourceLines(
  path: string,
  language: string,
  lines: ReadonlyArray<string>,
  chunks: ReadonlyArray<CodeChunk>,
  imports?: ReadonlyArray<string>,
): Array<CodeChunk> {
  if (chunks.length === 0) {
    return createFixedLineChunks(
      path,
      language,
      lines,
      0,
      lines.length,
      imports,
    );
  }

  const coveredLines = new Uint8Array(lines.length);
  for (const chunk of chunks) {
    const start = Math.min(Math.max(chunk.startLine - 1, 0), lines.length);
    const end = Math.min(Math.max(chunk.endLine, start), lines.length);
    coveredLines.fill(1, start, end);
  }

  const uncoveredChunks: Array<CodeChunk> = [];
  let lineIndex = 0;
  while (lineIndex < lines.length) {
    if (coveredLines[lineIndex] === 1) {
      lineIndex++;
      continue;
    }

    const gapStart = lineIndex;
    while (lineIndex < lines.length && coveredLines[lineIndex] === 0) {
      lineIndex++;
    }
    uncoveredChunks.push(
      ...createFixedLineChunks(
        path,
        language,
        lines,
        gapStart,
        lineIndex,
        imports,
      ),
    );
  }

  return [...chunks, ...uncoveredChunks].sort(
    (left, right) =>
      left.startLine - right.startLine ||
      left.endLine - right.endLine ||
      left.chunkId.localeCompare(right.chunkId),
  );
}

function normalizeStringList(
  values: ReadonlyArray<string> | undefined,
  maxBytes: number,
): Array<string> | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }

  const normalized: Array<string> = [];
  let usedBytes = 0;
  for (const value of values) {
    const separatorBytes = normalized.length > 0 ? 1 : 0;
    const availableBytes = maxBytes - usedBytes - separatorBytes;
    if (availableBytes < 1) {
      break;
    }
    const item = truncateUtf8(
      value,
      Math.min(availableBytes, MAX_RAG_METADATA_ITEM_BYTES),
    );
    if (item.length === 0) {
      continue;
    }
    normalized.push(item);
    usedBytes += separatorBytes + getUtf8ByteLength(item);
  }
  return normalized.length > 0 ? normalized : undefined;
}

function countNewlines(value: string): number {
  let count = 0;
  for (const character of value) {
    if (character === "\n") {
      count++;
    }
  }
  return count;
}

/**
 * Bound every persisted field and split large or single-line parser chunks
 * without dropping source text. Source files may be much larger than one
 * Convex document even when their character count looks small in UTF-16.
 */
export function normalizeCodeChunksForStorage(
  chunks: ReadonlyArray<CodeChunk>,
): Array<CodeChunk> {
  return chunks.flatMap((chunk) => {
    const path = truncateUtf8(chunk.path, MAX_RAG_PATH_BYTES);
    const language = truncateUtf8(chunk.language, MAX_RAG_LANGUAGE_BYTES);
    const symbols =
      normalizeStringList(chunk.symbols, MAX_RAG_SYMBOLS_BYTES) ?? [];
    const imports = normalizeStringList(chunk.imports, MAX_RAG_IMPORTS_BYTES);
    const exports = normalizeStringList(chunk.exports, MAX_RAG_EXPORTS_BYTES);
    const signature = chunk.signature
      ? truncateUtf8(chunk.signature, MAX_RAG_SIGNATURE_BYTES)
      : undefined;
    const docstring = chunk.docstring
      ? truncateUtf8(chunk.docstring, MAX_RAG_DOCSTRING_BYTES)
      : undefined;
    const codeParts = splitUtf8(chunk.code, MAX_RAG_CHUNK_CODE_BYTES);
    let nextStartLine = chunk.startLine;

    return codeParts.map((code, partIndex) => {
      const startLine = nextStartLine;
      const newlineCount = countNewlines(code);
      const endLine = Math.min(chunk.endLine, startLine + newlineCount);
      nextStartLine = endLine;
      const retrievalText = truncateUtf8(
        `${truncateUtf8Suffix(
          codeParts[partIndex - 1] ?? "",
          RAG_RETRIEVAL_OVERLAP_BYTES,
        )}${code}${truncateUtf8(
          codeParts[partIndex + 1] ?? "",
          RAG_RETRIEVAL_OVERLAP_BYTES,
        )}`,
        MAX_RAG_RETRIEVAL_TEXT_BYTES,
      );
      const searchableText = truncateUtf8(
        [symbols.join(" "), signature, docstring, retrievalText]
          .filter(Boolean)
          .join(" "),
        MAX_RAG_SEARCHABLE_TEXT_BYTES,
      );

      return {
        ...chunk,
        chunkId:
          codeParts.length === 1
            ? chunk.chunkId
            : stableChunkId(`${chunk.chunkId}#part:${partIndex}`),
        path,
        language,
        code,
        retrievalText,
        startLine,
        endLine,
        symbols,
        imports,
        exports,
        signature,
        docstring,
        contentHash:
          codeParts.length === 1 ? chunk.contentHash : contentHash(code),
        searchableText,
      };
    });
  });
}

/**
 * Parse TypeScript/JavaScript code into chunks
 */
function parseTypeScript(
  path: string,
  code: string,
  language: "typescript" | "javascript",
): CodeChunk[] {
  const lines = code.split("\n");
  const chunks: CodeChunk[] = [];
  let chunkCodeChars = 0;

  // Pattern for functions and classes
  const functionRegex = /^(\s*)(export\s+)?(async\s+)?function\s+(\w+)/;
  const arrowFunctionRegex =
    /^(\s*)(export\s+)?const\s+(\w+)\s*=\s*(async\s*)?\(/;
  const classRegex = /^(\s*)(export\s+)?(abstract\s+)?class\s+(\w+)/;
  const methodRegex =
    /^\s+(public|private|protected|static|\s)*(async\s+)?(\w+)\s*\(/;

  // Extract imports
  const imports: string[] = [];
  const importRegex = /^import\s+.*\s+from\s+['"]([^'"]+)['"]/;
  for (const line of lines) {
    const match = line.match(importRegex);
    if (match) {
      imports.push(match[1]);
    }
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Check for function/class/method
    const funcMatch = line.match(functionRegex);
    const arrowMatch = line.match(arrowFunctionRegex);
    const classMatch = line.match(classRegex);
    const methodMatch = line.match(methodRegex);

    if (funcMatch || arrowMatch || classMatch || methodMatch) {
      const startLine = i + 1;
      const isExport = line.includes("export");
      const symbolName =
        funcMatch?.[4] ||
        arrowMatch?.[3] ||
        classMatch?.[4] ||
        methodMatch?.[3];

      if (!symbolName) {
        i++;
        continue;
      }

      // Find docstring (look back up to 10 lines)
      let docstring: string | undefined;
      for (let j = i - 1; j >= Math.max(0, i - 10); j--) {
        const prevLine = lines[j].trim();
        if (
          prevLine.startsWith("/**") ||
          prevLine.startsWith("/*") ||
          prevLine.startsWith("//")
        ) {
          docstring = lines
            .slice(Math.max(0, j - 5), i)
            .join("\n")
            .trim();
          break;
        }
      }

      // Find end of function/class (matching braces)
      let braceCount = 0;
      let endLine = i;
      let started = false;

      for (let j = i; j < lines.length; j++) {
        const currentLine = lines[j];

        for (const char of currentLine) {
          if (char === "{") {
            braceCount++;
            started = true;
          } else if (char === "}") {
            braceCount--;
          }
        }

        if (started && braceCount === 0) {
          endLine = j + 1;
          break;
        }

        // Fallback: max 300 lines per chunk
        if (j - i > 300) {
          endLine = j;
          break;
        }
      }

      // Extract chunk with overlap (20 lines before and after)
      const overlapStart = Math.max(0, startLine - 1 - 20);
      const overlapEnd = Math.min(lines.length, endLine + 20);
      const chunkCode = lines.slice(overlapStart, overlapEnd).join("\n");

      // Create chunk
      const chunkId = stableChunkId(`${path}#${startLine}#${endLine}`);
      const signature = lines[i].trim();
      const chunkContentHash = contentHash(chunkCode);

      // Searchable text: symbols + signature + code
      const searchableText = [
        symbolName,
        signature,
        docstring || "",
        chunkCode,
      ].join(" ");

      chunks.push({
        chunkId,
        path,
        language,
        code: chunkCode,
        startLine: overlapStart + 1,
        endLine: overlapEnd,
        symbols: [symbolName],
        imports: imports.length > 0 ? imports : undefined,
        exports: isExport ? [symbolName] : undefined,
        signature,
        docstring,
        contentHash: chunkContentHash,
        searchableText,
      });

      chunkCodeChars += chunkCode.length;
      if (
        chunks.length > MAX_SEMANTIC_CHUNK_COUNT ||
        chunkCodeChars > MAX_SEMANTIC_CHUNK_CODE_CHARS
      ) {
        return createFixedLineChunks(path, language, lines);
      }

      i = endLine;
    } else {
      i++;
    }
  }

  return fillUncoveredSourceLines(path, language, lines, chunks, imports);
}

/**
 * Parse Python code into chunks
 */
function parsePython(path: string, code: string): CodeChunk[] {
  const lines = code.split("\n");
  const chunks: CodeChunk[] = [];
  let chunkCodeChars = 0;

  // Pattern for functions and classes
  const functionRegex = /^(\s*)def\s+(\w+)\s*\(/;
  const classRegex = /^(\s*)class\s+(\w+)/;

  // Extract imports
  const imports: string[] = [];
  const importRegex = /^(from\s+\S+\s+)?import\s+(.+)$/;
  for (const line of lines) {
    const match = line.match(importRegex);
    if (match) {
      imports.push(match[2].split(",")[0].trim());
    }
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const funcMatch = line.match(functionRegex);
    const classMatch = line.match(classRegex);

    if (funcMatch || classMatch) {
      const startLine = i + 1;
      const indent = (funcMatch?.[1] || classMatch?.[1] || "").length;
      const symbolName = funcMatch?.[2] || classMatch?.[2];

      if (!symbolName) {
        i++;
        continue;
      }

      // Find docstring
      let docstring: string | undefined;
      if (i + 1 < lines.length && lines[i + 1].trim().startsWith('"""')) {
        let docEnd = i + 1;
        for (let j = i + 2; j < lines.length; j++) {
          if (lines[j].includes('"""')) {
            docEnd = j;
            break;
          }
        }
        docstring = lines.slice(i + 1, docEnd + 1).join("\n");
      }

      // Find end (next line with same or less indentation)
      let endLine = i + 1;
      for (let j = i + 1; j < lines.length; j++) {
        const currentLine = lines[j];
        if (currentLine.trim() === "") continue;

        const currentIndent =
          currentLine.length - currentLine.trimStart().length;
        if (currentIndent <= indent && currentLine.trim() !== "") {
          endLine = j;
          break;
        }

        if (j === lines.length - 1) {
          endLine = j + 1;
        }
      }

      // Extract chunk with overlap
      const overlapStart = Math.max(0, startLine - 1 - 20);
      const overlapEnd = Math.min(lines.length, endLine + 20);
      const chunkCode = lines.slice(overlapStart, overlapEnd).join("\n");

      const chunkId = stableChunkId(`${path}#${startLine}#${endLine}`);
      const signature = lines[i].trim();
      const chunkContentHash = contentHash(chunkCode);

      const searchableText = [
        symbolName,
        signature,
        docstring || "",
        chunkCode,
      ].join(" ");

      chunks.push({
        chunkId,
        path,
        language: "python",
        code: chunkCode,
        startLine: overlapStart + 1,
        endLine: overlapEnd,
        symbols: [symbolName],
        imports: imports.length > 0 ? imports : undefined,
        signature,
        docstring,
        contentHash: chunkContentHash,
        searchableText,
      });

      chunkCodeChars += chunkCode.length;
      if (
        chunks.length > MAX_SEMANTIC_CHUNK_COUNT ||
        chunkCodeChars > MAX_SEMANTIC_CHUNK_CODE_CHARS
      ) {
        return createFixedLineChunks(path, "python", lines);
      }

      i = endLine;
    } else {
      i++;
    }
  }

  return fillUncoveredSourceLines(path, "python", lines, chunks, imports);
}

/**
 * Main parser entry point
 */
export function parseCodeIntoChunks(
  path: string,
  code: string,
  language?: string,
): CodeChunk[] {
  // Detect language from extension if not provided
  if (!language) {
    if (
      path.endsWith(".ts") ||
      path.endsWith(".tsx") ||
      path.endsWith(".js") ||
      path.endsWith(".jsx")
    ) {
      language = "typescript";
    } else if (path.endsWith(".py")) {
      language = "python";
    } else if (path.endsWith(".swift")) {
      language = "swift";
    } else if (path.endsWith(".kt") || path.endsWith(".kts")) {
      language = "kotlin";
    } else {
      // Default to fixed-size chunks for unknown languages
      language = "unknown";
    }
  }

  const normalizedLanguage = language.trim().toLowerCase();

  // Large or declaration-dense files would make the semantic parsers build an
  // overlapping window per declaration and exhaust the action heap, so bound
  // them to linear fixed-line chunking before dispatching by language.
  const sourceLines = code.split("\n");
  if (
    code.length > MAX_SEMANTIC_PARSE_BYTES ||
    sourceLines.length > MAX_SEMANTIC_PARSE_LINES
  ) {
    return createFixedLineChunks(path, normalizedLanguage, sourceLines);
  }

  // Parse based on language
  switch (normalizedLanguage) {
    case "typescript":
    case "javascript":
      return parseTypeScript(path, code, normalizedLanguage);
    case "python":
      return parsePython(path, code);
    default: {
      // Fixed-size chunks for unsupported languages
      return createFixedLineChunks(path, normalizedLanguage, sourceLines);
    }
  }
}
