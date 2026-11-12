import { internalMutation, type MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { v } from "convex/values";
import { validateAiResponse } from "../_ai/responseValidation";
import { getRepositoryAiReadiness } from "../repositories/aiReadiness";
import { normalizeGitdogMentionBody } from "../github/helpers";
import {
  getExactGitHubInstallation,
  isGitHubInstallationReady,
} from "../github/installationAccess";
import {
  PENDING_GENERATION_LEASE_MS,
  PENDING_GENERATION_TTL_MS,
  PENDING_GENERATION_WATCHDOG_DELAY_MS,
  chatRecoveryTargetValidator,
  type ChatRecoveryTarget,
} from "../_ai/chatRecovery";
import {
  CLAIMED_EXECUTION_RECOVERY_GRACE_MS,
  CLAIMED_EXECUTION_RECOVERY_LEASE_MS,
  CLAIMED_EXECUTION_RECOVERY_TTL_MS,
  stripExecutionMarkers,
} from "./executionRecovery";

type FollowUpActionCandidate = {
  _id: string;
  actionType: string;
  sourceCommentId?: number;
};

export const AUTO_EXECUTION_RECOVERY_LEASE_MS = 10 * 60 * 1_000;
export const AUTO_EXECUTION_RECOVERY_TTL_MS = 24 * 60 * 60 * 1_000;
const AUTO_EXECUTION_RECOVERY_LIMIT = 50;
const CLAIMED_EXECUTION_RECOVERY_LIMIT = 50;
const MAX_PUBLICATION_REFRESHES = 3;

export function findFollowUpActionByCommentId<
  T extends FollowUpActionCandidate,
>(actions: T[], commentId: number): T | undefined {
  return actions.find(
    (action) =>
      action.actionType === "follow_up" && action.sourceCommentId === commentId,
  );
}

export type PreviousFollowUpComment = {
  id: number | string;
  body: string;
  author: string;
  isGitdogBot: boolean;
  createdAt: string;
};

export function buildFollowUpChatHistory(
  previousComments: PreviousFollowUpComment[] | undefined,
  currentComment: {
    id: number;
    nodeId?: string;
    body: string;
    author: string;
  },
  now: number,
): Array<{
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}> {
  const chatHistory: Array<{
    role: "user" | "assistant";
    content: string;
    timestamp: number;
  }> = [];

  for (const comment of previousComments ?? []) {
    if (
      comment.id === currentComment.id ||
      (currentComment.nodeId !== undefined &&
        comment.id === currentComment.nodeId)
    ) {
      continue;
    }

    chatHistory.push({
      role: comment.isGitdogBot ? "assistant" : "user",
      content: comment.isGitdogBot
        ? stripExecutionMarkers(comment.body)
        : `[${comment.author}]: ${stripExecutionMarkers(comment.body)}`,
      timestamp: new Date(comment.createdAt).getTime(),
    });
  }

  chatHistory.push({
    role: "user",
    content: `[${currentComment.author}]: ${stripExecutionMarkers(currentComment.body)}`,
    timestamp: now,
  });

  return chatHistory;
}

type ActiveTicketWorkflow = {
  ticket: Doc<"tickets">;
  repository: Doc<"repositories">;
};

async function cancelResultRecovery(
  ctx: MutationCtx,
  action: Doc<"ticketActions">,
): Promise<void> {
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
}

function clearedResultRecovery() {
  return {
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
  };
}

async function armClaimedExecutionRecovery(
  ctx: MutationCtx,
  actionId: Id<"ticketActions">,
  expectedClaimedAt: number,
  expectedProposalVersion: number,
  now: number,
  expiresAt = now + CLAIMED_EXECUTION_RECOVERY_TTL_MS,
  delayMs = CLAIMED_EXECUTION_RECOVERY_LEASE_MS,
  retryAttempt = 0,
): Promise<void> {
  const scheduleId = await ctx.scheduler.runAfter(
    delayMs,
    internal.ticketActions.internalAction.reconcileClaimedExecution,
    {
      actionId,
      expectedClaimedAt,
      expectedProposalVersion,
      retryAttempt,
    },
  );
  await ctx.db.patch(actionId, {
    executionRecoveryExpiresAt: expiresAt,
    executionRecoveryLeaseUntil:
      now + delayMs + CLAIMED_EXECUTION_RECOVERY_LEASE_MS,
    executionRecoveryScheduleId: scheduleId,
  });
}

async function armAutoExecutionRecovery(
  ctx: MutationCtx,
  actionId: Id<"ticketActions">,
  now: number,
  expiresAt = now + AUTO_EXECUTION_RECOVERY_TTL_MS,
  delayMs = 0,
  preflightRetryAttempt = 0,
): Promise<void> {
  const scheduleId = await ctx.scheduler.runAfter(
    delayMs,
    internal.tickets.internalAction.executeAutoApprovedAction,
    { actionId, preflightRetryAttempt },
  );
  await ctx.db.patch(actionId, {
    autoExecutionRecoveryExpiresAt: expiresAt,
    autoExecutionRecoveryLeaseUntil:
      now + delayMs + AUTO_EXECUTION_RECOVERY_LEASE_MS,
    autoExecutionRecoveryScheduleId: scheduleId,
  });
}

async function armPendingGeneration(
  ctx: MutationCtx,
  actionId: Id<"ticketActions">,
  target: ChatRecoveryTarget,
  now: number,
): Promise<void> {
  const scheduleId = await ctx.scheduler.runAfter(
    PENDING_GENERATION_WATCHDOG_DELAY_MS,
    internal._ai.chatBilling.resumePendingChatGeneration,
    { ticketActionId: actionId },
  );
  await ctx.db.patch(actionId, {
    pendingGenerationTarget: target,
    pendingGenerationExpiresAt: now + PENDING_GENERATION_TTL_MS,
    pendingGenerationScheduleId: scheduleId,
    pendingGenerationLeaseUntil: now + PENDING_GENERATION_LEASE_MS,
    providerRetryStartedAt: undefined,
  });
}

async function getActiveTicketWorkflow(
  ctx: MutationCtx,
  ticketId: Id<"tickets">,
): Promise<
  | { active: true; workflow: ActiveTicketWorkflow }
  | { active: false; reason: string }
> {
  const ticket = await ctx.db.get(ticketId);
  if (!ticket || ticket.status !== "open") {
    return { active: false, reason: "Ticket is no longer open" };
  }
  if (ticket.githubStateAttestationPending === true) {
    return {
      active: false,
      reason: "Ticket is awaiting authoritative GitHub state attestation",
    };
  }
  if (!ticket.repositoryId) {
    return { active: false, reason: "Ticket has no repository linked" };
  }

  const repository = await ctx.db.get(ticket.repositoryId);
  if (
    !repository ||
    repository.isActive !== true ||
    repository.disconnectCleanupPending === true ||
    repository.githubAccessRevokedAt !== undefined
  ) {
    return {
      active: false,
      reason: "Repository workflow is no longer active",
    };
  }

  const installation = await getExactGitHubInstallation(
    ctx,
    repository.installationId,
  );
  if (
    !isGitHubInstallationReady(installation) ||
    installation.userId !== repository.userId ||
    installation.installationId !== repository.installationId
  ) {
    return {
      active: false,
      reason: "Repository installation access is not active",
    };
  }

  return { active: true, workflow: { ticket, repository } };
}

async function failNonterminalAction(
  ctx: MutationCtx,
  action: Doc<"ticketActions">,
  errorMessage: string,
): Promise<void> {
  if (
    action.status !== "pending" &&
    action.status !== "pending_approval" &&
    action.status !== "approved"
  ) {
    return;
  }
  await cancelResultRecovery(ctx, action);
  await ctx.db.patch(action._id, {
    status: "failed",
    errorMessage,
    completedAt: Date.now(),
    ...clearedResultRecovery(),
  });
}

function proposalMatchesCurrentIndex(
  actionType: Doc<"ticketActions">["actionType"],
  proposedChanges: unknown,
  repository: Doc<"repositories">,
): boolean {
  if (actionType !== "answer" && actionType !== "follow_up") return true;
  if (!isRecord(proposedChanges)) return false;
  return proposedChanges.groundedIndexVersion === repository.indexVersion;
}

function proposalMatchesCurrentTicket(
  actionType: Doc<"ticketActions">["actionType"],
  proposedChanges: unknown,
  ticket: Doc<"tickets">,
): boolean {
  if (actionType === "tag_maintainers") return true;
  if (!isRecord(proposedChanges)) return false;
  return (
    proposedChanges.originalTitle === ticket.githubTitle &&
    proposedChanges.originalBody === (ticket.githubBody ?? "")
  );
}

function getProposalStalenessReason(
  action: Doc<"ticketActions">,
  proposedChanges: unknown,
  workflow: ActiveTicketWorkflow,
): string | undefined {
  if (
    !proposalMatchesCurrentTicket(
      action.actionType,
      proposedChanges,
      workflow.ticket,
    )
  ) {
    return "Ticket content changed during analysis";
  }
  if (
    !proposalMatchesCurrentIndex(
      action.actionType,
      proposedChanges,
      workflow.repository,
    )
  ) {
    return "Repository index changed during analysis";
  }
  return undefined;
}

/**
 * Create a new ticket action
 */
export const create = internalMutation({
  args: {
    ticketId: v.id("tickets"),
    actionType: v.union(
      v.literal("format"),
      v.literal("answer"),
      v.literal("tag_maintainers"),
      v.literal("follow_up"),
    ),
    proposedChanges: v.optional(v.any()),
    chatHistory: v.optional(
      v.array(
        v.object({
          role: v.union(v.literal("user"), v.literal("assistant")),
          content: v.string(),
          timestamp: v.number(),
        }),
      ),
    ),
    pendingGenerationTarget: v.optional(chatRecoveryTargetValidator),
    initialProcessingGeneration: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access = await getActiveTicketWorkflow(ctx, args.ticketId);
    if (!access.active) {
      throw new Error(access.reason);
    }
    if (args.pendingGenerationTarget?.kind === "initial_ticket") {
      const target = args.pendingGenerationTarget;
      const readiness = getRepositoryAiReadiness(access.workflow.repository);
      if (
        access.workflow.ticket.githubInitialProcessingPending !== true ||
        access.workflow.ticket.githubInitialProcessingGeneration !==
          args.initialProcessingGeneration ||
        access.workflow.ticket.githubInitialProcessingAiInputVersion !==
          target.expectedAiInputVersion ||
        args.initialProcessingGeneration === undefined ||
        access.workflow.ticket.aiInputVersion !==
          target.expectedAiInputVersion ||
        readiness.indexVersion !== target.expectedIndexVersion
      ) {
        throw new Error("Initial ticket processing claim is stale");
      }
    }
    const now = Date.now();

    const actionId = await ctx.db.insert("ticketActions", {
      ticketId: args.ticketId,
      actionType: args.actionType,
      chatHistory: args.chatHistory ?? [],
      proposedChanges: args.proposedChanges,
      proposalVersion: args.proposedChanges ? 1 : 0,
      status: args.proposedChanges ? "pending_approval" : "pending",
      createdAt: now,
    });

    if (args.pendingGenerationTarget && !args.proposedChanges) {
      await armPendingGeneration(
        ctx,
        actionId,
        args.pendingGenerationTarget,
        now,
      );
      if (args.pendingGenerationTarget.kind === "initial_ticket") {
        const ticket = access.workflow.ticket;
        if (ticket.githubInitialProcessingScheduleId) {
          const scheduled = await ctx.db.system.get(
            ticket.githubInitialProcessingScheduleId,
          );
          if (scheduled?.state.kind === "pending") {
            await ctx.scheduler.cancel(
              ticket.githubInitialProcessingScheduleId,
            );
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
      }
    }

    return actionId;
  },
});

/** Record one visible failure when repository readiness polling expires. */
export const recordReadinessTimeout = internalMutation({
  args: {
    ticketId: v.id("tickets"),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await getActiveTicketWorkflow(ctx, args.ticketId);
    if (!access.active) return null;

    const recentActions = await ctx.db
      .query("ticketActions")
      .withIndex("by_ticket", (q) => q.eq("ticketId", args.ticketId))
      .order("desc")
      .take(100);
    const existing = recentActions.find(
      (action) =>
        action.status === "failed" && action.errorMessage === args.errorMessage,
    );
    if (existing) return existing._id;

    const now = Date.now();
    return await ctx.db.insert("ticketActions", {
      ticketId: args.ticketId,
      actionType: "answer",
      chatHistory: [],
      proposalVersion: 0,
      status: "failed",
      errorMessage: args.errorMessage,
      createdAt: now,
      completedAt: now,
    });
  },
});

/**
 * Update action status
 */
export const updateStatus = internalMutation({
  args: {
    actionId: v.id("ticketActions"),
    expectedProposalVersion: v.optional(v.number()),
    status: v.union(
      v.literal("pending"),
      v.literal("pending_approval"),
      v.literal("approved"),
      v.literal("rejected"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.actionId);
    if (!action) return false;
    if (
      args.expectedProposalVersion !== undefined &&
      (action.status !== "pending" ||
        action.proposalVersion !== args.expectedProposalVersion)
    ) {
      return false;
    }
    if (
      args.status === "pending" ||
      args.status === "pending_approval" ||
      args.status === "approved"
    ) {
      const access = await getActiveTicketWorkflow(ctx, action.ticketId);
      if (!access.active) {
        await failNonterminalAction(ctx, action, access.reason);
        return false;
      }
    }

    const updates: Record<string, unknown> = {
      status: args.status,
    };

    if (args.errorMessage) {
      updates.errorMessage = args.errorMessage;
    }

    if (args.status === "approved") {
      updates.approvedAt = Date.now();
    }

    if (args.status === "completed" || args.status === "failed") {
      updates.completedAt = Date.now();
      await cancelResultRecovery(ctx, action);
      Object.assign(updates, clearedResultRecovery());
    }

    await ctx.db.patch(action._id, updates);
    return true;
  },
});

export type ExecutionClaimMode = "manual_approval" | "auto_approved";

type ExecutionClaimCandidate = {
  status: string;
  executionClaimedAt?: number;
  executionResult?: unknown;
};

export function evaluateExecutionClaim(
  action: ExecutionClaimCandidate,
  ticketStatus: string,
  mode: ExecutionClaimMode,
): { eligible: true } | { eligible: false; reason: string } {
  if (ticketStatus !== "open") {
    return { eligible: false, reason: "Ticket is no longer open" };
  }

  if (action.executionClaimedAt !== undefined) {
    return { eligible: false, reason: "Action execution was already claimed" };
  }

  if (action.executionResult !== undefined) {
    return { eligible: false, reason: "Action was already executed" };
  }

  const expectedStatus =
    mode === "manual_approval" ? "pending_approval" : "approved";
  if (action.status !== expectedStatus) {
    return {
      eligible: false,
      reason:
        mode === "manual_approval"
          ? "Action is not pending approval"
          : "Action is not approved",
    };
  }

  return { eligible: true };
}

type ResponsePublicationCheck =
  { ready: true } | { ready: false; reason: string; refreshing?: true };

async function checkResponseIndexForPublication(
  ctx: MutationCtx,
  action: Doc<"ticketActions">,
  ticket: Doc<"tickets">,
  repository: Doc<"repositories">,
  mode: ExecutionClaimMode,
): Promise<ResponsePublicationCheck> {
  if (action.actionType !== "answer" && action.actionType !== "follow_up") {
    return { ready: true };
  }
  const groundedIndexVersion = isRecord(action.proposedChanges)
    ? action.proposedChanges.groundedIndexVersion
    : undefined;
  if (
    typeof groundedIndexVersion !== "number" ||
    !Number.isFinite(groundedIndexVersion)
  ) {
    return {
      ready: false,
      reason: "Action is missing its repository index snapshot",
    };
  }
  const readiness = getRepositoryAiReadiness(repository);
  if (readiness.state === "blocked") {
    return { ready: false, reason: readiness.reason };
  }
  if (
    readiness.state === "ready" &&
    readiness.indexVersion === groundedIndexVersion
  ) {
    return { ready: true };
  }
  const refreshCount = action.publicationRefreshCount ?? 0;
  if (refreshCount >= MAX_PUBLICATION_REFRESHES) {
    return {
      ready: false,
      reason:
        "Repository index kept changing before the response could be published",
    };
  }
  const epoch = {
    expectedAiInputVersion: ticket.aiInputVersion,
    expectedIndexVersion: readiness.indexVersion,
  };
  const forceApproval = mode === "manual_approval";
  const target: ChatRecoveryTarget =
    action.actionType === "follow_up"
      ? {
          kind: "follow_up",
          ...(forceApproval ? { forceApproval } : {}),
          ...epoch,
        }
      : forceApproval
        ? { kind: "regenerate", ...epoch }
        : { kind: "initial_ticket", stage: "answer", ...epoch };

  const now = Date.now();
  await cancelResultRecovery(ctx, action);
  await ctx.db.patch(action._id, {
    status: "pending",
    proposalVersion: action.proposalVersion + 1,
    publicationRefreshCount: refreshCount + 1,
    approvedAt: undefined,
    completedAt: undefined,
    errorMessage: undefined,
    executionClaimedAt: undefined,
    ...(target.kind === "initial_ticket"
      ? { proposedChanges: undefined, chatHistory: [] }
      : {}),
    ...clearedResultRecovery(),
  });
  await armPendingGeneration(ctx, action._id, target, now);
  if (target.kind === "initial_ticket") {
    await ctx.scheduler.runAfter(
      0,
      internal.tickets.internalAction.processNewTicket,
      {
        ticketId: ticket._id,
        repositoryId: repository._id,
        issueTitle: ticket.githubTitle,
        issueBody: ticket.githubBody ?? "",
        ...epoch,
        processingStage: "answer",
        answerActionId: action._id,
      },
    );
  } else {
    await ctx.scheduler.runAfter(
      0,
      target.kind === "follow_up"
        ? internal.ticketActions.internalAction.processFollowUp
        : internal.ticketActions.internalAction.regenerateWithFeedback,
      {
        actionId: action._id,
        expectedIndexVersion: epoch.expectedIndexVersion,
        ...(target.kind === "follow_up" && forceApproval
          ? { forceApproval }
          : {}),
      },
    );
  }
  return {
    ready: false,
    refreshing: true,
    reason: "Refreshing the response with the latest repository index",
  };
}

/**
 * Atomically claims the one external GitHub write associated with an action.
 * Manual approval also transitions pending_approval -> approved in the same
 * transaction, so concurrent approval requests cannot both publish.
 */
export const claimForExecution = internalMutation({
  args: {
    actionId: v.id("ticketActions"),
    mode: v.union(v.literal("manual_approval"), v.literal("auto_approved")),
    expectedProposalVersion: v.number(),
  },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.actionId);
    if (!action) {
      return { claimed: false as const, reason: "Action not found" };
    }
    if (action.proposalVersion !== args.expectedProposalVersion) {
      return {
        claimed: false as const,
        reason: "Action proposal changed before execution",
      };
    }

    const ticket = await ctx.db.get(action.ticketId);
    if (!ticket) {
      return { claimed: false as const, reason: "Ticket not found" };
    }

    const decision = evaluateExecutionClaim(action, ticket.status, args.mode);
    if (!decision.eligible) {
      return { claimed: false as const, reason: decision.reason };
    }

    const proposedChanges = isRecord(action.proposedChanges)
      ? action.proposedChanges
      : null;
    if (
      !proposalMatchesCurrentTicket(
        action.actionType,
        action.proposedChanges,
        ticket,
      )
    ) {
      return {
        claimed: false as const,
        reason: "Ticket content changed after this proposal was generated",
      };
    }
    const hasExecutablePayload =
      action.actionType === "format"
        ? typeof proposedChanges?.suggestedTitle === "string" &&
          proposedChanges.suggestedTitle.trim().length > 0 &&
          typeof proposedChanges.suggestedBody === "string" &&
          proposedChanges.suggestedBody.trim().length > 0
        : typeof proposedChanges?.suggestedResponse === "string" &&
          proposedChanges.suggestedResponse.trim().length > 0;
    if (!hasExecutablePayload) {
      return {
        claimed: false as const,
        reason: "Action has no executable proposed change",
      };
    }

    if (!ticket.repositoryId) {
      return {
        claimed: false as const,
        reason: "Ticket has no repository linked",
      };
    }
    const repository = await ctx.db.get(ticket.repositoryId);
    if (!repository) {
      return { claimed: false as const, reason: "Repository not found" };
    }
    if (
      repository.isActive !== true ||
      repository.disconnectCleanupPending === true
    ) {
      return { claimed: false as const, reason: "Repository is paused" };
    }
    if (repository.githubAccessRevokedAt !== undefined) {
      return {
        claimed: false as const,
        reason: "Repository installation access is not active",
      };
    }
    const installationId = repository.installationId;
    const installation = await getExactGitHubInstallation(ctx, installationId);
    if (
      !isGitHubInstallationReady(installation) ||
      installation.userId !== repository.userId ||
      installation.installationId !== repository.installationId
    ) {
      return {
        claimed: false as const,
        reason: "Repository installation access is not active",
      };
    }

    if (ticket.ticketType === "pull_request")
      return {
        claimed: false as const,
        reason: "PR reviews use the dedicated review executor",
      };
    const isDiscussion = ticket.ticketType === "discussion";
    const assistantEnabled = isDiscussion
      ? repository.settings.discussionAssistantEnabled
      : repository.settings.issueAssistantEnabled;
    if (!assistantEnabled) {
      return {
        claimed: false as const,
        reason: "Repository assistant is disabled",
      };
    }

    if (args.mode === "auto_approved") {
      const featureStillEnabled =
        action.actionType === "format"
          ? isDiscussion
            ? repository.settings.autoFormatDiscussion
            : repository.settings.autoFormatIssue
          : action.actionType === "answer"
            ? isDiscussion
              ? repository.settings.autoAnswerDiscussionQuestions
              : repository.settings.autoAnswerQuestions
            : true;
      if (!featureStillEnabled) {
        await cancelResultRecovery(ctx, action);
        await ctx.db.patch(action._id, {
          status: "failed",
          errorMessage: "Repository automation was disabled before publishing",
          completedAt: Date.now(),
          ...clearedResultRecovery(),
        });
        return {
          claimed: false as const,
          reason: "Repository automation is disabled",
        };
      }
    }

    const currentlyRequiresApproval = isDiscussion
      ? repository.settings.requireApprovalForDiscussions
      : repository.settings.requireApproval;
    if (args.mode === "auto_approved" && currentlyRequiresApproval) {
      await cancelResultRecovery(ctx, action);
      await ctx.db.patch(args.actionId, {
        status: "pending_approval",
        ...clearedResultRecovery(),
      });
      return {
        claimed: false as const,
        reason: "Repository now requires manual approval",
      };
    }

    const indexCheck = await checkResponseIndexForPublication(
      ctx,
      action,
      ticket,
      repository,
      args.mode,
    );
    if (!indexCheck.ready) {
      return {
        claimed: false as const,
        reason: indexCheck.reason,
        ...(indexCheck.refreshing ? { refreshing: true as const } : {}),
      };
    }

    const now = Date.now();
    const idempotencyKey = crypto.randomUUID();
    await cancelResultRecovery(ctx, action);
    await ctx.db.patch(args.actionId, {
      executionClaimedAt: now,
      ...(args.mode === "manual_approval"
        ? { status: "approved" as const, approvedAt: now }
        : {}),
      ...clearedResultRecovery(),
      executionIdempotencyKey: idempotencyKey,
      executionRecoveryMode: args.mode,
    });
    await armClaimedExecutionRecovery(
      ctx,
      action._id,
      now,
      action.proposalVersion,
      now,
    );

    return {
      claimed: true as const,
      claimedAt: now,
      idempotencyKey,
    };
  },
});

/** Check freshness after the final GitHub access lookup, before the first POST. */
export const checkClaimedResponseBeforeWrite = internalMutation({
  args: {
    actionId: v.id("ticketActions"),
    expectedClaimedAt: v.number(),
    expectedProposalVersion: v.number(),
  },
  handler: async (ctx, args): Promise<ResponsePublicationCheck> => {
    const action = await ctx.db.get(args.actionId);
    if (
      !action ||
      action.status !== "approved" ||
      action.executionResult !== undefined ||
      action.executionClaimedAt !== args.expectedClaimedAt ||
      action.proposalVersion !== args.expectedProposalVersion ||
      action.executionRecoveryReconcileOnly === true ||
      action.executionRecoveryMode === undefined ||
      Date.now() >= args.expectedClaimedAt + CLAIMED_EXECUTION_RECOVERY_LEASE_MS
    ) {
      return {
        ready: false,
        reason: "Action no longer owns the initial publication attempt",
      };
    }
    const access = await getActiveTicketWorkflow(ctx, action.ticketId);
    const check = !access.active
      ? { ready: false as const, reason: access.reason }
      : !proposalMatchesCurrentTicket(
            action.actionType,
            action.proposedChanges,
            access.workflow.ticket,
          )
        ? {
            ready: false as const,
            reason: "Ticket content changed after this proposal was generated",
          }
        : await checkResponseIndexForPublication(
            ctx,
            action,
            access.workflow.ticket,
            access.workflow.repository,
            action.executionRecoveryMode,
          );
    if (!check.ready && !check.refreshing) {
      await failNonterminalAction(ctx, action, check.reason);
    }
    return check;
  },
});

/**
 * Mark only the execution attempt that still owns the action as failed. For a
 * preflight failure, the action must still be unclaimed in its expected state.
 */
export const failExecutionAttempt = internalMutation({
  args: {
    actionId: v.id("ticketActions"),
    mode: v.union(v.literal("manual_approval"), v.literal("auto_approved")),
    claimedAt: v.optional(v.number()),
    expectedProposalVersion: v.optional(v.number()),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.actionId);
    if (!action || action.executionResult !== undefined) return false;
    if (
      args.expectedProposalVersion !== undefined &&
      action.proposalVersion !== args.expectedProposalVersion
    ) {
      return false;
    }

    if (args.claimedAt !== undefined) {
      if (
        action.executionClaimedAt !== args.claimedAt ||
        action.status !== "approved"
      ) {
        return false;
      }
    } else {
      const expectedStatus =
        args.mode === "manual_approval" ? "pending_approval" : "approved";
      if (
        action.status !== expectedStatus ||
        action.executionClaimedAt !== undefined
      ) {
        return false;
      }
    }

    await cancelResultRecovery(ctx, action);
    await ctx.db.patch(args.actionId, {
      status: "failed",
      errorMessage: args.errorMessage,
      completedAt: Date.now(),
      ...clearedResultRecovery(),
    });
    return true;
  },
});

/** Fail a still-pending AI generation without overwriting a newer result. */
export const failPendingAction = internalMutation({
  args: {
    actionId: v.id("ticketActions"),
    expectedProposalVersion: v.number(),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.actionId);
    if (
      !action ||
      action.status !== "pending" ||
      action.executionClaimedAt !== undefined ||
      action.executionResult !== undefined ||
      action.proposalVersion !== args.expectedProposalVersion
    ) {
      return false;
    }

    await cancelResultRecovery(ctx, action);
    await ctx.db.patch(args.actionId, {
      status: "failed",
      errorMessage: args.errorMessage,
      completedAt: Date.now(),
      ...clearedResultRecovery(),
    });
    return true;
  },
});

