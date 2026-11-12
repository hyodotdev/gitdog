import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { apiError } from "../apiKeys/security";

export const remove = mutation({
  args: {
    provider: v.union(v.literal("anthropic"), v.literal("openai")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) apiError("UNAUTHORIZED", "Sign in to remove an API key.");
    const row = await ctx.db
      .query("providerApiKeys")
      .withIndex("by_user_and_provider", (q) =>
        q.eq("userId", userId).eq("provider", args.provider),
      )
      .unique();
    if (row) await ctx.db.delete(row._id);
    return { removed: row !== null, provider: args.provider };
  },
});
