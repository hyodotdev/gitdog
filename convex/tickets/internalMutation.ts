import { internalMutation, MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { Doc, Id } from "../_generated/dataModel";
import { getRepositoryAiReadiness } from "../repositories/aiReadiness";
import {
  getExactGitHubInstallation,
  isGitHubInstallationReady,
} from "../github/installationAccess";
import {
  readRepositoriesByInstallationAndGitHubRepositoryId,
  resolveUniquePreferredRepositoryIdentity,
} from "../repositories/immutableIdentity";
import { buildFormattedGitdogBody } from "../_utils/gitdogFormat";
import { attachExecutionMarker } from "../ticketActions/executionRecovery";

export const INITIAL_TICKET_PROCESSING_LEASE_MS = 10 * 60 * 1_000;
export const INITIAL_TICKET_PROCESSING_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const INITIAL_TICKET_PROCESSING_RECOVERY_LIMIT = 50;
const TICKET_STATE_ATTESTATION_LEASE_MS = 10 * 60 * 1_000;
const TICKET_STATE_ATTESTATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const TICKET_STATE_ATTESTATION_RECOVERY_LIMIT = 50;

async function applyTrustedFormatExecutionEdit(
  ctx: MutationCtx,
  args: {
    ticket: Doc<"tickets">;
    executionKey: string;
    title: string;
    body: string | undefined;
    author: string | undefined;
    githubRepo: string;
  },
): Promise<boolean> {
  const action = await ctx.db
    .query("ticketActions")
    .withIndex("by_execution_idempotency_key", (q) =>
      q.eq("executionIdempotencyKey", args.executionKey),
    )
    .unique();
  if (
    !action ||
    action.ticketId !== args.ticket._id ||
    action.actionType !== "format" ||
    (action.status !== "approved" && action.status !== "completed")
  ) {
    return false;
  }
  const suggestedTitle = action.proposedChanges?.suggestedTitle;
  const suggestedBody = action.proposedChanges?.suggestedBody;
  if (typeof suggestedTitle !== "string" || typeof suggestedBody !== "string") {
    return false;
  }
  const formattedBody = buildFormattedGitdogBody(
    suggestedBody,
    action.proposedChanges?.changesSummary || "Formatting improvements",
  );
  if (
    !formattedBody ||
    args.title !== suggestedTitle ||
    (args.body ?? "") !==
      attachExecutionMarker(formattedBody, args.executionKey)
  ) {
    return false;
  }

  await ctx.db.patch(args.ticket._id, {
    githubRepo: args.githubRepo,
    githubTitle: args.title,
    githubBody: args.body,
    githubAuthor: args.author,
  });
  if (action.status === "approved") {
    for (const scheduleId of [
      action.resultRecoveryScheduleId,
      action.pendingGenerationScheduleId,
      action.autoExecutionRecoveryScheduleId,
      action.executionRecoveryScheduleId,
    ]) {
      if (!scheduleId) continue;
      const scheduled = await ctx.db.system.get(scheduleId);
      if (scheduled?.state.kind === "pending") {
        await ctx.scheduler.cancel(scheduleId);
      }
    }
    await ctx.db.patch(action._id, {
      status: "completed",
      executionResult: {
        success: true,
        updatedIssue: true,
        updatedTitle: true,
        updatedBody: true,
        reconciledFromWebhook: true,
      },
      completedAt: Date.now(),
      resultCheckpointKey: undefined,
      resultCheckpointExpiresAt: undefined,
      resultRecoveryLeaseUntil: undefined,
      resultRecoveryScheduleId: undefined,
      pendingGenerationTarget: undefined,
      pendingGenerationExpiresAt: undefined,
      pendingGenerationScheduleId: undefined,
      pendingGenerationLeaseUntil: undefined,
      providerRetryStartedAt: undefined,
      autoExecutionRecoveryExpiresAt: undefined,
      autoExecutionRecoveryLeaseUntil: undefined,
      autoExecutionRecoveryScheduleId: undefined,
      executionRecoveryReconcileOnly: undefined,
      executionRecoveryReconcileDeadlineAt: undefined,
      executionRecoveryExpiresAt: undefined,
      executionRecoveryLeaseUntil: undefined,
      executionRecoveryScheduleId: undefined,
    });
  }
  return true;
}

/** Resolve a signed webhook repository by immutable ID. */
async function findRepositoryForWebhook(
  ctx: MutationCtx,
  installationId: number,
  githubRepositoryId: number,
): Promise<Doc<"repositories"> | null> {
  const installation = await getExactGitHubInstallation(ctx, installationId);
  if (!isGitHubInstallationReady(installation)) {
    return null;
  }

  const identityMatches =
    await readRepositoriesByInstallationAndGitHubRepositoryId(
      ctx,
      installationId,
      githubRepositoryId,
    );
  const repository = resolveUniquePreferredRepositoryIdentity(
    identityMatches,
    (candidate) =>
      candidate.userId === installation.userId &&
      candidate.installationId === installationId &&
      candidate.githubRepositoryId === githubRepositoryId &&
      candidate.isActive === true &&
      candidate.disconnectCleanupPending !== true &&
      candidate.githubAccessRevokedAt === undefined &&
      candidate.githubInstallationReconnectRequired !== true,
  ).repository;

  if (
    !repository ||
    repository.installationId !== installationId ||
    repository.userId !== installation.userId ||
    repository.isActive !== true ||
    repository.disconnectCleanupPending === true ||
    repository.githubAccessRevokedAt !== undefined ||
    repository.githubRepositoryId !== githubRepositoryId
  ) {
    console.log("Repository was not available for webhook routing");
    return null;
  }

  return repository;
}

/** Resolve a ticket only through a signed, immutable repository identity. */
export const getByGithubNumberFromWebhook = internalMutation({
  args: {
    installationId: v.number(),
    githubRepositoryId: v.number(),
    repositoryFullName: v.string(),
    githubNumber: v.number(),
    ticketType: v.union(v.literal("issue"), v.literal("discussion")),
  },
  handler: async (ctx, args) => {
    const repository = await findRepositoryForWebhook(
      ctx,
      args.installationId,
      args.githubRepositoryId,
    );
    if (!repository) {
      return null;
    }
    const tickets = await ctx.db
      .query("tickets")
      .withIndex("by_github_number", (q) =>
        q
          .eq("repositoryId", repository._id)
          .eq("githubNumber", args.githubNumber),
      )
      .take(3);
    return (
      tickets.find(
        (ticket) =>
          ticket.ticketType === args.ticketType &&
          ticket.githubLifecycleOnly !== true,
      ) ?? null
    );
  },
});

/**
 * Create a new ticket
 */
export const create = internalMutation({
  args: {
    repositoryId: v.optional(v.id("repositories")),
    userId: v.id("users"),
    githubRepo: v.string(),
    ticketType: v.union(v.literal("issue"), v.literal("discussion")),
    githubNumber: v.number(),
    githubTitle: v.string(),
    githubBody: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    const ticketId = await ctx.db.insert("tickets", {
      repositoryId: args.repositoryId,
      userId: args.userId,
      githubRepo: args.githubRepo,
      ticketType: args.ticketType,
      githubNumber: args.githubNumber,
      githubTitle: args.githubTitle,
      githubBody: args.githubBody,
      aiInputVersion: 1,
      status: "open",
      createdAt: now,
    });

    return ticketId;
  },
});

/**
 * Close a ticket
 */
export const close = internalMutation({
  args: {
    ticketId: v.id("tickets"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.ticketId, {
      status: "closed",
      closedAt: Date.now(),
    });
  },
});

/**
 * Reopen a ticket
 */
export const reopen = internalMutation({
  args: {
    ticketId: v.id("tickets"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.ticketId, {
      status: "open",
      closedAt: undefined,
    });
  },
});

async function scheduleNewTicketProcessing(
  ctx: MutationCtx,
  args: {
    repository: Doc<"repositories">;
    ticketId: Id<"tickets">;
    title: string;
    body?: string;
    label: string;
    delayMs?: number;
    processingStage?: "start" | "answer";
    expectedIndexVersion?: number;
    readinessRetryAttempt?: number;
    readinessStartedAt?: number;
    readinessProgressAt?: number;
    readinessProgressKey?: string;
    initialProcessingGeneration?: number;
  },
): Promise<void> {
  const ticket = await ctx.db.get(args.ticketId);
  if (!ticket || ticket.ticketType === "pull_request") return;
  const readiness = getRepositoryAiReadiness(args.repository);
  if (readiness.state !== "ready") {
    console.log(
      `[tickets] Persisted ${args.label}; AI processing will wait: ${readiness.reason}`,
    );
  }
  if (
    args.initialProcessingGeneration !== undefined &&
    (ticket.githubInitialProcessingPending !== true ||
      ticket.githubInitialProcessingGeneration !==
        args.initialProcessingGeneration ||
      ticket.githubInitialProcessingAiInputVersion !== ticket.aiInputVersion)
  ) {
    return;
  }
  const ticketType = ticket.ticketType;
  const pendingStateAttestation = await ctx.db
    .query("ticketStateAttestationJobs")
    .withIndex("by_target", (q) =>
      q
        .eq("installationId", args.repository.installationId)
        .eq("githubRepositoryId", args.repository.githubRepositoryId)
        .eq("ticketType", ticketType)
        .eq("githubNumber", ticket.githubNumber),
    )
    .unique();
  if (pendingStateAttestation?.status === "pending") {
    if (!pendingStateAttestation.resumeInitialProcessing) {
      await ctx.db.patch(pendingStateAttestation._id, {
        resumeInitialProcessing: true,
        updatedAt: Date.now(),
      });
    }
    if (ticket.githubInitialProcessingScheduleId) {
      const scheduled = await ctx.db.system.get(
        ticket.githubInitialProcessingScheduleId,
      );
      if (scheduled?.state.kind === "pending") {
        await ctx.scheduler.cancel(ticket.githubInitialProcessingScheduleId);
      }
    }
    await ctx.db.patch(ticket._id, {
      githubStateAttestationPending: true,
      githubInitialProcessingPending: true,
      githubInitialProcessingGeneration:
        ticket.githubStateAttestationPending === true
          ? ticket.githubInitialProcessingGeneration
          : (ticket.githubInitialProcessingGeneration ?? 0) + 1,
      githubInitialProcessingAiInputVersion: ticket.aiInputVersion,
      githubInitialProcessingExpiresAt: undefined,
      githubInitialProcessingLeaseUntil: undefined,
      githubInitialProcessingScheduleId: undefined,
    });
    return;
  }

  if (ticket.githubInitialProcessingScheduleId) {
    const scheduled = await ctx.db.system.get(
      ticket.githubInitialProcessingScheduleId,
    );
    if (
      args.initialProcessingGeneration === undefined &&
      ticket.githubInitialProcessingPending === true &&
      ticket.githubInitialProcessingAiInputVersion === ticket.aiInputVersion &&
      (scheduled?.state.kind === "pending" ||
        scheduled?.state.kind === "inProgress")
    ) {
      return;
    }
    if (scheduled?.state.kind === "pending") {
      await ctx.scheduler.cancel(ticket.githubInitialProcessingScheduleId);
    }
  }

  const now = Date.now();
  const generation =
    args.initialProcessingGeneration ??
    (ticket.githubInitialProcessingGeneration ?? 0) + 1;
  const scheduleId = await ctx.scheduler.runAfter(
    args.delayMs ?? 0,
    internal.tickets.internalAction.processNewTicket,
    {
      ticketId: args.ticketId,
      repositoryId: args.repository._id,
      issueTitle: args.title,
      issueBody: args.body || "",
      expectedAiInputVersion: ticket.aiInputVersion,
      expectedIndexVersion: args.expectedIndexVersion ?? readiness.indexVersion,
      processingStage: args.processingStage ?? "start",
      readinessRetryAttempt: args.readinessRetryAttempt,
      readinessStartedAt: args.readinessStartedAt,
      readinessProgressAt: args.readinessProgressAt,
      readinessProgressKey: args.readinessProgressKey,
      initialProcessingGeneration: generation,
    },
  );
  await ctx.db.patch(args.ticketId, {
    githubInitialProcessingPending: true,
    githubInitialProcessingGeneration: generation,
    githubInitialProcessingAiInputVersion: ticket.aiInputVersion,
    githubInitialProcessingExpiresAt:
      args.initialProcessingGeneration === undefined
        ? now + INITIAL_TICKET_PROCESSING_TTL_MS
        : (ticket.githubInitialProcessingExpiresAt ??
          now + INITIAL_TICKET_PROCESSING_TTL_MS),
    githubInitialProcessingLeaseUntil:
      now + (args.delayMs ?? 0) + INITIAL_TICKET_PROCESSING_LEASE_MS,
    githubInitialProcessingScheduleId: scheduleId,
  });
  console.log("Scheduled AI processing for ticket:", args.ticketId);
}

export const refreshInitialTicketProcessingLease = internalMutation({
  args: {
    ticketId: v.id("tickets"),
    expectedAiInputVersion: v.number(),
    initialProcessingGeneration: v.number(),
  },
  handler: async (ctx, args) => {
    const ticket = await ctx.db.get(args.ticketId);
    if (
      !ticket ||
      ticket.githubInitialProcessingPending !== true ||
      ticket.githubStateAttestationPending === true ||
      ticket.githubInitialProcessingGeneration !==
        args.initialProcessingGeneration ||
      ticket.githubInitialProcessingAiInputVersion !==
        args.expectedAiInputVersion ||
      ticket.aiInputVersion !== args.expectedAiInputVersion
    ) {
      return false;
    }
    await ctx.db.patch(ticket._id, {
      githubInitialProcessingLeaseUntil:
        Date.now() + INITIAL_TICKET_PROCESSING_LEASE_MS,
    });
    return true;
  },
});

export const clearInitialTicketProcessing = internalMutation({
  args: {
    ticketId: v.id("tickets"),
    expectedAiInputVersion: v.number(),
    initialProcessingGeneration: v.number(),
    preserveForReopen: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const ticket = await ctx.db.get(args.ticketId);
    if (
      !ticket ||
      ticket.githubInitialProcessingPending !== true ||
      ticket.githubInitialProcessingGeneration !==
        args.initialProcessingGeneration ||
      ticket.githubInitialProcessingAiInputVersion !==
        args.expectedAiInputVersion ||
      ticket.aiInputVersion !== args.expectedAiInputVersion
    ) {
      return false;
    }
    if (ticket.githubInitialProcessingScheduleId) {
      const scheduled = await ctx.db.system.get(
        ticket.githubInitialProcessingScheduleId,
      );
      if (scheduled?.state.kind === "pending") {
        await ctx.scheduler.cancel(ticket.githubInitialProcessingScheduleId);
      }
    }
    await ctx.db.patch(ticket._id, {
      githubInitialProcessingPending: args.preserveForReopen ? true : undefined,
      githubInitialProcessingGeneration: args.preserveForReopen
        ? args.initialProcessingGeneration
        : undefined,
      githubInitialProcessingAiInputVersion: args.preserveForReopen
        ? ticket.aiInputVersion
        : undefined,
      githubInitialProcessingExpiresAt: undefined,
      githubInitialProcessingLeaseUntil: undefined,
      githubInitialProcessingScheduleId: undefined,
    });
    return true;
  },
});

/** Atomically end an initial claim with one visible terminal action. */
export const completeInitialTicketProcessingWithFailure = internalMutation({
  args: {
    ticketId: v.id("tickets"),
    expectedAiInputVersion: v.number(),
    initialProcessingGeneration: v.number(),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    const ticket = await ctx.db.get(args.ticketId);
    if (
      !ticket ||
      ticket.githubInitialProcessingPending !== true ||
      ticket.githubInitialProcessingGeneration !==
        args.initialProcessingGeneration ||
      ticket.githubInitialProcessingAiInputVersion !==
        args.expectedAiInputVersion ||
      ticket.aiInputVersion !== args.expectedAiInputVersion
    ) {
      return null;
    }
    const now = Date.now();
    const actionId = await ctx.db.insert("ticketActions", {
      ticketId: ticket._id,
      actionType: "answer",
      chatHistory: [
        {
          role: "assistant" as const,
          content: args.errorMessage,
          timestamp: now,
        },
      ],
      proposedChanges: { suggestedResponse: args.errorMessage },
      proposalVersion: 1,
      status: "failed",
      errorMessage: args.errorMessage,
      createdAt: now,
      completedAt: now,
    });
    if (ticket.githubInitialProcessingScheduleId) {
      const scheduled = await ctx.db.system.get(
        ticket.githubInitialProcessingScheduleId,
      );
      if (scheduled?.state.kind === "pending") {
        await ctx.scheduler.cancel(ticket.githubInitialProcessingScheduleId);
      }
    }
    await ctx.db.patch(ticket._id, {
      githubInitialProcessingPending: undefined,
      githubInitialProcessingGeneration: undefined,
      githubInitialProcessingAiInputVersion: undefined,
      githubInitialProcessingExpiresAt: undefined,
      githubInitialProcessingLeaseUntil: undefined,
      githubInitialProcessingScheduleId: undefined,
    });
    return actionId;
  },
});

/** Persist readiness continuation scheduling in the same transaction. */
export const scheduleInitialTicketProcessingContinuation = internalMutation({
  args: {
    ticketId: v.id("tickets"),
    repositoryId: v.id("repositories"),
    expectedAiInputVersion: v.number(),
    initialProcessingGeneration: v.number(),
    expectedIndexVersion: v.number(),
    processingStage: v.union(v.literal("start"), v.literal("answer")),
    delayMs: v.number(),
    readinessRetryAttempt: v.number(),
    readinessStartedAt: v.number(),
    readinessProgressAt: v.number(),
    readinessProgressKey: v.string(),
  },
  handler: async (ctx, args) => {
    const [ticket, repository] = await Promise.all([
      ctx.db.get(args.ticketId),
      ctx.db.get(args.repositoryId),
    ]);
    if (
      !ticket ||
      !repository ||
      ticket.repositoryId !== repository._id ||
      ticket.status !== "open" ||
      ticket.githubInitialProcessingPending !== true ||
      ticket.githubStateAttestationPending === true ||
      ticket.githubInitialProcessingGeneration !==
        args.initialProcessingGeneration ||
      ticket.githubInitialProcessingAiInputVersion !==
        args.expectedAiInputVersion ||
      ticket.aiInputVersion !== args.expectedAiInputVersion
    ) {
      return false;
    }
    await scheduleNewTicketProcessing(ctx, {
      repository,
      ticketId: ticket._id,
      title: ticket.githubTitle,
      body: ticket.githubBody,
      label: `${ticket.ticketType} #${ticket.githubNumber}`,
      delayMs: Math.max(0, args.delayMs),
      processingStage: args.processingStage,
      expectedIndexVersion: args.expectedIndexVersion,
      readinessRetryAttempt: args.readinessRetryAttempt,
      readinessStartedAt: args.readinessStartedAt,
      readinessProgressAt: args.readinessProgressAt,
      readinessProgressKey: args.readinessProgressKey,
      initialProcessingGeneration: args.initialProcessingGeneration,
    });
    return true;
  },
});

/** Recover an open ticket when its initial scheduler worker disappeared. */
export const recoverInitialTicketProcessing = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const expired = await ctx.db
      .query("tickets")
      .withIndex("by_initial_processing_expiration", (q) =>
        q
          .eq("githubInitialProcessingPending", true)
          .gt("githubInitialProcessingExpiresAt", 0)
          .lte("githubInitialProcessingExpiresAt", now),
      )
      .take(INITIAL_TICKET_PROCESSING_RECOVERY_LIMIT);
    let failed = 0;
    for (const ticket of expired) {
      if (
        ticket.status !== "open" ||
        ticket.githubLifecycleOnly === true ||
        ticket.deletedAt !== undefined
      ) {
        await ctx.db.patch(ticket._id, {
          githubInitialProcessingExpiresAt: undefined,
          githubInitialProcessingLeaseUntil: undefined,
          githubInitialProcessingScheduleId: undefined,
        });
        continue;
      }
      const recent = await ctx.db
        .query("ticketActions")
        .withIndex("by_ticket", (q) => q.eq("ticketId", ticket._id))
        .order("desc")
        .take(20);
      const errorMessage =
        "Initial ticket processing expired before an AI action was created";
      if (
        !recent.some(
          (action) =>
            action.status === "failed" && action.errorMessage === errorMessage,
        )
      ) {
        await ctx.db.insert("ticketActions", {
          ticketId: ticket._id,
          actionType: "answer",
          chatHistory: [],
          proposalVersion: 0,
          status: "failed",
          errorMessage,
          createdAt: now,
          completedAt: now,
        });
      }
      await ctx.db.patch(ticket._id, {
        githubInitialProcessingPending: undefined,
        githubInitialProcessingGeneration: undefined,
        githubInitialProcessingAiInputVersion: undefined,
        githubInitialProcessingExpiresAt: undefined,
        githubInitialProcessingLeaseUntil: undefined,
        githubInitialProcessingScheduleId: undefined,
      });
      failed += 1;
    }

    const due = await ctx.db
      .query("tickets")
      .withIndex("by_initial_processing_lease", (q) =>
        q
          .eq("githubInitialProcessingPending", true)
          .gt("githubInitialProcessingLeaseUntil", 0)
          .lte("githubInitialProcessingLeaseUntil", now),
      )
      .take(INITIAL_TICKET_PROCESSING_RECOVERY_LIMIT);
    let scheduled = 0;
    for (const ticket of due) {
      if (
        ticket.status !== "open" ||
        ticket.githubLifecycleOnly === true ||
        ticket.deletedAt !== undefined ||
        !ticket.repositoryId
      ) {
        await ctx.db.patch(ticket._id, {
          githubInitialProcessingExpiresAt: undefined,
          githubInitialProcessingLeaseUntil: undefined,
          githubInitialProcessingScheduleId: undefined,
        });
        continue;
      }
      if (ticket.githubInitialProcessingScheduleId) {
        const tracked = await ctx.db.system.get(
          ticket.githubInitialProcessingScheduleId,
        );
        if (
          tracked?.state.kind === "pending" ||
          tracked?.state.kind === "inProgress"
        ) {
          continue;
        }
      }
      const repository = await ctx.db.get(ticket.repositoryId);
      if (!repository) {
        await ctx.db.patch(ticket._id, {
          githubInitialProcessingPending: undefined,
          githubInitialProcessingGeneration: undefined,
          githubInitialProcessingAiInputVersion: undefined,
          githubInitialProcessingExpiresAt: undefined,
          githubInitialProcessingLeaseUntil: undefined,
          githubInitialProcessingScheduleId: undefined,
        });
        continue;
      }
      await scheduleNewTicketProcessing(ctx, {
        repository,
        ticketId: ticket._id,
        title: ticket.githubTitle,
        body: ticket.githubBody,
        label: `${ticket.ticketType} #${ticket.githubNumber}`,
        initialProcessingGeneration: ticket.githubInitialProcessingGeneration,
      });
      scheduled += 1;
    }
    return { failed, scheduled };
  },
});

