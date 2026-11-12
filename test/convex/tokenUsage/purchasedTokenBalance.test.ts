import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { PRICING } from "../../../convex/_ai/config";
import schema from "../../../convex/schema";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/subscriptions/query.ts": () =>
    import("../../../convex/subscriptions/query"),
  "../../../convex/subscriptions/internalQuery.ts": () =>
    import("../../../convex/subscriptions/internalQuery"),
  "../../../convex/tokenUsage/internalMutation.ts": () =>
    import("../../../convex/tokenUsage/internalMutation"),
};

const originalSiteUrl = process.env.SITE_URL;

beforeEach(() => {
  process.env.SITE_URL = "https://gitdog.dev";
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  if (originalSiteUrl === undefined) delete process.env.SITE_URL;
  else process.env.SITE_URL = originalSiteUrl;
});

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

async function insertFreeWallet(
  t: ReturnType<typeof convexTest>,
  args: { now: number; purchasedTokens: number },
): Promise<{ userId: Id<"users">; subscriptionId: Id<"subscriptions"> }> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const period = getUtcMonthBounds(args.now);
    const subscriptionId = await ctx.db.insert("subscriptions", {
      userId,
      plan: "free",
      status: "active",
      includedTokens: PRICING.FREE_INCLUDED_TOKENS,
      purchasedTokens: args.purchasedTokens,
      serviceFeeRate: PRICING.PLATFORM_FEE_FREE,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      createdAt: args.now,
      updatedAt: args.now,
    });
    return { userId, subscriptionId };
  });
}

async function recordChatUsage(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  inputTokens: number,
): Promise<Id<"tokenUsage">> {
  return await t.mutation(internal.tokenUsage.internalMutation.recordUsage, {
    userId,
    inputTokens,
    outputTokens: 0,
    model: "claude-sonnet-5-5",
    provider: "anthropic",
  });
}

