import { query } from "../_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { checkRepositoryAccess } from "../_utils/accessControl";

const REPOSITORY_MEMBER_LIST_LIMIT = 500;

export const list = query({
  args: {
    repositoryId: v.id("repositories"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return [];
    }

    // Check if user has access to this repository
    const access = await checkRepositoryAccess(ctx, args.repositoryId, userId);
    if (!access.hasAccess) {
      return [];
    }

    // Get the repository to include owner
    const repo = await ctx.db.get(args.repositoryId);
    if (!repo) {
      return [];
    }

    // Get owner's profile
    const ownerProfile = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", repo.userId))
      .first();

    // Get all members from repositoryMembers table
    const members = await ctx.db
      .query("repositoryMembers")
      .withIndex("by_repository", (q) =>
        q.eq("repositoryId", args.repositoryId),
      )
      .take(REPOSITORY_MEMBER_LIST_LIMIT);

    // Batch fetch profiles for all members in parallel
    const profiles = await Promise.all(
      members.map((m) =>
        ctx.db
          .query("userProfiles")
          .withIndex("by_user", (q) => q.eq("userId", m.userId))
          .first(),
      ),
    );

    // Create profile map for O(1) lookup
    const profileMap = new Map(
      profiles
        .filter((p): p is NonNullable<typeof p> => p !== null)
        .map((p) => [p.userId, p]),
    );

    // Build the result list - add owner first
    const result = [
      {
        _id: null as unknown as (typeof members)[0]["_id"], // Owner doesn't have a member record
        userId: repo.userId,
        githubUsername: ownerProfile?.githubUsername ?? "unknown",
        displayName: ownerProfile?.displayName,
        avatarUrl: ownerProfile?.avatarUrl,
        role: "owner" as const,
        joinedVia: "owner" as const,
        joinedAt: repo.createdAt,
        isCurrentUser: repo.userId === userId,
      },
      // Add other members
      ...members.map((member) => {
        const profile = profileMap.get(member.userId);
        return {
          _id: member._id,
          userId: member.userId,
          githubUsername: member.githubUsername,
          displayName: profile?.displayName,
          avatarUrl: profile?.avatarUrl,
          role: "viewer" as const,
          joinedVia: member.joinedVia,
          joinedAt: member.joinedAt,
          isCurrentUser: member.userId === userId,
        };
      }),
    ];

    return result;
  },
});

export const getMyRole = query({
  args: {
    repositoryId: v.id("repositories"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return null;
    }

    const access = await checkRepositoryAccess(ctx, args.repositoryId, userId);
    if (!access.hasAccess) {
      return null;
    }

    return {
      role: access.role,
      isOwner: access.isOwner,
      canEdit: access.canEdit,
      canManageMembers: access.canManageMembers,
    };
  },
});
