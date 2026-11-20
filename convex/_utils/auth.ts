import { getAuthUserId as getSessionUserId } from "@convex-dev/auth/server";
import type { Auth } from "convex/server";
import type { Id } from "../_generated/dataModel";

type SessionLookupCtx = Parameters<typeof getSessionUserId>[0];

/**
 * The signed-in user, from the caller's session in the auth component, or
 * null. Works in queries, mutations and actions: @convex-dev/auth types its
 * context after a query's runQuery, which an action's does not match.
 */
export async function getAuthUserId(ctx: {
  auth: Auth;
  runQuery: unknown;
}): Promise<Id<"users"> | null> {
  return await getSessionUserId<"users">(ctx as SessionLookupCtx);
}
