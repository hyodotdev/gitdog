/**
 * Centralized pricing configuration for frontend
 * Keep in sync with convex/_ai/config.ts
 */

export const TOKEN_LIMITS = {
  // Free tier: one-time trial credit granted on sign-in, no monthly allowance
  TRIAL_TOKENS: 100_000, // 100k tokens

  // Pro tier: hard limit extended only by prepaid token packs
  PRO_INCLUDED_TOKENS: 2_400_000, // 2.4M tokens

  // Token packs: purchasable tokens
  TOKEN_PACK_SMALL_SIZE: 2_200_000, // 2.2M tokens per small pack
  TOKEN_PACK_LARGE_SIZE: 7_500_000, // 7.5M tokens per large pack
} as const;

export function calculateTokenAvailability(args: {
  includedTokens: number;
  remainingPurchasedTokens: number;
  purchasedTokensDebited: number;
}): { remainingPurchasedTokens: number; totalAvailableTokens: number } {
  return {
    remainingPurchasedTokens: args.remainingPurchasedTokens,
    totalAvailableTokens:
      args.includedTokens +
      args.remainingPurchasedTokens +
      args.purchasedTokensDebited,
  };
}

export function calculateEstimatedAdditionalUsageCharge(): number {
  return 0;
}

export function getUtcMonthlyPeriod(now: number): {
  periodStart: number;
  periodEnd: number;
} {
  const date = new Date(now);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  return {
    periodStart: Date.UTC(year, month, 1),
    periodEnd: Date.UTC(year, month + 1, 1),
  };
}
