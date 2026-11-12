import { internalQuery, type QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { v } from "convex/values";
import { isDevelopmentSiteUrl } from "../_utils/environment";
import {
  getSafeQuotaTokenLimit,
  hasValidPurchasedTokenDebitCoverage,
  readQuotaTokenUsage,
} from "../tokenUsage/quota";
import { getSubscriptionForEntitlement } from "./entitlement";
import { readEffectiveSubscriptionQuota } from "./quotaEntitlement";

/**
 * Internal query to check if a user can perform an AI action
 * Used by internal actions that don't have auth context
 *
 * NOTE: In dev environment, token limits are bypassed for testing
 */
export const canPerformActionInternal = internalQuery({
  args: {
    userId: v.id("users"),
  },
  handler: (ctx, args) => checkAccountTokenAllowance(ctx, args.userId),
});

// Shared with mutations that must check and reserve quota in one transaction.
export async function checkAccountTokenAllowance(
  ctx: QueryCtx,
  userId: Id<"users">,
) {
  // In dev environment, always allow (bypass token limits for testing)
  if (isDevelopmentSiteUrl()) {
    console.log(
      "[canPerformActionInternal] Dev environment - bypassing token limit check",
    );
    return { allowed: true as const, isDev: true };
  }

  // Get subscription
  const now = Date.now();
  const subscription = await getSubscriptionForEntitlement(ctx, userId, now);

  const quota = await readEffectiveSubscriptionQuota(ctx, subscription, now);
  if (!quota.verified) {
    return {
      allowed: false as const,
      reason: quota.reason,
      message:
        quota.reason === "usage_history_too_large"
          ? "Usage history is too large to verify the account limit safely. Please contact support."
          : "The subscription balance cannot be verified safely. Please contact support.",
    };
  }
  const entitlement = quota.entitlement;
  const { plan, includedTokens, purchasedTokens, periodStart, periodEnd } =
    entitlement;

  if (
    !Number.isSafeInteger(includedTokens) ||
    includedTokens < 0 ||
    !Number.isSafeInteger(purchasedTokens) ||
    purchasedTokens < 0
  ) {
    return {
      allowed: false as const,
      reason: "invalid_subscription_balance" as const,
      message:
        "The subscription balance cannot be verified safely. Please contact support.",
    };
  }

  // Get token usage within the current billing period
  // Embedding usage is stored in stable cost-reference quota tokens, so it
  // can be summed with the rest of the account quota without a second
  // provider-specific conversion here.
  const usage = await readQuotaTokenUsage(ctx, {
    userId: userId,
    periodStart,
    periodEndExclusive: periodEnd,
  });
  if (!usage.verified) {
    return {
      allowed: false as const,
      reason: "usage_history_too_large" as const,
      message:
        "Usage history is too large to verify the account limit safely. Please contact support.",
    };
  }

  const tokensUsed = usage.tokensUsed;
  if (
    !hasValidPurchasedTokenDebitCoverage(
      tokensUsed,
      includedTokens,
      usage.purchasedTokensDebited,
    )
  ) {
    return {
      allowed: false as const,
      reason: "invalid_subscription_balance" as const,
      message:
        "The subscription balance cannot be verified safely. Please contact support.",
    };
  }
  const totalTokenLimit = getSafeQuotaTokenLimit(
    includedTokens,
    purchasedTokens,
    usage.purchasedTokensDebited,
  );
  if (totalTokenLimit === null) {
    return {
      allowed: false as const,
      reason: "invalid_subscription_balance" as const,
      message:
        "The subscription balance cannot be verified safely. Please contact support.",
    };
  }

  // Both plans stop at their included allowance plus prepaid token packs.
  if (tokensUsed >= totalTokenLimit) {
    const allowanceDescription = `${includedTokens.toLocaleString()} included + ${(purchasedTokens + usage.purchasedTokensDebited).toLocaleString()} purchased`;
    const nextStep =
      plan === "pro"
        ? "Purchase a non-expiring token pack to continue."
        : "Purchase a non-expiring token pack, or upgrade to Pro for 2.4M included tokens per billing period.";

    return {
      allowed: false,
      reason: "limit_reached" as const,
      message: `🚫 Token limit reached!\n\nYou've used ${tokensUsed.toLocaleString()} of ${totalTokenLimit.toLocaleString()} tokens (${allowanceDescription}).\n\n👉 ${nextStep}\n\nVisit gitdog.dev/pricing`,
      tokensUsed,
      tokenLimit: totalTokenLimit,
    };
  }

  return {
    allowed: true as const,
    tokensUsed,
    tokenLimit: totalTokenLimit,
  };
}
