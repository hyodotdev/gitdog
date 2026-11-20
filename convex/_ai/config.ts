/**
 * Centralized AI configuration
 * All AI model and pricing related constants in one place
 */

// ============================================
// AI MODEL CONFIGURATION
// ============================================

/** Retired Google models, kept only to price and validate historical usage rows. */
export const LEGACY_GOOGLE_MODELS = {
  provider: "google",
  chatModelId: "gemini-2.5-flash",
  chatInputPer1M: 0.3,
  chatOutputPer1M: 2.5,
  embeddingModelId: "gemini-embedding-2",
  embeddingPer1M: 0.2,
} as const;

// 2027-01-18 00:00 Asia/Seoul. This is an exclusive, immutable deadline.
export const CLAUDE_API_ENDS_AT = Date.parse("2027-01-17T15:00:00Z");

export const GENERATION_MODELS = {
  anthropic: {
    modelId: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    effort: "medium",
  },
  openai: {
    modelId: "gpt-6.2-sol",
    name: "GPT-6.2 Sol",
    effort: "high",
  },
} as const;

/**
 * Prices (USD per 1M tokens) and quota weights for every chat model Gitdog
 * has billed. Retired models stay so historical usage rows remain priceable.
 *
 * A quota weight is how many quota tokens one provider token costs on
 * Gitdog's key: 1 for the $2/$10 tier, 2 for a model that costs twice as
 * much. Usage on the owner's own key is billed by the provider and is never
 * weighted.
 */
export const CHAT_MODELS: Record<
  string,
  {
    provider: "anthropic" | "openai" | "google";
    inputPer1M: number;
    outputPer1M: number;
    quotaWeight: number;
    // A prompt cache read's share of the input price; 0.1 when unset.
    cacheReadMultiplier?: number;
    // Input above the threshold bills the whole request at the multipliers.
    longContext?: {
      inputTokens: number;
      inputMultiplier: number;
      outputMultiplier: number;
    };
  }
> = {
  "claude-opus-5-5": {
    provider: "anthropic",
    inputPer1M: 4,
    outputPer1M: 20,
    quotaWeight: 2,
    cacheReadMultiplier: 0.05,
  },
  // Refusal fallback targets for Opus 5.5, priced only for recorded cost.
  "claude-opus-5": {
    provider: "anthropic",
    inputPer1M: 5,
    outputPer1M: 25,
    quotaWeight: 2.5,
  },
  "claude-opus-4-8": {
    provider: "anthropic",
    inputPer1M: 5,
    outputPer1M: 25,
    quotaWeight: 2.5,
  },
  "claude-sonnet-5-5": {
    provider: "anthropic",
    inputPer1M: 2,
    outputPer1M: 10,
    quotaWeight: 1,
  },
  // Available on an owner's own key only; priced for recorded cost.
  "claude-haiku-5-5": {
    provider: "anthropic",
    inputPer1M: 0.1,
    outputPer1M: 0.5,
    quotaWeight: 0.05,
    longContext: {
      inputTokens: 100_000,
      inputMultiplier: 5,
      outputMultiplier: 5,
    },
  },
  "gpt-6.2-sol": {
    provider: "openai",
    inputPer1M: 2,
    outputPer1M: 10,
    quotaWeight: 1,
    cacheReadMultiplier: 0.05,
    longContext: {
      inputTokens: 272_000,
      inputMultiplier: 2,
      outputMultiplier: 1.5,
    },
  },
  "gpt-6.1-sol": {
    provider: "openai",
    inputPer1M: 2,
    outputPer1M: 10,
    quotaWeight: 1,
    longContext: {
      inputTokens: 272_000,
      inputMultiplier: 2,
      outputMultiplier: 1.5,
    },
  },
  [LEGACY_GOOGLE_MODELS.chatModelId]: {
    provider: LEGACY_GOOGLE_MODELS.provider,
    inputPer1M: LEGACY_GOOGLE_MODELS.chatInputPer1M,
    outputPer1M: LEGACY_GOOGLE_MODELS.chatOutputPer1M,
    quotaWeight: 1,
  },
};

// A five-minute prompt cache write costs this share of the input price.
export const CACHE_WRITE_MULTIPLIER = 1.25;
const DEFAULT_CACHE_READ_MULTIPLIER = 0.1;

/**
 * Prompt tokens as the plain input tokens they cost, so quota, cost and
 * reservations need no separate cache accounting: a cache write counts at
 * CACHE_WRITE_MULTIPLIER and a read at the model's read rate. Fractions round
 * up, so a request is never charged less than it cost.
 */
