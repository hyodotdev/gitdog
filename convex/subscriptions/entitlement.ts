import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { getFreeIncludedTokens, PRICING } from "../_ai/config";

export type ProEntitlementProvenance = {
  source: "lemon_squeezy_webhook" | "admin_override";
  verifiedAt: number;
};

export function isLemonProviderProvenance(
  source: ProEntitlementProvenance["source"] | undefined,
): boolean {
  return source === "lemon_squeezy_webhook";
}

export type ProEntitlementState = {
  plan: "free" | "pro";
  status: "active" | "canceled" | "expired";
  periodEnd?: number;
  proEntitlementProvenance?: ProEntitlementProvenance;
};

export type SubscriptionEntitlementState = Pick<
  Doc<"subscriptions">,
  | "plan"
  | "status"
  | "includedTokens"
  | "purchasedTokens"
  | "serviceFeeRate"
  | "periodStart"
  | "periodEnd"
  | "proEntitlementProvenance"
>;

export type EffectiveSubscriptionEntitlement = {
  plan: "free" | "pro";
  status: "active" | "canceled" | "expired";
  includedTokens: number;
  purchasedTokens: number;
  serviceFeeRate: number;
  periodStart: number;
  periodEnd: number;
  hasProAccess: boolean;
};

type SubscriptionReadCtx = Pick<QueryCtx | MutationCtx, "db">;

async function getValidTrustedSubscriptionForSource(
  ctx: SubscriptionReadCtx,
  userId: Id<"users">,
  source: ProEntitlementProvenance["source"],
  now: number,
): Promise<Doc<"subscriptions"> | null> {
  const [active, canceled] = await Promise.all(
    (["active", "canceled"] as const).map(
      async (status) =>
        await ctx.db
          .query("subscriptions")
          .withIndex("by_user_provenance_status_and_period_end", (q) =>
            q
              .eq("userId", userId)
              .eq("proEntitlementProvenance.source", source)
              .eq("status", status),
          )
          .order("desc")
          .first(),
    ),
  );
  return (
    [active, canceled]
      .filter((subscription): subscription is Doc<"subscriptions"> =>
        hasTrustedProEntitlement(subscription, now),
      )
      .sort(
        (left, right) =>
          (right.proEntitlementProvenance?.verifiedAt ?? 0) -
          (left.proEntitlementProvenance?.verifiedAt ?? 0),
      )[0] ?? null
  );
}

/** Prefer a currently valid trusted Pro row over free or expired rows. */
export async function getSubscriptionForEntitlement(
  ctx: SubscriptionReadCtx,
  userId: Id<"users">,
  now: number = Date.now(),
): Promise<Doc<"subscriptions"> | null> {
  const [latest, lemonSqueezy, adminOverride] = await Promise.all([
    ctx.db
      .query("subscriptions")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .first(),
    getValidTrustedSubscriptionForSource(
      ctx,
      userId,
      "lemon_squeezy_webhook",
      now,
    ),
    getValidTrustedSubscriptionForSource(ctx, userId, "admin_override", now),
  ]);
  const validTrusted = [lemonSqueezy, adminOverride]
    .filter((subscription): subscription is Doc<"subscriptions"> =>
      hasTrustedProEntitlement(subscription, now),
    )
    .sort(
      (left, right) =>
        (right.proEntitlementProvenance?.verifiedAt ?? 0) -
        (left.proEntitlementProvenance?.verifiedAt ?? 0),
    );
  return validTrusted[0] ?? latest;
}

function getUtcMonthBounds(now: number): {
  periodStart: number;
  periodEnd: number;
} {
  const date = new Date(now);
  return {
    periodStart: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
    periodEnd: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
  };
}

/** A Pro grant is trusted only after a verified billing-side write. */
export function hasTrustedProEntitlement(
  subscription: ProEntitlementState | null | undefined,
  now: number = Date.now(),
): boolean {
  if (
    !subscription ||
    subscription.plan !== "pro" ||
    subscription.periodEnd === undefined ||
    !Number.isFinite(subscription.periodEnd) ||
    now >= subscription.periodEnd
  ) {
    return false;
  }

  if (subscription.status !== "active" && subscription.status !== "canceled") {
    return false;
  }

  const provenance = subscription.proEntitlementProvenance;
  if (provenance === undefined) return false;

  return (
    (isLemonProviderProvenance(provenance.source) ||
      provenance.source === "admin_override") &&
    Number.isSafeInteger(provenance.verifiedAt) &&
    provenance.verifiedAt > 0 &&
    provenance.verifiedAt <= now
  );
}

export function hasEffectiveProEntitlement(
  subscription: ProEntitlementState | null | undefined,
  now: number = Date.now(),
): boolean {
  return hasTrustedProEntitlement(subscription, now);
}

export function getEffectiveSubscriptionEntitlement(
  subscription: SubscriptionEntitlementState | null | undefined,
  now: number = Date.now(),
): EffectiveSubscriptionEntitlement {
  const hasProAccess = hasEffectiveProEntitlement(subscription, now);
  if (hasProAccess && subscription) {
    return {
      plan: "pro",
      status: subscription.status,
      includedTokens: PRICING.PRO_INCLUDED_TOKENS,
      purchasedTokens: subscription.purchasedTokens,
      serviceFeeRate: PRICING.PLATFORM_FEE_PRO,
      periodStart: subscription.periodStart,
      periodEnd: subscription.periodEnd,
      hasProAccess: true,
    };
  }

  const freePeriodIsValid =
    subscription?.plan === "free" &&
    (subscription.status === "active" || subscription.status === "canceled") &&
    Number.isFinite(subscription.periodStart) &&
    Number.isFinite(subscription.periodEnd) &&
    subscription.periodStart <= now &&
    now < subscription.periodEnd;
  const fallbackPeriod = getUtcMonthBounds(now);
  const endedTrustedProPeriodStart =
    subscription?.plan === "pro" &&
    subscription.proEntitlementProvenance !== undefined &&
    Number.isFinite(subscription.proEntitlementProvenance.verifiedAt) &&
    subscription.proEntitlementProvenance.verifiedAt <= now &&
    Number.isFinite(subscription.periodEnd) &&
    subscription.periodEnd <= now &&
    subscription.periodEnd > fallbackPeriod.periodStart &&
    subscription.periodEnd < fallbackPeriod.periodEnd
      ? subscription.periodEnd
      : fallbackPeriod.periodStart;

  const periodStart = freePeriodIsValid
    ? subscription.periodStart
    : endedTrustedProPeriodStart;
  return {
    plan: "free",
    status: "active",
    includedTokens: getFreeIncludedTokens(periodStart),
    purchasedTokens: subscription ? subscription.purchasedTokens : 0,
    serviceFeeRate: PRICING.PLATFORM_FEE_FREE,
    periodStart,
    periodEnd: freePeriodIsValid
      ? subscription.periodEnd
      : fallbackPeriod.periodEnd,
    hasProAccess: false,
  };
}
