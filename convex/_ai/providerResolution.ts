import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import {
  decryptProviderKey,
  ProviderKeyEncryptionError,
  type KeyProvider,
} from "../providerApiKeys/crypto";
import {
  getDefaultAiModel,
  type AiProvider,
  type ChatCompletionOptions,
  type ChatCompletionResult,
  type ChatMessage,
} from "./model";
import { isUsableProviderKey } from "../providerApiKeys/usability";
import { ChatProviderRequestError } from "./providerErrors";
import {
  ClaudeProvider,
  CreditFallbackProvider,
  OpenAIProvider,
} from "./providers";

const PROVIDER_NAMES: Record<KeyProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

export type UserApiKeyErrorCode =
  | "invalid"
  | "out_of_credit"
  | "rate_limited"
  | "removed"
  | "unavailable"
  | "unreadable";

function userKeyMessage(code: UserApiKeyErrorCode, provider: KeyProvider) {
  const name = PROVIDER_NAMES[provider];
  switch (code) {
    case "invalid":
      return `Your ${name} API key was rejected. Replace or remove it in Gitdog settings.`;
    case "out_of_credit":
      return `Your ${name} API key is out of credit. Add credit with ${name} or replace the key in Gitdog settings.`;
    case "rate_limited":
      return `Your ${name} API key hit its rate limit. Try again shortly.`;
    case "removed":
      return "This request started on your own API key, which has been removed. Add a key again in Gitdog settings.";
    case "unavailable":
      return `Your ${name} API key is no longer available. Add it again in Gitdog settings.`;
    case "unreadable":
      return `Your ${name} API key can no longer be read. Enter it again in Gitdog settings.`;
  }
}

/** A failure of the user's own key. Gitdog never retries it on its own key. */
export class UserApiKeyError extends ChatProviderRequestError {
  constructor(
    readonly code: UserApiKeyErrorCode,
    readonly keyProvider: KeyProvider,
    base?: ChatProviderRequestError,
  ) {
    super(
      userKeyMessage(code, keyProvider),
      base?.billingOutcome ?? "not_billed",
      // A rejected or missing key may still fall back to the user's other key.
      code === "invalid" || code === "unavailable"
        ? { ...base?.options, unavailable: true }
        : (base?.options ?? {}),
    );
    this.name = "UserApiKeyError";
  }
}

class UserKeyProvider implements AiProvider {
  readonly keySource = "user" as const;
  constructor(
    private readonly ctx: ActionCtx,
    private readonly userId: Id<"users">,
    private readonly keyProvider: KeyProvider,
    private readonly inner: AiProvider,
  ) {}
  get name() {
    return this.inner.name;
  }
  get modelId() {
    return this.inner.modelId;
  }
  get providerId() {
    return this.inner.providerId;
  }

  private async recordFailure(
    code: "invalid" | "out_of_credit" | "rate_limited",
    httpStatus?: number,
  ) {
    try {
      await this.ctx.runMutation(
        internal.providerApiKeys.internalMutation.recordKeyFailure,
        { userId: this.userId, provider: this.keyProvider, code, httpStatus },
      );
    } catch {
      /* Best effort: the request already failed with an actionable error. */
    }
  }

  async chat(
    messages: ChatMessage[],
    options?: ChatCompletionOptions,
  ): Promise<ChatCompletionResult> {
    try {
      return await this.inner.chat(messages, options);
    } catch (error) {
      if (!(error instanceof ChatProviderRequestError)) throw error;
      const status = error.httpStatus;
      switch (true) {
        case status === 401 || status === 403:
          await this.recordFailure("invalid", status);
          throw new UserApiKeyError("invalid", this.keyProvider, error);
        case error.options.creditExhausted === true:
          await this.recordFailure("out_of_credit", status);
          throw new UserApiKeyError("out_of_credit", this.keyProvider, error);
        case status === 429:
          await this.recordFailure("rate_limited", status);
          throw new UserApiKeyError("rate_limited", this.keyProvider, error);
        default:
          throw error;
      }
    }
  }
}

async function userKeyLeaf(
  ctx: ActionCtx,
  row: Doc<"providerApiKeys">,
): Promise<AiProvider | "unreadable"> {
  let apiKey: string;
  try {
    apiKey = await decryptProviderKey(row);
  } catch (error) {
    // A server-side encryption problem says nothing about the provider key,
    // so the saved status is left unchanged.
    if (error instanceof ProviderKeyEncryptionError) return "unreadable";
    throw error;
  }
  return new UserKeyProvider(
    ctx,
    row.userId,
    row.provider,
    row.provider === "anthropic"
      ? new ClaudeProvider(apiKey, undefined, { enforceAccessDeadline: false })
      : new OpenAIProvider(apiKey),
  );
}

/**
 * Pick the provider for generation billed to `userId` (the repository
 * owner). Saved keys always win; when keys are saved but none is usable the
 * request fails instead of falling back to Gitdog's keys.
 */
export async function resolveGenerationProvider(
  ctx: ActionCtx,
  args: { userId: Id<"users">; ticketActionId?: Id<"ticketActions"> },
): Promise<AiProvider> {
  const [rows, action] = await Promise.all([
    ctx.runQuery(internal.providerApiKeys.internalQuery.getEncryptedKeys, {
      userId: args.userId,
    }),
    args.ticketActionId
      ? ctx.runQuery(internal.ticketActions.internalQuery.getById, {
          actionId: args.ticketActionId,
        })
      : null,
  ]);
  if (rows.length === 0) {
    if (action?.aiKeySource === "user")
      throw new UserApiKeyError("removed", "anthropic");
    return getDefaultAiModel();
  }
  const now = Date.now();
  const leaves = new Map<KeyProvider, AiProvider>();
  let unreadable: KeyProvider | undefined;
  for (const row of rows) {
    if (!isUsableProviderKey(row, now)) continue;
    const leaf = await userKeyLeaf(ctx, row);
    if (leaf === "unreadable") unreadable = row.provider;
    else leaves.set(row.provider, leaf);
  }
  const anthropic = leaves.get("anthropic");
  const openai = leaves.get("openai");
  if (anthropic && openai)
    return new CreditFallbackProvider(anthropic, openai, {
      enforceClaudeDeadline: false,
    });
  const only = anthropic ?? openai;
  if (only) return only;
  if (unreadable) throw new UserApiKeyError("unreadable", unreadable);
  const outOfCredit = rows.find((row) => row.status === "out_of_credit");
  if (outOfCredit)
    throw new UserApiKeyError("out_of_credit", outOfCredit.provider);
  throw new UserApiKeyError("invalid", rows[0].provider);
}

export function usesUserKey(provider: AiProvider): boolean {
  return provider.keySource === "user";
}
