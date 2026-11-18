import { internalQuery } from "../_generated/server";
import { checkAccountTokenAllowance } from "../subscriptions/internalQuery";
import { v } from "convex/values";
export const get = internalQuery({
  args: { actionId: v.id("ticketActions") },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.actionId);
    if (!action || action.actionType !== "review") return null;
    const ticket = await ctx.db.get(action.ticketId);
    const repository = ticket?.repositoryId
      ? await ctx.db.get(ticket.repositoryId)
      : null;
    if (
      !ticket ||
      ticket.ticketType !== "pull_request" ||
      !repository ||
      repository.disconnectCleanupPending === true ||
      ticket.deletedAt !== undefined
    )
      return null;
    return { action, ticket, repository };
  },
});
export const getTicket = internalQuery({
  args: { ticketId: v.id("tickets") },
  handler: async (ctx, args) => {
    const ticket = await ctx.db.get(args.ticketId);
    if (!ticket || ticket.deletedAt !== undefined) return null;
    const repository = ticket.repositoryId
      ? await ctx.db.get(ticket.repositoryId)
      : null;
    if (
      !repository ||
      repository.userId !== ticket.userId ||
      repository.disconnectCleanupPending === true
    )
      return null;
    return ticket;
  },
});

/** Which of these pull requests already have a review of any kind. */
export const reviewedNumbers = internalQuery({
  args: { repositoryId: v.id("repositories"), numbers: v.array(v.number()) },
  handler: async (ctx, args) => {
    const reviewed: number[] = [];
    for (const number of args.numbers.slice(0, 30)) {
      const ticket = await ctx.db
        .query("tickets")
        .withIndex("by_github_number", (q) =>
          q.eq("repositoryId", args.repositoryId).eq("githubNumber", number),
        )
        .first();
      if (!ticket || ticket.ticketType !== "pull_request") continue;
      const review = await ctx.db
        .query("ticketActions")
        .withIndex("by_ticket", (q) => q.eq("ticketId", ticket._id))
        .filter((q) => q.eq(q.field("actionType"), "review"))
        .first();
      if (review) reviewed.push(number);
    }
    return reviewed;
  },
});

/** Whether the account has tokens left for a review on Gitdog's key. */
export const hasReviewAllowance = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) =>
    (await checkAccountTokenAllowance(ctx, args.userId)).allowed,
});
