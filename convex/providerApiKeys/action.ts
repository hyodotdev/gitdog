import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, type ActionCtx } from "../_generated/server";
import { GENERATION_MODELS } from "../_ai/config";
import type { ApiErrorCode } from "../apiKeys/security";
import {
  decryptProviderKey,
  detectKeyProvider,
  encryptProviderKey,
  ProviderKeyEncryptionError,
  type KeyProvider,
} from "./crypto";
import { validateProviderKey, type KeyValidationResult } from "./validation";

const providerValidator = v.union(v.literal("anthropic"), v.literal("openai"));

const PROVIDER_NAMES: Record<KeyProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

/** Stable reasons the settings UI switches on; messages are for the CLI. */
export type ProviderKeyErrorReason =
  | "unauthorized"
  | "not_found"
  | "malformed"
  | "wrong_provider"
  | "rate_limited"
  | "not_configured"
  | "unreadable"
  | "invalid_key"
  | "no_model_access"
  | "validation_unavailable";

function keyError(
  code: ApiErrorCode,
  reason: ProviderKeyErrorReason,
  message: string,
): never {
  throw new ConvexError({ code, reason, message });
}

function rejectValidation(
  provider: KeyProvider,
  result: Exclude<KeyValidationResult, { ok: true }>,
): never {
  const name = PROVIDER_NAMES[provider];
  switch (result.code) {
    case "invalid":
      return keyError(
        "BAD_REQUEST",
        "invalid_key",
        `${name} rejected this API key.`,
      );
    case "no_model_access":
      return keyError(
        "BAD_REQUEST",
        "no_model_access",
        `This ${name} API key has no access to ${GENERATION_MODELS[provider].name}.`,
      );
    default:
      return keyError(
        "BAD_REQUEST",
        "validation_unavailable",
        `${name} could not validate this API key right now. Try again shortly.`,
      );
  }
}

async function requireValidationSlot(ctx: ActionCtx, userId: Id<"users">) {
  const attempt = await ctx.runMutation(
    internal.providerApiKeys.internalMutation.noteValidationAttempt,
    { userId },
  );
  if (!attempt.allowed)
    keyError(
      "BAD_REQUEST",
      "rate_limited",
      "Too many API key checks. Try again in a few minutes.",
    );
}

export const save = action({
  args: { provider: providerValidator, apiKey: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ provider: KeyProvider; last4: string; status: "active" }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId)
      keyError("UNAUTHORIZED", "unauthorized", "Sign in to save an API key.");
    const apiKey = args.apiKey.trim();
    const detected = detectKeyProvider(apiKey);
    if (detected !== args.provider)
      keyError(
        "BAD_REQUEST",
        detected ? "wrong_provider" : "malformed",
        detected
          ? `This looks like an ${PROVIDER_NAMES[detected]} API key.`
          : `This does not look like an ${PROVIDER_NAMES[args.provider]} API key.`,
      );
    const encryption = await ctx.runQuery(
      internal.providerApiKeys.internalQuery.getEncryptionState,
      {},
    );
    // Saving under a different server key would strand every other key.
    if (!encryption.ok)
      keyError(
        "UNSUPPORTED_OPERATION",
        "not_configured",
        "Saving API keys is not available right now.",
      );
    let encrypted: Awaited<ReturnType<typeof encryptProviderKey>>;
    try {
      encrypted = await encryptProviderKey(userId, args.provider, apiKey);
    } catch (error) {
      if (!(error instanceof ProviderKeyEncryptionError)) throw error;
      keyError(
        "UNSUPPORTED_OPERATION",
        "not_configured",
        "Saving API keys is not available right now.",
      );
    }
    await requireValidationSlot(ctx, userId);
    const result = await validateProviderKey(args.provider, apiKey);
    if (!result.ok) rejectValidation(args.provider, result);
    const last4 = apiKey.slice(-4);
    await ctx.runMutation(internal.providerApiKeys.internalMutation.upsert, {
      userId,
      provider: args.provider,
      ...encrypted,
      last4,
    });
    return { provider: args.provider, last4, status: "active" };
  },
});

export const revalidate = action({
  args: { provider: providerValidator },
  handler: async (
    ctx,
    args,
  ): Promise<{ provider: KeyProvider; status: "active" }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId)
      keyError("UNAUTHORIZED", "unauthorized", "Sign in to check an API key.");
    const row = await ctx.runQuery(
      internal.providerApiKeys.internalQuery.getEncryptedKey,
      { userId, provider: args.provider },
    );
    if (!row)
      keyError(
        "NOT_FOUND",
        "not_found",
        "No API key is saved for this provider.",
      );
    const encryption = await ctx.runQuery(
      internal.providerApiKeys.internalQuery.getEncryptionState,
      {},
    );
    if (!encryption.ok)
      keyError(
        "UNSUPPORTED_OPERATION",
        "not_configured",
        "Key checks are temporarily unavailable.",
      );
    let apiKey: string;
    try {
      apiKey = await decryptProviderKey(row);
    } catch (error) {
      if (!(error instanceof ProviderKeyEncryptionError)) throw error;
      if (error.kind === "not_configured")
        keyError(
          "UNSUPPORTED_OPERATION",
          "not_configured",
          "Key checks are temporarily unavailable.",
        );
      // The key itself cannot be decrypted; its provider status is left as
      // it is, and the key is flagged so the owner sees it.
      await ctx.runMutation(
        internal.providerApiKeys.internalMutation.noteUnreadableKey,
        { userId, provider: args.provider, keyIv: row.iv },
      );
      keyError(
        "BAD_REQUEST",
        "unreadable",
        "This API key can no longer be read. Enter it again.",
      );
    }
    await requireValidationSlot(ctx, userId);
    const result = await validateProviderKey(args.provider, apiKey);
    if (!result.ok) {
      if (result.code !== "unavailable")
        await ctx.runMutation(
          internal.providerApiKeys.internalMutation.recordKeyFailure,
          {
            userId,
            provider: args.provider,
            code: "invalid",
            httpStatus: result.httpStatus,
          },
        );
      rejectValidation(args.provider, result);
    }
    await ctx.runMutation(
      internal.providerApiKeys.internalMutation.markValidated,
      { userId, provider: args.provider },
    );
    return { provider: args.provider, status: "active" };
  },
});
