import { mutation } from "../_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";

/**
 * Soft delete a ticket
 */
export const softDelete = mutation({
  args: {
    id: v.id("tickets"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const ticket = await ctx.db.get(args.id);
    if (!ticket || ticket.githubLifecycleOnly === true) {
      throw new Error("Ticket not found");
    }

    if (ticket.userId !== userId) {
      throw new Error("Not authorized to delete this ticket");
    }

    if (ticket.deletedAt) {
      throw new Error("Ticket already deleted");
    }

    await ctx.db.patch(args.id, {
      deletedAt: Date.now(),
    });

    return { success: true };
  },
});

/**
 * Restore a soft deleted ticket
 */
export const restore = mutation({
  args: {
    id: v.id("tickets"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const ticket = await ctx.db.get(args.id);
    if (!ticket || ticket.githubLifecycleOnly === true) {
      throw new Error("Ticket not found");
    }

    if (ticket.userId !== userId) {
      throw new Error("Not authorized to restore this ticket");
    }

    if (!ticket.deletedAt) {
      throw new Error("Ticket is not deleted");
    }

    await ctx.db.patch(args.id, {
      deletedAt: undefined,
    });

    return { success: true };
  },
});