export function cacheAdjustedInputTokens(
  model: string,
  input: number,
  cacheWrite: number,
  cacheRead: number,
): number {
  const entry = Object.hasOwn(CHAT_MODELS, model)
    ? CHAT_MODELS[model]
    : undefined;
  return (
    input +
    Math.ceil(cacheWrite * CACHE_WRITE_MULTIPLIER) +
    Math.ceil(
      cacheRead * (entry?.cacheReadMultiplier ?? DEFAULT_CACHE_READ_MULTIPLIER),
    )
  );
}

export function getChatModel(model: string, provider: string) {
  const entry = Object.hasOwn(CHAT_MODELS, model)
    ? CHAT_MODELS[model]
    : undefined;
  if (!entry || entry.provider !== provider)
    throw new Error(
      `Unsupported chat pricing: ${provider}/${model}. Add explicit pricing before enabling it.`,
    );
  return entry;
}

export type ModelEffort = "low" | "medium" | "high";
export type UserKeyModel = {
  modelId: string;
  name: string;
  efforts: readonly ModelEffort[];
  defaultEffort: ModelEffort;
};

const EFFORTS: readonly ModelEffort[] = ["low", "medium", "high"];

/**
 * Models an owner can choose for their own provider key, the default first.
 * The provider bills that usage, so it never counts against Gitdog tokens.
 * Requests are not streamed and must finish within minutes (two for most
 * work, up to four or five in a pull request review), so settings that can
 * think for longer, such as Fable 5.1 or xhigh and max effort, are left out.
 */
export const USER_KEY_MODELS: Record<"anthropic" | "openai", UserKeyModel[]> = {
  anthropic: [
    {
      modelId: "claude-opus-5-5",
      name: "Claude Opus 5.5",
      efforts: EFFORTS,
      defaultEffort: "medium",
    },
    {
      modelId: "claude-sonnet-5-5",
      name: "Claude Sonnet 5.5",
      efforts: EFFORTS,
      defaultEffort: "high",
    },
    {
      modelId: "claude-haiku-5-5",
      name: "Claude Haiku 5.5",
      efforts: EFFORTS,
      defaultEffort: "medium",
    },
  ],
  // Keys saved before GPT-6.2 Sol were checked against 6.1 and store no
  // model, so 6.1 stays the default they resolve to.
  openai: [
    {
      modelId: "gpt-6.1-sol",
      name: "GPT-6.1 Sol",
      efforts: EFFORTS,
      defaultEffort: "high",
    },
    {
      modelId: "gpt-6.2-sol",
      name: "GPT-6.2 Sol",
      efforts: EFFORTS,
      defaultEffort: "high",
    },
  ],
};

/**
 * The model and effort an owner's key runs with. A choice that is no longer
 * offered falls back to the default, so a key never stops working.
 */
export function userKeyModel(
  provider: "anthropic" | "openai",
  modelId?: string,
  effort?: string,
): { modelId: string; name: string; effort: ModelEffort } {
  const models = USER_KEY_MODELS[provider];
  const model = models.find((m) => m.modelId === modelId) ?? models[0];
  return {
    modelId: model.modelId,
    name: model.name,
    effort: model.efforts.includes(effort as ModelEffort)
      ? (effort as ModelEffort)
      : model.defaultEffort,
  };
}

/**
 * Quota weight held by every chat reservation: the highest weight among the
 * models a Gitdog request may be routed to, so a reservation stays valid
 * whichever provider serves it.
 */
export const RESERVATION_QUOTA_WEIGHT = Math.max(
  ...Object.values(GENERATION_MODELS).map((model) => {
    const entry = CHAT_MODELS[model.modelId];
    if (!entry) throw new Error(`${model.modelId} has no chat pricing`);
    return entry.quotaWeight;
  }),
);

// ============================================
// TOKEN PRICING (per 1M tokens in USD)
// ============================================

export const TOKEN_PRICING = {
  // Stable cost unit used to translate non-chat provider spend into quota tokens.
  QUOTA_REFERENCE_COST_PER_1M: 1,
} as const;

// ============================================
// SUBSCRIPTION LIMITS
// ============================================

export const TOKEN_LIMITS = {
  // One-time trial credit granted on sign-in (stored as prepaid tokens).
  // Enough for a few issue and discussion replies and small pull request
  // reviews; Opus 5.5 counts twice. Large PRs are reviewed in batches that
  // each hold REVIEW_BATCH_TOKEN_ESTIMATE (200K at Opus's weight) up front,
  // so a trial alone cannot start one; the owner's own key has no such limit.
  TRIAL_TOKENS: 100_000,

  // Pro tier: monthly allowance plus prepaid token packs
  PRO_INCLUDED_TOKENS: 2_400_000, // 2.4M tokens

  // Token packs: purchasable tokens
  TOKEN_PACK_SMALL_SIZE: 2_200_000, // 2.2M tokens per small pack
  TOKEN_PACK_LARGE_SIZE: 7_500_000, // 7.5M tokens per large pack
} as const;

