import { readFileSync } from "node:fs";
import { join } from "node:path";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "../../../convex/schema";
import { internal, api } from "../../../convex/_generated/api";
import * as helpers from "../../../convex/github/helpers";
import * as repositoryIdentity from "../../../convex/github/repositoryIdentity";
import * as subscriptionQueries from "../../../convex/subscriptions/internalQuery";
import {
  CURRENT_TERMS_VERSION,
  CURRENT_PRIVACY_POLICY_VERSION,
} from "../../../convex/users/legal";
import { drainScheduledFunctions } from "../scheduling";
import { PRICING, getFreeIncludedTokens } from "../../../convex/_ai/config";
import { encryptProviderKey } from "../../../convex/providerApiKeys/crypto";
const modules = import.meta.glob("../../../convex/**/*.ts");
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});
const source = {
  headSha: "b".repeat(40),
  baseSha: "a".repeat(40),
  title: "Change cache",
  body: "Description",
};
const settings = {
  issueAssistantEnabled: true,
  autoFormatIssue: true,
  autoAnswerQuestions: true,
  tagMaintainersForCodeChanges: true,
  discussionAssistantEnabled: true,
  autoFormatDiscussion: true,
  autoAnswerDiscussionQuestions: true,
  tagMaintainersForDiscussionCodeChanges: true,
  requireApproval: true,
  requireApprovalForDiscussions: true,
  pullRequestReviewsEnabled: true,
};
async function fixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    // The one-time trial is already used, so quota checks see only the
    // allowance each test sets up.
    await ctx.db.insert("trialCreditGrants", {
      userId,
      tokens: 100_000,
      grantedAt: 1,
    });
    await ctx.db.insert("userProfiles", {
      userId,
      githubUsername: "owner",
      minimumAgeAttestedAt: 1,
      professionalUseAttestedAt: 1,
      termsAcceptedVersion: CURRENT_TERMS_VERSION,
      privacyPolicyAcceptedVersion: CURRENT_PRIVACY_POLICY_VERSION,
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("githubInstallations", {
      userId,
      installationId: 42,
      ownerGithubAccountId: "123",
      ownershipVerifiedAt: 1,
      accountLogin: "owner",
      accountType: "User",
      targetType: "User",
      createdAt: 1,
      updatedAt: 1,
    });
    const repositoryId = await ctx.db.insert("repositories", {
      userId,
      installationId: 42,
      githubRepositoryId: 123,
      githubRepo: "owner/repo",
      githubRepoKey: "owner/repo",
      name: "repo",
      githubUrl: "https://github.com/owner/repo",
      isActive: true,
      indexVersion: 1,
      indexStatus: "completed",
      ragStatus: "completed",
      ragTotalChunks: 1,
      ragIndexedChunks: 1,
      ragFailedChunks: 0,
      indexSyncPending: false,
      indexProgressAt: 1,
      settings,
      monthlyActions: 0,
      lastResetAt: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    return { userId, repositoryId };
  });
  const observe = (snapshot = source, open = true) =>
    t.mutation(internal.pullRequests.internalMutation.observe, {
      repositoryId: ids.repositoryId,
      number: 12,
      author: "author",
      open,
      snapshot,
    });
  return { t, ...ids, observe };
}
const findings = [
  {
    path: "src/main.ts",
    line: 2,
    priority: "P2" as const,
    title: "Keep the requested key",
    body: "When the caller requests another key, the constant lookup returns an unrelated value. Preserve the caller parameter.",
    confidence: 0.95,
    evidence: [
      {
        path: "src/main.ts",
        ref: "head" as const,
        quote: "return cache.get('constant');",
      },
    ],
  },
];
describe("PR review durable lifecycle", () => {
  it("does not enqueue bot-authored pull requests through observation", async () => {
    const f = await fixture();
    for (const author of ["dependabot[bot]", "renovate[bot]", "custom[BOT]"]) {
      expect(
        await f.t.mutation(internal.pullRequests.internalMutation.observe, {
          repositoryId: f.repositoryId,
          number: 12,
          author,
          open: true,
          snapshot: source,
        }),
      ).toBeNull();
    }
    expect(await f.t.run((ctx) => ctx.db.query("tickets").take(1))).toEqual([]);
    expect(
      await f.t.run((ctx) => ctx.db.query("ticketActions").take(1)),
    ).toEqual([]);
  });
  it("deduplicates repeated webhook snapshots", async () => {
    const f = await fixture();
    const id = await f.observe();
    expect(id).toBeTruthy();
    expect(await f.observe()).toBeNull();
  });
  it("updates the queued review after a PR edit and does not rerun the commit after completion", async () => {
    const f = await fixture();
    const actionId = (await f.observe())!;
    const edited = {
      ...source,
      title: "Revised title",
      body: "Updated description",
    };
    await expect(f.observe(edited)).resolves.toBeNull();
    await expect(f.t.run((ctx) => ctx.db.get(actionId))).resolves.toMatchObject(
      {
        status: "pending",
        proposedChanges: { source: edited },
      },
    );
    await expect(
      f.t.mutation(internal.pullRequests.internalMutation.claimGeneration, {
        actionId,
      }),
    ).resolves.toBeTypeOf("string");
    await expect(
      f.t.mutation(internal.pullRequests.internalMutation.propose, {
        actionId,
        source: edited,
        findings: [],
        excludedPaths: [],
        filesRead: [],
      }),
    ).resolves.toBe(true);

    await expect(
      f.observe({ ...edited, body: "Another update" }),
    ).resolves.toBeNull();
    const actions = await f.t.run((ctx) =>
      ctx.db.query("ticketActions").take(2),
    );
    expect(actions).toHaveLength(1);
    // The no-findings summary goes straight to publication.
    expect(actions[0]).toMatchObject({ _id: actionId, status: "approved" });
  });
  it("keeps generating through a description edit without starting another review", async () => {
    const f = await fixture();
    const actionId = (await f.observe())!;
    await f.t.mutation(internal.pullRequests.internalMutation.claimGeneration, {
      actionId,
    });
    const edited = { ...source, body: "Edited while generating" };
    await expect(f.observe(edited)).resolves.toBeNull();
    await expect(f.observe(edited)).resolves.toBeNull();
    const actions = await f.t.run((ctx) =>
      ctx.db.query("ticketActions").take(2),
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ _id: actionId, status: "pending" });
    await f.t.mutation(internal.pullRequests.internalMutation.propose, {
      actionId,
      source,
      findings,
      excludedPaths: [],
      filesRead: ["head:src/main.ts"],
    });
    expect((await f.t.run((ctx) => ctx.db.get(actionId)))?.status).toBe(
      "pending_approval",
    );
    await f.observe({ ...edited, title: "Edited before approval" });
    expect((await f.t.run((ctx) => ctx.db.get(actionId)))?.status).toBe(
      "pending_approval",
    );
  });
  it("defaults to human approval and uses the dedicated claim", async () => {
    const f = await fixture();
    const actionId = (await f.observe())!;
    await f.t.mutation(internal.pullRequests.internalMutation.propose, {
      actionId,
      source,
      findings,
      excludedPaths: [],
      filesRead: ["head:src/main.ts"],
    });
    expect((await f.t.run((ctx) => ctx.db.get(actionId)))?.status).toBe(
      "pending_approval",
    );
    expect(
      await f.t.mutation(internal.pullRequests.internalMutation.claim, {
        actionId,
        manual: false,
      }),
    ).toBe(false);
    expect(
      await f.t.mutation(internal.pullRequests.internalMutation.claim, {
        actionId,
        manual: true,
      }),
    ).toBeTypeOf("number");
    expect(
      await f.t.mutation(internal.pullRequests.internalMutation.claim, {
        actionId,
        manual: true,
      }),
    ).toBe(false);
  });
  it("posts a summary for a review without findings, without approval", async () => {
    const f = await fixture();
    const actionId = (await f.observe())!;
    await f.t.mutation(internal.pullRequests.internalMutation.propose, {
      actionId,
      source,
      findings: [],
      excludedPaths: ["binary.png"],
      filesRead: ["head:src/main.ts"],
      coverage: { changedFiles: 2, uncoveredFiles: 1 },
    });
    const action = await f.t.run((ctx) => ctx.db.get(actionId));
    expect(action).toMatchObject({
      status: "approved",
      proposedChanges: { changedFiles: 2, uncoveredFiles: 1 },
    });
    expect(action?.proposedChanges?.suggestedResponse).toContain(
      "**No issues found**",
    );
    expect(action?.proposedChanges?.suggestedResponse).toContain(
      "1 of 2 changed files was not fully reviewed.",
    );
    expect(action).not.toHaveProperty("executionResult");
  });
  describe("generation failures", () => {
    const pullRequest = {
      id: 100,
      number: 12,
      state: "open",
      draft: false,
      title: source.title,
      body: source.body,
      user: { login: "author" },
      head: { sha: source.headSha },
      base: { sha: source.baseSha, repo: { id: 123 } },
      changed_files: 1,
    };
    const changedFile = {
      filename: "src/a.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: "@@ -0,0 +1 @@\n+a",
    };
    async function generate(responses: unknown[], failure?: Error) {
      vi.spyOn(
        repositoryIdentity,
        "resolveVerifiedRepositoryAccess",
      ).mockResolvedValue({
        owner: "owner",
        repo: "repo",
        githubRepositoryId: 123,
        token: "fixture-token",
      } as repositoryIdentity.VerifiedRepositoryAccess);
      const fetch = vi.spyOn(helpers, "fetchGitHubAppJsonWithRetry");
      for (const response of responses) fetch.mockResolvedValueOnce(response);
      if (failure) fetch.mockRejectedValueOnce(failure);
      const f = await fixture();
      const actionId = (await f.observe())!;
      await f.t.action(internal.pullRequests.internalAction.generate, {
        actionId,
      });
      return await f.t.run((ctx) => ctx.db.get(actionId));
    }
    it("records the failed pinned source request on the review ticket", async () => {
      const filename = "src/pages/[id].tsx";
      const tree = {
        truncated: false,
        tree: [{ type: "blob", path: filename }],
      };
      const action = await generate(
        [
          pullRequest,
          {
            merge_base_commit: { sha: source.baseSha },
            files: [{ ...changedFile, filename }],
          },
          tree,
          tree,
        ],
        new Error("Read review context failed (HTTP 404)"),
      );
      expect(action).toMatchObject({
        status: "failed",
        reviewFailureDetails: [
          "Stage · AI generation and evidence validation",
          "Request · Read GitHub source file",
          `File · ${filename} @ ${source.headSha.slice(0, 12)}`,
          "Reason · GitHub could not find the requested resource (HTTP 404).",
        ].join("\n"),
      });
    });
    it("explains that a PR has too many changed files", async () => {
      expect(
        await generate([
          pullRequest,
          {
            merge_base_commit: { sha: source.baseSha },
            files: Array.from({ length: 300 }, (_, i) => ({
              ...changedFile,
              filename: `src/file-${i}.ts`,
            })),
          },
        ]),
      ).toMatchObject({
        status: "failed",
        errorMessage:
          "Review covers at most 300 changed files; split this PR for complete coverage",
      });
    });
    it("explains that a PR diff exceeds the review budget", async () => {
      const oversized = {
        ...changedFile,
        additions: 40_000,
        patch: `@@ -0,0 +1,40000 @@${"\n+a".repeat(40_000)}`,
      };
      expect(
        await generate([
          pullRequest,
          { merge_base_commit: { sha: source.baseSha }, files: [oversized] },
          // Batches drop the oversized diff, which leaves nothing to review.
          { merge_base_commit: { sha: source.baseSha }, files: [oversized] },
        ]),
      ).toMatchObject({
        status: "failed",
        errorMessage:
          "Pull request diff exceeds the review budget; split this PR",
        reviewFailureDetails:
          "Stage · Source preflight\nReason · Pull request diff exceeds the review budget; split this PR",
      });
    });
    it("describes a mismatched diff without storing its payload", async () => {
      const action = await generate([
        pullRequest,
        {
          merge_base_commit: { sha: source.baseSha },
          files: [{ ...changedFile, additions: 5 }],
        },
      ]);
      expect(action).toMatchObject({ status: "failed" });
      expect(action?.reviewFailureDetails).toContain(
        "GitHub's diff did not match the expected changed files and line counts.",
      );
    });
  });
  it("invalidates prior proposals on a new head and refuses late generation", async () => {
    const f = await fixture();
    const actionId = (await f.observe())!;
    await f.observe({ ...source, headSha: "c".repeat(40) });
    expect(
      await f.t.mutation(internal.pullRequests.internalMutation.propose, {
        actionId,
        source,
        findings,
        excludedPaths: [],
        filesRead: [],
      }),
    ).toBe(false);
    expect((await f.t.run((ctx) => ctx.db.get(actionId)))?.status).toBe(
      "failed",
    );
  });
  it("drops a push while a review runs and reviews only when none is running", async () => {
    const f = await fixture();
    const actionId = (await f.observe())!;
    await f.t.mutation(internal.pullRequests.internalMutation.claimGeneration, {
      actionId,
    });
    const next = { ...source, headSha: "c".repeat(40) };
    expect(await f.observe(next)).toBeNull();
    expect(await f.t.run((ctx) => ctx.db.get(actionId))).toMatchObject({
      status: "pending",
    });
    const ticket = async () =>
      f.t.run(async (ctx) =>
        ctx.db.get((await ctx.db.get(actionId))!.ticketId),
      );
    expect((await ticket())?.pullRequestHeadSha).toBe(source.headSha);
    // The running review still finishes on its own commit.
    expect(
      await f.t.mutation(internal.pullRequests.internalMutation.propose, {
        actionId,
        source,
        findings: [],
        excludedPaths: [],
        filesRead: [],
      }),
    ).toBe(true);
    await f.t.run((ctx) =>
      ctx.db.patch(actionId, {
        status: "completed",
        executionResult: { published: true },
      }),
    );
    // Once it is done, the next push starts a review again.
    expect(await f.observe(next)).toBeTruthy();
    expect((await ticket())?.pullRequestHeadSha).toBe(next.headSha);
  });
  it("keeps a review waiting for approval after a dropped push", async () => {
    const f = await fixture();
    const actionId = (await f.observe())!;
    await f.t.mutation(internal.pullRequests.internalMutation.claimGeneration, {
      actionId,
    });
    expect(await f.observe({ ...source, headSha: "c".repeat(40) })).toBeNull();
    await f.t.mutation(internal.pullRequests.internalMutation.propose, {
      actionId,
      source,
      findings,
      excludedPaths: [],
      filesRead: [],
    });
    await f.t.finishAllScheduledFunctions(() => {});
    expect((await f.t.run((ctx) => ctx.db.get(actionId)))?.status).toBe(
      "pending_approval",
    );
    expect(
      await f.t.run((ctx) => ctx.db.query("ticketActions").collect()),
    ).toHaveLength(1);
  });
  it("does not let an unclaimed approved review hold back later pushes", async () => {
    const f = await fixture();
    const actionId = (await f.observe())!;
    await f.t.mutation(internal.pullRequests.internalMutation.claimGeneration, {
      actionId,
    });
    await f.t.mutation(internal.pullRequests.internalMutation.propose, {
      actionId,
      source,
      findings: [],
      excludedPaths: [],
      filesRead: [],
    });
    expect((await f.t.run((ctx) => ctx.db.get(actionId)))?.status).toBe(
      "approved",
    );
    // Nothing is in flight until publication claims it, so a push still
    // supersedes it and starts a review.
    expect(
      await f.observe({ ...source, headSha: "c".repeat(40) }),
    ).toBeTruthy();
    expect((await f.t.run((ctx) => ctx.db.get(actionId)))?.status).toBe(
      "failed",
    );
  });
  it("closing or converting to draft prevents approval", async () => {
    const f = await fixture();
    const actionId = (await f.observe())!;
    await f.t.mutation(internal.pullRequests.internalMutation.propose, {
      actionId,
      source,
      findings,
      excludedPaths: [],
      filesRead: [],
    });
    await f.observe(source, false);
    expect(
      await f.t.mutation(internal.pullRequests.internalMutation.claim, {
        actionId,
        manual: true,
      }),
    ).toBe(false);
  });
  it("cannot overwrite a live claim from a concurrent preflight failure", async () => {
    const f = await fixture();
    const actionId = (await f.observe())!;
    await f.t.mutation(internal.pullRequests.internalMutation.propose, {
      actionId,
      source,
      findings,
      excludedPaths: [],
      filesRead: [],
    });
    const claimedAt = await f.t.mutation(
      internal.pullRequests.internalMutation.claim,
      { actionId, manual: true },
    );
    await f.t.mutation(internal.pullRequests.internalMutation.finish, {
      actionId,
      stage: "preflight",
      error: "concurrent failure",
    });
    expect((await f.t.run((ctx) => ctx.db.get(actionId)))?.status).toBe(
      "approved",
    );
    await f.t.mutation(internal.pullRequests.internalMutation.finish, {
      actionId,
      stage: "publication",
      claimedAt: claimedAt as number,
      reviewId: 99,
      reviewUrl: "https://github.com/owner/repo/pull/12#pullrequestreview-99",
    });
    expect((await f.t.run((ctx) => ctx.db.get(actionId)))?.status).toBe(
      "completed",
    );
  });
  it("requires legal eligibility and active settings before generation", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      const p = await ctx.db
        .query("userProfiles")
        .withIndex("by_user", (q) => q.eq("userId", f.userId))
        .unique();
      await ctx.db.patch(p!._id, { termsAcceptedVersion: "2000-01-01" });
    });
    expect(await f.observe()).toBeNull();
  });
  it("retains new settings when an older client saves issue settings", async () => {
    const f = await fixture();
    const { pullRequestReviewsEnabled: _, ...oldSettings } = settings;
    void _;
    await f.t
      .withIdentity({ subject: f.userId })
      .mutation(api.repositories.mutation.updateSettings, {
        repositoryId: f.repositoryId,
        settings: oldSettings,
      });
    expect(
      (await f.t.run((ctx) => ctx.db.get(f.repositoryId)))?.settings
        .pullRequestReviewsEnabled,
    ).toBe(true);
  });
  it("rejects non-owner settings changes", async () => {
    const f = await fixture();
    const other = await f.t.run((ctx) => ctx.db.insert("users", {}));
    await expect(
      f.t
        .withIdentity({ subject: other })
        .mutation(api.repositories.mutation.updateSettings, {
          repositoryId: f.repositoryId,
          settings,
        }),
    ).rejects.toThrow("unauthorized");
  });
});

