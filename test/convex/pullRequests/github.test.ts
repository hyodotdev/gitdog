import { afterEach, describe, expect, it, vi } from "vitest";
import * as helpers from "../../../convex/github/helpers";
import {
  changedSince,
  getPullRequest,
  isBotPullRequestAuthor,
  snapshot,
  splitReviewDiff,
  readFile,
  readReviewFile,
  treePaths,
  type PullRequest,
} from "../../../convex/pullRequests/github";
import { handlePullRequestEvent } from "../../../convex/pullRequests/webhook";
import type { VerifiedRepositoryAccess } from "../../../convex/github/repositoryIdentity";
import type { ActionCtx } from "../../../convex/_generated/server";
import { ReviewContextLimitError } from "../../../convex/pullRequests/errors";
import {
  OMITTED_SOURCE_MARKER,
  windowChangedSource,
} from "../../../convex/pullRequests/review";
const access = {
  owner: "owner",
  repo: "repo",
  githubRepositoryId: 123,
  token: "fixture-token",
} as VerifiedRepositoryAccess;
const pr: PullRequest = {
  id: 100,
  number: 12,
  state: "open",
  draft: false,
  title: "Change",
  body: "Description",
  user: { login: "author" },
  head: { sha: "b".repeat(40) },
  base: { sha: "a".repeat(40), repo: { id: 123 } },
  changed_files: 1,
};
const diff = (files: unknown[], mergeBase = pr.base.sha) => ({
  merge_base_commit: { sha: mergeBase },
  files,
});
afterEach(() => vi.restoreAllMocks());
describe("authoritative PR snapshots", () => {
  it.each([
    [{ login: "dependabot[bot]", type: "Bot" }, true],
    [{ login: "renovate[bot]" }, true],
    [{ login: "github-actions[BOT]", type: "User" }, true],
    [{ login: "custom-automation", type: "Bot" }, true],
    [{ login: "robotics-maintainer", type: "User" }, false],
    [{ login: "author" }, false],
  ])("classifies PR author %j without matching human names", (author, bot) => {
    expect(isBotPullRequestAuthor(author)).toBe(bot);
  });
  it("gives review reads more attempts than the default", async () => {
    const mock = vi
      .spyOn(helpers, "fetchGitHubAppJsonWithRetry")
      .mockResolvedValueOnce(pr)
      .mockResolvedValueOnce({
        type: "file",
        encoding: "base64",
        content: btoa("source"),
        size: 6,
      });
    await getPullRequest(access, pr.number);
    await readFile(access, "src/a.ts", pr.head.sha);
    expect(mock.mock.calls.map((call) => call[3])).toEqual([
      { maxAttempts: 4 },
      { maxAttempts: 4 },
    ]);
  });
  it("reads the diff of the pinned commits, not the live PR", async () => {
    const get = vi
      .spyOn(helpers, "fetchGitHubAppJsonWithRetry")
      .mockResolvedValueOnce(
        diff([
          {
            filename: "a.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
            patch: "@@ -0,0 +1 @@\n+x",
          },
        ]),
      );
    const pinned = { head: { sha: "e".repeat(40) }, base: pr.base };
    await expect(snapshot(access, pinned)).resolves.toMatchObject({
      headSha: "e".repeat(40),
      changedFiles: 1,
    });
    // One pinned comparison; the live PR is not re-read.
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toContain(
      `/compare/${pr.base.sha}...${"e".repeat(40)}`,
    );
  });
  it("identifies the file limit separately from access and binary failures", async () => {
    vi.spyOn(helpers, "fetchGitHubAppJsonWithRetry").mockResolvedValue({
      type: "file",
      encoding: "base64",
      content: btoa("x".repeat(40_001)),
      size: 40_001,
    });
    await expect(
      readFile(access, "large.ts", pr.head.sha),
    ).rejects.toBeInstanceOf(ReviewContextLimitError);
  });
  describe("large changed files", () => {
    // 3,000 numbered lines, about 57 KB; the diff adds line 1500.
    const lines = Array.from(
      { length: 3000 },
      (_, i) => `const value${i + 1} = ${i + 1};`,
    );
    const source = lines.join("\n");
    const changed = {
      filename: "src/large.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch:
        "@@ -1497,7 +1497,7 @@\n const value1497 = 1497;\n const value1498 = 1498;\n const value1499 = 1499;\n-old\n+const value1500 = 1500;\n const value1501 = 1501;\n const value1502 = 1502;\n const value1503 = 1503;",
    };
    const file = (text: string) => ({
      type: "file",
      encoding: "base64",
      content: btoa(text),
      size: text.length,
    });
    it("shows the diff region with its original line numbers", () => {
      const windowed = windowChangedSource(source, changed.patch)!;
      const shown = windowed.split("\n");
      expect(shown).toHaveLength(3000);
      expect(shown[1499]).toBe("const value1500 = 1500;");
      expect(shown[1497 - 80 - 1]).toBe("const value1417 = 1417;");
      expect(shown[1497 - 80 - 2]).toBe("");
      expect(shown[0]).toBe(OMITTED_SOURCE_MARKER);
      expect(shown[1]).toBe("");
      expect(shown[1503 + 80]).toBe(OMITTED_SOURCE_MARKER);
      expect(shown[2999]).toBe("");
      expect(JSON.stringify(windowed).length).toBeLessThanOrEqual(40_000);
    });
    it("narrows the context, then gives up, when the diff is too large", () => {
      const all = `@@ -1,3000 +1,3000 @@\n${lines.map((l) => `+${l}`).join("\n")}`;
      expect(windowChangedSource(source, all)).toBeNull();
      expect(windowChangedSource(source, "@@ -1,2 +0,0 @@\n-a\n-b")).toBeNull();
    });
    it("reads a changed file over 40 KB around its diff", async () => {
      const get = vi
        .spyOn(helpers, "fetchGitHubAppJsonWithRetry")
        .mockResolvedValue(file(source));
      const windowed = await readReviewFile(
        access,
        changed.filename,
        pr.head.sha,
        changed,
      );
      expect(windowed.split("\n")[1499]).toBe("const value1500 = 1500;");
      expect(windowed).toContain(OMITTED_SOURCE_MARKER);
      // A changed file is fetched once at the larger limit.
      expect(get).toHaveBeenCalledTimes(1);
    });
    it("shows a medium changed file around its diff too", async () => {
      // About 30 KB: under the old limit, over the windowing threshold.
      const medium = lines.slice(0, 1600).join("\n");
      vi.spyOn(helpers, "fetchGitHubAppJsonWithRetry").mockResolvedValue(
        file(medium),
      );
      const shown = await readReviewFile(
        access,
        changed.filename,
        pr.head.sha,
        changed,
      );
      expect(shown).toContain(OMITTED_SOURCE_MARKER);
      expect(shown.split("\n")).toHaveLength(1600);
      expect(shown.split("\n")[1499]).toBe("const value1500 = 1500;");
    });
    it("keeps the 40 KB rule for evidence saved before medium windowing", async () => {
      const medium = lines.slice(0, 1600).join("\n");
      vi.spyOn(helpers, "fetchGitHubAppJsonWithRetry").mockResolvedValue(
        file(medium),
      );
      expect(
        await readReviewFile(
          access,
          changed.filename,
          pr.head.sha,
          changed,
          undefined,
          40_000,
        ),
      ).toBe(medium);
    });
    it("shows a medium file whole when its diff cannot be windowed", async () => {
      const medium = lines.slice(0, 1600).join("\n");
      vi.spyOn(helpers, "fetchGitHubAppJsonWithRetry").mockResolvedValue(
        file(medium),
      );
      const all = `@@ -1,1600 +1,1600 @@\n${lines
        .slice(0, 1600)
        .map((l) => `+${l}`)
        .join("\n")}`;
      expect(
        await readReviewFile(access, changed.filename, pr.head.sha, {
          ...changed,
          additions: 1600,
          patch: all,
        }),
      ).toBe(medium);
    });
    it("keeps the 40 KB limit for unchanged files and base reads", async () => {
      vi.spyOn(helpers, "fetchGitHubAppJsonWithRetry").mockResolvedValue(
        file(source),
      );
      await expect(
        readReviewFile(access, changed.filename, pr.head.sha),
      ).rejects.toBeInstanceOf(ReviewContextLimitError);
      await expect(
        readReviewFile(access, changed.filename, pr.head.sha, {
          ...changed,
          status: "removed",
        }),
      ).rejects.toBeInstanceOf(ReviewContextLimitError);
    });
    it("refuses a changed file over 400 KB", async () => {
      vi.spyOn(helpers, "fetchGitHubAppJsonWithRetry").mockResolvedValue(
        file("x".repeat(400_001)),
      );
      await expect(
        readReviewFile(access, changed.filename, pr.head.sha, changed),
      ).rejects.toBeInstanceOf(ReviewContextLimitError);
    });
  });
  describe("changes since the last review", () => {
    const since = { headSha: "c".repeat(40), mergeBaseSha: "d".repeat(40) };
    const mergeBase = (sha: string) => ({
      status: "ahead",
      merge_base_commit: { sha },
    });
    it("lists the paths a push changed when it extends the reviewed head", async () => {
      const get = vi
        .spyOn(helpers, "fetchGitHubAppJsonWithRetry")
        .mockResolvedValueOnce({
          status: "ahead",
          files: [{ filename: "src/b.ts", previous_filename: "src/a.ts" }],
        })
        .mockResolvedValueOnce(mergeBase(since.mergeBaseSha));
      expect(await changedSince(access, since, pr)).toEqual({
        paths: new Set(["src/b.ts", "src/a.ts"]),
        mergeBaseSha: since.mergeBaseSha,
      });
      expect(get.mock.calls[0][0]).toContain(
        `/compare/${since.headSha}...${pr.head.sha}?per_page=1`,
      );
      expect(get.mock.calls[1][0]).toContain(
        `/compare/${pr.base.sha}...${pr.head.sha}`,
      );
    });
    it("adds the files a merge of the base branch brought into the diff", async () => {
      const moved = "e".repeat(40);
      const get = vi
        .spyOn(helpers, "fetchGitHubAppJsonWithRetry")
        .mockResolvedValueOnce({ status: "ahead", files: [] })
        .mockResolvedValueOnce(mergeBase(moved))
        .mockResolvedValueOnce({
          status: "ahead",
          files: [{ filename: "src/fixed-on-main.ts" }],
        });
      expect(await changedSince(access, since, pr)).toEqual({
        paths: new Set(["src/fixed-on-main.ts"]),
        mergeBaseSha: moved,
      });
      expect(get.mock.calls[2][0]).toContain(
        `/compare/${since.mergeBaseSha}...${moved}`,
      );
    });
    it("reviews the whole PR when the merge base was retargeted or rewound", async () => {
      for (const status of ["diverged", "behind"]) {
        vi.spyOn(helpers, "fetchGitHubAppJsonWithRetry")
          .mockResolvedValueOnce({ status: "ahead", files: [] })
          .mockResolvedValueOnce(mergeBase("e".repeat(40)))
          .mockResolvedValueOnce({ status, files: [] });
        expect(await changedSince(access, since, pr)).toBeNull();
      }
    });
    it("reviews the whole PR after a force push or a long comparison", async () => {
      const get = vi.spyOn(helpers, "fetchGitHubAppJsonWithRetry");
      get.mockResolvedValueOnce({ status: "diverged", files: [] });
      expect(await changedSince(access, since, pr)).toBeNull();
      get.mockResolvedValueOnce({
        status: "ahead",
        files: Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}` })),
      });
      expect(await changedSince(access, since, pr)).toBeNull();
      expect(
        await changedSince(access, { ...since, headSha: "main" }, pr),
      ).toBeNull();
    });
    it("reviews the whole PR when the comparison fails", async () => {
      vi.spyOn(helpers, "fetchGitHubAppJsonWithRetry").mockRejectedValue(
        new Error("Read changes since the last review failed (HTTP 404)"),
      );
      expect(await changedSince(access, since, pr)).toBeNull();
    });
  });
  it("rejects a PR from another immutable repository", async () => {
    vi.spyOn(helpers, "fetchGitHubAppJsonWithRetry").mockResolvedValue({
      ...pr,
      base: { ...pr.base, repo: { id: 999 } },
    });
    await expect(getPullRequest(access, 12)).rejects.toThrow("identity");
  });
  it("pins source to the merge base and head, not a mutable branch name", async () => {
    const get = vi
      .spyOn(helpers, "fetchGitHubAppJsonWithRetry")
      .mockResolvedValueOnce(
        diff(
          [
            {
              filename: "src/a.ts",
              status: "modified",
              additions: 1,
              deletions: 1,
              patch: "@@ -1 +1 @@\n-a\n+b",
            },
          ],
          "c".repeat(40),
        ),
      );
    const result = await snapshot(access, pr);
    expect(result.baseSha).toBe("c".repeat(40));
    expect(get.mock.calls[0][0]).toContain(`${pr.base.sha}...${pr.head.sha}`);
  });
  it("keeps review evidence and rename identity without replaying GitHub transport metadata", async () => {
    const file = {
      filename: "src/a.ts",
      previous_filename: "src/old.ts",
      status: "renamed",
      additions: 1,
      deletions: 1,
      patch: "@@ -1 +1 @@\n-a\n+b",
    };
    vi.spyOn(helpers, "fetchGitHubAppJsonWithRetry").mockResolvedValueOnce(
      diff([
        {
          ...file,
          sha: "d".repeat(40),
          blob_url: "https://github.com/owner/repo/blob/commit/src/a.ts",
          raw_url: "https://github.com/owner/repo/raw/commit/src/a.ts",
          contents_url:
            "https://api.github.com/repos/owner/repo/contents/src/a.ts",
          changes: 2,
        },
      ]),
    );
    expect((await snapshot(access, pr)).files).toEqual([file]);
  });
  it("preserves the size-limit diagnostic before discarding transport metadata", async () => {
    vi.spyOn(helpers, "fetchGitHubAppJsonWithRetry").mockResolvedValueOnce(
      diff([
        {
          filename: "a.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
          patch: "@@ -0,0 +1 @@\n+x",
          blob_url: "x".repeat(100_001),
        },
      ]),
    );
    await expect(snapshot(access, pr)).rejects.toThrow(
      "Pull request diff exceeds the review budget; split this PR",
    );
  });
  it("reads an over-budget diff when publication asks only for the finding paths", async () => {
    const file = {
      filename: "a.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: `@@ -0,0 +1 @@\n+${"x".repeat(100_001)}`,
    };
    vi.spyOn(helpers, "fetchGitHubAppJsonWithRetry").mockResolvedValueOnce(
      diff([file]),
    );
    expect(
      (await snapshot(access, pr, false, { findingPaths: new Set(["a.ts"]) }))
        .files,
    ).toEqual([file]);
  });
  it("rejects an empty or missing diff", async () => {
    const get = vi
      .spyOn(helpers, "fetchGitHubAppJsonWithRetry")
      .mockResolvedValueOnce(diff([]));
    await expect(snapshot(access, pr)).rejects.toThrow("at least one");
    get.mockResolvedValueOnce({ merge_base_commit: { sha: pr.base.sha } });
    await expect(snapshot(access, pr)).rejects.toThrow("incomplete");
    get.mockResolvedValueOnce({ files: [] });
    await expect(snapshot(access, pr)).rejects.toThrow("merge base");
  });
  it("refuses PRs beyond the review file limit and truncated repository trees", async () => {
    const get = vi.spyOn(helpers, "fetchGitHubAppJsonWithRetry");
    get.mockResolvedValueOnce(
      diff(
        Array.from({ length: 300 }, (_, index) => ({
          filename: `src/${index}.ts`,
          status: "added",
          additions: 1,
          deletions: 0,
          patch: "@@ -0,0 +1 @@\n+x",
        })),
      ),
    );
    await expect(snapshot(access, pr)).rejects.toThrow("300 changed files");
    get.mockResolvedValue({ truncated: true, tree: [] });
    await expect(treePaths(access, pr.head.sha)).rejects.toThrow("tree");
  });
  it("slices batch pages and finding paths from one pinned diff", async () => {
    const files = Array.from({ length: 101 }, (_, index) => ({
      filename: `src/${index}.ts`,
      status: "added",
      additions: 1,
      deletions: 0,
      patch: "@@ -0,0 +1 @@\n+x",
    }));
    const get = vi
      .spyOn(helpers, "fetchGitHubAppJsonWithRetry")
      .mockResolvedValue(diff(files));
    await expect(
      snapshot(access, pr, false, {
        findingPaths: new Set([files[100].filename]),
      }),
    ).resolves.toMatchObject({ files: [files[100]], changedFiles: 101 });
    await expect(
      snapshot(access, pr, false, { page: 7 }),
    ).resolves.toMatchObject({ files: files.slice(96, 101) });
    await expect(snapshot(access, pr, false, { page: 8 })).rejects.toThrow(
      "incomplete",
    );
    // A diff over 60 files is reviewed in batches.
    await expect(snapshot(access, pr)).rejects.toThrow("review budget");
    expect(get).toHaveBeenCalledTimes(4);
  });
  it("splits the page before any model request when the combined diff is too large", () => {
    const file = {
      filename: "src/a.ts",
      status: "added",
      additions: 1,
      deletions: 0,
      patch: `@@ -0,0 +1 @@\n+${"x".repeat(55_000)}`,
    };
    const second = { ...file, filename: "src/b.ts" };
    expect(splitReviewDiff([file, second])).toEqual([[file], [second]]);
    const lockfile = { ...file, patch: file.patch.repeat(2) };
    const { patch: _omitted, ...withoutPatch } = lockfile;
    expect(splitReviewDiff([lockfile, second])).toEqual([
      [withoutPatch, second],
    ]);
    const small = { ...file, patch: `@@ -0,0 +1 @@\n+${"x".repeat(15_000)}` };
    const third = { ...small, filename: "src/c.ts" };
    const fourth = { ...small, filename: "src/d.ts" };
    // Diffs are grouped below the size that leaves room for source reads.
    expect(splitReviewDiff([small, third, fourth])).toEqual([
      [small, third],
      [fourth],
    ]);
    // A file without a diff stays in the batch it follows.
    expect(splitReviewDiff([small, third, withoutPatch, fourth])).toEqual([
      [small, third, withoutPatch],
      [fourth],
    ]);
  });
  it("encodes paths and refuses mutable refs, traversal and binary content", async () => {
    const get = vi
      .spyOn(helpers, "fetchGitHubAppJsonWithRetry")
      .mockResolvedValue({
        type: "file",
        encoding: "base64",
        content: btoa("const value = 1;"),
        size: 16,
      });
    expect(await readFile(access, "src/a b.ts", pr.head.sha)).toBe(
      "const value = 1;",
    );
    expect(get.mock.calls[0][0]).toContain("src/a%20b.ts?ref=" + pr.head.sha);
    await expect(readFile(access, "../.env", pr.head.sha)).rejects.toThrow();
    await expect(readFile(access, "a.ts", "main")).rejects.toThrow();
    get.mockResolvedValue({
      type: "file",
      encoding: "base64",
      content: btoa("x\0y"),
      size: 3,
    });
    await expect(readFile(access, "a.bin", pr.head.sha)).rejects.toThrow(
      "binary",
    );
  });
});
describe("PR webhook routing", () => {
  it("ignores malformed events and opt-out repositories", async () => {
    const runQuery = vi.fn().mockResolvedValue({
      settings: { pullRequestReviewsEnabled: false },
      isActive: true,
    });
    const runAfter = vi.fn();
    const ctx = { runQuery, scheduler: { runAfter } } as unknown as ActionCtx;
    await handlePullRequestEvent(ctx, { action: "opened" });
    await handlePullRequestEvent(ctx, {
      action: "opened",
      repository: { id: 123 },
      installation: { id: 42 },
      pull_request: { number: 12 },
    });
    expect(runAfter).not.toHaveBeenCalled();
  });
  it("routes by installation and immutable ID without trusting PR content or head", async () => {
    const runQuery = vi.fn().mockResolvedValue({
      _id: "repo-id",
      settings: { pullRequestReviewsEnabled: true },
      isActive: true,
    });
    const runAfter = vi.fn();
    await handlePullRequestEvent(
      { runQuery, scheduler: { runAfter } } as unknown as ActionCtx,
      {
        action: "synchronize",
        repository: { id: 123, full_name: "attacker/reused-name" },
        installation: { id: 42 },
        pull_request: {
          number: 12,
          body: "execute secrets",
          head: { sha: "untrusted" },
        },
      },
    );
    expect(runQuery.mock.calls[0][1]).toEqual({
      installationId: 42,
      githubRepositoryId: 123,
    });
    expect(runAfter.mock.calls[0][2]).toEqual({
      repositoryId: "repo-id",
      number: 12,
    });
  });
});

it("rejects a present but truncated patch", async () => {
  vi.spyOn(helpers, "fetchGitHubAppJsonWithRetry").mockResolvedValue(
    diff([
      {
        filename: "a.ts",
        status: "modified",
        additions: 3,
        deletions: 0,
        patch: "@@ -0,0 +1 @@\n+only one",
      },
    ]),
  );
  await expect(snapshot(access, pr)).rejects.toThrow("incomplete");
});
