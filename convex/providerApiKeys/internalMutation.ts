import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { readExpectedEncryptionKeyId } from "./encryptionState";

const PROVIDER_NAMES = { anthropic: "Anthropic", openai: "OpenAI" } as const;
const FALLBACK_NOTICES = {
  invalid: (name: string) => ({
    title: `${name} API key rejected`,
    message: `${name} rejected your saved API key, so Gitdog paused work that uses it. Replace or remove it in your profile.`,
  }),
  out_of_credit: (name: string) => ({
    title: `${name} API key out of credit`,
    message: `Your ${name} API key is out of credit, so Gitdog paused work that uses it. Add credit or replace the key in your profile.`,
  }),
  unreadable: (name: string) => ({
    title: `${name} API key needs to be entered again`,
    message: `Gitdog can no longer read your saved ${name} API key. Enter it again in your profile.`,
  }),
};

async function notifyProviderKeyFailure(
  ctx: MutationCtx,
  userId: Id<"users">,
  provider: "anthropic" | "openai",
  reason: "invalid" | "out_of_credit" | "unreadable",
) {
  await ctx.db.insert("notifications", {
    userId,
    type: "provider_key_failed",
    providerKey: { provider, reason },
    // English fallback; the app translates from providerKey.
    ...FALLBACK_NOTICES[reason](PROVIDER_NAMES[provider]),
    isRead: false,
    createdAt: Date.now(),
  });
}

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
      unreadableAt: undefined,
      updatedAt: now,
    };
    // Keys must all use the deployment's expected encryption key; the first
    // record is seeded from existing keys, not from the key being saved.
    const expected = await readExpectedEncryptionKeyId(ctx);
    if (expected !== null && expected !== args.encryptionKeyId)
      throw new Error("Provider key encryption key does not match saved keys");
    if (!(await ctx.db.query("providerKeyEncryptionState").first()))
      await ctx.db.insert("providerKeyEncryptionState", {
        expectedKeyId: args.encryptionKeyId,
        createdAt: now,
      });
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
    if (
      nextStatus !== row.status &&
      (nextStatus === "invalid" || nextStatus === "out_of_credit")
    )
      await notifyProviderKeyFailure(
        ctx,
        args.userId,
        args.provider,
        nextStatus,
      );
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
      unreadableAt: undefined,
      lastValidatedAt: now,
      updatedAt: now,
    });
  },
});

/** Tell the owner once that a saved key can no longer be decrypted. */
export const noteUnreadableKey = internalMutation({
  args: {
    userId: v.id("users"),
    provider: providerValidator,
    // The saved key that failed; a report about a key since replaced is
    // ignored.
    keyIv: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("providerApiKeys")
      .withIndex("by_user_and_provider", (q) =>
        q.eq("userId", args.userId).eq("provider", args.provider),
      )
      .unique();
    if (!row || row.unreadableAt !== undefined || row.iv !== args.keyIv) return;
    await notifyProviderKeyFailure(
      ctx,
      args.userId,
      args.provider,
      "unreadable",
    );
    await ctx.db.patch(row._id, { unreadableAt: Date.now() });
  },
});

/** A request on the key just worked: clear a stale failure, once. */
export const markKeyWorking = internalMutation({
  args: {
    userId: v.id("users"),
    provider: providerValidator,
    // The saved key the request used (its iv changes on every save) and
    // when the request started, so a late success cannot hide a newer
    // failure or a replaced key.
    keyIv: v.string(),
    requestStartedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("providerApiKeys")
      .withIndex("by_user_and_provider", (q) =>
        q.eq("userId", args.userId).eq("provider", args.provider),
      )
      .unique();
    if (
      !row ||
      (row.status === "active" &&
        row.lastError === undefined &&
        row.unreadableAt === undefined)
    )
      return;
    if (row.status === "invalid") return;
    if (row.iv !== args.keyIv) return;
    if (
      (row.lastError?.at ?? 0) >= args.requestStartedAt ||
      (row.unreadableAt ?? 0) >= args.requestStartedAt
    )
      return;
    const now = Date.now();
    await ctx.db.patch(row._id, {
      status: "active",
      lastError: undefined,
      unreadableAt: undefined,
      lastValidatedAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Operator-only rotation: make `keyId` (from the new BYOK_ENCRYPTION_KEY)
 * the expected encryption key. Keys saved under the old key become
 * unreadable and their owners must enter them again.
 */
export const setExpectedEncryptionKeyId = internalMutation({
  args: { keyId: v.string() },
  handler: async (ctx, args) => {
    if (!/^[a-f0-9]{16}$/.test(args.keyId))
      throw new Error("Expected a 16-character encryption key id");
    const current = await ctx.db.query("providerKeyEncryptionState").first();
    if (current) await ctx.db.patch(current._id, { expectedKeyId: args.keyId });
    else
      await ctx.db.insert("providerKeyEncryptionState", {
        expectedKeyId: args.keyId,
        createdAt: Date.now(),
      });
    return { expectedKeyId: args.keyId };
  },
});
