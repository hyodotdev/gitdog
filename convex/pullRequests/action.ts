import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { resolveVerifiedRepositoryAccess } from "../github/repositoryIdentity";
import { requireCurrentAiLegalAttestation } from "../_ai/legalAttestation";
import { getPullRequest, isBotPullRequestAuthor } from "./github";

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