async function retireTicketActionsForNewInput(
  ctx: MutationCtx,
  ticketId: Id<"tickets">,
  reason = "Superseded by newer ticket content",
): Promise<boolean> {
  const actions = await ctx.db
    .query("ticketActions")
    .withIndex("by_ticket", (q) => q.eq("ticketId", ticketId))
    .order("desc")
    .take(100);
  const now = Date.now();
  let retired = false;
  for (const action of actions) {
    if (
      (action.status !== "pending" &&
        action.status !== "pending_approval" &&
        action.status !== "approved") ||
      action.executionClaimedAt !== undefined ||
      action.executionResult !== undefined
    ) {
      continue;
    }
    for (const scheduleId of [
      action.resultRecoveryScheduleId,
      action.pendingGenerationScheduleId,
      action.autoExecutionRecoveryScheduleId,
      action.executionRecoveryScheduleId,
    ]) {
      if (!scheduleId) continue;
      const scheduled = await ctx.db.system.get(scheduleId);
      if (scheduled?.state.kind === "pending") {
        await ctx.scheduler.cancel(scheduleId);
      }
    }
    await ctx.db.patch(action._id, {
      status: "failed",
      errorMessage: reason,
      completedAt: now,
      resultCheckpointKey: undefined,
      resultCheckpointExpiresAt: undefined,
      resultRecoveryLeaseUntil: undefined,
      resultRecoveryScheduleId: undefined,
      pendingGenerationTarget: undefined,
      pendingGenerationExpiresAt: undefined,
      pendingGenerationScheduleId: undefined,
      pendingGenerationLeaseUntil: undefined,
      providerRetryStartedAt: undefined,
      autoExecutionRecoveryExpiresAt: undefined,
      autoExecutionRecoveryLeaseUntil: undefined,
      autoExecutionRecoveryScheduleId: undefined,
      executionIdempotencyKey: undefined,
      executionRecoveryMode: undefined,
      executionRecoveryReconcileOnly: undefined,
      executionRecoveryReconcileDeadlineAt: undefined,
      executionRecoveryExpiresAt: undefined,
      executionRecoveryLeaseUntil: undefined,
      executionRecoveryScheduleId: undefined,
    });
    retired = true;
  }
  return retired;
}

