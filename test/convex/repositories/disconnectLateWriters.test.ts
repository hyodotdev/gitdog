import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import schema from "../../../convex/schema";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/admin/internalMutation.ts": () =>
    import("../../../convex/admin/internalMutation"),
  "../../../convex/tokenUsage/internalMutation.ts": () =>
    import("../../../convex/tokenUsage/internalMutation"),
};

async function insertFixture(t: ReturnType<typeof convexTest>): Promise<{
  userId: Id<"users">;
  repositoryId: Id<"repositories">;
  ticketId: Id<"tickets">;
  actionId: Id<"ticketActions">;
}> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const now = Date.now();
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
      installationId: 123,
      githubRepositoryId: 456,
      githubRepo: "owner/repo",
      githubRepoKey: "owner/repo",
      name: "repo",
      githubUrl: "https://github.com/owner/repo",
      isActive: false,
      disconnectCleanupPending: true,
      settings: {
        issueAssistantEnabled: true,
        autoFormatIssue: true,
        autoAnswerQuestions: true,
        tagMaintainersForCodeChanges: true,
        requireApproval: false,
        discussionAssistantEnabled: true,
        autoFormatDiscussion: true,
        autoAnswerDiscussionQuestions: true,
        tagMaintainersForDiscussionCodeChanges: true,
        requireApprovalForDiscussions: false,
      },
      monthlyActions: 0,
      lastResetAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const ticketId = await ctx.db.insert("tickets", {
      aiInputVersion: 1,
      repositoryId,
      userId,
      githubRepo: "owner/repo",
      ticketType: "issue",
      githubNumber: 42,
      githubTitle: "Issue",
      status: "open",
      createdAt: now,
    });
    const actionId = await ctx.db.insert("ticketActions", {
      ticketId,
      actionType: "answer",
      chatHistory: [],
      proposalVersion: 0,
      status: "pending",
      createdAt: now,
    });
    return { userId, repositoryId, ticketId, actionId };
  });
}

async function recordLateHistory(
  t: ReturnType<typeof convexTest>,
  fixture: Awaited<ReturnType<typeof insertFixture>>,
): Promise<void> {
  await t.mutation(internal.tokenUsage.internalMutation.recordUsage, {
    userId: fixture.userId,
    ticketActionId: fixture.actionId,
    repositoryId: fixture.repositoryId,
    inputTokens: 10,
    outputTokens: 5,
    model: "claude-sonnet-5-5",
    provider: "anthropic",
  });
  await t.mutation(internal.admin.internalMutation.createAiLog, {
    userId: fixture.userId,
    ticketId: fixture.ticketId,
    ticketActionId: fixture.actionId,
    repositoryId: fixture.repositoryId,
    workflowType: "issue_analysis",
    status: "success",
  });
}

describe("disconnect late history writers", () => {
  it("preserves billing and history while omitting a disconnect-pending repository", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);

    await recordLateHistory(t, fixture);
    const state = await t.run(async (ctx) => ({
      usage: await ctx.db.query("tokenUsage").collect(),
      logs: await ctx.db.query("aiLogs").collect(),
    }));

    expect(state.usage).toHaveLength(1);
    expect(state.usage[0]).toMatchObject({
      userId: fixture.userId,
      ticketActionId: fixture.actionId,
      totalTokens: 15,
    });
    expect(state.usage[0]?.repositoryId).toBeUndefined();
    expect(state.logs).toHaveLength(1);
    expect(state.logs[0]).toMatchObject({
      ticketId: fixture.ticketId,
      ticketActionId: fixture.actionId,
      status: "success",
    });
    expect(state.logs[0]?.repositoryId).toBeUndefined();
  });

  it("does not recreate a dangling repository reference after final deletion", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.ticketId, { repositoryId: undefined });
      await ctx.db.delete(fixture.repositoryId);
    });

    await recordLateHistory(t, fixture);
    const state = await t.run(async (ctx) => ({
      usage: await ctx.db.query("tokenUsage").first(),
      log: await ctx.db.query("aiLogs").first(),
    }));

    expect(state.usage?.repositoryId).toBeUndefined();
    expect(state.usage?.ticketActionId).toBe(fixture.actionId);
    expect(state.usage?.totalTokens).toBe(15);
    expect(state.log?.repositoryId).toBeUndefined();
    expect(state.log?.ticketId).toBe(fixture.ticketId);
    expect(state.log?.ticketActionId).toBe(fixture.actionId);
  });

  it("omits missing or mismatched ticket and action references from AI history", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    await t.run(async (ctx) => {
      await ctx.db.delete(fixture.actionId);
      await ctx.db.delete(fixture.ticketId);
    });

    const logId = await t.mutation(
      internal.admin.internalMutation.createAiLog,
      {
        userId: fixture.userId,
        ticketId: fixture.ticketId,
        ticketActionId: fixture.actionId,
        repositoryId: fixture.repositoryId,
        workflowType: "issue_analysis",
        status: "failed",
      },
    );
    const log = await t.run(async (ctx) => ctx.db.get(logId));

    expect(log?.ticketId).toBeUndefined();
    expect(log?.ticketActionId).toBeUndefined();
    expect(log?.repositoryId).toBeUndefined();
  });
});
