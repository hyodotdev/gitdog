import { internalAction, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { v } from "convex/values";
import { getDefaultAiModel, type AiProvider } from "../_ai/model";
import {
  resolveGenerationProvider,
  UserApiKeyError,
  usesUserKey,
} from "../_ai/providerResolution";
import { ChatProviderRequestError } from "../_ai/providerErrors";
import { analyzeIssueFormatting } from "../_ai/issueFormatting/workflow";
import { analyzeIssueWithTools } from "../_ai/issueAnalysis/agenticWorkflow";
import {
  ISSUE_FORMATTING_SYSTEM_PROMPT,
  createIssueFormattingUserPrompt,
} from "../_ai/issueFormatting/prompts";
import {
  updateIssue,
  addIssueComment,
  updateDiscussion,
  addDiscussionComment,
  addDiscussionReply,
  getRepositoryMaintainers,
  getIssue,
  getDiscussion,
  getIssueComment,
  getDiscussionComment,
  isGitdogInvocationUnchanged,
} from "../github/helpers";
import {
  validateAiResponse,
  logValidationWarning,
} from "../_ai/responseValidation";
import { buildFormattedGitdogBody } from "../_utils/gitdogFormat";
import {
  calculateReadinessRetryDelay,
  getRepositoryAiReadiness,
  getReadinessRetryWindow,
} from "../repositories/aiReadiness";
import {
  hasVerifiedActiveRepositoryInstallation,
  resolveVerifiedRepositoryAccess,
} from "../github/repositoryIdentity";
import {
  AI_LEGAL_ATTESTATION_REQUIRED_MESSAGE,
  guardAiProviderWithCurrentLegalAttestation,
  hasCurrentAiLegalAttestation,
  requireCurrentAiLegalAttestation,
} from "../_ai/legalAttestation";
import { createMeteredProvider, ChatBillingError } from "../_ai/chatBilling";
import { getProviderStartRetryWindow } from "../_ai/chatRecovery";
import {
  getConfiguredGitdogMention,
  getGitdogFollowUpFooter,
} from "../github/botIdentity";
import {
  attachExecutionMarker,
  buildMarkedResponseComment,
  CLAIMED_EXECUTION_RECOVERY_GRACE_MS,
  stripExecutionMarkers,
} from "../ticketActions/executionRecovery";

const FOOTER_MESSAGE = getGitdogFollowUpFooter();

function getProviderRetryAttempt(attempt?: number): number {
  return attempt !== undefined && Number.isSafeInteger(attempt) && attempt >= 0
    ? attempt
    : 0;
}

function isReservationIdentityMismatch(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === "AI chat reservation identity mismatch"
  );
}

export async function terminalizeConfirmedNotBilledInitialFailure(
  error: unknown,
  actionId: Id<"ticketActions">,
  failPendingGeneration: (
    actionId: Id<"ticketActions">,
    errorMessage: string,
  ) => Promise<void>,
): Promise<boolean> {
  if (
    !(error instanceof ChatProviderRequestError) ||
    error.billingOutcome !== "not_billed"
  ) {
    return false;
  }

  await failPendingGeneration(actionId, error.message);
  return true;
}
// Fetch real, mentionable repo maintainers for prompt injection. Failure is
// non-fatal — the AI prompt has a fallback rule that forbids @-mentioning
// anyone as "the maintainer" when the list is empty.
async function fetchRepositoryMaintainersSafe(
  ctx: ActionCtx,
  repositoryId: Id<"repositories">,
): Promise<string[]> {
  try {
    const { owner, repo, token } = await resolveVerifiedRepositoryAccess(
      ctx,
      repositoryId,
    );
    return await getRepositoryMaintainers(owner, repo, token);
  } catch {
    console.error("[fetchRepositoryMaintainersSafe] Failed");
    return [];
  }
}

/**
 * Process a new ticket - analyze and create appropriate actions
 */
