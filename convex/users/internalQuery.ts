import { v } from "convex/values";

import { internalQuery } from "../_generated/server";
import {
  hasCurrentLegalAttestation as hasCurrentLegalAttestationValue,
  satisfiesCurrentLegalAttestationRequirement,
} from "./legal";

export const hasCurrentLegalAttestation = internalQuery({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, { userId }) => {
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();

    return satisfiesCurrentLegalAttestationRequirement(profile);
  },
});

/** Strict gate for direct-user AI requests. */
export const hasStrictCurrentLegalAttestation = internalQuery({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    if (!user) return false;
    const profiles = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(2);
    return (
      profiles.length === 1 && hasCurrentLegalAttestationValue(profiles[0])
    );
  },
});