describe("bot review quota protection at the live GitHub boundary", () => {
  async function liveFixture(author: { login: string; type?: string }) {
    const f = await fixture();
    const github = await import("../../../convex/pullRequests/github");
    const billing = await import("../../../convex/_ai/chatBilling");
    const repository = (await f.t.run((ctx) => ctx.db.get(f.repositoryId)))!;
    vi.spyOn(
      repositoryIdentity,
      "resolveVerifiedRepositoryAccess",
    ).mockResolvedValue({
      repository,
      installation: {} as never,
      githubRepositoryId: 123,
      githubRepo: "owner/repo",
      owner: "owner",
      repo: "repo",
      token: "fixture-token",
    });
    vi.spyOn(github, "getPullRequest").mockResolvedValue({
      id: 1,
      number: 12,
      state: "open",
      draft: false,
      title: source.title,
      body: source.body,
      user: author,
      head: { sha: source.headSha },
      base: { sha: source.baseSha, repo: { id: 123 } },
      changed_files: 1,
    });
    const snapshot = vi.spyOn(github, "snapshot");
    const provider = vi.spyOn(billing, "createMeteredProvider");
    return { ...f, snapshot, provider };
  }
  it.each([
    { login: "dependabot[bot]", type: "Bot" },
    { login: "renovate[bot]" },
    { login: "custom-automation", type: "Bot" },
  ])(
    "blocks live bot %j before scheduling, source reads or billing",
    async (author) => {
      const f = await liveFixture(author);
      await f.t.action(internal.pullRequests.internalAction.observe, {
        repositoryId: f.repositoryId,
        number: 12,
      });
      expect(
        await f.t.run((ctx) => ctx.db.query("ticketActions").take(1)),
      ).toEqual([]);
      // Simulate a job queued before the bot exclusion was deployed.
      const actionId = (await f.observe())!;
      await f.t.action(internal.pullRequests.internalAction.generate, {
        actionId,
      });
      expect(f.snapshot).not.toHaveBeenCalled();
      expect(f.provider).not.toHaveBeenCalled();
      expect(await f.t.run((ctx) => ctx.db.get(actionId))).toMatchObject({
        status: "failed",
        errorMessage: expect.stringContaining(
          "Bot-authored pull requests are excluded",
        ),
      });
      await expect(
        f.t
          .withIdentity({ subject: f.userId })
          .action(api.pullRequests.action.recheck, { actionId }),
      ).rejects.toThrow("Bot-authored pull requests are not reviewed");
      expect(f.provider).not.toHaveBeenCalled();
    },
  );
  it("still schedules a human PR from the authoritative observation", async () => {
    const f = await liveFixture({ login: "robotics-maintainer", type: "User" });
    await f.t.action(internal.pullRequests.internalAction.observe, {
      repositoryId: f.repositoryId,
      number: 12,
    });
    expect(
      await f.t.run((ctx) => ctx.db.query("ticketActions").take(1)),
    ).toHaveLength(1);
  });
});

it("does not allow a late older observation to supersede the new head", async () => {
  const f = await fixture();
  const actionId = await f.t.mutation(
    internal.pullRequests.internalMutation.observe,
    {
      repositoryId: f.repositoryId,
      number: 12,
      author: "author",
      open: true,
      snapshot: { ...source, headSha: "d".repeat(40) },
      observedAt: 200,
    },
  );
  expect(
    await f.t.mutation(internal.pullRequests.internalMutation.observe, {
      repositoryId: f.repositoryId,
      number: 12,
      author: "author",
      open: true,
      snapshot: source,
      observedAt: 100,
    }),
  ).toBeNull();
  const row = await f.t.run((ctx) => ctx.db.get(actionId!));
  expect(row?.status).toBe("pending");
});
it("claims generation only once", async () => {
  const f = await fixture();
  const actionId = (await f.observe())!;
  expect(
    await f.t.mutation(internal.pullRequests.internalMutation.claimGeneration, {
      actionId,
    }),
  ).toBeTypeOf("string");
  expect(
    await f.t.mutation(internal.pullRequests.internalMutation.claimGeneration, {
      actionId,
    }),
  ).toBeNull();
});

it("allows one generation across two automatic actions already queued for the same commit", async () => {
  const f = await fixture();
  const first = (await f.observe())!;
  const second = await f.t.run(async (ctx) => {
    const original = (await ctx.db.get(first))!;
    return ctx.db.insert("ticketActions", {
      ticketId: original.ticketId,
      actionType: "review",
      proposedChanges: { source },
      proposalVersion: 1,
      status: "pending",
      chatHistory: [],
      createdAt: Date.now(),
    });
  });
  const claims = await Promise.all(
    [first, second].map((actionId) =>
      f.t.mutation(internal.pullRequests.internalMutation.claimGeneration, {
        actionId,
      }),
    ),
  );
  expect(claims.filter((token) => typeof token === "string")).toHaveLength(1);
  const rows = await f.t.run((ctx) => ctx.db.query("ticketActions").take(3));
  expect(rows).toContainEqual(
    expect.objectContaining({
      status: "failed",
      errorMessage: "Automatic review already attempted for this commit",
    }),
  );
});