/** Keep one pending-generation retry chain live without spawning duplicates. */
export const refreshPendingGenerationLease = internalMutation({
  args: {
    actionId: v.id("ticketActions"),
    providerRetryStartedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.actionId);
    if (
      !action ||
      action.status !== "pending" ||
      !action.pendingGenerationTarget ||
      action.resultCheckpointKey
    ) {
      return false;
    }
    await ctx.db.patch(action._id, {
      pendingGenerationLeaseUntil: Date.now() + PENDING_GENERATION_LEASE_MS,
      ...(args.providerRetryStartedAt === undefined
        ? {}
        : { providerRetryStartedAt: args.providerRetryStartedAt }),
    });
    return true;
  },
});

/** Refresh the durable lease before an approved worker begins GitHub preflight. */
export const refreshAutoExecutionRecoveryLease = internalMutation({
  args: { actionId: v.id("ticketActions") },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.actionId);
    if (
      !action ||
      action.status !== "approved" ||
      action.executionClaimedAt !== undefined ||
      action.executionResult !== undefined ||
      action.autoExecutionRecoveryExpiresAt === undefined
    ) {
      return false;
    }
    if (action.autoExecutionRecoveryExpiresAt <= Date.now()) {
      await failNonterminalAction(
        ctx,
        action,
        "Automatic execution expired before GitHub preflight completed",
      );
      return false;
    }
    await ctx.db.patch(action._id, {
      autoExecutionRecoveryLeaseUntil:
        Date.now() + AUTO_EXECUTION_RECOVERY_LEASE_MS,
    });
    return true;
  },
});

