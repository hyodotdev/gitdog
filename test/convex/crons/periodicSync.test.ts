import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import schema from "../../../convex/schema";
import * as githubHelpers from "../../../convex/github/helpers";
import {
  CURRENT_PRIVACY_POLICY_VERSION,
  CURRENT_TERMS_VERSION,
} from "../../../convex/users/legal";
const modules = import.meta.glob("../../../convex/**/*.ts");
const originalFetch = globalThis.fetch;
const INDEXED_SHA = "a".repeat(40);
const PUSHED_SHA = "b".repeat(40);
let headShas: Map<string, string>;
let defaultBranches: Map<string, string>;
let githubRequests: string[];
beforeEach(() => {
  vi.useFakeTimers();
  headShas = new Map();
  defaultBranches = new Map();
  githubRequests = [];
  vi.spyOn(githubHelpers, "getRepositoryInstallationToken").mockResolvedValue(
    "installation-token",
  );
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    githubRequests.push(url);
    const metadata = /^https:\/\/api\.github\.com\/repositories\/(\d+)$/.exec(
      url,
    );
    if (metadata) {
      const id = Number(metadata[1]);
      const name = id === 101 ? "owner/repo" : `owner/repo-${id - 101}`;
      return new Response(
        JSON.stringify({
          id,
          full_name: name,
          default_branch: defaultBranches.get(name) ?? "main",
        }),
        { status: 200 },
      );
    }
    const match =
      /^https:\/\/api\.github\.com\/repos\/(.+)\/commits\/(.+)$/.exec(url);
    const sha = match
      ? (headShas.get(`${match[1]}@${decodeURIComponent(match[2])}`) ??
        (match[2] === "main" ? headShas.get(match[1]) : undefined))
      : undefined;
    return sha
      ? new Response(JSON.stringify({ sha }), { status: 200 })
      : new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function insertFixture(t: ReturnType<typeof convexTest>): Promise<{
  userId: Id<"users">;
  repositoryId: Id<"repositories">;
  ticketActionId: Id<"ticketActions">;
  requirePendingTicketAction: true;
}> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", {});
    const repositoryId = await ctx.db.insert("repositories", {
      indexSyncPending: false,
      indexVersion: 1,
      indexStatus: "completed",
      indexProgressAt: Date.now(),
      ragStatus: "completed",
      ragTotalChunks: 0,
      ragIndexedChunks: 0,
      ragFailedChunks: 0,
      userId,
      installationId: 101,
      githubRepositoryId: 101,
      githubRepo: "owner/repo",
      githubRepoKey: "owner/repo",
      name: "repo",
      githubUrl: "https://github.com/owner/repo",
      defaultBranch: "main",
      isActive: true,
      settings: {
        issueAssistantEnabled: true,
        autoFormatIssue: true,
        autoAnswerQuestions: true,
        tagMaintainersForCodeChanges: true,
        discussionAssistantEnabled: true,
        autoFormatDiscussion: true,
        autoAnswerDiscussionQuestions: true,
        tagMaintainersForDiscussionCodeChanges: true,
        requireApproval: false,
        requireApprovalForDiscussions: false,
      },
      monthlyActions: 0,
      lastResetAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const ticketId = await ctx.db.insert("tickets", {
      repositoryId,
      userId,
      githubRepo: "owner/repo",
      ticketType: "issue",
      githubNumber: 42,
      githubTitle: "Issue",
      aiInputVersion: 1,
      status: "open",
      createdAt: now,
    });
    const ticketActionId = await ctx.db.insert("ticketActions", {
      ticketId,
      actionType: "answer",
      chatHistory: [],
      proposalVersion: 0,
      status: "pending",
      createdAt: now,
    });
    return {
      userId,
      repositoryId,
      ticketActionId,
      requirePendingTicketAction: true,
    };
  });
}

async function enableRepositoryAccess(
  t: ReturnType<typeof convexTest>,
  f: Awaited<ReturnType<typeof insertFixture>>,
) {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("userProfiles", {
      userId: f.userId,
      githubUsername: "owner",
      minimumAgeAttestedAt: now,
      professionalUseAttestedAt: now,
      termsAcceptedVersion: CURRENT_TERMS_VERSION,
      privacyPolicyAcceptedVersion: CURRENT_PRIVACY_POLICY_VERSION,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("githubInstallations", {
      userId: f.userId,
      installationId: 101,
      ownerGithubAccountId: "5001",
      ownershipVerifiedAt: now,
      accountLogin: "owner",
      accountType: "Organization",
      targetType: "Organization",
      createdAt: now,
      updatedAt: now,
    });
  });
}

describe("bounded periodic repository sync", () => {
  it("traverses later repositories and coalesces a busy page without invalidating work", async () => {
    const t = convexTest(schema, modules);
    const f = await insertFixture(t);
    await enableRepositoryAccess(t, f);
    const ids = await t.run(async (ctx) => {
      const first = await ctx.db.get(f.repositoryId);
      const result = [f.repositoryId];
      for (let i = 1; i < 12; i++) {
        const { _id, _creationTime, ...repo } = first!;
        void _id;
        void _creationTime;
        result.push(
          await ctx.db.insert("repositories", {
            ...repo,
            githubRepositoryId: 101 + i,
            githubRepo: `owner/repo-${i}`,
            githubRepoKey: `owner/repo-${i}`,
            name: `repo-${i}`,
          }),
        );
      }
      return result;
    });
    headShas.set("owner/repo", PUSHED_SHA);
    for (let i = 1; i < 12; i++) headShas.set(`owner/repo-${i}`, PUSHED_SHA);
    const first = await t.query(
      internal.repoIndexing.internalQuery.getPeriodicSyncPage,
      {},
    );
    expect(first.scanned).toBe(10);
    expect(first.isDone).toBe(false);
    expect(
      await t.action(
        internal.repoIndexing.internalAction.dailySyncAllRepositories,
        {},
      ),
    ).toEqual({ total: 10, scheduled: 10, skipped: 0, hasMore: true });
    const versions = await t.run((ctx) =>
      Promise.all(ids.map((id) => ctx.db.get(id))),
    );
    expect(
      await t.action(
        internal.repoIndexing.internalAction.dailySyncAllRepositories,
        {},
      ),
    ).toMatchObject({ scheduled: 0, skipped: 10 });
    const busy = await t.run((ctx) =>
      Promise.all(ids.map((id) => ctx.db.get(id))),
    );
    expect(busy.map((x) => x?.indexVersion)).toEqual(
      versions.map((x) => x?.indexVersion),
    );
    expect(
      await t.action(
        internal.repoIndexing.internalAction.dailySyncAllRepositories,
        { cursor: first.continueCursor },
      ),
    ).toEqual({ total: 2, scheduled: 2, skipped: 0, hasMore: false });
    const final = await t.run((ctx) =>
      Promise.all(ids.map((id) => ctx.db.get(id))),
    );
    expect(final.every((x) => x?.indexVersion === 2)).toBe(true);
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system
        .query("_scheduled_functions")
        .take(100)) {
        if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
      }
    });
  });
});