async function publicationFixture(empty = false, uncoveredFiles = 1) {
  const f = await fixture();
  const actionId = (await f.observe())!;
  const suggestion = {
    startLine: 2,
    original: " return cache.get('constant');",
    replacement: " return cache.get(key);",
  };
  await f.t.mutation(internal.pullRequests.internalMutation.propose, {
    actionId,
    source,
    findings: empty ? [] : [{ ...findings[0], suggestion }],
    excludedPaths: [],
    filesRead: ["head:src/main.ts"],
    ...(empty ? { coverage: { changedFiles: 3, uncoveredFiles } } : {}),
  });
  const identity = await import("../../../convex/github/repositoryIdentity");
  const github = await import("../../../convex/pullRequests/github");
  const helpers = await import("../../../convex/github/helpers");
  const repository = (await f.t.run((ctx) => ctx.db.get(f.repositoryId)))!;
  vi.spyOn(identity, "resolveVerifiedRepositoryAccess").mockResolvedValue({
    repository,
    installation: {} as never,
    githubRepositoryId: 123,
    githubRepo: "owner/repo",
    owner: "owner",
    repo: "repo",
    token: "fixture-token",
  });
  const live = vi.spyOn(github, "getPullRequest").mockResolvedValue({
    id: 1,
    number: 12,
    state: "open",
    draft: false,
    title: source.title,
    body: source.body,
    user: { login: "author" },
    head: { sha: source.headSha },
    base: { sha: source.baseSha, repo: { id: 123 } },
    changed_files: 1,
  });
  vi.spyOn(github, "snapshot").mockResolvedValue({
    headSha: source.headSha,
    baseSha: source.baseSha,
    files: [
      {
        filename: "src/main.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch:
          "@@ -1,3 +1,3 @@\n function find(key) {\n- return cache.get(key);\n+ return cache.get('constant');\n }",
      },
    ],
  });
  vi.spyOn(github, "readReviewFile").mockResolvedValue(
    "function find(key) {\n return cache.get('constant');\n}",
  );
  vi.spyOn(helpers, "fetchGitHubAppJsonWithRetry").mockResolvedValue([]);
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      id: 77,
      commit_id: source.headSha,
      body: `<!-- gitdog-pr-review:${actionId} -->`,
      html_url: "https://github.com/owner/repo/pull/12#pullrequestreview-77",
    }),
  );
  return { ...f, actionId, live, fetch };
}
afterEach(() => vi.restoreAllMocks());
it("publishes one COMMENT review with native suggestions against the exact head", async () => {
  const f = await publicationFixture();
  expect(
    await f.t.action(internal.pullRequests.internalAction.publish, {
      actionId: f.actionId,
      manual: true,
    }),
  ).toEqual({ success: true });
  expect(f.fetch).toHaveBeenCalledTimes(1);
  const request = JSON.parse(f.fetch.mock.calls[0][1]!.body as string);
  expect(request).toMatchObject({
    event: "COMMENT",
    commit_id: source.headSha,
    comments: [
      {
        path: "src/main.ts",
        line: 2,
        side: "RIGHT",
        body: expect.stringContaining(
          "```suggestion\n return cache.get(key);\n```",
        ),
      },
    ],
  });
  expect(
    (await f.t.run((ctx) => ctx.db.get(f.actionId)))?.executionResult,
  ).toMatchObject({ reviewId: 77, published: true });
});
it("posts a summary review without inline comments when nothing was found", async () => {
  const f = await publicationFixture(true);
  const snapshot = vi.spyOn(
    await import("../../../convex/pullRequests/github"),
    "snapshot",
  );
  expect(
    await f.t.action(internal.pullRequests.internalAction.publish, {
      actionId: f.actionId,
      manual: false,
    }),
  ).toEqual({ success: true });
  expect(snapshot).not.toHaveBeenCalled();
  const request = JSON.parse(f.fetch.mock.calls[0][1]!.body as string);
  expect(request).not.toHaveProperty("comments");
  expect(request.body).toBe(
    `**No issues found** in ${source.headSha}\n\n1 of 3 changed files was not fully reviewed.\n\n<sub>Not a merge approval. Tests were not run. [Gitdog](https://gitdog.dev)</sub>\n\n<!-- gitdog-pr-review:${f.actionId} -->`,
  );
  expect(
    (await f.t.run((ctx) => ctx.db.get(f.actionId)))?.executionResult,
  ).toMatchObject({ reviewId: 77, published: true });
});
describe("approval", () => {
  const ownApproval = {
    id: 5,
    state: "APPROVED",
    body: "earlier",
    commit_id: "c".repeat(40),
    html_url: "https://github.com/owner/repo/pull/12#pullrequestreview-5",
    user: { type: "Bot", login: "gitdogbot[bot]" },
  };
  async function github(
    threads: Array<{ isResolved: boolean }>,
    graphql: {
      failed?: boolean;
      more?: boolean;
      dismissFails?: boolean;
      errors?: boolean;
      author?: string;
    } = {},
  ) {
    const helpers = await import("../../../convex/github/helpers");
    return vi
      .mocked(helpers.fetchGitHubAppJsonWithRetry)
      .mockImplementation(async (url) => {
        if (url.endsWith("/graphql") && graphql.failed)
          throw new Error("GraphQL unavailable");
        if (url.includes("/dismissals") && graphql.dismissFails)
          throw new Error("Dismissal refused");
        if (url.endsWith("/graphql"))
          return {
            ...(graphql.errors ? { errors: [{ message: "partial" }] } : {}),
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    pageInfo: { hasNextPage: graphql.more === true },
                    nodes: threads.map((t) => ({
                      ...t,
                      comments: {
                        nodes: [
                          { author: { login: graphql.author ?? "gitdogbot" } },
                        ],
                      },
                    })),
                  },
                },
              },
            },
          } as never;
        if (url.includes("/reviews?")) return [ownApproval] as never;
        return {} as never;
      });
  }
  it("approves past a thread someone else left open", async () => {
    const f = await publicationFixture(true, 0);
    await github([{ isResolved: false }], { author: "maintainer" });
    await f.t.action(internal.pullRequests.internalAction.publish, {
      actionId: f.actionId,
      manual: false,
    });
    expect(JSON.parse(f.fetch.mock.calls[0][1]!.body as string).event).toBe(
      "APPROVE",
    );
  });
  it("approves a fully covered review with nothing found", async () => {
    const f = await publicationFixture(true, 0);
    const calls = await github([{ isResolved: true }]);
    await f.t.action(internal.pullRequests.internalAction.publish, {
      actionId: f.actionId,
      manual: false,
    });
    const request = JSON.parse(f.fetch.mock.calls[0][1]!.body as string);
    expect(request.event).toBe("APPROVE");
    expect(request.body).toContain("Approved because no issues were found");
    expect(calls.mock.calls.some(([url]) => url.includes("/dismissals"))).toBe(
      false,
    );
  });
  it.each([
    ["an earlier Gitdog thread is unresolved", [{ isResolved: false }], {}],
    ["the thread read fails", [], { failed: true }],
    ["the threads do not fit one page", [], { more: true }],
    ["GitHub reports errors with the threads", [], { errors: true }],
  ] as const)("only comments when %s", async (_case, threads, graphql) => {
    const f = await publicationFixture(true, 0);
    const calls = await github([...threads], graphql);
    expect(
      await f.t.action(internal.pullRequests.internalAction.publish, {
        actionId: f.actionId,
        manual: false,
      }),
    ).toEqual({ success: true });
    expect(calls.mock.calls.some(([url]) => url.endsWith("/graphql"))).toBe(
      true,
    );
    expect(JSON.parse(f.fetch.mock.calls[0][1]!.body as string).event).toBe(
      "COMMENT",
    );
  });
  it("only comments when the PR head moved past the reviewed commit", async () => {
    const f = await publicationFixture(true, 0);
    const calls = await github([]);
    const answer = calls.getMockImplementation()!;
    calls.mockImplementation(async (url, ...rest) =>
      url.includes("/compare/")
        ? ({ status: "ahead" } as never)
        : answer(url, ...rest),
    );
    f.live.mockResolvedValue({
      id: 1,
      number: 12,
      state: "open",
      draft: false,
      title: source.title,
      body: source.body,
      user: { login: "author" },
      head: { sha: "d".repeat(40) },
      base: { sha: source.baseSha, repo: { id: 123 } },
      changed_files: 1,
    });
    await f.t.action(internal.pullRequests.internalAction.publish, {
      actionId: f.actionId,
      manual: false,
    });
    expect(JSON.parse(f.fetch.mock.calls[0][1]!.body as string)).toMatchObject({
      event: "COMMENT",
      commit_id: source.headSha,
    });
  });
  it("posts a comment when GitHub refuses the approval", async () => {
    const f = await publicationFixture(true, 0);
    await github([]);
    const posted = f.fetch.getMockImplementation()!;
    f.fetch
      .mockResolvedValueOnce(new Response(null, { status: 422 }))
      .mockImplementation(posted);
    expect(
      await f.t.action(internal.pullRequests.internalAction.publish, {
        actionId: f.actionId,
        manual: false,
      }),
    ).toEqual({ success: true });
    const [first, second] = f.fetch.mock.calls.map(
      (call) => JSON.parse(call[1]!.body as string) as Record<string, string>,
    );
    expect(first.event).toBe("APPROVE");
    expect(second.event).toBe("COMMENT");
    expect(second.body).toContain("Not a merge approval");
  });
  it("withdraws its approval once a newer commit is pushed", async () => {
    const f = await publicationFixture(true, 0);
    await github([]);
    await f.t.action(internal.pullRequests.internalAction.publish, {
      actionId: f.actionId,
      manual: false,
    });
    const ticket = () =>
      f.t.run(async (ctx) => ctx.db.query("tickets").first());
    expect((await ticket())?.pullRequestApprovedSha).toBe(source.headSha);
    // The same commit observed again keeps the approval.
    await f.observe();
    expect((await ticket())?.pullRequestApprovedSha).toBe(source.headSha);
    const calls = await github([]);
    await f.observe({ ...source, headSha: "e".repeat(40) });
    await drainScheduledFunctions(f.t);
    // Forgotten only once the dismissal ran.
    expect((await ticket())?.pullRequestApprovedSha).toBeUndefined();
    expect(
      calls.mock.calls.some(([url]) =>
        url.endsWith("/pulls/12/reviews/5/dismissals"),
      ),
    ).toBe(true);
  });
  it("only comments after a push was dropped during the review", async () => {
    const f = await publicationFixture(true, 0);
    await github([]);
    await f.t.run(async (ctx) => {
      const ticket = (await ctx.db.query("tickets").first())!;
      await ctx.db.patch(ticket._id, { pullRequestDroppedAt: 1 });
    });
    await f.t.action(internal.pullRequests.internalAction.publish, {
      actionId: f.actionId,
      manual: false,
    });
    expect(JSON.parse(f.fetch.mock.calls[0][1]!.body as string).event).toBe(
      "COMMENT",
    );
  });
  it("does not withdraw an approval when only the thread read fails", async () => {
    const f = await publicationFixture(true, 0);
    const calls = await github([], { failed: true });
    await f.t.action(internal.pullRequests.internalAction.publish, {
      actionId: f.actionId,
      manual: false,
    });
    expect(calls.mock.calls.some(([url]) => url.includes("/dismissals"))).toBe(
      false,
    );
  });
  it("dismisses earlier approvals when an already posted review had findings", async () => {
    const f = await publicationFixture();
    const calls = await github([]);
    const answer = calls.getMockImplementation()!;
    calls.mockImplementation(async (url, ...rest) =>
      url.includes("/reviews?")
        ? ([
            {
              id: 9,
              state: "COMMENTED",
              body: `<!-- gitdog-pr-review:${f.actionId} -->`,
              commit_id: source.headSha,
              html_url:
                "https://github.com/owner/repo/pull/12#pullrequestreview-9",
              user: { type: "Bot", login: "gitdogbot[bot]" },
            },
            ownApproval,
          ] as never)
        : answer(url, ...rest),
    );
    expect(
      await f.t.action(internal.pullRequests.internalAction.publish, {
        actionId: f.actionId,
        manual: true,
      }),
    ).toEqual({ success: true });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(
      calls.mock.calls.some(([url]) => url.endsWith("/reviews/5/dismissals")),
    ).toBe(true);
  });
  it.each([
    [0, "approved"],
    [1, "completed"],
  ])(
    "offers a no-change follow-up for approval only when everything was reviewed (first review left %i files)",
    async (uncovered, status) => {
      const f = await fixture();
      const first = (await f.observe())!;
      await f.t.mutation(internal.pullRequests.internalMutation.propose, {
        actionId: first,
        source,
        findings: [],
        excludedPaths: uncovered ? ["binary.png"] : [],
        filesRead: [],
        coverage: { changedFiles: 2, uncoveredFiles: uncovered },
      });
      await f.t.run((ctx) =>
        ctx.db.patch(first, {
          status: "completed",
          executionResult: { published: true },
        }),
      );
      const next = { ...source, headSha: "e".repeat(40) };
      const second = (await f.observe(next))!;
      await f.t.mutation(internal.pullRequests.internalMutation.propose, {
        actionId: second,
        source: next,
        findings: [],
        excludedPaths: [],
        filesRead: [],
        coverage: { changedFiles: 0, uncoveredFiles: 0, since: source.headSha },
      });
      const action = await f.t.run((ctx) => ctx.db.get(second));
      expect(action?.status).toBe(status);
      if (status === "approved")
        expect(action?.proposedChanges?.suggestedResponse).toContain(
          `No pull request changes since ${source.headSha}.`,
        );
    },
  );
  it("builds a follow-up on the review of the commit it started from", async () => {
    const f = await fixture();
    const first = (await f.observe())!;
    const ticketId = (await f.t.run((ctx) => ctx.db.get(first)))!.ticketId;
    await f.t.run((ctx) => ctx.db.delete(first));
    const finished = (headSha: string, coverageComplete: boolean) =>
      f.t.run((ctx) =>
        ctx.db.insert("ticketActions", {
          ticketId,
          actionType: "review",
          status: "completed",
          proposalVersion: 1,
          chatHistory: [],
          createdAt: Date.now(),
          executionResult: { published: true, inlineFindings: true },
          proposedChanges: {
            source: { ...source, headSha },
            mergeBaseSha: source.baseSha,
            findings: [],
            uncoveredFiles: coverageComplete ? 0 : 1,
            changedFiles: 1,
            excludedPaths: [],
            coverageComplete,
          },
        }),
      );
    await finished(source.headSha, true);
    vi.advanceTimersByTime(1000);
    // A newer, incomplete review of another commit must not be the base.
    await finished("c".repeat(40), false);
    const next = { ...source, headSha: "e".repeat(40) };
    const followUp = (await f.observe(next))!;
    await f.t.mutation(internal.pullRequests.internalMutation.propose, {
      actionId: followUp,
      source: next,
      findings: [],
      excludedPaths: [],
      filesRead: [],
      coverage: { changedFiles: 1, uncoveredFiles: 0, since: source.headSha },
    });
    expect(
      (await f.t.run((ctx) => ctx.db.get(followUp)))?.proposedChanges
        ?.coverageComplete,
    ).toBe(true);
  });
  it("remembers an approval whose post outcome is unclear", async () => {
    const f = await publicationFixture(true, 0);
    await github([]);
    f.fetch.mockRejectedValue(new TypeError("network interruption"));
    await f.t.action(internal.pullRequests.internalAction.publish, {
      actionId: f.actionId,
      manual: false,
    });
    expect(
      (await f.t.run((ctx) => ctx.db.query("tickets").first()))
        ?.pullRequestApprovedSha,
    ).toBe(source.headSha);
  });
  it("keeps an approval of the current head and retries a failed withdrawal", async () => {
    const f = await publicationFixture(true, 0);
    const calls = await github([]);
    const answer = calls.getMockImplementation()!;
    const current = { ...ownApproval, id: 6, commit_id: source.headSha };
    calls.mockImplementation(async (url, ...rest) =>
      url.includes("/reviews?")
        ? ([ownApproval, current] as never)
        : answer(url, ...rest),
    );
    const ticketId = (await f.t.run((ctx) => ctx.db.query("tickets").first()))!
      ._id;
    const withdraw = () =>
      f.t.action(internal.pullRequests.internalAction.dismissStaleApproval, {
        repositoryId: f.repositoryId,
        number: 12,
        ticketId,
        staleSha: "c".repeat(40),
      });
    await f.t.run((ctx) =>
      ctx.db.patch(ticketId, { pullRequestApprovedSha: "c".repeat(40) }),
    );
    f.live.mockRejectedValueOnce(new Error("GitHub unavailable"));
    await expect(withdraw()).rejects.toThrow();
    expect(
      (await f.t.run((ctx) => ctx.db.get(ticketId)))?.pullRequestApprovedSha,
    ).toBe("c".repeat(40));
    await withdraw();
    const dismissed = calls.mock.calls
      .map(([url]) => url)
      .filter((url) => url.includes("/dismissals"));
    expect(dismissed).toEqual([
      "https://api.github.com/repos/owner/repo/pulls/12/reviews/5/dismissals",
    ]);
    expect(
      (await f.t.run((ctx) => ctx.db.get(ticketId)))?.pullRequestApprovedSha,
    ).toBeUndefined();
  });
  it("keeps an approval newer than the review that found issues", async () => {
    const f = await publicationFixture();
    const calls = await github([]);
    const answer = calls.getMockImplementation()!;
    calls.mockImplementation(async (url, ...rest) =>
      url.includes("/reviews?")
        ? ([{ ...ownApproval, id: 500 }] as never)
        : answer(url, ...rest),
    );
    await f.t.action(internal.pullRequests.internalAction.publish, {
      actionId: f.actionId,
      manual: true,
    });
    expect(calls.mock.calls.some(([url]) => url.includes("/dismissals"))).toBe(
      false,
    );
  });
  async function noChangeFollowUp(removedFiles?: number) {
    const f = await publicationFixture(true, 0);
    await f.t.run((ctx) =>
      ctx.db.patch(f.actionId, {
        status: "completed",
        executionResult: { published: true, inlineFindings: true },
      }),
    );
    const next = { ...source, headSha: "e".repeat(40) };
    const actionId = (await f.observe(next))!;
    await f.t.mutation(internal.pullRequests.internalMutation.propose, {
      actionId,
      source: next,
      findings: [],
      excludedPaths: [],
      filesRead: [],
      coverage: {
        changedFiles: 0,
        uncoveredFiles: 0,
        since: source.headSha,
        ...(removedFiles ? { removedFiles } : {}),
      },
    });
    const live = await f.live.getMockImplementation()!(
      {} as never,
      12 as never,
    );
    f.live.mockResolvedValue({ ...live, head: { sha: next.headSha } } as never);
    const publish = () =>
      f.t.action(internal.pullRequests.internalAction.publish, {
        actionId,
        manual: false,
      });
    return { ...f, actionId, next, publish };
  }
  it("approves again after a push that changed nothing in the PR diff", async () => {
    const f = await noChangeFollowUp();
    await github([]);
    f.fetch.mockClear();
    f.fetch.mockResolvedValue(
      Response.json({
        id: 78,
        commit_id: f.next.headSha,
        body: `<!-- gitdog-pr-review:${f.actionId} -->`,
        html_url: "https://github.com/owner/repo/pull/12#pullrequestreview-78",
      }),
    );
    expect(await f.publish()).toEqual({ success: true });
    const request = JSON.parse(f.fetch.mock.calls[0][1]!.body as string);
    expect(request.event).toBe("APPROVE");
    expect(request.body).toContain(
      `No pull request changes since ${source.headSha}.`,
    );
  });
  it("posts nothing for a no-change follow-up that cannot approve", async () => {
    const f = await noChangeFollowUp();
    await github([{ isResolved: false }]);
    f.fetch.mockClear();
    expect(await f.publish()).toEqual({ success: true });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(
      (await f.t.run((ctx) => ctx.db.get(f.actionId)))?.executionResult,
    ).toEqual({ published: false, reason: "no_new_changes" });
  });
  it("does not approve again after a push that only deleted files", async () => {
    const f = await noChangeFollowUp(1);
    expect(
      (await f.t.run((ctx) => ctx.db.get(f.actionId)))?.executionResult,
    ).toEqual({ published: false, reason: "no_new_changes" });
  });
  it("keeps tracking an approval GitHub refused to dismiss after a push", async () => {
    const f = await publicationFixture(true, 0);
    await github([], { dismissFails: true });
    const ticketId = (await f.t.run((ctx) => ctx.db.query("tickets").first()))!
      ._id;
    await f.t.run((ctx) =>
      ctx.db.patch(ticketId, { pullRequestApprovedSha: "c".repeat(40) }),
    );
    await f.t.action(
      internal.pullRequests.internalAction.dismissStaleApproval,
      {
        repositoryId: f.repositoryId,
        number: 12,
        ticketId,
        staleSha: "c".repeat(40),
      },
    );
    expect(
      (await f.t.run((ctx) => ctx.db.get(ticketId)))?.pullRequestApprovedSha,
    ).toBe("c".repeat(40));
  });
  it("keeps tracking an approval while a review may still post it", async () => {
    const f = await publicationFixture(true, 0);
    const ticketId = (await f.t.run((ctx) => ctx.db.query("tickets").first()))!
      ._id;
    await f.t.run(async (ctx) => {
      await ctx.db.patch(ticketId, { pullRequestApprovedSha: source.headSha });
      await ctx.db.patch(f.actionId, { executionClaimedAt: 1 });
    });
    await f.t.mutation(internal.pullRequests.internalMutation.forgetApproval, {
      ticketId,
      staleSha: source.headSha,
    });
    expect(
      (await f.t.run((ctx) => ctx.db.get(ticketId)))?.pullRequestApprovedSha,
    ).toBe(source.headSha);
  });
  it("records an earlier approval GitHub refused to dismiss", async () => {
    const f = await publicationFixture();
    await github([], { dismissFails: true });
    expect(
      await f.t.action(internal.pullRequests.internalAction.publish, {
        actionId: f.actionId,
        manual: true,
      }),
    ).toEqual({ success: true });
    expect(
      (await f.t.run((ctx) => ctx.db.get(f.actionId)))?.executionResult,
    ).toMatchObject({ published: true, keptApprovals: [5] });
  });
  it("only comments when a changed file was not fully reviewed", async () => {
    const f = await publicationFixture(true, 1);
    await github([]);
    await f.t.action(internal.pullRequests.internalAction.publish, {
      actionId: f.actionId,
      manual: false,
    });
    expect(JSON.parse(f.fetch.mock.calls[0][1]!.body as string).event).toBe(
      "COMMENT",
    );
  });
  it("dismisses an earlier Gitdog approval when a review has findings", async () => {
    const f = await publicationFixture();
    const calls = await github([]);
    expect(
      await f.t.action(internal.pullRequests.internalAction.publish, {
        actionId: f.actionId,
        manual: true,
      }),
    ).toEqual({ success: true });
    expect(JSON.parse(f.fetch.mock.calls[0][1]!.body as string).event).toBe(
      "COMMENT",
    );
    const dismissal = calls.mock.calls.find(([url]) =>
      url.endsWith("/pulls/12/reviews/5/dismissals"),
    );
    expect(dismissal?.[3]).toMatchObject({ method: "PUT" });
    // Every finding became a thread, so a later review may approve.
    expect(
      (await f.t.run((ctx) => ctx.db.get(f.actionId)))?.executionResult,
    ).toMatchObject({ inlineFindings: true });
  });
  it.each([
    [1, [false, false], undefined],
    [0, [true, true], undefined],
    // Findings of the first review that never became threads.
    [0, [true, false], false],
    [0, [true, true], true],
  ])(
    "carries coverage into a follow-up when the first review left %i files (inline findings: %s)",
    async (uncovered, expected, inlineFindings) => {
      const f = await fixture();
      const first = (await f.observe())!;
      await f.t.mutation(internal.pullRequests.internalMutation.propose, {
        actionId: first,
        source,
        findings: [],
        excludedPaths: uncovered ? ["binary.png"] : [],
        filesRead: [],
        coverage: { changedFiles: 2, uncoveredFiles: uncovered },
      });
      await f.t.run(async (ctx) => {
        const proposal = (await ctx.db.get(first))!.proposedChanges;
        await ctx.db.patch(first, {
          status: "completed",
          executionResult: {
            published: true,
            ...(inlineFindings === undefined ? {} : { inlineFindings }),
          },
          ...(inlineFindings === undefined
            ? {}
            : { proposedChanges: { ...proposal, findingCount: 2 } }),
        });
      });
      const next = { ...source, headSha: "e".repeat(40) };
      const second = (await f.observe(next))!;
      await f.t.mutation(internal.pullRequests.internalMutation.propose, {
        actionId: second,
        source: next,
        findings: [],
        excludedPaths: [],
        filesRead: [],
        coverage: { changedFiles: 1, uncoveredFiles: 0, since: source.headSha },
      });
      const proposals = await f.t.run(async (ctx) => [
        (await ctx.db.get(first))?.proposedChanges?.coverageComplete,
        (await ctx.db.get(second))?.proposedChanges?.coverageComplete,
      ]);
      expect(proposals).toEqual(expected);
    },
  );
});
describe("batched publication", () => {
  async function batchedPublication() {
    const f = await publicationFixture();
    // Turn the saved review into a batched one whose evidence also quotes a
    // changed file that has no finding of its own.
    await f.t.run(async (ctx) => {
      const action = (await ctx.db.get(f.actionId))!;
      const [finding] = action.proposedChanges.findings;
      await ctx.db.patch(f.actionId, {
        proposedChanges: {
          ...action.proposedChanges,
          batchCount: 4,
          findingCount: 1,
          changedFiles: 70,
          uncoveredFiles: 0,
          findings: [
            {
              ...finding,
              evidence: [
                ...finding.evidence,
                {
                  path: "src/large.ts",
                  ref: "head",
                  quote: "const large = true;",
                },
              ],
            },
          ],
        },
      });
    });
    const github = await import("../../../convex/pullRequests/github");
    const snapshot = vi.spyOn(github, "snapshot");
    vi.spyOn(github, "readReviewFile").mockImplementation(async (_a, path) =>
      path === "src/large.ts"
        ? "const large = true;"
        : "function find(key) {\n return cache.get('constant');\n}",
    );
    return { ...f, snapshot };
  }
  it("re-reads the diff of every changed file its evidence cites", async () => {
    const f = await batchedPublication();
    expect(
      await f.t.action(internal.pullRequests.internalAction.publish, {
        actionId: f.actionId,
        manual: true,
      }),
    ).toEqual({ success: true });
    const options = f.snapshot.mock.calls[0][3] as {
      findingPaths: Set<string>;
    };
    expect([...options.findingPaths].sort()).toEqual([
      "src/large.ts",
      "src/main.ts",
    ]);
    const request = JSON.parse(f.fetch.mock.calls[0][1]!.body as string);
    expect(request.comments).toHaveLength(1);
  });
  it("re-reads each quoted file the way its review group saw it", async () => {
    const github = await import("../../../convex/pullRequests/github");
    for (const windowed of [false, true, undefined]) {
      const f = await batchedPublication();
      await f.t.run(async (ctx) => {
        const action = (await ctx.db.get(f.actionId))!;
        const proposal = action.proposedChanges;
        await ctx.db.patch(f.actionId, {
          proposedChanges: {
            ...proposal,
            findings: proposal.findings.map(
              (finding: { evidence: object[] }) => ({
                ...finding,
                evidence: finding.evidence.map((e) => ({ ...e, windowed })),
              }),
            ),
          },
        });
      });
      const read = vi.mocked(github.readReviewFile);
      read.mockClear();
      await f.t.action(internal.pullRequests.internalAction.publish, {
        actionId: f.actionId,
        manual: true,
      });
      const changed = read.mock.calls.find(
        ([, path]) => path === "src/main.ts",
      )?.[3];
      // A group that read the file whole quotes the whole file; evidence
      // saved before the flag existed keeps the earlier rule.
      if (windowed === false) expect(changed).toBeUndefined();
      else expect(changed).toMatchObject({ filename: "src/main.ts" });
      vi.restoreAllMocks();
    }
  });
  it("checks findings that saw one file differently against their own reads", async () => {
    const f = await batchedPublication();
    const github = await import("../../../convex/pullRequests/github");
    await f.t.run(async (ctx) => {
      const action = (await ctx.db.get(f.actionId))!;
      const [first] = action.proposedChanges.findings;
      const tag = (windowed: boolean) =>
        first.evidence
          .filter((e: { path: string }) => e.path === "src/main.ts")
          .map((e: object) => ({ ...e, windowed }));
      await ctx.db.patch(f.actionId, {
        proposedChanges: {
          ...action.proposedChanges,
          findingCount: 2,
          findings: [
            { ...first, evidence: tag(true) },
            {
              ...first,
              title: "Keep the requested key in the second group",
              suggestion: undefined,
              evidence: tag(false),
            },
          ],
        },
      });
    });
    const read = vi.mocked(github.readReviewFile);
    read.mockClear();
    expect(
      await f.t.action(internal.pullRequests.internalAction.publish, {
        actionId: f.actionId,
        manual: true,
      }),
    ).toEqual({ success: true });
    const views = read.mock.calls
      .filter(([, path]) => path === "src/main.ts")
      .map((call) => call[3] !== undefined);
    expect(views.sort()).toEqual([false, true]);
  });
  it("falls back to one body when GitHub rejects an inline comment", async () => {
    const f = await batchedPublication();
    f.fetch.mockResolvedValueOnce(new Response("{}", { status: 422 }));
    expect(
      await f.t.action(internal.pullRequests.internalAction.publish, {
        actionId: f.actionId,
        manual: true,
      }),
    ).toEqual({ success: true });
    expect(f.fetch).toHaveBeenCalledTimes(2);
    const retry = JSON.parse(f.fetch.mock.calls[1][1]!.body as string);
    expect(retry).not.toHaveProperty("comments");
    expect(retry.body).toContain("`src/main.ts:2`");
    expect(retry.body).toContain(`<!-- gitdog-pr-review:${f.actionId} -->`);
    // Findings in one body have no threads to resolve.
    expect(
      (await f.t.run((ctx) => ctx.db.get(f.actionId)))?.executionResult,
    ).toMatchObject({ inlineFindings: false });
  });
});
it("still posts on the reviewed commit after a newer push", async () => {
  const f = await publicationFixture();
  const helpers = await import("../../../convex/github/helpers");
  vi.mocked(helpers.fetchGitHubAppJsonWithRetry).mockImplementation(
    async (url) =>
      (url.includes("/compare/") ? { status: "ahead" } : []) as never,
  );
  f.live.mockResolvedValue({
    id: 1,
    number: 12,
    state: "open",
    draft: false,
    title: source.title,
    body: source.body,
    user: { login: "author" },
    head: { sha: "d".repeat(40) },
    base: { sha: source.baseSha, repo: { id: 123 } },
    changed_files: 1,
  });
  expect(
    (
      await f.t.action(internal.pullRequests.internalAction.publish, {
        actionId: f.actionId,
        manual: true,
      })
    ).success,
  ).toBe(true);
  const request = JSON.parse(f.fetch.mock.calls[0][1]!.body as string);
  expect(request.commit_id).toBe(source.headSha);
});
it("does not retry an ambiguous GitHub POST", async () => {
  const f = await publicationFixture();
  f.fetch.mockRejectedValue(new TypeError("network interruption"));
  expect(
    (
      await f.t.action(internal.pullRequests.internalAction.publish, {
        actionId: f.actionId,
        manual: true,
      })
    ).success,
  ).toBe(false);
  expect(
    (
      await f.t.action(internal.pullRequests.internalAction.publish, {
        actionId: f.actionId,
        manual: true,
      })
    ).success,
  ).toBe(false);
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(
    (await f.t.run((ctx) => ctx.db.get(f.actionId)))?.errorMessage,
  ).toContain("requires inspection");
});

