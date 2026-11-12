import { describe, expect, it, vi } from "vitest";
import type { ActionCtx } from "../../../convex/_generated/server";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  executeTool,
  SEARCH_CODE_MAX_PAGES,
} from "../../../convex/_ai/tools/executors";

function chunk(path: string, code: string) {
  return {
    path,
    language: "TypeScript",
    symbols: [],
    code,
    startLine: 1,
    endLine: 1,
  };
}

describe("search_code pagination", () => {
  it("continues past the first page before reporting no matches", async () => {
    const firstPage = Array.from({ length: 64 }, (_, index) =>
      chunk(`src/generated-${index}.ts`, "export const unrelated = true;"),
    );
    const runQuery = vi
      .fn()
      .mockResolvedValueOnce({ indexVersion: 7 })
      .mockResolvedValueOnce({
        chunks: firstPage,
        cursor: "next-page",
        hasMore: true,
      })
      .mockResolvedValueOnce({
        chunks: [
          chunk(
            "packages/sdk/src/client.ts",
            "export function exactNeedle() {}",
          ),
        ],
        cursor: null,
        hasMore: false,
      })
      .mockResolvedValueOnce({ indexVersion: 7 });
    const ctx = { runQuery } as unknown as ActionCtx;

    const result = await executeTool(
      ctx,
      "repository-id" as Id<"repositories">,
      { name: "search_code", input: { pattern: "exactNeedle" } },
    );

    expect(result).toContain("packages/sdk/src/client.ts");
    expect(runQuery).toHaveBeenCalledTimes(4);
    expect(runQuery.mock.calls[2][1]).toMatchObject({
      indexVersion: 7,
      cursor: "next-page",
    });
  });

  it("applies file patterns while scanning all current-version pages", async () => {
    const runQuery = vi
      .fn()
      .mockResolvedValueOnce({ indexVersion: 3 })
      .mockResolvedValueOnce({
        chunks: [chunk("src/client.ts", "const target = true;")],
        cursor: "next-page",
        hasMore: true,
      })
      .mockResolvedValueOnce({
        chunks: [chunk("packages/native/client.kt", "val target = true")],
        cursor: null,
        hasMore: false,
      })
      .mockResolvedValueOnce({ indexVersion: 3 });
    const ctx = { runQuery } as unknown as ActionCtx;

    const result = await executeTool(
      ctx,
      "repository-id" as Id<"repositories">,
      {
        name: "search_code",
        input: { pattern: "target", file_pattern: "packages/**/*.kt" },
      },
    );

    expect(result).toContain("packages/native/client.kt");
    expect(result).not.toContain("src/client.ts");
  });

  it("returns partial exact matches and stops at the scan bound", async () => {
    let pageNumber = 0;
    const runQuery = vi.fn(async (_query, args: Record<string, unknown>) => {
      if ("expectedIndexVersion" in args) {
        return { indexVersion: 9 };
      }
      const isLastAllowedPage = pageNumber === SEARCH_CODE_MAX_PAGES - 1;
      const currentPage = pageNumber++;
      return {
        chunks: Array.from({ length: 64 }, (_, index) =>
          chunk(
            `src/page-${currentPage}-${index}.ts`,
            isLastAllowedPage && index === 63
              ? "export const boundedNeedle = true;"
              : "export const unrelated = true;",
          ),
        ),
        cursor: `cursor-${pageNumber}`,
        hasMore: true,
      };
    });
    const ctx = { runQuery } as unknown as ActionCtx;

    const result = await executeTool(
      ctx,
      "repository-id" as Id<"repositories">,
      { name: "search_code", input: { pattern: "boundedNeedle" } },
    );

    expect(result).toMatch(/^Error searching code: scan limit reached/);
    expect(result).toContain("boundedNeedle");
    expect(runQuery).toHaveBeenCalledTimes(SEARCH_CODE_MAX_PAGES + 2);
  });
});