/**
 * Create a ticket from a GitHub issue (triggered by webhook)
 */
export const createFromGithubIssue = internalMutation({
  args: {
    installationId: v.number(),
    githubRepositoryId: v.number(),
    repositoryFullName: v.string(),
    issueNumber: v.number(),
    issueTitle: v.string(),
    issueBody: v.optional(v.string()),
    issueUrl: v.string(),
    issueAuthor: v.optional(v.string()),
    action: v.string(),
    trustedExecutionKey: v.optional(v.string()),
    githubState: v.optional(v.union(v.literal("open"), v.literal("closed"))),
    githubStateUpdatedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    console.log("Creating or updating a GitHub issue ticket", {
      githubRepositoryId: args.githubRepositoryId,
      issueNumber: args.issueNumber,
      action: args.action,
    });

    const repository = await findRepositoryForWebhook(
      ctx,
      args.installationId,
      args.githubRepositoryId,
    );

    if (!repository) {
      return null;
    }
    if (isValidGitHubStateRevision(args.githubStateUpdatedAt)) {
      await supersedePendingTicketStateAttestation(ctx, {
        installationId: args.installationId,
        githubRepositoryId: args.githubRepositoryId,
        repositoryFullName: args.repositoryFullName,
        githubNumber: args.issueNumber,
        ticketType: "issue",
      });
    }

    // Check if Issue Assistant is enabled
    if (
      !repository.settings.issueAssistantEnabled &&
      !args.trustedExecutionKey
    ) {
      console.log("Issue Assistant disabled for repository:", repository._id);
      return null;
    }

    // Find existing ticket using composite index
    // Note: issue and discussion can have the same number, so filter by ticketType
    const existingTickets = await ctx.db
      .query("tickets")
      .withIndex("by_github_number", (q) =>
        q
          .eq("repositoryId", repository._id)
          .eq("githubNumber", args.issueNumber),
      )
      .take(3);

    const existing = existingTickets.find((t) => t.ticketType === "issue");

    const desiredStatus =
      args.githubState ?? (args.action === "opened" ? "open" : undefined);

    if (existing) {
      if (
        args.trustedExecutionKey !== undefined &&
        isValidGitHubStateRevision(args.githubStateUpdatedAt) &&
        existing.githubStateUpdatedAt !== undefined &&
        args.githubStateUpdatedAt! < existing.githubStateUpdatedAt
      ) {
        console.log("Ignored stale issue content webhook");
        return existing._id;
      }
      if (args.trustedExecutionKey) {
        if (desiredStatus !== undefined) {
          await applyMonotonicGitHubTicketState(
            ctx,
            existing,
            desiredStatus,
            args.githubStateUpdatedAt,
            undefined,
          );
        }
        const applied = await applyTrustedFormatExecutionEdit(ctx, {
          ticket: existing,
          executionKey: args.trustedExecutionKey,
          title: args.issueTitle,
          body: args.issueBody,
          author: args.issueAuthor,
          githubRepo: repository.githubRepo,
        });
        if (applied) {
          console.log("Applied trusted Gitdog issue formatting edit");
          return existing._id;
        }
        console.warn("Ignored unrecognized Gitdog issue formatting marker");
        return existing._id;
      }
      const wasLifecycleOnly = existing.githubLifecycleOnly === true;
      const contentChanged =
        existing.githubTitle !== args.issueTitle ||
        (existing.githubBody ?? "") !== (args.issueBody ?? "");
      let resultingStatus = existing.status;
      let stateNeedsAttestation = false;
      if (desiredStatus !== undefined) {
        const lifecycleResult = await applyMonotonicGitHubTicketState(
          ctx,
          existing,
          desiredStatus,
          args.githubStateUpdatedAt,
          undefined,
        );
        if (lifecycleResult === "applied") {
          resultingStatus = desiredStatus;
        } else if (lifecycleResult === "attest") {
          stateNeedsAttestation = true;
          await scheduleTicketStateAttestation(ctx, {
            installationId: args.installationId,
            githubRepositoryId: args.githubRepositoryId,
            repositoryFullName: args.repositoryFullName,
            githubNumber: args.issueNumber,
            ticketType: "issue",
            resumeInitialProcessing: wasLifecycleOnly || contentChanged,
          });
        }
      } else if (args.action === "edited") {
        stateNeedsAttestation = true;
        await scheduleTicketStateAttestation(ctx, {
          installationId: args.installationId,
          githubRepositoryId: args.githubRepositoryId,
          repositoryFullName: args.repositoryFullName,
          githubNumber: args.issueNumber,
          ticketType: "issue",
          resumeInitialProcessing: wasLifecycleOnly || contentChanged,
        });
      }

      const initialProcessingPending =
        existing.githubInitialProcessingPending === true ||
        wasLifecycleOnly ||
        contentChanged;
      if (contentChanged) {
        await retireTicketActionsForNewInput(ctx, existing._id);
      }
      await ctx.db.patch(existing._id, {
        githubRepo: repository.githubRepo,
        githubTitle: args.issueTitle,
        githubBody: args.issueBody,
        githubAuthor: args.issueAuthor,
        aiInputVersion: contentChanged
          ? existing.aiInputVersion + 1
          : existing.aiInputVersion,
        ...(wasLifecycleOnly
          ? { githubLifecycleOnly: undefined, deletedAt: undefined }
          : {}),
        ...(initialProcessingPending &&
        (resultingStatus !== "open" || stateNeedsAttestation)
          ? { githubInitialProcessingPending: true }
          : {}),
      });
      if (
        initialProcessingPending &&
        resultingStatus === "open" &&
        !stateNeedsAttestation
      ) {
        await scheduleNewTicketProcessing(ctx, {
          repository,
          ticketId: existing._id,
          title: args.issueTitle,
          body: args.issueBody,
          label: `issue #${args.issueNumber}`,
        });
      }
      console.log("Updated existing ticket:", existing._id);
      return existing._id;
    }

    if (args.trustedExecutionKey) {
      console.warn("Ignored Gitdog formatting edit without an existing issue");
      return null;
    }

    if (
      args.action === "edited" &&
      (desiredStatus === undefined ||
        !isValidGitHubStateRevision(args.githubStateUpdatedAt))
    ) {
      await scheduleTicketStateAttestation(ctx, {
        installationId: args.installationId,
        githubRepositoryId: args.githubRepositoryId,
        repositoryFullName: args.repositoryFullName,
        githubNumber: args.issueNumber,
        ticketType: "issue",
      });
      return null;
    }

    // Create new ticket
    const now = Date.now();
    const initialStatus = desiredStatus ?? "open";
    const ticketId = await ctx.db.insert("tickets", {
      repositoryId: repository._id,
      userId: repository.userId,
      githubRepo: repository.githubRepo,
      ticketType: "issue",
      githubNumber: args.issueNumber,
      githubTitle: args.issueTitle,
      githubBody: args.issueBody,
      githubAuthor: args.issueAuthor,
      aiInputVersion: 1,
      status: initialStatus,
      githubStateUpdatedAt: args.githubStateUpdatedAt,
      githubInitialProcessingPending:
        initialStatus === "closed" ? true : undefined,
      createdAt: now,
      closedAt: initialStatus === "closed" ? now : undefined,
    });

    console.log("Created new ticket:", ticketId);
    if (initialStatus === "open") {
      await scheduleNewTicketProcessing(ctx, {
        repository,
        ticketId,
        title: args.issueTitle,
        body: args.issueBody,
        label: `issue #${args.issueNumber}`,
      });
    }
    return ticketId;
  },
});

