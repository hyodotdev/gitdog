import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

export const PROVIDER_KEY_VALIDATION_WINDOW_MS = 10 * 60 * 1_000;
export const PROVIDER_KEY_VALIDATION_LIMIT = 5;

const providerValidator = v.union(v.literal("anthropic"), v.literal("openai"));

// Each validation sends the submitted key to a provider from Gitdog's
// servers, so the limit is per user across providers and saved keys.
export const noteValidationAttempt = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args): Promise<{ allowed: boolean }> => {
    const now = Date.now();
    const windowStart = now - PROVIDER_KEY_VALIDATION_WINDOW_MS;
    const expired = await ctx.db
      .query("providerKeyValidationAttempts")
      .withIndex("by_user_and_attempted_at", (q) =>
        q.eq("userId", args.userId).lt("attemptedAt", windowStart),
      )
      .take(20);
    for (const attempt of expired) await ctx.db.delete(attempt._id);
    const recent = await ctx.db
      .query("providerKeyValidationAttempts")
      .withIndex("by_user_and_attempted_at", (q) =>
        q.eq("userId", args.userId).gte("attemptedAt", windowStart),
      )
      .take(PROVIDER_KEY_VALIDATION_LIMIT);
    if (recent.length >= PROVIDER_KEY_VALIDATION_LIMIT)
      return { allowed: false };
    await ctx.db.insert("providerKeyValidationAttempts", {
      userId: args.userId,
      attemptedAt: now,
    });
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
    const nextStatus =
      args.code === "invalid" || args.code === "out_of_credit"
        ? args.code
        : row.status;
    // Notify once per transition, not once per failed request.
    if (nextStatus !== row.status) {
      const name = args.provider === "anthropic" ? "Anthropic" : "OpenAI";
      await ctx.db.insert("notifications", {
        userId: args.userId,
        type: "provider_key_failed",
        title:
          nextStatus === "invalid"
            ? `${name} API key rejected`
            : `${name} API key out of credit`,
        message:
          nextStatus === "invalid"
            ? `${name} rejected your saved API key, so Gitdog paused work that uses it. Replace or remove it in your profile.`
            : `Your ${name} API key is out of credit, so Gitdog paused work that uses it. Add credit or replace the key in your profile.`,
        isRead: false,
        createdAt: now,
      });
    }
    await ctx.db.patch(row._id, {
      status: nextStatus,
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