export const processNewTicket = internalAction({
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
  handler: async (ctx, args): Promise<void> => {
    let answerActionId = args.answerActionId;
    const existingAnswer = answerActionId
      ? await ctx.runQuery(internal.ticketActions.internalQuery.getById, {
          actionId: answerActionId,
        })
      : null;
    if (
      answerActionId &&
      (!existingAnswer ||
        existingAnswer.ticketId !== args.ticketId ||
        existingAnswer.actionType !== "answer" ||
        existingAnswer.status !== "pending")
    ) {
      return;
    }
    const answerProposalVersion = existingAnswer?.proposalVersion ?? 0;
    const failPendingGeneration = async (
      actionId: Id<"ticketActions">,
      errorMessage: string,
    ): Promise<void> => {
      const action = await ctx.runQuery(
        internal.ticketActions.internalQuery.getById,
        { actionId },
      );
      if (action?.status !== "pending") return;
      await ctx.runMutation(
        internal.ticketActions.internalMutation.failPendingAction,
        {
          actionId,
          expectedProposalVersion:
            actionId === answerActionId
              ? answerProposalVersion
              : action.proposalVersion,
          errorMessage,
        },
      );
    };
    const replaceStaleGeneration = async (
      actionId: Id<"ticketActions">,
    ): Promise<boolean> =>
      await ctx.runMutation(
        internal._ai.chatBilling.replaceStalePendingGeneration,
        {
          ticketActionId: actionId,
          expectedProposalVersion:
            actionId === answerActionId ? answerProposalVersion : undefined,
        },
      );
    const pendingActionId = args.formatActionId ?? args.answerActionId;
    const initialProcessingGeneration = args.initialProcessingGeneration;
    const initialClaimActive = pendingActionId
      ? true
      : initialProcessingGeneration !== undefined &&
        (await ctx.runMutation(
          internal.tickets.internalMutation.refreshInitialTicketProcessingLease,
          {
            ticketId: args.ticketId,
            expectedAiInputVersion: args.expectedAiInputVersion,
            initialProcessingGeneration,
          },
        ));
    if (!initialClaimActive) return;
    const clearInitialClaim = async (
      preserveForReopen = false,
    ): Promise<void> => {
      if (pendingActionId) return;
      if (initialProcessingGeneration === undefined) return;
      await ctx.runMutation(
        internal.tickets.internalMutation.clearInitialTicketProcessing,
        {
          ticketId: args.ticketId,
          expectedAiInputVersion: args.expectedAiInputVersion,
          initialProcessingGeneration,
          preserveForReopen,
        },
      );
    };
    const failInitialClaim = async (errorMessage: string): Promise<boolean> => {
      if (pendingActionId || initialProcessingGeneration === undefined) {
        return false;
      }
      const actionId = await ctx.runMutation(
        internal.tickets.internalMutation
          .completeInitialTicketProcessingWithFailure,
        {
          ticketId: args.ticketId,
          expectedAiInputVersion: args.expectedAiInputVersion,
          initialProcessingGeneration,
          errorMessage,
        },
      );
      return actionId !== null;
    };
    if (pendingActionId) {
      await ctx.runMutation(
        internal.ticketActions.internalMutation.refreshPendingGenerationLease,
        {
          actionId: pendingActionId,
          providerRetryStartedAt: args.providerRetryStartedAt,
        },
      );
    }
    console.log(
      "[processNewTicket] Starting analysis for ticket:",
      args.ticketId,
    );

    // Get ticket to check type
    const ticket = await ctx.runQuery(internal.tickets.internalQuery.getById, {
      ticketId: args.ticketId,
    });

    if (!ticket) {
      console.log("[processNewTicket] Ticket not found");
      if (pendingActionId) {
        await failPendingGeneration(pendingActionId, "Ticket no longer exists");
      }
      return;
    }

    if (ticket.status !== "open") {
      console.log("[processNewTicket] Ticket is no longer open, skipping");
      if (pendingActionId) {
        await failPendingGeneration(
          pendingActionId,
          "Ticket closed before AI generation completed",
        );
      }
      await clearInitialClaim(true);
      return;
    }
    if (ticket.githubStateAttestationPending === true) {
      console.log(
        "[processNewTicket] Waiting for authoritative GitHub state attestation",
      );
      return;
    }
    if (ticket.aiInputVersion !== args.expectedAiInputVersion) {
      console.log("[processNewTicket] Ticket input epoch changed, skipping");
      if (pendingActionId) {
        await replaceStaleGeneration(pendingActionId);
      }
      return;
    }

    const repository = await ctx.runQuery(
      internal.repositories.internalQuery.getById,
      { repositoryId: args.repositoryId },
    );

    if (!repository) {
      console.log("[processNewTicket] Repository not found");
      if (pendingActionId) {
        await failPendingGeneration(
          pendingActionId,
          "Repository no longer exists",
        );
      }
      await failInitialClaim("Repository no longer exists");
      return;
    }

    const isDiscussion = ticket.ticketType === "discussion";
    const assistantEnabled = isDiscussion
      ? repository.settings.discussionAssistantEnabled
      : repository.settings.issueAssistantEnabled;
    if (!assistantEnabled) {
      console.log(
        `[processNewTicket] ${isDiscussion ? "Discussion" : "Issue"} Assistant is disabled, skipping`,
      );
      if (pendingActionId) {
        await failPendingGeneration(
          pendingActionId,
          "Repository assistant is disabled",
        );
      }
      await failInitialClaim("Repository assistant is disabled");
      return;
    }

    const processingStage = args.processingStage ?? "start";
    const settings = repository.settings;
    const requireApproval = isDiscussion
      ? settings.requireApprovalForDiscussions
      : settings.requireApproval;
    const shouldAutoFormat = isDiscussion
      ? settings.autoFormatDiscussion
      : settings.autoFormatIssue;
    const shouldAutoAnswer = isDiscussion
      ? settings.autoAnswerDiscussionQuestions
      : settings.autoAnswerQuestions;
    if (
      processingStage === "start" &&
      args.formatActionId &&
      !shouldAutoFormat
    ) {
      await ctx.runMutation(
        internal.ticketActions.internalMutation
          .completeInitialFormatAndScheduleAnswer,
        {
          actionId: args.formatActionId,
          outcome: { kind: "completed" },
        },
      );
      return;
    }
    if (
      processingStage === "answer" &&
      args.answerActionId &&
      !shouldAutoAnswer
    ) {
      await ctx.runMutation(
        internal.ticketActions.internalMutation.updateStatus,
        {
          actionId: args.answerActionId,
          expectedProposalVersion: answerProposalVersion,
          status: "completed",
        },
      );
      return;
    }
    if (
      !args.formatActionId &&
      !args.answerActionId &&
      !shouldAutoFormat &&
      !shouldAutoAnswer
    ) {
      await clearInitialClaim();
      return;
    }

    const issueTitle = ticket.githubTitle;
    const rawIssueBody = ticket.githubBody || "";
    const issueBody = stripExecutionMarkers(rawIssueBody);
    const readinessRetryAttempt = args.readinessRetryAttempt ?? 0;
    const providerRetryAttempt = getProviderRetryAttempt(
      args.providerRetryAttempt,
    );
    const scheduleReadinessRetry = async (
      stage: "start" | "answer",
      observedRepository: typeof repository,
      expectedIndexVersion: number,
      reason: string,
      actionIds: {
        formatActionId?: Id<"ticketActions">;
        answerActionId?: Id<"ticketActions">;
      } = {},
    ): Promise<void> => {
      const retryWindow = getReadinessRetryWindow(observedRepository, {
        startedAt: args.readinessStartedAt,
        progressAt: args.readinessProgressAt,
        progressKey: args.readinessProgressKey,
      });
      if (retryWindow.timeoutReason) {
        const pendingActionId =
          actionIds.formatActionId ??
          actionIds.answerActionId ??
          args.formatActionId ??
          args.answerActionId;
        if (pendingActionId) {
          await failPendingGeneration(
            pendingActionId,
            retryWindow.timeoutReason,
          );
        } else {
          console.error(
            `[processNewTicket] Readiness wait expired: ${retryWindow.timeoutReason}`,
          );
          await failInitialClaim(retryWindow.timeoutReason);
        }
        return;
      }

      const delayMs = calculateReadinessRetryDelay(readinessRetryAttempt);
      const retryActionId =
        actionIds.formatActionId ??
        actionIds.answerActionId ??
        args.formatActionId ??
        args.answerActionId;
      if (retryActionId) {
        await ctx.runMutation(
          internal.ticketActions.internalMutation.refreshPendingGenerationLease,
          {
            actionId: retryActionId,
            providerRetryStartedAt: args.providerRetryStartedAt,
          },
        );
      }
      console.log(
        `[processNewTicket] Deferring ${stage} stage for ${delayMs}ms: ${reason}`,
      );
      const continuationArgs = {
        ticketId: args.ticketId,
        repositoryId: args.repositoryId,
        issueTitle,
        issueBody: rawIssueBody,
        expectedAiInputVersion: args.expectedAiInputVersion,
        expectedIndexVersion,
        processingStage: stage,
        readinessRetryAttempt: readinessRetryAttempt + 1,
        readinessStartedAt: retryWindow.startedAt,
        readinessProgressAt: retryWindow.progressAt,
        readinessProgressKey: retryWindow.progressKey,
        providerRetryAttempt,
        providerRetryStartedAt: args.providerRetryStartedAt,
        replayReservationKey: args.replayReservationKey,
        formatActionId: actionIds.formatActionId ?? args.formatActionId,
        answerActionId: actionIds.answerActionId ?? args.answerActionId,
        initialProcessingGeneration,
      };
      if (!retryActionId && initialProcessingGeneration !== undefined) {
        await ctx.runMutation(
          internal.tickets.internalMutation
            .scheduleInitialTicketProcessingContinuation,
          {
            ticketId: args.ticketId,
            repositoryId: args.repositoryId,
            expectedAiInputVersion: args.expectedAiInputVersion,
            initialProcessingGeneration,
            expectedIndexVersion,
            processingStage: stage,
            delayMs,
            readinessRetryAttempt: readinessRetryAttempt + 1,
            readinessStartedAt: retryWindow.startedAt,
            readinessProgressAt: retryWindow.progressAt,
            readinessProgressKey: retryWindow.progressKey,
          },
        );
      } else {
        await ctx.scheduler.runAfter(
          delayMs,
          internal.tickets.internalAction.processNewTicket,
          continuationArgs,
        );
      }
    };

    const scheduleProviderRetry = async (
      stage: "start" | "answer",
      actionIds: {
        formatActionId?: Id<"ticketActions">;
        answerActionId?: Id<"ticketActions">;
      },
      reason: ChatBillingError["reason"],
    ): Promise<void> => {
      const retryWindow = getProviderStartRetryWindow(
        args.providerRetryStartedAt,
      );
      if (retryWindow.timeoutReason) {
        const actionId = actionIds.formatActionId ?? actionIds.answerActionId;
        if (actionId) {
          await failPendingGeneration(actionId, retryWindow.timeoutReason);
        }
        return;
      }
      void reason;
      const delayMs = calculateReadinessRetryDelay(providerRetryAttempt);
      const retryActionId =
        actionIds.formatActionId ?? actionIds.answerActionId;
      if (retryActionId) {
        await ctx.runMutation(
          internal.ticketActions.internalMutation.refreshPendingGenerationLease,
          {
            actionId: retryActionId,
            providerRetryStartedAt: retryWindow.startedAt,
          },
        );
      }
      console.log(
        `[processNewTicket] Deferring ${stage} provider start for ${delayMs}ms`,
      );
      await ctx.scheduler.runAfter(
        delayMs,
        internal.tickets.internalAction.processNewTicket,
        {
          ticketId: args.ticketId,
          repositoryId: args.repositoryId,
          issueTitle,
          issueBody: rawIssueBody,
          expectedAiInputVersion: args.expectedAiInputVersion,
          expectedIndexVersion: args.expectedIndexVersion,
          processingStage: stage,
          readinessRetryAttempt: args.readinessRetryAttempt,
          readinessStartedAt: args.readinessStartedAt,
          readinessProgressAt: args.readinessProgressAt,
          readinessProgressKey: args.readinessProgressKey,
          providerRetryAttempt: providerRetryAttempt + 1,
          providerRetryStartedAt: retryWindow.startedAt,
          replayReservationKey: args.replayReservationKey,
          ...actionIds,
        },
      );
    };

    const readiness = getRepositoryAiReadiness(repository);
    if (readiness.state === "waiting") {
      await scheduleReadinessRetry(
        processingStage,
        repository,
        readiness.indexVersion,
        readiness.reason,
      );
      return;
    }
    if (readiness.state === "blocked") {
      console.log(
        `[processNewTicket] Repository AI processing is blocked: ${readiness.reason}`,
      );
      await failInitialClaim(readiness.reason);
      return;
    }
    if (
      args.expectedIndexVersion !== undefined &&
      args.expectedIndexVersion !== readiness.indexVersion
    ) {
      if (pendingActionId && (await replaceStaleGeneration(pendingActionId))) {
        return;
      }
      await scheduleReadinessRetry(
        processingStage,
        repository,
        readiness.indexVersion,
        `repository index version changed from ${args.expectedIndexVersion} to ${readiness.indexVersion}`,
      );
      return;
    }
    if (!(await hasVerifiedActiveRepositoryInstallation(ctx, repository))) {
      await scheduleReadinessRetry(
        processingStage,
        repository,
        readiness.indexVersion,
        "repository installation access is not active",
      );
      return;
    }

    if (!(await hasCurrentAiLegalAttestation(ctx, ticket.userId))) {
      if (pendingActionId) {
        await failPendingGeneration(
          pendingActionId,
          AI_LEGAL_ATTESTATION_REQUIRED_MESSAGE,
        );
        return;
      }
      await failInitialClaim(AI_LEGAL_ATTESTATION_REQUIRED_MESSAGE);
      return;
    }

    const stableIndexVersion = readiness.indexVersion;

    const replayActionId =
      processingStage === "start" ? args.formatActionId : args.answerActionId;
    const replayAuthorized =
      args.replayReservationKey && replayActionId
        ? await ctx.runQuery(
            internal._ai.chatBilling.canReplayCheckpointedChatResult,
            {
              ticketActionId: replayActionId,
              reservationKey: args.replayReservationKey,
            },
          )
        : false;
    if (args.replayReservationKey && !replayAuthorized) {
      if (replayActionId) {
        const replayAction = await ctx.runQuery(
          internal.ticketActions.internalQuery.getById,
          { actionId: replayActionId },
        );
        if (replayAction?.status === "pending") {
          await ctx.runMutation(
            internal.ticketActions.internalMutation.failPendingAction,
            {
              actionId: replayActionId,
              expectedProposalVersion: replayAction.proposalVersion,
              errorMessage: "AI result checkpoint is no longer replayable",
            },
          );
        }
      }
      return;
    }

    let rawAiProvider: AiProvider;
    try {
      rawAiProvider = await resolveGenerationProvider(ctx, {
        userId: ticket.userId,
        ticketActionId: pendingActionId,
      });
    } catch (error) {
      if (!(error instanceof UserApiKeyError)) throw error;
      // A checkpointed result replays without calling any provider, so a
      // removed or failing key must not block it.
      if (replayAuthorized) rawAiProvider = getDefaultAiModel();
      else if (pendingActionId) {
        await failPendingGeneration(pendingActionId, error.message);
        return;
      } else {
        await failInitialClaim(error.message);
        return;
      }
    }

    // Replaying an already billed checkpoint spends no new quota, and a
    // request on the owner's own key spends none of Gitdog's.
    const canPerform =
      replayAuthorized || usesUserKey(rawAiProvider)
        ? { allowed: true as const }
        : await ctx.runQuery(
            internal.subscriptions.internalQuery.canPerformActionInternal,
            { userId: ticket.userId },
          );

    if (!canPerform.allowed) {
      console.log(
        "[processNewTicket] User cannot perform action:",
        canPerform.reason,
      );
      console.log("[processNewTicket] Message:", canPerform.message);

      if (pendingActionId) {
        await failPendingGeneration(
          pendingActionId,
          canPerform.message || "Token limit reached.",
        );
        return;
      }

      const limitErrorMessage =
        canPerform.message ||
        "Token limit reached. Please add a prepaid token pack or upgrade to Pro to continue.";
      if (!(await failInitialClaim(limitErrorMessage))) return;

      // Post a comment to GitHub notifying about the limit
      try {
        const { owner, repo, token } = await resolveVerifiedRepositoryAccess(
          ctx,
          args.repositoryId,
        );
        const limitMessage = `⚠️ **Token limit reached**

Sorry, the repository owner's available token balance for this billing period is exhausted.

**Current usage:** ${(canPerform as { tokensUsed?: number }).tokensUsed?.toLocaleString() ?? "N/A"} / ${(canPerform as { tokenLimit?: number }).tokenLimit?.toLocaleString() ?? "N/A"} tokens

To continue using ${getConfiguredGitdogMention() ?? "the Gitdog bot"}, the repository owner can buy a prepaid token pack or, on Free, upgrade to Pro at [gitdog.dev/pricing](https://gitdog.dev/pricing). There are no automatic overage charges.

---
*🤖 [gitdog.dev](https://gitdog.dev)*`;

        if (isDiscussion) {
          await addDiscussionComment(
            owner,
            repo,
            ticket.githubNumber,
            limitMessage,
            token,
          );
        } else {
          await addIssueComment(
            owner,
            repo,
            ticket.githubNumber,
            limitMessage,
            token,
          );
        }

        console.log(
          "[processNewTicket] Posted token limit notification to GitHub",
        );
      } catch {
        console.error(
          "[processNewTicket] Failed to post limit notification to GitHub",
        );
      }

      return;
    }

    if (processingStage === "start" && shouldAutoFormat) {
      console.log(
        "[processNewTicket] Creating format action in pending state...",
      );

      let formatActionId = args.formatActionId;
      if (formatActionId) {
        const existingAction = await ctx.runQuery(
          internal.ticketActions.internalQuery.getById,
          { actionId: formatActionId },
        );
        if (
          !existingAction ||
          existingAction.ticketId !== args.ticketId ||
          existingAction.actionType !== "format" ||
          existingAction.status !== "pending"
        ) {
          console.error(
            "[processNewTicket] Pending format retry action is unavailable",
          );
          return;
        }
      } else {
        formatActionId = await ctx.runMutation(
          internal.ticketActions.internalMutation.create,
          {
            ticketId: args.ticketId,
            actionType: "format",
            pendingGenerationTarget: {
              kind: "initial_ticket",
              stage: "start",
              expectedAiInputVersion: ticket.aiInputVersion,
              expectedIndexVersion: stableIndexVersion,
            },
            initialProcessingGeneration,
          },
        );
      }

      console.log("[processNewTicket] Analyzing issue formatting...");

      const formatStartTime = Date.now();
      const formatUserPrompt = createIssueFormattingUserPrompt(
        issueTitle,
        issueBody,
      );

      if (!(await hasVerifiedActiveRepositoryInstallation(ctx, repository))) {
        await scheduleReadinessRetry(
          "start",
          repository,
          stableIndexVersion,
          "repository installation access changed before formatting analysis",
          { formatActionId },
        );
        return;
      }

      if (!(await hasCurrentAiLegalAttestation(ctx, ticket.userId))) {
        await ctx.runMutation(
          internal.ticketActions.internalMutation.updateStatus,
          {
            actionId: formatActionId,
            status: "failed",
            errorMessage: AI_LEGAL_ATTESTATION_REQUIRED_MESSAGE,
          },
        );
        return;
      }

      const formattingProvider = guardAiProviderWithCurrentLegalAttestation(
        ctx,
        ticket.userId,
        createMeteredProvider(ctx, {
          userId: ticket.userId,
          repositoryId: args.repositoryId,
          ticketActionId: formatActionId,
          generationKey: `ticket/${args.ticketId}/format/${formatActionId}`,
          operation: "initial-format",
          provider: rawAiProvider,
          requirePendingTicketAction: true,
          recoveryTarget: {
            kind: "initial_ticket",
            stage: "start",
            expectedAiInputVersion: ticket.aiInputVersion,
            expectedIndexVersion: stableIndexVersion,
          },
          beforeProviderStart: () =>
            requireCurrentAiLegalAttestation(ctx, ticket.userId),
        }),
      );
      let formattingResult: Awaited<ReturnType<typeof analyzeIssueFormatting>>;
      try {
        formattingResult = await analyzeIssueFormatting(
          {
            title: issueTitle,
            body: issueBody,
          },
          formattingProvider,
        );
      } catch (error) {
        if (error instanceof ChatBillingError && error.durableRetrySafe) {
          await scheduleProviderRetry(
            "start",
            { formatActionId },
            error.reason,
          );
          return;
        }
        if (
          await terminalizeConfirmedNotBilledInitialFailure(
            error,
            formatActionId,
            failPendingGeneration,
          )
        ) {
          return;
        }
        if (args.replayReservationKey && isReservationIdentityMismatch(error)) {
          await failPendingGeneration(
            formatActionId,
            "Ticket content changed after the AI result was generated",
          );
          return;
        }
        throw error;
      }

      const formatDurationMs = Date.now() - formatStartTime;

      // Create AI log for formatting action (non-blocking - don't fail the workflow)
      try {
        await ctx.runMutation(internal.admin.internalMutation.createAiLog, {
          ticketId: args.ticketId,
          ticketActionId: formatActionId,
          repositoryId: args.repositoryId,
          userId: ticket.userId,
          workflowType: "issue_formatting",
          actionType: "format",
          systemPrompt: ISSUE_FORMATTING_SYSTEM_PROMPT,
          userPrompt: formatUserPrompt,
          aiResponse: formattingResult.output
            ? JSON.stringify(formattingResult.output, null, 2)
            : undefined,
          githubRepo: ticket.githubRepo,
          githubNumber: ticket.githubNumber,
          ticketTitle: issueTitle,
          ticketBody: issueBody,
          status: formattingResult.success
            ? formattingResult.output?.needsImprovement
              ? "pending_approval"
              : "success"
            : "failed",
          errorMessage: formattingResult.success
            ? undefined
            : formattingResult.errors.join(", "),
          inputTokens: formattingResult.tokenUsage?.inputTokens,
          outputTokens: formattingResult.tokenUsage?.outputTokens,
          model: formattingResult.tokenUsage?.model,
          durationMs: formatDurationMs,
        });
      } catch {
        console.error("[processNewTicket] Failed to create AI log");
      }

      if (
        formattingResult.success &&
        formattingResult.output?.needsImprovement
      ) {
        console.log("[processNewTicket] Issue needs formatting improvement");

        // At this point, output is guaranteed to exist due to the check above
        const output = formattingResult.output!;

        await ctx.runMutation(
          internal.ticketActions.internalMutation
            .completeInitialFormatAndScheduleAnswer,
          {
            actionId: formatActionId,
            outcome: {
              kind: "results",
              proposedChanges: {
                originalTitle: issueTitle,
                originalBody: rawIssueBody,
                suggestedTitle: output.suggestedTitle,
                suggestedBody: output.suggestedBody,
                changesSummary: output.changesSummary,
                reasoning: output.reasoning,
                formatValidationPassed: true,
              },
              chatHistory: [
                {
                  role: "assistant",
                  content: `I analyzed this issue and found it could benefit from formatting improvements.\n\n**Reasoning:** ${output.reasoning}\n\n**Changes:**\n${output.changesSummary}`,
                  timestamp: Date.now(),
                },
              ],
              requireApproval,
            },
          },
        );
      } else if (formattingResult.success) {
        // If no improvement is needed, close the pending action cleanly.
        console.log(
          "[processNewTicket] No formatting improvement needed, removing action",
        );
        await ctx.runMutation(
          internal.ticketActions.internalMutation
            .completeInitialFormatAndScheduleAnswer,
          {
            actionId: formatActionId,
            outcome: { kind: "completed" },
          },
        );
      } else {
        console.error("[processNewTicket] Formatting analysis failed");
        await ctx.runMutation(
          internal.ticketActions.internalMutation
            .completeInitialFormatAndScheduleAnswer,
          {
            actionId: formatActionId,
            outcome: {
              kind: "failed",
              errorMessage:
                formattingResult.errors.join(", ") ||
                "Issue formatting analysis failed",
            },
          },
        );
      }
      return;
    }

    // 2. Check if auto-answer is enabled and analyze the issue
    if (shouldAutoAnswer) {
      // Formatting can take long enough for a push to start a new index. Check
      // again before repository-grounded analysis and resume only the answer
      // stage so a formatting suggestion is not duplicated on retry.
      const latestRepository = await ctx.runQuery(
        internal.repositories.internalQuery.getById,
        { repositoryId: args.repositoryId },
      );
      if (!latestRepository) {
        console.log(
          "[processNewTicket] Repository disappeared before answer analysis",
        );
        await failInitialClaim("Repository disappeared before answer analysis");
        return;
      }

      const latestReadiness = getRepositoryAiReadiness(latestRepository);
      if (latestReadiness.state === "waiting") {
        await scheduleReadinessRetry(
          "answer",
          latestRepository,
          latestReadiness.indexVersion,
          latestReadiness.reason,
        );
        return;
      }
      if (latestReadiness.state === "blocked") {
        console.log(
          `[processNewTicket] Answer analysis blocked: ${latestReadiness.reason}`,
        );
        await failInitialClaim(latestReadiness.reason);
        return;
      }
      if (latestReadiness.indexVersion !== stableIndexVersion) {
        await scheduleReadinessRetry(
          "answer",
          latestRepository,
          latestReadiness.indexVersion,
          `repository index version changed from ${stableIndexVersion} to ${latestReadiness.indexVersion}`,
        );
        return;
      }

      const latestTicketBeforeAnswer = await ctx.runQuery(
        internal.tickets.internalQuery.getById,
        { ticketId: args.ticketId },
      );
      if (
        !latestTicketBeforeAnswer ||
        latestTicketBeforeAnswer.status !== "open"
      ) {
        console.log(
          "[processNewTicket] Ticket is no longer open before answer analysis",
        );
        await clearInitialClaim(true);
        return;
      }
      if (
        latestTicketBeforeAnswer.githubTitle !== issueTitle ||
        (latestTicketBeforeAnswer.githubBody || "") !== rawIssueBody
      ) {
        await scheduleReadinessRetry(
          "answer",
          latestRepository,
          stableIndexVersion,
          "ticket content changed before answer analysis",
        );
        return;
      }

      console.log(
        "[processNewTicket] Creating answer action in pending state...",
      );

      if (!answerActionId) {
        answerActionId = await ctx.runMutation(
          internal.ticketActions.internalMutation.create,
          {
            ticketId: args.ticketId,
            actionType: "answer",
            pendingGenerationTarget: {
              kind: "initial_ticket",
              stage: "answer",
              expectedAiInputVersion: ticket.aiInputVersion,
              expectedIndexVersion: stableIndexVersion,
            },
            initialProcessingGeneration,
          },
        );
      }
      console.log(
        "[processNewTicket] Analyzing issue with agentic workflow...",
      );

      // Use the agentic workflow so AI can explore the codebase with tools.
      // Get response style based on ticket type (issue vs discussion)
      const responseStyle = isDiscussion
        ? settings.discussionResponseStyle
        : settings.issueResponseStyle;

      console.log("[processNewTicket] Starting analyzeIssueWithTools...");
      const answerStartTime = Date.now();

      const maintainers = await fetchRepositoryMaintainersSafe(
        ctx,
        args.repositoryId,
      );

      if (
        !(await hasVerifiedActiveRepositoryInstallation(ctx, latestRepository))
      ) {
        await scheduleReadinessRetry(
          "answer",
          latestRepository,
          stableIndexVersion,
          "repository installation access changed before answer analysis",
          { answerActionId },
        );
        return;
      }

      if (!(await hasCurrentAiLegalAttestation(ctx, ticket.userId))) {
        await ctx.runMutation(
          internal.ticketActions.internalMutation.updateStatus,
          {
            actionId: answerActionId,
            expectedProposalVersion: answerProposalVersion,
            status: "failed",
            errorMessage: AI_LEGAL_ATTESTATION_REQUIRED_MESSAGE,
          },
        );
        return;
      }

      const answerGenerationKey = `ticket/${args.ticketId}/answer/${answerActionId}/${stableIndexVersion}`;
      const answerProvider = guardAiProviderWithCurrentLegalAttestation(
        ctx,
        ticket.userId,
        createMeteredProvider(ctx, {
          userId: ticket.userId,
          repositoryId: args.repositoryId,
          ticketActionId: answerActionId,
          generationKey:
            answerProposalVersion === 0
              ? answerGenerationKey
              : `${answerGenerationKey}/proposal/${answerProposalVersion}`,
          operation: "initial-answer",
          provider: rawAiProvider,
          requirePendingTicketAction: true,
          recoveryTarget: {
            kind: "initial_ticket",
            stage: "answer",
            expectedAiInputVersion: ticket.aiInputVersion,
            expectedIndexVersion: stableIndexVersion,
          },
          beforeProviderStart: () =>
            requireCurrentAiLegalAttestation(ctx, ticket.userId),
        }),
      );
      let analysisResult: Awaited<ReturnType<typeof analyzeIssueWithTools>>;
      try {
        analysisResult = await analyzeIssueWithTools(
          ctx,
          args.repositoryId,
          {
            title: issueTitle,
            body: issueBody,
          },
          answerProvider,
          {
            responseStyle,
            repositoryLanguage: repository.language,
            maintainers,
            indexVersion: stableIndexVersion,
            embeddingDataProvenance: "public_github",
          },
        );
      } catch (error) {
        if (error instanceof ChatBillingError && error.durableRetrySafe) {
          await scheduleProviderRetry(
            "answer",
            { answerActionId },
            error.reason,
          );
          return;
        }
        if (
          await terminalizeConfirmedNotBilledInitialFailure(
            error,
            answerActionId,
            failPendingGeneration,
          )
        ) {
          return;
        }
        if (args.replayReservationKey && isReservationIdentityMismatch(error)) {
          await failPendingGeneration(
            answerActionId,
            "Ticket content changed after the AI result was generated",
          );
          return;
        }
        throw error;
      }
      const answerDurationMs = Date.now() - answerStartTime;
      console.log("[processNewTicket] analyzeIssueWithTools completed!");

      // Both the ticket and repository can change while the multi-turn agent
      // is running. Never save or publish a result produced from a stale
      // ticket snapshot or a different repository index generation.
      const [repositoryAfterAnalysis, ticketAfterAnalysis] = await Promise.all([
        ctx.runQuery(internal.repositories.internalQuery.getById, {
          repositoryId: args.repositoryId,
        }),
        ctx.runQuery(internal.tickets.internalQuery.getById, {
          ticketId: args.ticketId,
        }),
      ]);

      if (!ticketAfterAnalysis || ticketAfterAnalysis.status !== "open") {
        await failPendingGeneration(
          answerActionId,
          "Ticket changed or closed during AI analysis",
        );
        return;
      }

      const ticketContentChanged =
        ticketAfterAnalysis.githubTitle !== issueTitle ||
        (ticketAfterAnalysis.githubBody || "") !== rawIssueBody;
      const readinessAfterAnalysis = repositoryAfterAnalysis
        ? getRepositoryAiReadiness(repositoryAfterAnalysis)
        : null;
      const installationActiveAfterAnalysis = repositoryAfterAnalysis
        ? await hasVerifiedActiveRepositoryInstallation(
            ctx,
            repositoryAfterAnalysis,
          )
        : false;
      if (ticketContentChanged) {
        if (!(await replaceStaleGeneration(answerActionId))) {
          await failPendingGeneration(
            answerActionId,
            "Ticket content changed during AI analysis",
          );
        }
        return;
      }
      if (!repositoryAfterAnalysis) {
        await failPendingGeneration(
          answerActionId,
          "Repository disappeared during AI analysis",
        );
        return;
      }
      if (
        readinessAfterAnalysis &&
        readinessAfterAnalysis.indexVersion !== stableIndexVersion
      ) {
        if (!(await replaceStaleGeneration(answerActionId))) {
          await failPendingGeneration(
            answerActionId,
            "Repository index version changed during AI analysis",
          );
        }
        return;
      }
      if (
        !installationActiveAfterAnalysis ||
        readinessAfterAnalysis?.state !== "ready"
      ) {
        const retryReason = !installationActiveAfterAnalysis
          ? "repository installation access changed during AI analysis"
          : readinessAfterAnalysis && readinessAfterAnalysis.state !== "ready"
            ? readinessAfterAnalysis.reason
            : "repository became unavailable during AI analysis";
        await scheduleReadinessRetry(
          "answer",
          repositoryAfterAnalysis,
          readinessAfterAnalysis?.indexVersion ?? stableIndexVersion,
          retryReason,
          { answerActionId },
        );
        return;
      }
      if (readinessAfterAnalysis.indexVersion !== stableIndexVersion) {
        if (!(await replaceStaleGeneration(answerActionId))) {
          await failPendingGeneration(
            answerActionId,
            "Repository index version changed during AI analysis",
          );
        }
        return;
      }

      const assistantEnabledAfterAnalysis = isDiscussion
        ? repositoryAfterAnalysis.settings.discussionAssistantEnabled
        : repositoryAfterAnalysis.settings.issueAssistantEnabled;
      if (!assistantEnabledAfterAnalysis) {
        await ctx.runMutation(
          internal.ticketActions.internalMutation.updateStatus,
          {
            actionId: answerActionId,
            expectedProposalVersion: answerProposalVersion,
            status: "failed",
            errorMessage: "Repository assistant was disabled during analysis",
          },
        );
        return;
      }
      const answerRequireApproval = isDiscussion
        ? repositoryAfterAnalysis.settings.requireApprovalForDiscussions
        : repositoryAfterAnalysis.settings.requireApproval;

      // Create AI log for answer action (non-blocking - don't fail the workflow)
      try {
        await ctx.runMutation(internal.admin.internalMutation.createAiLog, {
          ticketId: args.ticketId,
          ticketActionId: answerActionId,
          repositoryId: args.repositoryId,
          userId: ticket.userId,
          workflowType: "issue_analysis",
          actionType: "answer",
          userPrompt: `Title: ${issueTitle}\n\nBody: ${issueBody}`,
          aiResponse: analysisResult.output?.suggestedResponse,
          githubRepo: ticket.githubRepo,
          githubNumber: ticket.githubNumber,
          ticketTitle: issueTitle,
          ticketBody: issueBody,
          status: analysisResult.success
            ? analysisResult.output?.suggestedResponse
              ? answerRequireApproval
                ? "pending_approval"
                : "success"
              : "success"
            : "failed",
          errorMessage: analysisResult.success
            ? undefined
            : analysisResult.errors.join(", "),
          inputTokens: analysisResult.tokenUsage?.inputTokens,
          outputTokens: analysisResult.tokenUsage?.outputTokens,
          model: analysisResult.tokenUsage?.model,
          durationMs: answerDurationMs,
        });
      } catch {
        console.error("[processNewTicket] Failed to create AI log");
      }

      if (analysisResult.success && analysisResult.output) {
        const { issueType, suggestedResponse, isActionable, confidence } =
          analysisResult.output;

        console.log("[processNewTicket] Issue analysis result:", {
          issueType,
          isActionable,
          hasSuggestedResponse: !!suggestedResponse,
        });
        // If we have a suggested response (for questions, docs, discussions, needs_more_info)
        if (suggestedResponse) {
          // Validate AI response before saving (prevents internal field leakage and context loss)
          const responseValidation = validateAiResponse(
            suggestedResponse,
            confidence,
          );
          if (!responseValidation.isValid) {
            logValidationWarning(
              `processNewTicket ticket=${args.ticketId}`,
              responseValidation,
            );
            // Block responses with internal field leakage or internal path references
            if (
              responseValidation.leakedFields.length > 0 ||
              responseValidation.leakedInternalPaths.length > 0
            ) {
              await failPendingGeneration(
                answerActionId,
                "AI response failed deterministic safety validation",
              );
              return;
            }
          }

          console.log(
            "[processNewTicket] Creating answer action with response length:",
            suggestedResponse.length,
          );

          // Update action with results (include confidence for auto-publish gating)
          const shouldAutoExecuteAnswer = await ctx.runMutation(
            internal.ticketActions.internalMutation.completeWithResults,
            {
              actionId: answerActionId,
              expectedProposalVersion: answerProposalVersion,
              proposedChanges: {
                originalTitle: issueTitle,
                originalBody: rawIssueBody,
                groundedIndexVersion: stableIndexVersion,
                suggestedResponse,
                issueType,
                reasoning: analysisResult.output.reasoning,
                isActionable,
                confidence: analysisResult.output.confidence,
                toolsUsed: analysisResult.output.toolsUsed,
                filesRead: analysisResult.output.filesRead,
                filesReadPaths: analysisResult.output.filesReadPaths,
                toolErrors: analysisResult.output.toolErrors,
                wasRepaired: analysisResult.output.wasRepaired,
                validationPassed: analysisResult.output.validationPassed,
              },
              chatHistory: analysisResult.chatHistory || [
                {
                  role: "assistant",
                  content: suggestedResponse,
                  timestamp: Date.now(),
                },
              ],
              requireApproval: answerRequireApproval,
            },
          );

          if (shouldAutoExecuteAnswer) {
            console.log(
              "[processNewTicket] Answer execution was scheduled atomically",
            );
          }
        } else {
          // If no response generated, mark as completed
          console.log(
            "[processNewTicket] No response generated, removing action",
          );
          await ctx.runMutation(
            internal.ticketActions.internalMutation.updateStatus,
            {
              actionId: answerActionId,
              expectedProposalVersion: answerProposalVersion,
              status: "completed",
            },
          );
        }
      } else {
        // If analysis failed, mark action as failed
        console.log(
          "[processNewTicket] Analysis failed, marking action as failed",
        );
        await failPendingGeneration(
          answerActionId,
          analysisResult.errors.join(", ") || "Issue analysis failed",
        );
      }
    }

    await clearInitialClaim();
    console.log(
      "[processNewTicket] Analysis complete for ticket:",
      args.ticketId,
    );
  },
});

