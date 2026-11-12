import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import schema from "../../../convex/schema";
import {
  CURRENT_PRIVACY_POLICY_VERSION,
  CURRENT_TERMS_VERSION,
} from "../../../convex/users/legal";
const modules = import.meta.glob("../../../convex/**/*.ts");
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
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
