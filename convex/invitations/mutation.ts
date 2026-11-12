import { mutation } from "../_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { hasLiveOwnerTeamEntitlement } from "../_utils/accessControl";
import {
  getExactGitHubInstallation,
  isGitHubInstallationReady,
} from "../github/installationAccess";
import { isInvitationRepositoryAvailable } from "./availability";

export const accept = mutation({
  args: {
    invitationId: v.id("invitations"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const invitation = await ctx.db.get(args.invitationId);
    if (!invitation) {
      throw new Error("Invitation not found");
    }

    if (invitation.inviteeUserId !== userId) {
      throw new Error("This invitation is not for you");
    }

    if (invitation.status !== "pending") {
      throw new Error("Invitation is no longer pending");
    }

    // Get repository for notification and fail closed once it is unavailable.
    const repo = await ctx.db.get(invitation.repositoryId);
    if (!isInvitationRepositoryAvailable(repo)) {
      throw new Error("Repository is no longer available");
    }
    const installation = await getExactGitHubInstallation(
      ctx,
      repo.installationId,
    );
    if (
      !isGitHubInstallationReady(installation) ||
      installation.userId !== repo.userId ||
      installation.installationId !== repo.installationId
    ) {
      throw new Error("Repository is no longer available");
    }
    if (!(await hasLiveOwnerTeamEntitlement(ctx, repo.userId))) {
      throw new Error("Repository owner Pro subscription is required");
    }

    const existingMember = await ctx.db
      .query("repositoryMembers")
      .withIndex("by_repository_and_user", (q) =>
        q.eq("repositoryId", invitation.repositoryId).eq("userId", userId),
      )
      .first();

    if (existingMember) {
      throw new Error("User is already a member of this repository");
    }

    // Update invitation status
    await ctx.db.patch(args.invitationId, {
      status: "accepted",
      respondedAt: Date.now(),
    });

    // Create repository member record
    await ctx.db.insert("repositoryMembers", {
      repositoryId: invitation.repositoryId,
      userId,
      githubUsername: invitation.inviteeGithubUsername,
      role: "viewer",
      joinedVia: "invitation",
      invitationId: invitation._id,
      joinedAt: Date.now(),
    });

    // Create notification for inviter
    await ctx.db.insert("notifications", {
      userId: invitation.invitedByUserId,
      type: "invitation_accepted",
      invitationId: args.invitationId,
      repositoryId: invitation.repositoryId,
      title: "Invitation accepted",
      message: `${invitation.inviteeGithubUsername} accepted your invitation to ${repo.githubRepo}`,
      isRead: false,
      createdAt: Date.now(),
    });

    return args.invitationId;
  },
});

export const reject = mutation({
  args: {
    invitationId: v.id("invitations"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const invitation = await ctx.db.get(args.invitationId);
    if (!invitation) {
      throw new Error("Invitation not found");
    }

    if (invitation.inviteeUserId !== userId) {
      throw new Error("This invitation is not for you");
    }

    if (invitation.status !== "pending") {
      throw new Error("Invitation is no longer pending");
    }

    // Get repository for notification
    const repo = await ctx.db.get(invitation.repositoryId);
    if (!repo) {
      throw new Error("Repository not found");
    }

    // Update invitation status
    await ctx.db.patch(args.invitationId, {
      status: "rejected",
      respondedAt: Date.now(),
    });

    // Create notification for inviter
    await ctx.db.insert("notifications", {
      userId: invitation.invitedByUserId,
      type: "invitation_rejected",
      invitationId: args.invitationId,
      repositoryId: invitation.repositoryId,
      title: "Invitation declined",
      message: `${invitation.inviteeGithubUsername} declined your invitation to ${repo.githubRepo}`,
      isRead: false,
      createdAt: Date.now(),
    });

    return args.invitationId;
  },
});

export const cancel = mutation({
  args: {
    invitationId: v.id("invitations"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const invitation = await ctx.db.get(args.invitationId);
    if (!invitation) {
      throw new Error("Invitation not found");
    }

    // Verify user is the one who sent the invitation
    if (invitation.invitedByUserId !== userId) {
      throw new Error("Only the inviter can cancel this invitation");
    }

    if (invitation.status !== "pending") {
      throw new Error("Invitation is no longer pending");
    }

    // Update invitation status
    await ctx.db.patch(args.invitationId, {
      status: "cancelled",
      respondedAt: Date.now(),
    });

    return args.invitationId;
  },
});
