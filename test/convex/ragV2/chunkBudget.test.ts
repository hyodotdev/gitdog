import { describe, expect, it } from "vitest";
import {
  buildRagChunkPublicationBatches,
  estimateRagChunkPublicationBytes,
  estimateRagEmbeddingCacheBytes,
  getUtf8ByteLength,
  MAX_RAG_CHUNK_CODE_BYTES,
  MAX_RAG_EMBEDDING_CACHE_BYTES,
  MAX_RAG_PROVIDER_BATCH_ITEMS,
  MAX_RAG_PUBLICATION_BYTES,
  MAX_RAG_SEARCHABLE_TEXT_BYTES,
  MAX_RAG_SOURCE_BYTES,
} from "../../../convex/ragV2/chunkBudget";
import {
  normalizeCodeChunksForStorage,
  parseCodeIntoChunks,
  stableChunkId,
  type CodeChunk,
} from "../../../convex/ragV2/parser";

function createChunk(code: string): CodeChunk {
  return {
    chunkId: "source-chunk",
    path: "packages/openiap/src/receipt-validation.ts",
    language: "typescript",
    code,
    startLine: 1,
    endLine: 1,
    symbols: ["validateReceipt"],
    imports: Array.from(
      { length: 2_000 },
      (_, index) => `@openiap/generated-import-${index}`,
    ),
    signature: `export function validateReceipt(payload: string)`,
    docstring: "Validates a platform receipt without dropping its source.",
    contentHash: "content-hash",
    searchableText: `validateReceipt ${code}`,
  };
}

describe("RAG chunk byte budgets", () => {
  it.each([
    [
      "TypeScript",
      "export function titleCaseTypeScript() { return true; }",
      "titleCaseTypeScript",
      "typescript",
    ],
    [
      "Python",
      "def title_case_python():\n    return True",
      "title_case_python",
      "python",
    ],
    [
      "JavaScript",
      "export function titleCaseJavaScript() { return true; }",
      "titleCaseJavaScript",
      "javascript",
    ],
  ])(
    "uses semantic parsing for canonical %s file-map labels",
    (language, source, symbol, expectedLanguage) => {
      const chunks = parseCodeIntoChunks("source.file", source, language);

      expect(chunks.some((chunk) => chunk.symbols.includes(symbol))).toBe(true);
      expect(chunks.every((chunk) => chunk.language === expectedLanguage)).toBe(
        true,
      );
    },
  );

  it("preserves an OpenIAP-sized single line while splitting storage documents", () => {
    const source = `export function validateReceipt() { return "${"x".repeat(
      285 * 1024,
    )}stored-tail-marker"; }`;
    const normalized = normalizeCodeChunksForStorage([createChunk(source)]);

    expect(getUtf8ByteLength(source)).toBeLessThan(MAX_RAG_SOURCE_BYTES);
    expect(normalized.length).toBeGreaterThan(1);
    expect(normalized.map((chunk) => chunk.code).join("")).toBe(source);
    expect(
      normalized.every(
        (chunk) =>
          getUtf8ByteLength(chunk.code) <= MAX_RAG_CHUNK_CODE_BYTES &&
          getUtf8ByteLength(chunk.searchableText) <=
            MAX_RAG_SEARCHABLE_TEXT_BYTES,
      ),
    ).toBe(true);
    expect(normalized.at(-1)?.code).toContain("stored-tail-marker");
  });

  it("does not split multibyte code points or exceed publication/cache budgets", () => {
    const source = `export function localized() { return "${"한글🙂".repeat(
      85_000,
    )}다국어-tail"; }`;
    const normalized = normalizeCodeChunksForStorage([createChunk(source)]);
    const batches = buildRagChunkPublicationBatches(
      normalized,
      (chunk) => chunk,
      {
        includeMissingEmbeddings: true,
        cacheEmbeddings: true,
      },
    );

    expect(getUtf8ByteLength(source)).toBeLessThan(MAX_RAG_SOURCE_BYTES);
    expect(normalized.map((chunk) => chunk.code).join("")).toBe(source);
    expect(normalized.at(-1)?.code).toContain("다국어-tail");
    expect(batches.flat()).toEqual(normalized);
    expect(
      batches.every(
        (batch) =>
          batch.length <= MAX_RAG_PROVIDER_BATCH_ITEMS &&
          batch.reduce(
            (total, chunk) =>
              total + estimateRagChunkPublicationBytes(chunk, true),
            0,
          ) <= MAX_RAG_PUBLICATION_BYTES &&
          estimateRagEmbeddingCacheBytes(batch.length) <=
            MAX_RAG_EMBEDDING_CACHE_BYTES,
      ),
    ).toBe(true);
  });

  it("makes middle and tail source bytes searchable", () => {
    const middleMarker = "unique-middle-marker-70k";
    const boundaryMarker = "unique-boundary-marker";
    const tailMarker = "unique-tail-marker-90k";
    const source = [
      "x".repeat(60 * 1024 - Math.floor(boundaryMarker.length / 2)),
      boundaryMarker,
      "y".repeat(10 * 1024),
      middleMarker,
      "z".repeat(20 * 1024),
      tailMarker,
    ].join("");
    const normalized = normalizeCodeChunksForStorage([createChunk(source)]);

    expect(normalized.map((chunk) => chunk.code).join("")).toBe(source);
    for (const chunk of normalized) {
      expect(chunk.searchableText).toContain(chunk.code);
    }
    for (const marker of [middleMarker, boundaryMarker, tailMarker]) {
      expect(
        normalized.some((chunk) => chunk.searchableText.includes(marker)),
      ).toBe(true);
    }
  });

  it.each([
    {
      path: "src/exact-coverage.ts",
      functionLines: [
        "export function semanticCoverageFunction() {",
        '  return "function-coverage-marker";',
        "}",
      ],
      topLevelLine: (index: number) =>
        `const topLevel${index} = "coverage-marker-${String(index).padStart(4, "0")}";`,
    },
    {
      path: "src/exact_coverage.py",
      functionLines: [
        "def semantic_coverage_function():",
        '    return "function-coverage-marker"',
      ],
      topLevelLine: (index: number) =>
        `top_level_${index} = "coverage-marker-${String(index).padStart(4, "0")}"`,
    },
  ])(
    "keeps every top-level line searchable around semantic chunks in $path",
    ({ path, functionLines, topLevelLine }) => {
      const topLevelLines = Array.from({ length: 520 }, (_, index) =>
        topLevelLine(index),
      );
      const source = [
        ...topLevelLines.slice(0, 260),
        ...functionLines,
        ...topLevelLines.slice(260),
      ].join("\n");
      const normalized = normalizeCodeChunksForStorage(
        parseCodeIntoChunks(path, source),
      );

      for (let index = 0; index < topLevelLines.length; index++) {
        const marker = `coverage-marker-${String(index).padStart(4, "0")}`;
        expect(
          normalized.some((chunk) => chunk.searchableText.includes(marker)),
        ).toBe(true);
      }
      expect(
        normalized.some((chunk) =>
          chunk.searchableText.includes("function-coverage-marker"),
        ),
      ).toBe(true);
    },
  );

  it("uses collision-resistant stable IDs at large repository scale", () => {
    const ids = new Set(
      Array.from({ length: 100_000 }, (_, index) =>
        stableChunkId(`packages/pkg-${index}/src/index.ts#1#100`),
      ),
    );
    expect(ids).toHaveLength(100_000);
    expect(Array.from(ids).every((id) => id.length === 32)).toBe(true);
  });
});
