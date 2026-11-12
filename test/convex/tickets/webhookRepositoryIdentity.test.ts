import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import schema from "../../../convex/schema";
import { buildFormattedGitdogBody } from "../../../convex/_utils/gitdogFormat";
import { attachExecutionMarker } from "../../../convex/ticketActions/executionRecovery";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/tickets/internalMutation.ts": () =>
    import("../../../convex/tickets/internalMutation"),
};

async function insertFixture(
  t: ReturnType<typeof convexTest>,
  githubRepositoryId: number,
): Promise<{
  repositoryId: Id<"repositories">;
  ticketId: Id<"tickets">;
}> {
  return await t.run(async (ctx) => {
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
      indexVersion: 1,
      indexStatus: "completed",
      indexProgressAt: Date.now(),
      ragStatus: "completed",
      ragTotalChunks: 0,
      ragIndexedChunks: 0,
      ragFailedChunks: 0,
      userId,
      installationId: 123,
      githubRepositoryId,
      githubRepo: "owner/repo",
      githubRepoKey: "owner/repo",
      name: "repo",
      githubUrl: "https://github.com/owner/repo",
      isActive: true,
      settings: {
        issueAssistantEnabled: true,
        discussionAssistantEnabled: true,
        autoFormatIssue: true,
        autoAnswerQuestions: true,
        tagMaintainersForCodeChanges: true,
        requireApproval: false,
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
    return { repositoryId, ticketId };
  });
}

async function cancelScheduledFunctions(t: ReturnType<typeof convexTest>) {
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
  await t.finishAllScheduledFunctions(() => vi.runAllTimers());
}

async function insertCheckpointedAction(
  t: ReturnType<typeof convexTest>,
  ticketId: Id<"tickets">,
): Promise<Id<"ticketActions">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("ticketActions", {
      ticketId,
      actionType: "answer",
      chatHistory: [],
      proposalVersion: 0,
      status: "pending",
      resultCheckpointKey: `checkpoint:${ticketId}`,
      resultCheckpointExpiresAt: Date.now() + 60_000,
      createdAt: Date.now(),
    }),
  );
}

