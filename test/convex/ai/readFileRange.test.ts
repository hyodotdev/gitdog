import { describe, expect, it } from "vitest";
import type { ActionCtx } from "../../../convex/_generated/server";
import { executeTool } from "../../../convex/_ai/tools/executors";

function createContext(content: string): ActionCtx {
  return {
    runQuery: async () => ({ indexVersion: 1 }),
    runAction: async () => [
      {
        path: "src/index.ts",
        language: "TypeScript",
        content,
      },
    ],
  } as unknown as ActionCtx;
}

describe("read_file line ranges", () => {
  it.each([
    { start_line: 0, end_line: 1 },
    { start_line: 2, end_line: 1 },
    { start_line: 1.5, end_line: 2 },
    { start_line: 4 },
  ])("rejects invalid or out-of-bounds ranges: %o", async (input) => {
    const result = await executeTool(
      createContext("first\nsecond\nthird"),
      "repository-id" as never,
      {
        name: "read_file",
        input: { path: "src/index.ts", ...input },
      },
    );

    expect(result).toMatch(/^Error reading file:/);
  });

  it("returns the requested valid range and clamps the end to EOF", async () => {
    const result = await executeTool(
      createContext("first\nsecond\nthird"),
      "repository-id" as never,
      {
        name: "read_file",
        input: {
          path: "src/index.ts",
          start_line: 2,
          end_line: 99,
        },
      },
    );

    expect(result).toContain("Lines: 2-3");
    expect(result).toContain("2\tsecond");
    expect(result).toContain("3\tthird");
  });

  it("does not count a whitespace-only range as a successful file read", async () => {
    const result = await executeTool(
      createContext("first\n   \nthird"),
      "repository-id" as never,
      {
        name: "read_file",
        input: {
          path: "src/index.ts",
          start_line: 2,
          end_line: 2,
        },
      },
    );

    expect(result).toMatch(/^Error reading file:/);
    expect(result).toContain("contains no content");
  });
});
