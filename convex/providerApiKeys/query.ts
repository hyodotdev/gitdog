import { getAuthUserId } from "@convex-dev/auth/server";
import { query } from "../_generated/server";
import { readEncryptionState } from "./encryptionState";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const rows = await ctx.db
      .query("providerApiKeys")
      .withIndex("by_user_and_provider", (q) => q.eq("userId", userId))
      .collect();
    const state = rows.length > 0 ? await readEncryptionState(ctx) : null;
    // A missing or wrong server key is a configuration problem, not the
    // user's, so keys are not reported as unreadable then.
    const serviceUnavailable = state !== null && !state.ok;
    return rows.map((row) => ({
      serviceUnavailable,
      // False when the server can no longer decrypt this key.
      readable:
        serviceUnavailable ||
        (state?.ok === true &&
          row.encryptionKeyId === state.keyId &&
          row.unreadableAt === undefined),
      provider: row.provider,
      last4: row.last4,
      status: row.status,
      lastValidatedAt: row.lastValidatedAt,
      lastErrorCode: row.lastError?.code ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  },
});
