import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, type ActionCtx } from "../_generated/server";
import { USER_KEY_MODELS, userKeyModel } from "../_ai/config";
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
  | "unknown_model"
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
  modelName: string,
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
        `This ${name} API key has no access to ${modelName}.`,
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
  ): Promise<{
    provider: KeyProvider;
    last4: string;
    status: "active";
    modelId: string;
  }> => {
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
    // A new key is checked against the model its owner chose, if any.
    const existing = await ctx.runQuery(
      internal.providerApiKeys.internalQuery.getEncryptedKey,
      { userId, provider: args.provider },
    );
    let model = userKeyModel(args.provider, existing?.modelId);
    let choice = { modelId: existing?.modelId, effort: existing?.effort };
    await requireValidationSlot(ctx, userId);
    let result = await validateProviderKey(
      args.provider,
      apiKey,
      model.modelId,
    );
    // A new key without access to the chosen model returns to the default
    // model, so replacing a revoked key never needs the key removed first.
    const defaultModel = userKeyModel(args.provider);
    if (
      !result.ok &&
      result.code === "no_model_access" &&
      model.modelId !== defaultModel.modelId
    ) {
      model = defaultModel;
      choice = { modelId: undefined, effort: undefined };
      result = await validateProviderKey(args.provider, apiKey, model.modelId);
    }
    if (!result.ok) rejectValidation(args.provider, result, model.name);
    const last4 = apiKey.slice(-4);
    await ctx.runMutation(internal.providerApiKeys.internalMutation.upsert, {
      userId,
      provider: args.provider,
      ...encrypted,
      last4,
      ...choice,
    });
    return {
      provider: args.provider,
      last4,
      status: "active",
      modelId: model.modelId,
    };
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
    const model = userKeyModel(args.provider, row.modelId);
    await requireValidationSlot(ctx, userId);
    const result = await validateProviderKey(
      args.provider,
      apiKey,
      model.modelId,
    );
    if (!result.ok) {
      if (result.code !== "unavailable")
        await ctx.runMutation(
          internal.providerApiKeys.internalMutation.recordKeyFailure,
          {
            userId,
            provider: args.provider,
            code: "invalid",
            httpStatus: result.httpStatus,
            keyIv: row.iv,
          },
        );
      rejectValidation(args.provider, result, model.name);
    }
    await ctx.runMutation(
      internal.providerApiKeys.internalMutation.markValidated,
      { userId, provider: args.provider, keyIv: row.iv },
    );
    return { provider: args.provider, status: "active" };
  },
});

/**
 * Choose the model and effort generation uses on the owner's own key. The
 * key must have access to that model; the provider bills the usage.
 */
export const setModel = action({
  args: {
    provider: providerValidator,
    modelId: v.string(),
    effort: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ provider: KeyProvider; modelId: string; effort: string }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId)
      keyError("UNAUTHORIZED", "unauthorized", "Sign in to choose a model.");
    const offered = USER_KEY_MODELS[args.provider].find(
      (m) => m.modelId === args.modelId,
    );
    if (
      !offered ||
      (args.effort !== undefined &&
        !(offered.efforts as readonly string[]).includes(args.effort))
    )
      keyError(
        "BAD_REQUEST",
        "unknown_model",
        `Choose one of: ${USER_KEY_MODELS[args.provider]
          .map((m) => `${m.modelId} (${m.efforts.join(", ")})`)
          .join("; ")}.`,
      );
    const row = await ctx.runQuery(
      internal.providerApiKeys.internalQuery.getEncryptedKey,
      { userId, provider: args.provider },
    );
    if (!row)
      keyError(
        "NOT_FOUND",
        "not_found",
        "Save an API key for this provider before choosing its model.",
      );
    const model = userKeyModel(args.provider, args.modelId, args.effort);
    if (userKeyModel(args.provider, row.modelId).modelId !== model.modelId) {
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
        keyError(
          "BAD_REQUEST",
          "unreadable",
          "This API key can no longer be read. Enter it again.",
        );
      }
      await requireValidationSlot(ctx, userId);
      const result = await validateProviderKey(
        args.provider,
        apiKey,
        model.modelId,
      );
      if (!result.ok) rejectValidation(args.provider, result, model.name);
    }
    await ctx.runMutation(internal.providerApiKeys.internalMutation.setModel, {
      userId,
      provider: args.provider,
      keyIv: row.iv,
      modelId: model.modelId,
      effort: model.effort,
    });
    return {
      provider: args.provider,
      modelId: model.modelId,
      effort: model.effort,
    };
  },
});