async function insertDuplicateIdentityFixture(
  t: ReturnType<typeof convexTest>,
  activeDuplicates: number,
): Promise<{
  ticketId: Id<"tickets">;
  activeRepositoryId: Id<"repositories">;
}> {
  return await t.run(async (ctx) => {
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
    await ctx.db.insert("repositories", {
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
      githubRepo: "owner/stale",
      githubRepoKey: "owner/stale",
      name: "stale",
      githubUrl: "https://github.com/owner/stale",
      isActive: false,
      githubAccessRevokedAt: 1,
      isActiveBeforeAccessRevocation: true,
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

    let activeRepositoryId: Id<"repositories"> | null = null;
    for (let index = 0; index < activeDuplicates; index += 1) {
      const githubRepo = index === 0 ? "owner/repo" : `owner/repo-${index}`;
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
        githubRepo,
        githubRepoKey: githubRepo,
        name: githubRepo.split("/").at(-1) ?? githubRepo,
        githubUrl: `https://github.com/${githubRepo}`,
        isActive: true,
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
      activeRepositoryId ??= repositoryId;
    }
    if (!activeRepositoryId) throw new Error("active repository missing");
    const ticketId = await ctx.db.insert("tickets", {
      aiInputVersion: 1,
      repositoryId: activeRepositoryId,
      userId,
      githubRepo: "owner/repo",
      ticketType: "issue",
      githubNumber: 42,
      githubTitle: "Issue",
      status: "open",
      createdAt: now,
    });
    return { ticketId, activeRepositoryId };
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ticket webhook repository identity", () => {
  it("routes a signed ticket through the active row after an earlier revoked duplicate", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertDuplicateIdentityFixture(t, 1);

    await expect(
      t.mutation(
        internal.tickets.internalMutation.getByGithubNumberFromWebhook,
        {
          installationId: 123,
          githubRepositoryId: 456,
          repositoryFullName: "owner/repo",
          githubNumber: 42,
          ticketType: "issue",
        },
      ),
    ).resolves.toMatchObject({
      _id: fixture.ticketId,
      repositoryId: fixture.activeRepositoryId,
    });
  });

  it("fails closed for signed tickets when two active rows share one immutable ID", async () => {
    const t = convexTest(schema, modules);
    await insertDuplicateIdentityFixture(t, 2);

    await expect(
      t.mutation(
        internal.tickets.internalMutation.getByGithubNumberFromWebhook,
        {
          installationId: 123,
          githubRepositoryId: 456,
          repositoryFullName: "owner/repo",
          githubNumber: 42,
          ticketType: "issue",
        },
      ),
    ).resolves.toBeNull();
  });

  it("retires a checkpointed issue answer and schedules the edited input epoch", async () => {
    const t = convexTest(schema, modules);
    const { repositoryId, ticketId } = await insertFixture(t, 456);
    const actionId = await insertCheckpointedAction(t, ticketId);

    await expect(
      t.mutation(internal.tickets.internalMutation.createFromGithubIssue, {
        installationId: 123,
        githubRepositoryId: 456,
        repositoryFullName: "owner/repo",
        issueNumber: 42,
        issueTitle: "Edited issue",
        issueBody: "Edited body",
        issueUrl: "https://github.com/owner/repo/issues/42",
        action: "edited",
        githubState: "open",
        githubStateUpdatedAt: 1_000,
      }),
    ).resolves.toBe(ticketId);

    const state = await t.run(async (ctx) => ({
      ticket: await ctx.db.get(ticketId),
      action: await ctx.db.get(actionId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.ticket).toMatchObject({
      githubTitle: "Edited issue",
      githubBody: "Edited body",
      aiInputVersion: 2,
      status: "open",
    });
    expect(state.action).toMatchObject({
      status: "failed",
      errorMessage: "Superseded by newer ticket content",
      completedAt: expect.any(Number),
    });
    expect(state.action?.resultCheckpointKey).toBeUndefined();
    expect(state.scheduled.map((job) => job.name)).toEqual([
      "tickets/internalAction:processNewTicket",
    ]);
    expect(state.scheduled[0]?.args).toEqual([
      {
        ticketId,
        repositoryId,
        issueTitle: "Edited issue",
        issueBody: "Edited body",
        expectedAiInputVersion: 2,
        expectedIndexVersion: 1,
        initialProcessingGeneration: 1,
        processingStage: "start",
      },
    ]);
    await cancelScheduledFunctions(t);
  });

  it("retires a checkpointed discussion answer and schedules the edited input epoch", async () => {
    const t = convexTest(schema, modules);
    const { repositoryId, ticketId } = await insertFixture(t, 456);
    await t.run(async (ctx) => {
      await ctx.db.patch(ticketId, {
        ticketType: "discussion",
        githubTitle: "Discussion",
      });
    });
    const actionId = await insertCheckpointedAction(t, ticketId);

    await expect(
      t.mutation(internal.tickets.internalMutation.createFromGithubDiscussion, {
        installationId: 123,
        githubRepositoryId: 456,
        repositoryFullName: "owner/repo",
        discussionNumber: 42,
        discussionTitle: "Edited discussion",
        discussionBody: "Edited discussion body",
        discussionUrl: "https://github.com/owner/repo/discussions/42",
        action: "edited",
        githubState: "open",
        githubStateUpdatedAt: 2_000,
      }),
    ).resolves.toBe(ticketId);

    const state = await t.run(async (ctx) => ({
      ticket: await ctx.db.get(ticketId),
      action: await ctx.db.get(actionId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.ticket).toMatchObject({
      githubTitle: "Edited discussion",
      githubBody: "Edited discussion body",
      aiInputVersion: 2,
      status: "open",
    });
    expect(state.action).toMatchObject({
      status: "failed",
      errorMessage: "Superseded by newer ticket content",
      completedAt: expect.any(Number),
    });
    expect(state.action?.resultCheckpointKey).toBeUndefined();
    expect(state.scheduled.map((job) => job.name)).toEqual([
      "tickets/internalAction:processNewTicket",
    ]);
    expect(state.scheduled[0]?.args).toEqual([
      {
        ticketId,
        repositoryId,
        issueTitle: "Edited discussion",
        issueBody: "Edited discussion body",
        expectedAiInputVersion: 2,
        expectedIndexVersion: 1,
        initialProcessingGeneration: 1,
        processingStage: "start",
      },
    ]);
    await cancelScheduledFunctions(t);
  });

  it("preserves a newer close that runs before the issue create job", async () => {
    const t = convexTest(schema, modules);
    const { ticketId } = await insertFixture(t, 456);
    await t.run(async (ctx) => await ctx.db.delete(ticketId));

    const lifecycleId = await t.mutation(
      internal.tickets.internalMutation.closeByGithubNumber,
      {
        installationId: 123,
        githubRepositoryId: 456,
        repositoryFullName: "owner/repo",
        githubNumber: 77,
        ticketType: "issue",
        githubStateUpdatedAt: 2_000,
      },
    );
    expect(lifecycleId).not.toBeNull();
    await expect(
      t.mutation(
        internal.tickets.internalMutation.getByGithubNumberFromWebhook,
        {
          installationId: 123,
          githubRepositoryId: 456,
          repositoryFullName: "owner/repo",
          githubNumber: 77,
          ticketType: "issue",
        },
      ),
    ).resolves.toBeNull();

    const createdId = await t.mutation(
      internal.tickets.internalMutation.createFromGithubIssue,
      {
        installationId: 123,
        githubRepositoryId: 456,
        repositoryFullName: "owner/repo",
        issueNumber: 77,
        issueTitle: "Delayed opened event",
        issueBody: "Body",
        issueUrl: "https://github.com/owner/repo/issues/77",
        issueAuthor: "octocat",
        action: "opened",
        githubStateUpdatedAt: 1_000,
      },
    );
    const state = await t.run(async (ctx) => ({
      ticket: lifecycleId ? await ctx.db.get(lifecycleId) : null,
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));

    expect(createdId).toBe(lifecycleId);
    expect(state.ticket).toMatchObject({
      githubTitle: "Delayed opened event",
      githubBody: "Body",
      githubAuthor: "octocat",
      status: "closed",
      githubStateUpdatedAt: 2_000,
    });
    expect(state.ticket?.githubLifecycleOnly).toBeUndefined();
    expect(state.ticket?.deletedAt).toBeUndefined();
    expect(state.scheduled).toHaveLength(0);
  });

  it("converts a newer reopen marker and schedules discussion processing once", async () => {
    const t = convexTest(schema, modules);
    const { ticketId } = await insertFixture(t, 456);
    await t.run(async (ctx) => await ctx.db.delete(ticketId));

    const lifecycleId = await t.mutation(
      internal.tickets.internalMutation.reopenByGithubNumber,
      {
        installationId: 123,
        githubRepositoryId: 456,
        repositoryFullName: "owner/repo",
        githubNumber: 78,
        ticketType: "discussion",
        githubStateUpdatedAt: 3_000,
      },
    );
    const createdId = await t.mutation(
      internal.tickets.internalMutation.createFromGithubDiscussion,
      {
        installationId: 123,
        githubRepositoryId: 456,
        repositoryFullName: "owner/repo",
        discussionNumber: 78,
        discussionTitle: "Delayed discussion",
        discussionBody: "Body",
        discussionUrl: "https://github.com/owner/repo/discussions/78",
        discussionAuthor: "octocat",
        action: "created",
        githubStateUpdatedAt: 2_000,
      },
    );
    const state = await t.run(async (ctx) => ({
      ticket: lifecycleId ? await ctx.db.get(lifecycleId) : null,
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));

    expect(createdId).toBe(lifecycleId);
    expect(state.ticket).toMatchObject({
      githubTitle: "Delayed discussion",
      status: "open",
      githubStateUpdatedAt: 3_000,
    });
    expect(state.ticket?.githubLifecycleOnly).toBeUndefined();
    expect(state.ticket?.deletedAt).toBeUndefined();
    expect(state.scheduled).toHaveLength(1);
    expect(state.scheduled[0].name).toBe(
      "tickets/internalAction:processNewTicket",
    );
    await t.run(async (ctx) => {
      await ctx.scheduler.cancel(state.scheduled[0]._id);
    });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
  });

  it("keeps a newer edited-closed issue closed until one later reopen schedules processing", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { ticketId } = await insertFixture(t, 456);
    await t.run(async (ctx) => await ctx.db.delete(ticketId));

    const createdId = await t.mutation(
      internal.tickets.internalMutation.createFromGithubIssue,
      {
        installationId: 123,
        githubRepositoryId: 456,
        repositoryFullName: "owner/repo",
        issueNumber: 79,
        issueTitle: "Edited while closed",
        issueBody: "Body",
        issueUrl: "https://github.com/owner/repo/issues/79",
        issueAuthor: "octocat",
        action: "edited",
        githubState: "closed",
        githubStateUpdatedAt: 4_000,
      },
    );
    await t.mutation(internal.tickets.internalMutation.closeByGithubNumber, {
      installationId: 123,
      githubRepositoryId: 456,
      repositoryFullName: "owner/repo",
      githubNumber: 79,
      ticketType: "issue",
      githubStateUpdatedAt: 3_000,
    });

    const closedState = await t.run(async (ctx) => ({
      ticket: createdId ? await ctx.db.get(createdId) : null,
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(closedState.ticket).toMatchObject({
      status: "closed",
      githubStateUpdatedAt: 4_000,
      githubInitialProcessingPending: true,
    });
    expect(closedState.scheduled).toHaveLength(0);

    for (let replay = 0; replay < 2; replay += 1) {
      await t.mutation(internal.tickets.internalMutation.reopenByGithubNumber, {
        installationId: 123,
        githubRepositoryId: 456,
        repositoryFullName: "owner/repo",
        githubNumber: 79,
        ticketType: "issue",
        githubStateUpdatedAt: 5_000,
      });
    }

    const reopenedState = await t.run(async (ctx) => ({
      ticket: createdId ? await ctx.db.get(createdId) : null,
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(reopenedState.ticket).toMatchObject({
      status: "open",
      githubStateUpdatedAt: 5_000,
    });
    expect(reopenedState.ticket?.githubInitialProcessingPending).toBe(true);
    expect(reopenedState.ticket?.githubInitialProcessingGeneration).toBe(1);
    expect(
      reopenedState.scheduled.filter(
        (job) => job.name === "tickets/internalAction:processNewTicket",
      ),
    ).toHaveLength(1);
    await cancelScheduledFunctions(t);
  });

  it("does not let an older close replay reopen an edited-closed discussion", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { ticketId } = await insertFixture(t, 456);
    await t.run(async (ctx) => await ctx.db.delete(ticketId));

    const createdId = await t.mutation(
      internal.tickets.internalMutation.createFromGithubDiscussion,
      {
        installationId: 123,
        githubRepositoryId: 456,
        repositoryFullName: "owner/repo",
        discussionNumber: 81,
        discussionTitle: "Edited closed discussion",
        discussionBody: "Body",
        discussionUrl: "https://github.com/owner/repo/discussions/81",
        discussionAuthor: "octocat",
        action: "edited",
        githubState: "closed",
        githubStateUpdatedAt: 4_000,
      },
    );
    await t.mutation(internal.tickets.internalMutation.closeByGithubNumber, {
      installationId: 123,
      githubRepositoryId: 456,
      repositoryFullName: "owner/repo",
      githubNumber: 81,
      ticketType: "discussion",
      githubStateUpdatedAt: 3_000,
    });

    const state = await t.run(async (ctx) => ({
      ticket: createdId ? await ctx.db.get(createdId) : null,
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.ticket).toMatchObject({
      status: "closed",
      githubStateUpdatedAt: 4_000,
      githubInitialProcessingPending: true,
    });
    expect(state.scheduled).toHaveLength(0);
  });

  it("schedules a same-revision attested discussion reopen exactly once after hydration", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { ticketId } = await insertFixture(t, 456);
    await t.run(async (ctx) => await ctx.db.delete(ticketId));

    const lifecycleId = await t.mutation(
      internal.tickets.internalMutation.closeByGithubNumber,
      {
        installationId: 123,
        githubRepositoryId: 456,
        repositoryFullName: "owner/repo",
        githubNumber: 80,
        ticketType: "discussion",
        githubStateUpdatedAt: 5_000,
      },
    );
    await t.mutation(internal.tickets.internalMutation.reopenByGithubNumber, {
      installationId: 123,
      githubRepositoryId: 456,
      repositoryFullName: "owner/repo",
      githubNumber: 80,
      ticketType: "discussion",
      githubStateUpdatedAt: 5_000,
    });
    await t.mutation(
      internal.tickets.internalMutation.createFromGithubDiscussion,
      {
        installationId: 123,
        githubRepositoryId: 456,
        repositoryFullName: "owner/repo",
        discussionNumber: 80,
        discussionTitle: "Hydrated discussion",
        discussionBody: "Body",
        discussionUrl: "https://github.com/owner/repo/discussions/80",
        discussionAuthor: "octocat",
        action: "created",
        githubState: "open",
        githubStateUpdatedAt: 4_000,
      },
    );

    for (const githubStateAttestedAt of [6_000, 7_000]) {
      await t.mutation(internal.tickets.internalMutation.reopenByGithubNumber, {
        installationId: 123,
        githubRepositoryId: 456,
        repositoryFullName: "owner/repo",
        githubNumber: 80,
        ticketType: "discussion",
        githubStateUpdatedAt: 5_000,
        githubStateAttestedAt,
      });
    }

    const state = await t.run(async (ctx) => ({
      ticket: lifecycleId ? await ctx.db.get(lifecycleId) : null,
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.ticket).toMatchObject({
      githubTitle: "Hydrated discussion",
      status: "open",
      githubStateUpdatedAt: 5_000,
      githubStateAttestedAt: 7_000,
    });
    expect(state.ticket?.githubLifecycleOnly).toBeUndefined();
    expect(state.ticket?.githubInitialProcessingPending).toBe(true);
    expect(state.ticket?.githubInitialProcessingGeneration).toBe(4);
    expect(state.ticket?.deletedAt).toBeUndefined();
    expect(
      state.scheduled.filter(
        (job) =>
          job.name === "github/action:reconcileTicketWebhookState" &&
          job.state.kind === "pending",
      ),
    ).toHaveLength(0);
    expect(
      state.scheduled.filter(
        (job) =>
          job.name === "tickets/internalAction:processNewTicket" &&
          job.state.kind === "pending",
      ),
    ).toHaveLength(1);
    await cancelScheduledFunctions(t);
  });

  it("refuses a mismatched immutable ID instead of falling back by name", async () => {
    const t = convexTest(schema, modules);
    const { repositoryId } = await insertFixture(t, 999);

    const ticket = await t.mutation(
      internal.tickets.internalMutation.getByGithubNumberFromWebhook,
      {
        installationId: 123,
        githubRepositoryId: 456,
        repositoryFullName: "owner/repo",
        githubNumber: 42,
        ticketType: "issue",
      },
    );
    const repository = await t.run(async (ctx) => ctx.db.get(repositoryId));

    expect(ticket).toBeNull();
    expect(repository?.githubRepositoryId).toBe(999);
  });

  it("refuses ticket updates after repository access is revoked", async () => {
    const t = convexTest(schema, modules);
    const { repositoryId } = await insertFixture(t, 456);
    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, {
        githubAccessRevokedAt: Date.now(),
        isActiveBeforeAccessRevocation: true,
        isActive: false,
      });
    });

    const ticket = await t.mutation(
      internal.tickets.internalMutation.getByGithubNumberFromWebhook,
      {
        installationId: 123,
        githubRepositoryId: 456,
        repositoryFullName: "owner/repo",
        githubNumber: 42,
        ticketType: "issue",
      },
    );

    expect(ticket).toBeNull();
  });

  it("does not update or schedule tickets after disconnect starts", async () => {
    const t = convexTest(schema, modules);
    const { repositoryId, ticketId } = await insertFixture(t, 456);
    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, {
        isActive: false,
        disconnectCleanupPending: true,
        updatedAt: Date.now(),
      });
    });

    const result = await t.mutation(
      internal.tickets.internalMutation.createFromGithubIssue,
      {
        installationId: 123,
        githubRepositoryId: 456,
        repositoryFullName: "owner/repo",
        issueNumber: 42,
        issueTitle: "Stale update after disconnect",
        issueUrl: "https://github.com/owner/repo/issues/42",
        action: "edited",
      },
    );
    const state = await t.run(async (ctx) => ({
      ticket: await ctx.db.get(ticketId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));

    expect(result).toBeNull();
    expect(state.ticket).toMatchObject({
      githubTitle: "Issue",
      status: "open",
    });
    expect(state.scheduled).toHaveLength(0);
  });

  it.each([
    {
      label: "repository removal",
      gate: { repositoryRemovalPendingAt: 10 },
    },
    {
      label: "phase-only access reconciliation",
      gate: { repositoryAccessReconciliationPhase: "fetching" as const },
    },
  ])("does not update tickets during $label", async ({ gate }) => {
    const t = convexTest(schema, modules);
    const { ticketId } = await insertFixture(t, 456);
    await t.run(async (ctx) => {
      const installation = await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) => q.eq("installationId", 123))
        .first();
      if (!installation) throw new Error("installation missing");
      await ctx.db.patch(installation._id, gate);
    });

    const result = await t.mutation(
      internal.tickets.internalMutation.createFromGithubIssue,
      {
        installationId: 123,
        githubRepositoryId: 456,
        repositoryFullName: "owner/repo",
        issueNumber: 42,
        issueTitle: "Stale reconciliation update",
        issueUrl: "https://github.com/owner/repo/issues/42",
        action: "edited",
      },
    );
    const ticket = await t.run(async (ctx) => ctx.db.get(ticketId));

    expect(result).toBeNull();
    expect(ticket?.githubTitle).toBe("Issue");
  });

  it("rejects an older installation delivery after a same-user transfer", async () => {
    const t = convexTest(schema, modules);
    const { repositoryId, ticketId } = await insertFixture(t, 456);
    await t.run(async (ctx) => {
      const repository = await ctx.db.get(repositoryId);
      if (!repository) {
        throw new Error("repository missing");
      }
      const now = Date.now();
      await ctx.db.insert("githubInstallations", {
        userId: repository.userId,
        installationId: 124,
        ownerGithubAccountId: "verified-owner-transfer",
        ownershipVerifiedAt: now,
        accountLogin: "owner",
        accountType: "Organization",
        targetType: "Organization",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.patch(repositoryId, {
        installationId: 124,
        githubRepo: "owner/name-c",
        name: "name-c",
        githubUrl: "https://github.com/owner/name-c",
      });
    });

    const ticket = await t.mutation(
      internal.tickets.internalMutation.getByGithubNumberFromWebhook,
      {
        installationId: 123,
        githubRepositoryId: 456,
        repositoryFullName: "owner/name-b",
        githubNumber: 42,
        ticketType: "issue",
      },
    );
    await t.mutation(internal.tickets.internalMutation.createFromGithubIssue, {
      installationId: 123,
      githubRepositoryId: 456,
      repositoryFullName: "owner/name-b",
      issueNumber: 42,
      issueTitle: "Updated issue",
      issueUrl: "https://github.com/owner/name-b/issues/42",
      action: "edited",
    });
    const repository = await t.run(async (ctx) => ctx.db.get(repositoryId));
    const storedTicket = await t.run(async (ctx) => ctx.db.get(ticketId));

    expect(ticket).toBeNull();
    expect(repository).toMatchObject({
      installationId: 124,
      githubRepositoryId: 456,
      githubRepo: "owner/name-c",
      name: "name-c",
      githubUrl: "https://github.com/owner/name-c",
    });
    expect(storedTicket).toMatchObject({
      _id: ticketId,
      githubRepo: "owner/repo",
      githubTitle: "Issue",
    });
  });
});

describe("durable ticket state attestations", () => {
  it("hydrates a no-row edited issue from the live snapshot before scheduling AI", async () => {
    const t = convexTest(schema, modules);
    const { ticketId } = await insertFixture(t, 456);
    await t.run(async (ctx) => ctx.db.delete(ticketId));

    const result = await t.mutation(
      internal.tickets.internalMutation.createFromGithubIssue,
      {
        installationId: 123,
        githubRepositoryId: 456,
        repositoryFullName: "owner/repo",
        issueNumber: 99,
        issueTitle: "Webhook title",
        issueBody: "Webhook body",
        issueUrl: "https://github.com/owner/repo/issues/99",
        issueAuthor: "reporter",
        action: "edited",
      },
    );
    expect(result).toBeNull();

    const job = await t.run(async (ctx) =>
      ctx.db.query("ticketStateAttestationJobs").unique(),
    );
    expect(job).toMatchObject({
      githubRepositoryId: 456,
      githubNumber: 99,
      ticketType: "issue",
      status: "pending",
      generation: 1,
    });
    if (!job) throw new Error("attestation job missing");

    await expect(
      t.mutation(
        internal.tickets.internalMutation.applyTicketStateAttestation,
        {
          jobId: job._id,
          expectedGeneration: job.generation,
          githubState: "open",
          githubStateUpdatedAt: 10_000,
          githubStateAttestedAt: 11_000,
          githubTitle: "Live title",
          githubBody: "Live body",
          githubAuthor: "live-reporter",
        },
      ),
    ).resolves.toBe(true);

    const state = await t.run(async (ctx) => ({
      job: await ctx.db.get(job._id),
      tickets: await ctx.db.query("tickets").collect(),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    const hydrated = state.tickets.find(
      (ticket) => ticket.githubNumber === 99 && ticket.ticketType === "issue",
    );
    expect(state.job).toBeNull();
    expect(hydrated).toMatchObject({
      githubTitle: "Live title",
      githubBody: "Live body",
      githubAuthor: "live-reporter",
      status: "open",
      githubInitialProcessingPending: true,
    });
    expect(
      state.scheduled
        .filter((scheduled) => scheduled.state.kind === "pending")
        .map((scheduled) => scheduled.name),
    ).toEqual(["tickets/internalAction:processNewTicket"]);
  });

  it("upserts one live job and rejects work from the superseded generation", async () => {
    const t = convexTest(schema, modules);
    const { ticketId } = await insertFixture(t, 456);
    await t.run(async (ctx) => ctx.db.delete(ticketId));
    const payload = {
      installationId: 123,
      githubRepositoryId: 456,
      repositoryFullName: "owner/repo",
      issueNumber: 100,
      issueTitle: "Edited",
      issueUrl: "https://github.com/owner/repo/issues/100",
      action: "edited",
    };
    await t.mutation(
      internal.tickets.internalMutation.createFromGithubIssue,
      payload,
    );
    const first = await t.run(async (ctx) =>
      ctx.db.query("ticketStateAttestationJobs").unique(),
    );
    await t.mutation(
      internal.tickets.internalMutation.createFromGithubIssue,
      payload,
    );
    const jobs = await t.run(async (ctx) =>
      ctx.db.query("ticketStateAttestationJobs").collect(),
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.generation).toBe(2);
    if (!first) throw new Error("first generation missing");
    await expect(
      t.mutation(
        internal.tickets.internalMutation.applyTicketStateAttestation,
        {
          jobId: first._id,
          expectedGeneration: 1,
          githubState: "open",
          githubStateUpdatedAt: 20_000,
          githubStateAttestedAt: 21_000,
          githubTitle: "Stale live title",
        },
      ),
    ).resolves.toBe(false);
    await expect(
      t.mutation(
        internal.tickets.internalMutation.scheduleTicketStateAttestationRetry,
        {
          jobId: first._id,
          expectedGeneration: 1,
          retryCount: 1,
          delayMs: 1_000,
          errorMessage: "stale",
        },
      ),
    ).resolves.toBe(false);
  });

  it("restarts expired jobs with and without an existing ticket", async () => {
    const t = convexTest(schema, modules);
    const { ticketId } = await insertFixture(t, 456);
    const now = Date.now();
    const jobIds = await t.run(async (ctx) => {
      await ctx.db.patch(ticketId, {
        githubStateAttestationPending: true,
        githubInitialProcessingPending: true,
        githubInitialProcessingGeneration: 4,
      });
      const common = {
        installationId: 123,
        githubRepositoryId: 456,
        repositoryFullName: "owner/repo",
        ticketType: "issue" as const,
        generation: 4,
        status: "pending" as const,
        retryCount: 6,
        resumeInitialProcessing: true,
        nextAttemptAt: now - 1,
        expiresAt: now - 1,
        createdAt: now - 10_000,
        updatedAt: now - 10_000,
      };
      return [
        await ctx.db.insert("ticketStateAttestationJobs", {
          ...common,
          githubNumber: 42,
        }),
        await ctx.db.insert("ticketStateAttestationJobs", {
          ...common,
          githubNumber: 404,
        }),
      ];
    });

    await expect(
      t.mutation(
        internal.tickets.internalMutation.recoverTicketStateAttestations,
        {},
      ),
    ).resolves.toEqual({ restarted: 2, scheduled: 0 });
    const state = await t.run(async (ctx) => ({
      jobs: await Promise.all(jobIds.map((jobId) => ctx.db.get(jobId))),
      ticket: await ctx.db.get(ticketId),
    }));
    expect(state.jobs.every((job) => job?.generation === 5)).toBe(true);
    expect(state.jobs.every((job) => (job?.expiresAt ?? 0) > now)).toBe(true);
    expect(state.jobs.every((job) => job?.scheduleId !== undefined)).toBe(true);
    expect(state.ticket).toMatchObject({
      githubStateAttestationPending: true,
      githubInitialProcessingPending: true,
      githubInitialProcessingGeneration: 4,
    });
  });

  it("invalidates an in-progress initial generation for same-input edited delivery", async () => {
    const t = convexTest(schema, modules);
    const { ticketId } = await insertFixture(t, 456);
    const actionId = await t.run(async (ctx) => {
      await ctx.db.patch(ticketId, {
        githubInitialProcessingPending: true,
        githubInitialProcessingGeneration: 7,
      });
      return await ctx.db.insert("ticketActions", {
        ticketId,
        actionType: "format",
        chatHistory: [],
        proposalVersion: 0,
        status: "pending",
        createdAt: Date.now(),
      });
    });

    await t.mutation(internal.tickets.internalMutation.createFromGithubIssue, {
      installationId: 123,
      githubRepositoryId: 456,
      repositoryFullName: "owner/repo",
      issueNumber: 42,
      issueTitle: "Issue",
      issueUrl: "https://github.com/owner/repo/issues/42",
      action: "edited",
    });
    const state = await t.run(async (ctx) => ({
      ticket: await ctx.db.get(ticketId),
      action: await ctx.db.get(actionId),
      jobs: await ctx.db.query("ticketStateAttestationJobs").collect(),
    }));
    expect(state.ticket).toMatchObject({
      githubStateAttestationPending: true,
      githubInitialProcessingPending: true,
      githubInitialProcessingGeneration: 8,
    });
    expect(state.action).toMatchObject({
      status: "failed",
      errorMessage: "Paused for authoritative GitHub state attestation",
    });
    expect(state.jobs).toHaveLength(1);
  });

  it("does not restart AI for a fully processed state-only attestation", async () => {
    const t = convexTest(schema, modules);
    const { ticketId } = await insertFixture(t, 456);
    await t.run(async (ctx) => {
      await ctx.db.insert("ticketActions", {
        ticketId,
        actionType: "answer",
        chatHistory: [],
        proposalVersion: 1,
        status: "completed",
        createdAt: Date.now(),
        completedAt: Date.now(),
      });
    });
    await t.mutation(internal.tickets.internalMutation.closeByGithubNumber, {
      installationId: 123,
      githubRepositoryId: 456,
      repositoryFullName: "owner/repo",
      githubNumber: 42,
      ticketType: "issue",
    });
    const job = await t.run(async (ctx) =>
      ctx.db.query("ticketStateAttestationJobs").unique(),
    );
    expect(job?.resumeInitialProcessing).toBe(false);
    if (!job) throw new Error("attestation job missing");
    await expect(
      t.mutation(
        internal.tickets.internalMutation.applyTicketStateAttestation,
        {
          jobId: job._id,
          expectedGeneration: job.generation,
          githubState: "open",
          githubStateUpdatedAt: 40_000,
          githubStateAttestedAt: 41_000,
          githubTitle: "Issue",
        },
      ),
    ).resolves.toBe(true);
    const state = await t.run(async (ctx) => ({
      ticket: await ctx.db.get(ticketId),
      pendingSchedules: (
        await ctx.db.system.query("_scheduled_functions").collect()
      ).filter((scheduled) => scheduled.state.kind === "pending"),
      actions: await ctx.db
        .query("ticketActions")
        .withIndex("by_ticket", (q) => q.eq("ticketId", ticketId))
        .collect(),
    }));
    expect(state.ticket?.githubStateAttestationPending).toBeUndefined();
    expect(state.ticket?.githubInitialProcessingPending).toBeUndefined();
    expect(state.pendingSchedules).toHaveLength(0);
    expect(state.actions).toHaveLength(1);
  });

  it("does not let an older live snapshot overwrite a newer trusted webhook", async () => {
    const t = convexTest(schema, modules);
    const { ticketId } = await insertFixture(t, 456);
    await t.mutation(internal.tickets.internalMutation.createFromGithubIssue, {
      installationId: 123,
      githubRepositoryId: 456,
      repositoryFullName: "owner/repo",
      issueNumber: 42,
      issueTitle: "Issue",
      issueUrl: "https://github.com/owner/repo/issues/42",
      action: "edited",
    });
    const oldJob = await t.run(async (ctx) =>
      ctx.db.query("ticketStateAttestationJobs").unique(),
    );
    if (!oldJob) throw new Error("attestation job missing");

    await t.mutation(internal.tickets.internalMutation.createFromGithubIssue, {
      installationId: 123,
      githubRepositoryId: 456,
      repositoryFullName: "owner/repo",
      issueNumber: 42,
      issueTitle: "New trusted title",
      issueBody: "New trusted body",
      issueUrl: "https://github.com/owner/repo/issues/42",
      action: "edited",
      githubState: "open",
      githubStateUpdatedAt: 30_000,
    });
    await expect(
      t.mutation(
        internal.tickets.internalMutation.applyTicketStateAttestation,
        {
          jobId: oldJob._id,
          expectedGeneration: oldJob.generation,
          githubState: "closed",
          githubStateUpdatedAt: 20_000,
          githubStateAttestedAt: 21_000,
          githubTitle: "Stale live title",
          githubBody: "Stale live body",
        },
      ),
    ).resolves.toBe(false);
    const pending = await t.run(async (ctx) => ({
      ticket: await ctx.db.get(ticketId),
      job: await ctx.db.query("ticketStateAttestationJobs").unique(),
    }));
    expect(pending.ticket).toMatchObject({
      githubTitle: "New trusted title",
      githubBody: "New trusted body",
      status: "open",
      githubStateUpdatedAt: 30_000,
      githubInitialProcessingPending: true,
      githubStateAttestationPending: true,
    });
    expect(pending.job?.generation).toBeGreaterThan(oldJob.generation);
    expect(pending.job?.resumeInitialProcessing).toBe(true);
    if (!pending.ticket?.githubInitialProcessingGeneration || !pending.job) {
      throw new Error("initial generation missing");
    }
    await expect(
      t.mutation(
        internal.tickets.internalMutation.refreshInitialTicketProcessingLease,
        {
          ticketId,
          expectedAiInputVersion: pending.ticket.aiInputVersion,
          initialProcessingGeneration:
            pending.ticket.githubInitialProcessingGeneration,
        },
      ),
    ).resolves.toBe(false);
    await expect(
      t.mutation(
        internal.tickets.internalMutation.applyTicketStateAttestation,
        {
          jobId: pending.job._id,
          expectedGeneration: pending.job.generation,
          githubState: "open",
          githubStateUpdatedAt: 30_000,
          githubStateAttestedAt: 31_000,
          githubTitle: "New trusted title",
          githubBody: "New trusted body",
        },
      ),
    ).resolves.toBe(true);
    const finalState = await t.run(async (ctx) => ({
      ticket: await ctx.db.get(ticketId),
      job: await ctx.db.get(pending.job!._id),
    }));
    expect(finalState.job).toBeNull();
    expect(finalState.ticket?.githubStateAttestationPending).toBeUndefined();
    expect(finalState.ticket?.githubInitialProcessingPending).toBe(true);
  });

  it("applies a completed Gitdog format webhook without restarting AI", async () => {
    const t = convexTest(schema, modules);
    const { ticketId } = await insertFixture(t, 456);
    const executionKey = "00000000-0000-4000-8000-000000000000";
    const suggestedBody = "## Reproduction\n\nRun the example.";
    const formattedBody = buildFormattedGitdogBody(
      suggestedBody,
      "Structured the report",
    );
    if (!formattedBody) throw new Error("formatted body missing");
    const markedBody = attachExecutionMarker(formattedBody, executionKey);
    const actionId = await t.run(
      async (ctx) =>
        await ctx.db.insert("ticketActions", {
          ticketId,
          actionType: "format",
          chatHistory: [],
          proposedChanges: {
            originalTitle: "Issue",
            originalBody: "",
            suggestedTitle: "Clear issue title",
            suggestedBody,
            changesSummary: "Structured the report",
          },
          proposalVersion: 0,
          status: "completed",
          executionClaimedAt: Date.now(),
          executionResult: { success: true, updatedIssue: true },
          executionIdempotencyKey: executionKey,
          executionRecoveryMode: "auto_approved",
          completedAt: Date.now(),
          createdAt: Date.now(),
        }),
    );

    await expect(
      t.mutation(internal.tickets.internalMutation.createFromGithubIssue, {
        installationId: 123,
        githubRepositoryId: 456,
        repositoryFullName: "owner/repo",
        issueNumber: 42,
        issueTitle: "Clear issue title",
        issueBody: markedBody,
        issueUrl: "https://github.com/owner/repo/issues/42",
        issueAuthor: "author",
        action: "edited",
        trustedExecutionKey: executionKey,
        githubState: "open",
        githubStateUpdatedAt: 40_000,
      }),
    ).resolves.toBe(ticketId);
    const state = await t.run(async (ctx) => ({
      ticket: await ctx.db.get(ticketId),
      action: await ctx.db.get(actionId),
      pendingSchedules: (
        await ctx.db.system.query("_scheduled_functions").collect()
      ).filter((job) => job.state.kind === "pending"),
    }));
    expect(state.ticket).toMatchObject({
      githubTitle: "Clear issue title",
      githubBody: markedBody,
      githubAuthor: "author",
      aiInputVersion: 1,
      status: "open",
      githubStateUpdatedAt: 40_000,
    });
    expect(state.ticket?.githubInitialProcessingPending).toBeUndefined();
    expect(state.action).toMatchObject({
      status: "completed",
      executionIdempotencyKey: executionKey,
    });
    expect(state.pendingSchedules).toHaveLength(0);
  });

  it("does not trust a user-authored execution marker", async () => {
    const t = convexTest(schema, modules);
    const { ticketId } = await insertFixture(t, 456);
    const forgedBody = attachExecutionMarker(
      "Human-authored edit",
      "00000000-0000-4000-8000-000000000000",
    );

    await t.mutation(internal.tickets.internalMutation.createFromGithubIssue, {
      installationId: 123,
      githubRepositoryId: 456,
      repositoryFullName: "owner/repo",
      issueNumber: 42,
      issueTitle: "Human edit",
      issueBody: forgedBody,
      issueUrl: "https://github.com/owner/repo/issues/42",
      issueAuthor: "human",
      action: "edited",
      githubState: "open",
      githubStateUpdatedAt: 50_000,
    });
    const state = await t.run(async (ctx) => ({
      ticket: await ctx.db.get(ticketId),
      pendingSchedules: (
        await ctx.db.system.query("_scheduled_functions").collect()
      ).filter((job) => job.state.kind === "pending"),
    }));
    expect(state.ticket).toMatchObject({
      githubTitle: "Human edit",
      githubBody: forgedBody,
      githubAuthor: "human",
      aiInputVersion: 2,
      githubInitialProcessingPending: true,
    });
    expect(
      state.pendingSchedules.some(
        (job) => job.name === "tickets/internalAction:processNewTicket",
      ),
    ).toBe(true);
    await cancelScheduledFunctions(t);
  });
});
