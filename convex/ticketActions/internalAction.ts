import { internalAction } from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { getDefaultAiModel, type AiProvider } from "../_ai/model";
import {
  resolveGenerationProvider,
  UserApiKeyError,
  usesUserKey,
} from "../_ai/providerResolution";
import { analyzeIssueFormatting } from "../_ai/issueFormatting/workflow";
import { analyzeIssueWithTools } from "../_ai/issueAnalysis/agenticWorkflow";
import {
  ISSUE_FORMATTING_SYSTEM_PROMPT,
  createIssueFormattingUserPrompt,
} from "../_ai/issueFormatting/prompts";
import {
  addIssueComment,
  addDiscussionComment,
  addDiscussionReply,
  findDiscussionCommentByExecutionMarker,
  findIssueCommentByExecutionMarker,
  getDiscussion,
  getDiscussionComment,
  getIssue,
  getIssueComment,
  getRepositoryMaintainers,
  isGitdogInvocationUnchanged,
  updateDiscussion,
  updateIssue,
} from "../github/helpers";
import {
  extractLearning,
  mightContainTeaching,
} from "../_ai/learning/extractLearning";
import {
  validateAiResponse,
  logValidationWarning,
} from "../_ai/responseValidation";
import type { Id } from "../_generated/dataModel";
import {
  calculateReadinessRetryDelay,
  getRepositoryAiReadiness,
  getReadinessRetryWindow,
} from "../repositories/aiReadiness";
import {
  hasVerifiedActiveRepositoryInstallation,
  resolveDisconnectingRepositoryReadAccess,
  resolveVerifiedRepositoryAccess,
} from "../github/repositoryIdentity";
import { buildLearningContextForProvenance } from "../repoLearnings/trust";
import {
  AI_LEGAL_ATTESTATION_REQUIRED_MESSAGE,
  DIRECT_REQUESTER_LEGAL_ATTESTATION_REQUIRED_MESSAGE,
  guardAiProviderWithCurrentLegalAttestation,
  guardAiProviderWithStrictCurrentLegalAttestation,
  hasCurrentAiLegalAttestation,
  hasStrictCurrentAiLegalAttestation,
  requireCurrentAiLegalAttestation,
  requireStrictCurrentAiLegalAttestation,
} from "../_ai/legalAttestation";
import {
  createBillingGenerationKey,
  createMeteredProvider,
  ChatBillingError,
} from "../_ai/chatBilling";
import { getProviderStartRetryWindow } from "../_ai/chatRecovery";
import {
  getConfiguredGitdogMention,
  getGitdogFollowUpFooter,
} from "../github/botIdentity";
import { buildFormattedGitdogBody } from "../_utils/gitdogFormat";
import {
  attachExecutionMarker,
  buildExecutionMarker,
  buildMarkedResponseComment,
  CLAIMED_EXECUTION_RECOVERY_GRACE_MS,
  classifyFormatExecutionReconciliation,
  stripExecutionMarkers,
} from "./executionRecovery";

