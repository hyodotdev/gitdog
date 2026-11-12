/**
 * Tool executors - Implement actual tool functionality
 */

import type { ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { EmbeddingDataProvenance } from "../legacyEmbeddings";
import { requireStrictCurrentAiLegalAttestation } from "../legalAttestation";

export const SEARCH_CODE_PAGE_SIZE = 64;
export const SEARCH_CODE_MAX_PAGES = 64;
export const SEARCH_CODE_MAX_SCANNED_CHUNKS =
  SEARCH_CODE_PAGE_SIZE * SEARCH_CODE_MAX_PAGES;

const REPOSITORY_ACCESS_CHANGED_TOOL_ERROR =
  "Error executing tool: repository access or indexed version changed.";

async function getToolAccessSnapshot(
  ctx: ActionCtx,
  repositoryId: Id<"repositories">,
  expectedIndexVersion?: number,
): Promise<{ indexVersion: number } | null> {
  return await ctx.runQuery(
    internal.repositories.internalQuery.getAiAccessSnapshot,
    { repositoryId, expectedIndexVersion },
  );
}

export type ToolInput =
  | {
      name: "hybrid_search";
      input: {
        query: string;
        topK?: number;
        language?: string[];
      };
    }
  | {
      name: "search_code";
      input: {
        pattern: string;
        file_pattern?: string;
        case_sensitive?: boolean;
      };
    }
  | {
      name: "read_file";
      input: {
        path: string;
        start_line?: number;
        end_line?: number;
      };
    }
  | {
      name: "list_directory";
      input: {
        path: string;
        pattern?: string;
        recursive?: boolean;
      };
    };

/**
 * Execute a tool and return the result as a string
 */
export async function executeTool(
  ctx: ActionCtx,
  repositoryId: Id<"repositories">,
  tool: ToolInput,
  indexVersion?: number,
  embeddingDataProvenance: EmbeddingDataProvenance = "private_user_input",
  requestedByUserId?: Id<"users">,
): Promise<string> {
  if (requestedByUserId) {
    await requireStrictCurrentAiLegalAttestation(ctx, requestedByUserId);
  }
  const access = await getToolAccessSnapshot(ctx, repositoryId, indexVersion);
  if (!access) {
    return REPOSITORY_ACCESS_CHANGED_TOOL_ERROR;
  }

  let result: string;
  switch (tool.name) {
    case "hybrid_search":
      result = await executeHybridSearch(
        ctx,
        repositoryId,
        tool.input,
        access.indexVersion,
        embeddingDataProvenance,
        requestedByUserId,
      );
      break;
    case "search_code":
      result = await executeSearchCode(
        ctx,
        repositoryId,
        tool.input,
        access.indexVersion,
      );
      break;
    case "read_file":
      result = await executeReadFile(
        ctx,
        repositoryId,
        tool.input,
        access.indexVersion,
      );
      break;
    case "list_directory":
      result = await executeListDirectory(
        ctx,
        repositoryId,
        tool.input,
        access.indexVersion,
      );
      break;
    default:
      result = "Unknown tool";
  }

  const currentAccess = await getToolAccessSnapshot(
    ctx,
    repositoryId,
    access.indexVersion,
  );
  if (requestedByUserId) {
    await requireStrictCurrentAiLegalAttestation(ctx, requestedByUserId);
  }
  return currentAccess ? result : REPOSITORY_ACCESS_CHANGED_TOOL_ERROR;
}

/**
 * Ranked keyword search over indexed code chunks (RAG V2)
 */
async function executeHybridSearch(
  ctx: ActionCtx,
  repositoryId: Id<"repositories">,
  input: { query: string; topK?: number; language?: string[] },
  indexVersion?: number,
  embeddingDataProvenance: EmbeddingDataProvenance = "private_user_input",
  requestedByUserId?: Id<"users">,
): Promise<string> {
  try {
    if (requestedByUserId) {
      await requireStrictCurrentAiLegalAttestation(ctx, requestedByUserId);
    }
    const results = await ctx.runAction(internal.ragV2.action.hybridSearch, {
      repositoryId,
      indexVersion,
      query: input.query,
      embeddingDataProvenance,
      requestedByUserId,
      topK: input.topK || 8,
      filters: input.language
        ? {
            language: input.language,
          }
        : undefined,
    });

    if (!results || results.length === 0) {
      return `No results found for query: "${input.query}". The repository may not be indexed yet, or try a different search query.`;
    }

    // Format results with relevance scores and line numbers
    const formatted = results.map((chunk, idx) => {
      const relevance = Math.round(chunk.score * 100);
      // Add line numbers to code for accurate referencing
      // Count leading newlines before trim to keep line numbers accurate
      const leadingNewlines = chunk.code.match(/^\n*/)?.[0]?.length ?? 0;
      const codeLines = chunk.code.trim().split("\n");
      const numberedCode = codeLines
        .map(
          (line, lineIdx) =>
            `${chunk.startLine + leadingNewlines + lineIdx}\t${line}`,
        )
        .join("\n");
      return `[${idx + 1}] ${chunk.path}:${chunk.startLine}-${chunk.endLine} (${relevance}% relevant)
Language: ${chunk.language || "N/A"}
Symbols: ${chunk.symbols.join(", ") || "N/A"}
${chunk.signature ? `Signature: ${chunk.signature}\n` : ""}---
${numberedCode}
`;
    });

    const summary = `Found ${results.length} matching code chunks for "${input.query}":\n\n`;
    return summary + formatted.join("\n---\n\n");
  } catch (error) {
    if (requestedByUserId) {
      await requireStrictCurrentAiLegalAttestation(ctx, requestedByUserId);
    }
    console.error("Hybrid search failed");
    // Fallback message if RAG V2 is not available
    if (error instanceof Error && error.message.includes("not found")) {
      return `Hybrid search is not available yet. The repository needs to be synced first. Try using search_code instead.`;
    }
    return `Error performing hybrid search: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Search for code patterns in the repository
 */
async function executeSearchCode(
  ctx: ActionCtx,
  repositoryId: Id<"repositories">,
  input: { pattern: string; file_pattern?: string; case_sensitive?: boolean },
  pinnedIndexVersion?: number,
): Promise<string> {
  try {
    if (!input.pattern.trim()) {
      return "Error searching code: the pattern must contain a searchable identifier or word.";
    }

    const repository =
      pinnedIndexVersion === undefined
        ? await ctx.runQuery(internal.repositories.internalQuery.getById, {
            repositoryId,
          })
        : null;
    const indexVersion = pinnedIndexVersion ?? repository?.indexVersion;
    if (indexVersion === undefined) {
      return "No indexed code found. The repository may not be indexed yet.";
    }

    const caseSensitive = input.case_sensitive ?? false;
    const pattern = caseSensitive ? input.pattern : input.pattern.toLowerCase();

    type Chunk = {
      path: string;
      language: string;
      symbols: string[];
      code: string;
      startLine: number;
      endLine: number;
    };

    const isMatch = (chunk: Chunk): boolean => {
      const symbols = caseSensitive
        ? chunk.symbols.join(" ")
        : chunk.symbols.join(" ").toLowerCase();
      const code = caseSensitive ? chunk.code : chunk.code.toLowerCase();

      const symbolMatch = symbols.includes(pattern);
      const codeMatch = code.includes(pattern);

      // Filter by file pattern if provided
      if (input.file_pattern) {
        const matchesFilePattern = matchGlobPattern(
          chunk.path,
          input.file_pattern,
        );
        return (symbolMatch || codeMatch) && matchesFilePattern;
      }

      return symbolMatch || codeMatch;
    };

    const matches: Chunk[] = [];
    let cursor: string | undefined;
    let hasMore = true;
    let scannedChunks = 0;
    let scannedPages = 0;

    while (
      hasMore &&
      matches.length < 20 &&
      scannedPages < SEARCH_CODE_MAX_PAGES &&
      scannedChunks < SEARCH_CODE_MAX_SCANNED_CHUNKS
    ) {
      const page = await ctx.runQuery(
        internal.ragV2.internalQuery.getSearchableChunksPage,
        {
          repositoryId,
          indexVersion,
          cursor,
          limit: Math.min(
            SEARCH_CODE_PAGE_SIZE,
            SEARCH_CODE_MAX_SCANNED_CHUNKS - scannedChunks,
          ),
        },
      );

      scannedPages++;
      scannedChunks += page.chunks.length;
      for (const chunk of page.chunks as Chunk[]) {
        if (isMatch(chunk)) matches.push(chunk);
        if (matches.length === 20) break;
      }

      cursor = page.cursor ?? undefined;
      hasMore = page.hasMore && Boolean(cursor);
    }

    const searchLimitReached =
      hasMore &&
      matches.length < 20 &&
      (scannedPages >= SEARCH_CODE_MAX_PAGES ||
        scannedChunks >= SEARCH_CODE_MAX_SCANNED_CHUNKS);
    const incompleteSearchNotice = searchLimitReached
      ? `Error searching code: scan limit reached after ${scannedChunks} current-version chunks; results below may be incomplete. Use read_file when the target path is known.\n\n`
      : "";

    if (scannedChunks === 0) {
      return searchLimitReached
        ? `${incompleteSearchNotice}No searchable chunks were returned before the scan limit.`
        : "No indexed code found. The repository may not be indexed yet.";
    }

    if (matches.length === 0) {
      return `${incompleteSearchNotice}No matches found for pattern "${input.pattern}"${input.file_pattern ? ` in files matching "${input.file_pattern}"` : ""}.`;
    }

    // Group by file
    const fileGroups = new Map<string, typeof matches>();
    for (const match of matches) {
      const existing = fileGroups.get(match.path) || [];
      existing.push(match);
      fileGroups.set(match.path, existing);
    }

    const results = matches.map((chunk: Chunk) => {
      // Add line numbers to code for accurate referencing
      // Count leading newlines before trim to keep line numbers accurate
      const leadingNewlines = chunk.code.match(/^\n*/)?.[0]?.length ?? 0;
      const codeLines = chunk.code.trim().split("\n");
      const numberedCode = codeLines
        .map(
          (line, idx) => `${chunk.startLine + leadingNewlines + idx}\t${line}`,
        )
        .join("\n");
      return `File: ${chunk.path}:${chunk.startLine}-${chunk.endLine}
Language: ${chunk.language}
Symbols: ${chunk.symbols.join(", ")}
---
${numberedCode}
`;
    });

    const reachedMatchLimit = matches.length === 20 && hasMore;
    const summary = `Found ${matches.length}${reachedMatchLimit ? "+" : ""} matches across ${fileGroups.size} files${reachedMatchLimit ? " (showing first 20)" : ""}:\n\n`;

    return incompleteSearchNotice + summary + results.join("\n---\n\n");
  } catch (error) {
    console.error("Code search failed");
    return `Error searching code: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Read a file from the repository
 */
async function executeReadFile(
  ctx: ActionCtx,
  repositoryId: Id<"repositories">,
  input: { path: string; start_line?: number; end_line?: number },
  indexVersion?: number,
): Promise<string> {
  try {
    const files = await ctx.runAction(
      internal.repoIndexing.internalAction.getRepositoryFilesWithContent,
      {
        repositoryId,
        filePaths: [input.path],
        indexVersion,
      },
    );

    if (!files || files.length === 0) {
      return `File not found: ${input.path}`;
    }

    const file = files[0];
    const allLines = file.content.split("\n");

    // Apply line range if specified
    const requestedStartLine = input.start_line ?? 1;
    const requestedEndLine = input.end_line ?? allLines.length;
    if (
      !Number.isInteger(requestedStartLine) ||
      !Number.isInteger(requestedEndLine) ||
      requestedStartLine < 1 ||
      requestedEndLine < requestedStartLine
    ) {
      return `Error reading file: invalid line range ${requestedStartLine}-${requestedEndLine} for ${file.path}`;
    }
    if (requestedStartLine > allLines.length) {
      return `Error reading file: start_line ${requestedStartLine} exceeds ${file.path} length (${allLines.length} lines)`;
    }

    const start = requestedStartLine - 1; // Convert to 0-indexed
    const end = Math.min(requestedEndLine, allLines.length);
    const selectedLines = allLines.slice(start, end);
    if (selectedLines.every((line) => line.trim().length === 0)) {
      return `Error reading file: line range ${requestedStartLine}-${end} contains no content in ${file.path}`;
    }

    // Add line numbers to each line for accurate referencing
    const startLineNum = start + 1;
    const numberedContent = selectedLines
      .map((line, idx) => `${startLineNum + idx}\t${line}`)
      .join("\n");

    return `File: ${file.path}${file.language ? ` (${file.language})` : ""}
Lines: ${startLineNum}-${start + selectedLines.length}

${numberedContent}`;
  } catch (error) {
    console.error("Repository file read failed");
    return `Error reading file: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * List files in a directory
 */
async function executeListDirectory(
  ctx: ActionCtx,
  repositoryId: Id<"repositories">,
  input: { path: string; pattern?: string; recursive?: boolean },
  indexVersion?: number,
): Promise<string> {
  try {
    const repository =
      indexVersion === undefined
        ? await ctx.runQuery(internal.repositories.internalQuery.getById, {
            repositoryId,
          })
        : null;
    const targetIndexVersion = indexVersion ?? repository?.indexVersion;
    if (targetIndexVersion === undefined) {
      return "No files found. The repository may not be indexed yet.";
    }

    const paths: string[] = [];
    let cursor: string | undefined;
    let hasMore = true;
    let pagesScanned = 0;
    const maxPages = 64;

    while (hasMore && pagesScanned < maxPages) {
      const page = await ctx.runQuery(
        internal.repoIndexing.internalQuery.getRepositoryFilePathsPage,
        {
          repositoryId,
          indexVersion: targetIndexVersion,
          cursor,
          limit: 64,
        },
      );
      paths.push(...page.paths);
      cursor = page.cursor ?? undefined;
      hasMore = page.hasMore && Boolean(cursor);
      pagesScanned++;
    }

    if (paths.length === 0) {
      return "No files found. The repository may not be indexed yet.";
    }

    // Normalize path
    const dirPath = input.path === "." ? "" : input.path.replace(/\/$/, "");

    // Filter files by directory
    let matchingFiles = paths.filter((path) => {
      if (dirPath === "") {
        // Root directory
        return input.recursive || !path.includes("/");
      }

      if (input.recursive) {
        // Recursive: path starts with dirPath
        return path.startsWith(dirPath + "/");
      } else {
        // Non-recursive: direct children only
        const relativePath = path.startsWith(dirPath + "/")
          ? path.slice(dirPath.length + 1)
          : "";
        return relativePath && !relativePath.includes("/");
      }
    });

    // Apply pattern filter if provided
    if (input.pattern) {
      matchingFiles = matchingFiles.filter((path: string) =>
        matchGlobPattern(path, input.pattern!),
      );
    }

    if (matchingFiles.length === 0) {
      if (hasMore) {
        return `Error listing directory: scan limit reached after ${paths.length} current-version files; no matching file was found in the scanned prefix.`;
      }
      return `No files found in directory "${input.path}"${input.pattern ? ` matching "${input.pattern}"` : ""}.`;
    }

    // Group by directory for better readability
    const maxDisplayedFiles = 300;
    const displayedFiles = matchingFiles.slice(0, maxDisplayedFiles);
    const grouped = new Map<string, string[]>();
    for (const file of displayedFiles) {
      const dir = file.includes("/")
        ? file.substring(0, file.lastIndexOf("/"))
        : ".";
      const existing = grouped.get(dir) || [];
      existing.push(file);
      grouped.set(dir, existing);
    }

    let result = hasMore
      ? `Error listing directory: scan limit reached after ${paths.length} current-version files; showing partial matches.\n\n`
      : "";
    result += `Found ${matchingFiles.length} files in "${input.path}"${input.pattern ? ` matching "${input.pattern}"` : ""}:\n\n`;

    for (const [dir, dirFiles] of grouped) {
      result += `${dir}/\n`;
      for (const file of dirFiles.slice(0, 50)) {
        // Limit per directory
        result += `  - ${file}\n`;
      }
      if (dirFiles.length > 50) {
        result += `  ... and ${dirFiles.length - 50} more files\n`;
      }
      result += "\n";
    }

    if (matchingFiles.length > displayedFiles.length) {
      result += `... and ${matchingFiles.length - displayedFiles.length} additional matching files omitted from tool output\n`;
    }

    return result;
  } catch (error) {
    console.error("Repository directory listing failed");
    return `Error listing directory: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * AI Guide file patterns to search for in repositories
 * These files contain instructions for AI assistants
 */
// Three-tier priority system. findAiGuideFiles fetches in tier order and
// stops at MAX_FETCH_PATHS, so higher tiers always win a slot.
// Matching is case-insensitive (see findAiGuideFiles).

// Tier 1: high-signal named AI instruction files. Always included first so
// root-level CLAUDE.md/AGENTS.md aren't crowded out by a large .claude/ dir.
const AI_GUIDE_NAMED_PATTERNS = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "COPILOT.md",
  "AI.md",
  "llm.txt",
  "llms.txt",
  "llms-full.txt",
  "CONVENTION.md",
  ".github/AGENTS.md",
  ".github/COPILOT.md",
  ".ai/llm.txt",
  ".ai/instructions.md",
  "docs/llm.txt",
  "doc/llm.txt",
  "documentation/llm.txt",
];

// Tier 2: directory prefixes whose contents are AI context docs. Matched
// at repo root OR inside any sub-package (monorepo support).
const AI_GUIDE_DIRECTORY_PREFIXES = [".claude/", ".cursor/rules/"];

// Tier 3: generic fallback. Only consulted after specialized guides,
// so a large README never crowds out the above.
const AI_GUIDE_FALLBACK_PATTERNS = ["README.md"];

// Precomputed lookup tables derived from the constants above. Hoisted to
// module scope so findAiGuideFiles doesn't reallocate them on every call.
const AI_GUIDE_NAMED_EXACTS = new Set(
  AI_GUIDE_NAMED_PATTERNS.map((p) => p.toLowerCase()),
);
const AI_GUIDE_NAMED_SUFFIXES = AI_GUIDE_NAMED_PATTERNS.map(
  (p) => "/" + p.toLowerCase(),
);
const AI_GUIDE_FALLBACK_EXACTS = new Set(
  AI_GUIDE_FALLBACK_PATTERNS.map((p) => p.toLowerCase()),
);
const AI_GUIDE_FALLBACK_SUFFIXES = AI_GUIDE_FALLBACK_PATTERNS.map(
  (p) => "/" + p.toLowerCase(),
);
const AI_GUIDE_DIR_NESTED_NEEDLES = AI_GUIDE_DIRECTORY_PREFIXES.map(
  (p) => "/" + p,
);

// Path lookups for the index-backed (case-sensitive) `by_repository_and_path`
// query. We pass both the conventional casing (CLAUDE.md, AGENTS.md, ...) and
// the all-lowercase variant so repos that store guides as `claude.md` /
// `agents.md` are still hit by the guaranteed-discovery pass.
const AI_GUIDE_NAMED_LOOKUP_PATHS = Array.from(
  new Set([
    ...AI_GUIDE_NAMED_PATTERNS,
    ...AI_GUIDE_NAMED_PATTERNS.map((p) => p.toLowerCase()),
  ]),
);

/**
 * Find and read AI guide files from a repository
 * Returns combined content from all found guide files
 */
export async function findAiGuideFiles(
  ctx: ActionCtx,
  repositoryId: Id<"repositories">,
  indexVersion?: number,
): Promise<{ found: boolean; content: string; files: string[] }> {
  try {
    const access = await getToolAccessSnapshot(ctx, repositoryId, indexVersion);
    if (!access) {
      return { found: false, content: "", files: [] };
    }
    const pinnedIndexVersion = access.indexVersion;

    type FileInfo = {
      path: string;
      url: string | null;
      language: string | undefined;
      size: number;
    };

    // Two-pass discovery so we never silently drop high-signal root-level
    // guides in large repos:
    //   (1) Index-backed lookup of AI_GUIDE_NAMED_LOOKUP_PATHS via
    //       by_repository_and_path. The index match is case-sensitive, so we
    //       pass both conventional and all-lowercase variants — guarantees
    //       CLAUDE.md / claude.md / llm.txt etc. at their expected paths are
    //       found even when a repo has >1000 blobbed files (the flat scan
    //       below would otherwise truncate before reaching them).
    //   (2) Flat scan (up to 1000 files) for sub-package discovery and
    //       .claude/.cursor/rules/ directory matches, which can't be
    //       pre-enumerated by exact path.
    const [rootNamedFiles, scannedFiles] = await Promise.all([
      ctx.runQuery(internal.repoIndexing.internalQuery.getRepositoryFiles, {
        repositoryId,
        filePaths: AI_GUIDE_NAMED_LOOKUP_PATHS,
        indexVersion: pinnedIndexVersion,
      }),
      ctx.runQuery(internal.repoIndexing.internalQuery.getRepositoryFiles, {
        repositoryId,
        limit: 1000,
        indexVersion: pinnedIndexVersion,
      }),
    ]);

    const seenPaths = new Set<string>();
    const files: FileInfo[] = [];
    for (const f of [
      ...(rootNamedFiles ?? []),
      ...(scannedFiles ?? []),
    ] as FileInfo[]) {
      if (seenPaths.has(f.path)) continue;
      seenPaths.add(f.path);
      files.push(f);
    }

    if (files.length === 0) {
      return { found: false, content: "", files: [] };
    }

    // Classify each file into a priority tier in a single pass:
    //   Tier 1: named patterns (CLAUDE.md, AGENTS.md, ...) — root or sub-package.
    //   Tier 2: directory prefixes (.claude/, .cursor/rules/**) — specialized rules.
    //   Tier 3: fallback (README.md) — only if earlier tiers don't fill MAX_FETCH_PATHS.
    // Tier 1 first guarantees root-level named guides never get crowded out
    // by a large .claude/ directory in a monorepo.
    const tier1: string[] = [];
    const tier2: string[] = [];
    const tier3: string[] = [];

    for (const f of files) {
      const pathLower = f.path.toLowerCase();

      if (
        AI_GUIDE_NAMED_EXACTS.has(pathLower) ||
        AI_GUIDE_NAMED_SUFFIXES.some((s) => pathLower.endsWith(s))
      ) {
        tier1.push(f.path);
        continue;
      }

      const isDocFile = pathLower.endsWith(".md") || pathLower.endsWith(".mdc");
      if (
        isDocFile &&
        AI_GUIDE_DIRECTORY_PREFIXES.some(
          (prefix, i) =>
            pathLower.startsWith(prefix) ||
            pathLower.includes(AI_GUIDE_DIR_NESTED_NEEDLES[i]),
        )
      ) {
        tier2.push(f.path);
        continue;
      }

      if (
        AI_GUIDE_FALLBACK_EXACTS.has(pathLower) ||
        AI_GUIDE_FALLBACK_SUFFIXES.some((s) => pathLower.endsWith(s))
      ) {
        tier3.push(f.path);
      }
    }

    // Concatenate tiers preserving discovery order; dedupe in case a file
    // somehow matched two tiers (shouldn't happen, but guard with Set).
    const matchingPaths = Array.from(new Set([...tier1, ...tier2, ...tier3]));

    if (matchingPaths.length === 0) {
      return { found: false, content: "", files: [] };
    }

    // Cap how many files we actually fetch. Monorepos can accumulate dozens
    // of .claude/.cursor guides per sub-package; anything beyond this would
    // be dropped by the 8000-char truncation below anyway, so avoid the
    // extra parallel fetches and action-timeout risk.
    const MAX_FETCH_PATHS = 20;
    const pathsToFetch = matchingPaths.slice(0, MAX_FETCH_PATHS);

    // Read the content of found files
    const fileContents: Array<{ path: string; content: string }> =
      await ctx.runAction(
        internal.repoIndexing.internalAction.getRepositoryFilesWithContent,
        {
          repositoryId,
          filePaths: pathsToFetch,
          indexVersion: pinnedIndexVersion,
        },
      );

    if (!fileContents || fileContents.length === 0) {
      return { found: false, content: "", files: [] };
    }

    // getRepositoryFilesWithContent may reorder results; re-sort to match
    // matchingPaths priority so the 8000-char truncation preserves intent.
    const priorityIndex = new Map(matchingPaths.map((p, i) => [p, i]));
    const orderedContents = [...fileContents].sort(
      (a, b) =>
        (priorityIndex.get(a.path) ?? Infinity) -
        (priorityIndex.get(b.path) ?? Infinity),
    );

    // Combine content from all files (limit total size to avoid token issues)
    const MAX_GUIDE_LENGTH = 8000; // Limit total guide content
    let combinedContent = "";
    const includedFiles: string[] = [];

    for (const file of orderedContents) {
      const fileHeader = `\n### From ${file.path}:\n`;
      const fileContent = file.content.trim();

      if (
        combinedContent.length + fileHeader.length + fileContent.length >
        MAX_GUIDE_LENGTH
      ) {
        // If we've already included some content, stop here
        if (includedFiles.length > 0) break;
        // If this is the first file and it's too large, truncate it
        combinedContent =
          fileHeader +
          fileContent.substring(0, MAX_GUIDE_LENGTH - fileHeader.length - 100) +
          "\n...(truncated)";
        includedFiles.push(file.path);
        break;
      }

      combinedContent += fileHeader + fileContent + "\n";
      includedFiles.push(file.path);
    }

    console.log(
      `[findAiGuideFiles] Found ${includedFiles.length} AI guide files`,
    );

    const currentAccess = await getToolAccessSnapshot(
      ctx,
      repositoryId,
      pinnedIndexVersion,
    );
    if (!currentAccess) {
      return { found: false, content: "", files: [] };
    }

    return {
      found: true,
      content: combinedContent.trim(),
      files: includedFiles,
    };
  } catch {
    console.error("[findAiGuideFiles] Failed");
    return { found: false, content: "", files: [] };
  }
}

/**
 * Simple glob pattern matching
 * Supports: *, **, ?, [abc]
 */
function matchGlobPattern(path: string, pattern: string): boolean {
  let regexPattern = "";

  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];

    if (character === "*" && pattern[index + 1] === "*") {
      const followedBySlash = pattern[index + 2] === "/";
      regexPattern += followedBySlash ? "(?:.*/)?" : ".*";
      index += followedBySlash ? 2 : 1;
      continue;
    }

    if (character === "*") {
      regexPattern += "[^/]*";
      continue;
    }

    if (character === "?") {
      regexPattern += "[^/]";
      continue;
    }

    if (character === "[") {
      const closingBracket = pattern.indexOf("]", index + 1);
      if (closingBracket !== -1) {
        regexPattern += pattern.slice(index, closingBracket + 1);
        index = closingBracket;
        continue;
      }
    }

    regexPattern += character.replace(/[\\^$+?.()|{}]/g, "\\$&");
  }

  return new RegExp(`^${regexPattern}$`).test(path);
}
