import { getAuthUserId } from "../_utils/auth";
import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { apiError } from "../apiKeys/security";

const providerValidator = v.union(v.literal("anthropic"), v.literal("openai"));

/**
 * Choose which saved key reviews try first when both work; the other one
 * takes over when the first runs out of credit or is rejected.
 */
export const setPriority = mutation({
  args: { primaryProvider: providerValidator },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) apiError("UNAUTHORIZED", "Sign in to choose a key order.");
    const row = await ctx.db
      .query("providerKeyPreferences")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    const updatedAt = Date.now();
    if (row)
      await ctx.db.patch(row._id, {
        primaryProvider: args.primaryProvider,
        updatedAt,
      });
    else
      await ctx.db.insert("providerKeyPreferences", {
        userId,
        primaryProvider: args.primaryProvider,
        updatedAt,
      });
    return { primaryProvider: args.primaryProvider };
  },
});

export const remove = mutation({
  args: { provider: providerValidator },
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
