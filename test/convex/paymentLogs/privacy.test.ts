import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { internal } from "../../../convex/_generated/api";
import crons from "../../../convex/crons";
import {
  getPaymentLogRetentionCutoff,
  PAYMENT_LOG_MAINTENANCE_BATCH_SIZE,
} from "../../../convex/paymentLogs/privacy";
import schema from "../../../convex/schema";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/paymentLogs/privacy.ts": () =>
    import("../../../convex/paymentLogs/privacy"),
};

afterEach(() => {
  vi.useRealTimers();
});

describe("payment-log privacy maintenance", () => {
  it("registers the recurring retention job", () => {
    const jobs = JSON.parse(crons.export()) as Record<
      string,
      { name: string; schedule: Record<string, number | string> }
    >;

    expect(jobs).not.toHaveProperty("redact-payment-log-pii");
    expect(jobs["delete-expired-payment-logs"]).toMatchObject({
      name: "paymentLogs/privacy:deleteExpiredPaymentLogs",
      schedule: { type: "daily", hourUTC: 3, minuteUTC: 20 },
    });
  });

  it("deletes only logs older than five UTC calendar years", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-07-20T12:34:56.000Z");
    vi.setSystemTime(now);
    const cutoff = getPaymentLogRetentionCutoff(now);
    expect(cutoff).toBe(Date.parse("2021-07-20T12:34:56.000Z"));
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      for (
        let index = 0;
        index <= PAYMENT_LOG_MAINTENANCE_BATCH_SIZE;
        index++
      ) {
        await ctx.db.insert("paymentLogs", {
          eventType: "expired_payment",
          status: "success",
          createdAt: cutoff - index - 1,
        });
      }
      const boundaryLogId = await ctx.db.insert("paymentLogs", {
        eventType: "boundary_payment",
        status: "success",
        createdAt: cutoff,
      });
      const recentLogId = await ctx.db.insert("paymentLogs", {
        eventType: "recent_payment",
        status: "success",
        createdAt: now,
      });
      return { boundaryLogId, recentLogId };
    });

    await expect(
      t.mutation(internal.paymentLogs.privacy.deleteExpiredPaymentLogs, {}),
    ).resolves.toEqual({
      deleted: PAYMENT_LOG_MAINTENANCE_BATCH_SIZE,
      manualReviewsDeleted: 0,
      invoiceInboxDeleted: 0,
      cutoff,
      continuationScheduled: true,
    });
    await t.finishAllScheduledFunctions(() => vi.advanceTimersToNextTimer());

    const remaining = await t.run(async (ctx) =>
      ctx.db.query("paymentLogs").withIndex("by_created").take(10),
    );
    expect(remaining.map((log) => log._id)).toEqual([
      ids.boundaryLogId,
      ids.recentLogId,
    ]);
  });

  it("deletes expired current reviews and invoice inbox rows", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-07-20T12:34:56.000Z");
    vi.setSystemTime(now);
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const expiredReview = await ctx.db.insert(
        "paymentSettlementManualReviews",
        {
          settlementKeyFingerprint: "a".repeat(64),
          identityFingerprint: "b".repeat(64),
          fingerprintVersion: 1,
          reviewType: "invoice_refund",
          providerResourceId: "7001",
          reason: "Refund review",
          status: "open",
          expiresAt: now - 1,
          createdAt: 1,
          updatedAt: 1,
        },
      );
      const boundaryReview = await ctx.db.insert(
        "paymentSettlementManualReviews",
        {
          settlementKeyFingerprint: "c".repeat(64),
          identityFingerprint: "d".repeat(64),
          fingerprintVersion: 1,
          reviewType: "order_refund",
          providerResourceId: "7002",
          reason: "Boundary review",
          status: "resolved",
          expiresAt: now,
          createdAt: 1,
          updatedAt: 1,
        },
      );
      const expiredInbox = await ctx.db.insert("lemonSqueezyInvoiceInbox", {
        settlementKeyFingerprint: "e".repeat(64),
        identityFingerprint: "f".repeat(64),
        fingerprintVersion: 1,
        eventName: "subscription_payment_success",
        invoiceId: "8001",
        subscriptionId: "8002",
        customerId: "8003",
        billingReason: "renewal",
        invoiceCreatedAt: 1,
        invoiceUpdatedAt: 1,
        amountCents: 1000,
        currency: "USD",
        status: "manual_review",
        attemptCount: 1,
        nextAttemptAt: now - 1,
        expiresAt: now - 1,
        createdAt: 1,
        updatedAt: 1,
      });
      return { expiredReview, boundaryReview, expiredInbox };
    });

    await expect(
      t.mutation(internal.paymentLogs.privacy.deleteExpiredPaymentLogs, {}),
    ).resolves.toMatchObject({
      deleted: 0,
      manualReviewsDeleted: 1,
      invoiceInboxDeleted: 1,
    });
    const records = await t.run(async (ctx) => ({
      expiredReview: await ctx.db.get(ids.expiredReview),
      boundaryReview: await ctx.db.get(ids.boundaryReview),
      expiredInbox: await ctx.db.get(ids.expiredInbox),
    }));
    expect(records).toEqual({
      expiredReview: null,
      boundaryReview: expect.objectContaining({ _id: ids.boundaryReview }),
      expiredInbox: null,
    });
  });
});
