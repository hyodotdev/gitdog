import { mutation } from "../_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { checkRepositoryAccess } from "../_utils/accessControl";

export const remove = mutation({
  args: {
    memberId: v.id("repositoryMembers"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const member = await ctx.db.get(args.memberId);
    if (!member) {
      throw new Error("Member not found");
    }

    // Check if current user is owner
    const access = await checkRepositoryAccess(
      ctx,
      member.repositoryId,
      userId,
    );
    if (!access.isOwner) {
      throw new Error("Only repository owner can remove members");
    }

    await ctx.db.delete(args.memberId);

    return args.memberId;
  },
});

export const leave = mutation({
  args: {
    repositoryId: v.id("repositories"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    // Check if user is a member
    const access = await checkRepositoryAccess(ctx, args.repositoryId, userId);
    if (!access.hasAccess) {
      throw new Error("You are not a member of this repository");
    }

    // Owner cannot leave (they must transfer ownership or delete the repository)
    if (access.isOwner) {
      throw new Error("Owner cannot leave the repository");
    }

    // Find and delete member record
    const member = await ctx.db
      .query("repositoryMembers")
      .withIndex("by_repository_and_user", (q) =>
        q.eq("repositoryId", args.repositoryId).eq("userId", userId),
      )
      .first();

    if (member) {
      await ctx.db.delete(member._id);
    }

    return args.repositoryId;
  },
});
