import { action } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  updateIssue,
  addIssueComment,
  updateDiscussion,
  addDiscussionComment,
  addDiscussionReply,
  getIssue,
  getDiscussion,
  getIssueComment,
  getDiscussionComment,
  isGitdogInvocationUnchanged,
} from "../github/helpers";
import { buildFormattedGitdogBody } from "../_utils/gitdogFormat";
import { resolveVerifiedRepositoryAccess } from "../github/repositoryIdentity";
import { getGitdogFollowUpFooter } from "../github/botIdentity";
import {
  attachExecutionMarker,
  buildMarkedResponseComment,
  CLAIMED_EXECUTION_RECOVERY_GRACE_MS,
} from "./executionRecovery";

const FOOTER_MESSAGE = getGitdogFollowUpFooter();

/**
 * Approve a pending action
 */
export const approve = action({
  args: {
    actionId: v.id("ticketActions"),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ success: boolean; reason?: string; refreshing?: true }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    // Get action
    const ticketAction = await ctx.runQuery(
      internal.ticketActions.internalQuery.getById,
      { actionId: args.actionId },
    );

    if (!ticketAction) {
      throw new Error("Action not found");
    }

    // Verify ticket ownership
    const ticket = await ctx.runQuery(internal.tickets.internalQuery.getById, {
      ticketId: ticketAction.ticketId,
    });

    if (!ticket || ticket.userId !== userId) {
      throw new Error("Not authorized");
    }

    if (ticketAction.actionType === "review") {
      return await ctx.runAction(internal.pullRequests.internalAction.publish, {
        actionId: args.actionId,
        manual: true,
      });
    }

    if (ticketAction.status !== "pending_approval") {
      throw new Error("Action is not pending approval");
    }

    // Get repository info for GitHub API
    if (!ticket.repositoryId) {
      throw new Error("Ticket has no repository linked");
    }

    const failTerminalPreflight = async (message: string): Promise<void> => {
      await ctx.runMutation(
        internal.ticketActions.internalMutation.failExecutionAttempt,
        {
          actionId: args.actionId,
          mode: "manual_approval",
          expectedProposalVersion: ticketAction.proposalVersion,
          errorMessage: message,
        },
      );
    };
    let executionClaimedAt: number | undefined;
    try {
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
          "Ticket content changed after this suggestion was generated. Regenerate it before approval.";
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

      // Claim immediately before the external write. This transition is
      // atomic with the status check, so concurrent approvals cannot publish
      // the same action twice.
      const executionClaim = await ctx.runMutation(
        internal.ticketActions.internalMutation.claimForExecution,
        {
          actionId: args.actionId,
          mode: "manual_approval",
          expectedProposalVersion: ticketAction.proposalVersion,
        },
      );
      if (!executionClaim.claimed) {
        if (executionClaim.refreshing) {
          return { success: false, refreshing: true };
        }
        await ctx.runMutation(
          internal.ticketActions.internalMutation.failExecutionAttempt,
          {
            actionId: args.actionId,
            mode: "manual_approval",
            expectedProposalVersion: ticketAction.proposalVersion,
            errorMessage: executionClaim.reason,
          },
        );
        return { success: false, reason: executionClaim.reason };
      }
      executionClaimedAt = executionClaim.claimedAt;

      // Re-resolve after the atomic claim so a suspension, transfer, rename,
      // or name reuse between preflight and write fails closed.
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
          if (!publication.ready) {
            return publication.refreshing
              ? { success: false, refreshing: true }
              : { success: false, reason: publication.reason };
          }
        }

        // Use appropriate API based on ticket type
        let commentId: string | number;
        if (isDiscussion) {
          // For follow_up actions, try to reply to the specific comment if commentNodeId exists
          const replyToNodeId = ticketAction.proposedChanges?.commentNodeId;
          if (
            ticketAction.actionType === "follow_up" &&
            replyToNodeId &&
            typeof replyToNodeId === "string"
          ) {
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

      return { success: true };
    } catch (error) {
      console.error("[approve] GitHub API request failed");

      // A transport failure can be ambiguous: GitHub may have committed the
      // write even when this action did not receive a response. Reconcile the
      // opaque marker after a grace period instead of publishing again now.
      if (executionClaimedAt !== undefined) {
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
      }

      throw error;
    }
  },
});

/**
 * Reject a pending action
 */
export const reject = action({
  args: {
    actionId: v.id("ticketActions"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    // Get action
    const ticketAction = await ctx.runQuery(
      internal.ticketActions.internalQuery.getById,
      { actionId: args.actionId },
    );

    if (!ticketAction) {
      throw new Error("Action not found");
    }

    // Verify ticket ownership
    const ticket = await ctx.runQuery(internal.tickets.internalQuery.getById, {
      ticketId: ticketAction.ticketId,
    });

    if (!ticket || ticket.userId !== userId) {
      throw new Error("Not authorized");
    }

    // Reject only if approval has not already claimed execution.
    await ctx.runMutation(
      internal.ticketActions.internalMutation.rejectPendingApproval,
      { actionId: args.actionId },
    );

    return { success: true };
  },
});

/**
 * Request changes for a pending action
 */
export const requestChanges = action({
  args: {
    actionId: v.id("ticketActions"),
    feedback: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    // Get action
    const ticketAction = await ctx.runQuery(
      internal.ticketActions.internalQuery.getById,
      { actionId: args.actionId },
    );

    if (!ticketAction) {
      throw new Error("Action not found");
    }

    // Verify ticket ownership
    const ticket = await ctx.runQuery(internal.tickets.internalQuery.getById, {
      ticketId: ticketAction.ticketId,
    });

    if (!ticket || ticket.userId !== userId) {
      throw new Error("Not authorized");
    }

    if (ticketAction.actionType === "review") {
      throw new Error(
        "Reject this review and wait for a new commit to request a fresh review",
      );
    }

    // Record feedback, transition to pending, and schedule regeneration in a
    // single mutation so this cannot race an approval/external write.
    await ctx.runMutation(
      internal.ticketActions.internalMutation.requestChangesForAction,
      {
        actionId: args.actionId,
        feedback: args.feedback,
      },
    );

    return { success: true };
  },
});