/** Atomically persist a preflight retry and its scheduler job. */
export const scheduleAutoExecutionRetry = internalMutation({
  args: {
    actionId: v.id("ticketActions"),
    expectedProposalVersion: v.optional(v.number()),
    retryAttempt: v.number(),
    delayMs: v.number(),
  },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.actionId);
    if (
      !action ||
      action.status !== "approved" ||
      action.executionClaimedAt !== undefined ||
      action.executionResult !== undefined ||
      (args.expectedProposalVersion !== undefined &&
        action.proposalVersion !== args.expectedProposalVersion)
    ) {
      return false;
    }
    const now = Date.now();
    const expiresAt =
      action.autoExecutionRecoveryExpiresAt ??
      now + AUTO_EXECUTION_RECOVERY_TTL_MS;
    if (expiresAt <= now) {
      await failNonterminalAction(
        ctx,
        action,
        "Automatic execution expired before GitHub preflight completed",
      );
      return false;
    }
    if (action.autoExecutionRecoveryScheduleId) {
      const scheduled = await ctx.db.system.get(
        action.autoExecutionRecoveryScheduleId,
      );
      if (scheduled?.state.kind === "pending") {
        await ctx.scheduler.cancel(action.autoExecutionRecoveryScheduleId);
      }
    }
    await armAutoExecutionRecovery(
      ctx,
      action._id,
      now,
      expiresAt,
      Math.max(0, args.delayMs),
      Math.max(0, Math.floor(args.retryAttempt)),
    );
    return true;
  },
});

