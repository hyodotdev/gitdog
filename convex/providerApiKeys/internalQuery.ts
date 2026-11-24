import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { readEncryptionState } from "./encryptionState";
import { readPrimaryProvider } from "./priority";

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

/** Which of the owner's keys generation tries first when both work. */
export const getPrimaryProvider = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => await readPrimaryProvider(ctx, args.userId),
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
