import { mutation, type MutationCtx } from "../_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";

// Helper to check if current user is admin
async function requireAdmin(ctx: MutationCtx, userId: Id<"users">) {
  const profile = await ctx.db
    .query("userProfiles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();

  if (!profile?.isAdmin) {
    throw new Error("unauthorized");
  }
}

export const updateAiLogStatus = mutation({
  args: {
    logId: v.id("aiLogs"),
    status: v.union(
      v.literal("success"),
      v.literal("failed"),
      v.literal("pending_approval"),
      v.literal("approved"),
      v.literal("rejected"),
      v.literal("request_changes"),
    ),
    userFeedback: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("not authenticated");
    }

    await requireAdmin(ctx, userId);

    const log = await ctx.db.get(args.logId);
    if (!log) {
      throw new Error("log not found");
    }

    const updates: Record<string, unknown> = {
      status: args.status,
    };

    if (args.userFeedback !== undefined) {
      updates.userFeedback = args.userFeedback;
    }

    if (args.status === "request_changes") {
      updates.requestChangesCount = (log.requestChangesCount ?? 0) + 1;
    }

    await ctx.db.patch(args.logId, updates);

    return { success: true };
  },
});

export const deleteAiLog = mutation({
  args: {
    logId: v.id("aiLogs"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("not authenticated");
    }

    await requireAdmin(ctx, userId);

    const log = await ctx.db.get(args.logId);
    if (!log) {
      throw new Error("log not found");
    }

    await ctx.db.delete(args.logId);

    return { success: true };
  },
});