describe("daily sync head comparison", () => {
  async function insertIndexedRepository(
    t: ReturnType<typeof convexTest>,
    commitSha: string,
  ) {
    const f = await insertFixture(t);
    await enableRepositoryAccess(t, f);
    await t.run(async (ctx) => {
      await ctx.db.patch(f.repositoryId, {
        indexSource: { indexVersion: 1, commitSha, defaultBranch: "main" },
      });
    });
    return f.repositoryId;
  }

  it("does no database work when the default branch head is already indexed", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertIndexedRepository(t, INDEXED_SHA);
    headShas.set("owner/repo", INDEXED_SHA);
    const before = await t.run((ctx) => ctx.db.get(repositoryId));

    expect(
      await t.action(
        internal.repoIndexing.internalAction.dailySyncAllRepositories,
        {},
      ),
    ).toEqual({ total: 1, scheduled: 0, skipped: 1, hasMore: false });

    const after = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
      logs: await ctx.db.query("repoIndexingLogs").collect(),
    }));
    expect(after.repository).toEqual(before);
    expect(after.scheduled).toHaveLength(0);
    expect(after.logs).toHaveLength(0);
    expect(githubRequests).toEqual([
      "https://api.github.com/repositories/101",
      "https://api.github.com/repos/owner/repo/commits/main",
    ]);
  });

  it("starts a generation pinned to the new head when the branch moved", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertIndexedRepository(t, INDEXED_SHA);
    headShas.set("owner/repo", PUSHED_SHA);

    expect(
      await t.action(
        internal.repoIndexing.internalAction.dailySyncAllRepositories,
        {},
      ),
    ).toEqual({ total: 1, scheduled: 1, skipped: 0, hasMore: false });
    const repository = await t.run((ctx) => ctx.db.get(repositoryId));
    expect(repository).toMatchObject({
      indexVersion: 2,
      indexStatus: "pending",
    });
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system
        .query("_scheduled_functions")
        .take(100)) {
        if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
      }
    });
  });

  it("leaves the index alone when GitHub cannot report the head", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertIndexedRepository(t, INDEXED_SHA);
    const before = await t.run((ctx) => ctx.db.get(repositoryId));

    expect(
      await t.action(
        internal.repoIndexing.internalAction.dailySyncAllRepositories,
        {},
      ),
    ).toEqual({ total: 1, scheduled: 0, skipped: 1, hasMore: false });
    expect(await t.run((ctx) => ctx.db.get(repositoryId))).toEqual(before);
  });

  it("compares the head of a renamed default branch, not the stored one", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertIndexedRepository(t, INDEXED_SHA);
    // The old branch still exists at the indexed commit.
    headShas.set("owner/repo@main", INDEXED_SHA);
    defaultBranches.set("owner/repo", "trunk");
    headShas.set("owner/repo@trunk", PUSHED_SHA);

    expect(
      await t.action(
        internal.repoIndexing.internalAction.dailySyncAllRepositories,
        {},
      ),
    ).toMatchObject({ scheduled: 1, skipped: 0 });
    expect(await t.run((ctx) => ctx.db.get(repositoryId))).toMatchObject({
      indexVersion: 2,
    });
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system
        .query("_scheduled_functions")
        .take(100)) {
        if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
      }
    });
  });

  it("skips without database work when the installation token cannot be minted", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertIndexedRepository(t, INDEXED_SHA);
    const before = await t.run((ctx) => ctx.db.get(repositoryId));
    vi.spyOn(githubHelpers, "getRepositoryInstallationToken").mockRejectedValue(
      new Error(
        "GitHub repository-scoped installation token request failed (HTTP 404)",
      ),
    );
    expect(
      await t.action(
        internal.repoIndexing.internalAction.dailySyncAllRepositories,
        {},
      ),
    ).toMatchObject({ scheduled: 0, skipped: 1 });
    expect(await t.run((ctx) => ctx.db.get(repositoryId))).toEqual(before);
  });
});
