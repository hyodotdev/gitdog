import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchRepositoryTree,
  getLanguageFromPath,
  getRepositoryIndexBatch,
  isTextFile,
  parseCompleteRepositoryTree,
} from "../../../convex/repoIndexing/action";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("repository indexing language coverage", () => {
  it.each([
    ["lib/main.dart", "Dart"],
    ["native/module.mm", "Objective-C++"],
    ["native/module.m", "Objective-C"],
    ["src/module.cs", "C#"],
    ["src/module.cpp", "C++"],
    ["android/build.gradle.kts", "Kotlin"],
  ])("indexes %s as %s", (path, language) => {
    expect(isTextFile(path)).toBe(true);
    expect(getLanguageFromPath(path)).toBe(language);
  });
});

describe("repository indexing batches", () => {
  it("uses a conservative default batch size", () => {
    const result = getRepositoryIndexBatch(
      Array.from({ length: 100 }, (_, index) => index),
      0,
    );

    expect(result.batch).toHaveLength(40);
    expect(result.nextOffset).toBe(40);
  });

  it("covers a large repository exactly once in bounded continuations", () => {
    const files = Array.from({ length: 1862 }, (_, index) => index);
    const processed: Array<number> = [];
    let offset = 0;

    while (offset < files.length) {
      const result = getRepositoryIndexBatch(files, offset, 100);
      expect(result.batch.length).toBeLessThanOrEqual(100);
      expect(result.nextOffset).toBeGreaterThan(offset);
      processed.push(...result.batch);
      offset = result.nextOffset;
    }

    expect(processed).toEqual(files);
  });

  it("clamps stale offsets without duplicating work", () => {
    const result = getRepositoryIndexBatch(["a", "b"], 99, 100);

    expect(result).toEqual({ batch: [], nextOffset: 2, totalFiles: 2 });
  });
});

describe("repository tree snapshots", () => {
  it("rejects a truncated recursive tree before cleanup can run", () => {
    expect(() =>
      parseCompleteRepositoryTree({ tree: [], truncated: true }),
    ).toThrow("truncated repository tree");
  });

  it("requires durable traversal when GitHub truncates the recursive tree", async () => {
    const requests: Array<string> = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      requests.push(url);
      if (url.endsWith("/git/trees/root?recursive=1")) {
        return new Response(JSON.stringify({ tree: [], truncated: true }), {
          status: 200,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      fetchRepositoryTree("owner/repo", "root", "installation-token"),
    ).rejects.toThrow("durable traversal is required");
    expect(requests).toEqual([
      "https://api.github.com/repos/owner/repo/git/trees/root?recursive=1",
    ]);
  });
});
