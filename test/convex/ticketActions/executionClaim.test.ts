import { convexTest } from "convex-test";
import { v } from "convex/values";
import { describe, expect, it, vi } from "vitest";

import { internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { internalAction } from "../../../convex/_generated/server";
import * as github from "../../../convex/github/helpers";
import * as repositoryIdentity from "../../../convex/github/repositoryIdentity";
import schema from "../../../convex/schema";
import { evaluateExecutionClaim } from "../../../convex/ticketActions/internalMutation";

const noopRegenerateWithFeedback = internalAction({
  args: {
    actionId: v.id("ticketActions"),
    expectedIndexVersion: v.optional(v.number()),
    readinessRetryAttempt: v.optional(v.number()),
  },
  handler: async () => undefined,
});

const noopProcessFollowUp = internalAction({
  args: {
    actionId: v.id("ticketActions"),
    expectedIndexVersion: v.optional(v.number()),
    readinessRetryAttempt: v.optional(v.number()),
    forceApproval: v.optional(v.boolean()),
  },
  handler: async () => undefined,
});

const noopReconcileClaimedExecution = internalAction({
  args: {
    actionId: v.id("ticketActions"),
    expectedClaimedAt: v.number(),
    expectedProposalVersion: v.number(),
    retryAttempt: v.optional(v.number()),
  },
  handler: async () => undefined,
});

const noopProcessNewTicket = internalAction({
  args: {
    ticketId: v.id("tickets"),
    repositoryId: v.id("repositories"),
    issueTitle: v.string(),
    issueBody: v.string(),
    expectedAiInputVersion: v.number(),
    expectedIndexVersion: v.optional(v.number()),
    processingStage: v.optional(
      v.union(v.literal("start"), v.literal("answer")),
    ),
    readinessRetryAttempt: v.optional(v.number()),
    readinessStartedAt: v.optional(v.number()),
    readinessProgressAt: v.optional(v.number()),
    readinessProgressKey: v.optional(v.string()),
    providerRetryAttempt: v.optional(v.number()),
    providerRetryStartedAt: v.optional(v.number()),
    replayReservationKey: v.optional(v.string()),
    formatActionId: v.optional(v.id("ticketActions")),
    answerActionId: v.optional(v.id("ticketActions")),
    initialProcessingGeneration: v.optional(v.number()),
  },
  handler: async () => undefined,
});

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/ticketActions/internalMutation.ts": () =>
    import("../../../convex/ticketActions/internalMutation"),
  "../../../convex/ticketActions/internalQuery.ts": () =>
    import("../../../convex/ticketActions/internalQuery"),
  "../../../convex/tickets/internalQuery.ts": () =>
    import("../../../convex/tickets/internalQuery"),
  "../../../convex/ticketActions/internalAction.ts": async () => ({
    regenerateWithFeedback: noopRegenerateWithFeedback,
    processFollowUp: noopProcessFollowUp,
    reconcileClaimedExecution: noopReconcileClaimedExecution,
  }),
  "../../../convex/tickets/internalAction.ts": async () => ({
    processNewTicket: noopProcessNewTicket,
    executeAutoApprovedAction: (
      await import("../../../convex/tickets/internalAction")
    ).executeAutoApprovedAction,
  }),
};

type ExecutionFixture = {
  actionId: Id<"ticketActions">;
  repositoryId: Id<"repositories">;
  ticketId: Id<"tickets">;
};

async function cancelPendingSchedules(
  t: ReturnType<typeof convexTest>,
): Promise<void> {
  await t.run(async (ctx) => {
    const scheduled = await ctx.db.system
      .query("_scheduled_functions")
      .collect();
    for (const job of scheduled) {
      if (job.state.kind === "pending") {
        await ctx.scheduler.cancel(job._id);
      }
    }
  });
}

async function createExecutionFixture(
  ticketStatus: "open" | "closed",
  actionStatus:
    | "pending"
    | "pending_approval"
    | "approved"
    | "rejected"
    | "completed"
    | "failed",
): Promise<{
  t: ReturnType<typeof convexTest>;
  fixture: ExecutionFixture;
}> {
  const t = convexTest(schema, modules);
  const fixture = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const now = Date.now();
    await ctx.db.insert("githubInstallations", {
      userId,
      installationId: 123,
      ownerGithubAccountId: "verified-owner",
      ownershipVerifiedAt: now,
      accountLogin: "owner",
      accountType: "Organization",
      targetType: "Organization",
      createdAt: now,
      updatedAt: now,
    });
    const repositoryId = await ctx.db.insert("repositories", {
      indexSyncPending: false,
      indexProgressAt: Date.now(),
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
      isActive: true,
      indexVersion: 7,
      indexStatus: "completed",
      ragStatus: "completed",
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
      githubTitle: "Original title",
      githubBody: "Original body",
      status: ticketStatus,
      ...(ticketStatus === "closed" ? { closedAt: now } : {}),
      createdAt: now,
    });
    const actionId = await ctx.db.insert("ticketActions", {
      ticketId,
      actionType: "answer",
      chatHistory: [],
      proposedChanges: {
        originalTitle: "Original title",
        originalBody: "Original body",
        suggestedResponse: "Grounded response",
        groundedIndexVersion: 7,
      },
      proposalVersion: 0,
      status: actionStatus,
      createdAt: now,
    });

    return { actionId, repositoryId, ticketId };
  });

  return { t, fixture };
}