/**
 * Close a ticket by GitHub number (triggered by webhook)
 */
async function applyMonotonicGitHubTicketState(
  ctx: MutationCtx,
  ticket: Doc<"tickets">,
  desiredStatus: "open" | "closed",
  githubStateUpdatedAt: number | undefined,
  githubStateAttestedAt: number | undefined,
): Promise<"applied" | "ignored" | "attest"> {
  if (
    githubStateUpdatedAt === undefined ||
    !Number.isSafeInteger(githubStateUpdatedAt) ||
    githubStateUpdatedAt <= 0
  ) {
    return "attest";
  }
  const attestedAt =
    githubStateAttestedAt !== undefined &&
    Number.isSafeInteger(githubStateAttestedAt) &&
    githubStateAttestedAt > 0
      ? githubStateAttestedAt
      : undefined;
  const storedRevision = ticket.githubStateUpdatedAt;
  if (storedRevision !== undefined && githubStateUpdatedAt < storedRevision) {
    return "ignored";
  }
  if (storedRevision === githubStateUpdatedAt) {
    if (ticket.status === desiredStatus) {
      if (
        attestedAt !== undefined &&
        attestedAt > (ticket.githubStateAttestedAt ?? 0)
      ) {
        await ctx.db.patch(ticket._id, {
          githubStateAttestedAt: attestedAt,
        });
      }
      return "ignored";
    }
    if (attestedAt === undefined) {
      return "attest";
    }
    if (attestedAt <= (ticket.githubStateAttestedAt ?? 0)) {
      return "ignored";
    }
  }

  await ctx.db.patch(ticket._id, {
    status: desiredStatus,
    closedAt:
      desiredStatus === "closed" ? (ticket.closedAt ?? Date.now()) : undefined,
    githubStateUpdatedAt,
    githubStateAttestedAt: attestedAt,
  });
  return "applied";
}