/** Recover approved, unclaimed actions whose scheduler worker disappeared. */
export const recoverAutoApprovedExecutions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const expired = await ctx.db
      .query("ticketActions")
      .withIndex("by_status_and_auto_execution_expiration", (q) =>
        q
          .eq("status", "approved")
          .gt("autoExecutionRecoveryExpiresAt", 0)
          .lte("autoExecutionRecoveryExpiresAt", now),
      )
      .take(AUTO_EXECUTION_RECOVERY_LIMIT);
    let failed = 0;
    for (const action of expired) {
      if (
        action.executionClaimedAt !== undefined ||
        action.executionResult !== undefined
      ) {
        continue;
      }
      await failNonterminalAction(
        ctx,
        action,
        "Automatic execution expired before GitHub preflight completed",
      );
      failed += 1;
    }

    const due = await ctx.db
      .query("ticketActions")
      .withIndex("by_status_and_auto_execution_lease", (q) =>
        q
          .eq("status", "approved")
          .gt("autoExecutionRecoveryLeaseUntil", 0)
          .lte("autoExecutionRecoveryLeaseUntil", now),
      )
      .take(AUTO_EXECUTION_RECOVERY_LIMIT);
    let scheduled = 0;
    for (const action of due) {
      if (
        action.executionClaimedAt !== undefined ||
        action.executionResult !== undefined ||
        action.autoExecutionRecoveryExpiresAt === undefined ||
        action.autoExecutionRecoveryExpiresAt <= now
      ) {
        continue;
      }
      if (action.autoExecutionRecoveryScheduleId) {
        const tracked = await ctx.db.system.get(
          action.autoExecutionRecoveryScheduleId,
        );
        if (
          tracked?.state.kind === "pending" ||
          tracked?.state.kind === "inProgress"
        ) {
          continue;
        }
      }
      await armAutoExecutionRecovery(
        ctx,
        action._id,
        now,
        action.autoExecutionRecoveryExpiresAt,
      );
      scheduled += 1;
    }
    return { failed, scheduled };
  },
});

