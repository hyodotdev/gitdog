import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

export const PROVIDER_KEY_VALIDATION_INTERVAL_MS = 10_000;

const providerValidator = v.union(v.literal("anthropic"), v.literal("openai"));

export const noteValidationAttempt = internalMutation({
  args: { userId: v.id("users"), provider: providerValidator },
  handler: async (ctx, args): Promise<{ allowed: boolean }> => {
    const now = Date.now();
    const row = await ctx.db
      .query("providerApiKeys")
      .withIndex("by_user_and_provider", (q) =>
        q.eq("userId", args.userId).eq("provider", args.provider),
      )
      .unique();
    if (!row) return { allowed: true };
    if (
      row.lastValidationAttemptAt !== undefined &&
      now - row.lastValidationAttemptAt < PROVIDER_KEY_VALIDATION_INTERVAL_MS
    )
      return { allowed: false };
    await ctx.db.patch(row._id, { lastValidationAttemptAt: now });
    return { allowed: true };
  },
});

export const upsert = internalMutation({
  args: {
    userId: v.id("users"),
    provider: providerValidator,
    ciphertext: v.string(),
    iv: v.string(),
    encryptionKeyId: v.string(),
    last4: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("providerApiKeys")
      .withIndex("by_user_and_provider", (q) =>
        q.eq("userId", args.userId).eq("provider", args.provider),
      )
      .unique();
    const fields = {
      ciphertext: args.ciphertext,
      iv: args.iv,
      encryptionKeyId: args.encryptionKeyId,
      last4: args.last4,
      status: "active" as const,
      lastValidatedAt: now,
      lastError: undefined,
      lastValidationAttemptAt: now,
      updatedAt: now,
    };
    if (existing) await ctx.db.patch(existing._id, fields);
    else
      await ctx.db.insert("providerApiKeys", {
        userId: args.userId,
        provider: args.provider,
        ...fields,
        createdAt: now,
      });
  },
});

export const recordKeyFailure = internalMutation({
  args: {
    userId: v.id("users"),
    provider: providerValidator,
    code: v.union(
      v.literal("invalid"),
      v.literal("out_of_credit"),
      v.literal("rate_limited"),
      v.literal("provider_error"),
    ),
    httpStatus: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("providerApiKeys")
      .withIndex("by_user_and_provider", (q) =>
        q.eq("userId", args.userId).eq("provider", args.provider),
      )
      .unique();
    if (!row) return;
    const now = Date.now();
    await ctx.db.patch(row._id, {
      ...(args.code === "invalid" || args.code === "out_of_credit"
        ? { status: args.code }
        : {}),
      lastError: { code: args.code, httpStatus: args.httpStatus, at: now },
      updatedAt: now,
    });
  },
});

export const markValidated = internalMutation({
  args: { userId: v.id("users"), provider: providerValidator },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("providerApiKeys")
      .withIndex("by_user_and_provider", (q) =>
        q.eq("userId", args.userId).eq("provider", args.provider),
      )
      .unique();
    if (!row) return;
    const now = Date.now();
    await ctx.db.patch(row._id, {
      status: "active",
      lastError: undefined,
      lastValidatedAt: now,
      updatedAt: now,
    });
  },
});
