import { query } from "../_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { PRICING, CLAUDE_API_ENDS_AT, GENERATION_MODELS } from "../_ai/config";
import {
  getSafeQuotaTokenLimit,
  hasValidPurchasedTokenDebitCoverage,
  readBillingPeriodUsage,
  readQuotaTokenUsage,
} from "../tokenUsage/quota";
import {
  getEffectiveSubscriptionEntitlement,
  getSubscriptionForEntitlement,
} from "./entitlement";
import { readEffectiveSubscriptionQuota } from "./quotaEntitlement";

const INVALID_USAGE_MESSAGE =
  "Usage data is too large or contains unsupported values. Please contact support.";

export function calculateSafeBillingCosts(
  totalUsageCostCents: number,
  overageTokens: number,
  tokensUsed: number,
  subscriptionCostCents: number,
): { overageCostCents: number; totalCostCents: number } {
  if (
    !Number.isFinite(totalUsageCostCents) ||
    totalUsageCostCents < 0 ||
    totalUsageCostCents > Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(overageTokens) ||
    overageTokens < 0 ||
    !Number.isSafeInteger(tokensUsed) ||
    tokensUsed <= 0 ||
    overageTokens > tokensUsed ||
    !Number.isSafeInteger(subscriptionCostCents) ||
    subscriptionCostCents < 0
  ) {
    throw new Error(INVALID_USAGE_MESSAGE);
  }
  const overageCostCents = Math.round(
    totalUsageCostCents * (overageTokens / tokensUsed),
  );
  if (!Number.isSafeInteger(overageCostCents) || overageCostCents < 0) {
    throw new Error(INVALID_USAGE_MESSAGE);
  }
  const totalCostCents = subscriptionCostCents + overageCostCents;
  if (!Number.isSafeInteger(totalCostCents)) {
    throw new Error(INVALID_USAGE_MESSAGE);
  }
  return { overageCostCents, totalCostCents };
}

export const getCurrent = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return null;
    }

    const now = Date.now();
    const subscription = await getSubscriptionForEntitlement(ctx, userId, now);

    // If no subscription exists, return default free tier
    if (!subscription) {
      const entitlement = getEffectiveSubscriptionEntitlement(null, now);
      return {
        plan: entitlement.plan,
        status: entitlement.status,
        includedTokens: entitlement.includedTokens,
        purchasedTokens: entitlement.purchasedTokens,
        purchasedTokensDebited: 0,
        serviceFeeRate: entitlement.serviceFeeRate,
        periodStart: entitlement.periodStart,
        periodEnd: entitlement.periodEnd,
      };
    }

    const quota = await readEffectiveSubscriptionQuota(ctx, subscription, now);
    if (!quota.verified) throw new Error(INVALID_USAGE_MESSAGE);
    const entitlement = quota.entitlement;
    let purchasedTokensDebited = 0;
    if (entitlement.plan === "free") {
      const usage = await readQuotaTokenUsage(ctx, {
        userId,
        periodStart: entitlement.periodStart,
        periodEndExclusive: entitlement.periodEnd,
      });
      if (!usage.verified) throw new Error(INVALID_USAGE_MESSAGE);
      if (
        !hasValidPurchasedTokenDebitCoverage(
          usage.tokensUsed,
          entitlement.includedTokens,
          usage.purchasedTokensDebited,
        )
      ) {
        throw new Error(INVALID_USAGE_MESSAGE);
      }
      purchasedTokensDebited = usage.purchasedTokensDebited;
    }
    return {
      ...subscription,
      plan: entitlement.plan,
      status: entitlement.status,
      includedTokens: entitlement.includedTokens,
      purchasedTokens: entitlement.purchasedTokens,
      purchasedTokensDebited,
      serviceFeeRate: entitlement.serviceFeeRate,
      periodStart: entitlement.periodStart,
      periodEnd: entitlement.periodEnd,
    };
  },
});

export const canPerformAction = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return { allowed: false, reason: "not_authenticated" };
    }

    // Get subscription
    const now = Date.now();
    const subscription = await getSubscriptionForEntitlement(ctx, userId, now);

    const quota = await readEffectiveSubscriptionQuota(ctx, subscription, now);
    if (!quota.verified) {
      return {
        allowed: false,
        reason:
          quota.reason === "usage_history_too_large"
            ? "usage_history_too_large"
            : "invalid_usage_data",
      };
    }
    const entitlement = quota.entitlement;
    const { includedTokens, purchasedTokens, periodStart, periodEnd } =
      entitlement;

    const usage = await readQuotaTokenUsage(ctx, {
      userId,
      periodStart,
      periodEndExclusive: periodEnd,
    });
    if (!usage.verified) {
      return { allowed: false, reason: "usage_history_too_large" };
    }
    const tokensUsed = usage.tokensUsed;
    if (
      !hasValidPurchasedTokenDebitCoverage(
        tokensUsed,
        includedTokens,
        usage.purchasedTokensDebited,
      )
    ) {
      return { allowed: false, reason: "invalid_usage_data" };
    }
    const totalAvailable = getSafeQuotaTokenLimit(
      includedTokens,
      purchasedTokens,
      usage.purchasedTokensDebited,
    );
    if (totalAvailable === null) {
      return { allowed: false, reason: "invalid_usage_data" };
    }

    // Both plans authorize only within included and prepaid token balances.
    if (tokensUsed >= totalAvailable) {
      return {
        allowed: false,
        reason: "token_limit_reached",
        tokensUsed,
        includedTokens,
        purchasedTokens,
        purchasedTokensDebited: usage.purchasedTokensDebited,
      };
    }

    return {
      allowed: true,
      tokensUsed,
      tokenLimit: totalAvailable,
    };
  },
});