/** Keep the post-claim reconciliation lease alive for exactly one claim. */
export const refreshClaimedExecutionRecoveryLease = internalMutation({
  args: {
    actionId: v.id("ticketActions"),
    expectedClaimedAt: v.number(),
    expectedProposalVersion: v.number(),
  },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.actionId);
    if (
      !action ||
      action.status !== "approved" ||
      action.executionResult !== undefined ||
      action.executionClaimedAt !== args.expectedClaimedAt ||
      action.proposalVersion !== args.expectedProposalVersion ||
      !action.executionIdempotencyKey ||
      action.executionRecoveryExpiresAt === undefined
    ) {
      return false;
    }
    const now = Date.now();
    if (
      action.executionRecoveryReconcileOnly === true &&
      (action.executionRecoveryReconcileDeadlineAt ?? 0) <= now
    ) {
      await failNonterminalAction(
        ctx,
        action,
        "Repository disconnect completed before the external GitHub outcome could be verified",
      );
      return false;
    }
    await ctx.db.patch(action._id, {
      executionRecoveryExpiresAt:
        action.executionRecoveryExpiresAt <= now
          ? now + CLAIMED_EXECUTION_RECOVERY_TTL_MS
          : action.executionRecoveryExpiresAt,
      executionRecoveryLeaseUntil: now + CLAIMED_EXECUTION_RECOVERY_LEASE_MS,
    });
    return true;
  },
});

/** Persist a delayed reconciliation after an ambiguous external write. */
export const scheduleClaimedExecutionRetry = internalMutation({
  args: {
    actionId: v.id("ticketActions"),
    expectedClaimedAt: v.number(),
    expectedProposalVersion: v.number(),
    retryAttempt: v.number(),
    delayMs: v.number(),
  },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.actionId);
    if (
      !action ||
      action.status !== "approved" ||
      action.executionResult !== undefined ||
      action.executionClaimedAt !== args.expectedClaimedAt ||
      action.proposalVersion !== args.expectedProposalVersion ||
      !action.executionIdempotencyKey ||
      action.executionRecoveryExpiresAt === undefined
    ) {
      return false;
    }
    const now = Date.now();
    if (
      action.executionRecoveryReconcileOnly === true &&
      (action.executionRecoveryReconcileDeadlineAt ?? 0) <= now
    ) {
      await failNonterminalAction(
        ctx,
        action,
        "Repository disconnect completed before the external GitHub outcome could be verified",
      );
      return false;
    }
    const expiresAt =
      action.executionRecoveryExpiresAt <= now
        ? now + CLAIMED_EXECUTION_RECOVERY_TTL_MS
        : action.executionRecoveryExpiresAt;
    if (action.executionRecoveryScheduleId) {
      const scheduled = await ctx.db.system.get(
        action.executionRecoveryScheduleId,
      );
      if (scheduled?.state.kind === "pending") {
        await ctx.scheduler.cancel(action.executionRecoveryScheduleId);
      }
    }
    await armClaimedExecutionRecovery(
      ctx,
      action._id,
      args.expectedClaimedAt,
      args.expectedProposalVersion,
      now,
      expiresAt,
      Math.max(CLAIMED_EXECUTION_RECOVERY_GRACE_MS, args.delayMs),
      Math.max(0, Math.floor(args.retryAttempt)),
    );
    return true;
  },
});

/** Recover post-claim workers whose durable scheduler chain disappeared. */
export const recoverClaimedExecutions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const expired = await ctx.db
      .query("ticketActions")
      .withIndex("by_status_and_execution_recovery_expiration", (q) =>
        q
          .eq("status", "approved")
          .gt("executionRecoveryExpiresAt", 0)
          .lte("executionRecoveryExpiresAt", now),
      )
      .take(CLAIMED_EXECUTION_RECOVERY_LIMIT);
    let restarted = 0;
    for (const action of expired) {
      if (
        action.executionClaimedAt === undefined ||
        action.executionResult !== undefined ||
        !action.executionIdempotencyKey
      ) {
        continue;
      }
      if (
        action.executionRecoveryReconcileOnly === true &&
        (action.executionRecoveryReconcileDeadlineAt ?? 0) <= now
      ) {
        await failNonterminalAction(
          ctx,
          action,
          "Repository disconnect completed before the external GitHub outcome could be verified",
        );
        continue;
      }
      if (action.executionRecoveryScheduleId) {
        const tracked = await ctx.db.system.get(
          action.executionRecoveryScheduleId,
        );
        if (
          tracked?.state.kind === "pending" ||
          tracked?.state.kind === "inProgress"
        ) {
          await ctx.db.patch(action._id, {
            executionRecoveryExpiresAt: now + CLAIMED_EXECUTION_RECOVERY_TTL_MS,
          });
          restarted += 1;
          continue;
        }
      }
      await armClaimedExecutionRecovery(
        ctx,
        action._id,
        action.executionClaimedAt,
        action.proposalVersion,
        now,
        now + CLAIMED_EXECUTION_RECOVERY_TTL_MS,
        0,
      );
      restarted += 1;
    }

    const due = await ctx.db
      .query("ticketActions")
      .withIndex("by_status_and_execution_recovery_lease", (q) =>
        q
          .eq("status", "approved")
          .gt("executionRecoveryLeaseUntil", 0)
          .lte("executionRecoveryLeaseUntil", now),
      )
      .take(CLAIMED_EXECUTION_RECOVERY_LIMIT);
    let scheduled = 0;
    for (const action of due) {
      if (
        action.executionClaimedAt === undefined ||
        action.executionResult !== undefined ||
        !action.executionIdempotencyKey ||
        action.executionRecoveryExpiresAt === undefined ||
        action.executionRecoveryExpiresAt <= now
      ) {
        continue;
      }
      if (
        action.executionRecoveryReconcileOnly === true &&
        (action.executionRecoveryReconcileDeadlineAt ?? 0) <= now
      ) {
        await failNonterminalAction(
          ctx,
          action,
          "Repository disconnect completed before the external GitHub outcome could be verified",
        );
        continue;
      }
      if (action.executionRecoveryScheduleId) {
        const tracked = await ctx.db.system.get(
          action.executionRecoveryScheduleId,
        );
        if (
          tracked?.state.kind === "pending" ||
          tracked?.state.kind === "inProgress"
        ) {
          continue;
        }
      }
      await armClaimedExecutionRecovery(
        ctx,
        action._id,
        action.executionClaimedAt,
        action.proposalVersion,
        now,
        action.executionRecoveryExpiresAt,
        0,
      );
      scheduled += 1;
    }
    return { restarted, scheduled };
  },
});