async function scheduleTicketStateAttestation(
  ctx: MutationCtx,
  args: {
    installationId: number;
    githubRepositoryId: number;
    repositoryFullName: string;
    githubNumber: number;
    ticketType: "issue" | "discussion";
    resumeInitialProcessing?: boolean;
  },
): Promise<void> {
  const existing = await ctx.db
    .query("ticketStateAttestationJobs")
    .withIndex("by_target", (q) =>
      q
        .eq("installationId", args.installationId)
        .eq("githubRepositoryId", args.githubRepositoryId)
        .eq("ticketType", args.ticketType)
        .eq("githubNumber", args.githubNumber),
    )
    .unique();
  let shouldResumeInitialProcessing =
    existing?.resumeInitialProcessing === true ||
    args.resumeInitialProcessing === true;
  const repository = await findRepositoryForWebhook(
    ctx,
    args.installationId,
    args.githubRepositoryId,
  );
  if (repository) {
    const candidates = await ctx.db
      .query("tickets")
      .withIndex("by_github_number", (q) =>
        q
          .eq("repositoryId", repository._id)
          .eq("githubNumber", args.githubNumber),
      )
      .take(3);
    const ticket = candidates.find(
      (candidate) => candidate.ticketType === args.ticketType,
    );
    if (ticket) {
      if (ticket.githubInitialProcessingScheduleId) {
        const scheduled = await ctx.db.system.get(
          ticket.githubInitialProcessingScheduleId,
        );
        if (scheduled?.state.kind === "pending") {
          await ctx.scheduler.cancel(ticket.githubInitialProcessingScheduleId);
        }
      }
      const retiredAction = await retireTicketActionsForNewInput(
        ctx,
        ticket._id,
        "Paused for authoritative GitHub state attestation",
      );
      shouldResumeInitialProcessing =
        shouldResumeInitialProcessing ||
        ticket.githubInitialProcessingPending === true ||
        ticket.githubLifecycleOnly === true ||
        retiredAction;
      await ctx.db.patch(ticket._id, {
        githubStateAttestationPending: true,
        githubInitialProcessingPending: shouldResumeInitialProcessing
          ? true
          : undefined,
        githubInitialProcessingGeneration:
          (ticket.githubInitialProcessingGeneration ?? 0) + 1,
        githubInitialProcessingAiInputVersion: ticket.aiInputVersion,
        githubInitialProcessingExpiresAt: undefined,
        githubInitialProcessingLeaseUntil: undefined,
        githubInitialProcessingScheduleId: undefined,
      });
    } else {
      shouldResumeInitialProcessing = true;
    }
  } else {
    shouldResumeInitialProcessing = true;
  }
  if (existing?.scheduleId) {
    const scheduled = await ctx.db.system.get(existing.scheduleId);
    if (scheduled?.state.kind === "pending") {
      await ctx.scheduler.cancel(existing.scheduleId);
    }
  }
  const now = Date.now();
  const generation = (existing?.generation ?? 0) + 1;
  const jobId = existing
    ? existing._id
    : await ctx.db.insert("ticketStateAttestationJobs", {
        ...args,
        generation,
        status: "pending",
        retryCount: 0,
        resumeInitialProcessing: shouldResumeInitialProcessing,
        nextAttemptAt: now + TICKET_STATE_ATTESTATION_LEASE_MS,
        expiresAt: now + TICKET_STATE_ATTESTATION_TTL_MS,
        createdAt: now,
        updatedAt: now,
      });
  const scheduleId = await ctx.scheduler.runAfter(
    0,
    internal.github.action.reconcileTicketWebhookState,
    { jobId, expectedGeneration: generation },
  );
  await ctx.db.patch(jobId, {
    ...args,
    generation,
    status: "pending",
    retryCount: 0,
    resumeInitialProcessing: shouldResumeInitialProcessing,
    nextAttemptAt: now + TICKET_STATE_ATTESTATION_LEASE_MS,
    expiresAt: now + TICKET_STATE_ATTESTATION_TTL_MS,
    scheduleId,
    lastError: undefined,
    updatedAt: now,
    completedAt: undefined,
  });
}

async function retireSatisfiedTicketStateAttestation(
  ctx: MutationCtx,
  args: {
    installationId: number;
    githubRepositoryId: number;
    githubNumber: number;
    ticketType: "issue" | "discussion";
  },
): Promise<void> {
  const job = await ctx.db
    .query("ticketStateAttestationJobs")
    .withIndex("by_target", (q) =>
      q
        .eq("installationId", args.installationId)
        .eq("githubRepositoryId", args.githubRepositoryId)
        .eq("ticketType", args.ticketType)
        .eq("githubNumber", args.githubNumber),
    )
    .unique();
  if (!job) return;
  if (job.scheduleId) {
    const scheduled = await ctx.db.system.get(job.scheduleId);
    if (scheduled?.state.kind === "pending") {
      await ctx.scheduler.cancel(job.scheduleId);
    }
  }
  await ctx.db.delete(job._id);
  const repository = await findRepositoryForWebhook(
    ctx,
    args.installationId,
    args.githubRepositoryId,
  );
  if (!repository) return;
  const tickets = await ctx.db
    .query("tickets")
    .withIndex("by_github_number", (q) =>
      q
        .eq("repositoryId", repository._id)
        .eq("githubNumber", args.githubNumber),
    )
    .take(3);
  const ticket = tickets.find(
    (candidate) => candidate.ticketType === args.ticketType,
  );
  if (ticket?.githubStateAttestationPending === true) {
    await ctx.db.patch(ticket._id, {
      githubStateAttestationPending: undefined,
    });
  }
}