function getProviderRetryAttempt(attempt?: number): number {
  return attempt !== undefined && Number.isSafeInteger(attempt) && attempt >= 0
    ? attempt
    : 0;
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

/** Reconcile an exact claimed GitHub write before deciding whether to retry. */
export const reconcileClaimedExecution = internalAction({
  args: {
    actionId: v.id("ticketActions"),
    expectedClaimedAt: v.number(),
    expectedProposalVersion: v.number(),
    retryAttempt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const leaseActive = await ctx.runMutation(
      internal.ticketActions.internalMutation
        .refreshClaimedExecutionRecoveryLease,
      {
        actionId: args.actionId,
        expectedClaimedAt: args.expectedClaimedAt,
        expectedProposalVersion: args.expectedProposalVersion,
      },
    );
    if (!leaseActive) return;

    const action = await ctx.runQuery(
      internal.ticketActions.internalQuery.getById,
      { actionId: args.actionId },
    );
    if (
      !action ||
      action.status !== "approved" ||
      action.executionClaimedAt !== args.expectedClaimedAt ||
      action.proposalVersion !== args.expectedProposalVersion ||
      !action.executionIdempotencyKey ||
      !action.executionRecoveryMode
    ) {
      return;
    }

    const failOwnedClaim = async (errorMessage: string) => {
      await ctx.runMutation(
        internal.ticketActions.internalMutation.failExecutionAttempt,
        {
          actionId: args.actionId,
          mode: action.executionRecoveryMode!,
          claimedAt: args.expectedClaimedAt,
          expectedProposalVersion: args.expectedProposalVersion,
          errorMessage,
        },
      );
    };
    const completeOwnedClaim = async (result: unknown) =>
      await ctx.runMutation(
        internal.ticketActions.internalMutation.completeClaimedExecution,
        {
          actionId: args.actionId,
          expectedClaimedAt: args.expectedClaimedAt,
          expectedProposalVersion: args.expectedProposalVersion,
          result,
        },
      );

    try {
      const ticket = await ctx.runQuery(
        internal.tickets.internalQuery.getById,
        { ticketId: action.ticketId },
      );
      if (!ticket?.repositoryId) {
        throw new Error("Claimed execution ticket is unavailable");
      }
      const repository = await ctx.runQuery(
        action.executionRecoveryReconcileOnly
          ? internal.repositories.internalQuery.getByIdIncludingDisconnecting
          : internal.repositories.internalQuery.getById,
        { repositoryId: ticket.repositoryId },
      );
      if (!repository) {
        throw new Error("Claimed execution repository is unavailable");
      }

      if (ticket.ticketType === "pull_request")
        throw new Error("PR reviews use the dedicated review executor");
      const isDiscussion = ticket.ticketType === "discussion";
      const publicationStillEnabled = async (): Promise<boolean> => {
        const assistantEnabled = isDiscussion
          ? repository.settings.discussionAssistantEnabled
          : repository.settings.issueAssistantEnabled;
        if (!assistantEnabled) {
          await failOwnedClaim(
            "Repository assistant was disabled before recovery completed",
          );
          return false;
        }
        if (action.executionRecoveryMode === "auto_approved") {
          const featureEnabled =
            action.actionType === "format"
              ? isDiscussion
                ? repository.settings.autoFormatDiscussion
                : repository.settings.autoFormatIssue
              : action.actionType === "answer"
                ? isDiscussion
                  ? repository.settings.autoAnswerDiscussionQuestions
                  : repository.settings.autoAnswerQuestions
                : true;
          const requiresApproval = isDiscussion
            ? repository.settings.requireApprovalForDiscussions
            : repository.settings.requireApproval;
          if (!featureEnabled || requiresApproval) {
            await failOwnedClaim(
              "Repository automation changed before recovery completed",
            );
            return false;
          }
        }
        return true;
      };

      const { owner, repo, token } = action.executionRecoveryReconcileOnly
        ? await resolveDisconnectingRepositoryReadAccess(
            ctx,
            ticket.repositoryId,
          )
        : await resolveVerifiedRepositoryAccess(ctx, ticket.repositoryId);
      const ticketNumber = ticket.githubNumber;
      const marker = buildExecutionMarker(action.executionIdempotencyKey);
      const proposedChanges = action.proposedChanges;
      const originalTitle = proposedChanges?.originalTitle;
      const originalBody = proposedChanges?.originalBody;
      if (
        typeof originalTitle !== "string" ||
        typeof originalBody !== "string"
      ) {
        await failOwnedClaim(
          "Action is missing the source ticket snapshot and cannot be recovered safely",
        );
        return;
      }

      if (action.actionType === "format") {
        const suggestedTitle = proposedChanges?.suggestedTitle;
        const suggestedBody = proposedChanges?.suggestedBody;
        if (
          typeof suggestedTitle !== "string" ||
          !suggestedTitle.trim() ||
          typeof suggestedBody !== "string" ||
          !suggestedBody.trim()
        ) {
          await failOwnedClaim("Formatting action has no executable payload");
          return;
        }
        const formattedBody = buildFormattedGitdogBody(
          suggestedBody,
          proposedChanges?.changesSummary || "Formatting improvements",
        );
        if (!formattedBody) {
          await failOwnedClaim("Formatting action has no executable body");
          return;
        }
        const expectedBody = attachExecutionMarker(
          formattedBody,
          action.executionIdempotencyKey,
        );
        const liveTicket = isDiscussion
          ? await getDiscussion(owner, repo, ticketNumber, token)
          : await getIssue(owner, repo, ticketNumber, token);

        const reconciliation = classifyFormatExecutionReconciliation({
          liveState: liveTicket.state,
          liveTitle: liveTicket.title,
          liveBody: liveTicket.body || "",
          originalTitle,
          originalBody,
          expectedTitle: suggestedTitle,
          expectedBody,
          marker,
        });
        if (reconciliation === "already_applied") {
          await completeOwnedClaim({
            success: true,
            updatedIssue: true,
            updatedTitle: true,
            updatedBody: true,
            reconciled: true,
          });
          return;
        }
        if (action.executionRecoveryReconcileOnly) {
          throw new Error(
            "Claimed formatting write has not been observed during disconnect reconciliation",
          );
        }
        if (!(await publicationStillEnabled())) return;
        if (reconciliation === "conflict") {
          await failOwnedClaim(
            "Ticket changed while the formatting execution was being reconciled",
          );
          return;
        }

        if (isDiscussion) {
          await updateDiscussion(
            owner,
            repo,
            ticketNumber,
            { title: suggestedTitle, body: expectedBody },
            token,
          );
        } else {
          await updateIssue(
            owner,
            repo,
            ticketNumber,
            { title: suggestedTitle, body: expectedBody },
            token,
          );
        }
        await completeOwnedClaim({
          success: true,
          updatedIssue: true,
          updatedTitle: true,
          updatedBody: true,
          reconciled: true,
        });
        return;
      }

      const suggestedResponse = proposedChanges?.suggestedResponse;
      if (typeof suggestedResponse !== "string" || !suggestedResponse.trim()) {
        await failOwnedClaim("Response action has no executable payload");
        return;
      }
      const replyToNodeId =
        action.actionType === "follow_up" &&
        typeof proposedChanges?.commentNodeId === "string"
          ? proposedChanges.commentNodeId
          : undefined;
      const markerLookup = isDiscussion
        ? await findDiscussionCommentByExecutionMarker(
            owner,
            repo,
            ticketNumber,
            replyToNodeId,
            marker,
            token,
          )
        : await findIssueCommentByExecutionMarker(
            owner,
            repo,
            ticketNumber,
            marker,
            token,
          );
      if (markerLookup.commentId !== null) {
        await completeOwnedClaim({
          success: true,
          commentId: markerLookup.commentId,
          postedComment: true,
          reconciled: true,
        });
        return;
      }
      if (!markerLookup.exhaustive) {
        throw new Error("GitHub comment marker search was not exhaustive");
      }
      if (action.executionRecoveryReconcileOnly) {
        throw new Error(
          "Claimed response write has not been observed during disconnect reconciliation",
        );
      }
      if (!(await publicationStillEnabled())) return;

      const liveTicket = isDiscussion
        ? await getDiscussion(owner, repo, ticketNumber, token)
        : await getIssue(owner, repo, ticketNumber, token);
      if (
        liveTicket.state !== "open" ||
        liveTicket.title !== originalTitle ||
        (liveTicket.body || "") !== originalBody
      ) {
        await failOwnedClaim(
          "Ticket changed while the response execution was being reconciled",
        );
        return;
      }
      if (action.actionType === "answer" || action.actionType === "follow_up") {
        const groundedIndexVersion = proposedChanges?.groundedIndexVersion;
        if (typeof groundedIndexVersion !== "number") {
          await failOwnedClaim(
            "Response action is missing its repository index snapshot",
          );
          return;
        }
        const indexSnapshot = await ctx.runQuery(
          internal.repositories.internalQuery.getAiAccessSnapshot,
          {
            repositoryId: ticket.repositoryId,
            expectedIndexVersion: groundedIndexVersion,
          },
        );
        if (!indexSnapshot) {
          await failOwnedClaim(
            "Repository index changed while the response execution was being reconciled",
          );
          return;
        }
      }
      if (action.actionType === "follow_up") {
        const sourceCommentRawBody = proposedChanges?.sourceCommentRawBody;
        const sourceComment = isDiscussion
          ? replyToNodeId
            ? await getDiscussionComment(replyToNodeId, token)
            : null
          : typeof proposedChanges?.commentId === "number"
            ? await getIssueComment(
                owner,
                repo,
                proposedChanges.commentId,
                token,
              )
            : null;
        if (
          typeof sourceCommentRawBody !== "string" ||
          !sourceComment ||
          !isGitdogInvocationUnchanged(sourceComment.body, sourceCommentRawBody)
        ) {
          await failOwnedClaim(
            "The follow-up comment changed or was deleted during recovery",
          );
          return;
        }
      }

      const authorToMention =
        action.actionType === "follow_up"
          ? proposedChanges?.author
          : ticket.githubAuthor;
      const commentBody = buildMarkedResponseComment(
        suggestedResponse,
        typeof authorToMention === "string" ? authorToMention : undefined,
        getGitdogFollowUpFooter(),
        action.executionIdempotencyKey,
      );
      const commentId = isDiscussion
        ? replyToNodeId
          ? await addDiscussionReply(
              owner,
              repo,
              ticketNumber,
              replyToNodeId,
              commentBody,
              token,
            )
          : await addDiscussionComment(
              owner,
              repo,
              ticketNumber,
              commentBody,
              token,
            )
        : await addIssueComment(owner, repo, ticketNumber, commentBody, token);
      await completeOwnedClaim({
        success: true,
        commentId,
        postedComment: true,
        reconciled: true,
      });
    } catch (error) {
      const retryAttempt = args.retryAttempt ?? 0;
      const delayMs = Math.max(
        CLAIMED_EXECUTION_RECOVERY_GRACE_MS,
        Math.min(30_000 * 2 ** Math.min(retryAttempt, 6), 15 * 60_000),
      );
      console.warn("[reconcileClaimedExecution] Retrying reconciliation", {
        retryAttempt,
        delayMs,
        errorName: error instanceof Error ? error.name : "unknown",
      });
      await ctx.runMutation(
        internal.ticketActions.internalMutation.scheduleClaimedExecutionRetry,
        {
          actionId: args.actionId,
          expectedClaimedAt: args.expectedClaimedAt,
          expectedProposalVersion: args.expectedProposalVersion,
          retryAttempt: Math.min(retryAttempt + 1, 6),
          delayMs,
        },
      );
    }
  },
});

/**
 * Regenerate action with user feedback
 */
export const regenerateWithFeedback = internalAction({
  args: {
    actionId: v.id("ticketActions"),
    expectedIndexVersion: v.optional(v.number()),
    readinessRetryAttempt: v.optional(v.number()),
    readinessStartedAt: v.optional(v.number()),
    readinessProgressAt: v.optional(v.number()),
    readinessProgressKey: v.optional(v.string()),
    providerRetryAttempt: v.optional(v.number()),
    providerRetryStartedAt: v.optional(v.number()),
    replayReservationKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    console.log("[regenerateWithFeedback] Starting for action:", args.actionId);

    // Get the action
    const action = await ctx.runQuery(
      internal.ticketActions.internalQuery.getById,
      { actionId: args.actionId },
    );

    if (!action) {
      console.error("[regenerateWithFeedback] Action not found");
      return;
    }

    if (action.status !== "pending") {
      console.log(
        `[regenerateWithFeedback] Action is already ${action.status}, skipping duplicate regeneration`,
      );
      return;
    }

    const failPendingGeneration = async (
      errorMessage: string,
    ): Promise<void> => {
      await ctx.runMutation(
        internal.ticketActions.internalMutation.failPendingAction,
        {
          actionId: args.actionId,
          expectedProposalVersion: action.proposalVersion,
          errorMessage,
        },
      );
    };
    const replaceStaleGeneration = async (): Promise<boolean> =>
      await ctx.runMutation(
        internal._ai.chatBilling.replaceStalePendingGeneration,
        {
          ticketActionId: args.actionId,
          expectedProposalVersion: action.proposalVersion,
        },
      );
    await ctx.runMutation(
      internal.ticketActions.internalMutation.refreshPendingGenerationLease,
      {
        actionId: args.actionId,
        providerRetryStartedAt: args.providerRetryStartedAt,
      },
    );

    // Get the ticket
    const ticket = await ctx.runQuery(internal.tickets.internalQuery.getById, {
      ticketId: action.ticketId,
    });

    if (!ticket) {
      console.error("[regenerateWithFeedback] Ticket not found");
      await failPendingGeneration("Ticket no longer exists");
      return;
    }
    if (ticket.status !== "open") {
      console.error("[regenerateWithFeedback] Ticket is no longer open");
      await failPendingGeneration(
        "Ticket closed before AI regeneration completed",
      );
      return;
    }

    if (!(await hasCurrentAiLegalAttestation(ctx, ticket.userId))) {
      await ctx.runMutation(
        internal.ticketActions.internalMutation.updateStatus,
        {
          actionId: args.actionId,
          status: "failed",
          errorMessage: AI_LEGAL_ATTESTATION_REQUIRED_MESSAGE,
        },
      );
      return;
    }

    const replayAuthorized = args.replayReservationKey
      ? await ctx.runQuery(
          internal._ai.chatBilling.canReplayCheckpointedChatResult,
          {
            ticketActionId: args.actionId,
            reservationKey: args.replayReservationKey,
          },
        )
      : false;
    if (args.replayReservationKey && !replayAuthorized) {
      await failPendingGeneration(
        "AI result checkpoint is no longer replayable",
      );
      return;
    }
    let rawAiProvider: AiProvider;
    try {
      rawAiProvider = await resolveGenerationProvider(ctx, {
        userId: ticket.userId,
        ticketActionId: args.actionId,
      });
    } catch (error) {
      if (!(error instanceof UserApiKeyError)) throw error;
      // A checkpointed result replays without calling any provider, so a
      // removed or failing key must not block it.
      if (!replayAuthorized) {
        await failPendingGeneration(error.message);
        return;
      }
      rawAiProvider = getDefaultAiModel();
    }
    // A free owner who never opened the web app still gets the trial. Best
    // effort: the quota check below refuses as usual if it was skipped.
    if (!replayAuthorized && !usesUserKey(rawAiProvider)) {
      try {
        await ctx.runMutation(
          internal.subscriptions.internalMutation.grantTrialCredit,
          { userId: ticket.userId },
        );
      } catch {
        console.warn("Trial credit grant was skipped");
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
      console.error("[regenerateWithFeedback] User cannot perform action");
      await ctx.runMutation(
        internal.ticketActions.internalMutation.updateStatus,
        {
          actionId: args.actionId,
          status: "failed",
          errorMessage:
            canPerform.message ||
            "Token limit reached. Please add a prepaid token pack or upgrade to Pro to continue.",
        },
      );
      return;
    }

    const userFeedback = action.userFeedback || "";
    const aiTicketBody = stripExecutionMarkers(ticket.githubBody || "");

    // Get repository settings for response style
    const repository = ticket.repositoryId
      ? await ctx.runQuery(internal.repositories.internalQuery.getById, {
          repositoryId: ticket.repositoryId,
        })
      : null;

    const isDiscussion = ticket.ticketType === "discussion";
    const responseStyle = isDiscussion
      ? repository?.settings?.discussionResponseStyle
      : repository?.settings?.issueResponseStyle;

    const readinessRetryAttempt = args.readinessRetryAttempt ?? 0;
    const providerRetryAttempt = getProviderRetryAttempt(
      args.providerRetryAttempt,
    );
    const scheduleReadinessRetry = async (
      observedRepository: NonNullable<typeof repository>,
      expectedIndexVersion: number,
      reason: string,
    ): Promise<void> => {
      const retryWindow = getReadinessRetryWindow(observedRepository, {
        startedAt: args.readinessStartedAt,
        progressAt: args.readinessProgressAt,
        progressKey: args.readinessProgressKey,
      });
      if (retryWindow.timeoutReason) {
        await ctx.runMutation(
          internal.ticketActions.internalMutation.failPendingAction,
          {
            actionId: args.actionId,
            expectedProposalVersion: action.proposalVersion,
            errorMessage: retryWindow.timeoutReason,
          },
        );
        return;
      }

      const delayMs = calculateReadinessRetryDelay(readinessRetryAttempt);
      await ctx.runMutation(
        internal.ticketActions.internalMutation.refreshPendingGenerationLease,
        {
          actionId: args.actionId,
          providerRetryStartedAt: args.providerRetryStartedAt,
        },
      );
      console.log(
        `[regenerateWithFeedback] Deferring for ${delayMs}ms: ${reason}`,
      );
      await ctx.scheduler.runAfter(
        delayMs,
        internal.ticketActions.internalAction.regenerateWithFeedback,
        {
          actionId: args.actionId,
          expectedIndexVersion,
          readinessRetryAttempt: readinessRetryAttempt + 1,
          readinessStartedAt: retryWindow.startedAt,
          readinessProgressAt: retryWindow.progressAt,
          readinessProgressKey: retryWindow.progressKey,
          providerRetryAttempt,
          providerRetryStartedAt: args.providerRetryStartedAt,
          replayReservationKey: args.replayReservationKey,
        },
      );
    };
    const scheduleProviderRetry = async (
      reason: ChatBillingError["reason"],
    ): Promise<void> => {
      const retryWindow = getProviderStartRetryWindow(
        args.providerRetryStartedAt,
      );
      if (retryWindow.timeoutReason) {
        await ctx.runMutation(
          internal.ticketActions.internalMutation.failPendingAction,
          {
            actionId: args.actionId,
            expectedProposalVersion: action.proposalVersion,
            errorMessage: retryWindow.timeoutReason,
          },
        );
        return;
      }
      void reason;
      const delayMs = calculateReadinessRetryDelay(providerRetryAttempt);
      await ctx.runMutation(
        internal.ticketActions.internalMutation.refreshPendingGenerationLease,
        {
          actionId: args.actionId,
          providerRetryStartedAt: retryWindow.startedAt,
        },
      );
      console.log(
        `[regenerateWithFeedback] Deferring provider start for ${delayMs}ms`,
      );
      await ctx.scheduler.runAfter(
        delayMs,
        internal.ticketActions.internalAction.regenerateWithFeedback,
        {
          actionId: args.actionId,
          expectedIndexVersion: args.expectedIndexVersion,
          readinessRetryAttempt: args.readinessRetryAttempt,
          readinessStartedAt: args.readinessStartedAt,
          readinessProgressAt: args.readinessProgressAt,
          readinessProgressKey: args.readinessProgressKey,
          providerRetryAttempt: providerRetryAttempt + 1,
          providerRetryStartedAt: retryWindow.startedAt,
          replayReservationKey: args.replayReservationKey,
        },
      );
    };

    // If orchestration fails after any paid turn, the checkpoint mutation can
    // prove whether replay is possible. Deterministic model/validation failures
    // overwrite this flag before reaching the catch block.
    let shouldRecoverCheckpointedResult = true;
    try {
      if (!ticket.repositoryId || !repository) {
        throw new Error("Repository not found");
      }
      if (!(await hasVerifiedActiveRepositoryInstallation(ctx, repository))) {
        await scheduleReadinessRetry(
          repository,
          repository.indexVersion,
          "repository installation access is not active",
        );
        return;
      }

      if (action.actionType === "format") {
        // Regenerate format suggestion with feedback
        console.log("[regenerateWithFeedback] Regenerating format action...");

        const formatStartTime = Date.now();
        const formatUserPrompt = createIssueFormattingUserPrompt(
          ticket.githubTitle,
          aiTicketBody,
          userFeedback,
        );

        if (!(await hasVerifiedActiveRepositoryInstallation(ctx, repository))) {
          await scheduleReadinessRetry(
            repository,
            repository.indexVersion,
            "repository installation access changed before formatting analysis",
          );
          return;
        }

        if (!(await hasCurrentAiLegalAttestation(ctx, ticket.userId))) {
          await ctx.runMutation(
            internal.ticketActions.internalMutation.updateStatus,
            {
              actionId: args.actionId,
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
            repositoryId: ticket.repositoryId,
            ticketActionId: args.actionId,
            generationKey: `action/${args.actionId}/proposal/${action.proposalVersion}/format`,
            operation: "regenerate-format",
            provider: rawAiProvider,
            requirePendingTicketAction: true,
            recoveryTarget: {
              kind: "regenerate",
              expectedAiInputVersion: ticket.aiInputVersion,
              expectedIndexVersion: repository.indexVersion,
            },
            beforeProviderStart: () =>
              requireCurrentAiLegalAttestation(ctx, ticket.userId),
          }),
        );
        const formattingResult = await analyzeIssueFormatting(
          {
            title: ticket.githubTitle,
            body: aiTicketBody,
            feedback: userFeedback,
          },
          formattingProvider,
        );
        shouldRecoverCheckpointedResult = Boolean(
          formattingResult.success && formattingResult.output,
        );

        const formatDurationMs = Date.now() - formatStartTime;

        // Create AI log for format regeneration (non-blocking - don't fail the workflow)
        if (ticket.repositoryId) {
          try {
            await ctx.runMutation(internal.admin.internalMutation.createAiLog, {
              ticketId: action.ticketId,
              ticketActionId: args.actionId,
              repositoryId: ticket.repositoryId,
              userId: ticket.userId,
              workflowType: "issue_formatting_regenerate",
              actionType: "format",
              systemPrompt: ISSUE_FORMATTING_SYSTEM_PROMPT,
              userPrompt: formatUserPrompt,
              aiResponse: formattingResult.output
                ? JSON.stringify(formattingResult.output, null, 2)
                : undefined,
              githubRepo: ticket.githubRepo,
              githubNumber: ticket.githubNumber,
              ticketTitle: ticket.githubTitle,
              ticketBody: aiTicketBody,
              status: formattingResult.success ? "pending_approval" : "failed",
              errorMessage: formattingResult.success
                ? undefined
                : formattingResult.errors.join(", "),
              userFeedback,
              requestChangesCount: 1,
              inputTokens: formattingResult.tokenUsage?.inputTokens,
              outputTokens: formattingResult.tokenUsage?.outputTokens,
              model: formattingResult.tokenUsage?.model,
              durationMs: formatDurationMs,
            });
          } catch {
            console.error("[regenerateWithFeedback] Failed to create AI log");
          }
        }

        if (formattingResult.success && formattingResult.output) {
          const proposalUpdated = await ctx.runMutation(
            internal.ticketActions.internalMutation.updateProposedChanges,
            {
              actionId: args.actionId,
              proposedChanges: {
                originalTitle: ticket.githubTitle,
                originalBody: ticket.githubBody || "",
                suggestedTitle: formattingResult.output.suggestedTitle,
                suggestedBody: formattingResult.output.suggestedBody,
                changesSummary: formattingResult.output.changesSummary,
                reasoning: formattingResult.output.reasoning,
                formatValidationPassed: true,
              },
            },
          );
          if (!proposalUpdated) {
            console.log(
              "[regenerateWithFeedback] Format proposal changed concurrently; discarding stale result",
            );
            return;
          }
          shouldRecoverCheckpointedResult = false;

          // Add AI response to chat history
          await ctx.runMutation(
            internal.ticketActions.internalMutation.addChatMessage,
            {
              actionId: args.actionId,
              role: "assistant",
              content: `I've updated the formatting based on your feedback.\n\n**Changes:**\n${formattingResult.output.changesSummary}`,
            },
          );
        } else {
          throw new Error("Format analysis failed");
        }
      } else if (action.actionType === "answer") {
        // Regenerate answer with feedback using agentic workflow
        console.log(
          "[regenerateWithFeedback] Regenerating answer action with agentic workflow...",
        );

        if (!ticket.repositoryId) {
          throw new Error("Ticket has no repository linked");
        }

        if (!repository) {
          throw new Error("Repository not found");
        }

        const readiness = getRepositoryAiReadiness(repository);
        if (readiness.state === "waiting") {
          await scheduleReadinessRetry(
            repository,
            readiness.indexVersion,
            readiness.reason,
          );
          return;
        }
        if (readiness.state === "blocked") {
          throw new Error(readiness.reason);
        }
        if (
          args.expectedIndexVersion !== undefined &&
          args.expectedIndexVersion !== readiness.indexVersion
        ) {
          if (await replaceStaleGeneration()) return;
          await scheduleReadinessRetry(
            repository,
            readiness.indexVersion,
            `repository index version changed from ${args.expectedIndexVersion} to ${readiness.indexVersion}`,
          );
          return;
        }
        const stableIndexVersion = readiness.indexVersion;

        const ticketBeforeAnalysis = await ctx.runQuery(
          internal.tickets.internalQuery.getById,
          { ticketId: action.ticketId },
        );
        if (!ticketBeforeAnalysis || ticketBeforeAnalysis.status !== "open") {
          throw new Error("Ticket is no longer open");
        }
        if (
          ticketBeforeAnalysis.githubTitle !== ticket.githubTitle ||
          (ticketBeforeAnalysis.githubBody || "") !== (ticket.githubBody || "")
        ) {
          await scheduleReadinessRetry(
            repository,
            stableIndexVersion,
            "ticket content changed before regeneration",
          );
          return;
        }

        // Fetch learned context for this repository
        let learnedContext: string | undefined;
        try {
          const learnings = await ctx.runAction(
            internal.repoLearnings.action.searchLearnings,
            {
              repositoryId: ticket.repositoryId,
              query: `${ticket.githubTitle} ${userFeedback}`,
              topK: 5,
              embeddingDataProvenance: "private_user_input",
            },
          );
          learnedContext = buildLearningContextForProvenance(
            learnings,
            "private_user_input",
          );
          if (learnedContext) {
            console.log(
              `[regenerateWithFeedback] Found ${learnings.length} relevant learnings`,
            );
          }
        } catch {
          console.error("[regenerateWithFeedback] Failed to fetch learnings");
        }

        const answerStartTime = Date.now();
        const answerUserPrompt = userFeedback
          ? `${aiTicketBody}\n\n---\n\n**User feedback for improvement:**\n${userFeedback}`
          : aiTicketBody;

        const maintainers = await fetchRepositoryMaintainersSafe(
          ctx,
          ticket.repositoryId,
        );

        if (!(await hasVerifiedActiveRepositoryInstallation(ctx, repository))) {
          await scheduleReadinessRetry(
            repository,
            stableIndexVersion,
            "repository installation access changed before answer regeneration",
          );
          return;
        }

        if (!(await hasCurrentAiLegalAttestation(ctx, ticket.userId))) {
          await ctx.runMutation(
            internal.ticketActions.internalMutation.updateStatus,
            {
              actionId: args.actionId,
              status: "failed",
              errorMessage: AI_LEGAL_ATTESTATION_REQUIRED_MESSAGE,
            },
          );
          return;
        }

        // Use agentic workflow - same as initial analysis, but with user feedback
        const answerProvider = guardAiProviderWithCurrentLegalAttestation(
          ctx,
          ticket.userId,
          createMeteredProvider(ctx, {
            userId: ticket.userId,
            repositoryId: ticket.repositoryId,
            ticketActionId: args.actionId,
            generationKey: `action/${args.actionId}/proposal/${action.proposalVersion}/answer/${stableIndexVersion}`,
            operation: "regenerate-answer",
            provider: rawAiProvider,
            requirePendingTicketAction: true,
            recoveryTarget: {
              kind: "regenerate",
              expectedAiInputVersion: ticket.aiInputVersion,
              expectedIndexVersion: stableIndexVersion,
            },
            beforeProviderStart: () =>
              requireCurrentAiLegalAttestation(ctx, ticket.userId),
          }),
        );
        const analysisResult = await analyzeIssueWithTools(
          ctx,
          ticket.repositoryId,
          {
            title: ticket.githubTitle,
            body: answerUserPrompt,
          },
          answerProvider,
          {
            responseStyle,
            learnedContext,
            repositoryLanguage: repository?.language,
            maintainers,
            validationFocus: userFeedback,
            indexVersion: stableIndexVersion,
            embeddingDataProvenance: "private_user_input",
          },
        );
        shouldRecoverCheckpointedResult = Boolean(
          analysisResult.success && analysisResult.output?.suggestedResponse,
        );

        const answerDurationMs = Date.now() - answerStartTime;

        const [repositoryAfterAnalysis, ticketAfterAnalysis] =
          await Promise.all([
            ctx.runQuery(internal.repositories.internalQuery.getById, {
              repositoryId: ticket.repositoryId,
            }),
            ctx.runQuery(internal.tickets.internalQuery.getById, {
              ticketId: action.ticketId,
            }),
          ]);
        const readinessAfterAnalysis = repositoryAfterAnalysis
          ? getRepositoryAiReadiness(repositoryAfterAnalysis)
          : null;
        const installationActiveAfterAnalysis = repositoryAfterAnalysis
          ? await hasVerifiedActiveRepositoryInstallation(
              ctx,
              repositoryAfterAnalysis,
            )
          : false;
        const ticketChanged =
          !ticketAfterAnalysis ||
          ticketAfterAnalysis.status !== "open" ||
          ticketAfterAnalysis.githubTitle !== ticket.githubTitle ||
          (ticketAfterAnalysis.githubBody || "") !== (ticket.githubBody || "");
        const repositorySnapshotChanged =
          !readinessAfterAnalysis ||
          readinessAfterAnalysis.state !== "ready" ||
          readinessAfterAnalysis.indexVersion !== stableIndexVersion ||
          !installationActiveAfterAnalysis;

        if (ticketChanged || repositorySnapshotChanged) {
          const staleReason = ticketChanged
            ? "ticket content changed or closed during regeneration"
            : !installationActiveAfterAnalysis
              ? "repository installation access changed during regeneration"
              : readinessAfterAnalysis?.state !== "ready"
                ? readinessAfterAnalysis?.reason ||
                  "repository disappeared during regeneration"
                : "repository index version changed during regeneration";
          if (
            !ticketChanged &&
            readinessAfterAnalysis?.indexVersion !== stableIndexVersion &&
            (await replaceStaleGeneration())
          ) {
            return;
          }
          if (
            ticketAfterAnalysis?.status === "open" &&
            readinessAfterAnalysis?.state !== "blocked"
          ) {
            await scheduleReadinessRetry(
              repositoryAfterAnalysis ?? repository,
              readinessAfterAnalysis?.indexVersion ?? stableIndexVersion,
              staleReason,
            );
          } else {
            throw new Error(staleReason);
          }
          return;
        }
        if (!repositoryAfterAnalysis) return;

        const assistantEnabledAfterAnalysis = isDiscussion
          ? repositoryAfterAnalysis.settings.discussionAssistantEnabled
          : repositoryAfterAnalysis.settings.issueAssistantEnabled;
        if (!assistantEnabledAfterAnalysis) {
          throw new Error("Repository assistant was disabled during analysis");
        }

        // Create AI log for answer regeneration (non-blocking - don't fail the workflow)
        try {
          await ctx.runMutation(internal.admin.internalMutation.createAiLog, {
            ticketId: action.ticketId,
            ticketActionId: args.actionId,
            repositoryId: ticket.repositoryId,
            userId: ticket.userId,
            workflowType: "issue_analysis_regenerate",
            actionType: "answer",
            userPrompt: `Title: ${ticket.githubTitle}\n\n${answerUserPrompt}`,
            aiResponse: analysisResult.output?.suggestedResponse,
            githubRepo: ticket.githubRepo,
            githubNumber: ticket.githubNumber,
            ticketTitle: ticket.githubTitle,
            ticketBody: aiTicketBody,
            status: analysisResult.success
              ? analysisResult.output?.suggestedResponse
                ? "pending_approval"
                : "success"
              : "failed",
            errorMessage: analysisResult.success
              ? undefined
              : analysisResult.errors.join(", "),
            userFeedback,
            requestChangesCount: 1,
            inputTokens: analysisResult.tokenUsage?.inputTokens,
            outputTokens: analysisResult.tokenUsage?.outputTokens,
            model: analysisResult.tokenUsage?.model,
            durationMs: answerDurationMs,
          });
        } catch {
          console.error("[regenerateWithFeedback] Failed to create AI log");
        }

        if (
          analysisResult.success &&
          analysisResult.output?.suggestedResponse
        ) {
          // Validate AI response before saving (prevents internal field leakage and context loss)
          const responseValidation = validateAiResponse(
            analysisResult.output.suggestedResponse,
            analysisResult.output.confidence,
          );
          if (!responseValidation.isValid) {
            logValidationWarning(
              `regenerateWithFeedback action=${args.actionId}`,
              responseValidation,
            );
            // Block responses with context loss or internal field leakage
            if (responseValidation.contextLossPhrases.length > 0) {
              shouldRecoverCheckpointedResult = false;
              throw new Error(
                `AI response contains context loss phrase: "${responseValidation.contextLossPhrases[0]}"`,
              );
            }
            if (responseValidation.leakedFields.length > 0) {
              shouldRecoverCheckpointedResult = false;
              throw new Error(
                `AI response leaked internal field names: ${responseValidation.leakedFields.join(", ")}`,
              );
            }
            if (responseValidation.leakedInternalPaths.length > 0) {
              shouldRecoverCheckpointedResult = false;
              throw new Error(
                `AI response leaked internal file paths: ${responseValidation.leakedInternalPaths.join(", ")}`,
              );
            }
          }

          const proposalUpdated = await ctx.runMutation(
            internal.ticketActions.internalMutation.updateProposedChanges,
            {
              actionId: args.actionId,
              expectedProposalVersion: action.proposalVersion,
              proposedChanges: {
                originalTitle: ticket.githubTitle,
                originalBody: ticket.githubBody || "",
                groundedIndexVersion: stableIndexVersion,
                suggestedResponse: analysisResult.output.suggestedResponse,
                issueType: analysisResult.output.issueType,
                reasoning: analysisResult.output.reasoning,
                isActionable: analysisResult.output.isActionable,
                confidence: analysisResult.output.confidence,
                toolsUsed: analysisResult.output.toolsUsed,
                filesRead: analysisResult.output.filesRead,
                filesReadPaths: analysisResult.output.filesReadPaths,
                toolErrors: analysisResult.output.toolErrors,
                wasRepaired: analysisResult.output.wasRepaired,
                validationPassed: analysisResult.output.validationPassed,
              },
            },
          );
          if (!proposalUpdated) {
            console.log(
              "[regenerateWithFeedback] Answer proposal changed concurrently; discarding stale result",
            );
            return;
          }
          shouldRecoverCheckpointedResult = false;

          // Add AI response to chat history
          await ctx.runMutation(
            internal.ticketActions.internalMutation.addChatMessage,
            {
              actionId: args.actionId,
              role: "assistant",
              content: analysisResult.output.suggestedResponse,
            },
          );

          // Extract learning from user feedback (non-blocking)
          if (userFeedback && mightContainTeaching(userFeedback)) {
            try {
              await triggerLearningExtraction(ctx, {
                repositoryId: ticket.repositoryId,
                ticketId: action.ticketId,
                ticketActionId: args.actionId,
                userId: ticket.userId,
                userMessage: userFeedback,
                previousResponse: action.proposedChanges?.suggestedResponse,
                source: `github.com/${ticket.githubRepo}/issues/${ticket.githubNumber}`,
                githubRepo: ticket.githubRepo,
                githubNumber: ticket.githubNumber,
                isTrusted: true,
                embeddingDataProvenance: "private_user_input",
              });
            } catch {
              console.error(
                "[regenerateWithFeedback] Failed to extract learning",
              );
            }
          }
        } else {
          throw new Error(
            analysisResult.errors?.join(", ") ||
              "Issue analysis failed or no suggested response",
          );
        }
      } else {
        console.log(
          "[regenerateWithFeedback] Unsupported action type:",
          action.actionType,
        );
        // For other action types, just mark as pending_approval
        await ctx.runMutation(
          internal.ticketActions.internalMutation.updateStatus,
          {
            actionId: args.actionId,
            status: "pending_approval",
          },
        );
      }

      console.log(
        "[regenerateWithFeedback] Successfully regenerated action:",
        args.actionId,
      );
    } catch (error) {
      console.error("[regenerateWithFeedback] Failed");

      if (error instanceof ChatBillingError && error.durableRetrySafe) {
        await scheduleProviderRetry(error.reason);
        return;
      }

      if (shouldRecoverCheckpointedResult) {
        try {
          if (
            await ctx.runMutation(
              internal._ai.chatBilling.keepCheckpointedChatActionPending,
              { ticketActionId: args.actionId },
            )
          ) {
            return;
          }
        } catch {
          // The durable checkpoint watchdog can recover without this response.
          return;
        }
      }

      // Update status to failed
      await ctx.runMutation(
        internal.ticketActions.internalMutation.failPendingAction,
        {
          actionId: args.actionId,
          expectedProposalVersion: action.proposalVersion,
          errorMessage:
            error instanceof Error ? error.message : "Regeneration failed",
        },
      );
    }
  },
});

/**
 * Process a follow-up comment on an issue
 */
export const processFollowUp = internalAction({
  args: {
    actionId: v.id("ticketActions"),
    expectedIndexVersion: v.optional(v.number()),
    readinessRetryAttempt: v.optional(v.number()),
    forceApproval: v.optional(v.boolean()),
    readinessStartedAt: v.optional(v.number()),
    readinessProgressAt: v.optional(v.number()),
    readinessProgressKey: v.optional(v.string()),
    providerRetryAttempt: v.optional(v.number()),
    providerRetryStartedAt: v.optional(v.number()),
    replayReservationKey: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    console.log("[processFollowUp] Starting for action:", args.actionId);

    // Get the action
    const action = await ctx.runQuery(
      internal.ticketActions.internalQuery.getById,
      { actionId: args.actionId },
    );

    if (!action) {
      console.error("[processFollowUp] Action not found");
      return;
    }

    if (action.status !== "pending") {
      console.log(
        `[processFollowUp] Action is already ${action.status}, skipping duplicate processing`,
      );
      return;
    }

    const failPendingGeneration = async (
      errorMessage: string,
    ): Promise<void> => {
      await ctx.runMutation(
        internal.ticketActions.internalMutation.failPendingAction,
        {
          actionId: args.actionId,
          expectedProposalVersion: action.proposalVersion,
          errorMessage,
        },
      );
    };
    const replaceStaleGeneration = async (): Promise<boolean> =>
      await ctx.runMutation(
        internal._ai.chatBilling.replaceStalePendingGeneration,
        {
          ticketActionId: args.actionId,
          expectedProposalVersion: action.proposalVersion,
        },
      );
    await ctx.runMutation(
      internal.ticketActions.internalMutation.refreshPendingGenerationLease,
      {
        actionId: args.actionId,
        providerRetryStartedAt: args.providerRetryStartedAt,
      },
    );

    const requestedByUserId = action.requestedByUserId;
    if (
      !requestedByUserId ||
      !(await hasStrictCurrentAiLegalAttestation(ctx, requestedByUserId))
    ) {
      await ctx.runMutation(
        internal.ticketActions.internalMutation.updateStatus,
        {
          actionId: args.actionId,
          status: "failed",
          errorMessage: DIRECT_REQUESTER_LEGAL_ATTESTATION_REQUIRED_MESSAGE,
        },
      );
      return;
    }

    // Get the ticket
    const ticket = await ctx.runQuery(internal.tickets.internalQuery.getById, {
      ticketId: action.ticketId,
    });

    if (!ticket) {
      console.error("[processFollowUp] Ticket not found");
      await failPendingGeneration("Ticket no longer exists");
      return;
    }
    if (ticket.status !== "open") {
      console.error("[processFollowUp] Ticket is no longer open");
      await failPendingGeneration(
        "Ticket closed before AI follow-up completed",
      );
      return;
    }

    if (!(await hasCurrentAiLegalAttestation(ctx, ticket.userId))) {
      await ctx.runMutation(
        internal.ticketActions.internalMutation.updateStatus,
        {
          actionId: args.actionId,
          status: "failed",
          errorMessage: AI_LEGAL_ATTESTATION_REQUIRED_MESSAGE,
        },
      );
      return;
    }

    const replayAuthorized = args.replayReservationKey
      ? await ctx.runQuery(
          internal._ai.chatBilling.canReplayCheckpointedChatResult,
          {
            ticketActionId: args.actionId,
            reservationKey: args.replayReservationKey,
          },
        )
      : false;
    if (args.replayReservationKey && !replayAuthorized) {
      await failPendingGeneration(
        "AI result checkpoint is no longer replayable",
      );
      return;
    }
    let rawAiProvider: AiProvider;
    try {
      rawAiProvider = await resolveGenerationProvider(ctx, {
        userId: ticket.userId,
        ticketActionId: args.actionId,
      });
    } catch (error) {
      if (!(error instanceof UserApiKeyError)) throw error;
      // A checkpointed result replays without calling any provider, so a
      // removed or failing key must not block it.
      if (!replayAuthorized) {
        await failPendingGeneration(error.message);
        return;
      }
      rawAiProvider = getDefaultAiModel();
    }
    // A free owner who never opened the web app still gets the trial. Best
    // effort: the quota check below refuses as usual if it was skipped.
    if (!replayAuthorized && !usesUserKey(rawAiProvider)) {
      try {
        await ctx.runMutation(
          internal.subscriptions.internalMutation.grantTrialCredit,
          { userId: ticket.userId },
        );
      } catch {
        console.warn("Trial credit grant was skipped");
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
      console.error("[processFollowUp] User cannot perform action");

      // Post a comment to GitHub notifying the user about the limit
      try {
        if (ticket.repositoryId) {
          const { owner, repo, token } = await resolveVerifiedRepositoryAccess(
            ctx,
            ticket.repositoryId,
          );
          const limitMessage = `⚠️ **Token limit reached**

Sorry, the repository owner's available token balance for this billing period is exhausted.

**Current usage:** ${(canPerform as { tokensUsed?: number }).tokensUsed?.toLocaleString() ?? "N/A"} / ${(canPerform as { tokenLimit?: number }).tokenLimit?.toLocaleString() ?? "N/A"} tokens

To continue using ${getConfiguredGitdogMention() ?? "the Gitdog bot"}, the repository owner can buy a prepaid token pack or, on Free, upgrade to Pro at [gitdog.dev/pricing](https://gitdog.dev/pricing). There are no automatic overage charges.

---
*🤖 [gitdog.dev](https://gitdog.dev)*`;

          if (ticket.ticketType === "discussion") {
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
            "[processFollowUp] Posted token limit notification to GitHub",
          );
        }
      } catch {
        console.error(
          "[processFollowUp] Failed to post limit notification to GitHub",
        );
      }

      await ctx.runMutation(
        internal.ticketActions.internalMutation.updateStatus,
        {
          actionId: args.actionId,
          status: "failed",
          errorMessage:
            canPerform.message ||
            "Token limit reached. Please add a prepaid token pack or upgrade to Pro to continue.",
        },
      );
      return;
    }

    // Get the latest user comment from chat history.
    const latestUserComment = [...action.chatHistory]
      .reverse()
      .find((msg) => msg.role === "user");
    if (!latestUserComment) {
      console.error("[processFollowUp] No user comment found in chat history");
      await failPendingGeneration(
        "Follow-up context is missing before AI generation",
      );
      return;
    }

    const aiTicketBody = stripExecutionMarkers(ticket.githubBody || "");
    const providerRetryAttempt = getProviderRetryAttempt(
      args.providerRetryAttempt,
    );
    const scheduleProviderRetry = async (
      reason: ChatBillingError["reason"],
    ): Promise<void> => {
      const retryWindow = getProviderStartRetryWindow(
        args.providerRetryStartedAt,
      );
      if (retryWindow.timeoutReason) {
        await ctx.runMutation(
          internal.ticketActions.internalMutation.failPendingAction,
          {
            actionId: args.actionId,
            expectedProposalVersion: action.proposalVersion,
            errorMessage: retryWindow.timeoutReason,
          },
        );
        return;
      }
      void reason;
      const delayMs = calculateReadinessRetryDelay(providerRetryAttempt);
      await ctx.runMutation(
        internal.ticketActions.internalMutation.refreshPendingGenerationLease,
        {
          actionId: args.actionId,
          providerRetryStartedAt: retryWindow.startedAt,
        },
      );
      console.log(
        `[processFollowUp] Deferring provider start for ${delayMs}ms`,
      );
      await ctx.scheduler.runAfter(
        delayMs,
        internal.ticketActions.internalAction.processFollowUp,
        {
          actionId: args.actionId,
          expectedIndexVersion: args.expectedIndexVersion,
          readinessRetryAttempt: args.readinessRetryAttempt,
          forceApproval: args.forceApproval,
          readinessStartedAt: args.readinessStartedAt,
          readinessProgressAt: args.readinessProgressAt,
          readinessProgressKey: args.readinessProgressKey,
          providerRetryAttempt: providerRetryAttempt + 1,
          providerRetryStartedAt: retryWindow.startedAt,
          replayReservationKey: args.replayReservationKey,
        },
      );
    };

    // Keep an already-paid intermediate turn replayable across transient
    // database/scheduler failures. Deterministic output failures set this false.
    let shouldRecoverCheckpointedResult = true;
    try {
      if (!ticket.repositoryId) {
        throw new Error("Ticket has no repository linked");
      }

      // Get repository settings first (for responseStyle and requireApproval)
      const repository = await ctx.runQuery(
        internal.repositories.internalQuery.getById,
        { repositoryId: ticket.repositoryId },
      );

      if (!repository) {
        throw new Error("Repository not found");
      }

      const readinessRetryAttempt = args.readinessRetryAttempt ?? 0;
      const scheduleReadinessRetry = async (
        observedRepository: typeof repository,
        expectedIndexVersion: number,
        reason: string,
      ): Promise<void> => {
        const retryWindow = getReadinessRetryWindow(observedRepository, {
          startedAt: args.readinessStartedAt,
          progressAt: args.readinessProgressAt,
          progressKey: args.readinessProgressKey,
        });
        if (retryWindow.timeoutReason) {
          await ctx.runMutation(
            internal.ticketActions.internalMutation.failPendingAction,
            {
              actionId: args.actionId,
              expectedProposalVersion: action.proposalVersion,
              errorMessage: retryWindow.timeoutReason,
            },
          );
          return;
        }

        const delayMs = calculateReadinessRetryDelay(readinessRetryAttempt);
        await ctx.runMutation(
          internal.ticketActions.internalMutation.refreshPendingGenerationLease,
          {
            actionId: args.actionId,
            providerRetryStartedAt: args.providerRetryStartedAt,
          },
        );
        console.log(`[processFollowUp] Deferring for ${delayMs}ms: ${reason}`);
        await ctx.scheduler.runAfter(
          delayMs,
          internal.ticketActions.internalAction.processFollowUp,
          {
            actionId: args.actionId,
            expectedIndexVersion,
            readinessRetryAttempt: readinessRetryAttempt + 1,
            forceApproval: args.forceApproval,
            readinessStartedAt: retryWindow.startedAt,
            readinessProgressAt: retryWindow.progressAt,
            readinessProgressKey: retryWindow.progressKey,
            providerRetryAttempt,
            providerRetryStartedAt: args.providerRetryStartedAt,
            replayReservationKey: args.replayReservationKey,
          },
        );
      };

      if (!(await hasVerifiedActiveRepositoryInstallation(ctx, repository))) {
        await scheduleReadinessRetry(
          repository,
          repository.indexVersion,
          "repository installation access is not active",
        );
        return;
      }

      const readiness = getRepositoryAiReadiness(repository);
      if (readiness.state === "waiting") {
        await scheduleReadinessRetry(
          repository,
          readiness.indexVersion,
          readiness.reason,
        );
        return;
      }
      if (readiness.state === "blocked") {
        await ctx.runMutation(
          internal.ticketActions.internalMutation.updateStatus,
          {
            actionId: args.actionId,
            status: "failed",
            errorMessage: readiness.reason,
          },
        );
        return;
      }
      if (
        args.expectedIndexVersion !== undefined &&
        args.expectedIndexVersion !== readiness.indexVersion
      ) {
        if (await replaceStaleGeneration()) return;
        await scheduleReadinessRetry(
          repository,
          readiness.indexVersion,
          `repository index version changed from ${args.expectedIndexVersion} to ${readiness.indexVersion}`,
        );
        return;
      }
      const stableIndexVersion = readiness.indexVersion;

      const isDiscussion = ticket.ticketType === "discussion";
      const responseStyle = isDiscussion
        ? repository?.settings?.discussionResponseStyle
        : repository?.settings?.issueResponseStyle;
      const learningEmbeddingDataProvenance =
        action.userFeedback === undefined
          ? ("public_github" as const)
          : ("private_user_input" as const);

      // Fetch learned context for this repository
      let learnedContext: string | undefined;
      try {
        await requireStrictCurrentAiLegalAttestation(ctx, requestedByUserId);
        const learnings = await ctx.runAction(
          internal.repoLearnings.action.searchLearnings,
          {
            repositoryId: ticket.repositoryId,
            query: `${ticket.githubTitle} ${stripExecutionMarkers(action.chatHistory.slice(-1)[0]?.content || "")}`,
            topK: 5,
            embeddingDataProvenance: learningEmbeddingDataProvenance,
            requestedByUserId,
          },
        );
        learnedContext = buildLearningContextForProvenance(
          learnings,
          learningEmbeddingDataProvenance,
        );
        if (learnedContext) {
          console.log(
            `[processFollowUp] Found ${learnings.length} relevant learnings`,
          );
        }
      } catch {
        console.error("[processFollowUp] Failed to fetch learnings");
      }
      await requireStrictCurrentAiLegalAttestation(ctx, requestedByUserId);

      // Build conversation history from chat history (up to 5 previous messages)
      const previousMessages = action.chatHistory.slice(0, -1); // Exclude current message
      const conversationHistory = previousMessages
        .map((msg: { role: "user" | "assistant"; content: string }) => {
          // For assistant messages, add "Gitdog (AI)" label
          // For user messages, content already includes author info like "[hyochan [Maintainer]]: ..."
          if (msg.role === "assistant") {
            return `[Gitdog (AI)]: ${stripExecutionMarkers(msg.content)}`;
          }
          // User messages already have author info in content
          return stripExecutionMarkers(msg.content).replace(
            " [Maintainer]]:",
            "]:",
          );
        })
        .join("\n\n");

      // Build context with original issue + conversation history + current comment
      // Let AI understand the full context and decide how to respond
      const hasConversationHistory =
        conversationHistory && conversationHistory.length > 0;
      const fullContext = `${hasConversationHistory ? "⚠️ THIS IS A FOLLOW-UP CONVERSATION - YOU HAVE FULL CONTEXT BELOW. NEVER SAY 'I don't have any record of a previous conversation'.\n\n" : ""}Original ${isDiscussion ? "Discussion" : "Issue"} Title: ${ticket.githubTitle}
Original ${isDiscussion ? "Discussion" : "Issue"} Body: ${aiTicketBody || "(No description)"}

---
${
  hasConversationHistory
    ? `
**Previous Conversation (THIS IS YOUR CONTEXT - USE IT):**
${conversationHistory}

---
`
    : ""
}
**Current Follow-up Comment:** ${stripExecutionMarkers(latestUserComment.content)}

---
**FOLLOW-UP RESPONSE GUIDELINES:**
${hasConversationHistory ? "⚠️ CRITICAL: You have the conversation history above. NEVER claim you don't have context.\n" : ""}
This is a follow-up in an ongoing conversation. Before responding:
1. Read the previous conversation carefully - understand what was already discussed
2. Pay attention to ANY feedback from the user about response style, length, or format
3. If user is asking for changes to your previous response (shorter, longer, different format, etc.), adapt accordingly
4. Don't repeat information already provided unless specifically asked
5. If user's request is simple (like asking for shorter version), you may NOT need to use tools - just reformat your previous answer
6. NEVER say "I don't have any record of a previous conversation" - the conversation is shown above
7. NEVER mention internal field names like "suggestedResponse" - users don't know these terms`;

      console.log(
        "[processFollowUp] Calling analyzeIssueWithTools for follow-up with",
        previousMessages.length,
        "previous messages",
      );

      // Use the agentic workflow so AI can explore the codebase with tools.
      const followUpStartTime = Date.now();
      const followUpMaintainers = await fetchRepositoryMaintainersSafe(
        ctx,
        ticket.repositoryId,
      );
      const latestRepository = await ctx.runQuery(
        internal.repositories.internalQuery.getById,
        { repositoryId: ticket.repositoryId },
      );
      if (!latestRepository) {
        throw new Error("Repository disappeared before follow-up analysis");
      }
      const latestReadiness = getRepositoryAiReadiness(latestRepository);
      if (latestReadiness.state === "waiting") {
        await scheduleReadinessRetry(
          latestRepository,
          latestReadiness.indexVersion,
          latestReadiness.reason,
        );
        return;
      }
      if (latestReadiness.state === "blocked") {
        await ctx.runMutation(
          internal.ticketActions.internalMutation.updateStatus,
          {
            actionId: args.actionId,
            status: "failed",
            errorMessage: latestReadiness.reason,
          },
        );
        return;
      }
      if (latestReadiness.indexVersion !== stableIndexVersion) {
        await scheduleReadinessRetry(
          latestRepository,
          latestReadiness.indexVersion,
          `repository index version changed from ${stableIndexVersion} to ${latestReadiness.indexVersion}`,
        );
        return;
      }
      const latestTicketBeforeAnalysis = await ctx.runQuery(
        internal.tickets.internalQuery.getById,
        { ticketId: action.ticketId },
      );
      if (
        !latestTicketBeforeAnalysis ||
        latestTicketBeforeAnalysis.status !== "open"
      ) {
        await ctx.runMutation(
          internal.ticketActions.internalMutation.updateStatus,
          {
            actionId: args.actionId,
            status: "failed",
            errorMessage: "Ticket is no longer open",
          },
        );
        return;
      }
      if (
        latestTicketBeforeAnalysis.githubTitle !== ticket.githubTitle ||
        (latestTicketBeforeAnalysis.githubBody || "") !==
          (ticket.githubBody || "")
      ) {
        await scheduleReadinessRetry(
          latestRepository,
          stableIndexVersion,
          "ticket content changed before follow-up analysis",
        );
        return;
      }
      if (
        !(await hasVerifiedActiveRepositoryInstallation(ctx, latestRepository))
      ) {
        await scheduleReadinessRetry(
          latestRepository,
          stableIndexVersion,
          "repository installation access changed before follow-up analysis",
        );
        return;
      }
      if (!(await hasCurrentAiLegalAttestation(ctx, ticket.userId))) {
        await ctx.runMutation(
          internal.ticketActions.internalMutation.updateStatus,
          {
            actionId: args.actionId,
            status: "failed",
            errorMessage: AI_LEGAL_ATTESTATION_REQUIRED_MESSAGE,
          },
        );
        return;
      }
      await requireStrictCurrentAiLegalAttestation(ctx, requestedByUserId);
      const followUpProvider = guardAiProviderWithStrictCurrentLegalAttestation(
        ctx,
        requestedByUserId,
        guardAiProviderWithCurrentLegalAttestation(
          ctx,
          ticket.userId,
          createMeteredProvider(ctx, {
            userId: ticket.userId,
            repositoryId: ticket.repositoryId,
            ticketActionId: args.actionId,
            generationKey: `action/${args.actionId}/proposal/${action.proposalVersion}/follow-up/${stableIndexVersion}`,
            operation: "follow-up-answer",
            provider: rawAiProvider,
            requirePendingTicketAction: true,
            recoveryTarget: {
              kind: "follow_up",
              expectedAiInputVersion: ticket.aiInputVersion,
              expectedIndexVersion: stableIndexVersion,
              ...(args.forceApproval === undefined
                ? {}
                : { forceApproval: args.forceApproval }),
            },
            beforeProviderStart: async () => {
              await requireCurrentAiLegalAttestation(ctx, ticket.userId);
              await requireStrictCurrentAiLegalAttestation(
                ctx,
                requestedByUserId,
              );
            },
          }),
        ),
      );
      await requireStrictCurrentAiLegalAttestation(ctx, requestedByUserId);
      const analysisResult = await analyzeIssueWithTools(
        ctx,
        ticket.repositoryId,
        {
          title: ticket.githubTitle,
          body: fullContext,
        },
        followUpProvider,
        {
          responseStyle,
          learnedContext,
          repositoryLanguage: repository?.language,
          maintainers: followUpMaintainers,
          validationFocus: latestUserComment.content,
          indexVersion: stableIndexVersion,
          embeddingDataProvenance: learningEmbeddingDataProvenance,
          requestedByUserId,
        },
      );
      shouldRecoverCheckpointedResult = Boolean(
        analysisResult.success && analysisResult.output?.suggestedResponse,
      );
      const followUpDurationMs = Date.now() - followUpStartTime;

      const [repositoryAfterAnalysis, ticketAfterAnalysis] = await Promise.all([
        ctx.runQuery(internal.repositories.internalQuery.getById, {
          repositoryId: ticket.repositoryId,
        }),
        ctx.runQuery(internal.tickets.internalQuery.getById, {
          ticketId: action.ticketId,
        }),
      ]);
      const readinessAfterAnalysis = repositoryAfterAnalysis
        ? getRepositoryAiReadiness(repositoryAfterAnalysis)
        : null;
      const installationActiveAfterAnalysis = repositoryAfterAnalysis
        ? await hasVerifiedActiveRepositoryInstallation(
            ctx,
            repositoryAfterAnalysis,
          )
        : false;
      const ticketChanged =
        !ticketAfterAnalysis ||
        ticketAfterAnalysis.status !== "open" ||
        ticketAfterAnalysis.githubTitle !== ticket.githubTitle ||
        (ticketAfterAnalysis.githubBody || "") !== (ticket.githubBody || "");
      const repositorySnapshotChanged =
        !readinessAfterAnalysis ||
        readinessAfterAnalysis.state !== "ready" ||
        readinessAfterAnalysis.indexVersion !== stableIndexVersion ||
        !installationActiveAfterAnalysis;

      if (ticketChanged || repositorySnapshotChanged) {
        const staleReason = ticketChanged
          ? "ticket content changed or closed during follow-up analysis"
          : !installationActiveAfterAnalysis
            ? "repository installation access changed during follow-up analysis"
            : readinessAfterAnalysis?.state !== "ready"
              ? readinessAfterAnalysis?.reason ||
                "repository disappeared during follow-up analysis"
              : "repository index version changed during follow-up analysis";

        if (
          !ticketChanged &&
          readinessAfterAnalysis?.indexVersion !== stableIndexVersion &&
          (await replaceStaleGeneration())
        ) {
          return;
        }

        if (
          ticketAfterAnalysis?.status === "open" &&
          readinessAfterAnalysis?.state !== "blocked"
        ) {
          await scheduleReadinessRetry(
            repositoryAfterAnalysis ?? latestRepository,
            readinessAfterAnalysis?.indexVersion ?? stableIndexVersion,
            staleReason,
          );
        } else {
          await ctx.runMutation(
            internal.ticketActions.internalMutation.updateStatus,
            {
              actionId: args.actionId,
              status: "failed",
              errorMessage: staleReason,
            },
          );
        }
        return;
      }
      if (!repositoryAfterAnalysis) return;

      const assistantEnabledAfterAnalysis = isDiscussion
        ? repositoryAfterAnalysis.settings.discussionAssistantEnabled
        : repositoryAfterAnalysis.settings.issueAssistantEnabled;
      if (!assistantEnabledAfterAnalysis) {
        await ctx.runMutation(
          internal.ticketActions.internalMutation.updateStatus,
          {
            actionId: args.actionId,
            status: "failed",
            errorMessage: "Repository assistant was disabled during analysis",
          },
        );
        return;
      }

      // Determine if approval is required based on ticket type
      const configuredRequireApproval = isDiscussion
        ? repositoryAfterAnalysis.settings.requireApprovalForDiscussions
        : repositoryAfterAnalysis.settings.requireApproval;
      const requireApproval =
        args.forceApproval === true || configuredRequireApproval;

      // Create AI log for follow-up (non-blocking - don't fail the workflow)
      try {
        await ctx.runMutation(internal.admin.internalMutation.createAiLog, {
          ticketId: action.ticketId,
          ticketActionId: args.actionId,
          repositoryId: ticket.repositoryId,
          userId: ticket.userId,
          workflowType: "follow_up",
          actionType: "follow_up",
          userPrompt: fullContext,
          aiResponse: analysisResult.output?.suggestedResponse,
          githubRepo: ticket.githubRepo,
          githubNumber: ticket.githubNumber,
          ticketTitle: ticket.githubTitle,
          ticketBody: latestUserComment.content,
          status: analysisResult.success
            ? analysisResult.output?.suggestedResponse
              ? requireApproval
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
          durationMs: followUpDurationMs,
        });
      } catch {
        console.error("[processFollowUp] Failed to create AI log");
      }

      console.log("[processFollowUp] Analysis result:", {
        success: analysisResult.success,
        hasOutput: !!analysisResult.output,
        hasSuggestedResponse: !!analysisResult.output?.suggestedResponse,
        issueType: analysisResult.output?.issueType,
      });

      if (analysisResult.success && analysisResult.output?.suggestedResponse) {
        // Validate AI response before saving (prevents internal field leakage and context loss)
        const responseValidation = validateAiResponse(
          analysisResult.output.suggestedResponse,
          analysisResult.output.confidence,
        );
        if (!responseValidation.isValid) {
          logValidationWarning(
            `processFollowUp action=${args.actionId}`,
            responseValidation,
          );
          // Block responses with context loss or internal field leakage
          if (responseValidation.contextLossPhrases.length > 0) {
            shouldRecoverCheckpointedResult = false;
            throw new Error(
              `AI response contains context loss phrase: "${responseValidation.contextLossPhrases[0]}". This indicates the AI failed to use the provided conversation context.`,
            );
          }
          if (responseValidation.leakedFields.length > 0) {
            shouldRecoverCheckpointedResult = false;
            throw new Error(
              `AI response leaked internal field names: ${responseValidation.leakedFields.join(", ")}. This should not be shown to users.`,
            );
          }
          if (responseValidation.leakedInternalPaths.length > 0) {
            shouldRecoverCheckpointedResult = false;
            throw new Error(
              `AI response leaked internal file paths: ${responseValidation.leakedInternalPaths.join(", ")}. This should not be shown to users.`,
            );
          }
        }

        console.log(
          "[processFollowUp] requireApproval:",
          requireApproval,
          "ticketType:",
          ticket.ticketType,
        );

        // Use completeWithResults which handles requireApproval properly
        // Note: Don't add AI response to chatHistory - it shows in Proposed Changes only
        // Preserve commentNodeId from initial proposedChanges for threaded reply
        const shouldAutoExecute = await ctx.runMutation(
          internal.ticketActions.internalMutation.completeWithResults,
          {
            actionId: args.actionId,
            expectedProposalVersion: action.proposalVersion,
            proposedChanges: {
              // Preserve original comment info (commentId, commentNodeId, author)
              ...action.proposedChanges,
              originalTitle: ticket.githubTitle,
              originalBody: ticket.githubBody || "",
              groundedIndexVersion: stableIndexVersion,
              // Add AI analysis results
              suggestedResponse: analysisResult.output.suggestedResponse,
              issueType: analysisResult.output.issueType,
              reasoning: analysisResult.output.reasoning,
              isActionable: analysisResult.output.isActionable,
              confidence: analysisResult.output.confidence,
              toolsUsed: analysisResult.output.toolsUsed,
              filesRead: analysisResult.output.filesRead,
              filesReadPaths: analysisResult.output.filesReadPaths,
              toolErrors: analysisResult.output.toolErrors,
              wasRepaired: analysisResult.output.wasRepaired,
              validationPassed: analysisResult.output.validationPassed,
            },
            // Preserve the conversation so a later change request can use the
            // original follow-up, the prior response, and the new feedback.
            chatHistory: action.chatHistory,
            requireApproval,
          },
        );
        shouldRecoverCheckpointedResult = false;

        console.log(
          "[processFollowUp] Successfully processed follow-up:",
          args.actionId,
          "shouldAutoExecute:",
          shouldAutoExecute,
        );

        if (shouldAutoExecute) {
          console.log(
            "[processFollowUp] Follow-up execution was scheduled atomically",
          );
        }

        // Extract learning from follow-up comment (non-blocking)
        const learningAuthor = action.proposedChanges?.author;
        const isMaintainerLearning =
          typeof learningAuthor === "string" &&
          followUpMaintainers.some(
            (maintainer) =>
              maintainer.toLowerCase() === learningAuthor.toLowerCase(),
          );
        if (
          latestUserComment &&
          isMaintainerLearning &&
          mightContainTeaching(latestUserComment.content)
        ) {
          try {
            await triggerLearningExtraction(ctx, {
              repositoryId: ticket.repositoryId,
              ticketId: action.ticketId,
              ticketActionId: args.actionId,
              userId: ticket.userId,
              userMessage: latestUserComment.content,
              previousResponse: action.proposedChanges?.suggestedResponse,
              source: `github.com/${ticket.githubRepo}/${isDiscussion ? "discussions" : "issues"}/${ticket.githubNumber}`,
              githubRepo: ticket.githubRepo,
              githubNumber: ticket.githubNumber,
              isTrusted: true,
              embeddingDataProvenance: learningEmbeddingDataProvenance,
              requestedByUserId,
            });
          } catch {
            console.error("[processFollowUp] Failed to extract learning");
          }
        }
      } else {
        // More detailed error message
        const errorDetails = !analysisResult.success
          ? `Analysis failed: ${analysisResult.errors.join(", ")}`
          : `No suggested response for issueType: ${analysisResult.output?.issueType}`;
        throw new Error(errorDetails);
      }
    } catch (error) {
      console.error("[processFollowUp] Failed");

      if (error instanceof ChatBillingError && error.durableRetrySafe) {
        await scheduleProviderRetry(error.reason);
        return;
      }

      if (shouldRecoverCheckpointedResult) {
        try {
          if (
            await ctx.runMutation(
              internal._ai.chatBilling.keepCheckpointedChatActionPending,
              { ticketActionId: args.actionId },
            )
          ) {
            return;
          }
        } catch {
          // The durable checkpoint watchdog can recover without this response.
          return;
        }
      }

      await ctx.runMutation(
        internal.ticketActions.internalMutation.failPendingAction,
        {
          actionId: args.actionId,
          expectedProposalVersion: action.proposalVersion,
          errorMessage:
            error instanceof Error
              ? error.message
              : "Follow-up processing failed",
        },
      );
    }
  },
});

/**
 * Helper function to trigger learning extraction
 */
async function triggerLearningExtraction(
  ctx: ActionCtx,
  options: {
    repositoryId: Id<"repositories">;
    ticketId: Id<"tickets">;
    ticketActionId: Id<"ticketActions">;
    userId: Id<"users">;
    userMessage: string;
    previousResponse?: string;
    source: string;
    githubRepo: string;
    githubNumber: number;
    isTrusted: boolean;
    embeddingDataProvenance: "public_github" | "private_user_input";
    requestedByUserId?: Id<"users">;
  },
) {
  console.log(
    "[triggerLearningExtraction] Extracting learning from message...",
  );
  const startTime = Date.now();

  try {
    await requireCurrentAiLegalAttestation(ctx, options.userId);
    if (options.requestedByUserId) {
      await requireStrictCurrentAiLegalAttestation(
        ctx,
        options.requestedByUserId,
      );
    }
    const learningGenerationKey = await createBillingGenerationKey(
      `learning/${options.ticketActionId}`,
      [
        options.userMessage,
        options.previousResponse ?? "",
        options.source,
        options.embeddingDataProvenance,
      ],
    );
    const ownerGuardedLearningProvider =
      guardAiProviderWithCurrentLegalAttestation(
        ctx,
        options.userId,
        createMeteredProvider(ctx, {
          userId: options.userId,
          repositoryId: options.repositoryId,
          ticketActionId: options.ticketActionId,
          generationKey: learningGenerationKey,
          operation: "learning-extraction",
          provider: await resolveGenerationProvider(ctx, {
            userId: options.userId,
            ticketActionId: options.ticketActionId,
          }),
          requirePendingTicketAction: false,
          beforeProviderStart: async () => {
            await requireCurrentAiLegalAttestation(ctx, options.userId);
            if (options.requestedByUserId) {
              await requireStrictCurrentAiLegalAttestation(
                ctx,
                options.requestedByUserId,
              );
            }
          },
        }),
      );
    const learningProvider = options.requestedByUserId
      ? guardAiProviderWithStrictCurrentLegalAttestation(
          ctx,
          options.requestedByUserId,
          ownerGuardedLearningProvider,
        )
      : ownerGuardedLearningProvider;
    const result = await extractLearning({
      userMessage: options.userMessage,
      previousResponse: options.previousResponse,
      provider: learningProvider,
      beforeProviderCall: async () => {
        await requireCurrentAiLegalAttestation(ctx, options.userId);
        if (options.requestedByUserId) {
          await requireStrictCurrentAiLegalAttestation(
            ctx,
            options.requestedByUserId,
          );
        }
      },
    });

    if (options.requestedByUserId) {
      await requireStrictCurrentAiLegalAttestation(
        ctx,
        options.requestedByUserId,
      );
    }

    const durationMs = Date.now() - startTime;

    // Calculate total tokens (extraction + link summary if any)
    const totalInputTokens =
      (result.usage?.promptTokens || 0) +
      (result.linkSummaryUsage?.promptTokens || 0);
    const totalOutputTokens =
      (result.usage?.completionTokens || 0) +
      (result.linkSummaryUsage?.completionTokens || 0);

    // Create AI log for monitoring
    await ctx.runMutation(internal.admin.internalMutation.createAiLog, {
      ticketId: options.ticketId,
      ticketActionId: options.ticketActionId,
      repositoryId: options.repositoryId,
      userId: options.userId,
      workflowType: "learning_extraction",
      actionType: "learning",
      userPrompt: options.userMessage,
      aiResponse: result.result.hasLearning
        ? `Learning extracted (confidence: ${result.result.confidence}): ${result.result.learning}`
        : `No learning detected (confidence: ${result.result.confidence})`,
      githubRepo: options.githubRepo,
      githubNumber: options.githubNumber,
      ticketTitle: "Learning Extraction",
      ticketBody: options.userMessage,
      status: result.result.hasLearning ? "success" : "success",
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      model: learningProvider.modelId,
      durationMs,
    });

    if (result.result.hasLearning && result.result.learning) {
      console.log("[triggerLearningExtraction] Found learning", {
        confidence: result.result.confidence,
        contentLength: result.result.learning.length,
      });

      // Create the learning with embedding
      if (options.requestedByUserId) {
        await requireStrictCurrentAiLegalAttestation(
          ctx,
          options.requestedByUserId,
        );
      }
      await ctx.runAction(internal.repoLearnings.action.createLearning, {
        repositoryId: options.repositoryId,
        content: result.result.learning,
        source: options.source,
        // No caller key: one action legitimately teaches several times as a
        // maintainer requests changes, and a per-action key would collide those
        // distinct learnings. createLearning derives a content hash instead,
        // which still collapses true retries.
        sourceType: result.result.sourceType,
        isTrusted: options.isTrusted,
        ticketId: options.ticketId,
        embeddingDataProvenance: options.embeddingDataProvenance,
        requestedByUserId: options.requestedByUserId,
      });

      console.log("[triggerLearningExtraction] Learning saved successfully");
    } else {
      console.log(
        "[triggerLearningExtraction] No learning detected (confidence:",
        result.result.confidence,
        ")",
      );
    }
  } catch {
    console.error("[triggerLearningExtraction] Failed");
  }
}