/** Atomically reject an action only while it is still awaiting approval. */
export const rejectPendingApproval = internalMutation({
  args: { actionId: v.id("ticketActions") },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.actionId);
    if (!action) throw new Error("Action not found");
    const access = await getActiveTicketWorkflow(ctx, action.ticketId);
    if (!access.active) throw new Error(access.reason);
    if (
      action.status !== "pending_approval" ||
      action.executionClaimedAt !== undefined
    ) {
      throw new Error("Action is no longer pending approval");
    }

    await ctx.db.patch(args.actionId, { status: "rejected" });
  },
});

/**
 * Atomically record feedback and queue regeneration. Keeping the transition
 * and scheduling in one mutation prevents approval from racing a second AI
 * run for the same action.
 */
export const requestChangesForAction = internalMutation({
  args: {
    actionId: v.id("ticketActions"),
    feedback: v.string(),
  },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.actionId);
    if (!action) throw new Error("Action not found");
    const access = await getActiveTicketWorkflow(ctx, action.ticketId);
    if (!access.active) throw new Error(access.reason);
    if (
      action.status !== "pending_approval" ||
      action.executionClaimedAt !== undefined
    ) {
      throw new Error("Action is no longer pending approval");
    }
    if (
      action.actionType !== "format" &&
      action.actionType !== "answer" &&
      action.actionType !== "follow_up"
    ) {
      throw new Error("This action type does not support regeneration");
    }

    const now = Date.now();
    const nextChatHistory = [...action.chatHistory];
    if (action.actionType === "follow_up") {
      const proposedChanges = isRecord(action.proposedChanges)
        ? action.proposedChanges
        : null;
      const previousResponse = proposedChanges?.suggestedResponse;

      if (
        typeof previousResponse === "string" &&
        previousResponse.trim().length > 0 &&
        !nextChatHistory.some(
          (message) =>
            message.role === "assistant" &&
            message.content === previousResponse,
        )
      ) {
        nextChatHistory.push({
          role: "assistant" as const,
          content: previousResponse,
          timestamp: now,
        });
      }
    }

    nextChatHistory.push({
      role: "user" as const,
      content: `Request changes: ${args.feedback}`,
      timestamp: now,
    });

    await cancelResultRecovery(ctx, action);
    await ctx.db.patch(args.actionId, {
      userFeedback: args.feedback,
      status: "pending",
      chatHistory: nextChatHistory,
      proposalVersion: action.proposalVersion + 1,
      ...clearedResultRecovery(),
    });

    await armPendingGeneration(
      ctx,
      action._id,
      action.actionType === "follow_up"
        ? {
            kind: "follow_up",
            forceApproval: true,
            expectedAiInputVersion: access.workflow.ticket.aiInputVersion,
            expectedIndexVersion: access.workflow.repository.indexVersion,
          }
        : {
            kind: "regenerate",
            expectedAiInputVersion: access.workflow.ticket.aiInputVersion,
            expectedIndexVersion: access.workflow.repository.indexVersion,
          },
      now,
    );

    if (action.actionType === "follow_up") {
      await ctx.scheduler.runAfter(
        0,
        internal.ticketActions.internalAction.processFollowUp,
        { actionId: args.actionId, forceApproval: true },
      );
    } else {
      await ctx.scheduler.runAfter(
        0,
        internal.ticketActions.internalAction.regenerateWithFeedback,
        { actionId: args.actionId },
      );
    }
  },
});

/**
 * Update proposed changes
 */
export const updateProposedChanges = internalMutation({
  args: {
    actionId: v.id("ticketActions"),
    expectedProposalVersion: v.optional(v.number()),
    proposedChanges: v.any(),
  },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.actionId);
    if (!action) throw new Error("Action not found");
    if (
      action.status !== "pending" ||
      action.executionClaimedAt !== undefined ||
      (args.expectedProposalVersion !== undefined &&
        action.proposalVersion !== args.expectedProposalVersion)
    ) {
      return false;
    }
    const access = await getActiveTicketWorkflow(ctx, action.ticketId);
    const stalenessReason = access.active
      ? getProposalStalenessReason(
          action,
          args.proposedChanges,
          access.workflow,
        )
      : undefined;
    if (!access.active || stalenessReason) {
      const reason = access.active
        ? (stalenessReason ?? "AI proposal snapshot changed")
        : access.reason;
      await failNonterminalAction(ctx, action, reason);
      return false;
    }
    await cancelResultRecovery(ctx, action);
    await ctx.db.patch(args.actionId, {
      proposedChanges: args.proposedChanges,
      proposalVersion: action.proposalVersion + 1,
      status: "pending_approval",
      ...clearedResultRecovery(),
    });
    return true;
  },
});

export const AUTO_PUBLISH_CONFIDENCE_THRESHOLD = 0.8;