it("reviews an unposted superseded proposal again when its PR is reopened", async () => {
  const f = await fixture();
  const first = await f.observe();
  await f.observe(source, false);
  const second = await f.observe();
  expect(second).toBeTruthy();
  expect(second).not.toBe(first);
});

describe("explicit verification of failed reviews", () => {
  async function failedFixture() {
    const f = await fixture();
    const failedId = (await f.observe())!;
    await f.t.mutation(internal.pullRequests.internalMutation.finish, {
      actionId: failedId,
      stage: "generation",
      error: "Original generation failed",
    });
    await f.observe(source, false);
    const expectedObservedAt = await f.t.run(async (ctx) => {
      const action = await ctx.db.get(failedId);
      return (await ctx.db.get(action!.ticketId))!.pullRequestObservedAt;
    });
    const queue = () =>
      f.t.mutation(internal.pullRequests.internalMutation.queueVerification, {
        actionId: failedId,
        requestedByUserId: f.userId,
        source,
        observedAt: Date.now(),
        expectedObservedAt,
        author: "author",
        open: false,
      });
    return { ...f, failedId, queue, expectedObservedAt };
  }
  it("does not enqueue a bot recheck through the internal mutation", async () => {
    const f = await failedFixture();
    await expect(
      f.t.mutation(internal.pullRequests.internalMutation.queueVerification, {
        actionId: f.failedId,
        requestedByUserId: f.userId,
        source,
        observedAt: Date.now(),
        expectedObservedAt: f.expectedObservedAt,
        author: "dependabot[bot]",
        open: false,
      }),
    ).rejects.toThrow("current access or settings");
    expect(
      await f.t.run((ctx) => ctx.db.query("ticketActions").take(2)),
    ).toHaveLength(1);
  });
  it("deduplicates an overlapping recheck after the first request updates observation time", async () => {
    const f = await failedFixture();
    const args = {
      actionId: f.failedId,
      requestedByUserId: f.userId,
      source,
      observedAt: (f.expectedObservedAt ?? 0) + 1,
      expectedObservedAt: f.expectedObservedAt,
      author: "author",
      open: false,
    };
    const first = await f.t.mutation(
      internal.pullRequests.internalMutation.queueVerification,
      args,
    );
    expect(
      await f.t.mutation(
        internal.pullRequests.internalMutation.queueVerification,
        args,
      ),
    ).toBe(first);
  });
  it("refreshes a stale source atomically from the authoritative recheck", async () => {
    const f = await failedFixture();
    const latest = {
      ...source,
      headSha: "c".repeat(40),
      title: "Latest title",
    };
    const actionId = await f.t.mutation(
      internal.pullRequests.internalMutation.queueVerification,
      {
        actionId: f.failedId,
        requestedByUserId: f.userId,
        source: latest,
        observedAt: Date.now(),
        expectedObservedAt: f.expectedObservedAt,
        author: "author",
        open: false,
      },
    );
    const row = await f.t.run((ctx) => ctx.db.get(actionId));
    expect(row?.proposedChanges?.source).toEqual(latest);
    expect(await f.t.run((ctx) => ctx.db.get(row!.ticketId))).toMatchObject({
      pullRequestHeadSha: latest.headSha,
      githubTitle: latest.title,
      status: "closed",
    });
  });
  it("does not let verification-only history block a normal review after reopening", async () => {
    const f = await failedFixture();
    await f.t.run((ctx) =>
      ctx.db.patch(f.failedId, {
        errorMessage:
          "Pull request changed or closed; this review is superseded",
      }),
    );
    const verificationId = await f.queue();
    await f.t.mutation(internal.pullRequests.internalMutation.propose, {
      actionId: verificationId,
      source,
      findings: [],
      excludedPaths: [],
      filesRead: ["head:src/main.ts"],
    });
    const reopened = await f.observe(source, true);
    expect(reopened).toBeTruthy();
    expect(reopened).not.toBe(verificationId);
    expect(await f.t.run((ctx) => ctx.db.get(reopened!))).not.toHaveProperty(
      "reviewVerificationOnly",
    );
  });
  it("creates one new verification and preserves closed ticket and failed history", async () => {
    const f = await failedFixture();
    const before = await f.t.run((ctx) => ctx.db.get(f.failedId));
    const actionId = await f.queue();
    expect(actionId).not.toBe(f.failedId);
    expect(await f.queue()).toBe(actionId);
    expect(await f.t.run((ctx) => ctx.db.get(f.failedId))).toEqual(before);
    const row = await f.t.run((ctx) => ctx.db.get(actionId));
    expect(row).toMatchObject({
      status: "pending",
      reviewVerificationOnly: true,
      reviewRecheckOfActionId: f.failedId,
      requestedByUserId: f.userId,
    });
    expect(await f.t.run((ctx) => ctx.db.get(row!.ticketId))).toMatchObject({
      status: "closed",
    });
    await f.observe(source, false);
    expect(await f.t.run((ctx) => ctx.db.get(actionId))).toMatchObject({
      status: "pending",
    });
  });
  it("completes findings without ever publishing, even with automatic approval configured", async () => {
    const f = await failedFixture();
    await f.t.run((ctx) =>
      ctx.db.patch(f.repositoryId, {
        settings: { ...settings, requireApprovalForPullRequests: false },
      }),
    );
    const actionId = await f.queue();
    await f.t.mutation(internal.pullRequests.internalMutation.propose, {
      actionId,
      source,
      findings,
      excludedPaths: [],
      filesRead: ["head:src/main.ts"],
    });
    expect(await f.t.run((ctx) => ctx.db.get(actionId))).toMatchObject({
      status: "completed",
      executionResult: { published: false, reason: "verification_only" },
    });
    for (const manual of [true, false]) {
      await f.t.run((ctx) =>
        ctx.db.patch(actionId, {
          status: manual ? "pending_approval" : "approved",
        }),
      );
      expect(
        await f.t.mutation(internal.pullRequests.internalMutation.claim, {
          actionId,
          manual,
        }),
      ).toBe(false);
      expect(
        await f.t.action(internal.pullRequests.internalAction.publish, {
          actionId,
          manual,
        }),
      ).toMatchObject({ success: false });
    }
  });
  it("rejects another owner, revoked installation, opt-out and stale observations", async () => {
    const f = await failedFixture();
    const stranger = await f.t.run((ctx) => ctx.db.insert("users", {}));
    await expect(
      f.t.mutation(internal.pullRequests.internalMutation.queueVerification, {
        actionId: f.failedId,
        requestedByUserId: stranger,
        source,
        observedAt: Date.now(),
        expectedObservedAt: f.expectedObservedAt,
        author: "author",
        open: false,
      }),
    ).rejects.toThrow();
    await expect(
      f.t.mutation(internal.pullRequests.internalMutation.queueVerification, {
        actionId: f.failedId,
        requestedByUserId: f.userId,
        source,
        observedAt: Date.now(),
        expectedObservedAt: (f.expectedObservedAt ?? 0) - 1,
        author: "author",
        open: false,
      }),
    ).rejects.toThrow("newer");
    await f.t.run((ctx) =>
      ctx.db.patch(f.repositoryId, {
        settings: { ...settings, pullRequestReviewsEnabled: false },
      }),
    );
    await expect(f.queue()).rejects.toThrow("settings");
    await f.t.run((ctx) =>
      ctx.db.patch(f.repositoryId, { settings, githubAccessRevokedAt: 1 }),
    );
    await expect(f.queue()).rejects.toThrow("access");
  });
  it("rejects unauthenticated and foreign public requests before any GitHub access", async () => {
    const f = await failedFixture();
    const access = vi.spyOn(
      repositoryIdentity,
      "resolveVerifiedRepositoryAccess",
    );
    await expect(
      f.t.action(api.pullRequests.action.recheck, { actionId: f.failedId }),
    ).rejects.toThrow("authenticated");
    const stranger = await f.t.run((ctx) => ctx.db.insert("users", {}));
    await expect(
      f.t
        .withIdentity({ subject: stranger })
        .action(api.pullRequests.action.recheck, { actionId: f.failedId }),
    ).rejects.toThrow("authorized");
    expect(access).not.toHaveBeenCalled();
  });
  it("generates a real evidence-backed result on a closed PR without publication", async () => {
    const f = await failedFixture();
    const github = await import("../../../convex/pullRequests/github");
    const billing = await import("../../../convex/_ai/chatBilling");
    const repository = (await f.t.run((ctx) => ctx.db.get(f.repositoryId)))!;
    vi.spyOn(
      repositoryIdentity,
      "resolveVerifiedRepositoryAccess",
    ).mockResolvedValue({
      repository,
      installation: {} as never,
      githubRepositoryId: 123,
      githubRepo: "owner/repo",
      owner: "owner",
      repo: "repo",
      token: "fixture-token",
    });
    vi.spyOn(github, "getPullRequest").mockResolvedValue({
      id: 1,
      number: 12,
      state: "closed",
      draft: false,
      title: source.title,
      body: source.body,
      user: { login: "author" },
      head: { sha: source.headSha },
      base: { sha: source.baseSha, repo: { id: 123 } },
      changed_files: 1,
    });
    const snapshot = vi.spyOn(github, "snapshot").mockResolvedValue({
      headSha: source.headSha,
      baseSha: source.baseSha,
      changedFiles: 1,
      files: [
        {
          filename: "src/main.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: "@@ -1 +1 @@\n-old\n+new",
        },
      ],
    });
    vi.spyOn(github, "treePaths").mockResolvedValue([]);
    vi.spyOn(github, "readReviewFile").mockResolvedValue(
      "new implementation source",
    );
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: "",
        finishReason: "tool_use",
        toolUse: [
          {
            id: "read",
            name: "read_file",
            input: { path: "src/main.ts", ref: "head" },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: '{"findings":[]}',
        finishReason: "stop",
      });
    vi.spyOn(billing, "createMeteredProvider").mockReturnValue({
      name: "fixture",
      providerId: "openai",
      modelId: "fixture",
      chat,
    });
    const actionId = await f.queue();
    await f.t.action(internal.pullRequests.internalAction.generate, {
      actionId,
    });
    expect(snapshot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ state: "closed" }),
      true,
    );
    expect(chat).toHaveBeenCalledTimes(2);
    expect(await f.t.run((ctx) => ctx.db.get(actionId))).toMatchObject({
      status: "completed",
      proposedChanges: { findings: [], filesRead: ["head:src/main.ts"] },
      executionResult: { published: false, reason: "verification_only" },
    });
  });
});

