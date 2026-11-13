import { internal } from "../_generated/api";
import { internalMutation, mutation } from "../_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import {
  canAcceptDisplayedLegalPolicyVersion,
  CURRENT_PRIVACY_POLICY_VERSION,
  CURRENT_TERMS_VERSION,
  hasCurrentLegalAttestation,
  LEGAL_POLICY_VERSION_MISMATCH_CODE,
} from "./legal";
import { resumeRagAfterLegalEligibilityAttestation } from "../ragV2/internalMutation";

const LEGAL_ELIGIBILITY_RESUME_PAGE_SIZE = 10;

export const attestLegalEligibility = mutation({
  args: {
    minimumAgeConfirmed: v.literal(true),
    professionalUseConfirmed: v.literal(true),
    termsAccepted: v.literal(true),
    privacyPolicyAccepted: v.literal(true),
    displayedTermsVersion: v.string(),
    displayedPrivacyPolicyVersion: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }
    if (
      !canAcceptDisplayedLegalPolicyVersion(
        args.displayedTermsVersion,
        CURRENT_TERMS_VERSION,
      ) ||
      !canAcceptDisplayedLegalPolicyVersion(
        args.displayedPrivacyPolicyVersion,
        CURRENT_PRIVACY_POLICY_VERSION,
      )
    ) {
      throw new Error(
        `${LEGAL_POLICY_VERSION_MISMATCH_CODE}: Policies changed after this page loaded`,
      );
    }

    const existing = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    const now = Date.now();
    const legalAttestation = {
      minimumAgeAttestedAt: now,
      professionalUseAttestedAt: now,
      termsAcceptedVersion: CURRENT_TERMS_VERSION,
      privacyPolicyAcceptedVersion: CURRENT_PRIVACY_POLICY_VERSION,
      updatedAt: now,
    };

    if (existing) {
      await ctx.db.patch(existing._id, legalAttestation);
    } else {
      const user = await ctx.db.get(userId);
      if (!user?.name) {
        throw new Error("Authenticated GitHub account is unavailable");
      }

      await ctx.db.insert("userProfiles", {
        userId,
        githubUsername: user.name,
        displayName: user.name,
        avatarUrl: user.image,
        ...legalAttestation,
        createdAt: now,
      });
    }

    await ctx.scheduler.runAfter(
      0,
      internal.users.mutation.resumeLegalEligibilityBlockedRepositories,
      { userId },
    );
    // Separate transaction: a wallet problem must not block consent.
    await ctx.scheduler.runAfter(
      0,
      internal.subscriptions.internalMutation.grantTrialCredit,
      { userId },
    );

    return { success: true };
  },
});

/** Durably drain a bounded page of repositories released by legal consent. */
export const resumeLegalEligibilityBlockedRepositories = internalMutation({
  args: { userId: v.id("users") },
  returns: v.object({
    scanned: v.number(),
    scheduled: v.number(),
    cleared: v.number(),
    hasMore: v.boolean(),
  }),
  handler: async (ctx, { userId }) => {
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (!hasCurrentLegalAttestation(profile)) {
      return { scanned: 0, scheduled: 0, cleared: 0, hasMore: false };
    }

    const ragRepositories = await ctx.db
      .query("repositories")
      .withIndex("by_user_and_rag_legal_eligibility_blocked", (q) =>
        q.eq("userId", userId).gt("ragLegalEligibilityBlockedAt", 0),
      )
      .take(LEGAL_ELIGIBILITY_RESUME_PAGE_SIZE);
    let scheduled = 0;
    let cleared = 0;
    for (const repository of ragRepositories) {
      const outcome = await resumeRagAfterLegalEligibilityAttestation(
        ctx,
        repository,
      );
      if (outcome === "scheduled") {
        scheduled++;
      } else if (outcome === "cleared") {
        cleared++;
      }
    }
    const hasMore =
      ragRepositories.length === LEGAL_ELIGIBILITY_RESUME_PAGE_SIZE;
    if (hasMore) {
      await ctx.scheduler.runAfter(
        0,
        internal.users.mutation.resumeLegalEligibilityBlockedRepositories,
        { userId },
      );
    }
    return {
      scanned: ragRepositories.length,
      scheduled,
      cleared,
      hasMore,
    };
  },
});

export const createOrUpdateProfile = internalMutation({
  args: {
    displayName: v.optional(v.string()),
    bio: v.optional(v.string()),
    githubUsername: v.string(),
    avatarUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const existing = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();

    const now = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        ...args,
        updatedAt: now,
      });
      return existing._id;
    }

    const profileId = await ctx.db.insert("userProfiles", {
      userId,
      githubUsername: args.githubUsername,
      displayName: args.displayName,
      bio: args.bio,
      avatarUrl: args.avatarUrl,
      createdAt: now,
      updatedAt: now,
    });

    return profileId;
  },
});

export const ensureProfileFromAuth = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    // Get user from auth table
    const user = await ctx.db.get(userId);
    if (!user) {
      throw new Error("User not found");
    }

    // For now, use the user's name as github username
    // This will be corrected when the user logs in through the updated auth flow
    const githubUsername = user.name || "unknown";

    // Check if profile already exists
    const existing = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();

    const now = Date.now();

    if (existing) {
      // Update existing profile with correct GitHub username
      await ctx.db.patch(existing._id, {
        githubUsername,
        updatedAt: now,
      });
      return existing._id;
    }

    // Create profile
    const profileId = await ctx.db.insert("userProfiles", {
      userId,
      githubUsername,
      displayName: user.name,
      avatarUrl: user.image,
      createdAt: now,
      updatedAt: now,
    });

    return profileId;
  },
});
