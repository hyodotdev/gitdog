import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { action } from "../_generated/server";
import { GENERATION_MODELS } from "../_ai/config";
import { apiError } from "../apiKeys/security";
import {
  decryptProviderKey,
  encryptProviderKey,
  PROVIDER_KEY_PATTERNS,
  ProviderKeyEncryptionError,
  type KeyProvider,
} from "./crypto";
import { validateProviderKey, type KeyValidationResult } from "./validation";

const providerValidator = v.union(v.literal("anthropic"), v.literal("openai"));

const PROVIDER_NAMES: Record<KeyProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

function validationMessage(
  provider: KeyProvider,
  result: Exclude<KeyValidationResult, { ok: true }>,
): string {
  switch (result.code) {
    case "invalid":
      return `${PROVIDER_NAMES[provider]} rejected this API key.`;
    case "no_model_access":
      return `This ${PROVIDER_NAMES[provider]} API key has no access to ${GENERATION_MODELS[provider].name}.`;
    default:
      return `${PROVIDER_NAMES[provider]} could not validate this API key right now. Try again shortly.`;
  }
}

export const save = action({
  args: { provider: providerValidator, apiKey: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ provider: KeyProvider; last4: string; status: "active" }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) apiError("UNAUTHORIZED", "Sign in to save an API key.");
    const apiKey = args.apiKey.trim();
    if (!PROVIDER_KEY_PATTERNS[args.provider].test(apiKey))
      apiError(
        "BAD_REQUEST",
        `This does not look like an ${PROVIDER_NAMES[args.provider]} API key.`,
      );
    const attempt = await ctx.runMutation(
      internal.providerApiKeys.internalMutation.noteValidationAttempt,
      { userId, provider: args.provider },
    );
    if (!attempt.allowed)
      apiError("BAD_REQUEST", "Wait a few seconds before trying again.");
    const result = await validateProviderKey(args.provider, apiKey);
    if (!result.ok)
      apiError("BAD_REQUEST", validationMessage(args.provider, result));
    let encrypted: Awaited<ReturnType<typeof encryptProviderKey>>;
    try {
      encrypted = await encryptProviderKey(userId, args.provider, apiKey);
    } catch (error) {
      if (error instanceof ProviderKeyEncryptionError)
        apiError(
          "UNSUPPORTED_OPERATION",
          "Saving API keys is not available right now.",
        );
      throw error;
    }
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
    if (!userId) apiError("UNAUTHORIZED", "Sign in to check an API key.");
    const row = await ctx.runQuery(
      internal.providerApiKeys.internalQuery.getEncryptedKey,
      { userId, provider: args.provider },
    );
    if (!row) apiError("NOT_FOUND", "No API key is saved for this provider.");
    const attempt = await ctx.runMutation(
      internal.providerApiKeys.internalMutation.noteValidationAttempt,
      { userId, provider: args.provider },
    );
    if (!attempt.allowed)
      apiError("BAD_REQUEST", "Wait a few seconds before trying again.");
    let apiKey: string;
    try {
      apiKey = await decryptProviderKey(row);
    } catch (error) {
      if (!(error instanceof ProviderKeyEncryptionError)) throw error;
      await ctx.runMutation(
        internal.providerApiKeys.internalMutation.recordKeyFailure,
        { userId, provider: args.provider, code: "invalid" },
      );
      apiError("BAD_REQUEST", "Enter this API key again.");
    }
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
      apiError("BAD_REQUEST", validationMessage(args.provider, result));
    }
    await ctx.runMutation(
      internal.providerApiKeys.internalMutation.markValidated,
      { userId, provider: args.provider },
    );
    return { provider: args.provider, status: "active" };
  },
});
