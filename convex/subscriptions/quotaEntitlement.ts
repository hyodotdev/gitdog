import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { PRICING } from "../_ai/config";
import {
  getEffectiveSubscriptionEntitlement,
  type EffectiveSubscriptionEntitlement,
} from "./entitlement";
import {
  hasUnsettledEndedTrustedProQuota,
  settleAllEndedTrustedProQuotas,
} from "./billingBoundaries";
import { readPurchasedTokenWalletBalance } from "./wallet";

type SubscriptionQuotaReadCtx = Pick<MutationCtx | QueryCtx, "db">;

export type EffectiveSubscriptionQuotaResult =
  | {
      verified: true;
      entitlement: EffectiveSubscriptionEntitlement;
      needsFreePeriodRefresh: boolean;
    }
  | {
      verified: false;
      reason: "invalid_subscription_balance" | "usage_history_too_large";
    };

export async function readEffectiveSubscriptionQuota(
  ctx: SubscriptionQuotaReadCtx,
  subscription: Doc<"subscriptions"> | null,
  now: number = Date.now(),
): Promise<EffectiveSubscriptionQuotaResult> {
  if (
    subscription &&
    (await hasUnsettledEndedTrustedProQuota(ctx, subscription.userId, now))
  ) {
    return { verified: false, reason: "invalid_subscription_balance" };
  }

  const entitlement = getEffectiveSubscriptionEntitlement(subscription, now);
  let purchasedTokens: number;
  try {
    purchasedTokens = subscription
      ? await readPurchasedTokenWalletBalance(ctx, subscription.userId)
      : 0;
  } catch {
    return { verified: false, reason: "invalid_subscription_balance" };
  }

  return {
    verified: true,
    entitlement: { ...entitlement, purchasedTokens },
    needsFreePeriodRefresh:
      subscription?.plan === "free" &&
      (subscription.periodStart !== entitlement.periodStart ||
        subscription.periodEnd !== entitlement.periodEnd ||
        subscription.status === "expired"),
  };
}

export async function refreshFreeSubscriptionPeriod(
  ctx: MutationCtx,
  subscription: Doc<"subscriptions"> | null,
  now: number,
): Promise<EffectiveSubscriptionEntitlement> {
  if (subscription) {
    await settleAllEndedTrustedProQuotas(ctx, subscription.userId, now);
  }
  const quota = await readEffectiveSubscriptionQuota(ctx, subscription, now);
  if (!quota.verified) {
    throw new Error(
      quota.reason === "usage_history_too_large"
        ? "Usage history is too large to settle the purchased-token wallet safely"
        : "Purchased-token wallet cannot be verified safely",
    );
  }
  if (!subscription || !quota.needsFreePeriodRefresh) {
    return quota.entitlement;
  }

  await ctx.db.patch(subscription._id, {
    plan: "free",
    status: "active",
    includedTokens: quota.entitlement.includedTokens,
    serviceFeeRate: PRICING.PLATFORM_FEE_FREE,
    purchasedTokens: quota.entitlement.purchasedTokens,
    periodStart: quota.entitlement.periodStart,
    periodEnd: quota.entitlement.periodEnd,
    updatedAt: now,
  });

  return quota.entitlement;
}