describe("batched PR reviews", () => {
  async function batchFixture(
    failedPage?: number | number[],
    largeFiles = 0,
    purchasedTokens = 10_000_000,
    largeIndexes: number[] = [],
    fileCount = 61,
    pageFailure: () => Error = () => new Error("Fixture model failure"),
  ) {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      const now = new Date(Date.now());
      await ctx.db.insert("subscriptions", {
        userId: f.userId,
        plan: "free",
        status: "active",
        includedTokens: getFreeIncludedTokens(Date.now()),
        purchasedTokens,
        serviceFeeRate: PRICING.PLATFORM_FEE_FREE,
        periodStart: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
        periodEnd: Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
        createdAt: now.getTime(),
        updatedAt: now.getTime(),
      });
    });
    const github = await import("../../../convex/pullRequests/github");
    const billing = await import("../../../convex/_ai/chatBilling");
    await f.t.run((ctx) =>
      ctx.db.patch(f.repositoryId, {
        settings: { ...settings, requireApprovalForPullRequests: false },
      }),
    );
    const repository = (await f.t.run((ctx) => ctx.db.get(f.repositoryId)))!;
    vi.spyOn(
      repositoryIdentity,
      "resolveVerifiedRepositoryAccess",
    ).mockResolvedValue({
      repository,
      installation: {} as never,
      owner: "owner",
      repo: "repo",
      githubRepo: "owner/repo",
      githubRepositoryId: 123,
      token: "fixture-token",
    });
    const files = Array.from({ length: fileCount }, (_, index) => ({
      filename: `src/file-${index + 1}.ts`,
      status: index >= 16 && index < 32 ? "removed" : "modified",
      additions: 1,
      deletions: 1,
      patch:
        "@@ -2 +2 @@\n- return cache.get(key);\n+ return cache.get('constant');" +
        (index < largeFiles || largeIndexes.includes(index)
          ? `\n ${"x".repeat(60_000)}`
          : ""),
    }));
    const live = {
      id: 1,
      number: 12,
      state: "open",
      draft: false,
      title: source.title,
      body: source.body,
      user: { login: "author" },
      head: { sha: source.headSha },
      base: { sha: source.baseSha, repo: { id: 123 } },
      changed_files: files.length,
    };
    vi.spyOn(helpers, "fetchGitHubAppJsonWithRetry").mockImplementation(
      async (url) => {
        const { pathname } = new URL(url);
        if (pathname.includes(`/compare/${source.baseSha}...`))
          return {
            merge_base_commit: { sha: source.baseSha },
            files,
          } as never;
        if (pathname.includes(`/compare/${source.headSha}...`))
          return {
            status: "ahead",
            files: [{ filename: "src/file-1.ts" }, { filename: "README.md" }],
          } as never;
        if (pathname.includes("/compare/"))
          return { merge_base_commit: { sha: source.baseSha } } as never;
        if (pathname.endsWith("/pulls/12/reviews")) return [] as never;
        if (pathname.endsWith("/pulls/12")) return live as never;
        throw new Error(`Unexpected fixture request: ${pathname}`);
      },
    );
    vi.spyOn(github, "treePaths").mockResolvedValue(
      files.map((f) => f.filename),
    );
    vi.spyOn(github, "readReviewFile").mockResolvedValue(
      "function find(key) {\n return cache.get('constant');\n}",
    );
    const batches: string[] = [];
    vi.spyOn(billing, "createMeteredProvider").mockImplementation(
      (_ctx, args) => {
        batches.push(args.generationKey);
        const batch = args.generationKey.includes("/batch/");
        const page = batch ? Number(args.generationKey.split("/").at(-2)) : 0;
        const group = Number(args.generationKey.split("/").at(-1));
        const path = batch
          ? files[(page - 1) * 16 + group - 1].filename
          : "src/file-1.ts";
        const candidate = {
          ...findings[0],
          path,
          evidence: [{ ...findings[0].evidence[0], path }],
          suggestion: {
            startLine: 2,
            original: " return cache.get('constant');",
            replacement: " return cache.get(key);",
          },
        };
        return {
          name: "fixture",
          providerId: "openai",
          modelId: "fixture",
          chat: async (_messages, options) => {
            if (
              page === failedPage ||
              failedPage === -1 ||
              (Array.isArray(failedPage) && failedPage.includes(page))
            )
              throw pageFailure();
            return {
              content: JSON.stringify(
                options?.billingLabel === "pr-review/critique"
                  ? { retainedFindingIds: ["F1"] }
                  : { findings: page === 3 ? [] : [candidate] },
              ),
              finishReason: "stop",
            };
          },
        };
      },
    );
    const actionId = (await f.observe())!;
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        id: 87,
        commit_id: source.headSha,
        body: `<!-- gitdog-pr-review:${actionId} -->`,
      }),
    );
    return {
      ...f,
      actionId,
      fetch,
      batches,
      live,
      files,
      generate: (page?: number, group?: number) =>
        f.t.action(internal.pullRequests.internalAction.generate, {
          actionId,
          page,
          group,
        }),
      publish: () =>
        f.t.action(internal.pullRequests.internalAction.publish, {
          actionId,
          manual: false,
        }),
      getAction: () => f.t.run((ctx) => ctx.db.get(actionId)),
    };
  }

  it("combines findings from a 61-file PR into one review body after all batches finish", async () => {
    const f = await batchFixture();
    await f.generate();
    await f.generate();
    await f.generate(2);
    await f.generate(2);
    await f.generate(3);
    expect(await f.getAction()).toMatchObject({
      status: "pending",
      reviewBatch: { page: 4 },
    });
    expect(f.fetch).not.toHaveBeenCalled();
    await f.t.mutation(internal.pullRequests.internalMutation.expire, {
      actionId: f.actionId,
      page: 3,
    });
    await drainScheduledFunctions(f.t);
    expect(await f.getAction()).toMatchObject({
      status: "completed",
      executionResult: { published: true, reviewId: 87 },
      proposedChanges: {
        batchCount: 4,
        findings: [{ path: "src/file-1.ts" }, { path: "src/file-49.ts" }].map(
          (finding) => expect.objectContaining(finding),
        ),
        excludedPaths: expect.arrayContaining([
          "src/file-17.ts",
          "src/file-32.ts",
        ]),
      },
    });
    expect(f.batches.map((key) => key.split("/batch/")[1])).toEqual([
      "1/1",
      "3/1",
      "4/1",
    ]);
    expect(await f.getAction()).not.toHaveProperty("reviewQuotaHold");
    expect(await f.publish()).toMatchObject({ success: false });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    const request = JSON.parse(f.fetch.mock.calls[0][1]!.body as string);
    expect(request).toMatchObject({
      event: "COMMENT",
      commit_id: source.headSha,
    });
    // Batched findings are posted inline under a short summary.
    expect(
      request.comments.map((c: { path: string; line: number }) => [
        c.path,
        c.line,
      ]),
    ).toEqual([
      ["src/file-1.ts", 2],
      ["src/file-49.ts", 2],
    ]);
    expect(JSON.stringify(request.comments)).toContain(
      "return cache.get(key);",
    );
    expect(request.body).toContain("**2 potential issues**");
    expect(request.body).not.toContain("were not fully reviewed");
    expect(request.body).toContain(`<!-- gitdog-pr-review:${f.actionId} -->`);
    // Approvers still preview every finding.
    expect((await f.getAction())?.proposedChanges?.suggestedResponse).toContain(
      "src/file-49.ts:2",
    );
    expect(
      await f.observe({ ...source, body: "Edit only the description" }),
    ).toBeNull();
  });

  it("reviews a 3-file PR over the diff budget in batches and publishes one review", async () => {
    const f = await batchFixture(undefined, 2, 10_000_000, [], 3);
    await f.generate();
    expect(await f.getAction()).toMatchObject({
      status: "pending",
      reviewBatch: { page: 1, group: 1, claimed: false },
      reviewQuotaHold: 200_000,
    });
    await f.generate(1, 1);
    await drainScheduledFunctions(f.t);
    expect(f.batches.map((key) => key.split("/batch/")[1])).toEqual([
      "1/1",
      "1/2",
      "1/3",
    ]);
    const action = await f.getAction();
    expect(action).toMatchObject({
      status: "completed",
      executionResult: { published: true, reviewId: 87 },
      proposedChanges: { batchCount: 3, changedFiles: 3 },
    });
    expect(action).not.toHaveProperty("reviewQuotaHold");
    expect(f.fetch).toHaveBeenCalledTimes(1);
    const request = JSON.parse(f.fetch.mock.calls[0][1]!.body as string);
    expect(request.comments.map((c: { path: string }) => c.path)).toEqual([
      "src/file-1.ts",
      "src/file-2.ts",
      "src/file-3.ts",
    ]);
  });

  it("publishes a single-batch review when one oversized diff is left out", async () => {
    const f = await batchFixture(undefined, 0, 10_000_000, [], 3);
    f.files[2].patch += `\n ${"x".repeat(110_000)}`;
    await f.generate();
    await drainScheduledFunctions(f.t);
    expect(f.batches.map((key) => key.split("/batch/")[1])).toEqual(["1/1"]);
    expect(await f.getAction()).toMatchObject({
      status: "completed",
      executionResult: { published: true, reviewId: 87 },
      proposedChanges: {
        batchCount: 1,
        excludedPaths: expect.arrayContaining(["src/file-3.ts"]),
      },
    });
    const request = JSON.parse(f.fetch.mock.calls[0][1]!.body as string);
    expect(request.comments.map((c: { path: string }) => c.path)).toEqual([
      "src/file-1.ts",
    ]);
    expect(request.body).toContain(
      "1 of 3 changed files was not fully reviewed.",
    );
  });

  it("reviews each diff group of a large page in its own action", async () => {
    const f = await batchFixture(undefined, 2);
    await f.generate();
    expect(await f.getAction()).toMatchObject({
      status: "pending",
      reviewBatch: { page: 1, group: 1, claimed: false },
      // Two groups left on this page plus three pages for the other 45 files.
      reviewQuotaHold: 500_000,
    });
    expect(f.batches.map((key) => key.split("/batch/")[1])).toEqual(["1/1"]);
    await f.generate(1, 1);
    await f.generate(1, 1);
    expect(f.batches.map((key) => key.split("/batch/")[1])).toEqual([
      "1/1",
      "1/2",
    ]);
    expect(await f.getAction()).toMatchObject({
      status: "pending",
      reviewBatch: { page: 1, group: 2 },
    });
    await f.t.mutation(internal.pullRequests.internalMutation.expire, {
      actionId: f.actionId,
      page: 1,
      group: 1,
    });
    expect((await f.getAction())?.status).toBe("pending");
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("runs every batch on the owner's own key without a quota hold", async () => {
    const previousKey = process.env.BYOK_ENCRYPTION_KEY;
    process.env.BYOK_ENCRYPTION_KEY = btoa("k".repeat(32));
    try {
      const f = await batchFixture(undefined, 2, 0, [], 3);
      const apiKey = `sk-proj-${"b".repeat(40)}`;
      await f.t.mutation(internal.providerApiKeys.internalMutation.upsert, {
        userId: f.userId,
        provider: "openai",
        ...(await encryptProviderKey(f.userId, "openai", apiKey)),
        last4: apiKey.slice(-4),
      });
      await f.generate();
      expect(await f.getAction()).toMatchObject({
        status: "pending",
        reviewBatch: { page: 1, group: 1, claimed: false },
      });
      expect(await f.getAction()).not.toHaveProperty("reviewQuotaHold");
      await f.generate(1, 1);
      await drainScheduledFunctions(f.t);
      expect(f.batches.map((key) => key.split("/batch/")[1])).toEqual([
        "1/1",
        "1/2",
        "1/3",
      ]);
      const billing = await import("../../../convex/_ai/chatBilling");
      expect(
        vi
          .mocked(billing.createMeteredProvider)
          .mock.calls.every(([, args]) => args.provider.keySource === "user"),
      ).toBe(true);
      const action = await f.getAction();
      expect(action).toMatchObject({
        status: "completed",
        executionResult: { published: true, reviewId: 87 },
      });
      expect(action).not.toHaveProperty("reviewQuotaUserId");
    } finally {
      if (previousKey === undefined) delete process.env.BYOK_ENCRYPTION_KEY;
      else process.env.BYOK_ENCRYPTION_KEY = previousKey;
    }
  });

  it("refuses a batched review the remaining tokens cannot cover before any model call", async () => {
    const f = await batchFixture(undefined, 0, 0);
    await f.generate();
    const action = await f.getAction();
    expect(action).toMatchObject({
      status: "failed",
      errorMessage:
        "Not enough tokens remain for this pull request review. No review was published.",
    });
    expect(action?.reviewFailureDetails).toContain("Stage · Token quota check");
    expect(action?.reviewFailureDetails).toContain(
      "at least 4 more review batches, estimated at 400,000 tokens; 100,000 tokens remain.",
    );
    expect(f.batches).toEqual([]);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("reports an interrupted quota check without blaming review evidence", async () => {
    const f = await batchFixture();
    vi.spyOn(
      subscriptionQueries,
      "checkAccountTokenAllowance",
    ).mockRejectedValue(new Error("Transient database failure"));
    await f.generate();
    const action = await f.getAction();
    expect(action).toMatchObject({
      status: "failed",
      errorMessage:
        "The token balance could not be verified for this pull request review. No review was published.",
      reviewFailureDetails:
        "Stage · Token quota check (review batch 1)\nReason · The token quota check did not complete, so the review did not start.",
    });
    expect(action).not.toHaveProperty("reviewQuotaHold");
    expect(f.batches).toEqual([]);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("keeps the repository document out of the quota reservation", () => {
    const source = readFileSync(
      join(process.cwd(), "convex/pullRequests/internalMutation.ts"),
      "utf8",
    );
    const reservation = source.slice(
      source.indexOf("async function checkBatchQuota"),
      source.indexOf("export const propose"),
    );
    // Indexing patches the repository faster than the usage read finishes,
    // so reading it here fails the reservation on every retry.
    expect(reservation).toContain("ticket.userId");
    expect(reservation).not.toMatch(
      /\.get\([^)]*repositoryId|"repositories"|\brepo\b/,
    );
  });

  it("holds the expected tokens and shrinks the hold as batches finish", async () => {
    const f = await batchFixture();
    await f.generate();
    expect(await f.getAction()).toMatchObject({
      reviewQuotaUserId: f.userId,
      reviewQuotaHold: 300_000,
      reviewBatch: { page: 2 },
    });
    await f.generate(2);
    expect((await f.getAction())?.reviewQuotaHold).toBe(200_000);
  });

  it.each([
    ["pending", true],
    ["failed", false],
  ] as const)(
    "accounts for a %s batched review that holds tokens",
    async (status, refused) => {
      const f = await batchFixture(undefined, 0, 400_000);
      const ticketId = (await f.getAction())!.ticketId;
      const holderId = await f.t.run((ctx) =>
        ctx.db.insert("ticketActions", {
          ticketId,
          actionType: "review",
          status,
          proposalVersion: 1,
          // Another pull request's review holding tokens for the same account.
          proposedChanges: { source: { ...source, headSha: "d".repeat(40) } },
          chatHistory: [],
          createdAt: 1,
          reviewQuotaUserId: f.userId,
          reviewQuotaHold: 400_000,
        }),
      );
      await f.generate();
      const action = await f.getAction();
      if (refused) {
        expect(action?.status).toBe("failed");
        expect(action?.reviewFailureDetails).toContain(
          "100,000 tokens remain after 400,000 held by other reviews in progress.",
        );
        expect(f.batches).toEqual([]);
      } else {
        expect(action).toMatchObject({
          status: "pending",
          reviewBatch: { page: 2 },
        });
        // A hold left behind by an ended action is released, not counted.
        expect(await f.t.run((ctx) => ctx.db.get(holderId))).not.toHaveProperty(
          "reviewQuotaHold",
        );
      }
    },
  );

  it("reserves for the first page's real groups before any model call", async () => {
    const f = await batchFixture(undefined, 2, 300_000);
    await f.generate();
    const action = await f.getAction();
    expect(action?.status).toBe("failed");
    expect(action?.reviewFailureDetails).toContain(
      "at least 6 more review batches, estimated at 600,000 tokens; 400,000 tokens remain.",
    );
    expect(f.batches).toEqual([]);
  });

  it("stops before spending more when a later page needs more than the hold", async () => {
    const f = await batchFixture(undefined, 0, 300_000, [32, 33, 34]);
    await f.generate();
    const ticketId = (await f.getAction())!.ticketId;
    await f.t.run((ctx) =>
      ctx.db.insert("ticketActions", {
        ticketId,
        actionType: "review",
        status: "pending",
        proposalVersion: 1,
        proposedChanges: { source: { ...source, headSha: "d".repeat(40) } },
        chatHistory: [],
        createdAt: 1,
        reviewQuotaUserId: f.userId,
        reviewQuotaHold: 200_000,
      }),
    );
    await f.generate(2);
    await f.generate(3);
    const action = await f.getAction();
    expect(action).toMatchObject({
      status: "failed",
      errorMessage:
        "Not enough tokens remain for this pull request review. No review was published.",
    });
    expect(action?.reviewFailureDetails).toContain(
      "Stage · Token quota check (review batch 3)",
    );
    expect(action).not.toHaveProperty("reviewQuotaHold");
    expect(f.batches.map((key) => key.split("/batch/")[1])).toEqual([
      "1/1",
      "3/1",
    ]);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("finishes a batched review when only the description changes between batches", async () => {
    const f = await batchFixture();
    await f.generate();
    f.live.body = "Edited between batches";
    await f.observe({ ...source, body: "Edited between batches" });
    expect(await f.getAction()).toMatchObject({
      status: "pending",
      reviewBatch: { page: 2 },
    });
    await f.generate(2);
    expect(await f.getAction()).toMatchObject({ reviewBatch: { page: 3 } });
  });

  it("fails without posting when a page splits differently between its groups", async () => {
    const f = await batchFixture(undefined, 2);
    await f.generate();
    expect(await f.getAction()).toMatchObject({
      reviewBatch: { page: 1, group: 1 },
    });
    f.files[2].patch = f.files[0].patch;
    await f.generate(1, 1);
    const action = await f.getAction();
    expect(action?.status).toBe("failed");
    expect(action?.reviewBatch).toBeUndefined();
    expect(f.batches.map((key) => key.split("/batch/")[1])).toEqual(["1/1"]);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("fails when no changed file was inspected even though guides were read", async () => {
    const f = await batchFixture();
    const github = await import("../../../convex/pullRequests/github");
    const { ReviewContextLimitError } =
      await import("../../../convex/pullRequests/errors");
    vi.spyOn(github, "treePaths").mockResolvedValue([
      ...f.files.map((file) => file.filename),
      "README.md",
    ]);
    vi.spyOn(github, "readReviewFile").mockImplementation(
      async (_access, path) => {
        if (path === "README.md") return "Repository guidance.";
        throw new ReviewContextLimitError();
      },
    );
    for (const page of [undefined, 2, 3, 4]) await f.generate(page);
    const action = await f.getAction();
    expect(action?.status).toBe("failed");
    expect(action?.reviewBatch).toBeUndefined();
    expect(action?.reviewFailureDetails).toContain("review batch 4");
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("drops a push that lands while a review runs and finishes on its commit", async () => {
    const f = await batchFixture();
    await f.generate();
    expect(await f.getAction()).toMatchObject({ reviewBatch: { page: 2 } });
    const next = { ...source, headSha: "c".repeat(40) };
    f.live.head = { sha: next.headSha };
    // The push is dropped: no new review, and the running one is kept.
    expect(await f.observe(next)).toBeNull();
    expect(
      await f.t.run((ctx) => ctx.db.query("ticketActions").collect()),
    ).toHaveLength(1);
    for (const page of [2, 3, 4]) await f.generate(page);
    await drainScheduledFunctions(f.t);
    expect(await f.getAction()).toMatchObject({
      status: "completed",
      executionResult: { published: true },
    });
    const request = JSON.parse(f.fetch.mock.calls[0][1]!.body as string);
    expect(request.commit_id).toBe(source.headSha);
    // Once it ended, the PR was observed again and the dropped head is
    // reviewed from the commit just reviewed.
    const actions = await f.t.run((ctx) =>
      ctx.db.query("ticketActions").collect(),
    );
    expect(actions).toHaveLength(2);
    expect(actions[1]).toMatchObject({
      proposedChanges: { source: { headSha: next.headSha } },
      reviewSince: { headSha: source.headSha },
    });
  });

  it("reviews only the files a later push changed", async () => {
    const f = await batchFixture(undefined, 0, 10_000_000, [], 61);
    await f.generate();
    await f.generate(2);
    await f.generate(3);
    await f.generate(4);
    await drainScheduledFunctions(f.t);
    expect((await f.getAction())?.executionResult).toMatchObject({
      published: true,
    });
    const next = { ...source, headSha: "e".repeat(40) };
    f.live.head = { sha: next.headSha };
    const nextId = (await f.observe(next))!;
    expect(await f.t.run((ctx) => ctx.db.get(nextId))).toMatchObject({
      reviewSince: { headSha: source.headSha, mergeBaseSha: source.baseSha },
    });
    expect(
      (await f.t.run((ctx) => ctx.db.get(nextId)))?.reviewSince,
    ).not.toHaveProperty("uncoveredPaths");
    f.batches.length = 0;
    f.fetch.mockResolvedValue(
      Response.json({
        id: 88,
        commit_id: next.headSha,
        body: `<!-- gitdog-pr-review:${nextId} -->`,
      }),
    );
    await f.t.action(internal.pullRequests.internalAction.generate, {
      actionId: nextId,
    });
    await drainScheduledFunctions(f.t);
    // One single review of the changed PR file, not 61 files in batches.
    expect(f.batches).toEqual([`pr/${nextId}/${next.headSha}`]);
    const action = await f.t.run((ctx) => ctx.db.get(nextId));
    expect(action).toMatchObject({
      status: "completed",
      executionResult: { published: true, reviewId: 88 },
      proposedChanges: {
        changedFiles: 1,
        reviewedSince: source.headSha,
        findings: [expect.objectContaining({ path: "src/file-1.ts" })],
      },
    });
    const request = JSON.parse(f.fetch.mock.calls.at(-1)![1]!.body as string);
    expect(request.body).toContain(
      `Reviewed the 1 file changed since ${source.headSha}.`,
    );
    expect(request.comments).toHaveLength(1);
  });

  it("does not resend files a legacy follow-up record carried", async () => {
    const f = await batchFixture(undefined, 0, 10_000_000, [], 61);
    for (const page of [undefined, 2, 3, 4]) await f.generate(page);
    await drainScheduledFunctions(f.t);
    const next = { ...source, headSha: "e".repeat(40) };
    f.live.head = { sha: next.headSha };
    const nextId = (await f.observe(next))!;
    await f.t.run((ctx) =>
      ctx.db.patch(nextId, {
        reviewSince: {
          headSha: source.headSha,
          mergeBaseSha: source.baseSha,
          uncoveredPaths: ["src/file-40.ts", "src/file-41.ts"],
        },
      }),
    );
    f.batches.length = 0;
    await f.t.action(internal.pullRequests.internalAction.generate, {
      actionId: nextId,
    });
    expect(f.batches).toEqual([`pr/${nextId}/${next.headSha}`]);
    // The carried files are not sent with the one file the push changed.
    expect(
      (await f.t.run((ctx) => ctx.db.get(nextId)))?.proposedChanges,
    ).toMatchObject({ changedFiles: 1, reviewedSince: source.headSha });
  });

  async function followUp(
    changed: Set<string> | null,
    previous: Set<string> | null = null,
  ) {
    const f = await batchFixture(undefined, 0, 10_000_000, [], 61);
    for (const page of [undefined, 2, 3, 4]) await f.generate(page);
    await drainScheduledFunctions(f.t);
    const github = await import("../../../convex/pullRequests/github");
    vi.spyOn(github, "changedSince").mockResolvedValue(
      changed && { paths: changed, mergeBaseSha: source.baseSha, previous },
    );
    const next = { ...source, headSha: "e".repeat(40) };
    f.live.head = { sha: next.headSha };
    const nextId = (await f.observe(next))!;
    f.batches.length = 0;
    f.fetch.mockClear();
    await f.t.action(internal.pullRequests.internalAction.generate, {
      actionId: nextId,
    });
    return { ...f, nextId, next };
  }
  it("reviews the whole PR again after a force push", async () => {
    const f = await followUp(null);
    expect(f.batches).toEqual([`pr/${f.nextId}/${f.next.headSha}/batch/1/1`]);
  });
  it("does not approve again after a push deleted a file the PR added", async () => {
    // src/added.ts was in the reviewed diff and is gone from the PR now.
    const f = await followUp(
      new Set(["src/added.ts"]),
      new Set(["src/added.ts", "src/file-1.ts"]),
    );
    await drainScheduledFunctions(f.t);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(await f.t.run((ctx) => ctx.db.get(f.nextId))).toMatchObject({
      status: "completed",
      executionResult: { published: false, reason: "no_new_changes" },
      proposedChanges: { coverageComplete: false },
    });
  });
  it("completes without posting when a push changed nothing in the PR diff", async () => {
    const f = await followUp(new Set(["README.md"]));
    await drainScheduledFunctions(f.t);
    expect(f.batches).toEqual([]);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(await f.t.run((ctx) => ctx.db.get(f.nextId))).toMatchObject({
      status: "completed",
      executionResult: { published: false, reason: "no_new_changes" },
    });
  });

  it("records on each quoted head file whether its group saw it windowed", async () => {
    const f = await batchFixture(undefined, 0, 10_000_000, [], 61);
    const github = await import("../../../convex/pullRequests/github");
    vi.mocked(github.readReviewFile).mockImplementation(
      async (_access, path, _ref, _changed, onWindowed) => {
        if (path === "src/file-1.ts") onWindowed?.();
        return "function find(key) {\n return cache.get('constant');\n}";
      },
    );
    for (const page of [undefined, 2, 3, 4]) await f.generate(page);
    const evidence = Object.fromEntries(
      ((await f.getAction())?.proposedChanges?.findings ?? []).map(
        (finding: {
          path: string;
          evidence: Array<{ windowed?: boolean }>;
        }) => [finding.path, finding.evidence[0].windowed],
      ),
    );
    expect(evidence).toEqual({
      "src/file-1.ts": true,
      "src/file-49.ts": false,
    });
  });
  it("keeps the paid batches when the model output of one batch cannot be used", async () => {
    const { ChatProviderRequestError } =
      await import("../../../convex/_ai/providerErrors");
    const f = await batchFixture(
      3,
      0,
      10_000_000,
      [],
      61,
      () => new ChatProviderRequestError("Unreadable output", "billed"),
    );
    await f.generate();
    await f.generate(2);
    await f.generate(3);
    await f.generate(4);
    await drainScheduledFunctions(f.t);
    const action = await f.getAction();
    expect(action).toMatchObject({
      status: "completed",
      executionResult: { published: true },
      proposedChanges: { batchCount: 4 },
    });
    expect(action?.proposedChanges?.excludedPaths).toEqual(
      expect.arrayContaining(["src/file-33.ts", "src/file-48.ts"]),
    );
    const request = JSON.parse(f.fetch.mock.calls[0][1]!.body as string);
    expect(request.body).toContain("were not fully reviewed");
  });
  it("finishes a review when the safety filter declines several batches", async () => {
    const { ChatProviderRequestError } =
      await import("../../../convex/_ai/providerErrors");
    const f = await batchFixture(
      [3, 4, 5],
      0,
      10_000_000,
      [],
      80,
      () =>
        new ChatProviderRequestError("Claude declined the request", "billed", {
          refusal: "cyber",
        }),
    );
    for (const page of [undefined, 2, 3, 4, 5]) await f.generate(page);
    await drainScheduledFunctions(f.t);
    const action = await f.getAction();
    // Declines are about content, so three of them do not stop the review.
    expect(action).toMatchObject({
      status: "completed",
      executionResult: { published: true },
    });
    const request = JSON.parse(f.fetch.mock.calls[0][1]!.body as string);
    expect(request.body).toContain("were not fully reviewed");
  });
  it("stops after too many batches are declined", async () => {
    const { ChatProviderRequestError } =
      await import("../../../convex/_ai/providerErrors");
    const f = await batchFixture(
      [3, 4, 5, 6, 7, 8],
      0,
      10_000_000,
      [],
      144,
      () =>
        new ChatProviderRequestError("Claude declined the request", "billed", {
          refusal: "general_harms",
        }),
    );
    for (const page of [undefined, 2, 3, 4, 5, 6, 7]) await f.generate(page);
    expect((await f.getAction())?.reviewBatch?.result).toMatchObject({
      refusedGroups: 5,
    });
    await f.generate(8);
    expect((await f.getAction())?.status).toBe("failed");
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("reports a declined single review and does not carry its files forward", async () => {
    const { ChatProviderRequestError } =
      await import("../../../convex/_ai/providerErrors");
    const f = await batchFixture(
      0,
      0,
      10_000_000,
      [],
      3,
      () =>
        new ChatProviderRequestError(
          "Claude declined the request",
          "not_billed",
          {
            refusal: "cyber",
          },
        ),
    );
    await f.generate();
    await drainScheduledFunctions(f.t);
    const action = await f.getAction();
    expect(action).toMatchObject({
      status: "completed",
      executionResult: { published: true },
      proposedChanges: {
        refusedPaths: ["src/file-1.ts", "src/file-2.ts", "src/file-3.ts"],
      },
    });
    const request = JSON.parse(f.fetch.mock.calls[0][1]!.body as string);
    expect(request.body).toContain("could not review the 3 changed files");
    const next = { ...source, headSha: "e".repeat(40) };
    f.live.head = { sha: next.headSha };
    const nextId = (await f.observe(next))!;
    expect((await f.t.run((ctx) => ctx.db.get(nextId)))?.reviewSince).toEqual({
      headSha: source.headSha,
      mergeBaseSha: source.baseSha,
    });
  });
  it("stops paying for batches once model output keeps failing", async () => {
    const { ChatProviderRequestError } =
      await import("../../../convex/_ai/providerErrors");
    const f = await batchFixture(
      -1,
      0,
      10_000_000,
      [],
      61,
      () => new ChatProviderRequestError("Unreadable output", "billed"),
    );
    await f.generate();
    await f.generate(2);
    await f.generate(3);
    expect((await f.getAction())?.reviewBatch?.result).toMatchObject({
      failedGroups: 2,
    });
    await f.generate(4);
    expect((await f.getAction())?.status).toBe("failed");
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("builds on a review that could not list everything it missed", async () => {
    const f = await fixture();
    const first = (await f.observe())!;
    await f.t.run((ctx) =>
      ctx.db.patch(first, {
        status: "completed",
        executionResult: { published: true },
        proposedChanges: {
          source,
          mergeBaseSha: source.baseSha,
          findings: [],
          uncoveredFiles: 150,
          coverageLimited: true,
          excludedPaths: [],
        },
      }),
    );
    const next = (await f.observe({ ...source, headSha: "e".repeat(40) }))!;
    expect((await f.t.run((ctx) => ctx.db.get(next)))?.reviewSince).toEqual({
      headSha: source.headSha,
      mergeBaseSha: source.baseSha,
    });
  });
  it("still stops the whole review on an ambiguous provider outcome", async () => {
    const { ChatProviderRequestError } =
      await import("../../../convex/_ai/providerErrors");
    const f = await batchFixture(
      3,
      0,
      10_000_000,
      [],
      61,
      () => new ChatProviderRequestError("Lost response", "ambiguous"),
    );
    await f.generate();
    await f.generate(2);
    await f.generate(3);
    expect((await f.getAction())?.status).toBe("failed");
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("clears partial results and skips publication when a later batch fails", async () => {
    const f = await batchFixture(3);
    await f.generate();
    await f.generate(2);
    await f.generate(3);
    await f.generate(4);
    const action = await f.getAction();
    expect(action?.status).toBe("failed");
    expect(action?.reviewBatch).toBeUndefined();
    expect(action?.proposedChanges?.findings).toBeUndefined();
    expect(action?.reviewFailureDetails).toContain("review batch 3");
    expect(action).not.toHaveProperty("reviewQuotaHold");
    expect(await f.publish()).toMatchObject({ success: false });
    expect(f.fetch).not.toHaveBeenCalled();
  });
});
