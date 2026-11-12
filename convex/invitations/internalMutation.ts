import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { checkProSubscription } from "../_utils/accessControl";
import {
  getExactGitHubInstallation,
  isGitHubInstallationReady,
} from "../github/installationAccess";
import { isInvitationRepositoryAvailable } from "./availability";

const GITHUB_LOGIN_MAX_LENGTH = 39;
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/** Atomically re-attest access and bind the invitation to an OAuth account ID. */
export const create = internalMutation({
  args: {
    inviterUserId: v.id("users"),
    repositoryId: v.id("repositories"),
    expectedInstallationId: v.number(),
    githubAccountId: v.number(),
    canonicalGithubLogin: v.string(),
    role: v.literal("viewer"),
  },
  handler: async (ctx, args) => {
    if (
      !Number.isSafeInteger(args.githubAccountId) ||
      args.githubAccountId <= 0 ||
      args.canonicalGithubLogin.length === 0 ||
      args.canonicalGithubLogin.length > GITHUB_LOGIN_MAX_LENGTH ||
      args.canonicalGithubLogin !== args.canonicalGithubLogin.trim() ||
      !GITHUB_LOGIN_PATTERN.test(args.canonicalGithubLogin)
    ) {
      throw new Error("Invalid verified GitHub account");
    }
    if (!(await checkProSubscription(ctx, args.inviterUserId))) {
      throw new Error("Pro subscription required to invite members");
    }

    const repository = await ctx.db.get(args.repositoryId);
    if (!repository || repository.userId !== args.inviterUserId) {
      throw new Error("Only repository owner can invite members");
    }
    if (
      !isInvitationRepositoryAvailable(repository) ||
      repository.installationId !== args.expectedInstallationId
    ) {
      throw new Error("Repository is no longer available");
    }

    const installation = await getExactGitHubInstallation(
      ctx,
      args.expectedInstallationId,
    );
    if (
      !isGitHubInstallationReady(installation) ||
      installation.installationId !== repository.installationId ||
      installation.userId !== args.inviterUserId ||
      installation.installationId !== args.expectedInstallationId
    ) {
      throw new Error("GitHub App installation is not ready");
    }

    const account = await ctx.db
      .query("authAccounts")
      .withIndex("providerAndAccountId", (q) =>
        q
          .eq("provider", "github")
          .eq("providerAccountId", args.githubAccountId.toString()),
      )
      .unique();
    if (!account || !(await ctx.db.get(account.userId))) {
      throw new Error("User not found. They must have a Gitdog account.");
    }
    const inviteeUserId = account.userId;

    if (inviteeUserId === repository.userId) {
      throw new Error("User is already a member of this repository");
    }
    const existingMember = await ctx.db
      .query("repositoryMembers")
      .withIndex("by_repository_and_user", (q) =>
        q.eq("repositoryId", args.repositoryId).eq("userId", inviteeUserId),
      )
      .first();
    if (existingMember) {
      throw new Error("User is already a member of this repository");
    }

    const pendingInvitation = await ctx.db
      .query("invitations")
      .withIndex("by_repository_and_invitee_user_and_status", (q) =>
        q
          .eq("repositoryId", args.repositoryId)
          .eq("inviteeUserId", inviteeUserId)
          .eq("status", "pending"),
      )
      .first();
    if (pendingInvitation) {
      throw new Error("An invitation is already pending for this user");
    }

    const inviter = await ctx.db.get(args.inviterUserId);
    const inviterUsername =
      typeof inviter?.name === "string" && inviter.name.trim().length > 0
        ? inviter.name.trim()
        : "Gitdog user";
    const now = Date.now();
    const invitationId = await ctx.db.insert("invitations", {
      repositoryId: args.repositoryId,
      invitedByUserId: args.inviterUserId,
      invitedByUsername: inviterUsername,
      inviteeGithubUsername: args.canonicalGithubLogin,
      inviteeUserId,
      role: args.role,
      status: "pending",
      createdAt: now,
    });
    await ctx.db.insert("notifications", {
      userId: inviteeUserId,
      type: "invitation_received",
      invitationId,
      repositoryId: args.repositoryId,
      title: "New invitation",
      message: `${inviterUsername} invited you to ${repository.githubRepo}`,
      isRead: false,
      createdAt: now,
    });

    return invitationId;
  },
});