// Free plans had a monthly allowance until this UTC month boundary. Periods
// that start before it keep it, so usage already counted in the current
// month stays covered; later free periods include no tokens.
export const FREE_MONTHLY_ALLOWANCE_ENDS_AT = Date.parse(
  "2026-12-01T00:00:00Z",
);
export const LEGACY_FREE_MONTHLY_TOKENS = 100_000;

export function getFreeIncludedTokens(periodStart: number): number {
  return periodStart < FREE_MONTHLY_ALLOWANCE_ENDS_AT
    ? LEGACY_FREE_MONTHLY_TOKENS
    : 0;
}

// ============================================
// PLATFORM FEES
// ============================================
// Internal service-cost allocation rates. Customer charges are prepaid through
// subscriptions and token packs; these rates do not authorize postpaid usage.
//
// - FREE: 25% internal cost allocation
// - PRO: 18% internal cost allocation
// - TOKEN_PACK_SMALL: 25% ($9.99 for 2.2M tokens)
// - TOKEN_PACK_LARGE: 20% ($29.99 for 7.5M tokens, better value)

export const PLATFORM_FEES = {
  FREE: 0.25,
  PRO: 0.18,
  TOKEN_PACK_SMALL: 0.25, // 25% margin for small pack
  TOKEN_PACK_LARGE: 0.2, // 20% margin for large pack (better value)
} as const;

// ============================================
// SUBSCRIPTION PRICES
// ============================================
// After Lemon Squeezy fee (~5% + $0.50):
// - Pro: $9.99/mo → includes 2.4M tokens
// - Small Pack: $9.99 → 2.2M tokens (25% margin)
// - Large Pack: $29.99 → 7.5M tokens (20% margin, better value)

export const SUBSCRIPTION_PRICES = {
  PRO_MONTHLY: 9.99, // $9.99/month (includes 2.4M tokens)
  TOKEN_PACK_SMALL: 9.99, // $9.99 per 2.2M tokens
  TOKEN_PACK_LARGE: 29.99, // $29.99 per 7.5M tokens (better value)
} as const;

// ============================================
// COMBINED BILLING CONFIGURATION
// ============================================

export const PRICING = {
  QUOTA_REFERENCE_COST_PER_1M: TOKEN_PRICING.QUOTA_REFERENCE_COST_PER_1M,

  // Embeddings are retired; this prices historical usage rows only.
  OPENAI_EMBEDDING_PER_1M: 0.02,

  // Platform fees
  PLATFORM_FEE_FREE: PLATFORM_FEES.FREE,
  PLATFORM_FEE_PRO: PLATFORM_FEES.PRO,
  PLATFORM_FEE_TOKEN_PACK_SMALL: PLATFORM_FEES.TOKEN_PACK_SMALL,
  PLATFORM_FEE_TOKEN_PACK_LARGE: PLATFORM_FEES.TOKEN_PACK_LARGE,

  // Token limits
  TRIAL_TOKENS: TOKEN_LIMITS.TRIAL_TOKENS,
  PRO_INCLUDED_TOKENS: TOKEN_LIMITS.PRO_INCLUDED_TOKENS,
  TOKEN_PACK_SMALL_SIZE: TOKEN_LIMITS.TOKEN_PACK_SMALL_SIZE,
  TOKEN_PACK_LARGE_SIZE: TOKEN_LIMITS.TOKEN_PACK_LARGE_SIZE,

  // Subscription prices
  PRO_MONTHLY_PRICE: SUBSCRIPTION_PRICES.PRO_MONTHLY,
  TOKEN_PACK_SMALL_PRICE: SUBSCRIPTION_PRICES.TOKEN_PACK_SMALL,
  TOKEN_PACK_LARGE_PRICE: SUBSCRIPTION_PRICES.TOKEN_PACK_LARGE,
} as const;

export function getEmbeddingPricePer1M(
  provider: "google" | "openai",
  model: string,
): number {
  if (
    provider === LEGACY_GOOGLE_MODELS.provider &&
    model === LEGACY_GOOGLE_MODELS.embeddingModelId
  )
    return LEGACY_GOOGLE_MODELS.embeddingPer1M;
  if (provider === "openai" && model === "text-embedding-3-small")
    return PRICING.OPENAI_EMBEDDING_PER_1M;
  throw new Error("Unsupported embedding provider/model identity");
}
