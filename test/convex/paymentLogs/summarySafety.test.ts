import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { internal } from "../../../convex/_generated/api";
import schema from "../../../convex/schema";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/paymentLogs/internalMutation.ts": () =>
    import("../../../convex/paymentLogs/internalMutation"),
};

const validSummary = {
  key: "global" as const,
  totalRevenueCents: 0,
  totalTokensSold: 0,
  totalOrders: 0,
  proSubscriptionCount: 0,
  tokenPackSmallCount: 0,
  tokenPackLargeCount: 0,
  totalRefundedCents: 0,
  totalRefundedTokens: 0,
  updatedAt: 1,
};

async function readPaymentState(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ({
    logs: await ctx.db.query("paymentLogs").withIndex("by_created").take(10),
    summaries: await ctx.db
      .query("paymentStatsSummary")
      .withIndex("by_key", (q) => q.eq("key", "global"))
      .take(2),
  }));
}

describe("payment summary arithmetic safety", () => {
  it("rejects unsafe payment inputs without persisting a log or summary", async () => {
    const t = convexTest(schema, modules);

    await expect(
      t.mutation(internal.paymentLogs.internalMutation.createLog, {
        eventType: "order_created",
        productType: "token_pack_small",
        amountCents: Number.MAX_SAFE_INTEGER + 1,
        tokensAdded: 2_200_000,
        status: "success",
      }),
    ).rejects.toThrow("Payment amount must be a non-negative safe integer");

    await expect(readPaymentState(t)).resolves.toEqual({
      logs: [],
      summaries: [],
    });
  });

  it("rolls back when a success total would overflow", async () => {
    const t = convexTest(schema, modules);
    const summaryId = await t.run(async (ctx) =>
      ctx.db.insert("paymentStatsSummary", {
        ...validSummary,
        totalRevenueCents: Number.MAX_SAFE_INTEGER,
      }),
    );

    await expect(
      t.mutation(internal.paymentLogs.internalMutation.createLog, {
        eventType: "order_created",
        productType: "token_pack_small",
        amountCents: 1,
        tokensAdded: 2_200_000,
        status: "success",
      }),
    ).rejects.toThrow(
      "Payment summary totalRevenueCents exceeds the supported range",
    );

    const state = await readPaymentState(t);
    expect(state.logs).toEqual([]);
    expect(state.summaries).toHaveLength(1);
    expect(state.summaries[0]).toMatchObject({
      _id: summaryId,
      totalRevenueCents: Number.MAX_SAFE_INTEGER,
      totalTokensSold: 0,
      totalOrders: 0,
    });
  });

  it("rolls back when an existing summary counter is invalid", async () => {
    const t = convexTest(schema, modules);
    const summaryId = await t.run(async (ctx) =>
      ctx.db.insert("paymentStatsSummary", {
        ...validSummary,
        tokenPackSmallCount: -1,
      }),
    );

    await expect(
      t.mutation(internal.paymentLogs.internalMutation.createLog, {
        eventType: "subscription_payment_success",
        productType: "pro",
        amountCents: 999,
        status: "success",
      }),
    ).rejects.toThrow(
      "Payment summary tokenPackSmallCount must be a non-negative safe integer",
    );

    const state = await readPaymentState(t);
    expect(state.logs).toEqual([]);
    expect(state.summaries).toHaveLength(1);
    expect(state.summaries[0]).toMatchObject({
      _id: summaryId,
      totalRevenueCents: 0,
      totalOrders: 0,
      tokenPackSmallCount: -1,
    });
  });

  it("rolls back when a refund total would overflow", async () => {
    const t = convexTest(schema, modules);
    const summaryId = await t.run(async (ctx) =>
      ctx.db.insert("paymentStatsSummary", {
        ...validSummary,
        totalRefundedTokens: Number.MAX_SAFE_INTEGER,
      }),
    );

    await expect(
      t.mutation(internal.paymentLogs.internalMutation.createLog, {
        eventType: "order_refunded",
        productType: "token_pack_small",
        tokensAdded: -1,
        status: "refunded",
      }),
    ).rejects.toThrow(
      "Payment summary totalRefundedTokens exceeds the supported range",
    );

    const state = await readPaymentState(t);
    expect(state.logs).toEqual([]);
    expect(state.summaries).toHaveLength(1);
    expect(state.summaries[0]).toMatchObject({
      _id: summaryId,
      totalRefundedTokens: Number.MAX_SAFE_INTEGER,
    });
  });
});