type AutoPublishDecision = {
  eligible: boolean;
  reasons: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const HIGH_RISK_RESPONSE_PATTERN = new RegExp(
  [
    "```",
    "https?://",
    "\\b(?:confirmed\\s+bug|root\\s+cause|not\\s+reproducible|already\\s+fixed)\\b",
    "\\b(?:the\\s+bug|this\\s+bug)\\s+does\\s+not\\s+exist\\b",
    "\\brecommend(?:ed|ing|s)?\\s+(?:close|closing)\\b",
    "\\b[\\w./-]+\\.[A-Za-z0-9]+:\\d+\\b",
  ].join("|"),
  "i",
);

const ACTIONABLE_CHANGE_VERB_SOURCE =
  "add|call|change|configure|delete|disable|edit|enable|implement|insert|modify|move|pass|remove|rename|replace|run|set|switch|update|use|wrap";
const ACTIONABLE_IMPERATIVE_PATTERN = new RegExp(
  [
    String.raw`(?:^|[.!?]\s+|\n+)\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:(?:(?:in|inside)\s+[^,\n]{1,120}|to\s+(?:address|fix|resolve)\b[^,\n]{0,100}),\s*)?(?:please\s+)?(?:${ACTIONABLE_CHANGE_VERB_SOURCE})\b`,
    String.raw`\b(?:you\s+)?(?:can|could|must|need\s+to|should|try\s+to)\s+(?:${ACTIONABLE_CHANGE_VERB_SOURCE})\b`,
  ].join("|"),
  "i",
);

function containsNonAsciiLetter(value: string): boolean {
  return Array.from(value).some(
    (character) => /\p{Letter}/u.test(character) && !/[A-Za-z]/.test(character),
  );
}

/**
 * Auto-publish only low-risk, English, code-grounded answers. Formatting
 * changes always require review because formatting validation cannot prove
 * semantic equivalence.
 */
export function evaluateAutoPublishEligibility(
  proposedChanges: unknown,
  actionType?: string,
): AutoPublishDecision {
  if (!isRecord(proposedChanges)) {
    return { eligible: false, reasons: ["missing proposed changes"] };
  }

  if (actionType === "format") {
    const formatReasons = ["formatting changes require manual approval"];
    if (proposedChanges.formatValidationPassed !== true) {
      formatReasons.push("format validation did not pass");
    }
    if (
      typeof proposedChanges.suggestedTitle !== "string" ||
      proposedChanges.suggestedTitle.trim().length === 0
    ) {
      formatReasons.push("missing suggested title");
    }
    if (
      typeof proposedChanges.suggestedBody !== "string" ||
      proposedChanges.suggestedBody.trim().length === 0
    ) {
      formatReasons.push("missing suggested body");
    }

    return { eligible: false, reasons: formatReasons };
  }

  const suggestedResponse = proposedChanges.suggestedResponse;
  if (suggestedResponse === undefined) {
    return { eligible: false, reasons: ["missing suggested response"] };
  }

  const reasons: string[] = [];
  const confidence = proposedChanges.confidence;
  const toolsUsed = proposedChanges.toolsUsed;
  const filesRead = proposedChanges.filesRead;
  const filesReadPaths = proposedChanges.filesReadPaths;
  const toolErrors = proposedChanges.toolErrors;
  const groundedIndexVersion = proposedChanges.groundedIndexVersion;

  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence > 1 ||
    confidence < AUTO_PUBLISH_CONFIDENCE_THRESHOLD
  ) {
    reasons.push("confidence below auto-publish threshold");
  }
  if (typeof toolsUsed !== "number" || toolsUsed < 1) {
    reasons.push("no successful grounding workflow recorded");
  }
  if (typeof filesRead !== "number" || filesRead < 1) {
    reasons.push("no repository file was read");
  }
  if (typeof toolErrors !== "number" || toolErrors !== 0) {
    reasons.push("repository tool errors occurred");
  }
  if (proposedChanges.validationPassed !== true) {
    reasons.push("deterministic response validation did not pass");
  }
  if (
    typeof groundedIndexVersion !== "number" ||
    !Number.isFinite(groundedIndexVersion)
  ) {
    reasons.push("repository index snapshot was not recorded");
  }
  if (proposedChanges.wasRepaired === true) {
    reasons.push("response required validation repair");
  }
  if (
    proposedChanges.isActionable === true ||
    proposedChanges.issueType === "actionable"
  ) {
    reasons.push("actionable code-change analysis requires review");
  }
  if (
    typeof suggestedResponse !== "string" ||
    suggestedResponse.trim().length === 0
  ) {
    reasons.push("missing suggested response");
  } else {
    if (HIGH_RISK_RESPONSE_PATTERN.test(suggestedResponse)) {
      reasons.push("response contains high-risk technical guidance");
    }
    if (ACTIONABLE_IMPERATIVE_PATTERN.test(suggestedResponse)) {
      reasons.push("response contains actionable change instructions");
    }
    if (containsNonAsciiLetter(suggestedResponse)) {
      reasons.push("non-English responses require manual review");
    }

    const responseValidation = validateAiResponse(
      suggestedResponse,
      typeof confidence === "number" ? confidence : undefined,
    );
    if (responseValidation.speculationPatterns.length > 0) {
      reasons.push("response contains speculative technical guidance");
    }
  }
  if (
    !Array.isArray(filesReadPaths) ||
    filesReadPaths.length === 0 ||
    !filesReadPaths.some(
      (path) =>
        typeof path === "string" &&
        path.length > 0 &&
        typeof suggestedResponse === "string" &&
        suggestedResponse.toLowerCase().includes(path.toLowerCase()),
    )
  ) {
    reasons.push("response does not cite a repository file that was read");
  }

  return { eligible: reasons.length === 0, reasons };
}

type CompleteActionWithResultsArgs = {
  actionId: Id<"ticketActions">;
  expectedProposalVersion?: number;
  proposedChanges: unknown;
  chatHistory?: Array<{
    role: "user" | "assistant";
    content: string;
    timestamp: number;
  }>;
  requireApproval: boolean;
};

async function completeActionWithResultsInTransaction(
  ctx: MutationCtx,
  args: CompleteActionWithResultsArgs,
): Promise<{
  accepted: boolean;
  shouldAutoExecute: boolean;
  workflow?: ActiveTicketWorkflow;
}> {
  const action = await ctx.db.get(args.actionId);
  if (!action) throw new Error("Action not found");
  if (
    action.status !== "pending" ||
    action.executionClaimedAt !== undefined ||
    (args.expectedProposalVersion !== undefined &&
      action.proposalVersion !== args.expectedProposalVersion)
  ) {
    return { accepted: false, shouldAutoExecute: false };
  }
  const access = await getActiveTicketWorkflow(ctx, action.ticketId);
  const stalenessReason = access.active
    ? getProposalStalenessReason(action, args.proposedChanges, access.workflow)
    : undefined;
  if (!access.active || stalenessReason) {
    const reason = access.active
      ? (stalenessReason ?? "AI proposal snapshot changed")
      : access.reason;
    await failNonterminalAction(ctx, action, reason);
    return { accepted: false, shouldAutoExecute: false };
  }

  const autoPublishDecision = evaluateAutoPublishEligibility(
    args.proposedChanges,
    action.actionType,
  );
  if (!autoPublishDecision.eligible && !args.requireApproval) {
    console.warn(
      "[completeWithResults] Forcing manual approval despite auto-approve setting:",
      autoPublishDecision.reasons,
    );
  }
  const shouldAutoExecute =
    !args.requireApproval && autoPublishDecision.eligible;

  await cancelResultRecovery(ctx, action);
  await ctx.db.patch(args.actionId, {
    proposedChanges: args.proposedChanges,
    proposalVersion: action.proposalVersion + 1,
    chatHistory: args.chatHistory ?? [],
    status: shouldAutoExecute ? "approved" : "pending_approval",
    ...(shouldAutoExecute ? { approvedAt: Date.now() } : {}),
    ...clearedResultRecovery(),
  });
  if (shouldAutoExecute) {
    await armAutoExecutionRecovery(ctx, args.actionId, Date.now());
  }
  return {
    accepted: true,
    shouldAutoExecute,
    workflow: access.workflow,
  };
}

async function scheduleInitialAnswerInTransaction(
  ctx: MutationCtx,
  workflow: ActiveTicketWorkflow,
): Promise<void> {
  const readiness = getRepositoryAiReadiness(workflow.repository);
  const now = Date.now();
  const answerActionId = await ctx.db.insert("ticketActions", {
    ticketId: workflow.ticket._id,
    actionType: "answer",
    chatHistory: [],
    proposalVersion: 0,
    status: "pending",
    createdAt: now,
  });
  await armPendingGeneration(
    ctx,
    answerActionId,
    {
      kind: "initial_ticket",
      stage: "answer",
      expectedAiInputVersion: workflow.ticket.aiInputVersion,
      expectedIndexVersion: readiness.indexVersion,
    },
    now,
  );
  await ctx.scheduler.runAfter(
    0,
    internal.tickets.internalAction.processNewTicket,
    {
      ticketId: workflow.ticket._id,
      repositoryId: workflow.repository._id,
      issueTitle: workflow.ticket.githubTitle,
      issueBody: workflow.ticket.githubBody ?? "",
      expectedAiInputVersion: workflow.ticket.aiInputVersion,
      expectedIndexVersion: readiness.indexVersion,
      processingStage: "answer",
      answerActionId,
    },
  );
}

/**
 * Complete action with results (update proposedChanges and chatHistory)
 * If requireApproval is false, automatically approve and return true for auto-execution.
 * High-risk or insufficiently grounded answers are always sent to manual
 * approval, even when the repository allows automatic publishing.
 */
export const completeWithResults = internalMutation({
  args: {
    actionId: v.id("ticketActions"),
    expectedProposalVersion: v.optional(v.number()),
    proposedChanges: v.any(),
    chatHistory: v.optional(
      v.array(
        v.object({
          role: v.union(v.literal("user"), v.literal("assistant")),
          content: v.string(),
          timestamp: v.number(),
        }),
      ),
    ),
    requireApproval: v.boolean(),
  },
  handler: async (ctx, args) => {
    const result = await completeActionWithResultsInTransaction(ctx, args);
    return result.accepted && result.shouldAutoExecute;
  },
});

