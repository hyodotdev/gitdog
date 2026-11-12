import { query } from "../_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { checkRepositoryAccess } from "../_utils/accessControl";
import { getInvitationUnavailableReason } from "./availability";

export const INVITATION_QUERY_LIMIT = 500;

export const listPending = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return [];
    }

    const invitations = await ctx.db
      .query("invitations")
      .withIndex("by_invitee_user_and_status", (q) =>
        q.eq("inviteeUserId", userId).eq("status", "pending"),
      )
      .take(INVITATION_QUERY_LIMIT);

    // Get unique repository IDs and fetch repos in parallel
    const repoIds = [...new Set(invitations.map((inv) => inv.repositoryId))];
    const repos = await Promise.all(repoIds.map((id) => ctx.db.get(id)));

    const availableRepos = await Promise.all(
      repos.map(async (repo) =>
        repo && (await getInvitationUnavailableReason(ctx, repo)) === undefined
          ? repo
          : null,
      ),
    );

    // Create a map for O(1) lookup
    const repoMap = new Map(
      availableRepos
        .filter((repo): repo is NonNullable<typeof repo> => repo !== null)
        .map((repo) => [repo._id, repo]),
    );

    // Hide invitations whose repository is no longer available.
    const pendingInvitations = invitations.flatMap((inv) => {
      const repo = repoMap.get(inv.repositoryId);
      if (!repo) {
        return [];
      }

      return [
        {
          ...inv,
          role: "viewer" as const,
          repository: {
            _id: repo._id,
            githubRepo: repo.githubRepo,
            name: repo.name,
            description: repo.description,
          },
        },
      ];
    });

    return pendingInvitations;
  },
});

export const listForRepository = query({
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

    // Only owner can see all invitations
    if (!access.isOwner) {
      return [];
    }

    const invitations = await ctx.db
      .query("invitations")
      .withIndex("by_repository", (q) =>
        q.eq("repositoryId", args.repositoryId),
      )
      .order("desc")
      .take(INVITATION_QUERY_LIMIT);

    return invitations.map((invitation) => ({
      ...invitation,
      role: "viewer" as const,
    }));
  },
});

export const getPendingForRepository = query({
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
    if (!access.isOwner) {
      return [];
    }

    const invitations = await ctx.db
      .query("invitations")
      .withIndex("by_repository_and_status", (q) =>
        q.eq("repositoryId", args.repositoryId).eq("status", "pending"),
      )
      .take(INVITATION_QUERY_LIMIT);

    return invitations.map((invitation) => ({
      ...invitation,
      role: "viewer" as const,
    }));
  },
});