describe("durable purchased-token balance", () => {
  it("carries only the remaining wallet across a UTC month rollover", async () => {
    const july = Date.UTC(2026, 6, 15, 12);
    const august = Date.UTC(2026, 7, 15, 12);
    vi.setSystemTime(july);
    const t = convexTest(schema, modules);
    const { userId, subscriptionId } = await insertFreeWallet(t, {
      now: july,
      purchasedTokens: 100,
    });
    const authenticated = t.withIdentity({ subject: `${userId}|session` });

    await recordChatUsage(t, userId, PRICING.FREE_INCLUDED_TOKENS + 60);
    await expect(
      authenticated.query(api.subscriptions.query.getCurrent, {}),
    ).resolves.toMatchObject({
      purchasedTokens: 40,
      purchasedTokensDebited: 60,
    });

    vi.setSystemTime(august);
    await expect(
      authenticated.query(api.subscriptions.query.getCurrent, {}),
    ).resolves.toMatchObject({
      purchasedTokens: 40,
      purchasedTokensDebited: 0,
      periodStart: Date.UTC(2026, 7, 1),
      periodEnd: Date.UTC(2026, 8, 1),
    });
    await recordChatUsage(t, userId, PRICING.FREE_INCLUDED_TOKENS + 40);

    const state = await t.run(async (ctx) => ({
      subscription: await ctx.db.get(subscriptionId),
      usage: await ctx.db
        .query("tokenUsage")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(3),
    }));
    expect(state.subscription).toMatchObject({
      purchasedTokens: 0,
      periodStart: Date.UTC(2026, 7, 1),
      periodEnd: Date.UTC(2026, 8, 1),
    });
    expect(
      state.usage.reduce((total, row) => total + row.purchasedTokensDebited, 0),
    ).toBe(100);
  });

  it("serializes concurrent current-period writes against one wallet", async () => {
    const now = Date.UTC(2026, 6, 15, 12);
    vi.setSystemTime(now);
    const t = convexTest(schema, modules);
    const { userId, subscriptionId } = await insertFreeWallet(t, {
      now,
      purchasedTokens: 100,
    });

    await Promise.all([
      recordChatUsage(t, userId, PRICING.FREE_INCLUDED_TOKENS + 50),
      recordChatUsage(t, userId, 25),
    ]);

    const state = await t.run(async (ctx) => ({
      subscription: await ctx.db.get(subscriptionId),
      usage: await ctx.db
        .query("tokenUsage")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(3),
    }));
    expect(state.subscription?.purchasedTokens).toBe(25);
    expect(state.usage.reduce((total, row) => total + row.totalTokens, 0)).toBe(
      PRICING.FREE_INCLUDED_TOKENS + 75,
    );
    expect(
      state.usage.reduce((total, row) => total + row.purchasedTokensDebited, 0),
    ).toBe(75);
  });

  it("consolidates a wallet split across multiple current rows", async () => {
    const now = Date.UTC(2026, 6, 15, 12);
    vi.setSystemTime(now);
    const t = convexTest(schema, modules);
    const period = getUtcMonthBounds(now);
    const { userId, newerSubscriptionId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("subscriptions", {
        userId,
        plan: "free",
        status: "active",
        includedTokens: PRICING.FREE_INCLUDED_TOKENS,
        purchasedTokens: 70,
        serviceFeeRate: PRICING.PLATFORM_FEE_FREE,
        ...period,
        createdAt: now,
        updatedAt: now,
      });
      const newerSubscriptionId = await ctx.db.insert("subscriptions", {
        userId,
        plan: "free",
        status: "active",
        includedTokens: PRICING.FREE_INCLUDED_TOKENS,
        purchasedTokens: 30,
        serviceFeeRate: PRICING.PLATFORM_FEE_FREE,
        ...period,
        createdAt: now + 1,
        updatedAt: now + 1,
      });
      return { userId, newerSubscriptionId };
    });

    await recordChatUsage(t, userId, PRICING.FREE_INCLUDED_TOKENS + 40);
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("subscriptions")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect(),
    );
    expect(rows.reduce((total, row) => total + row.purchasedTokens, 0)).toBe(
      60,
    );
    expect(
      rows.find((row) => row._id === newerSubscriptionId)?.purchasedTokens,
    ).toBe(60);
  });

  it("enforces the exact trusted Pro prepaid boundary without an immediate wallet debit", async () => {
    const now = Date.UTC(2026, 6, 15, 12);
    vi.setSystemTime(now);
    const t = convexTest(schema, modules);
    const { userId, subscriptionId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const subscriptionId = await ctx.db.insert("subscriptions", {
        userId,
        lemonSqueezySubscriptionId: "1001",
        plan: "pro",
        status: "active",
        proEntitlementProvenance: {
          source: "lemon_squeezy_webhook",
          verifiedAt: now,
        },
        includedTokens: PRICING.PRO_INCLUDED_TOKENS,
        purchasedTokens: 100,
        serviceFeeRate: PRICING.PLATFORM_FEE_PRO,
        periodStart: now - 60_000,
        periodEnd: now + 60_000,
        createdAt: now - 60_000,
        updatedAt: now - 60_000,
      });
      await ctx.db.insert("tokenUsage", {
        userId,
        usageType: "chat",
        inputTokens: PRICING.PRO_INCLUDED_TOKENS + 99,
        outputTokens: 0,
        totalTokens: PRICING.PRO_INCLUDED_TOKENS + 99,
        inputCostCents: 0,
        outputCostCents: 0,
        baseCostCents: 0,
        serviceFeeCents: 0,
        totalCostCents: 0,
        model: "claude-sonnet-5-5",
        provider: "anthropic",
        serviceFeeRate: PRICING.PLATFORM_FEE_PRO,
        purchasedTokensDebited: 0,
        createdAt: now - 1,
      });
      return { userId, subscriptionId };
    });
    const authenticated = t.withIdentity({ subject: `${userId}|session` });
    const tokenLimit = PRICING.PRO_INCLUDED_TOKENS + 100;

    await expect(
      authenticated.query(api.subscriptions.query.canPerformAction, {}),
    ).resolves.toEqual({
      allowed: true,
      tokensUsed: tokenLimit - 1,
      tokenLimit,
    });
    const usageId = await recordChatUsage(t, userId, 1);
    const state = await t.run(async (ctx) => ({
      subscription: await ctx.db.get(subscriptionId),
      usage: await ctx.db.get(usageId),
    }));
    expect(state.subscription?.purchasedTokens).toBe(100);
    expect(state.usage?.purchasedTokensDebited).toBe(0);
    await expect(
      authenticated.query(api.subscriptions.query.canPerformAction, {}),
    ).resolves.toMatchObject({
      allowed: false,
      reason: "token_limit_reached",
      tokensUsed: tokenLimit,
    });
  });

  it("fails quota reads closed when persisted debits exceed usage coverage", async () => {
    const now = Date.UTC(2026, 6, 15, 12);
    vi.setSystemTime(now);
    const t = convexTest(schema, modules);
    const { userId } = await insertFreeWallet(t, {
      now,
      purchasedTokens: 100,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("tokenUsage", {
        userId,
        usageType: "chat",
        inputTokens: 1,
        outputTokens: 0,
        totalTokens: 1,
        inputCostCents: 0,
        outputCostCents: 0,
        baseCostCents: 0,
        serviceFeeCents: 0,
        totalCostCents: 0,
        model: "claude-sonnet-5-5",
        provider: "anthropic",
        serviceFeeRate: PRICING.PLATFORM_FEE_FREE,
        purchasedTokensDebited: 100,
        createdAt: now,
      });
    });
    const authenticated = t.withIdentity({ subject: `${userId}|session` });

    await expect(
      authenticated.query(api.subscriptions.query.getCurrent, {}),
    ).rejects.toThrow("Usage data is too large or contains unsupported values");
    await expect(
      authenticated.query(api.subscriptions.query.canPerformAction, {}),
    ).resolves.toEqual({ allowed: false, reason: "invalid_usage_data" });
    await expect(
      t.query(internal.subscriptions.internalQuery.canPerformActionInternal, {
        userId,
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: "invalid_subscription_balance",
    });
  });
});
