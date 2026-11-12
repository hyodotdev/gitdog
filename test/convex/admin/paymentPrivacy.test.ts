import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "../../../convex/_generated/api";
import schema from "../../../convex/schema";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/admin/paymentQuery.ts": () =>
    import("../../../convex/admin/paymentQuery"),
  "../../../convex/admin/paymentMutation.ts": () =>
    import("../../../convex/admin/paymentMutation"),
  "../../../convex/admin/utils.ts": () => import("../../../convex/admin/utils"),
  "../../../convex/lemonSqueezy/webhook.ts": () =>
    import("../../../convex/lemonSqueezy/webhook"),
};

const PRO_INCLUDED_TOKENS = 2_400_000;

afterEach(() => {
  vi.useRealTimers();
});

describe("admin payment-log privacy", () => {
  it("authenticates and idempotently requeues an exact terminal invoice review", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const now = Date.now();
    const { adminUserId, normalUserId, inboxId, reviewId } = await t.run(
      async (ctx) => {
        const adminUserId = await ctx.db.insert("users", {});
        const normalUserId = await ctx.db.insert("users", {});
        await ctx.db.insert("userProfiles", {
          userId: adminUserId,
          githubUsername: "billing-admin",
          isAdmin: true,
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.insert("userProfiles", {
          userId: normalUserId,
          githubUsername: "normal-user",
          createdAt: now,
          updatedAt: now,
        });
        const inboxId = await ctx.db.insert("lemonSqueezyInvoiceInbox", {
          settlementKeyFingerprint: "a".repeat(64),
          identityFingerprint: "b".repeat(64),
          fingerprintVersion: 1,
          eventName: "subscription_payment_success",
          invoiceId: "7001",
          subscriptionId: "4001",
          customerId: "2001",
          billingReason: "renewal",
          invoiceCreatedAt: now,
          invoiceUpdatedAt: now,
          amountCents: 1_999,
          currency: "USD",
          status: "manual_review",
          attemptCount: 96,
          nextAttemptAt: now,
          lastError: "Provider state unavailable",
          expiresAt: now + 1_000_000,
          createdAt: now,
          updatedAt: now,
        });
        const reviewId = await ctx.db.insert("paymentSettlementManualReviews", {
          settlementKeyFingerprint: "a".repeat(64),
          identityFingerprint: "b".repeat(64),
          fingerprintVersion: 1,
          reviewType: "invoice_processing",
          providerResourceId: "7001",
          invoiceInboxId: inboxId,
          lemonSqueezySubscriptionId: "4001",
          amountCents: 1_999,
          currency: "USD",
          reason: "Invoice processing exhausted automatic retries",
          status: "open",
          expiresAt: now + 1_000_000,
          createdAt: now,
          updatedAt: now,
        });
        return { adminUserId, normalUserId, inboxId, reviewId };
      },
    );
    const args = {
      manualReviewId: reviewId,
      evidenceReference: "ls-support-case-7001",
      confirmRetry: true as const,
    };

    await expect(
      t.mutation(
        api.admin.paymentMutation.requeueSubscriptionInvoiceReview,
        args,
      ),
    ).rejects.toThrow("Unauthorized");
    await expect(
      t
        .withIdentity({ subject: `${normalUserId}|session` })
        .mutation(
          api.admin.paymentMutation.requeueSubscriptionInvoiceReview,
          args,
        ),
    ).rejects.toThrow("Unauthorized");

    const authenticated = t.withIdentity({
      subject: `${adminUserId}|admin-session`,
    });
    const listed = await authenticated.query(
      api.admin.paymentQuery.listOpenSettlementReviews,
      { limit: 10 },
    );
    expect(listed.reviews).toEqual([
      expect.objectContaining({
        _id: reviewId,
        reviewType: "invoice_processing",
        providerResourceId: "7001",
        status: "open",
      }),
    ]);
    expect(JSON.stringify(listed)).not.toContain("a".repeat(64));
    expect(JSON.stringify(listed)).not.toContain("b".repeat(64));

    await expect(
      authenticated.mutation(
        api.admin.paymentMutation.requeueSubscriptionInvoiceReview,
        { ...args, evidenceReference: "   " },
      ),
    ).rejects.toThrow("bounded provider evidence");
    await expect(
      authenticated.mutation(
        api.admin.paymentMutation.requeueSubscriptionInvoiceReview,
        args,
      ),
    ).resolves.toEqual({ success: true, idempotent: false });
    await expect(
      authenticated.mutation(
        api.admin.paymentMutation.requeueSubscriptionInvoiceReview,
        args,
      ),
    ).resolves.toEqual({ success: true, idempotent: true });

    const state = await t.run(async (ctx) => ({
      inbox: await ctx.db.get(inboxId),
      review: await ctx.db.get(reviewId),
    }));
    expect(state.inbox).toMatchObject({ status: "pending", attemptCount: 0 });
    expect(state.inbox).not.toHaveProperty("lastError");
    expect(state.review).toMatchObject({
      status: "resolved",
      resolutionAction: "requeue",
      resolutionEvidenceReference: args.evidenceReference,
      resolvedBy: adminUserId,
    });

    await t.run(async (ctx) => ctx.db.delete(inboxId));
    await expect(
      authenticated.mutation(
        api.admin.paymentMutation.requeueSubscriptionInvoiceReview,
        args,
      ),
    ).resolves.toEqual({ success: true, idempotent: true });
    await expect(
      authenticated.mutation(
        api.admin.paymentMutation.requeueSubscriptionInvoiceReview,
        { ...args, evidenceReference: "different-provider-case" },
      ),
    ).rejects.toThrow("already resolved");
  });

  it("rejects a terminal invoice review whose inbox identity conflicts", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const now = Date.now();
    const { adminUserId, inboxId, reviewId } = await t.run(async (ctx) => {
      const adminUserId = await ctx.db.insert("users", {});
      await ctx.db.insert("userProfiles", {
        userId: adminUserId,
        githubUsername: "billing-admin",
        isAdmin: true,
        createdAt: now,
        updatedAt: now,
      });
      const inboxId = await ctx.db.insert("lemonSqueezyInvoiceInbox", {
        settlementKeyFingerprint: "c".repeat(64),
        identityFingerprint: "d".repeat(64),
        fingerprintVersion: 1,
        eventName: "subscription_payment_success",
        invoiceId: "7002",
        subscriptionId: "4002",
        customerId: "2002",
        billingReason: "renewal",
        invoiceCreatedAt: now,
        invoiceUpdatedAt: now,
        amountCents: 1_999,
        currency: "USD",
        status: "manual_review",
        attemptCount: 96,
        nextAttemptAt: now,
        expiresAt: now + 1_000_000,
        createdAt: now,
        updatedAt: now,
      });
      const reviewId = await ctx.db.insert("paymentSettlementManualReviews", {
        settlementKeyFingerprint: "c".repeat(64),
        identityFingerprint: "e".repeat(64),
        fingerprintVersion: 1,
        reviewType: "invoice_processing",
        providerResourceId: "7002",
        invoiceInboxId: inboxId,
        lemonSqueezySubscriptionId: "4002",
        reason: "Conflicting identity",
        status: "open",
        expiresAt: now + 1_000_000,
        createdAt: now,
        updatedAt: now,
      });
      return { adminUserId, inboxId, reviewId };
    });

    await expect(
      t
        .withIdentity({ subject: `${adminUserId}|admin-session` })
        .mutation(api.admin.paymentMutation.requeueSubscriptionInvoiceReview, {
          manualReviewId: reviewId,
          evidenceReference: "ls-support-case-conflict",
          confirmRetry: true,
        }),
    ).rejects.toThrow("conflicts with durable inbox");
    const state = await t.run(async (ctx) => ({
      inbox: await ctx.db.get(inboxId),
      review: await ctx.db.get(reviewId),
    }));
    expect(state.inbox).toMatchObject({ status: "manual_review" });
    expect(state.review).toMatchObject({ status: "open" });
  });

  it("keeps admin refunds from consuming current Pro token liability", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const { adminUserId, subscriptionId, refund41LogId, refund40LogId } =
      await t.run(async (ctx) => {
        const adminUserId = await ctx.db.insert("users", {});
        const customerUserId = await ctx.db.insert("users", {});
        await ctx.db.insert("userProfiles", {
          userId: adminUserId,
          githubUsername: "billing-admin",
          isAdmin: true,
          createdAt: now,
          updatedAt: now,
        });
        const subscriptionId = await ctx.db.insert("subscriptions", {
          userId: customerUserId,
          plan: "pro",
          status: "active",
          includedTokens: PRO_INCLUDED_TOKENS,
          purchasedTokens: 100,
          serviceFeeRate: 0.18,
          periodStart: now - 24 * 60 * 60 * 1_000,
          periodEnd: now + 30 * 24 * 60 * 60 * 1_000,
          proEntitlementProvenance: {
            source: "admin_override",
            verifiedAt: now,
          },
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.insert("tokenUsage", {
          purchasedTokensDebited: 0,
          userId: customerUserId,
          usageType: "chat",
          inputTokens: PRO_INCLUDED_TOKENS + 60,
          outputTokens: 0,
          totalTokens: PRO_INCLUDED_TOKENS + 60,
          inputCostCents: 1,
          outputCostCents: 0,
          baseCostCents: 1,
          serviceFeeCents: 0.18,
          totalCostCents: 1.18,
          model: "claude-sonnet-5-5",
          provider: "anthropic",
          serviceFeeRate: 0.18,
          createdAt: now,
        });
        const refund41LogId = await ctx.db.insert("paymentLogs", {
          userId: customerUserId,
          eventType: "admin_credit",
          productType: "token_pack",
          tokensAdded: 41,
          status: "success",
          createdAt: now,
        });
        const refund40LogId = await ctx.db.insert("paymentLogs", {
          userId: customerUserId,
          eventType: "admin_credit",
          productType: "token_pack",
          tokensAdded: 40,
          status: "success",
          createdAt: now,
        });
        return {
          adminUserId,
          subscriptionId,
          refund41LogId,
          refund40LogId,
        };
      });
    const authenticated = t.withIdentity({
      subject: `${adminUserId}|admin-session`,
    });

    await expect(
      authenticated.mutation(api.admin.paymentMutation.refundTokens, {
        subscriptionId,
        tokensToRefund: 41,
        paymentLogId: refund41LogId,
      }),
    ).rejects.toThrow("reserved for current Pro usage");
    await expect(
      authenticated.mutation(api.admin.paymentMutation.refundTokens, {
        subscriptionId,
        tokensToRefund: 40,
        paymentLogId: refund40LogId,
      }),
    ).resolves.toMatchObject({
      success: true,
      previousBalance: 100,
      newBalance: 60,
    });

    const state = await t.run(async (ctx) => ({
      subscription: await ctx.db.get(subscriptionId),
      refundLogs: await ctx.db
        .query("paymentLogs")
        .withIndex("by_status", (q) => q.eq("status", "refunded"))
        .take(2),
    }));
    expect(state.subscription?.purchasedTokens).toBe(60);
    expect(state.refundLogs).toHaveLength(2);
    expect(state.refundLogs).toContainEqual(
      expect.objectContaining({
        eventType: "admin_refund",
        tokensAdded: -40,
      }),
    );
  });

  it("returns only allowlisted payment-log fields from every admin query", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const { adminUserId, customerUserId, paymentLogId } = await t.run(
      async (ctx) => {
        const adminUserId = await ctx.db.insert("users", {});
        const customerUserId = await ctx.db.insert("users", {});
        await ctx.db.insert("userProfiles", {
          userId: adminUserId,
          githubUsername: "billing-admin",
          isAdmin: true,
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.insert("userProfiles", {
          userId: customerUserId,
          githubUsername: "customer",
          displayName: "Customer",
          createdAt: now,
          updatedAt: now,
        });
        const paymentLogId = await ctx.db.insert("paymentLogs", {
          userId: customerUserId,
          lemonSqueezyEventId: "event-1",
          lemonSqueezyOrderId: "order-1",
          lemonSqueezyCustomerId: "customer-1",
          lemonSqueezyVariantId: "variant-1",
          eventType: "order_created",
          productType: "token_pack_small",
          amountCents: 500,
          currency: "USD",
          tokensAdded: 2_200_000,
          status: "refunded",
          errorMessage: "Fixed diagnostic code",
          adminNote: "Refund verified",
          refundedAt: now,
          refundedBy: adminUserId,
          createdAt: now,
        });
        return { adminUserId, customerUserId, paymentLogId };
      },
    );
    const authenticated = t.withIdentity({
      subject: `${adminUserId}|admin-session`,
    });

    const listed = await authenticated.query(
      api.admin.paymentQuery.listPaymentLogs,
      { limit: 10 },
    );
    expect(listed.logs).toHaveLength(1);
    expect(listed.logs[0]).toMatchObject({
      _id: paymentLogId,
      userId: customerUserId,
      lemonSqueezyOrderId: "order-1",
      eventType: "order_created",
      productType: "token_pack_small",
      amountCents: 500,
      tokensAdded: 2_200_000,
      status: "refunded",
      errorMessage: "Fixed diagnostic code",
      adminNote: "Refund verified",
      refundedAt: now,
      refundedBy: adminUserId,
      createdAt: now,
      userName: "Customer",
    });
    const grouped = await authenticated.query(
      api.admin.paymentQuery.listPaymentLogsByUser,
      { year: new Date(now).getFullYear(), month: new Date(now).getMonth() },
    );
    expect(grouped.users).toHaveLength(1);
    expect(grouped.users[0]?.logs[0]).toMatchObject({
      _id: paymentLogId,
      lemonSqueezyOrderId: "order-1",
      eventType: "order_created",
      productType: "token_pack_small",
      amountCents: 500,
      tokensAdded: 2_200_000,
      status: "refunded",
      errorMessage: "Fixed diagnostic code",
      adminNote: "Refund verified",
      refundedAt: now,
      refundedBy: adminUserId,
      createdAt: now,
    });
  });
});
