import { query } from "../_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import {
  hasCurrentLegalAttestation,
  requiresCurrentLegalAttestation,
} from "./legal";

export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return null;
    }

    const user = await ctx.db.get(userId);
    if (!user) {
      return null;
    }

    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();

    // Exclude isAdmin from client response
    if (profile) {
      const {
        isAdmin,
        minimumAgeAttestedAt,
        professionalUseAttestedAt,
        termsAcceptedVersion,
        privacyPolicyAcceptedVersion,
        ...safeProfile
      } = profile;
      void isAdmin; // Explicitly mark as intentionally unused
      void minimumAgeAttestedAt;
      void professionalUseAttestedAt;
      void termsAcceptedVersion;
      void privacyPolicyAcceptedVersion;
      const hasCurrentAttestation = hasCurrentLegalAttestation(profile);
      return {
        ...user,
        profile: safeProfile,
        hasCurrentLegalAttestation: hasCurrentAttestation,
        requiresCurrentLegalAttestation:
          requiresCurrentLegalAttestation(profile),
      };
    }

    return {
      ...user,
      profile,
      hasCurrentLegalAttestation: false,
      requiresCurrentLegalAttestation: requiresCurrentLegalAttestation(profile),
    };
  },
});

export const getProfile = query({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();

    // Exclude isAdmin from client response
    if (profile) {
      const {
        isAdmin,
        minimumAgeAttestedAt,
        professionalUseAttestedAt,
        termsAcceptedVersion,
        privacyPolicyAcceptedVersion,
        ...safeProfile
      } = profile;
      void isAdmin; // Explicitly mark as intentionally unused
      void minimumAgeAttestedAt;
      void professionalUseAttestedAt;
      void termsAcceptedVersion;
      void privacyPolicyAcceptedVersion;
      return safeProfile;
    }

    return profile;
  },
});
