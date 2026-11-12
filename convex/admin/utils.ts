import { getAuthUserId } from "@convex-dev/auth/server";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type AdminCheckResult = {
  isAdmin: boolean;
  userId: Id<"users"> | null;
};

/**
 * Shared admin check utility for admin queries and mutations.
 * Returns both admin status and userId for convenience.
 */
export async function checkAdmin(
  ctx: QueryCtx | MutationCtx,
): Promise<AdminCheckResult> {
  const userId = await getAuthUserId(ctx);
  if (!userId) {
    return { isAdmin: false, userId: null };
  }

  const profile = await ctx.db
    .query("userProfiles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();

  return {
    isAdmin: profile?.isAdmin === true,
    userId,
  };
}

/**
 * Type guard to validate if a string is a valid Convex ID format.
 * Note: This only checks format, not existence in database.
 */
export function isValidConvexId(id: string): boolean {
  // Convex IDs are base64-like strings, typically 32+ chars
  return (
    typeof id === "string" && id.length >= 20 && /^[a-zA-Z0-9_-]+$/.test(id)
  );
}
