import { internalQuery } from "../_generated/server";
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
