import { getAuthUserId } from "@convex-dev/auth/server";
import { query } from "../_generated/server";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const rows = await ctx.db
      .query("providerApiKeys")
      .withIndex("by_user_and_provider", (q) => q.eq("userId", userId))
      .collect();
    return rows.map((row) => ({
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
