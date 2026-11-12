import { describe, expect, it } from "vitest";

import { getUtf8ByteLength } from "../../../convex/ragV2/chunkBudget";
import {
  normalizeCodeChunksForStorage,
  parseCodeIntoChunks,
} from "../../../convex/ragV2/parser";

function sumCodeBytes(chunks: ReadonlyArray<{ code: string }>): number {
  return chunks.reduce(
    (total, chunk) => total + getUtf8ByteLength(chunk.code),
    0,
  );
}

describe("RAG parser memory bounds", () => {
  it("keeps a declaration-dense file linear instead of building overlapping windows", () => {
    // A generated protocol/types file: thousands of tiny exported declarations.
    // The semantic parser would emit one overlapping window per declaration and
    // build an O(declarations x window) raw array that exhausts the action heap.
    const declarationCount = 6_000;
    const source = Array.from(
      { length: declarationCount },
      (_, index) => `export const FIELD_${index} = ${index};`,
    ).join("\n");

    const chunks = parseCodeIntoChunks("src/generated/protocol.ts", source);

    // Fixed-line fallback yields roughly lines/step chunks, never one per
    // declaration, and emits no per-symbol metadata.
    expect(chunks.length).toBeLessThan(200);
    expect(chunks.every((chunk) => chunk.symbols.length === 0)).toBe(true);

    // Peak raw chunk bytes stay proportional to the source (fixed windows
    // overlap by a fixed fraction), not quadratic in the declaration count.
    const sourceBytes = getUtf8ByteLength(source);
    expect(sumCodeBytes(chunks)).toBeLessThan(sourceBytes * 3);

    // Normalization still succeeds and preserves the source text.
    const normalized = normalizeCodeChunksForStorage(chunks);
    expect(normalized.length).toBeGreaterThan(0);
  });

  it("falls back to fixed-line chunking when byte size exceeds the semantic budget", () => {
    // Fewer than the line cap, but past the 256 KiB semantic byte budget.
    const source = Array.from(
      { length: 4_000 },
      (_, index) => `export const WIDE_${index} = "${"x".repeat(80)}";`,
    ).join("\n");
    expect(getUtf8ByteLength(source)).toBeGreaterThan(256 * 1024);

    const chunks = parseCodeIntoChunks("src/generated/wide.ts", source);

    expect(chunks.every((chunk) => chunk.symbols.length === 0)).toBe(true);
    expect(sumCodeBytes(chunks)).toBeLessThan(getUtf8ByteLength(source) * 3);
  });

  it("bounds a declaration-dense file that stays under the size pre-filter", () => {
    // Under both the byte (256 KiB) and line (5000) pre-filters, yet dense with
    // method declarations. Each match would otherwise copy an overlapping
    // window plus a searchable-text duplicate, expanding a small file into tens
    // of MB of raw chunks and exhausting the 64 MB action heap. The output
    // budget must catch it and fall back to linear fixed-line chunking.
    const methods = Array.from(
      { length: 3_000 },
      (_, index) => `  method_${index}(a) { return a + ${index}; }`,
    );
    const source = ["export class Dense {", ...methods, "}"].join("\n");
    expect(getUtf8ByteLength(source)).toBeLessThan(256 * 1024);
    expect(source.split("\n").length).toBeLessThan(5_000);

    const chunks = parseCodeIntoChunks("src/dense.ts", source);

    // Fell back to fixed-line windows: no per-symbol metadata, bounded count,
    // and raw bytes proportional to the source rather than quadratic.
    expect(chunks.every((chunk) => chunk.symbols.length === 0)).toBe(true);
    expect(chunks.length).toBeLessThan(200);
    expect(sumCodeBytes(chunks)).toBeLessThan(getUtf8ByteLength(source) * 3);
  });

  it("still uses semantic parsing for normal-sized source files", () => {
    const source = [
      "export function validateReceipt(payload: string) {",
      "  return payload.length > 0;",
      "}",
      "",
      "export class ReceiptStore {",
      "  save() {",
      "    return true;",
      "  }",
      "}",
    ].join("\n");

    const chunks = parseCodeIntoChunks("src/receipt.ts", source);

    expect(
      chunks.some((chunk) => chunk.symbols.includes("validateReceipt")),
    ).toBe(true);
    expect(chunks.some((chunk) => chunk.symbols.includes("ReceiptStore"))).toBe(
      true,
    );
  });
});
