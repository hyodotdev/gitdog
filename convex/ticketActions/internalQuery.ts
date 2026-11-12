import { internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { paginatedCollect } from "../_utils/pagination";

/**
 * Get action by ID (internal)
 */
export const getById = internalQuery({
  args: {
    actionId: v.id("ticketActions"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.actionId);
  },
});

/**
 * Get pending approval actions for a ticket
 */
export const getPendingByTicket = internalQuery({
  args: {
    ticketId: v.id("tickets"),
  },
  handler: async (ctx, args) => {
    return await paginatedCollect(
      ctx.db
        .query("ticketActions")
        .withIndex("by_ticket_and_status", (q) =>
          q.eq("ticketId", args.ticketId).eq("status", "pending_approval"),
        ),
    );
  },
});

/**
 * Get all actions for a ticket
 */
export const listByTicket = internalQuery({
  args: {
    ticketId: v.id("tickets"),
  },
  handler: async (ctx, args) => {
    return await paginatedCollect(
      ctx.db
        .query("ticketActions")
        .withIndex("by_ticket", (q) => q.eq("ticketId", args.ticketId))
        .order("asc"),
    );
  },
});

/**
 * Find a completed action by its posted GitHub comment ID.
 * Used for detecting when a bot comment gets deleted on GitHub.
 */
export const findByGithubCommentId = internalQuery({
  args: {
    ticketId: v.id("tickets"),
    commentId: v.union(v.number(), v.string()),
  },
  handler: async (ctx, args) => {
    // Search through completed actions for this ticket to find one with matching commentId
    const actions = await paginatedCollect(
      ctx.db
        .query("ticketActions")
        .withIndex("by_ticket_and_status", (q) =>
          q.eq("ticketId", args.ticketId).eq("status", "completed"),
        ),
    );

    return (
      actions.find((action) => {
        const result = action.executionResult as
          { commentId?: number | string } | undefined;
        return result?.commentId === args.commentId;
      }) ?? null
    );
  },
});
