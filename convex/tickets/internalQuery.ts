import { internalQuery } from "../_generated/server";
import { v } from "convex/values";

/**
 * Get ticket by ID (internal)
 */
export const getById = internalQuery({
  args: {
    ticketId: v.id("tickets"),
  },
  handler: async (ctx, args) => {
    const ticket = await ctx.db.get(args.ticketId);
    return ticket?.githubLifecycleOnly === true ? null : ticket;
  },
});