async function supersedePendingTicketStateAttestation(
  ctx: MutationCtx,
  args: {
    installationId: number;
    githubRepositoryId: number;
    repositoryFullName: string;
    githubNumber: number;
    ticketType: "issue" | "discussion";
  },
): Promise<boolean> {
  const job = await ctx.db
    .query("ticketStateAttestationJobs")
    .withIndex("by_target", (q) =>
      q
        .eq("installationId", args.installationId)
        .eq("githubRepositoryId", args.githubRepositoryId)
        .eq("ticketType", args.ticketType)
        .eq("githubNumber", args.githubNumber),
    )
    .unique();
  if (job?.status !== "pending") return false;
  await scheduleTicketStateAttestation(ctx, {
    installationId: args.installationId,
    githubRepositoryId: args.githubRepositoryId,
    repositoryFullName: args.repositoryFullName,
    githubNumber: args.githubNumber,
    ticketType: args.ticketType,
    resumeInitialProcessing: job.resumeInitialProcessing,
  });
  return true;
}

export const claimTicketStateAttestation = internalMutation({
  args: {
    jobId: v.id("ticketStateAttestationJobs"),
    expectedGeneration: v.number(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (
      !job ||
      job.status !== "pending" ||
      job.generation !== args.expectedGeneration ||
      job.expiresAt <= Date.now()
    ) {
      return null;
    }
    await ctx.db.patch(job._id, {
      nextAttemptAt: Date.now() + TICKET_STATE_ATTESTATION_LEASE_MS,
      updatedAt: Date.now(),
    });
    return job;
  },
});

export const scheduleTicketStateAttestationRetry = internalMutation({
  args: {
    jobId: v.id("ticketStateAttestationJobs"),
    expectedGeneration: v.number(),
    retryCount: v.number(),
    delayMs: v.number(),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (
      !job ||
      job.status !== "pending" ||
      job.generation !== args.expectedGeneration ||
      job.expiresAt <= Date.now()
    ) {
      return false;
    }
    if (job.scheduleId) {
      const scheduled = await ctx.db.system.get(job.scheduleId);
      if (scheduled?.state.kind === "pending") {
        await ctx.scheduler.cancel(job.scheduleId);
      }
    }
    const now = Date.now();
    const delayMs = Math.max(0, args.delayMs);
    const scheduleId = await ctx.scheduler.runAfter(
      delayMs,
      internal.github.action.reconcileTicketWebhookState,
      { jobId: job._id, expectedGeneration: args.expectedGeneration },
    );
    await ctx.db.patch(job._id, {
      retryCount: Math.max(0, Math.floor(args.retryCount)),
      nextAttemptAt: now + delayMs + TICKET_STATE_ATTESTATION_LEASE_MS,
      scheduleId,
      lastError: args.errorMessage.slice(0, 500),
      updatedAt: now,
    });
    return true;
  },
});

/** CAS the attestation generation and apply the live GitHub snapshot atomically. */
export const applyTicketStateAttestation = internalMutation({
  args: {
    jobId: v.id("ticketStateAttestationJobs"),
    expectedGeneration: v.number(),
    githubState: v.union(v.literal("open"), v.literal("closed")),
    githubStateUpdatedAt: v.number(),
    githubStateAttestedAt: v.number(),
    githubTitle: v.string(),
    githubBody: v.optional(v.string()),
    githubAuthor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (
      !job ||
      job.status !== "pending" ||
      job.generation !== args.expectedGeneration ||
      job.expiresAt <= Date.now()
    ) {
      return false;
    }
    const repository = await findRepositoryForWebhook(
      ctx,
      job.installationId,
      job.githubRepositoryId,
    );
    if (!repository)
      throw new Error("Repository is unavailable for attestation");

    const candidates = await ctx.db
      .query("tickets")
      .withIndex("by_github_number", (q) =>
        q
          .eq("repositoryId", repository._id)
          .eq("githubNumber", job.githubNumber),
      )
      .take(3);
    const existing = candidates.find(
      (candidate) => candidate.ticketType === job.ticketType,
    );
    let ticketId: Id<"tickets">;
    let resultingStatus = args.githubState;
    let shouldResumeInitialProcessing =
      job.resumeInitialProcessing || existing === undefined;
    if (!existing) {
      const now = Date.now();
      ticketId = await ctx.db.insert("tickets", {
        repositoryId: repository._id,
        userId: repository.userId,
        githubRepo: repository.githubRepo,
        ticketType: job.ticketType,
        githubNumber: job.githubNumber,
        githubTitle: args.githubTitle,
        githubBody: args.githubBody,
        githubAuthor: args.githubAuthor,
        aiInputVersion: 1,
        status: args.githubState,
        githubStateUpdatedAt: args.githubStateUpdatedAt,
        githubStateAttestedAt: args.githubStateAttestedAt,
        githubInitialProcessingPending: true,
        createdAt: now,
        closedAt: args.githubState === "closed" ? now : undefined,
      });
    } else {
      const contentChanged =
        existing.githubTitle !== args.githubTitle ||
        (existing.githubBody ?? "") !== (args.githubBody ?? "");
      shouldResumeInitialProcessing =
        shouldResumeInitialProcessing ||
        contentChanged ||
        existing.githubLifecycleOnly === true;
      if (contentChanged) {
        await retireTicketActionsForNewInput(ctx, existing._id);
      }
      const lifecycleResult = await applyMonotonicGitHubTicketState(
        ctx,
        existing,
        args.githubState,
        args.githubStateUpdatedAt,
        args.githubStateAttestedAt,
      );
      resultingStatus =
        lifecycleResult === "applied" ? args.githubState : existing.status;
      ticketId = existing._id;
      await ctx.db.patch(existing._id, {
        githubRepo: repository.githubRepo,
        githubTitle: args.githubTitle,
        githubBody: args.githubBody,
        githubAuthor: args.githubAuthor,
        aiInputVersion: contentChanged
          ? existing.aiInputVersion + 1
          : existing.aiInputVersion,
        githubLifecycleOnly: undefined,
        deletedAt: undefined,
        githubStateAttestationPending: undefined,
        githubInitialProcessingPending: shouldResumeInitialProcessing
          ? true
          : undefined,
        githubInitialProcessingGeneration: shouldResumeInitialProcessing
          ? existing.githubInitialProcessingGeneration
          : undefined,
        githubInitialProcessingAiInputVersion: shouldResumeInitialProcessing
          ? contentChanged
            ? existing.aiInputVersion + 1
            : existing.aiInputVersion
          : undefined,
        githubInitialProcessingExpiresAt: undefined,
        githubInitialProcessingLeaseUntil: undefined,
        githubInitialProcessingScheduleId: undefined,
      });
    }

    if (job.scheduleId) {
      const scheduled = await ctx.db.system.get(job.scheduleId);
      if (scheduled?.state.kind === "pending") {
        await ctx.scheduler.cancel(job.scheduleId);
      }
    }
    await ctx.db.delete(job._id);
    if (resultingStatus === "open" && shouldResumeInitialProcessing) {
      const ticket = await ctx.db.get(ticketId);
      if (ticket) {
        await ctx.db.patch(ticketId, {
          githubStateAttestationPending: undefined,
        });
        await scheduleNewTicketProcessing(ctx, {
          repository,
          ticketId,
          title: args.githubTitle,
          body: args.githubBody,
          label: `${job.ticketType} #${job.githubNumber}`,
        });
      }
    }
    return true;
  },
});

export const recoverTicketStateAttestations = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const expired = await ctx.db
      .query("ticketStateAttestationJobs")
      .withIndex("by_status_and_expiration", (q) =>
        q.eq("status", "pending").gt("expiresAt", 0).lte("expiresAt", now),
      )
      .take(TICKET_STATE_ATTESTATION_RECOVERY_LIMIT);
    let restarted = 0;
    for (const job of expired) {
      if (job.scheduleId) {
        const scheduled = await ctx.db.system.get(job.scheduleId);
        if (scheduled?.state.kind === "pending") {
          await ctx.scheduler.cancel(job.scheduleId);
        }
      }
      const generation = job.generation + 1;
      const scheduleId = await ctx.scheduler.runAfter(
        0,
        internal.github.action.reconcileTicketWebhookState,
        { jobId: job._id, expectedGeneration: generation },
      );
      await ctx.db.patch(job._id, {
        generation,
        retryCount: 0,
        nextAttemptAt: now + TICKET_STATE_ATTESTATION_LEASE_MS,
        expiresAt: now + TICKET_STATE_ATTESTATION_TTL_MS,
        scheduleId,
        lastError: "Attestation generation expired and was restarted",
        updatedAt: now,
      });
      restarted += 1;
    }

    const due = await ctx.db
      .query("ticketStateAttestationJobs")
      .withIndex("by_status_and_next_attempt", (q) =>
        q
          .eq("status", "pending")
          .gt("nextAttemptAt", 0)
          .lte("nextAttemptAt", now),
      )
      .take(TICKET_STATE_ATTESTATION_RECOVERY_LIMIT);
    let scheduled = 0;
    for (const job of due) {
      if (job.expiresAt <= now) continue;
      if (job.scheduleId) {
        const tracked = await ctx.db.system.get(job.scheduleId);
        if (
          tracked?.state.kind === "pending" ||
          tracked?.state.kind === "inProgress"
        ) {
          continue;
        }
      }
      const scheduleId = await ctx.scheduler.runAfter(
        0,
        internal.github.action.reconcileTicketWebhookState,
        { jobId: job._id, expectedGeneration: job.generation },
      );
      await ctx.db.patch(job._id, {
        scheduleId,
        nextAttemptAt: now + TICKET_STATE_ATTESTATION_LEASE_MS,
        updatedAt: now,
      });
      scheduled += 1;
    }
    return { restarted, scheduled };
  },
});

