import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it } from "vitest";

import { api, internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  createSettlementFingerprintKeyAttestation,
  createSettlementIdentityFingerprint,
  createSettlementKeyFingerprint,
} from "../../../convex/lemonSqueezy/webhook";
import schema from "../../../convex/schema";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/subscriptions/internalMutation.ts": () =>
    import("../../../convex/subscriptions/internalMutation"),
  "../../../convex/admin/paymentMutation.ts": () =>
    import("../../../convex/admin/paymentMutation"),
  "../../../convex/admin/utils.ts": () => import("../../../convex/admin/utils"),
  "../../../convex/paymentLogs/internalMutation.ts": () =>
    import("../../../convex/paymentLogs/internalMutation"),
};

beforeEach(() => {
  process.env.LS_PRO_VARIANT_ID = "9001";
  process.env.LS_TOKEN_PACK_SMALL_VARIANT_ID = "9002";
  process.env.LS_TOKEN_PACK_LARGE_VARIANT_ID = "9003";
  process.env.LS_SETTLEMENT_FINGERPRINT_SECRET_V1 =
    "mutation-security-fingerprint-test-secret-v1";
});

describe("subscription mutation trust boundary", () => {
  it("keeps trusted Lemon Squeezy mutations able to create and resume Pro", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const providerCreatedAt = Date.now();

    const { subscriptionId } = await t.mutation(
      internal.subscriptions.internalMutation.syncLemonSqueezySubscription,
      {
        eventName: "subscription_created",
        userId,
        lemonSqueezySubscriptionId: "1001",
        lemonSqueezyCustomerId: "2001",
        lemonSqueezyVariantId: "9001",
        status: "active",
        providerCreatedAt,
        providerUpdatedAt: providerCreatedAt,
        periodEnd: providerCreatedAt + 60_000,
      },
    );
    await t.mutation(
      internal.subscriptions.internalMutation.syncLemonSqueezySubscription,
      {
        eventName: "subscription_cancelled",
        lemonSqueezySubscriptionId: "1001",
        lemonSqueezyCustomerId: "2001",
        lemonSqueezyVariantId: "9001",
        status: "canceled",
        providerCreatedAt,
        providerUpdatedAt: providerCreatedAt + 1,
        periodEnd: providerCreatedAt + 60_000,
      },
    );
    await t.mutation(
      internal.subscriptions.internalMutation.syncLemonSqueezySubscription,
      {
        eventName: "subscription_resumed",
        lemonSqueezySubscriptionId: "1001",
        lemonSqueezyCustomerId: "2001",
        lemonSqueezyVariantId: "9001",
        status: "active",
        providerCreatedAt,
        providerUpdatedAt: providerCreatedAt + 2,
        periodEnd: providerCreatedAt + 120_000,
      },
    );

    await expect(
      t.run(async (ctx) => ctx.db.get(subscriptionId)),
    ).resolves.toMatchObject({
      userId,
      lemonSqueezySubscriptionId: "1001",
      plan: "pro",
      status: "active",
      proEntitlementProvenance: {
        source: "lemon_squeezy_webhook",
      },
    });
  });

  it("does not let ID-only webhooks trust an unverified billing ID", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const { attackerUserId, victimUserId, plantedSubscriptionId } = await t.run(
      async (ctx) => {
        const victimUserId = await ctx.db.insert("users", {});
        let attackerUserId: Id<"users"> | undefined;
        let plantedSubscriptionId: Id<"subscriptions"> | undefined;
        for (let index = 0; index < 125; index++) {
          const plantedUserId = await ctx.db.insert("users", {});
          const plantedId = await ctx.db.insert("subscriptions", {
            userId: plantedUserId,
            lemonSqueezySubscriptionId: "3001",
            lemonSqueezyCustomerId: `forged-customer-${index}`,
            lemonSqueezyVariantId: "forged-variant",
            plan: "pro",
            status: "canceled",
            includedTokens: 2_400_000,
            serviceFeeRate: 0.18,
            purchasedTokens: 123,
            periodStart: now - 1_000,
            periodEnd: now + 60_000,
            createdAt: now + index,
            updatedAt: now + index,
          });
          attackerUserId ??= plantedUserId;
          plantedSubscriptionId ??= plantedId;
        }
        if (!attackerUserId || !plantedSubscriptionId) {
          throw new Error("Failed to create planted subscriptions");
        }
        return { attackerUserId, victimUserId, plantedSubscriptionId };
      },
    );

    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.syncLemonSqueezySubscription,
        {
          eventName: "subscription_resumed",
          lemonSqueezySubscriptionId: "3001",
          lemonSqueezyCustomerId: "4001",
          lemonSqueezyVariantId: "9001",
          status: "active",
          providerCreatedAt: now - 1_000,
          providerUpdatedAt: now,
          periodEnd: now + 60_000,
        },
      ),
    ).rejects.toThrow("Trusted billing subscription not found");
    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.settleSubscriptionInvoice,
        {
          eventName: "subscription_payment_success",
          invoiceId: "5001",
          invoiceStatus: "paid",
          subscriptionId: "3001",
          customerId: "4001",
          billingReason: "renewal",
          invoiceCreatedAt: now,
          invoiceUpdatedAt: now,
          amountCents: 1999,
          currency: "USD",
          fingerprintKeyAttestation: "c".repeat(64),
          settlementKeyFingerprint: "a".repeat(64),
          identityFingerprint: "b".repeat(64),
        },
      ),
    ).rejects.toThrow("Trusted billing subscription not found");

    const { subscriptionId: trustedSubscriptionId } = await t.mutation(
      internal.subscriptions.internalMutation.syncLemonSqueezySubscription,
      {
        eventName: "subscription_created",
        userId: victimUserId,
        lemonSqueezySubscriptionId: "3001",
        lemonSqueezyCustomerId: "4001",
        lemonSqueezyVariantId: "9001",
        status: "active",
        providerCreatedAt: now - 1_000,
        providerUpdatedAt: now,
        periodEnd: now + 60_000,
      },
    );
    await t.mutation(
      internal.subscriptions.internalMutation.syncLemonSqueezySubscription,
      {
        eventName: "subscription_cancelled",
        lemonSqueezySubscriptionId: "3001",
        lemonSqueezyCustomerId: "4001",
        lemonSqueezyVariantId: "9001",
        status: "canceled",
        providerCreatedAt: now - 1_000,
        providerUpdatedAt: now + 1,
        periodEnd: now + 60_000,
      },
    );

    const [planted, trusted] = await Promise.all([
      t.run(async (ctx) => ctx.db.get(plantedSubscriptionId)),
      t.run(async (ctx) => ctx.db.get(trustedSubscriptionId)),
    ]);
    expect(planted).toMatchObject({
      userId: attackerUserId,
      status: "canceled",
      purchasedTokens: 123,
    });
    expect(planted?.proEntitlementProvenance).toBeUndefined();
    expect(trusted).toMatchObject({
      userId: victimUserId,
      status: "canceled",
      proEntitlementProvenance: {
        source: "lemon_squeezy_webhook",
      },
    });
  });

  it("keeps the admin Pro override behind the admin authorization gate", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const { callerUserId, targetUserId, subscriptionId } = await t.run(
      async (ctx) => {
        const callerUserId = await ctx.db.insert("users", {});
        const targetUserId = await ctx.db.insert("users", {});
        const subscriptionId = await ctx.db.insert("subscriptions", {
          userId: targetUserId,
          plan: "pro",
          status: "expired",
          includedTokens: 2_400_000,
          purchasedTokens: 0,
          serviceFeeRate: 0.18,
          periodStart: now - 60_000,
          periodEnd: now - 1,
          createdAt: now,
          updatedAt: now,
        });
        return { callerUserId, targetUserId, subscriptionId };
      },
    );

    await expect(
      t
        .withIdentity({ subject: `${callerUserId}|client-session` })
        .mutation(api.admin.paymentMutation.reactivateSubscription, {
          subscriptionId,
          operationId: "00000000-0000-4000-8000-000000000001",
        }),
    ).rejects.toThrow("Admin access required");

    const subscriptions = await t.run(async (ctx) =>
      ctx.db
        .query("subscriptions")
        .withIndex("by_user", (q) => q.eq("userId", targetUserId))
        .take(2),
    );
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]).toMatchObject({ status: "expired" });
    expect(subscriptions[0]?.proEntitlementProvenance).toBeUndefined();
  });

  it("records provenance when an authorized admin grants Pro", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const { adminUserId, subscriptionId } = await t.run(async (ctx) => {
      const adminUserId = await ctx.db.insert("users", {});
      const targetUserId = await ctx.db.insert("users", {});
      await ctx.db.insert("userProfiles", {
        userId: adminUserId,
        githubUsername: "billing-admin",
        isAdmin: true,
        createdAt: now,
        updatedAt: now,
      });
      const subscriptionId = await ctx.db.insert("subscriptions", {
        userId: targetUserId,
        plan: "pro",
        status: "expired",
        includedTokens: 2_400_000,
        purchasedTokens: 0,
        serviceFeeRate: 0.18,
        periodStart: now - 60_000,
        periodEnd: now - 1,
        createdAt: now,
        updatedAt: now,
      });
      return { adminUserId, subscriptionId };
    });

    await expect(
      t
        .withIdentity({ subject: `${adminUserId}|admin-session` })
        .mutation(api.admin.paymentMutation.reactivateSubscription, {
          subscriptionId,
          operationId: "00000000-0000-4000-8000-000000000002",
        }),
    ).resolves.toEqual({ success: true });

    const subscription = await t.run(async (ctx) => ctx.db.get(subscriptionId));
    expect(subscription).toMatchObject({
      plan: "pro",
      proEntitlementProvenance: {
        source: "admin_override",
      },
    });
  });

  it("requires Lemon Squeezy to resume a provider-managed Pro subscription", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const periodStart = now - 24 * 60 * 60 * 1_000;
    const periodEnd = now + 24 * 60 * 60 * 1_000;
    const { adminUserId, targetUserId, subscriptionId, boundaryId } =
      await t.run(async (ctx) => {
        const adminUserId = await ctx.db.insert("users", {});
        const targetUserId = await ctx.db.insert("users", {});
        await ctx.db.insert("userProfiles", {
          userId: adminUserId,
          githubUsername: "billing-admin",
          isAdmin: true,
          createdAt: now,
          updatedAt: now,
        });
        const subscriptionId = await ctx.db.insert("subscriptions", {
          userId: targetUserId,
          lemonSqueezySubscriptionId: "6001",
          lemonSqueezyCustomerId: "7001",
          lemonSqueezyVariantId: "9001",
          providerCreatedAt: periodStart,
          providerUpdatedAt: now,
          plan: "pro",
          status: "canceled",
          proEntitlementProvenance: {
            source: "lemon_squeezy_webhook",
            verifiedAt: periodStart,
          },
          includedTokens: 2_400_000,
          purchasedTokens: 100,
          serviceFeeRate: 0.18,
          periodStart,
          periodEnd,
          createdAt: periodStart,
          updatedAt: now,
        });
        const boundaryId = await ctx.db.insert(
          "subscriptionBillingBoundaries",
          {
            subscriptionId,
            periodStart,
            periodEnd,
            providerUpdatedAt: now,
            status: "pending",
            createdAt: periodStart,
            updatedAt: now,
          },
        );
        return { adminUserId, targetUserId, subscriptionId, boundaryId };
      });
    const admin = t.withIdentity({
      subject: `${adminUserId}|admin-session`,
    });

    await expect(
      admin.mutation(api.admin.paymentMutation.reactivateSubscription, {
        subscriptionId,
        operationId: "00000000-0000-4000-8000-000000000003",
      }),
    ).rejects.toThrow(
      "Lemon Squeezy subscriptions must be reactivated in Lemon Squeezy",
    );

    await expect(
      admin.mutation(api.admin.paymentMutation.cancelSubscription, {
        subscriptionId,
        operationId: "00000000-0000-4000-8000-000000000008",
      }),
    ).rejects.toThrow(
      "Lemon Squeezy subscriptions must be canceled in Lemon Squeezy",
    );

    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.syncLemonSqueezySubscription,
        {
          eventName: "subscription_resumed",
          lemonSqueezySubscriptionId: "6001",
          lemonSqueezyCustomerId: "7001",
          lemonSqueezyVariantId: "9001",
          status: "active",
          providerCreatedAt: periodStart,
          providerUpdatedAt: now + 1,
          periodEnd,
        },
      ),
    ).resolves.toMatchObject({ subscriptionId, outcome: "applied" });

    const state = await t.run(async (ctx) => ({
      subscription: await ctx.db.get(subscriptionId),
      boundary: await ctx.db.get(boundaryId),
      boundaries: await ctx.db
        .query("subscriptionBillingBoundaries")
        .withIndex("by_subscription_and_period_end", (q) =>
          q.eq("subscriptionId", subscriptionId),
        )
        .take(3),
      logs: await ctx.db
        .query("paymentLogs")
        .withIndex("by_user", (q) => q.eq("userId", targetUserId))
        .take(3),
    }));
    expect(state.subscription).toMatchObject({
      status: "active",
      periodStart,
      periodEnd,
      proEntitlementProvenance: {
        source: "lemon_squeezy_webhook",
        verifiedAt: expect.any(Number),
      },
    });
    expect(state.boundary).toMatchObject({ status: "pending" });
    expect(state.boundaries).toHaveLength(1);
    expect(
      state.logs.filter((log) => log.eventType === "admin_reactivate"),
    ).toHaveLength(0);
  });

  it("settles an ended admin Pro boundary before starting a new period", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const oldPeriodEnd = now - 1_000;
    const oldPeriodStart = oldPeriodEnd - 30 * 24 * 60 * 60 * 1_000;
    const { adminUserId, targetUserId, subscriptionId, oldBoundaryId } =
      await t.run(async (ctx) => {
        const adminUserId = await ctx.db.insert("users", {});
        const targetUserId = await ctx.db.insert("users", {});
        await ctx.db.insert("userProfiles", {
          userId: adminUserId,
          githubUsername: "billing-admin",
          isAdmin: true,
          createdAt: now,
          updatedAt: now,
        });
        const subscriptionId = await ctx.db.insert("subscriptions", {
          userId: targetUserId,
          plan: "pro",
          status: "canceled",
          proEntitlementProvenance: {
            source: "admin_override",
            verifiedAt: oldPeriodStart,
          },
          includedTokens: 2_400_000,
          purchasedTokens: 100,
          serviceFeeRate: 0.18,
          periodStart: oldPeriodStart,
          periodEnd: oldPeriodEnd,
          createdAt: oldPeriodStart,
          updatedAt: oldPeriodEnd,
        });
        const oldBoundaryId = await ctx.db.insert(
          "subscriptionBillingBoundaries",
          {
            subscriptionId,
            periodStart: oldPeriodStart,
            periodEnd: oldPeriodEnd,
            providerUpdatedAt: oldPeriodEnd,
            status: "pending",
            createdAt: oldPeriodStart,
            updatedAt: oldPeriodEnd,
          },
        );
        await ctx.db.insert("tokenUsage", {
          purchasedTokensDebited: 0,
          userId: targetUserId,
          usageType: "chat",
          inputTokens: 2_400_040,
          outputTokens: 0,
          totalTokens: 2_400_040,
          inputCostCents: 1,
          outputCostCents: 0,
          baseCostCents: 1,
          serviceFeeCents: 0.18,
          totalCostCents: 1.18,
          model: "claude-sonnet-5-5",
          provider: "anthropic",
          serviceFeeRate: 0.18,
          createdAt: oldPeriodEnd - 1,
        });
        return {
          adminUserId,
          targetUserId,
          subscriptionId,
          oldBoundaryId,
        };
      });
    const admin = t.withIdentity({
      subject: `${adminUserId}|admin-session`,
    });

    await expect(
      admin.mutation(api.admin.paymentMutation.reactivateSubscription, {
        subscriptionId,
        operationId: "00000000-0000-4000-8000-000000000004",
      }),
    ).resolves.toEqual({ success: true });
    const firstState = await t.run(async (ctx) => ({
      subscription: await ctx.db.get(subscriptionId),
      oldBoundary: await ctx.db.get(oldBoundaryId),
      boundaries: await ctx.db
        .query("subscriptionBillingBoundaries")
        .withIndex("by_subscription_and_period_end", (q) =>
          q.eq("subscriptionId", subscriptionId),
        )
        .take(3),
    }));
    expect(firstState.subscription).toMatchObject({
      status: "active",
      purchasedTokens: 60,
      proEntitlementProvenance: { source: "admin_override" },
    });
    expect(firstState.subscription?.periodStart).toBeGreaterThan(oldPeriodEnd);
    expect(firstState.oldBoundary).toMatchObject({
      status: "settled",
      settlementReason: "terminal_entitlement",
      purchasedTokensDebited: 40,
    });
    expect(firstState.boundaries).toHaveLength(2);
    expect(firstState.boundaries).toContainEqual(
      expect.objectContaining({
        periodStart: firstState.subscription?.periodStart,
        periodEnd: firstState.subscription?.periodEnd,
        status: "pending",
      }),
    );

    await expect(
      admin.mutation(api.admin.paymentMutation.reactivateSubscription, {
        subscriptionId,
        operationId: "00000000-0000-4000-8000-000000000004",
      }),
    ).resolves.toEqual({ success: true });
    const retryState = await t.run(async (ctx) => ({
      subscription: await ctx.db.get(subscriptionId),
      boundaries: await ctx.db
        .query("subscriptionBillingBoundaries")
        .withIndex("by_subscription_and_period_end", (q) =>
          q.eq("subscriptionId", subscriptionId),
        )
        .take(3),
      logs: await ctx.db
        .query("paymentLogs")
        .withIndex("by_user", (q) => q.eq("userId", targetUserId))
        .take(3),
    }));
    expect(retryState.subscription?.periodStart).toBe(
      firstState.subscription?.periodStart,
    );
    expect(retryState.subscription?.periodEnd).toBe(
      firstState.subscription?.periodEnd,
    );
    expect(retryState.subscription?.purchasedTokens).toBe(60);
    expect(retryState.boundaries).toHaveLength(2);
    expect(
      retryState.logs.filter((log) => log.eventType === "admin_reactivate"),
    ).toHaveLength(1);
  });

  it("fails closed when an ended Pro boundary cannot settle exactly", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const periodEnd = now - 1_000;
    const periodStart = periodEnd - 30 * 24 * 60 * 60 * 1_000;
    const { adminUserId, targetUserId, subscriptionId, boundaryId } =
      await t.run(async (ctx) => {
        const adminUserId = await ctx.db.insert("users", {});
        const targetUserId = await ctx.db.insert("users", {});
        await ctx.db.insert("userProfiles", {
          userId: adminUserId,
          githubUsername: "billing-admin",
          isAdmin: true,
          createdAt: now,
          updatedAt: now,
        });
        const subscriptionId = await ctx.db.insert("subscriptions", {
          userId: targetUserId,
          plan: "pro",
          status: "canceled",
          proEntitlementProvenance: {
            source: "admin_override",
            verifiedAt: periodStart,
          },
          includedTokens: 2_400_000,
          purchasedTokens: 30,
          serviceFeeRate: 0.18,
          periodStart,
          periodEnd,
          createdAt: periodStart,
          updatedAt: periodEnd,
        });
        const boundaryId = await ctx.db.insert(
          "subscriptionBillingBoundaries",
          {
            subscriptionId,
            periodStart,
            periodEnd,
            providerUpdatedAt: periodEnd,
            status: "pending",
            createdAt: periodStart,
            updatedAt: periodEnd,
          },
        );
        await ctx.db.insert("tokenUsage", {
          purchasedTokensDebited: 0,
          userId: targetUserId,
          usageType: "chat",
          inputTokens: 2_400_040,
          outputTokens: 0,
          totalTokens: 2_400_040,
          inputCostCents: 1,
          outputCostCents: 0,
          baseCostCents: 1,
          serviceFeeCents: 0.18,
          totalCostCents: 1.18,
          model: "claude-sonnet-5-5",
          provider: "anthropic",
          serviceFeeRate: 0.18,
          createdAt: periodEnd - 1,
        });
        return { adminUserId, targetUserId, subscriptionId, boundaryId };
      });

    await expect(
      t
        .withIdentity({ subject: `${adminUserId}|admin-session` })
        .mutation(api.admin.paymentMutation.reactivateSubscription, {
          subscriptionId,
          operationId: "00000000-0000-4000-8000-000000000005",
        }),
    ).rejects.toThrow(
      "Purchased-token wallet cannot cover the exact terminal settlement",
    );

    const state = await t.run(async (ctx) => ({
      subscription: await ctx.db.get(subscriptionId),
      boundary: await ctx.db.get(boundaryId),
      logs: await ctx.db
        .query("paymentLogs")
        .withIndex("by_user", (q) => q.eq("userId", targetUserId))
        .take(1),
    }));
    expect(state.subscription).toMatchObject({
      status: "canceled",
      periodStart,
      periodEnd,
      purchasedTokens: 30,
    });
    expect(state.boundary).toMatchObject({ status: "pending" });
    expect(state.logs).toEqual([]);
  });

  it("credits token packs to trusted Pro instead of a newer untrusted row", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const { userId, trustedId, forgedId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const trustedId = await ctx.db.insert("subscriptions", {
        userId,
        lemonSqueezySubscriptionId: "trusted-token-owner",
        plan: "pro",
        status: "active",
        proEntitlementProvenance: {
          source: "lemon_squeezy_webhook",
          verifiedAt: now,
        },
        includedTokens: 2_400_000,
        purchasedTokens: 100,
        serviceFeeRate: 0.18,
        periodStart: now,
        periodEnd: now + 60_000,
        createdAt: now,
        updatedAt: now,
      });
      const forgedId = await ctx.db.insert("subscriptions", {
        userId,
        lemonSqueezySubscriptionId: "newer-forged-row",
        plan: "pro",
        status: "active",
        includedTokens: 2_400_000,
        purchasedTokens: 0,
        serviceFeeRate: 0.18,
        periodStart: now,
        periodEnd: now + 60_000,
        createdAt: now + 1,
        updatedAt: now + 1,
      });
      return { userId, trustedId, forgedId };
    });

    const orderId = "8101";
    const orderCreatedAt = now;
    const customerId = "2101";
    const variantId = "9002";
    const quantity = 1;
    const amountCents = 999;
    const currency = "USD";
    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.fulfillTokenPackOrder,
        {
          userId,
          orderId,
          orderCreatedAt,
          customerId,
          variantId,
          quantity,
          amountCents,
          currency,
          fingerprintKeyAttestation:
            await createSettlementFingerprintKeyAttestation(),
          settlementKeyFingerprint: await createSettlementKeyFingerprint(
            "order",
            orderId,
          ),
          identityFingerprint: await createSettlementIdentityFingerprint([
            "order",
            userId,
            orderId,
            orderCreatedAt,
            customerId,
            variantId,
            quantity,
            amountCents,
            currency,
          ]),
        },
      ),
    ).resolves.toMatchObject({ subscriptionId: trustedId, outcome: "applied" });
    const [trusted, forged] = await Promise.all([
      t.run(async (ctx) => ctx.db.get(trustedId)),
      t.run(async (ctx) => ctx.db.get(forgedId)),
    ]);
    expect(trusted?.purchasedTokens).toBe(2_200_100);
    expect(forged?.purchasedTokens).toBe(0);
  });
});
