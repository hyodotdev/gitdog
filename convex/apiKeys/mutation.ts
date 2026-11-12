import { mutation } from "../_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { apiError, ownedRepository } from "./security";

export const revoke = mutation({
  args: { keyId: v.id("projectApiKeys") },
  handler: async (ctx, args) => {
    const key = await ctx.db.get(args.keyId);
    const userId = await getAuthUserId(ctx);
    if (!userId) apiError("UNAUTHORIZED", "Sign in to revoke an API key.");
    if (!key) apiError("NOT_FOUND", "API key not found.");
    await ownedRepository(ctx, userId, key.repositoryId);
    if (key.revokedAt === undefined)
      await ctx.db.patch(key._id, { revokedAt: Date.now() });
    return { revoked: true, keyId: key._id };
  },
});