function isValidGitHubStateRevision(
  value: number | undefined,
): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

async function createLifecycleOnlyTicket(
  ctx: MutationCtx,
  args: {
    repository: Doc<"repositories">;
    githubNumber: number;
    ticketType: "issue" | "discussion";
    desiredStatus: "open" | "closed";
    githubStateUpdatedAt: number;
    githubStateAttestedAt?: number;
  },
): Promise<Id<"tickets">> {
  const now = Date.now();
  const githubStateAttestedAt = isValidGitHubStateRevision(
    args.githubStateAttestedAt,
  )
    ? args.githubStateAttestedAt
    : undefined;
  return await ctx.db.insert("tickets", {
    repositoryId: args.repository._id,
    userId: args.repository.userId,
    githubRepo: args.repository.githubRepo,
    ticketType: args.ticketType,
    githubNumber: args.githubNumber,
    githubTitle: "",
    aiInputVersion: 1,
    status: args.desiredStatus,
    githubStateUpdatedAt: args.githubStateUpdatedAt,
    githubStateAttestedAt,
    githubLifecycleOnly: true,
    githubInitialProcessingPending: true,
    createdAt: now,
    closedAt: args.desiredStatus === "closed" ? now : undefined,
    deletedAt: now,
  });
}

export const closeByGithubNumber = internalMutation({
  args: {
    installationId: v.number(),
    githubRepositoryId: v.number(),
    repositoryFullName: v.string(),
    githubNumber: v.number(),
    ticketType: v.union(v.literal("issue"), v.literal("discussion")),
    githubStateUpdatedAt: v.optional(v.number()),
    githubStateAttestedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    console.log(`Closing ${args.ticketType} ticket from GitHub`, {
      githubRepositoryId: args.githubRepositoryId,
      githubNumber: args.githubNumber,
    });

    const repository = await findRepositoryForWebhook(
      ctx,
      args.installationId,
      args.githubRepositoryId,
    );

    if (!repository) {
      return null;
    }
    if (isValidGitHubStateRevision(args.githubStateUpdatedAt)) {
      await supersedePendingTicketStateAttestation(ctx, args);
    }
    if (isValidGitHubStateRevision(args.githubStateAttestedAt)) {
      await retireSatisfiedTicketStateAttestation(ctx, args);
    }

    // Issue and discussion numbers share a namespace only within their own type.
    const tickets = await ctx.db
      .query("tickets")
      .withIndex("by_github_number", (q) =>
        q
          .eq("repositoryId", repository._id)
          .eq("githubNumber", args.githubNumber),
      )
      .take(3);

    const ticket = tickets.find(
      (candidate) => candidate.ticketType === args.ticketType,
    );

    if (!ticket) {
      if (!isValidGitHubStateRevision(args.githubStateUpdatedAt)) {
        await scheduleTicketStateAttestation(ctx, {
          installationId: args.installationId,
          githubRepositoryId: args.githubRepositoryId,
          repositoryFullName: args.repositoryFullName,
          githubNumber: args.githubNumber,
          ticketType: args.ticketType,
        });
        return null;
      }
      return await createLifecycleOnlyTicket(ctx, {
        repository,
        githubNumber: args.githubNumber,
        ticketType: args.ticketType,
        desiredStatus: "closed",
        githubStateUpdatedAt: args.githubStateUpdatedAt,
        githubStateAttestedAt: args.githubStateAttestedAt,
      });
    }

    const result = await applyMonotonicGitHubTicketState(
      ctx,
      ticket,
      "closed",
      args.githubStateUpdatedAt,
      args.githubStateAttestedAt,
    );
    if (result === "attest") {
      await scheduleTicketStateAttestation(ctx, {
        installationId: args.installationId,
        githubRepositoryId: args.githubRepositoryId,
        repositoryFullName: args.repositoryFullName,
        githubNumber: args.githubNumber,
        ticketType: args.ticketType,
      });
      return ticket._id;
    }

    console.log(
      result === "applied" ? "Closed ticket:" : "Ignored stale close:",
      ticket._id,
    );
    return ticket._id;
  },
});

/**
 * Reopen a ticket by GitHub number (triggered by webhook).
 * Issue and discussion numbers may overlap, so ticketType is mandatory.
 */
export const reopenByGithubNumber = internalMutation({
  args: {
    installationId: v.number(),
    githubRepositoryId: v.number(),
    repositoryFullName: v.string(),
    githubNumber: v.number(),
    ticketType: v.union(v.literal("issue"), v.literal("discussion")),
    githubStateUpdatedAt: v.optional(v.number()),
    githubStateAttestedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    console.log(`Reopening ${args.ticketType} ticket from GitHub`, {
      githubRepositoryId: args.githubRepositoryId,
      githubNumber: args.githubNumber,
    });

    const repository = await findRepositoryForWebhook(
      ctx,
      args.installationId,
      args.githubRepositoryId,
    );

    if (!repository) {
      return null;
    }
    if (isValidGitHubStateRevision(args.githubStateUpdatedAt)) {
      await supersedePendingTicketStateAttestation(ctx, args);
    }
    if (isValidGitHubStateRevision(args.githubStateAttestedAt)) {
      await retireSatisfiedTicketStateAttestation(ctx, args);
    }

    const tickets = await ctx.db
      .query("tickets")
      .withIndex("by_github_number", (q) =>
        q
          .eq("repositoryId", repository._id)
          .eq("githubNumber", args.githubNumber),
      )
      .take(3);

    const ticket = tickets.find(
      (candidate) => candidate.ticketType === args.ticketType,
    );

    if (!ticket) {
      if (!isValidGitHubStateRevision(args.githubStateUpdatedAt)) {
        await scheduleTicketStateAttestation(ctx, {
          installationId: args.installationId,
          githubRepositoryId: args.githubRepositoryId,
          repositoryFullName: args.repositoryFullName,
          githubNumber: args.githubNumber,
          ticketType: args.ticketType,
        });
        return null;
      }
      return await createLifecycleOnlyTicket(ctx, {
        repository,
        githubNumber: args.githubNumber,
        ticketType: args.ticketType,
        desiredStatus: "open",
        githubStateUpdatedAt: args.githubStateUpdatedAt,
        githubStateAttestedAt: args.githubStateAttestedAt,
      });
    }

    const result = await applyMonotonicGitHubTicketState(
      ctx,
      ticket,
      "open",
      args.githubStateUpdatedAt,
      args.githubStateAttestedAt,
    );
    if (result === "attest") {
      await scheduleTicketStateAttestation(ctx, {
        installationId: args.installationId,
        githubRepositoryId: args.githubRepositoryId,
        repositoryFullName: args.repositoryFullName,
        githubNumber: args.githubNumber,
        ticketType: args.ticketType,
      });
      return ticket._id;
    }

    const resultingStatus = result === "applied" ? "open" : ticket.status;
    if (
      resultingStatus === "open" &&
      ticket.githubInitialProcessingPending === true &&
      ticket.githubLifecycleOnly !== true &&
      ticket.deletedAt === undefined
    ) {
      await scheduleNewTicketProcessing(ctx, {
        repository,
        ticketId: ticket._id,
        title: ticket.githubTitle,
        body: ticket.githubBody,
        label: `${args.ticketType} #${args.githubNumber}`,
      });
    }

    console.log(
      result === "applied" ? "Reopened ticket:" : "Ignored stale reopen:",
      ticket._id,
    );
    return ticket._id;
  },
});

