import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { resolveVerifiedRepositoryAccess } from "../github/repositoryIdentity";
import { requireCurrentAiLegalAttestation } from "../_ai/legalAttestation";
import { getPullRequest, isBotPullRequestAuthor } from "./github";
import {
  runPullRequestCommand,
  type PullRequestCommandResult,
} from "./internalAction";

export const recheck = action({
  args: { actionId: v.id("ticketActions") },
  handler: async (ctx, args): Promise<Id<"ticketActions">> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const state = await ctx.runQuery(
      internal.pullRequests.internalQuery.get,
      args,
    );
    if (
      !state ||
      state.ticket.userId !== userId ||
      state.repository.userId !== userId
    )
      throw new Error("Review not found or not authorized");
    if (state.action.status !== "failed")
      throw new Error("Only a failed review can be rechecked");
    await requireCurrentAiLegalAttestation(ctx, userId);
    const access = await resolveVerifiedRepositoryAccess(
      ctx,
      state.repository._id,
    );
    const observedAt = Date.now();
    const pr = await getPullRequest(access, state.ticket.githubNumber);
    if (isBotPullRequestAuthor(pr.user))
      throw new Error("Bot-authored pull requests are not reviewed");
    if (pr.draft) throw new Error("Draft pull requests cannot be rechecked");
    return await ctx.runMutation(
      internal.pullRequests.internalMutation.queueVerification,
      {
        actionId: args.actionId,
        requestedByUserId: userId,
        observedAt,
        expectedObservedAt: state.ticket.pullRequestObservedAt,
        author: pr.user.login,
        open: pr.state === "open",
        source: {
          headSha: pr.head.sha,
          baseSha: pr.base.sha,
          title: pr.title,
          body: pr.body ?? "",
        },
      },
    );
  },
});

/**
 * The CLI and web counterpart of the "@gitdogbot review", "full review" and
 * "resolve" pull request comments. The command reply is returned instead of
 * posted. The review itself, a limit notice if it runs out of tokens, and a
 * note when there is nothing new to review are posted as for comments.
 */
export const command = action({
  args: {
    ticketId: v.id("tickets"),
    command: v.union(
      v.literal("review"),
      v.literal("full_review"),
      v.literal("resolve"),
    ),
  },
  handler: async (ctx, args): Promise<PullRequestCommandResult> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const ticket = await ctx.runQuery(
      internal.pullRequests.internalQuery.getTicket,
      { ticketId: args.ticketId },
    );
    if (
      !ticket ||
      ticket.ticketType !== "pull_request" ||
      ticket.userId !== userId ||
      !ticket.repositoryId
    )
      throw new Error("Pull request not found or not authorized");
    if (args.command !== "resolve")
      await requireCurrentAiLegalAttestation(ctx, userId);
    const access = await resolveVerifiedRepositoryAccess(
      ctx,
      ticket.repositoryId,
    );
    return await runPullRequestCommand(
      ctx,
      access,
      ticket.repositoryId,
      ticket.githubNumber,
      args.command,
    );
  },
});
