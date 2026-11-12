import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { getFreeIncludedTokens, PRICING } from "../_ai/config";
import {
  getSubscriptionForEntitlement,
  hasTrustedProEntitlement,
} from "./entitlement";
import {
  hasUnsettledProHistory,
  probeProHistory,
  settleAllEndedTrustedProQuotas,
  TerminalProQuotaUnavailableError,
} from "./billingBoundaries";
import {
  readEffectiveSubscriptionQuota,
  refreshFreeSubscriptionPeriod,
} from "./quotaEntitlement";
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
  args: {
    userId: Id<"users">;
    tokensToAdd: number;
    now: number;
    trial?: boolean;
  },
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
      ...(args.trial ? { trialTokens: args.tokensToAdd } : {}),
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
    trialTokensToAdd: args.trial ? args.tokensToAdd : 0,
    now: args.now,
  });
  return subscription._id;
}

export type TrialGrantStatus =
  "granted" | "already_granted" | "pro" | "pro_settling" | "wallet_unverified";

/**
 * Grant the one-time trial credit as prepaid tokens to a free account. The
 * grant row is the idempotency record, written in the same transaction as
 * the credit and never deleted, so the trial is never granted twice.
 *
 * Best effort and never throws for account state: Pro accounts, Pro history
 * still being settled and unverifiable wallets are skipped without writes so
 * the regular quota checks report them as usual. Former Pro owners get the
 * trial once they are on Free.
 */
export async function grantTrialCreditOnce(
  ctx: MutationCtx,
  userId: Id<"users">,
  now: number = Date.now(),
): Promise<{ status: TrialGrantStatus; tokens: number }> {
  const existing = await ctx.db
    .query("trialCreditGrants")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  if (existing) return { status: "already_granted", tokens: existing.tokens };
  const subscription = await getSubscriptionForEntitlement(ctx, userId, now);
  if (hasTrustedProEntitlement(subscription, now))
    return { status: "pro", tokens: 0 };
  if (await hasUnsettledProHistory(ctx, userId, now))
    return { status: "pro_settling", tokens: 0 };
  if (
    subscription &&
    !(await readEffectiveSubscriptionQuota(ctx, subscription, now)).verified
  )
    return { status: "wallet_unverified", tokens: 0 };
  await creditPurchasedTokens(ctx, {
    userId,
    tokensToAdd: PRICING.TRIAL_TOKENS,
    now,
    trial: true,
  });
  await ctx.db.insert("trialCreditGrants", {
    userId,
    tokens: PRICING.TRIAL_TOKENS,
    grantedAt: now,
  });
  return { status: "granted", tokens: PRICING.TRIAL_TOKENS };
}

/**
 * Settle ended Pro periods first, so a former Pro owner gets the trial on
 * the first request after the period closes, then grant it. A period that
 * cannot settle yet leaves the grant for a later request.
 */
export async function settleThenGrantTrialCredit(
  ctx: MutationCtx,
  userId: Id<"users">,
  now: number = Date.now(),
): Promise<{ status: TrialGrantStatus; tokens: number }> {
  const history = await probeProHistory(ctx, userId, now);
  // Corrupt history needs an operator; settling it here would only throw.
  if (history === "corrupt") return { status: "pro_settling", tokens: 0 };
  if (history === "unsettled") {
    try {
      await settleAllEndedTrustedProQuotas(ctx, userId, now);
    } catch (error) {
      if (!(error instanceof TerminalProQuotaUnavailableError)) throw error;
      return { status: "pro_settling", tokens: 0 };
    }
  }
  return await grantTrialCreditOnce(ctx, userId, now);
}