describe("ticket action execution claims", () => {
  it("allows one manual approval claim for an open ticket", () => {
    expect(
      evaluateExecutionClaim(
        { status: "pending_approval" },
        "open",
        "manual_approval",
      ),
    ).toEqual({ eligible: true });
  });

  it("rejects a second claim", () => {
    expect(
      evaluateExecutionClaim(
        { status: "approved", executionClaimedAt: 123 },
        "open",
        "auto_approved",
      ),
    ).toEqual({
      eligible: false,
      reason: "Action execution was already claimed",
    });
  });

  it("does not publish to a closed ticket", () => {
    expect(
      evaluateExecutionClaim(
        { status: "pending_approval" },
        "closed",
        "manual_approval",
      ),
    ).toEqual({ eligible: false, reason: "Ticket is no longer open" });
  });

  it("requires the status associated with the claim mode", () => {
    expect(
      evaluateExecutionClaim(
        { status: "pending_approval" },
        "open",
        "auto_approved",
      ),
    ).toEqual({ eligible: false, reason: "Action is not approved" });
  });

  it("atomically transitions one manual approval and rejects the duplicate", async () => {
    const { t, fixture } = await createExecutionFixture(
      "open",
      "pending_approval",
    );
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.actionId, {
        resultCheckpointKey: "stale-checkpoint",
        resultCheckpointExpiresAt: Date.now() + 60_000,
        resultRecoveryLeaseUntil: Date.now() + 60_000,
      });
    });

    const firstClaim = await t.mutation(
      internal.ticketActions.internalMutation.claimForExecution,
      {
        actionId: fixture.actionId,
        mode: "manual_approval",
        expectedProposalVersion: 0,
      },
    );
    const afterFirstClaim = await t.run(async (ctx) => ({
      action: await ctx.db.get(fixture.actionId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    const secondClaim = await t.mutation(
      internal.ticketActions.internalMutation.claimForExecution,
      {
        actionId: fixture.actionId,
        mode: "auto_approved",
        expectedProposalVersion: 0,
      },
    );
    const afterSecondClaim = await t.run(
      async (ctx) => await ctx.db.get(fixture.actionId),
    );

    expect(firstClaim).toMatchObject({
      claimed: true,
      claimedAt: expect.any(Number),
      idempotencyKey: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      ),
    });
    expect(afterFirstClaim.action).toMatchObject({
      status: "approved",
      executionClaimedAt: expect.any(Number),
      approvedAt: expect.any(Number),
      executionRecoveryMode: "manual_approval",
      executionRecoveryExpiresAt: expect.any(Number),
      executionRecoveryLeaseUntil: expect.any(Number),
      executionRecoveryScheduleId: expect.any(String),
    });
    expect(afterFirstClaim.scheduled).toHaveLength(1);
    expect(afterFirstClaim.scheduled[0]).toMatchObject({
      name: "ticketActions/internalAction:reconcileClaimedExecution",
      args: [
        {
          actionId: fixture.actionId,
          expectedClaimedAt: firstClaim.claimed
            ? firstClaim.claimedAt
            : undefined,
          expectedProposalVersion: 0,
          retryAttempt: 0,
        },
      ],
    });
    expect(secondClaim).toEqual({
      claimed: false,
      reason: "Action execution was already claimed",
    });
    expect(afterSecondClaim).toEqual(afterFirstClaim.action);
    await cancelPendingSchedules(t);
  });

  it("atomically completes only the owning claim and clears its watchdog", async () => {
    const { t, fixture } = await createExecutionFixture("open", "approved");
    const claim = await t.mutation(
      internal.ticketActions.internalMutation.claimForExecution,
      {
        actionId: fixture.actionId,
        mode: "auto_approved",
        expectedProposalVersion: 0,
      },
    );
    if (!claim.claimed) throw new Error(claim.reason);

    expect(
      await t.mutation(
        internal.ticketActions.internalMutation.completeClaimedExecution,
        {
          actionId: fixture.actionId,
          expectedClaimedAt: claim.claimedAt - 1,
          expectedProposalVersion: 0,
          result: { success: true, commentId: 9 },
        },
      ),
    ).toBe(false);
    expect(
      await t.mutation(
        internal.ticketActions.internalMutation.completeClaimedExecution,
        {
          actionId: fixture.actionId,
          expectedClaimedAt: claim.claimedAt,
          expectedProposalVersion: 0,
          result: { success: true, commentId: 9 },
        },
      ),
    ).toBe(true);

    const action = await t.run(
      async (ctx) => await ctx.db.get(fixture.actionId),
    );
    expect(action).toMatchObject({
      status: "completed",
      executionResult: { success: true, commentId: 9 },
      executionClaimedAt: claim.claimedAt,
      executionIdempotencyKey: claim.idempotencyKey,
      executionRecoveryMode: "auto_approved",
      completedAt: expect.any(Number),
    });
    expect(action?.executionRecoveryScheduleId).toBeUndefined();
    expect(action?.executionRecoveryLeaseUntil).toBeUndefined();
  });

  it("restarts an expired ambiguous claim instead of terminally failing it", async () => {
    const { t, fixture } = await createExecutionFixture("open", "approved");
    const claim = await t.mutation(
      internal.ticketActions.internalMutation.claimForExecution,
      {
        actionId: fixture.actionId,
        mode: "auto_approved",
        expectedProposalVersion: 0,
      },
    );
    if (!claim.claimed) throw new Error(claim.reason);
    await cancelPendingSchedules(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.actionId, {
        executionRecoveryExpiresAt: Date.now() - 1,
        executionRecoveryLeaseUntil: Date.now() - 1,
      });
    });

    await expect(
      t.mutation(
        internal.ticketActions.internalMutation.recoverClaimedExecutions,
        {},
      ),
    ).resolves.toEqual({ restarted: 1, scheduled: 0 });
    const state = await t.run(async (ctx) => ({
      action: await ctx.db.get(fixture.actionId),
      scheduled: (
        await ctx.db.system.query("_scheduled_functions").collect()
      ).filter((job) => job.state.kind === "pending"),
    }));
    expect(state.action).toMatchObject({
      status: "approved",
      executionClaimedAt: claim.claimedAt,
      executionIdempotencyKey: claim.idempotencyKey,
      executionRecoveryExpiresAt: expect.any(Number),
    });
    expect(state.scheduled).toHaveLength(1);
    expect(state.scheduled[0]?.name).toBe(
      "ticketActions/internalAction:reconcileClaimedExecution",
    );
    await cancelPendingSchedules(t);
  });

  it.each([
    { accessSuspendedAt: 10 },
    { repositoryRemovalPendingAt: 10 },
    { repositoryAccessReconciliationPhase: "fetching" as const },
  ])("rejects a claim while installation access is gated: %o", async (gate) => {
    const { t, fixture } = await createExecutionFixture(
      "open",
      "pending_approval",
    );
    await t.run(async (ctx) => {
      const installation = await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) => q.eq("installationId", 123))
        .first();
      if (!installation) throw new Error("installation missing");
      await ctx.db.patch(installation._id, gate);
    });

    const result = await t.mutation(
      internal.ticketActions.internalMutation.claimForExecution,
      {
        actionId: fixture.actionId,
        mode: "manual_approval",
        expectedProposalVersion: 0,
      },
    );

    expect(result).toEqual({
      claimed: false,
      reason: "Repository installation access is not active",
    });
  });

  it("does not let an executor claim a regenerated proposal revision", async () => {
    const { t, fixture } = await createExecutionFixture(
      "open",
      "pending_approval",
    );

    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.actionId, { status: "pending" });
    });
    await t.mutation(
      internal.ticketActions.internalMutation.updateProposedChanges,
      {
        actionId: fixture.actionId,
        proposedChanges: {
          originalTitle: "Original title",
          originalBody: "Original body",
          suggestedResponse: "Regenerated grounded response",
          groundedIndexVersion: 7,
        },
      },
    );

    const staleClaim = await t.mutation(
      internal.ticketActions.internalMutation.claimForExecution,
      {
        actionId: fixture.actionId,
        mode: "manual_approval",
        expectedProposalVersion: 0,
      },
    );
    const staleFailure = await t.mutation(
      internal.ticketActions.internalMutation.failExecutionAttempt,
      {
        actionId: fixture.actionId,
        mode: "manual_approval",
        expectedProposalVersion: 0,
        errorMessage: "Old preflight failed",
      },
    );
    const currentClaim = await t.mutation(
      internal.ticketActions.internalMutation.claimForExecution,
      {
        actionId: fixture.actionId,
        mode: "manual_approval",
        expectedProposalVersion: 1,
      },
    );

    expect(staleClaim).toEqual({
      claimed: false,
      reason: "Action proposal changed before execution",
    });
    expect(staleFailure).toBe(false);
    expect(currentClaim).toMatchObject({ claimed: true });
  });

  it("leaves an action unchanged when its ticket is already closed", async () => {
    const { t, fixture } = await createExecutionFixture(
      "closed",
      "pending_approval",
    );
    const beforeClaim = await t.run(
      async (ctx) => await ctx.db.get(fixture.actionId),
    );

    const result = await t.mutation(
      internal.ticketActions.internalMutation.claimForExecution,
      {
        actionId: fixture.actionId,
        mode: "manual_approval",
        expectedProposalVersion: 0,
      },
    );
    const afterClaim = await t.run(
      async (ctx) => await ctx.db.get(fixture.actionId),
    );

    expect(result).toEqual({
      claimed: false,
      reason: "Ticket is no longer open",
    });
    expect(afterClaim).toEqual(beforeClaim);
  });

  it("claims an auto-approved action without changing its approved status", async () => {
    const { t, fixture } = await createExecutionFixture("open", "approved");

    const result = await t.mutation(
      internal.ticketActions.internalMutation.claimForExecution,
      {
        actionId: fixture.actionId,
        mode: "auto_approved",
        expectedProposalVersion: 0,
      },
    );
    const action = await t.run(
      async (ctx) => await ctx.db.get(fixture.actionId),
    );

    expect(result).toMatchObject({
      claimed: true,
      claimedAt: expect.any(Number),
    });
    expect(action).toMatchObject({
      status: "approved",
      executionClaimedAt: expect.any(Number),
    });
  });

  it("does not claim an action that already has an execution result", async () => {
    const { t, fixture } = await createExecutionFixture("open", "approved");
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.actionId, {
        executionResult: { success: true, commentId: 123 },
      });
    });
    const beforeClaim = await t.run(
      async (ctx) => await ctx.db.get(fixture.actionId),
    );

    const result = await t.mutation(
      internal.ticketActions.internalMutation.claimForExecution,
      {
        actionId: fixture.actionId,
        mode: "auto_approved",
        expectedProposalVersion: 0,
      },
    );
    const afterClaim = await t.run(
      async (ctx) => await ctx.db.get(fixture.actionId),
    );

    expect(result).toEqual({
      claimed: false,
      reason: "Action was already executed",
    });
    expect(afterClaim).toEqual(beforeClaim);
  });

  it("refreshes a stale manual draft and requires approval again", async () => {
    vi.useFakeTimers();
    const { t, fixture } = await createExecutionFixture(
      "open",
      "pending_approval",
    );
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.repositoryId, { indexVersion: 8 });
    });
    const result = await t.mutation(
      internal.ticketActions.internalMutation.claimForExecution,
      {
        actionId: fixture.actionId,
        mode: "manual_approval",
        expectedProposalVersion: 0,
      },
    );
    expect(result).toMatchObject({
      claimed: false,
      refreshing: true,
    });
    const state = await t.run(async (ctx) => ({
      action: await ctx.db.get(fixture.actionId),
      jobs: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.action).toMatchObject({
      status: "pending",
      proposalVersion: 1,
      pendingGenerationTarget: {
        kind: "regenerate",
        expectedIndexVersion: 8,
      },
    });
    expect(state.action?.executionClaimedAt).toBeUndefined();
    expect(state.jobs).toContainEqual(
      expect.objectContaining({
        name: "ticketActions/internalAction:regenerateWithFeedback",
        args: [{ actionId: fixture.actionId, expectedIndexVersion: 8 }],
      }),
    );
    await cancelPendingSchedules(t);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("schedules one refresh and posts the regenerated response once under concurrent execution", async () => {
    vi.useFakeTimers();
    const { t, fixture } = await createExecutionFixture("open", "approved");
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.repositoryId, {
        indexVersion: 8,
        indexSyncPending: true,
      });
    });

    const claim = (expectedProposalVersion: number) =>
      t.mutation(internal.ticketActions.internalMutation.claimForExecution, {
        actionId: fixture.actionId,
        mode: "auto_approved",
        expectedProposalVersion,
      });
    const staleClaims = await Promise.all([claim(0), claim(0)]);
    expect(staleClaims.filter((result) => result.refreshing)).toHaveLength(1);
    expect(staleClaims.every((result) => !result.claimed)).toBe(true);

    const state = await t.run(async (ctx) => ({
      actions: await ctx.db.query("ticketActions").collect(),
      jobs: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.actions).toHaveLength(1);
    expect(state.actions[0]).toMatchObject({
      _id: fixture.actionId,
      status: "pending",
      proposalVersion: 1,
      pendingGenerationTarget: {
        kind: "initial_ticket",
        stage: "answer",
        expectedIndexVersion: 8,
      },
    });
    expect(
      state.jobs.filter(
        (job) => job.name === "tickets/internalAction:processNewTicket",
      ),
    ).toEqual([
      expect.objectContaining({
        args: [
          expect.objectContaining({
            answerActionId: fixture.actionId,
            expectedIndexVersion: 8,
          }),
        ],
      }),
    ]);

    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.repositoryId, { indexSyncPending: false });
    });
    const proposal = {
      originalTitle: "Original title",
      originalBody: "Original body",
      suggestedResponse: "README.md explains the updated setup.",
      groundedIndexVersion: 8,
      confidence: 0.95,
      toolsUsed: 1,
      filesRead: 1,
      filesReadPaths: ["README.md"],
      toolErrors: 0,
      validationPassed: true,
      isActionable: false,
      issueType: "question",
    };
    const finishGeneration = (expectedProposalVersion: number) =>
      t.mutation(internal.ticketActions.internalMutation.completeWithResults, {
        actionId: fixture.actionId,
        proposedChanges: proposal,
        requireApproval: false,
        expectedProposalVersion,
      });
    await expect(finishGeneration(0)).resolves.toBe(false);
    await expect(finishGeneration(1)).resolves.toBe(true);
    const access = await t.run(async (ctx) => {
      const repository = await ctx.db.get(fixture.repositoryId);
      const installation = await ctx.db.query("githubInstallations").first();
      if (!repository || !installation) throw new Error("Missing fixture");
      return {
        repository,
        installation,
        githubRepositoryId: repository.githubRepositoryId,
        githubRepo: repository.githubRepo,
        owner: "owner",
        repo: "repo",
        token: "test-token",
      };
    });
    vi.spyOn(
      repositoryIdentity,
      "resolveVerifiedRepositoryAccess",
    ).mockResolvedValue(access);
    vi.spyOn(github, "getIssue").mockResolvedValue({
      title: "Original title",
      body: "Original body",
      html_url: "https://github.com/owner/repo/issues/42",
      state: "open",
    });
    const postComment = vi
      .spyOn(github, "addIssueComment")
      .mockResolvedValue(123);
    const execute = () =>
      t.action(internal.tickets.internalAction.executeAutoApprovedAction, {
        actionId: fixture.actionId,
      });
    try {
      await Promise.all([execute(), execute()]);
      expect(postComment).toHaveBeenCalledExactlyOnceWith(
        "owner",
        "repo",
        42,
        expect.stringContaining(proposal.suggestedResponse),
        "test-token",
      );
      const completed = await t.run(
        async (ctx) => await ctx.db.get(fixture.actionId),
      );
      expect(completed).toMatchObject({
        status: "completed",
        executionResult: { commentId: 123, postedComment: true },
      });
    } finally {
      await cancelPendingSchedules(t);
      vi.restoreAllMocks();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("refreshes an owned response when the index changes after the claim and before the POST", async () => {
    vi.useFakeTimers();
    const { t, fixture } = await createExecutionFixture("open", "approved");
    const claim = await t.mutation(
      internal.ticketActions.internalMutation.claimForExecution,
      {
        actionId: fixture.actionId,
        mode: "auto_approved",
        expectedProposalVersion: 0,
      },
    );
    if (!claim.claimed) throw new Error(claim.reason);
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.repositoryId, { indexVersion: 8 });
    });
    const write = () =>
      t.mutation(
        internal.ticketActions.internalMutation.checkClaimedResponseBeforeWrite,
        {
          actionId: fixture.actionId,
          expectedClaimedAt: claim.claimedAt,
          expectedProposalVersion: 0,
        },
      );
    await expect(write()).resolves.toMatchObject({
      ready: false,
      refreshing: true,
    });
    await expect(write()).resolves.toMatchObject({ ready: false });
    const action = await t.run(
      async (ctx) => await ctx.db.get(fixture.actionId),
    );
    expect(action?.status).toBe("pending");
    expect(action?.executionClaimedAt).toBeUndefined();
    expect(action?.executionIdempotencyKey).toBeUndefined();
    await cancelPendingSchedules(t);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("returns an auto-approved action to manual review when settings change", async () => {
    const { t, fixture } = await createExecutionFixture("open", "approved");
    await t.run(async (ctx) => {
      const repository = await ctx.db.get(fixture.repositoryId);
      if (!repository) throw new Error("Repository not found");
      await ctx.db.patch(fixture.repositoryId, {
        settings: { ...repository.settings, requireApproval: true },
      });
    });

    const result = await t.mutation(
      internal.ticketActions.internalMutation.claimForExecution,
      {
        actionId: fixture.actionId,
        mode: "auto_approved",
        expectedProposalVersion: 0,
      },
    );
    const action = await t.run(
      async (ctx) => await ctx.db.get(fixture.actionId),
    );

    expect(result).toEqual({
      claimed: false,
      reason: "Repository now requires manual approval",
    });
    expect(action).toMatchObject({ status: "pending_approval" });
    expect(action?.executionClaimedAt).toBeUndefined();
  });

  it("does not execute formatting changes for a paused repository", async () => {
    const { t, fixture } = await createExecutionFixture(
      "open",
      "pending_approval",
    );
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.repositoryId, { isActive: false });
      await ctx.db.patch(fixture.actionId, {
        actionType: "format",
        proposedChanges: {
          originalTitle: "Original title",
          originalBody: "Original body",
          suggestedTitle: "Formatted title",
          suggestedBody: "Original body",
        },
      });
    });
    const beforeClaim = await t.run(
      async (ctx) => await ctx.db.get(fixture.actionId),
    );

    const result = await t.mutation(
      internal.ticketActions.internalMutation.claimForExecution,
      {
        actionId: fixture.actionId,
        mode: "manual_approval",
        expectedProposalVersion: 0,
      },
    );
    const afterClaim = await t.run(
      async (ctx) => await ctx.db.get(fixture.actionId),
    );

    expect(result).toEqual({
      claimed: false,
      reason: "Repository is paused",
    });
    expect(afterClaim).toEqual(beforeClaim);
  });

  it("preserves a rejection when a later approval attempts to claim", async () => {
    const { t, fixture } = await createExecutionFixture(
      "open",
      "pending_approval",
    );

    await t.mutation(
      internal.ticketActions.internalMutation.rejectPendingApproval,
      { actionId: fixture.actionId },
    );
    const result = await t.mutation(
      internal.ticketActions.internalMutation.claimForExecution,
      {
        actionId: fixture.actionId,
        mode: "manual_approval",
        expectedProposalVersion: 0,
      },
    );
    const action = await t.run(
      async (ctx) => await ctx.db.get(fixture.actionId),
    );

    expect(result).toEqual({
      claimed: false,
      reason: "Action is not pending approval",
    });
    expect(action).toMatchObject({ status: "rejected" });
    expect(action?.executionClaimedAt).toBeUndefined();
  });

  it("does not let rejection overwrite a claimed approval", async () => {
    const { t, fixture } = await createExecutionFixture(
      "open",
      "pending_approval",
    );

    await t.mutation(
      internal.ticketActions.internalMutation.claimForExecution,
      {
        actionId: fixture.actionId,
        mode: "manual_approval",
        expectedProposalVersion: 0,
      },
    );
    await expect(
      t.mutation(
        internal.ticketActions.internalMutation.rejectPendingApproval,
        { actionId: fixture.actionId },
      ),
    ).rejects.toThrow("Action is no longer pending approval");

    expect(
      await t.run(async (ctx) => await ctx.db.get(fixture.actionId)),
    ).toMatchObject({
      status: "approved",
      executionClaimedAt: expect.any(Number),
    });
  });

  it("preserves requested changes when a later approval attempts to claim", async () => {
    vi.useFakeTimers();
    const { t, fixture } = await createExecutionFixture(
      "open",
      "pending_approval",
    );

    await t.mutation(
      internal.ticketActions.internalMutation.requestChangesForAction,
      { actionId: fixture.actionId, feedback: "Cite the exact implementation" },
    );
    const result = await t.mutation(
      internal.ticketActions.internalMutation.claimForExecution,
      {
        actionId: fixture.actionId,
        mode: "manual_approval",
        expectedProposalVersion: 0,
      },
    );
    const state = await t.run(async (ctx) => ({
      action: await ctx.db.get(fixture.actionId),
      actions: await ctx.db
        .query("ticketActions")
        .withIndex("by_ticket", (q) => q.eq("ticketId", fixture.ticketId))
        .collect(),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));

    expect(result).toEqual({
      claimed: false,
      reason: "Action proposal changed before execution",
    });
    expect(state.action).toMatchObject({
      status: "pending",
      userFeedback: "Cite the exact implementation",
      proposalVersion: 1,
      chatHistory: [
        {
          role: "user",
          content: "Request changes: Cite the exact implementation",
          timestamp: expect.any(Number),
        },
      ],
    });
    expect(state.action?.executionClaimedAt).toBeUndefined();
    expect(state.action?.resultCheckpointKey).toBeUndefined();
    expect(state.action?.resultCheckpointExpiresAt).toBeUndefined();
    expect(state.action?.resultRecoveryLeaseUntil).toBeUndefined();
    expect(state.scheduled.map((scheduled) => scheduled.name).sort()).toEqual([
      "_ai/chatBilling:resumePendingChatGeneration",
      "ticketActions/internalAction:regenerateWithFeedback",
    ]);
    expect(state.action).toMatchObject({
      pendingGenerationTarget: { kind: "regenerate" },
      pendingGenerationExpiresAt: expect.any(Number),
      pendingGenerationScheduleId: expect.any(String),
    });
    await cancelPendingSchedules(t);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("routes follow-up feedback through follow-up processing with full context", async () => {
    vi.useFakeTimers();
    const { t, fixture } = await createExecutionFixture(
      "open",
      "pending_approval",
    );
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.actionId, {
        actionType: "follow_up",
        chatHistory: [
          {
            role: "user",
            content: "[maintainer]: Original follow-up",
            timestamp: 1,
          },
        ],
        proposedChanges: {
          commentId: 99,
          sourceCommentBody: "Original follow-up",
          sourceCommentRawBody: "@gitdogbot Original follow-up",
          author: "maintainer",
          suggestedResponse: "Previous proposed reply",
        },
      });
    });

    await t.mutation(
      internal.ticketActions.internalMutation.requestChangesForAction,
      { actionId: fixture.actionId, feedback: "Be more specific" },
    );

    const state = await t.run(async (ctx) => ({
      action: await ctx.db.get(fixture.actionId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.action).toMatchObject({
      status: "pending",
      userFeedback: "Be more specific",
      proposedChanges: {
        commentId: 99,
        sourceCommentRawBody: "@gitdogbot Original follow-up",
      },
      chatHistory: [
        { role: "user", content: "[maintainer]: Original follow-up" },
        { role: "assistant", content: "Previous proposed reply" },
        { role: "user", content: "Request changes: Be more specific" },
      ],
    });
    expect(state.scheduled.map((scheduled) => scheduled.name).sort()).toEqual([
      "_ai/chatBilling:resumePendingChatGeneration",
      "ticketActions/internalAction:processFollowUp",
    ]);
    const followUpSchedule = state.scheduled.find(
      (scheduled) =>
        scheduled.name === "ticketActions/internalAction:processFollowUp",
    );
    expect(followUpSchedule?.args).toEqual([
      expect.objectContaining({ forceApproval: true }),
    ]);
    expect(state.action).toMatchObject({
      pendingGenerationTarget: {
        kind: "follow_up",
        forceApproval: true,
      },
      pendingGenerationExpiresAt: expect.any(Number),
      pendingGenerationScheduleId: expect.any(String),
    });
    await cancelPendingSchedules(t);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("rejects unsupported regeneration without changing the action", async () => {
    const { t, fixture } = await createExecutionFixture(
      "open",
      "pending_approval",
    );
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.actionId, {
        actionType: "tag_maintainers",
      });
    });
    const before = await t.run(
      async (ctx) => await ctx.db.get(fixture.actionId),
    );

    await expect(
      t.mutation(
        internal.ticketActions.internalMutation.requestChangesForAction,
        { actionId: fixture.actionId, feedback: "Try again" },
      ),
    ).rejects.toThrow("does not support regeneration");

    const state = await t.run(async (ctx) => ({
      action: await ctx.db.get(fixture.actionId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.action).toEqual(before);
    expect(state.scheduled).toHaveLength(0);
  });

  it("does not let requested changes overwrite a claimed approval", async () => {
    const { t, fixture } = await createExecutionFixture(
      "open",
      "pending_approval",
    );

    await t.mutation(
      internal.ticketActions.internalMutation.claimForExecution,
      {
        actionId: fixture.actionId,
        mode: "manual_approval",
        expectedProposalVersion: 0,
      },
    );
    await expect(
      t.mutation(
        internal.ticketActions.internalMutation.requestChangesForAction,
        { actionId: fixture.actionId, feedback: "Try again" },
      ),
    ).rejects.toThrow("Action is no longer pending approval");

    const state = await t.run(async (ctx) => ({
      action: await ctx.db.get(fixture.actionId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.action).toMatchObject({
      status: "approved",
      executionClaimedAt: expect.any(Number),
      chatHistory: [],
    });
    expect(state.action?.userFeedback).toBeUndefined();
    expect(state.scheduled).toHaveLength(1);
    expect(state.scheduled[0]?.name).toBe(
      "ticketActions/internalAction:reconcileClaimedExecution",
    );
    await cancelPendingSchedules(t);
  });

  it.each([
    {
      name: "rejected",
      actionStatus: "rejected" as const,
      mode: "manual_approval" as const,
    },
    {
      name: "regenerating",
      actionStatus: "pending" as const,
      mode: "manual_approval" as const,
    },
    {
      name: "completed",
      actionStatus: "completed" as const,
      mode: "auto_approved" as const,
    },
  ])(
    "does not let an unclaimed $name action get overwritten by a stale preflight failure",
    async ({ actionStatus, mode }) => {
      const { t, fixture } = await createExecutionFixture("open", actionStatus);
      const beforeFailure = await t.run(
        async (ctx) => await ctx.db.get(fixture.actionId),
      );

      const updated = await t.mutation(
        internal.ticketActions.internalMutation.failExecutionAttempt,
        {
          actionId: fixture.actionId,
          mode,
          errorMessage: "Stale preflight failed",
        },
      );
      const afterFailure = await t.run(
        async (ctx) => await ctx.db.get(fixture.actionId),
      );

      expect(updated).toBe(false);
      expect(afterFailure).toEqual(beforeFailure);
    },
  );

  it("does not let an old execution attempt overwrite a newer claim", async () => {
    const { t, fixture } = await createExecutionFixture("open", "approved");
    const claim = await t.mutation(
      internal.ticketActions.internalMutation.claimForExecution,
      {
        actionId: fixture.actionId,
        mode: "auto_approved",
        expectedProposalVersion: 0,
      },
    );
    if (!claim.claimed) {
      throw new Error(`Expected execution claim: ${claim.reason}`);
    }
    const beforeFailure = await t.run(
      async (ctx) => await ctx.db.get(fixture.actionId),
    );

    const updated = await t.mutation(
      internal.ticketActions.internalMutation.failExecutionAttempt,
      {
        actionId: fixture.actionId,
        mode: "auto_approved",
        claimedAt: claim.claimedAt - 1,
        errorMessage: "Old attempt failed",
      },
    );
    const afterFailure = await t.run(
      async (ctx) => await ctx.db.get(fixture.actionId),
    );

    expect(updated).toBe(false);
    expect(afterFailure).toEqual(beforeFailure);
  });

  it("lets the owning execution attempt record its own failure", async () => {
    const { t, fixture } = await createExecutionFixture("open", "approved");
    const claim = await t.mutation(
      internal.ticketActions.internalMutation.claimForExecution,
      {
        actionId: fixture.actionId,
        mode: "auto_approved",
        expectedProposalVersion: 0,
      },
    );
    if (!claim.claimed) {
      throw new Error(`Expected execution claim: ${claim.reason}`);
    }

    const updated = await t.mutation(
      internal.ticketActions.internalMutation.failExecutionAttempt,
      {
        actionId: fixture.actionId,
        mode: "auto_approved",
        claimedAt: claim.claimedAt,
        errorMessage: "GitHub write failed",
      },
    );
    const action = await t.run(
      async (ctx) => await ctx.db.get(fixture.actionId),
    );

    expect(updated).toBe(true);
    expect(action).toMatchObject({
      status: "failed",
      errorMessage: "GitHub write failed",
      executionClaimedAt: claim.claimedAt,
      completedAt: expect.any(Number),
    });
  });

  it("fails only the pending proposal revision when readiness expires", async () => {
    const { t, fixture } = await createExecutionFixture("open", "pending");
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.actionId, { proposalVersion: 2 });
    });

    expect(
      await t.mutation(
        internal.ticketActions.internalMutation.failPendingAction,
        {
          actionId: fixture.actionId,
          expectedProposalVersion: 1,
          errorMessage: "Repository indexing timed out",
        },
      ),
    ).toBe(false);
    expect(
      await t.mutation(
        internal.ticketActions.internalMutation.failPendingAction,
        {
          actionId: fixture.actionId,
          expectedProposalVersion: 2,
          errorMessage: "Repository indexing timed out",
        },
      ),
    ).toBe(true);
    expect(
      await t.run(async (ctx) => await ctx.db.get(fixture.actionId)),
    ).toMatchObject({
      status: "failed",
      errorMessage: "Repository indexing timed out",
    });
  });

  it("finalizes initial formatting and schedules the answer atomically", async () => {
    vi.useFakeTimers();
    const { t, fixture } = await createExecutionFixture("open", "pending");
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.actionId, {
        actionType: "format",
        proposedChanges: undefined,
        proposalVersion: 0,
      });
    });

    await expect(
      t.mutation(
        internal.ticketActions.internalMutation
          .completeInitialFormatAndScheduleAnswer,
        {
          actionId: fixture.actionId,
          outcome: { kind: "completed" },
        },
      ),
    ).resolves.toEqual({ accepted: true, shouldAutoExecute: false });

    const state = await t.run(async (ctx) => ({
      action: await ctx.db.get(fixture.actionId),
      actions: await ctx.db.query("ticketActions").collect(),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.action).toMatchObject({
      status: "completed",
      completedAt: expect.any(Number),
    });
    expect(state.action?.pendingGenerationTarget).toBeUndefined();
    expect(state.action?.pendingGenerationScheduleId).toBeUndefined();
    const answerAction = state.actions.find(
      (action) => action._id !== fixture.actionId,
    );
    expect(answerAction).toMatchObject({
      actionType: "answer",
      status: "pending",
      pendingGenerationTarget: {
        kind: "initial_ticket",
        stage: "answer",
      },
    });
    expect(state.scheduled).toHaveLength(2);
    const answerWorker = state.scheduled.find(
      (scheduled) =>
        scheduled.name === "tickets/internalAction:processNewTicket",
    );
    expect(answerWorker?.args).toEqual([
      {
        ticketId: fixture.ticketId,
        repositoryId: fixture.repositoryId,
        issueTitle: "Original title",
        issueBody: "Original body",
        expectedAiInputVersion: 1,
        expectedIndexVersion: 7,
        processingStage: "answer",
        answerActionId: answerAction?._id,
      },
    ]);
    expect(
      state.scheduled.find(
        (scheduled) =>
          scheduled.name === "_ai/chatBilling:resumePendingChatGeneration",
      )?.args,
    ).toEqual([{ ticketActionId: answerAction?._id }]);
    await cancelPendingSchedules(t);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("approves and schedules safe auto-execution in one transaction", async () => {
    vi.useFakeTimers();
    const { t, fixture } = await createExecutionFixture("open", "pending");

    await expect(
      t.mutation(internal.ticketActions.internalMutation.completeWithResults, {
        actionId: fixture.actionId,
        proposedChanges: {
          originalTitle: "Original title",
          originalBody: "Original body",
          suggestedResponse:
            "README.md describes the repository setup used by this project.",
          groundedIndexVersion: 7,
          confidence: 0.95,
          toolsUsed: 1,
          filesRead: 1,
          filesReadPaths: ["README.md"],
          toolErrors: 0,
          validationPassed: true,
          isActionable: false,
          issueType: "question",
        },
        requireApproval: false,
      }),
    ).resolves.toBe(true);

    const state = await t.run(async (ctx) => ({
      action: await ctx.db.get(fixture.actionId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.action).toMatchObject({
      status: "approved",
      approvedAt: expect.any(Number),
    });
    expect(state.scheduled).toHaveLength(1);
    expect(state.scheduled[0]).toMatchObject({
      name: "tickets/internalAction:executeAutoApprovedAction",
      args: [{ actionId: fixture.actionId }],
    });
    await cancelPendingSchedules(t);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("records one visible timeout for a new ticket", async () => {
    const { t, fixture } = await createExecutionFixture("open", "pending");
    const errorMessage =
      "Repository indexing made no observable progress for 24 hours";

    const first = await t.mutation(
      internal.ticketActions.internalMutation.recordReadinessTimeout,
      { ticketId: fixture.ticketId, errorMessage },
    );
    const second = await t.mutation(
      internal.ticketActions.internalMutation.recordReadinessTimeout,
      { ticketId: fixture.ticketId, errorMessage },
    );
    const matches = await t.run(async (ctx) => {
      const actions = await ctx.db
        .query("ticketActions")
        .withIndex("by_ticket", (q) => q.eq("ticketId", fixture.ticketId))
        .collect();
      return actions.filter((action) => action.errorMessage === errorMessage);
    });

    expect(first).toBe(second);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ status: "failed" });
  });

  it("fails a provider result instead of publishing it after disconnect starts", async () => {
    const { t, fixture } = await createExecutionFixture("open", "pending");
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.repositoryId, {
        isActive: false,
        disconnectCleanupPending: true,
        updatedAt: Date.now(),
      });
    });

    const completed = await t.mutation(
      internal.ticketActions.internalMutation.completeWithResults,
      {
        actionId: fixture.actionId,
        proposedChanges: {
          suggestedResponse: "Stale response",
          groundedIndexVersion: 7,
        },
        requireApproval: true,
      },
    );
    const action = await t.run(
      async (ctx) => await ctx.db.get(fixture.actionId),
    );

    expect(completed).toBe(false);
    expect(action).toMatchObject({
      status: "failed",
      errorMessage: "Repository workflow is no longer active",
      completedAt: expect.any(Number),
    });
  });

  it("fails a stale provider result when the repository index generation changed", async () => {
    const { t, fixture } = await createExecutionFixture("open", "pending");
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.repositoryId, {
        indexVersion: 8,
        updatedAt: Date.now(),
      });
    });

    const updated = await t.mutation(
      internal.ticketActions.internalMutation.updateProposedChanges,
      {
        actionId: fixture.actionId,
        proposedChanges: {
          originalTitle: "Original title",
          originalBody: "Original body",
          suggestedResponse: "Grounded against an old index",
          groundedIndexVersion: 7,
        },
      },
    );
    const action = await t.run(
      async (ctx) => await ctx.db.get(fixture.actionId),
    );

    expect(updated).toBe(false);
    expect(action).toMatchObject({
      status: "failed",
      errorMessage: "Repository index changed during analysis",
    });
  });

  it("fails a provider result generated from edited ticket content", async () => {
    const { t, fixture } = await createExecutionFixture("open", "pending");
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.ticketId, {
        githubTitle: "Edited title",
        githubBody: "Edited body",
      });
    });

    const updated = await t.mutation(
      internal.ticketActions.internalMutation.updateProposedChanges,
      {
        actionId: fixture.actionId,
        proposedChanges: {
          originalTitle: "Original title",
          originalBody: "Original body",
          suggestedResponse: "Answer for the old ticket",
          groundedIndexVersion: 7,
        },
      },
    );
    const action = await t.run((ctx) => ctx.db.get(fixture.actionId));

    expect(updated).toBe(false);
    expect(action).toMatchObject({
      status: "failed",
      errorMessage: "Ticket content changed during analysis",
    });
  });

  it("does not create or reactivate ticket actions after disconnect starts", async () => {
    const { t, fixture } = await createExecutionFixture("open", "pending");
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.repositoryId, {
        isActive: false,
        disconnectCleanupPending: true,
        updatedAt: Date.now(),
      });
    });

    await expect(
      t.mutation(internal.ticketActions.internalMutation.create, {
        ticketId: fixture.ticketId,
        actionType: "format",
      }),
    ).rejects.toThrow("Repository workflow is no longer active");
    expect(
      await t.mutation(internal.ticketActions.internalMutation.updateStatus, {
        actionId: fixture.actionId,
        status: "pending_approval",
      }),
    ).toBe(false);
    expect(
      await t.mutation(internal.ticketActions.internalMutation.createFollowUp, {
        ticketId: fixture.ticketId,
        commentId: 99,
        commentBody: "@gitdogbot stale follow-up",
        commentAuthor: "owner",
      }),
    ).toBeNull();

    const state = await t.run(async (ctx) => ({
      actions: await ctx.db
        .query("ticketActions")
        .withIndex("by_ticket", (q) => q.eq("ticketId", fixture.ticketId))
        .collect(),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.actions).toHaveLength(1);
    expect(state.actions[0]).toMatchObject({
      status: "failed",
      errorMessage: "Repository workflow is no longer active",
    });
    expect(state.scheduled).toHaveLength(0);
  });

  it.each(["reject", "requestChanges"] as const)(
    "does not allow %s to transition an action on a closed ticket",
    async (transition) => {
      const { t, fixture } = await createExecutionFixture(
        "closed",
        "pending_approval",
      );
      const beforeTransition = await t.run(
        async (ctx) => await ctx.db.get(fixture.actionId),
      );

      const request =
        transition === "reject"
          ? t.mutation(
              internal.ticketActions.internalMutation.rejectPendingApproval,
              { actionId: fixture.actionId },
            )
          : t.mutation(
              internal.ticketActions.internalMutation.requestChangesForAction,
              { actionId: fixture.actionId, feedback: "Try again" },
            );
      await expect(request).rejects.toThrow("Ticket is no longer open");

      const state = await t.run(async (ctx) => ({
        action: await ctx.db.get(fixture.actionId),
        scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
      }));
      expect(state.action).toEqual(beforeTransition);
      expect(state.scheduled).toHaveLength(0);
    },
  );
});