/** Finalize initial formatting and enqueue answer generation atomically. */
export const completeInitialFormatAndScheduleAnswer = internalMutation({
  args: {
    actionId: v.id("ticketActions"),
    outcome: v.union(
      v.object({
        kind: v.literal("results"),
        proposedChanges: v.any(),
        chatHistory: v.array(
          v.object({
            role: v.union(v.literal("user"), v.literal("assistant")),
            content: v.string(),
            timestamp: v.number(),
          }),
        ),
        requireApproval: v.boolean(),
      }),
      v.object({ kind: v.literal("completed") }),
      v.object({ kind: v.literal("failed"), errorMessage: v.string() }),
    ),
  },
  handler: async (ctx, args) => {
    let workflow: ActiveTicketWorkflow | undefined;
    let shouldAutoExecute = false;

    if (args.outcome.kind === "results") {
      const action = await ctx.db.get(args.actionId);
      if (!action || action.actionType !== "format") {
        return { accepted: false as const, shouldAutoExecute: false };
      }
      const result = await completeActionWithResultsInTransaction(ctx, {
        actionId: args.actionId,
        proposedChanges: args.outcome.proposedChanges,
        chatHistory: args.outcome.chatHistory,
        requireApproval: args.outcome.requireApproval,
      });
      if (!result.accepted || !result.workflow) {
        return { accepted: false as const, shouldAutoExecute: false };
      }
      workflow = result.workflow;
      shouldAutoExecute = result.shouldAutoExecute;
    } else {
      const action = await ctx.db.get(args.actionId);
      if (
        !action ||
        action.actionType !== "format" ||
        action.status !== "pending" ||
        action.executionClaimedAt !== undefined ||
        action.executionResult !== undefined
      ) {
        return { accepted: false as const, shouldAutoExecute: false };
      }
      const access = await getActiveTicketWorkflow(ctx, action.ticketId);
      if (!access.active) {
        await failNonterminalAction(ctx, action, access.reason);
        return { accepted: false as const, shouldAutoExecute: false };
      }
      workflow = access.workflow;
      await cancelResultRecovery(ctx, action);
      await ctx.db.patch(action._id, {
        status: args.outcome.kind === "failed" ? "failed" : "completed",
        ...(args.outcome.kind === "failed"
          ? { errorMessage: args.outcome.errorMessage }
          : {}),
        completedAt: Date.now(),
        ...clearedResultRecovery(),
      });
    }

    const shouldScheduleAnswer =
      workflow.ticket.ticketType === "discussion"
        ? workflow.repository.settings.autoAnswerDiscussionQuestions
        : workflow.repository.settings.autoAnswerQuestions;
    if (shouldScheduleAnswer) {
      await scheduleInitialAnswerInTransaction(ctx, workflow);
    }
    return { accepted: true as const, shouldAutoExecute };
  },
});

/**
 * Add chat message
 */
export const addChatMessage = internalMutation({
  args: {
    actionId: v.id("ticketActions"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.actionId);
    if (!action) {
      throw new Error("Action not found");
    }

    const newMessage = {
      role: args.role,
      content: args.content,
      timestamp: Date.now(),
    };

    await ctx.db.patch(args.actionId, {
      chatHistory: [...action.chatHistory, newMessage],
    });
  },
});

/**
 * Set user feedback (for request changes)
 */
export const setUserFeedback = internalMutation({
  args: {
    actionId: v.id("ticketActions"),
    feedback: v.string(),
  },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.actionId);
    if (!action) throw new Error("Action not found");
    const access = await getActiveTicketWorkflow(ctx, action.ticketId);
    if (!access.active) throw new Error(access.reason);
    await cancelResultRecovery(ctx, action);
    await ctx.db.patch(action._id, {
      userFeedback: args.feedback,
      status: "pending", // Reset to pending for regeneration
      proposalVersion: action.proposalVersion + 1,
      ...clearedResultRecovery(),
    });
  },
});

/** Complete only the exact execution claim that performed or reconciled it. */
export const completeClaimedExecution = internalMutation({
  args: {
    actionId: v.id("ticketActions"),
    expectedClaimedAt: v.number(),
    expectedProposalVersion: v.number(),
    result: v.any(),
  },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.actionId);
    if (
      !action ||
      action.status !== "approved" ||
      action.executionResult !== undefined ||
      action.executionClaimedAt !== args.expectedClaimedAt ||
      action.proposalVersion !== args.expectedProposalVersion
    ) {
      return false;
    }
    await cancelResultRecovery(ctx, action);
    await ctx.db.patch(action._id, {
      executionResult: args.result,
      status: "completed",
      completedAt: Date.now(),
      ...clearedResultRecovery(),
      executionIdempotencyKey: action.executionIdempotencyKey,
      executionRecoveryMode: action.executionRecoveryMode,
    });
    return true;
  },
});

/**
 * Create a follow-up action from a comment (triggered by webhook)
 * Now includes previous comments as chat history context
 */
export const createFollowUp = internalMutation({
  args: {
    ticketId: v.id("tickets"),
    commentId: v.number(),
    requestedByUserId: v.optional(v.id("users")),
    commentNodeId: v.optional(v.string()), // GraphQL node ID for replying
    commentBody: v.string(),
    commentAuthor: v.string(),
    commentAuthorRole: v.optional(v.string()), // OWNER, MEMBER, COLLABORATOR, etc.
    previousComments: v.optional(
      v.array(
        v.object({
          id: v.union(v.number(), v.string()),
          body: v.string(),
          author: v.string(),
          authorRole: v.optional(v.string()), // OWNER, MEMBER, COLLABORATOR, etc.
          isGitdogBot: v.boolean(),
          createdAt: v.string(),
        }),
      ),
    ),
  },
  handler: async (ctx, args) => {
    console.log("Creating follow-up action for ticket:", args.ticketId);
    console.log("Previous comments count:", args.previousComments?.length ?? 0);

    const access = await getActiveTicketWorkflow(ctx, args.ticketId);
    if (!access.active) return null;

    const existingAction = await ctx.db
      .query("ticketActions")
      .withIndex("by_ticket_and_source_comment", (q) =>
        q.eq("ticketId", args.ticketId).eq("sourceCommentId", args.commentId),
      )
      .first();
    if (existingAction?.actionType === "follow_up") {
      console.log(
        "Skipping duplicate follow-up delivery for comment:",
        args.commentId,
      );
      return null;
    }

    const now = Date.now();
    const promptCommentBody =
      normalizeGitdogMentionBody(args.commentBody) || args.commentBody;

    const chatHistory = buildFollowUpChatHistory(
      args.previousComments,
      {
        id: args.commentId,
        nodeId: args.commentNodeId,
        body: promptCommentBody,
        author: args.commentAuthor,
      },
      now,
    );

    // Create a follow-up action with the chat history
    const actionId = await ctx.db.insert("ticketActions", {
      ticketId: args.ticketId,
      sourceCommentId: args.commentId,
      requestedByUserId: args.requestedByUserId,
      actionType: "follow_up",
      chatHistory,
      proposedChanges: {
        commentId: args.commentId,
        commentNodeId: args.commentNodeId, // For replying to specific comment
        sourceCommentBody: promptCommentBody,
        sourceCommentRawBody: args.commentBody,
        author: args.commentAuthor,
        authorRole: args.commentAuthorRole,
      },
      proposalVersion: 1,
      status: "pending",
      createdAt: now,
    });

    await armPendingGeneration(
      ctx,
      actionId,
      {
        kind: "follow_up",
        expectedAiInputVersion: access.workflow.ticket.aiInputVersion,
        expectedIndexVersion: access.workflow.repository.indexVersion,
      },
      now,
    );

    // Scheduling inside the mutation keeps delivery deduplication and work
    // creation atomic. If scheduling fails, the insert is rolled back and a
    // GitHub redelivery can retry the whole operation safely.
    await ctx.scheduler.runAfter(
      0,
      internal.ticketActions.internalAction.processFollowUp,
      { actionId },
    );

    console.log(
      "Created follow-up action:",
      actionId,
      "with",
      chatHistory.length,
      "messages in history",
    );
    return actionId;
  },
});
