import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { readEncryptionState } from "./encryptionState";

export const getEncryptionState = internalQuery({
  args: {},
  handler: async (ctx) => await readEncryptionState(ctx),
});

export const getEncryptedKeys = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) =>
    await ctx.db
      .query("providerApiKeys")
      .withIndex("by_user_and_provider", (q) => q.eq("userId", args.userId))
      .collect(),
});

export const getEncryptedKey = internalQuery({
  args: {
    userId: v.id("users"),
    provider: v.union(v.literal("anthropic"), v.literal("openai")),
  },
  handler: async (ctx, args) =>
    await ctx.db
      .query("providerApiKeys")
      .withIndex("by_user_and_provider", (q) =>
        q.eq("userId", args.userId).eq("provider", args.provider),
      )
      .unique(),
});
