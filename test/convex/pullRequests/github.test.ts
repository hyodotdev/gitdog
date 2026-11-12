import { afterEach, describe, expect, it, vi } from "vitest";
import * as helpers from "../../../convex/github/helpers";
import {
  getPullRequest,
  isBotPullRequestAuthor,
  snapshot,
  splitReviewDiff,
  readFile,
  treePaths,
  type PullRequest,
} from "../../../convex/pullRequests/github";
import { handlePullRequestEvent } from "../../../convex/pullRequests/webhook";
import type { VerifiedRepositoryAccess } from "../../../convex/github/repositoryIdentity";
import type { ActionCtx } from "../../../convex/_generated/server";
import { ReviewContextLimitError } from "../../../convex/pullRequests/errors";
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
  it("allows a closed immutable snapshot only for verification", async () => {
    const closed = { ...pr, state: "closed" };
    const mock = vi.spyOn(helpers, "fetchGitHubAppJsonWithRetry");
    const responses = () =>
      mock
        .mockResolvedValueOnce([
          {
            filename: "a.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
            patch: "@@ -0,0 +1 @@\n+x",
          },
        ])
        .mockResolvedValueOnce({ merge_base_commit: { sha: pr.base.sha } })
        .mockResolvedValueOnce(closed);
    responses();
    await expect(snapshot(access, closed)).rejects.toThrow("changed");
    responses();
    await expect(snapshot(access, closed, true)).resolves.toMatchObject({
      headSha: pr.head.sha,
    });
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
      .mockResolvedValueOnce([
        {
          filename: "src/a.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: "@@ -1 +1 @@\n-a\n+b",
        },
      ])
      .mockResolvedValueOnce({ merge_base_commit: { sha: "c".repeat(40) } })
      .mockResolvedValueOnce(pr);
    const result = await snapshot(access, pr);
    expect(result.baseSha).toBe("c".repeat(40));
    expect(get.mock.calls[1][0]).toContain(`${pr.base.sha}...${pr.head.sha}`);
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
    vi.spyOn(helpers, "fetchGitHubAppJsonWithRetry")
      .mockResolvedValueOnce([
        {
          ...file,
          sha: "d".repeat(40),
          blob_url: "https://github.com/owner/repo/blob/commit/src/a.ts",
          raw_url: "https://github.com/owner/repo/raw/commit/src/a.ts",
          contents_url:
            "https://api.github.com/repos/owner/repo/contents/src/a.ts",
          changes: 2,
        },
      ])
      .mockResolvedValueOnce({ merge_base_commit: { sha: pr.base.sha } })
      .mockResolvedValueOnce(pr);
    expect((await snapshot(access, pr)).files).toEqual([file]);
  });
  it("preserves the size-limit diagnostic before discarding transport metadata", async () => {
    vi.spyOn(helpers, "fetchGitHubAppJsonWithRetry").mockResolvedValueOnce([
      {
        filename: "a.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ -0,0 +1 @@\n+x",
        blob_url: "x".repeat(100_001),
      },
    ]);
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
    vi.spyOn(helpers, "fetchGitHubAppJsonWithRetry")
      .mockResolvedValueOnce([file])
      .mockResolvedValueOnce({ merge_base_commit: { sha: pr.base.sha } })
      .mockResolvedValueOnce(pr);
    expect(
      (await snapshot(access, pr, false, { findingPaths: new Set(["a.ts"]) }))
        .files,
    ).toEqual([file]);
  });
  it("rejects truncated files and a head change while reading", async () => {
    const get = vi
      .spyOn(helpers, "fetchGitHubAppJsonWithRetry")
      .mockResolvedValueOnce([]);
    await expect(snapshot(access, pr)).rejects.toThrow("incomplete");
    get
      .mockReset()
      .mockResolvedValueOnce([
        {
          filename: "a.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
          patch: "@@ -0,0 +1 @@\n+x",
        },
      ])
      .mockResolvedValueOnce({ merge_base_commit: { sha: pr.base.sha } })
      .mockResolvedValueOnce({ ...pr, head: { sha: "d".repeat(40) } });
    await expect(snapshot(access, pr)).rejects.toThrow("changed");
  });
  it("refuses PRs beyond the review file limit and truncated repository trees", async () => {
    await expect(
      snapshot(access, { ...pr, changed_files: 301 }),
    ).rejects.toThrow("300 changed files");
    vi.spyOn(helpers, "fetchGitHubAppJsonWithRetry").mockResolvedValue({
      truncated: true,
      tree: [],
    });
    await expect(treePaths(access, pr.head.sha)).rejects.toThrow("tree");
  });
  it("reads and checks every diff page before returning publication anchors", async () => {
    const large = { ...pr, changed_files: 101 };
    const files = Array.from({ length: 101 }, (_, index) => ({
      filename: `src/${index}.ts`,
      status: "added",
      additions: 1,
      deletions: 0,
      patch: "@@ -0,0 +1 @@\n+x",
    }));
    const get = vi.spyOn(helpers, "fetchGitHubAppJsonWithRetry");
    get
      .mockResolvedValueOnce(files.slice(0, 100))
      .mockResolvedValueOnce(files.slice(100))
      .mockResolvedValueOnce({ merge_base_commit: { sha: pr.base.sha } })
      .mockResolvedValueOnce(large);
    const options = { findingPaths: new Set([files[100].filename]) };
    await expect(
      snapshot(access, large, false, options),
    ).resolves.toMatchObject({
      files: [files[100]],
    });
    expect(get.mock.calls[0][0]).toContain("per_page=100&page=1");
    expect(get.mock.calls[1][0]).toContain("per_page=100&page=2");
    get
      .mockResolvedValueOnce(files.slice(0, 100))
      .mockResolvedValueOnce([files[0]]);
    await expect(snapshot(access, large, false, options)).rejects.toThrow(
      "incomplete",
    );
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
  vi.spyOn(helpers, "fetchGitHubAppJsonWithRetry").mockResolvedValue([
    {
      filename: "a.ts",
      status: "modified",
      additions: 3,
      deletions: 0,
      patch: "@@ -0,0 +1 @@\n+only one",
    },
  ]);
  await expect(snapshot(access, pr)).rejects.toThrow("incomplete");
});
