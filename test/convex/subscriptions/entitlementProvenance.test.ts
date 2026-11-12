import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "../../../convex/_generated/api";
import { PRICING } from "../../../convex/_ai/config";
import { checkProSubscription } from "../../../convex/_utils/accessControl";
import {
  getEffectiveSubscriptionEntitlement,
  hasTrustedProEntitlement,
} from "../../../convex/subscriptions/entitlement";
import schema from "../../../convex/schema";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/subscriptions/query.ts": () =>
    import("../../../convex/subscriptions/query"),
  "../../../convex/subscriptions/internalQuery.ts": () =>
    import("../../../convex/subscriptions/internalQuery"),
};

afterEach(() => {
  vi.useRealTimers();
});

describe("trusted Pro entitlement provenance", () => {
  it("requires trusted provenance for Pro access", () => {
    const now = Date.UTC(2026, 6, 20, 12);
    const entitlement = getEffectiveSubscriptionEntitlement(
      {
        plan: "pro",
        status: "active",
        includedTokens: PRICING.PRO_INCLUDED_TOKENS,
        purchasedTokens: 7_500_000,
        serviceFeeRate: PRICING.PLATFORM_FEE_PRO,
        periodStart: now - 60_000,
        periodEnd: now + 60_000,
      },
      now,
    );

    expect(entitlement).toMatchObject({
      plan: "free",
      includedTokens: PRICING.FREE_INCLUDED_TOKENS,
      purchasedTokens: 7_500_000,
      serviceFeeRate: PRICING.PLATFORM_FEE_FREE,
      hasProAccess: false,
    });
  });

  it("requires an unexpired paid period and a nonfuture attestation", () => {
    const now = 10_000;
    const trusted = {
      plan: "pro" as const,
      status: "active" as const,
      periodEnd: now + 1,
      proEntitlementProvenance: {
        source: "lemon_squeezy_webhook" as const,
        verifiedAt: now,
      },
    };

    expect(hasTrustedProEntitlement(trusted, now)).toBe(true);
    expect(hasTrustedProEntitlement({ ...trusted, periodEnd: now }, now)).toBe(
      false,
    );
    expect(
      hasTrustedProEntitlement(
        {
          ...trusted,
          proEntitlementProvenance: {
            ...trusted.proEntitlementProvenance,
            verifiedAt: now + 1,
          },
        },
        now,
      ),
    ).toBe(false);
  });

  it("accepts an unexpired canceled period and an admin override", () => {
    const now = 10_000;
    expect(
      hasTrustedProEntitlement(
        {
          plan: "pro",
          status: "canceled",
          periodEnd: now + 1,
          proEntitlementProvenance: {
            source: "admin_override",
            verifiedAt: now,
          },
        },
        now,
      ),
    ).toBe(true);
  });

  it("rolls an expired free token-pack row into the current quota month", () => {
    const now = Date.UTC(2026, 6, 20, 12);
    const entitlement = getEffectiveSubscriptionEntitlement(
      {
        plan: "free",
        status: "active",
        includedTokens: PRICING.FREE_INCLUDED_TOKENS,
        purchasedTokens: 2_200_000,
        serviceFeeRate: PRICING.PLATFORM_FEE_FREE,
        periodStart: Date.UTC(2026, 4, 1),
        periodEnd: Date.UTC(2026, 5, 1),
      },
      now,
    );

    expect(entitlement.periodStart).toBe(Date.UTC(2026, 6, 1));
    expect(entitlement.periodEnd).toBe(Date.UTC(2026, 7, 1));
    expect(entitlement.purchasedTokens).toBe(2_200_000);
  });

  it("returns the current UTC quota month without a subscription", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T12:34:56.789Z"));
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    const authenticated = t.withIdentity({
      subject: `${userId}|test-session`,
    });

    await expect(
      authenticated.query(api.subscriptions.query.getCurrent, {}),
    ).resolves.toEqual({
      plan: "free",
      status: "active",
      includedTokens: PRICING.FREE_INCLUDED_TOKENS,
      purchasedTokens: 0,
      purchasedTokensDebited: 0,
      serviceFeeRate: PRICING.PLATFORM_FEE_FREE,
      periodStart: Date.UTC(2026, 6, 1),
      periodEnd: Date.UTC(2026, 7, 1),
    });
  });

  it("returns a complete zero-usage Pro billing estimate", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const userId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("subscriptions", {
        userId,
        lemonSqueezySubscriptionId: "1001",
        plan: "pro",
        status: "active",
        proEntitlementProvenance: {
          source: "lemon_squeezy_webhook",
          verifiedAt: now,
        },
        includedTokens: PRICING.PRO_INCLUDED_TOKENS,
        purchasedTokens: 0,
        serviceFeeRate: PRICING.PLATFORM_FEE_PRO,
        periodStart: now - 60_000,
        periodEnd: now + 60_000,
        createdAt: now,
        updatedAt: now,
      });
      return userId;
    });
    const authenticated = t.withIdentity({
      subject: `${userId}|test-session`,
    });

    await expect(
      authenticated.query(api.subscriptions.query.calculateOverage, {}),
    ).resolves.toMatchObject({
      plan: "pro",
      tokensUsed: 0,
      usedFromPurchased: 0,
      overageTokens: 0,
      overageCostCents: 0,
      subscriptionCostCents: Math.round(PRICING.PRO_MONTHLY_PRICE * 100),
      totalCostCents: Math.round(PRICING.PRO_MONTHLY_PRICE * 100),
      serviceFeeRate: PRICING.PLATFORM_FEE_PRO,
      totalServiceFeeCents: 0,
    });
  });

  it("prefers a trusted Pro row over a newer untrusted row", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const userId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("subscriptions", {
        userId,
        lemonSqueezySubscriptionId: "1002",
        plan: "pro",
        status: "active",
        proEntitlementProvenance: {
          source: "lemon_squeezy_webhook",
          verifiedAt: now,
        },
        includedTokens: PRICING.PRO_INCLUDED_TOKENS,
        purchasedTokens: 77,
        serviceFeeRate: PRICING.PLATFORM_FEE_PRO,
        periodStart: now - 1_000,
        periodEnd: now + 60_000,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("subscriptions", {
        userId,
        plan: "pro",
        status: "active",
        includedTokens: 99_000_000,
        purchasedTokens: 0,
        serviceFeeRate: 0,
        periodStart: now,
        periodEnd: now + 60_000,
        createdAt: now + 1,
        updatedAt: now + 1,
      });
      return userId;
    });
    const authenticated = t.withIdentity({
      subject: `${userId}|test-session`,
    });

    await expect(
      authenticated.query(api.subscriptions.query.getCurrent, {}),
    ).resolves.toMatchObject({
      lemonSqueezySubscriptionId: "1002",
      plan: "pro",
      purchasedTokens: 77,
      serviceFeeRate: PRICING.PLATFORM_FEE_PRO,
    });
    await expect(
      t.query(internal.subscriptions.internalQuery.canPerformActionInternal, {
        userId,
      }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      t.run(async (ctx) => checkProSubscription(ctx, userId)),
    ).resolves.toBe(true);
  });
});