/**
 * Execute an approved action automatically (for auto-approval flow)
 */
export const executeAutoApprovedAction = internalAction({
  args: {
    actionId: v.id("ticketActions"),
    preflightRetryAttempt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    console.log(
      "[executeAutoApprovedAction] Starting for action:",
      args.actionId,
    );

    let terminalPreflightFailure = false;
    let ticketAction: Doc<"ticketActions"> | null = null;
    let ticket: Doc<"tickets"> | null;
    const failTerminalPreflight = async (message: string): Promise<void> => {
      if (!ticketAction) return;
      terminalPreflightFailure = await ctx.runMutation(
        internal.ticketActions.internalMutation.failExecutionAttempt,
        {
          actionId: args.actionId,
          mode: "auto_approved",
          expectedProposalVersion: ticketAction.proposalVersion,
          errorMessage: message,
        },
      );
    };
    let executionClaimedAt: number | undefined;
    try {
      const recoveryActive = await ctx.runMutation(
        internal.ticketActions.internalMutation
          .refreshAutoExecutionRecoveryLease,
        { actionId: args.actionId },
      );
      if (!recoveryActive) return;

      ticketAction = await ctx.runQuery(
        internal.ticketActions.internalQuery.getById,
        { actionId: args.actionId },
      );
      if (!ticketAction) return;

      ticket = await ctx.runQuery(internal.tickets.internalQuery.getById, {
        ticketId: ticketAction.ticketId,
      });
      if (!ticket) {
        const message = "Ticket not found";
        await failTerminalPreflight(message);
        throw new Error(message);
      }
      if (!ticket.repositoryId) {
        const message = "Ticket has no repository linked";
        await failTerminalPreflight(message);
        throw new Error(message);
      }

      let verifiedAccess = await resolveVerifiedRepositoryAccess(
        ctx,
        ticket.repositoryId,
      );
      let { owner, repo, token } = verifiedAccess;
      const ticketNumber = ticket.githubNumber;
      const isDiscussion = ticket.ticketType === "discussion";

      const originalTitle = ticketAction.proposedChanges?.originalTitle;
      const originalBody = ticketAction.proposedChanges?.originalBody;
      if (
        typeof originalTitle !== "string" ||
        typeof originalBody !== "string"
      ) {
        const message =
          "Action is missing the source ticket snapshot and cannot be executed safely";
        await failTerminalPreflight(message);
        throw new Error(message);
      }

      const liveTicket = isDiscussion
        ? await getDiscussion(owner, repo, ticketNumber, token)
        : await getIssue(owner, repo, ticketNumber, token);
      if (
        liveTicket.state !== "open" ||
        liveTicket.title !== originalTitle ||
        (liveTicket.body || "") !== originalBody
      ) {
        const message =
          "Ticket content changed after this suggestion was generated. Regenerate it before execution.";
        await failTerminalPreflight(message);
        throw new Error(message);
      }

      if (ticketAction.actionType === "follow_up") {
        const sourceCommentRawBody =
          ticketAction.proposedChanges?.sourceCommentRawBody;
        const sourceComment = isDiscussion
          ? typeof ticketAction.proposedChanges?.commentNodeId === "string"
            ? await getDiscussionComment(
                ticketAction.proposedChanges.commentNodeId,
                token,
              )
            : null
          : typeof ticketAction.proposedChanges?.commentId === "number"
            ? await getIssueComment(
                owner,
                repo,
                ticketAction.proposedChanges.commentId,
                token,
              )
            : null;
        if (
          typeof sourceCommentRawBody !== "string" ||
          !sourceComment ||
          !isGitdogInvocationUnchanged(sourceComment.body, sourceCommentRawBody)
        ) {
          const message =
            "The follow-up comment changed or was deleted during analysis. Regenerate the response.";
          await failTerminalPreflight(message);
          throw new Error(message);
        }
      }

      const executionClaim = await ctx.runMutation(
        internal.ticketActions.internalMutation.claimForExecution,
        {
          actionId: args.actionId,
          mode: "auto_approved",
          expectedProposalVersion: ticketAction.proposalVersion,
        },
      );
      if (!executionClaim.claimed) {
        if (executionClaim.refreshing) return;
        console.log(
          "[executeAutoApprovedAction] Execution was not claimed:",
          executionClaim.reason,
        );
        await ctx.runMutation(
          internal.ticketActions.internalMutation.failExecutionAttempt,
          {
            actionId: args.actionId,
            mode: "auto_approved",
            expectedProposalVersion: ticketAction.proposalVersion,
            errorMessage: executionClaim.reason,
          },
        );
        return;
      }
      executionClaimedAt = executionClaim.claimedAt;

      // The claim rechecks database ownership. Resolve the immutable GitHub
      // identity again after it so no stale mutable name can reach a write.
      verifiedAccess = await resolveVerifiedRepositoryAccess(
        ctx,
        ticket.repositoryId,
      );
      ({ owner, repo, token } = verifiedAccess);

      // Execute action based on type
      if (
        ticketAction.actionType === "format" &&
        ticketAction.proposedChanges
      ) {
        // Update issue/discussion title and body
        const suggestedTitle = ticketAction.proposedChanges.suggestedTitle;
        const suggestedBody = ticketAction.proposedChanges.suggestedBody;
        const changesSummary =
          ticketAction.proposedChanges.changesSummary ||
          "Formatting improvements";

        if (suggestedTitle || suggestedBody) {
          // Add gitdog attribution to body
          const formattedBody = buildFormattedGitdogBody(
            suggestedBody,
            changesSummary,
          );
          const markedBody = formattedBody
            ? attachExecutionMarker(
                formattedBody,
                executionClaim.idempotencyKey,
              )
            : undefined;

          // Use appropriate API based on ticket type
          if (isDiscussion) {
            await updateDiscussion(
              owner,
              repo,
              ticketNumber,
              {
                title: suggestedTitle,
                body: markedBody,
              },
              token,
            );
          } else {
            await updateIssue(
              owner,
              repo,
              ticketNumber,
              {
                title: suggestedTitle,
                body: markedBody,
              },
              token,
            );
          }

          // Save execution result
          await ctx.runMutation(
            internal.ticketActions.internalMutation.completeClaimedExecution,
            {
              actionId: args.actionId,
              expectedClaimedAt: executionClaim.claimedAt,
              expectedProposalVersion: ticketAction.proposalVersion,
              result: {
                success: true,
                updatedIssue: true,
                updatedTitle: !!suggestedTitle,
                updatedBody: !!suggestedBody,
              },
            },
          );
        }
      } else if (
        (ticketAction.actionType === "answer" ||
          ticketAction.actionType === "tag_maintainers" ||
          ticketAction.actionType === "follow_up") &&
        ticketAction.proposedChanges?.suggestedResponse
      ) {
        // Post comment to issue/discussion
        // For first response (answer), mention the ticket author
        // For follow_up, mention the comment author
        const authorToMention =
          ticketAction.actionType === "follow_up"
            ? ticketAction.proposedChanges?.author
            : ticket.githubAuthor;
        const commentBody = buildMarkedResponseComment(
          ticketAction.proposedChanges.suggestedResponse,
          typeof authorToMention === "string" ? authorToMention : undefined,
          FOOTER_MESSAGE,
          executionClaim.idempotencyKey,
        );

        if (ticketAction.actionType !== "tag_maintainers") {
          const publication = await ctx.runMutation(
            internal.ticketActions.internalMutation
              .checkClaimedResponseBeforeWrite,
            {
              actionId: args.actionId,
              expectedClaimedAt: executionClaim.claimedAt,
              expectedProposalVersion: ticketAction.proposalVersion,
            },
          );
          if (!publication.ready) return;
        }

        // Use appropriate API based on ticket type
        let commentId: string | number;
        if (isDiscussion) {
          // For follow_up actions with commentNodeId, try to reply to the specific comment
          const replyToNodeId = ticketAction.proposedChanges?.commentNodeId;
          console.log(
            "[executeAutoApprovedAction] Checked discussion reply target",
          );
          if (
            ticketAction.actionType === "follow_up" &&
            replyToNodeId &&
            typeof replyToNodeId === "string"
          ) {
            console.log(
              "[executeAutoApprovedAction] Posting a threaded discussion reply",
            );
            commentId = await addDiscussionReply(
              owner,
              repo,
              ticketNumber,
              replyToNodeId,
              commentBody,
              token,
            );
          } else {
            commentId = await addDiscussionComment(
              owner,
              repo,
              ticketNumber,
              commentBody,
              token,
            );
          }
        } else {
          commentId = await addIssueComment(
            owner,
            repo,
            ticketNumber,
            commentBody,
            token,
          );
        }

        // Save execution result
        await ctx.runMutation(
          internal.ticketActions.internalMutation.completeClaimedExecution,
          {
            actionId: args.actionId,
            expectedClaimedAt: executionClaim.claimedAt,
            expectedProposalVersion: ticketAction.proposalVersion,
            result: {
              success: true,
              commentId: typeof commentId === "number" ? commentId : commentId,
              postedComment: true,
            },
          },
        );
      }

      console.log(
        "[executeAutoApprovedAction] Successfully executed action:",
        args.actionId,
      );
    } catch {
      console.error("[executeAutoApprovedAction] GitHub API request failed");

      // An external transport failure is ambiguous. Reconcile the opaque
      // marker after GitHub has had time to settle before any retry.
      if (executionClaimedAt !== undefined && ticketAction) {
        await ctx.runMutation(
          internal.ticketActions.internalMutation.scheduleClaimedExecutionRetry,
          {
            actionId: args.actionId,
            expectedClaimedAt: executionClaimedAt,
            expectedProposalVersion: ticketAction.proposalVersion,
            retryAttempt: 1,
            delayMs: CLAIMED_EXECUTION_RECOVERY_GRACE_MS,
          },
        );
      } else if (!terminalPreflightFailure) {
        const retryAttempt = args.preflightRetryAttempt ?? 0;
        const delayMs = Math.min(
          15_000 * 2 ** Math.min(retryAttempt, 5),
          5 * 60_000,
        );
        console.warn(
          `[executeAutoApprovedAction] Retrying preflight in ${delayMs}ms`,
        );
        await ctx.runMutation(
          internal.ticketActions.internalMutation.scheduleAutoExecutionRetry,
          {
            actionId: args.actionId,
            expectedProposalVersion: ticketAction?.proposalVersion,
            retryAttempt: Math.min(retryAttempt + 1, 5),
            delayMs,
          },
        );
      }
    }
  },
});