/**
 * Create a ticket from a GitHub discussion (triggered by webhook)
 */
export const createFromGithubDiscussion = internalMutation({
  args: {
    installationId: v.number(),
    githubRepositoryId: v.number(),
    repositoryFullName: v.string(),
    discussionNumber: v.number(),
    discussionTitle: v.string(),
    discussionBody: v.optional(v.string()),
    discussionUrl: v.string(),
    discussionAuthor: v.optional(v.string()),
    action: v.string(),
    trustedExecutionKey: v.optional(v.string()),
    githubState: v.optional(v.union(v.literal("open"), v.literal("closed"))),
    githubStateUpdatedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    console.log("Creating or updating a GitHub discussion ticket", {
      githubRepositoryId: args.githubRepositoryId,
      discussionNumber: args.discussionNumber,
      action: args.action,
    });

    const repository = await findRepositoryForWebhook(
      ctx,
      args.installationId,
      args.githubRepositoryId,
    );

    if (!repository) {
      return null;
    }
    if (isValidGitHubStateRevision(args.githubStateUpdatedAt)) {
      await supersedePendingTicketStateAttestation(ctx, {
        installationId: args.installationId,
        githubRepositoryId: args.githubRepositoryId,
        repositoryFullName: args.repositoryFullName,
        githubNumber: args.discussionNumber,
        ticketType: "discussion",
      });
    }

    // Check if Discussion Assistant is enabled
    if (
      !repository.settings.discussionAssistantEnabled &&
      !args.trustedExecutionKey
    ) {
      console.log(
        "Discussion Assistant disabled for repository:",
        repository._id,
      );
      return null;
    }

    // Find existing ticket using composite index
    // Note: we check ticketType after query since discussion number can overlap with issue number
    const existingTickets = await ctx.db
      .query("tickets")
      .withIndex("by_github_number", (q) =>
        q
          .eq("repositoryId", repository._id)
          .eq("githubNumber", args.discussionNumber),
      )
      .take(3);

    const existing = existingTickets.find((t) => t.ticketType === "discussion");

    const desiredStatus =
      args.githubState ?? (args.action === "created" ? "open" : undefined);

    if (existing) {
      if (
        args.trustedExecutionKey !== undefined &&
        isValidGitHubStateRevision(args.githubStateUpdatedAt) &&
        existing.githubStateUpdatedAt !== undefined &&
        args.githubStateUpdatedAt! < existing.githubStateUpdatedAt
      ) {
        console.log("Ignored stale discussion content webhook");
        return existing._id;
      }
      if (args.trustedExecutionKey) {
        if (desiredStatus !== undefined) {
          await applyMonotonicGitHubTicketState(
            ctx,
            existing,
            desiredStatus,
            args.githubStateUpdatedAt,
            undefined,
          );
        }
        const applied = await applyTrustedFormatExecutionEdit(ctx, {
          ticket: existing,
          executionKey: args.trustedExecutionKey,
          title: args.discussionTitle,
          body: args.discussionBody,
          author: args.discussionAuthor,
          githubRepo: repository.githubRepo,
        });
        if (applied) {
          console.log("Applied trusted Gitdog discussion formatting edit");
          return existing._id;
        }
        console.warn(
          "Ignored unrecognized Gitdog discussion formatting marker",
        );
        return existing._id;
      }
      const wasLifecycleOnly = existing.githubLifecycleOnly === true;
      const contentChanged =
        existing.githubTitle !== args.discussionTitle ||
        (existing.githubBody ?? "") !== (args.discussionBody ?? "");
      let resultingStatus = existing.status;
      let stateNeedsAttestation = false;
      if (desiredStatus !== undefined) {
        const lifecycleResult = await applyMonotonicGitHubTicketState(
          ctx,
          existing,
          desiredStatus,
          args.githubStateUpdatedAt,
          undefined,
        );
        if (lifecycleResult === "applied") {
          resultingStatus = desiredStatus;
        } else if (lifecycleResult === "attest") {
          stateNeedsAttestation = true;
          await scheduleTicketStateAttestation(ctx, {
            installationId: args.installationId,
            githubRepositoryId: args.githubRepositoryId,
            repositoryFullName: args.repositoryFullName,
            githubNumber: args.discussionNumber,
            ticketType: "discussion",
            resumeInitialProcessing: wasLifecycleOnly || contentChanged,
          });
        }
      } else if (args.action === "edited") {
        stateNeedsAttestation = true;
        await scheduleTicketStateAttestation(ctx, {
          installationId: args.installationId,
          githubRepositoryId: args.githubRepositoryId,
          repositoryFullName: args.repositoryFullName,
          githubNumber: args.discussionNumber,
          ticketType: "discussion",
          resumeInitialProcessing: wasLifecycleOnly || contentChanged,
        });
      }

      const initialProcessingPending =
        existing.githubInitialProcessingPending === true ||
        wasLifecycleOnly ||
        contentChanged;
      if (contentChanged) {
        await retireTicketActionsForNewInput(ctx, existing._id);
      }
      await ctx.db.patch(existing._id, {
        githubRepo: repository.githubRepo,
        githubTitle: args.discussionTitle,
        githubBody: args.discussionBody,
        githubAuthor: args.discussionAuthor,
        aiInputVersion: contentChanged
          ? existing.aiInputVersion + 1
          : existing.aiInputVersion,
        ...(wasLifecycleOnly
          ? { githubLifecycleOnly: undefined, deletedAt: undefined }
          : {}),
        ...(initialProcessingPending &&
        (resultingStatus !== "open" || stateNeedsAttestation)
          ? { githubInitialProcessingPending: true }
          : {}),
      });
      if (
        initialProcessingPending &&
        resultingStatus === "open" &&
        !stateNeedsAttestation
      ) {
        await scheduleNewTicketProcessing(ctx, {
          repository,
          ticketId: existing._id,
          title: args.discussionTitle,
          body: args.discussionBody,
          label: `discussion #${args.discussionNumber}`,
        });
      }
      console.log("Updated existing ticket:", existing._id);
      return existing._id;
    }

    if (args.trustedExecutionKey) {
      console.warn(
        "Ignored Gitdog formatting edit without an existing discussion",
      );
      return null;
    }

    if (
      args.action === "edited" &&
      (desiredStatus === undefined ||
        !isValidGitHubStateRevision(args.githubStateUpdatedAt))
    ) {
      await scheduleTicketStateAttestation(ctx, {
        installationId: args.installationId,
        githubRepositoryId: args.githubRepositoryId,
        repositoryFullName: args.repositoryFullName,
        githubNumber: args.discussionNumber,
        ticketType: "discussion",
      });
      return null;
    }

    // Create new ticket
    const now = Date.now();
    const initialStatus = desiredStatus ?? "open";
    const ticketId = await ctx.db.insert("tickets", {
      repositoryId: repository._id,
      userId: repository.userId,
      githubRepo: repository.githubRepo,
      ticketType: "discussion",
      githubNumber: args.discussionNumber,
      githubTitle: args.discussionTitle,
      githubBody: args.discussionBody,
      githubAuthor: args.discussionAuthor,
      aiInputVersion: 1,
      status: initialStatus,
      githubStateUpdatedAt: args.githubStateUpdatedAt,
      githubInitialProcessingPending:
        initialStatus === "closed" ? true : undefined,
      createdAt: now,
      closedAt: initialStatus === "closed" ? now : undefined,
    });

    console.log("Created new ticket:", ticketId);
    if (initialStatus === "open") {
      await scheduleNewTicketProcessing(ctx, {
        repository,
        ticketId,
        title: args.discussionTitle,
        body: args.discussionBody,
        label: `discussion #${args.discussionNumber}`,
      });
    }
    return ticketId;
  },
});
