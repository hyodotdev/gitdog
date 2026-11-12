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
    modelId: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    effort: "high",
    inputPer1M: 2,
    outputPer1M: 10,
  },
  openai: {
    modelId: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    effort: "xhigh",
    inputPer1M: 2,
    outputPer1M: 10,
  },
} as const;

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
  // Free tier: monthly allowance plus prepaid token packs
  FREE_INCLUDED_TOKENS: 100_000, // 100k tokens

  // Pro tier: monthly allowance plus prepaid token packs
  PRO_INCLUDED_TOKENS: 2_400_000, // 2.4M tokens

  // Token packs: purchasable tokens
  TOKEN_PACK_SMALL_SIZE: 2_200_000, // 2.2M tokens per small pack
  TOKEN_PACK_LARGE_SIZE: 7_500_000, // 7.5M tokens per large pack
} as const;

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

  // Embedding pricing
  OPENAI_EMBEDDING_PER_1M: 0.02,

  // Platform fees
  PLATFORM_FEE_FREE: PLATFORM_FEES.FREE,
  PLATFORM_FEE_PRO: PLATFORM_FEES.PRO,
  PLATFORM_FEE_TOKEN_PACK_SMALL: PLATFORM_FEES.TOKEN_PACK_SMALL,
  PLATFORM_FEE_TOKEN_PACK_LARGE: PLATFORM_FEES.TOKEN_PACK_LARGE,

  // Token limits
  FREE_INCLUDED_TOKENS: TOKEN_LIMITS.FREE_INCLUDED_TOKENS,
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
