import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { getFreeIncludedTokens, PRICING } from "../_ai/config";
import {
  getSubscriptionForEntitlement,
  hasTrustedProEntitlement,
} from "./entitlement";
import { refreshFreeSubscriptionPeriod } from "./quotaEntitlement";
import { consolidatePurchasedTokenWallet } from "./wallet";

function getCurrentUtcMonthBounds(now: number): {
  periodStart: number;
  periodEnd: number;
} {
  const date = new Date(now);
  return {
    periodStart: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
    periodEnd: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
  };
}

export async function creditPurchasedTokens(
  ctx: MutationCtx,
  args: { userId: Id<"users">; tokensToAdd: number; now: number },
): Promise<Id<"subscriptions">> {
  if (!Number.isSafeInteger(args.tokensToAdd) || args.tokensToAdd <= 0) {
    throw new Error("Invalid purchased token amount");
  }
  const subscription = await getSubscriptionForEntitlement(ctx, args.userId);
  if (!subscription) {
    const period = getCurrentUtcMonthBounds(args.now);
    return await ctx.db.insert("subscriptions", {
      userId: args.userId,
      plan: "free",
      status: "active",
      serviceFeeRate: PRICING.PLATFORM_FEE_FREE,
      includedTokens: getFreeIncludedTokens(period.periodStart),
      purchasedTokens: args.tokensToAdd,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      createdAt: args.now,
      updatedAt: args.now,
    });
  }

  await refreshFreeSubscriptionPeriod(ctx, subscription, args.now);

  await consolidatePurchasedTokenWallet(ctx, {
    userId: args.userId,
    targetSubscriptionId: subscription._id,
    tokensToAdd: args.tokensToAdd,
    now: args.now,
  });
  return subscription._id;
}

/**
 * Grant the one-time trial credit as prepaid tokens to a free account. The
 * grant row is the idempotency record, written in the same transaction as
 * the credit and never deleted, so the trial is never granted twice. Pro
 * accounts get it later if they are ever on Free.
 */
export async function grantTrialCreditOnce(
  ctx: MutationCtx,
  userId: Id<"users">,
  now: number = Date.now(),
): Promise<{ granted: boolean; tokens: number }> {
  const existing = await ctx.db
    .query("trialCreditGrants")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  if (existing) return { granted: false, tokens: existing.tokens };
  const subscription = await getSubscriptionForEntitlement(ctx, userId, now);
  if (hasTrustedProEntitlement(subscription, now))
    return { granted: false, tokens: 0 };
  await creditPurchasedTokens(ctx, {
    userId,
    tokensToAdd: PRICING.TRIAL_TOKENS,
    now,
  });
  await ctx.db.insert("trialCreditGrants", {
    userId,
    tokens: PRICING.TRIAL_TOKENS,
    grantedAt: now,
  });
  return { granted: true, tokens: PRICING.TRIAL_TOKENS };
}