/**
 * Calculate authoritative usage allocation for billing-period reporting and
 * historical settlement. Runtime quota checks prevent new postpaid overage.
 */
export const calculateOverage = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return null;
    }

    // Get subscription
    const now = Date.now();
    const subscription = await getSubscriptionForEntitlement(ctx, userId, now);

    const quota = await readEffectiveSubscriptionQuota(ctx, subscription, now);
    if (!quota.verified) throw new Error(INVALID_USAGE_MESSAGE);
    const entitlement = quota.entitlement;
    const {
      plan,
      includedTokens,
      purchasedTokens,
      serviceFeeRate,
      periodStart,
      periodEnd,
    } = entitlement;

    const usage = await readBillingPeriodUsage(ctx, {
      userId,
      periodStart,
      periodEndExclusive: periodEnd,
    });
    if (!usage.verified) throw new Error(INVALID_USAGE_MESSAGE);
    const {
      tokensUsed,
      totalCostCents: totalCostCentsFromUsage,
      totalServiceFeeCents,
      purchasedTokensDebited,
    } = usage;
    if (
      plan === "free" &&
      !hasValidPurchasedTokenDebitCoverage(
        tokensUsed,
        includedTokens,
        purchasedTokensDebited,
      )
    ) {
      throw new Error(INVALID_USAGE_MESSAGE);
    }
    const debitedPurchasedCoverage =
      plan === "free" ? purchasedTokensDebited : 0;
    const totalCoveredTokens = getSafeQuotaTokenLimit(
      includedTokens,
      purchasedTokens,
      debitedPurchasedCoverage,
    );
    if (totalCoveredTokens === null) throw new Error(INVALID_USAGE_MESSAGE);
    const subscriptionCostCents =
      plan === "pro" ? Math.round(PRICING.PRO_MONTHLY_PRICE * 100) : 0;

    if (tokensUsed === 0) {
      return {
        plan,
        includedTokens,
        purchasedTokens,
        purchasedTokensDebited: debitedPurchasedCoverage,
        tokensUsed: 0,
        usedFromPurchased: 0,
        overageTokens: 0,
        overageCostCents: 0,
        subscriptionCostCents,
        totalCostCents: subscriptionCostCents,
        serviceFeeRate,
        totalServiceFeeCents,
      };
    }

    // Historical overage is usage beyond all included and prepaid coverage.
    // Order of consumption: included → purchased → uncovered historical usage.
    const overageTokens = Math.max(0, tokensUsed - totalCoveredTokens);

    // Calculate how much of purchased tokens were used
    const usedFromPurchased =
      plan === "free"
        ? purchasedTokensDebited
        : Math.max(0, Math.min(purchasedTokens, tokensUsed - includedTokens));

    // Preserve cost attribution for settled usage. This is not exposed as a
    // new automatic postpaid charge.
    const { overageCostCents, totalCostCents } = calculateSafeBillingCosts(
      totalCostCentsFromUsage,
      overageTokens,
      tokensUsed,
      subscriptionCostCents,
    );

    return {
      plan,
      includedTokens,
      purchasedTokens,
      purchasedTokensDebited: debitedPurchasedCoverage,
      tokensUsed,
      usedFromPurchased,
      overageTokens,
      overageCostCents,
      subscriptionCostCents,
      totalCostCents,
      serviceFeeRate,
      totalServiceFeeCents,
    };
  },
});

/**
 * Get pricing information for display
 */
export const getPricingInfo = query({
  args: {},
  handler: async () => {
    const generation =
      GENERATION_MODELS[
        Date.now() < CLAUDE_API_ENDS_AT ? "anthropic" : "openai"
      ];
    return {
      plans: {
        free: {
          name: "Free",
          price: 0,
          includedTokens: PRICING.FREE_INCLUDED_TOKENS,
          serviceFeeRate: PRICING.PLATFORM_FEE_FREE,
          features: [
            `${(PRICING.FREE_INCLUDED_TOKENS / 1000).toFixed(0)}k tokens/month (hard limit)`,
            "All repositories",
            "Issue Assistant",
          ],
        },
        pro: {
          name: "Pro",
          price: PRICING.PRO_MONTHLY_PRICE,
          includedTokens: PRICING.PRO_INCLUDED_TOKENS,
          serviceFeeRate: PRICING.PLATFORM_FEE_PRO,
          features: [
            `${(PRICING.PRO_INCLUDED_TOKENS / 1_000_000).toFixed(1)}M tokens included`,
            "Add non-expiring token packs when needed",
            "Priority processing",
            "All repositories",
            "Usage dashboard",
            "Prepaid usage with no surprise charges",
          ],
        },
      },
      tokenPacks: {
        small: {
          name: "Token Pack",
          price: PRICING.TOKEN_PACK_SMALL_PRICE,
          tokens: PRICING.TOKEN_PACK_SMALL_SIZE,
          serviceFeeRate: PRICING.PLATFORM_FEE_TOKEN_PACK_SMALL,
          description: "2.2M tokens",
        },
        large: {
          name: "Token Pack",
          price: PRICING.TOKEN_PACK_LARGE_PRICE,
          tokens: PRICING.TOKEN_PACK_LARGE_SIZE,
          serviceFeeRate: PRICING.PLATFORM_FEE_TOKEN_PACK_LARGE,
          description: "7.5M tokens",
        },
      },
      tokenPricing: {
        inputPer1M: generation.inputPer1M,
        outputPer1M: generation.outputPer1M,
        model: generation.name,
      },
    };
  },
});
