import { convexTest } from "convex-test";
import { mutationWithTime } from "../scheduling";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  assertConfiguredProductVariants,
  assertLemonSqueezyRuntimeConfiguration,
  createSettlementFingerprintKeyAttestation,
  createSettlementIdentityFingerprint,
  createSettlementKeyFingerprint,
  parsePaidSubscriptionInvoice,
  parseSubscriptionInvoiceRefund,
  parseSubscriptionState,
  parseTokenPackOrder,
  parseTokenPackRefund,
  assertConfiguredWebhookResource,
  resolveConfiguredOrderProductType,
  verifyLemonSqueezySignature,
  type WebhookEnvelope,
} from "../../../convex/lemonSqueezy/webhook";
import schema from "../../../convex/schema";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/subscriptions/internalMutation.ts": () =>
    import("../../../convex/subscriptions/internalMutation"),
  "../../../convex/_ai/chatBilling.ts": () =>
    import("../../../convex/_ai/chatBilling"),
  "../../../convex/_ai/embeddingBilling.ts": () =>
    import("../../../convex/_ai/embeddingBilling"),
  "../../../convex/paymentLogs/internalMutation.ts": () =>
    import("../../../convex/paymentLogs/internalMutation"),
  "../../../convex/tokenUsage/internalMutation.ts": () =>
    import("../../../convex/tokenUsage/internalMutation"),
  "../../../convex/lemonSqueezy/webhook.ts": () =>
    import("../../../convex/lemonSqueezy/webhook"),
  "../../../convex/admin/paymentMutation.ts": () =>
    import("../../../convex/admin/paymentMutation"),
  "../../../convex/admin/utils.ts": () => import("../../../convex/admin/utils"),
  "../../../convex/http.ts": () => import("../../../convex/http"),
};

const PRO_VARIANT_ID = "9001";
const SMALL_PACK_VARIANT_ID = "9002";
const LARGE_PACK_VARIANT_ID = "9003";
const PRO_INCLUDED_TOKENS = 2_400_000;
const SMALL_PACK_TOKENS = 2_200_000;
const originalVariantEnvironment = {
  pro: process.env.LS_PRO_VARIANT_ID,
  small: process.env.LS_TOKEN_PACK_SMALL_VARIANT_ID,
  large: process.env.LS_TOKEN_PACK_LARGE_VARIANT_ID,
  store: process.env.LS_STORE_ID,
  testMode: process.env.LS_TEST_MODE,
  fingerprintSecret: process.env.LS_SETTLEMENT_FINGERPRINT_SECRET_V1,
  webhookSecret: process.env.LS_WEBHOOK_SECRET,
};

beforeEach(() => {
  process.env.LS_PRO_VARIANT_ID = PRO_VARIANT_ID;
  process.env.LS_TOKEN_PACK_SMALL_VARIANT_ID = SMALL_PACK_VARIANT_ID;
  process.env.LS_TOKEN_PACK_LARGE_VARIANT_ID = LARGE_PACK_VARIANT_ID;
  process.env.LS_STORE_ID = "1001";
  process.env.LS_TEST_MODE = "true";
  process.env.LS_SETTLEMENT_FINGERPRINT_SECRET_V1 =
    "billing-fingerprint-test-secret-v1";
  process.env.LS_WEBHOOK_SECRET = "billing-webhook-test-secret";
});

afterEach(() => {
  vi.useRealTimers();
  for (const [name, value] of [
    ["LS_PRO_VARIANT_ID", originalVariantEnvironment.pro],
    ["LS_TOKEN_PACK_SMALL_VARIANT_ID", originalVariantEnvironment.small],
    ["LS_TOKEN_PACK_LARGE_VARIANT_ID", originalVariantEnvironment.large],
    ["LS_STORE_ID", originalVariantEnvironment.store],
    ["LS_TEST_MODE", originalVariantEnvironment.testMode],
    [
      "LS_SETTLEMENT_FINGERPRINT_SECRET_V1",
      originalVariantEnvironment.fingerprintSecret,
    ],
    ["LS_WEBHOOK_SECRET", originalVariantEnvironment.webhookSecret],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function tokenOrderArgs(userId: string, orderId = "8101") {
  const orderCreatedAt = Date.parse("2099-01-15T12:00:00.000Z");
  const customerId = "2101";
  const quantity = 1;
  const amountCents = 999;
  const currency = "USD";
  return {
    userId,
    orderId,
    orderCreatedAt,
    customerId,
    variantId: SMALL_PACK_VARIANT_ID,
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
      SMALL_PACK_VARIANT_ID,
      quantity,
      amountCents,
      currency,
    ]),
  };
}

async function invoiceArgs(
  subscriptionId: string,
  invoiceId: string,
  invoiceCreatedAt: number,
  billingReason: "initial" | "renewal" | "updated" = "renewal",
) {
  const customerId = "2201";
  const amountCents = 1_999;
  const currency = "USD";
  return {
    eventName: "subscription_payment_success" as const,
    invoiceId,
    invoiceStatus: "paid" as const,
    subscriptionId,
    customerId,
    billingReason,
    invoiceCreatedAt,
    invoiceUpdatedAt: invoiceCreatedAt,
    amountCents,
    currency,
    fingerprintKeyAttestation:
      await createSettlementFingerprintKeyAttestation(),
    settlementKeyFingerprint: await createSettlementKeyFingerprint(
      "invoice",
      invoiceId,
    ),
    identityFingerprint: await createSettlementIdentityFingerprint([
      "invoice",
      invoiceId,
      subscriptionId,
      customerId,
      billingReason,
      invoiceCreatedAt,
      amountCents,
      currency,
    ]),
  };
}

async function pinSettlementConfiguration(
  t: ReturnType<typeof convexTest>,
  updatedAt: number,
): Promise<void> {
  const fingerprintKeyAttestation =
    await createSettlementFingerprintKeyAttestation();
  await t.run(async (ctx) => {
    await ctx.db.insert("paymentSettlementConfiguration", {
      key: "global",
      fingerprintKeyAttestation,
      updatedAt,
    });
  });
}

async function insertAiUsageScope(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  now: number,
) {
  return await t.run(async (ctx) => {
    const repositoryId = await ctx.db.insert("repositories", {
      indexSyncPending: false,
      indexVersion: 1,
      indexStatus: "completed",
      indexProgressAt: Date.now(),
      ragStatus: "completed",
      ragTotalChunks: 0,
      ragIndexedChunks: 0,
      ragFailedChunks: 0,
      userId,
      installationId: 101,
      githubRepositoryId: 101,
      githubRepo: "owner/billing-holds",
      githubRepoKey: "owner/billing-holds",
      name: "billing-holds",
      githubUrl: "https://github.com/owner/billing-holds",
      isActive: true,
      settings: {
        issueAssistantEnabled: true,
        autoFormatIssue: true,
        autoAnswerQuestions: true,
        tagMaintainersForCodeChanges: true,
        discussionAssistantEnabled: true,
        autoFormatDiscussion: true,
        autoAnswerDiscussionQuestions: true,
        tagMaintainersForDiscussionCodeChanges: true,
        requireApproval: false,
        requireApprovalForDiscussions: false,
      },
      monthlyActions: 0,
      lastResetAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const ticketId = await ctx.db.insert("tickets", {
      aiInputVersion: 1,
      repositoryId,
      userId,
      githubRepo: "owner/billing-holds",
      ticketType: "issue",
      githubNumber: 42,
      githubTitle: "Billing holds",
      status: "open",
      createdAt: now,
    });
    const ticketActionId = await ctx.db.insert("ticketActions", {
      ticketId,
      actionType: "answer",
      chatHistory: [],
      proposalVersion: 0,
      status: "pending",
      createdAt: now,
    });
    return { repositoryId, ticketActionId };
  });
}

async function tokenRefundArgs(
  userId: string,
  orderId: string,
  refundedAmountCents = 999,
) {
  const order = await tokenOrderArgs(userId, orderId);
  const orderUpdatedAt = order.orderCreatedAt + 1_000;
  const refundStatus =
    refundedAmountCents === order.amountCents
      ? ("refunded" as const)
      : ("partial_refund" as const);
  return {
    userId: order.userId,
    orderId: order.orderId,
    orderCreatedAt: order.orderCreatedAt,
    orderUpdatedAt,
    customerId: order.customerId,
    variantId: order.variantId,
    quantity: order.quantity,
    amountCents: order.amountCents,
    refundedAmountCents,
    currency: order.currency,
    refundStatus,
    fingerprintKeyAttestation: order.fingerprintKeyAttestation,
    originalSettlementKeyFingerprint: order.settlementKeyFingerprint,
    originalIdentityFingerprint: order.identityFingerprint,
    settlementKeyFingerprint: await createSettlementKeyFingerprint(
      "order_refund",
      `${order.orderId}:${refundedAmountCents}`,
    ),
    identityFingerprint: await createSettlementIdentityFingerprint([
      "order_refund",
      order.userId,
      order.orderId,
      order.orderCreatedAt,
      order.customerId,
      order.variantId,
      order.quantity,
      order.amountCents,
      refundedAmountCents,
      order.currency,
      refundStatus,
    ]),
  };
}

function stateEnvelope(
  eventName:
    | "subscription_created"
    | "subscription_updated"
    | "subscription_cancelled"
    | "subscription_paused"
    | "subscription_expired",
  status: "active" | "cancelled" | "paused" | "past_due" | "unpaid" | "expired",
  attributes: Record<string, unknown> = {},
): WebhookEnvelope {
  return {
    eventName,
    dataId: "3101",
    dataType: "subscriptions",
    storeId: "1001",
    testMode: true,
    attributes: {
      customer_id: 2201,
      variant_id: 9001,
      status,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-02-01T00:00:00.000Z",
      ...attributes,
    },
  };
}

async function signBody(body: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

describe("Lemon Squeezy webhook validation", () => {
  it("uses the invoice resource ID separately from the subscription ID", () => {
    const parsed = parsePaidSubscriptionInvoice({
      eventName: "subscription_payment_success",
      dataId: "7001",
      dataType: "subscription-invoices",
      storeId: "1001",
      testMode: true,
      attributes: {
        subscription_id: 6001,
        customer_id: 2201,
        billing_reason: "renewal",
        status: "paid",
        total: 1_999,
        currency: "usd",
        created_at: "2026-02-01T00:00:00.000Z",
        updated_at: "2026-02-01T00:00:01.000Z",
      },
    });

    expect(parsed.invoiceId).toBe("7001");
    expect(parsed.subscriptionId).toBe("6001");
    expect(parsed.currency).toBe("USD");
  });

  it("revokes every non-active state without trusting renewal retry dates", () => {
    const providerUpdatedAt = Date.parse("2026-02-01T00:00:00.000Z");
    const cases = [
      ["subscription_cancelled", "cancelled", "canceled"],
      ["subscription_paused", "paused", "canceled"],
      ["subscription_updated", "past_due", "canceled"],
      ["subscription_updated", "unpaid", "canceled"],
      ["subscription_expired", "expired", "expired"],
    ] as const;
    for (const [eventName, providerStatus, status] of cases) {
      expect(
        parseSubscriptionState(
          stateEnvelope(eventName, providerStatus, {
            renews_at: "2026-04-01T00:00:00.000Z",
          }),
        ),
      ).toMatchObject({ status, periodEnd: providerUpdatedAt });
    }
    expect(() =>
      parseSubscriptionState(stateEnvelope("subscription_updated", "active")),
    ).toThrow("Subscription has no authoritative period end");
    expect(() =>
      parseSubscriptionState(
        stateEnvelope("subscription_updated", "active", {
          renews_at: "2026-02-01T00:00:00.000Z",
        }),
      ),
    ).toThrow("Active subscription has no future period end");
  });

  it("rejects another store, mode, or missing fingerprint secret", async () => {
    expect(() =>
      assertConfiguredWebhookResource({ storeId: "1001", testMode: true }),
    ).not.toThrow();
    expect(() =>
      assertConfiguredWebhookResource({ storeId: "9999", testMode: true }),
    ).toThrow("another Lemon Squeezy store");
    expect(() =>
      assertConfiguredWebhookResource({ storeId: "1001", testMode: false }),
    ).toThrow("mode does not match deployment");

    const originalSecret = process.env.LS_SETTLEMENT_FINGERPRINT_SECRET_V1;
    delete process.env.LS_SETTLEMENT_FINGERPRINT_SECRET_V1;
    await expect(
      createSettlementIdentityFingerprint(["invoice", "1"]),
    ).rejects.toThrow("LS_SETTLEMENT_FINGERPRINT_SECRET_V1");
    process.env.LS_SETTLEMENT_FINGERPRINT_SECRET_V1 = originalSecret;
  });

  it("fails closed on weak settlement keys or ambiguous product configuration", async () => {
    expect(() => assertLemonSqueezyRuntimeConfiguration()).not.toThrow();
    expect(() => assertConfiguredProductVariants()).not.toThrow();
    expect(resolveConfiguredOrderProductType(PRO_VARIANT_ID)).toBe("pro");
    expect(resolveConfiguredOrderProductType(SMALL_PACK_VARIANT_ID)).toBe(
      "token_pack_small",
    );
    expect(resolveConfiguredOrderProductType(LARGE_PACK_VARIANT_ID)).toBe(
      "token_pack_large",
    );
    expect(() => resolveConfiguredOrderProductType("9999")).toThrow(
      "not configured",
    );

    process.env.LS_SETTLEMENT_FINGERPRINT_SECRET_V1 = "too-short";
    expect(() => assertLemonSqueezyRuntimeConfiguration()).toThrow(
      "at least 32 bytes",
    );
    await expect(
      createSettlementIdentityFingerprint(["invoice", "1"]),
    ).rejects.toThrow("at least 32 bytes");
    process.env.LS_SETTLEMENT_FINGERPRINT_SECRET_V1 =
      "billing-fingerprint-test-secret-v1";

    delete process.env.LS_TOKEN_PACK_SMALL_VARIANT_ID;
    expect(() => assertConfiguredProductVariants()).toThrow(
      "LS_TOKEN_PACK_SMALL_VARIANT_ID",
    );
    process.env.LS_TOKEN_PACK_SMALL_VARIANT_ID = SMALL_PACK_VARIANT_ID;

    process.env.LS_TOKEN_PACK_LARGE_VARIANT_ID = SMALL_PACK_VARIANT_ID;
    expect(() => assertConfiguredProductVariants()).toThrow("must be distinct");
  });

  it("verifies only well-formed HMAC signatures", async () => {
    const body = JSON.stringify({ event: "subscription_created" });
    const secret = "webhook-test-secret";
    const signature = await signBody(body, secret);

    await expect(
      verifyLemonSqueezySignature(signature, body, secret),
    ).resolves.toBe(true);
    await expect(
      verifyLemonSqueezySignature(signature.toUpperCase(), body, secret),
    ).resolves.toBe(true);
    await expect(
      verifyLemonSqueezySignature(signature, `${body}x`, secret),
    ).resolves.toBe(false);
    await expect(
      verifyLemonSqueezySignature("not-hex", body, secret),
    ).resolves.toBe(false);
    await expect(
      verifyLemonSqueezySignature("0".repeat(62), body, secret),
    ).resolves.toBe(false);
  });

  it("validates refund chronology and cumulative amounts", () => {
    const tokenRefundEnvelope: WebhookEnvelope = {
      eventName: "order_refunded",
      userId: "user-1",
      dataId: "8107",
      dataType: "orders",
      storeId: "1001",
      testMode: true,
      attributes: {
        customer_id: 2101,
        status: "refunded",
        total: 999,
        refunded_amount: 999,
        currency: "usd",
        created_at: "2026-01-15T12:00:00.000Z",
        updated_at: "2026-01-15T12:00:01.000Z",
        first_order_item: { variant_id: 9002 },
      },
    };
    expect(
      parseTokenPackOrder({
        ...tokenRefundEnvelope,
        eventName: "order_created",
        attributes: { ...tokenRefundEnvelope.attributes, status: "paid" },
      }),
    ).toMatchObject({ orderId: "8107", quantity: 1 });
    expect(parseTokenPackRefund(tokenRefundEnvelope)).toMatchObject({
      orderId: "8107",
      quantity: 1,
      refundedAmountCents: 999,
      refundStatus: "refunded",
    });
    expect(() =>
      parseTokenPackOrder({
        ...tokenRefundEnvelope,
        eventName: "order_created",
        attributes: {
          ...tokenRefundEnvelope.attributes,
          status: "paid",
          first_order_item: { variant_id: 9002, quantity: 2 },
        },
      }),
    ).toThrow("exactly one item");
    expect(() =>
      parseTokenPackRefund({
        ...tokenRefundEnvelope,
        attributes: {
          ...tokenRefundEnvelope.attributes,
          first_order_item: { variant_id: 9002, quantity: 2 },
        },
      }),
    ).toThrow("exactly one item");
    expect(() =>
      parseTokenPackRefund({
        ...tokenRefundEnvelope,
        attributes: {
          ...tokenRefundEnvelope.attributes,
          refunded_amount: 1_000,
        },
      }),
    ).toThrow("exceeds order total");

    const invoiceRefundEnvelope: WebhookEnvelope = {
      eventName: "subscription_payment_refunded",
      dataId: "7106",
      dataType: "subscription-invoices",
      storeId: "1001",
      testMode: true,
      attributes: {
        subscription_id: 4201,
        customer_id: 2201,
        billing_reason: "renewal",
        status: "partial_refund",
        total: 1_999,
        refunded_amount: 500,
        currency: "usd",
        created_at: "2026-02-01T00:00:00.000Z",
        updated_at: "2026-02-01T00:00:01.000Z",
      },
    };
    expect(parseSubscriptionInvoiceRefund(invoiceRefundEnvelope)).toMatchObject(
      {
        invoiceId: "7106",
        refundedAmountCents: 500,
        refundStatus: "partial_refund",
      },
    );
    expect(() =>
      parseSubscriptionInvoiceRefund({
        ...invoiceRefundEnvelope,
        attributes: {
          ...invoiceRefundEnvelope.attributes,
          updated_at: "2026-01-31T23:59:59.000Z",
        },
      }),
    ).toThrow("predates invoice creation");
  });
});

describe("atomic token-pack settlement", () => {
  it("rejects a replay after the settlement fingerprint key rotates", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const originalArgs = await tokenOrderArgs(userId, "8188");
    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.fulfillTokenPackOrder,
        originalArgs,
      ),
    ).resolves.toMatchObject({ outcome: "applied" });

    process.env.LS_SETTLEMENT_FINGERPRINT_SECRET_V1 =
      "rotated-billing-fingerprint-test-secret-v2";
    const rotatedArgs = await tokenOrderArgs(userId, "8188");
    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.fulfillTokenPackOrder,
        rotatedArgs,
      ),
    ).rejects.toThrow("attestation mismatch");

    const state = await t.run(async (ctx) => ({
      subscriptions: await ctx.db
        .query("subscriptions")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(2),
      logs: await ctx.db.query("paymentLogs").withIndex("by_created").take(2),
      receipts: await ctx.db.query("paymentSettlementReceipts").take(2),
      configuration: await ctx.db
        .query("paymentSettlementConfiguration")
        .withIndex("by_key", (q) => q.eq("key", "global"))
        .first(),
    }));
    expect(state.subscriptions).toHaveLength(1);
    expect(state.subscriptions[0]?.purchasedTokens).toBe(SMALL_PACK_TOKENS);
    expect(state.logs).toHaveLength(1);
    expect(state.receipts).toHaveLength(1);
    expect(state.configuration?.fingerprintKeyAttestation).toBe(
      originalArgs.fingerprintKeyAttestation,
    );
  });

  it("rejects a token-pack settlement with an explicit non-unit quantity", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.fulfillTokenPackOrder,
        { ...(await tokenOrderArgs(userId, "8199")), quantity: 2 },
      ),
    ).rejects.toThrow("Invalid token-pack quantity");
    await expect(
      t.run(async (ctx) =>
        ctx.db
          .query("subscriptions")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .take(1),
      ),
    ).resolves.toEqual([]);
  });

  it("credits concurrent duplicate orders only once", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const args = await tokenOrderArgs(userId);

    const results = await Promise.all([
      t.mutation(
        internal.subscriptions.internalMutation.fulfillTokenPackOrder,
        args,
      ),
      t.mutation(
        internal.subscriptions.internalMutation.fulfillTokenPackOrder,
        args,
      ),
    ]);

    expect(results.map((result) => result.outcome).sort()).toEqual([
      "applied",
      "duplicate",
    ]);
    const state = await t.run(async (ctx) => ({
      subscriptions: await ctx.db
        .query("subscriptions")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(2),
      logs: await ctx.db.query("paymentLogs").withIndex("by_created").take(2),
      receipts: await ctx.db
        .query("paymentSettlementReceipts")
        .withIndex("by_settlement_key_fingerprint", (q) =>
          q.eq("settlementKeyFingerprint", args.settlementKeyFingerprint),
        )
        .take(2),
      summaries: await ctx.db
        .query("paymentStatsSummary")
        .withIndex("by_key", (q) => q.eq("key", "global"))
        .take(2),
    }));

    expect(state.subscriptions).toHaveLength(1);
    expect(state.subscriptions[0]?.purchasedTokens).toBe(SMALL_PACK_TOKENS);
    expect(state.logs).toHaveLength(1);
    expect(state.logs[0]).toMatchObject({
      status: "success",
      tokensAdded: SMALL_PACK_TOKENS,
    });
    expect(state.receipts).toHaveLength(1);
    expect(state.receipts[0]).toMatchObject({
      settlementKeyFingerprint: args.settlementKeyFingerprint,
      settlementType: "order",
      identityFingerprint: args.identityFingerprint,
    });
    expect(state.receipts[0]).not.toHaveProperty("settlementKey");
    expect(state.summaries[0]).toMatchObject({
      totalOrders: 1,
      totalRevenueCents: 999,
      totalTokensSold: SMALL_PACK_TOKENS,
      tokenPackSmallCount: 1,
    });
  });

  it("rolls back every side effect and succeeds on retry", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const insertedUserId = await ctx.db.insert("users", {});
      for (let index = 0; index < 2; index++) {
        await ctx.db.insert("paymentStatsSummary", {
          key: "global",
          totalRevenueCents: 0,
          totalTokensSold: 0,
          totalOrders: 0,
          proSubscriptionCount: 0,
          tokenPackSmallCount: 0,
          tokenPackLargeCount: 0,
          totalRefundedCents: 0,
          totalRefundedTokens: 0,
          updatedAt: index + 1,
        });
      }
      return insertedUserId;
    });
    const args = await tokenOrderArgs(userId, "8102");

    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.fulfillTokenPackOrder,
        args,
      ),
    ).rejects.toThrow("Duplicate global payment summaries");
    const rolledBack = await t.run(async (ctx) => ({
      subscriptions: await ctx.db
        .query("subscriptions")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(1),
      logs: await ctx.db.query("paymentLogs").withIndex("by_created").take(1),
      receipts: await ctx.db
        .query("paymentSettlementReceipts")
        .withIndex("by_settlement_key_fingerprint", (q) =>
          q.eq("settlementKeyFingerprint", args.settlementKeyFingerprint),
        )
        .take(1),
    }));
    expect(rolledBack).toEqual({ subscriptions: [], logs: [], receipts: [] });

    await t.run(async (ctx) => {
      const summaries = await ctx.db
        .query("paymentStatsSummary")
        .withIndex("by_key", (q) => q.eq("key", "global"))
        .take(2);
      if (summaries[1]) await ctx.db.delete(summaries[1]._id);
    });
    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.fulfillTokenPackOrder,
        args,
      ),
    ).resolves.toMatchObject({ outcome: "applied" });
  });

  it("retains a hashed tombstone after log deletion and rejects mismatched replay", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const args = await tokenOrderArgs(userId, "8103");

    await t.mutation(
      internal.subscriptions.internalMutation.fulfillTokenPackOrder,
      args,
    );
    await t.run(async (ctx) => {
      const logs = await ctx.db
        .query("paymentLogs")
        .withIndex("by_created")
        .take(10);
      for (const log of logs) await ctx.db.delete(log._id);
    });

    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.fulfillTokenPackOrder,
        args,
      ),
    ).resolves.toMatchObject({ outcome: "duplicate" });
    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.fulfillTokenPackOrder,
        { ...args, identityFingerprint: "f".repeat(64) },
      ),
    ).rejects.toThrow("Token-pack order replay does not match settlement");

    const state = await t.run(async (ctx) => ({
      subscription: await ctx.db
        .query("subscriptions")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .first(),
      receipt: await ctx.db
        .query("paymentSettlementReceipts")
        .withIndex("by_settlement_key_fingerprint", (q) =>
          q.eq("settlementKeyFingerprint", args.settlementKeyFingerprint),
        )
        .unique(),
    }));
    expect(state.subscription?.purchasedTokens).toBe(SMALL_PACK_TOKENS);
    expect(state.receipt?.settlementKeyFingerprint).toBe(
      await createSettlementKeyFingerprint("order", args.orderId),
    );
    expect(Object.keys(state.receipt ?? {}).sort()).toEqual([
      "_creationTime",
      "_id",
      "createdAt",
      "fingerprintVersion",
      "identityFingerprint",
      "settlementKeyFingerprint",
      "settlementType",
    ]);

    await t.run(async (ctx) => {
      if (state.subscription) await ctx.db.delete(state.subscription._id);
      await ctx.db.delete(userId);
    });
    process.env.LS_TOKEN_PACK_SMALL_VARIANT_ID = "9999";
    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.fulfillTokenPackOrder,
        args,
      ),
    ).resolves.toMatchObject({ outcome: "duplicate" });
  });

  it("rolls back when the canonical wallet would exceed a safe integer", async () => {
    const t = convexTest(schema, modules);
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    const originalBalance = Number.MAX_SAFE_INTEGER - SMALL_PACK_TOKENS + 1;
    const userId = await t.run(async (ctx) => {
      const insertedUserId = await ctx.db.insert("users", {});
      await ctx.db.insert("subscriptions", {
        userId: insertedUserId,
        plan: "free",
        status: "active",
        includedTokens: 100_000,
        purchasedTokens: originalBalance,
        serviceFeeRate: 0.25,
        periodStart: now,
        periodEnd: Date.parse("2026-02-01T00:00:00.000Z"),
        createdAt: now,
        updatedAt: now,
      });
      return insertedUserId;
    });
    const args = await tokenOrderArgs(userId, "8106");

    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.fulfillTokenPackOrder,
        args,
      ),
    ).rejects.toThrow("Purchased token balance exceeds the supported range");
    const state = await t.run(async (ctx) => ({
      subscription: await ctx.db
        .query("subscriptions")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .unique(),
      receipts: await ctx.db
        .query("paymentSettlementReceipts")
        .withIndex("by_settlement_key_fingerprint", (q) =>
          q.eq("settlementKeyFingerprint", args.settlementKeyFingerprint),
        )
        .take(1),
    }));
    expect(state.subscription?.purchasedTokens).toBe(originalBalance);
    expect(state.receipts).toEqual([]);
  });
});

describe("refund settlement", () => {
  it("claws back a full unused token pack exactly once", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const order = await tokenOrderArgs(userId, "8110");
    const refund = await tokenRefundArgs(userId, order.orderId);

    await t.mutation(
      internal.subscriptions.internalMutation.fulfillTokenPackOrder,
      order,
    );
    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.processTokenPackRefund,
        refund,
      ),
    ).resolves.toMatchObject({
      outcome: "applied",
      tokensClawedBack: SMALL_PACK_TOKENS,
    });
    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.processTokenPackRefund,
        refund,
      ),
    ).resolves.toMatchObject({ outcome: "duplicate" });

    const state = await t.run(async (ctx) => ({
      subscription: await ctx.db
        .query("subscriptions")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .unique(),
      refundReceipts: await ctx.db
        .query("paymentSettlementReceipts")
        .withIndex("by_settlement_key_fingerprint", (q) =>
          q.eq("settlementKeyFingerprint", refund.settlementKeyFingerprint),
        )
        .take(2),
      refundLogs: await ctx.db
        .query("paymentLogs")
        .withIndex("by_order_event_status", (q) =>
          q
            .eq("lemonSqueezyOrderId", order.orderId)
            .eq("eventType", "order_refunded")
            .eq("status", "refunded"),
        )
        .take(2),
      summary: await ctx.db
        .query("paymentStatsSummary")
        .withIndex("by_key", (q) => q.eq("key", "global"))
        .unique(),
    }));
    expect(state.subscription?.purchasedTokens).toBe(0);
    expect(state.refundReceipts).toHaveLength(1);
    expect(state.refundReceipts[0]).toMatchObject({
      settlementType: "order_refund",
      fingerprintVersion: 1,
    });
    expect(state.refundLogs).toHaveLength(1);
    expect(state.refundLogs[0]).toMatchObject({
      amountCents: 999,
      tokensAdded: -SMALL_PACK_TOKENS,
    });
    expect(state.summary).toMatchObject({
      totalOrders: 1,
      totalRevenueCents: 999,
      totalRefundedCents: 999,
      totalRefundedTokens: SMALL_PACK_TOKENS,
    });
  });

  it.each(["user", "customer", "variant", "amount", "currency"] as const)(
    "routes an exact-original %s identity mismatch to durable review",
    async (field) => {
      const t = convexTest(schema, modules);
      const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
      const otherUserId = await t.run(async (ctx) =>
        ctx.db.insert("users", {}),
      );
      const order = await tokenOrderArgs(userId, `812${field.length}`);
      await t.mutation(
        internal.subscriptions.internalMutation.fulfillTokenPackOrder,
        order,
      );
      const base = await tokenRefundArgs(userId, order.orderId);
      const refund = {
        ...base,
        ...(field === "user" ? { userId: otherUserId } : {}),
        ...(field === "customer" ? { customerId: "2999" } : {}),
        ...(field === "variant" ? { variantId: LARGE_PACK_VARIANT_ID } : {}),
        ...(field === "amount" ? { amountCents: 1_000 } : {}),
        ...(field === "currency" ? { currency: "KRW" } : {}),
      };
      refund.originalIdentityFingerprint =
        await createSettlementIdentityFingerprint([
          "order",
          refund.userId,
          refund.orderId,
          refund.orderCreatedAt,
          refund.customerId,
          refund.variantId,
          refund.quantity,
          refund.amountCents,
          refund.currency,
        ]);
      refund.identityFingerprint = await createSettlementIdentityFingerprint([
        "order_refund",
        refund.userId,
        refund.orderId,
        refund.orderCreatedAt,
        refund.customerId,
        refund.variantId,
        refund.quantity,
        refund.amountCents,
        refund.refundedAmountCents,
        refund.currency,
        refund.refundStatus,
      ]);

      await expect(
        t.mutation(
          internal.subscriptions.internalMutation.processTokenPackRefund,
          refund,
        ),
      ).resolves.toEqual({ outcome: "manual_review" });
      const state = await t.run(async (ctx) => ({
        wallet: await ctx.db
          .query("subscriptions")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .unique(),
        reviews: await ctx.db
          .query("paymentSettlementManualReviews")
          .withIndex("by_status_and_expiration", (q) => q.eq("status", "open"))
          .collect(),
        receipt: await ctx.db
          .query("paymentSettlementReceipts")
          .withIndex("by_settlement_key_fingerprint", (q) =>
            q.eq("settlementKeyFingerprint", refund.settlementKeyFingerprint),
          )
          .unique(),
      }));
      expect(state.wallet?.purchasedTokens).toBe(SMALL_PACK_TOKENS);
      expect(state.reviews).toHaveLength(1);
      expect(state.reviews[0]?.reason).toContain("identity");
      expect(state.receipt).toBeNull();
    },
  );

  it("settles an ended Pro overage before exposing the wallet to a refund", async () => {
    vi.useFakeTimers();
    const periodStart = Date.parse("2026-01-01T00:00:00.000Z");
    const periodEnd = Date.parse("2026-01-25T00:00:00.000Z");
    vi.setSystemTime(Date.parse("2026-01-20T00:00:00.000Z"));
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const order = await tokenOrderArgs(userId, "8180");
    await t.mutation(
      internal.subscriptions.internalMutation.fulfillTokenPackOrder,
      order,
    );
    const subscriptionId = await t.run(async (ctx) => {
      const subscription = await ctx.db
        .query("subscriptions")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .unique();
      if (!subscription) throw new Error("wallet missing");
      await ctx.db.patch(subscription._id, {
        plan: "pro",
        status: "active",
        proEntitlementProvenance: {
          source: "lemon_squeezy_webhook",
          verifiedAt: periodStart,
        },
        includedTokens: PRO_INCLUDED_TOKENS,
        serviceFeeRate: 0.18,
        purchasedTokens: SMALL_PACK_TOKENS + 40,
        periodStart,
        periodEnd,
      });
      await ctx.db.insert("subscriptionBillingBoundaries", {
        subscriptionId: subscription._id,
        periodStart,
        periodEnd,
        providerUpdatedAt: periodEnd,
        status: "pending",
        createdAt: periodStart,
        updatedAt: periodEnd,
      });
      await ctx.db.insert("tokenUsage", {
        purchasedTokensDebited: 0,
        userId,
        usageType: "chat",
        inputTokens: PRO_INCLUDED_TOKENS + 40,
        outputTokens: 0,
        totalTokens: PRO_INCLUDED_TOKENS + 40,
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
      return subscription._id;
    });
    vi.setSystemTime(periodEnd + 1);
    const refund = await tokenRefundArgs(userId, order.orderId);

    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.processTokenPackRefund,
        refund,
      ),
    ).resolves.toMatchObject({
      outcome: "applied",
      tokensClawedBack: SMALL_PACK_TOKENS,
    });
    const state = await t.run(async (ctx) => ({
      subscription: await ctx.db.get(subscriptionId),
      boundary: await ctx.db
        .query("subscriptionBillingBoundaries")
        .withIndex("by_subscription_and_period_end", (q) =>
          q.eq("subscriptionId", subscriptionId).eq("periodEnd", periodEnd),
        )
        .unique(),
    }));
    expect(state.subscription?.purchasedTokens).toBe(0);
    expect(state.boundary).toMatchObject({
      status: "settled",
      settlementReason: "terminal_entitlement",
      purchasedTokensDebited: 40,
    });
  });

  it("keeps a current Pro overage out of automatic token-pack refunds", async () => {
    vi.useFakeTimers();
    const periodStart = Date.parse("2026-01-01T00:00:00.000Z");
    const now = Date.parse("2026-01-20T00:00:00.000Z");
    const periodEnd = Date.parse("2026-02-01T00:00:00.000Z");
    vi.setSystemTime(now);
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const order = await tokenOrderArgs(userId, "8182");
    await t.mutation(
      internal.subscriptions.internalMutation.fulfillTokenPackOrder,
      order,
    );
    const subscriptionId = await t.run(async (ctx) => {
      const subscription = await ctx.db
        .query("subscriptions")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .unique();
      if (!subscription) throw new Error("wallet missing");
      await ctx.db.patch(subscription._id, {
        plan: "pro",
        status: "active",
        proEntitlementProvenance: {
          source: "lemon_squeezy_webhook",
          verifiedAt: periodStart,
        },
        includedTokens: PRO_INCLUDED_TOKENS,
        serviceFeeRate: 0.18,
        periodStart,
        periodEnd,
      });
      await ctx.db.insert("subscriptionBillingBoundaries", {
        subscriptionId: subscription._id,
        periodStart,
        periodEnd,
        providerUpdatedAt: periodStart,
        status: "pending",
        createdAt: periodStart,
        updatedAt: periodStart,
      });
      return subscription._id;
    });
    await t.mutation(internal.tokenUsage.internalMutation.recordUsage, {
      userId,
      inputTokens: PRO_INCLUDED_TOKENS + 40,
      outputTokens: 0,
      model: "claude-sonnet-5-5",
      provider: "anthropic",
    });
    const refund = await tokenRefundArgs(userId, order.orderId);

    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.processTokenPackRefund,
        refund,
      ),
    ).resolves.toEqual({ outcome: "manual_review" });
    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.processTokenPackRefund,
        refund,
      ),
    ).resolves.toEqual({ outcome: "manual_review" });

    const state = await t.run(async (ctx) => ({
      subscription: await ctx.db.get(subscriptionId),
      boundary: await ctx.db
        .query("subscriptionBillingBoundaries")
        .withIndex("by_subscription_and_period_end", (q) =>
          q.eq("subscriptionId", subscriptionId).eq("periodEnd", periodEnd),
        )
        .unique(),
      review: await ctx.db
        .query("paymentSettlementManualReviews")
        .withIndex("by_settlement_key_fingerprint", (q) =>
          q.eq("settlementKeyFingerprint", refund.settlementKeyFingerprint),
        )
        .unique(),
      receipt: await ctx.db
        .query("paymentSettlementReceipts")
        .withIndex("by_settlement_key_fingerprint", (q) =>
          q.eq("settlementKeyFingerprint", refund.settlementKeyFingerprint),
        )
        .unique(),
      refundLogs: await ctx.db
        .query("paymentLogs")
        .withIndex("by_order_event_status", (q) =>
          q
            .eq("lemonSqueezyOrderId", order.orderId)
            .eq("eventType", "order_refunded")
            .eq("status", "refunded"),
        )
        .collect(),
    }));
    expect(state.subscription?.purchasedTokens).toBe(SMALL_PACK_TOKENS);
    expect(state.boundary).toMatchObject({ status: "pending" });
    expect(state.review?.reason).toContain("exact billing boundary");
    expect(state.receipt).toBeNull();
    expect(state.refundLogs).toEqual([]);
  });

  it("still refunds an unused pack during a verified current Pro period", async () => {
    vi.useFakeTimers();
    const periodStart = Date.parse("2026-01-01T00:00:00.000Z");
    const periodEnd = Date.parse("2026-02-01T00:00:00.000Z");
    vi.setSystemTime(Date.parse("2026-01-20T00:00:00.000Z"));
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const order = await tokenOrderArgs(userId, "8183");
    await t.mutation(
      internal.subscriptions.internalMutation.fulfillTokenPackOrder,
      order,
    );
    await t.run(async (ctx) => {
      const subscription = await ctx.db
        .query("subscriptions")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .unique();
      if (!subscription) throw new Error("wallet missing");
      await ctx.db.patch(subscription._id, {
        plan: "pro",
        status: "active",
        proEntitlementProvenance: {
          source: "lemon_squeezy_webhook",
          verifiedAt: periodStart,
        },
        includedTokens: PRO_INCLUDED_TOKENS,
        serviceFeeRate: 0.18,
        periodStart,
        periodEnd,
      });
    });
    const refund = await tokenRefundArgs(userId, order.orderId);

    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.processTokenPackRefund,
        refund,
      ),
    ).resolves.toMatchObject({
      outcome: "applied",
      tokensClawedBack: SMALL_PACK_TOKENS,
    });
    const subscription = await t.run(async (ctx) =>
      ctx.db
        .query("subscriptions")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .unique(),
    );
    expect(subscription?.purchasedTokens).toBe(0);
  });

  it.each(["pending", "ambiguous"] as const)(
    "keeps a %s provider reservation ahead of refund clawback",
    async (status) => {
      const t = convexTest(schema, modules);
      const now = Date.now();
      const userId = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", {});
        // The trial is already used, so the refund sees only paid tokens.
        await ctx.db.insert("trialCreditGrants", {
          userId,
          tokens: 100_000,
          grantedAt: 1,
        });
        return userId;
      });
      const order = await tokenOrderArgs(
        userId,
        status === "pending" ? "8184" : "8185",
      );
      await t.mutation(
        internal.subscriptions.internalMutation.fulfillTokenPackOrder,
        order,
      );
      await t.run(async (ctx) => {
        const repositoryId = await ctx.db.insert("repositories", {
          indexSyncPending: false,
          indexVersion: 1,
          indexStatus: "completed",
          indexProgressAt: Date.now(),
          ragStatus: "completed",
          ragTotalChunks: 0,
          ragIndexedChunks: 0,
          ragFailedChunks: 0,
          userId,
          installationId: 1,
          githubRepositoryId: 1,
          githubRepo: "owner/repo",
          githubRepoKey: "owner/repo",
          name: "repo",
          githubUrl: "https://github.com/owner/repo",
          isActive: true,
          settings: {
            issueAssistantEnabled: false,
            autoFormatIssue: false,
            autoAnswerQuestions: false,
            tagMaintainersForCodeChanges: false,
            discussionAssistantEnabled: false,
            autoFormatDiscussion: false,
            autoAnswerDiscussionQuestions: false,
            tagMaintainersForDiscussionCodeChanges: false,
            requireApproval: true,
            requireApprovalForDiscussions: true,
          },
          monthlyActions: 0,
          lastResetAt: now,
          createdAt: now,
          updatedAt: now,
        });
        const ticketId = await ctx.db.insert("tickets", {
          repositoryId,
          userId,
          githubRepo: "owner/repo",
          ticketType: "issue",
          githubNumber: 1,
          githubTitle: "Issue",
          aiInputVersion: 1,
          status: "open",
          createdAt: now,
        });
        const ticketActionId = await ctx.db.insert("ticketActions", {
          ticketId,
          actionType: "answer",
          chatHistory: [],
          proposalVersion: 0,
          status: "pending",
          createdAt: now,
        });
        await ctx.db.insert("chatUsageReservations", {
          reservationKey: `refund-${status}`,
          attemptToken: `attempt-${status}`,
          userId,
          repositoryId,
          ticketActionId,
          requirePendingTicketAction: true,
          ticketActionProposalVersion: 0,
          generationKey: `refund-generation-${status}`,
          operation: "answer",
          model: "claude-sonnet-5-5",
          provider: "anthropic",
          requestFingerprint: "0".repeat(64),
          inputTokenLimit: 1,
          outputTokenLimit: 1,
          reservedTokens: 2,
          entitlementPlan: "free",
          includedTokens: 100_000,
          serviceFeeRate: 0.25,
          quotaPeriodStart: now - 1_000,
          quotaPeriodEnd: now + 60_000,
          status,
          ...(status !== "pending"
            ? {
                providerStartedAt: now,
                releaseReason: "ambiguous_provider_attempt",
              }
            : {}),
          expiresAt: now + 60_000,
          createdAt: now,
          updatedAt: now,
        });
      });
      const refund = await tokenRefundArgs(userId, order.orderId);

      await expect(
        t.mutation(
          internal.subscriptions.internalMutation.processTokenPackRefund,
          refund,
        ),
      ).resolves.toEqual({ outcome: "manual_review" });
      const state = await t.run(async (ctx) => ({
        subscription: await ctx.db
          .query("subscriptions")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .unique(),
        review: await ctx.db
          .query("paymentSettlementManualReviews")
          .withIndex("by_settlement_key_fingerprint", (q) =>
            q.eq("settlementKeyFingerprint", refund.settlementKeyFingerprint),
          )
          .unique(),
        receipt: await ctx.db
          .query("paymentSettlementReceipts")
          .withIndex("by_settlement_key_fingerprint", (q) =>
            q.eq("settlementKeyFingerprint", refund.settlementKeyFingerprint),
          )
          .unique(),
        reservation: await ctx.db
          .query("chatUsageReservations")
          .withIndex("by_reservation_key", (q) =>
            q.eq("reservationKey", `refund-${status}`),
          )
          .unique(),
      }));
      expect(state.subscription?.purchasedTokens).toBe(SMALL_PACK_TOKENS);
      expect(state.review?.reason).toContain("provider usage");
      expect(state.receipt).toBeNull();
      expect(state.reservation?.status).toBe(status);
    },
  );

  it("routes partial or fully consumed token-pack refunds to durable review", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const partialOrder = await tokenOrderArgs(userId, "8111");
    const consumedOrder = await tokenOrderArgs(userId, "8112");
    await t.mutation(
      internal.subscriptions.internalMutation.fulfillTokenPackOrder,
      partialOrder,
    );
    await t.mutation(
      internal.subscriptions.internalMutation.fulfillTokenPackOrder,
      consumedOrder,
    );

    const partialRefund = await tokenRefundArgs(userId, "8111", 500);
    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.processTokenPackRefund,
        partialRefund,
      ),
    ).resolves.toMatchObject({ outcome: "manual_review" });
    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.processTokenPackRefund,
        partialRefund,
      ),
    ).resolves.toMatchObject({ outcome: "manual_review" });

    const subscription = await t.run(async (ctx) =>
      ctx.db
        .query("subscriptions")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .unique(),
    );
    if (!subscription) throw new Error("Expected token wallet");
    await t.mutation(internal.tokenUsage.internalMutation.recordUsage, {
      userId,
      inputTokens: 100_000 + SMALL_PACK_TOKENS + 1,
      outputTokens: 0,
      model: "claude-sonnet-5-5",
      provider: "anthropic",
    });
    const consumedRefund = await tokenRefundArgs(userId, "8112");
    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.processTokenPackRefund,
        consumedRefund,
      ),
    ).resolves.toMatchObject({ outcome: "manual_review" });

    const state = await t.run(async (ctx) => ({
      subscription: await ctx.db.get(subscription._id),
      reviews: await ctx.db
        .query("paymentSettlementManualReviews")
        .withIndex("by_status_and_expiration", (q) => q.eq("status", "open"))
        .collect(),
      refundLogs: await ctx.db
        .query("paymentLogs")
        .withIndex("by_order_event_status", (q) =>
          q.eq("lemonSqueezyOrderId", "8112").eq("eventType", "order_refunded"),
        )
        .collect(),
      usage: await ctx.db
        .query("tokenUsage")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .unique(),
    }));
    expect(state.subscription?.purchasedTokens).toBe(SMALL_PACK_TOKENS - 1);
    expect(state.usage?.purchasedTokensDebited).toBe(SMALL_PACK_TOKENS + 1);
    expect(state.reviews).toHaveLength(2);
    expect(state.reviews.every((review) => review.expiresAt > Date.now())).toBe(
      true,
    );
    expect(state.refundLogs).toEqual([]);
  });

  it("records subscription refunds for review without changing entitlement", async () => {
    const t = convexTest(schema, modules);
    const now = Date.parse("2026-02-01T00:00:00.000Z");
    const { userId, subscriptionId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const subscriptionId = await ctx.db.insert("subscriptions", {
        userId,
        lemonSqueezySubscriptionId: "4501",
        lemonSqueezyCustomerId: "2201",
        lemonSqueezyVariantId: PRO_VARIANT_ID,
        providerCreatedAt: Date.parse("2026-01-01T00:00:00.000Z"),
        providerUpdatedAt: now,
        proEntitlementProvenance: {
          source: "lemon_squeezy_webhook",
          verifiedAt: now,
        },
        plan: "pro",
        status: "active",
        includedTokens: PRO_INCLUDED_TOKENS,
        purchasedTokens: 123,
        serviceFeeRate: 0.18,
        periodStart: Date.parse("2026-01-01T00:00:00.000Z"),
        periodEnd: Date.parse("2026-03-01T00:00:00.000Z"),
        createdAt: now,
        updatedAt: now,
      });
      return { userId, subscriptionId };
    });
    const refundedAmountCents = 1_999;
    const settlementKeyFingerprint = await createSettlementKeyFingerprint(
      "invoice_refund",
      `7107:${refundedAmountCents}`,
    );
    const identityFingerprint = await createSettlementIdentityFingerprint([
      "invoice_refund",
      "7107",
      "4501",
      "2201",
      "renewal",
      now,
      1_999,
      refundedAmountCents,
      "USD",
      "refunded",
    ]);
    const args = {
      invoiceId: "7107",
      subscriptionId: "4501",
      customerId: "2201",
      billingReason: "renewal" as const,
      invoiceCreatedAt: now,
      invoiceUpdatedAt: now,
      amountCents: 1_999,
      refundedAmountCents,
      currency: "USD",
      refundStatus: "refunded" as const,
      fingerprintKeyAttestation:
        await createSettlementFingerprintKeyAttestation(),
      settlementKeyFingerprint,
      identityFingerprint,
    };

    await expect(
      t.mutation(
        internal.subscriptions.internalMutation
          .recordSubscriptionInvoiceRefundManualReview,
        args,
      ),
    ).resolves.toMatchObject({ outcome: "manual_review" });
    await expect(
      t.mutation(
        internal.subscriptions.internalMutation
          .recordSubscriptionInvoiceRefundManualReview,
        args,
      ),
    ).resolves.toMatchObject({ outcome: "manual_review" });

    const state = await t.run(async (ctx) => ({
      subscription: await ctx.db.get(subscriptionId),
      reviews: await ctx.db
        .query("paymentSettlementManualReviews")
        .withIndex("by_settlement_key_fingerprint", (q) =>
          q.eq("settlementKeyFingerprint", settlementKeyFingerprint),
        )
        .take(2),
      receipts: await ctx.db
        .query("paymentSettlementReceipts")
        .withIndex("by_settlement_key_fingerprint", (q) =>
          q.eq("settlementKeyFingerprint", settlementKeyFingerprint),
        )
        .take(1),
    }));
    expect(state.subscription).toMatchObject({
      userId,
      status: "active",
      purchasedTokens: 123,
    });
    expect(state.reviews).toHaveLength(1);
    expect(state.reviews[0]).toMatchObject({
      reviewType: "invoice_refund",
      providerResourceId: "7107",
      status: "open",
    });
    expect(state.receipts).toEqual([]);

    const mismatchedCustomerId = "9999";
    const mismatchSettlementKey = await createSettlementKeyFingerprint(
      "invoice_refund",
      `7108:${refundedAmountCents}`,
    );
    const mismatchIdentity = await createSettlementIdentityFingerprint([
      "invoice_refund",
      "7108",
      "4501",
      mismatchedCustomerId,
      "renewal",
      now,
      1_999,
      refundedAmountCents,
      "USD",
      "refunded",
    ]);
    await expect(
      t.mutation(
        internal.subscriptions.internalMutation
          .recordSubscriptionInvoiceRefundManualReview,
        {
          ...args,
          invoiceId: "7108",
          customerId: mismatchedCustomerId,
          settlementKeyFingerprint: mismatchSettlementKey,
          identityFingerprint: mismatchIdentity,
        },
      ),
    ).resolves.toMatchObject({ outcome: "manual_review" });

    const mismatchState = await t.run(async (ctx) => ({
      subscription: await ctx.db.get(subscriptionId),
      review: await ctx.db
        .query("paymentSettlementManualReviews")
        .withIndex("by_settlement_key_fingerprint", (q) =>
          q.eq("settlementKeyFingerprint", mismatchSettlementKey),
        )
        .unique(),
    }));
    expect(mismatchState.subscription).toMatchObject({
      status: "active",
      purchasedTokens: 123,
    });
    expect(mismatchState.review).toMatchObject({
      reviewType: "invoice_refund",
      reason: "Subscription refund customer binding requires operator review.",
      userId,
      status: "open",
    });
  });
});

describe("authoritative subscription and invoice settlement", () => {
  it("persists an invoice before ACK and completes it through the durable worker", async () => {
    vi.useFakeTimers();
    const providerCreatedAt = Date.parse("2100-01-01T00:00:00.000Z");
    const invoiceCreatedAt = Date.parse("2100-02-01T00:00:00.000Z");
    vi.setSystemTime(invoiceCreatedAt);
    const t = convexTest(schema, modules);
    await pinSettlementConfiguration(t, providerCreatedAt);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await t.mutation(
      internal.subscriptions.internalMutation.syncLemonSqueezySubscription,
      {
        eventName: "subscription_created",
        userId,
        lemonSqueezySubscriptionId: "4051",
        lemonSqueezyCustomerId: "2201",
        lemonSqueezyVariantId: PRO_VARIANT_ID,
        status: "active",
        providerCreatedAt,
        providerUpdatedAt: providerCreatedAt,
        periodEnd: invoiceCreatedAt,
      },
    );
    const { invoiceStatus: _invoiceStatus, ...invoice } = await invoiceArgs(
      "4051",
      "7051",
      invoiceCreatedAt,
    );
    void _invoiceStatus;
    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.enqueueSubscriptionInvoice,
        invoice,
      ),
    ).resolves.toMatchObject({ outcome: "queued" });

    const inbox = await t.run(async (ctx) =>
      ctx.db
        .query("lemonSqueezyInvoiceInbox")
        .withIndex("by_settlement_key_fingerprint", (q) =>
          q.eq("settlementKeyFingerprint", invoice.settlementKeyFingerprint),
        )
        .unique(),
    );
    expect(inbox).toMatchObject({
      invoiceId: "7051",
      status: "pending",
      attemptCount: 0,
      fingerprintVersion: 1,
    });
    if (!inbox) throw new Error("Expected durable invoice inbox row");

    await t.finishAllScheduledFunctions(() => vi.advanceTimersToNextTimer());
    const settled = await t.run(async (ctx) => ({
      inbox: await ctx.db.get(inbox._id),
      receipt: await ctx.db
        .query("paymentSettlementReceipts")
        .withIndex("by_settlement_key_fingerprint", (q) =>
          q.eq("settlementKeyFingerprint", invoice.settlementKeyFingerprint),
        )
        .unique(),
    }));
    expect(settled.inbox).toBeNull();
    expect(settled.receipt).toMatchObject({ settlementType: "invoice" });
    await expect(
      t.action(internal.lemonSqueezy.webhook.processSubscriptionInvoiceInbox, {
        inboxId: inbox._id,
      }),
    ).resolves.toMatchObject({ outcome: "ignored" });
  });

  it("keeps one durable review across terminal invoice retry cycles", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const now = Date.now();
    const invoice = await invoiceArgs(
      "4054",
      "7054",
      Date.parse("2100-02-01T00:00:00.000Z"),
    );
    const { adminUserId, inboxId } = await t.run(async (ctx) => {
      const adminUserId = await ctx.db.insert("users", {});
      await ctx.db.insert("userProfiles", {
        userId: adminUserId,
        githubUsername: "invoice-admin",
        isAdmin: true,
        createdAt: now,
        updatedAt: now,
      });
      const inboxId = await ctx.db.insert("lemonSqueezyInvoiceInbox", {
        settlementKeyFingerprint: invoice.settlementKeyFingerprint,
        identityFingerprint: invoice.identityFingerprint,
        fingerprintVersion: 1,
        eventName: invoice.eventName,
        invoiceId: invoice.invoiceId,
        subscriptionId: invoice.subscriptionId,
        customerId: invoice.customerId,
        billingReason: invoice.billingReason,
        invoiceCreatedAt: invoice.invoiceCreatedAt,
        invoiceUpdatedAt: invoice.invoiceUpdatedAt,
        amountCents: invoice.amountCents,
        currency: invoice.currency,
        status: "processing",
        attemptCount: 96,
        nextAttemptAt: now,
        leaseToken: "terminal-lease-1",
        expiresAt: now + 365 * 24 * 60 * 60 * 1_000,
        createdAt: now,
        updatedAt: now,
      });
      return { adminUserId, inboxId };
    });
    const settlementConfiguration = {
      fingerprintKeyAttestation: invoice.fingerprintKeyAttestation,
    };

    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.deferSubscriptionInvoiceInbox,
        {
          inboxId,
          leaseToken: "terminal-lease-1",
          error: "subscription state unavailable",
          ...settlementConfiguration,
        },
      ),
    ).resolves.toBe(true);
    const first = await t.run(async (ctx) => ({
      inbox: await ctx.db.get(inboxId),
      reviews: await ctx.db
        .query("paymentSettlementManualReviews")
        .withIndex("by_settlement_key_fingerprint", (q) =>
          q.eq("settlementKeyFingerprint", invoice.settlementKeyFingerprint),
        )
        .take(2),
    }));
    expect(first.inbox).toMatchObject({
      status: "manual_review",
      attemptCount: 96,
    });
    expect(first.reviews).toHaveLength(1);
    expect(first.reviews[0]).toMatchObject({
      reviewType: "invoice_processing",
      invoiceInboxId: inboxId,
      providerResourceId: invoice.invoiceId,
      identityFingerprint: invoice.identityFingerprint,
      status: "open",
    });

    const authenticated = t.withIdentity({
      subject: `${adminUserId}|admin-session`,
    });
    await expect(
      authenticated.mutation(
        api.admin.paymentMutation.requeueSubscriptionInvoiceReview,
        {
          manualReviewId: first.reviews[0]._id,
          evidenceReference: "ls-support-case-retry-1",
          confirmRetry: true,
        },
      ),
    ).resolves.toEqual({ success: true, idempotent: false });

    await t.run(async (ctx) => {
      await ctx.db.patch(inboxId, {
        status: "processing",
        attemptCount: 96,
        leaseToken: "terminal-lease-2",
        nextAttemptAt: now,
      });
    });
    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.deferSubscriptionInvoiceInbox,
        {
          inboxId,
          leaseToken: "terminal-lease-2",
          error: "subscription state still unavailable",
          ...settlementConfiguration,
        },
      ),
    ).resolves.toBe(true);

    const repeated = await t.run(async (ctx) => ({
      inbox: await ctx.db.get(inboxId),
      reviews: await ctx.db
        .query("paymentSettlementManualReviews")
        .withIndex("by_settlement_key_fingerprint", (q) =>
          q.eq("settlementKeyFingerprint", invoice.settlementKeyFingerprint),
        )
        .take(2),
    }));
    expect(repeated.inbox).toMatchObject({ status: "manual_review" });
    expect(repeated.reviews).toHaveLength(1);
    expect(repeated.reviews[0]).toMatchObject({
      _id: first.reviews[0]._id,
      reviewType: "invoice_processing",
      status: "open",
    });
    expect(repeated.reviews[0]).not.toHaveProperty(
      "resolutionEvidenceReference",
    );
  });

  it("keeps exact calendar boundaries and fences stale or conflicting state", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const providerCreatedAt = Date.parse("2026-01-31T10:00:00.000Z");
    const februaryEnd = Date.parse("2026-02-28T10:00:00.000Z");
    const marchEnd = Date.parse("2026-03-31T10:00:00.000Z");

    const created = await t.mutation(
      internal.subscriptions.internalMutation.syncLemonSqueezySubscription,
      {
        eventName: "subscription_created",
        userId,
        lemonSqueezySubscriptionId: "4101",
        lemonSqueezyCustomerId: "2201",
        lemonSqueezyVariantId: PRO_VARIANT_ID,
        status: "active",
        providerCreatedAt,
        providerUpdatedAt: providerCreatedAt,
        periodEnd: februaryEnd,
      },
    );
    const updatedAt = Date.parse("2026-02-15T10:00:00.000Z");
    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.syncLemonSqueezySubscription,
        {
          eventName: "subscription_updated",
          lemonSqueezySubscriptionId: "4101",
          lemonSqueezyCustomerId: "2201",
          lemonSqueezyVariantId: PRO_VARIANT_ID,
          status: "active",
          providerCreatedAt,
          providerUpdatedAt: updatedAt,
          periodEnd: marchEnd,
        },
      ),
    ).resolves.toMatchObject({ outcome: "applied" });
    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.syncLemonSqueezySubscription,
        {
          eventName: "subscription_updated",
          lemonSqueezySubscriptionId: "4101",
          lemonSqueezyCustomerId: "2201",
          lemonSqueezyVariantId: PRO_VARIANT_ID,
          status: "active",
          providerCreatedAt,
          providerUpdatedAt: updatedAt - 1,
          periodEnd: februaryEnd,
        },
      ),
    ).resolves.toMatchObject({ outcome: "stale" });
    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.syncLemonSqueezySubscription,
        {
          eventName: "subscription_updated",
          lemonSqueezySubscriptionId: "4101",
          lemonSqueezyCustomerId: "2201",
          lemonSqueezyVariantId: PRO_VARIANT_ID,
          status: "canceled",
          providerCreatedAt,
          providerUpdatedAt: updatedAt,
          periodEnd: marchEnd,
        },
      ),
    ).rejects.toThrow("Conflicting subscription state at provider timestamp");

    const state = await t.run(async (ctx) => ({
      subscription: await ctx.db.get(created.subscriptionId),
      logs: await ctx.db.query("paymentLogs").withIndex("by_created").take(1),
    }));
    expect(state.subscription).toMatchObject({
      periodStart: providerCreatedAt,
      periodEnd: marchEnd,
      providerUpdatedAt: updatedAt,
      status: "active",
    });
    expect(state.logs).toEqual([]);
  });

  it("rejects an overlapping trusted replacement without truncating its provider period", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const oldCreatedAt = now - 10 * 24 * 60 * 60 * 1_000;
    const oldUpdatedAt = now - 2 * 24 * 60 * 60 * 1_000;
    const oldPeriodEnd = now + 10 * 24 * 60 * 60 * 1_000;
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));

    const oldSubscription = await t.mutation(
      internal.subscriptions.internalMutation.syncLemonSqueezySubscription,
      {
        eventName: "subscription_created",
        userId,
        lemonSqueezySubscriptionId: "4102",
        lemonSqueezyCustomerId: "2202",
        lemonSqueezyVariantId: PRO_VARIANT_ID,
        status: "canceled",
        providerCreatedAt: oldCreatedAt,
        providerUpdatedAt: oldUpdatedAt,
        periodEnd: oldPeriodEnd,
      },
    );
    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.syncLemonSqueezySubscription,
        {
          eventName: "subscription_created",
          userId,
          lemonSqueezySubscriptionId: "4103",
          lemonSqueezyCustomerId: "2203",
          lemonSqueezyVariantId: PRO_VARIANT_ID,
          status: "active",
          providerCreatedAt: now - 24 * 60 * 60 * 1_000,
          providerUpdatedAt: now - 24 * 60 * 60 * 1_000,
          periodEnd: now + 29 * 24 * 60 * 60 * 1_000,
        },
      ),
    ).rejects.toThrow("User already has an active trusted subscription");

    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.syncLemonSqueezySubscription,
        {
          eventName: "subscription_updated",
          lemonSqueezySubscriptionId: "4102",
          lemonSqueezyCustomerId: "2202",
          lemonSqueezyVariantId: PRO_VARIANT_ID,
          status: "active",
          providerCreatedAt: oldCreatedAt,
          providerUpdatedAt: oldUpdatedAt - 1,
          periodEnd: oldPeriodEnd,
        },
      ),
    ).resolves.toMatchObject({ outcome: "stale" });

    await expect(
      t.run(async (ctx) => ctx.db.get(oldSubscription.subscriptionId)),
    ).resolves.toMatchObject({
      status: "canceled",
      periodEnd: oldPeriodEnd,
    });
  });

  it("settles an ended trusted Pro period exactly before replacement", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const periodStart = now - 31 * 24 * 60 * 60 * 1_000;
    const periodEnd = now - 24 * 60 * 60 * 1_000;
    const { userId, oldSubscriptionId } = await t.run(async (ctx) => {
      const insertedUserId = await ctx.db.insert("users", {});
      const subscriptionId = await ctx.db.insert("subscriptions", {
        userId: insertedUserId,
        lemonSqueezySubscriptionId: "4112",
        lemonSqueezyCustomerId: "2212",
        lemonSqueezyVariantId: PRO_VARIANT_ID,
        providerCreatedAt: periodStart,
        providerUpdatedAt: periodEnd,
        proEntitlementProvenance: {
          source: "lemon_squeezy_webhook",
          verifiedAt: periodStart,
        },
        plan: "pro",
        status: "canceled",
        includedTokens: PRO_INCLUDED_TOKENS,
        purchasedTokens: 100,
        serviceFeeRate: 0.18,
        periodStart,
        periodEnd,
        createdAt: periodStart,
        updatedAt: periodEnd,
      });
      await ctx.db.insert("subscriptionBillingBoundaries", {
        subscriptionId,
        periodStart,
        periodEnd,
        providerUpdatedAt: periodEnd,
        status: "pending",
        createdAt: periodStart,
        updatedAt: periodEnd,
      });
      await ctx.db.insert("tokenUsage", {
        purchasedTokensDebited: 0,
        userId: insertedUserId,
        usageType: "chat",
        inputTokens: PRO_INCLUDED_TOKENS + 40,
        outputTokens: 0,
        totalTokens: PRO_INCLUDED_TOKENS + 40,
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
      return { userId: insertedUserId, oldSubscriptionId: subscriptionId };
    });

    const replacement = await t.mutation(
      internal.subscriptions.internalMutation.syncLemonSqueezySubscription,
      {
        eventName: "subscription_created",
        userId,
        lemonSqueezySubscriptionId: "4113",
        lemonSqueezyCustomerId: "2213",
        lemonSqueezyVariantId: PRO_VARIANT_ID,
        status: "active",
        providerCreatedAt: now,
        providerUpdatedAt: now,
        periodEnd: now + 30 * 24 * 60 * 60 * 1_000,
      },
    );

    const state = await t.run(async (ctx) => ({
      old: await ctx.db.get(oldSubscriptionId),
      replacement: await ctx.db.get(replacement.subscriptionId),
      oldBoundary: await ctx.db
        .query("subscriptionBillingBoundaries")
        .withIndex("by_subscription_and_period_end", (q) =>
          q.eq("subscriptionId", oldSubscriptionId).eq("periodEnd", periodEnd),
        )
        .unique(),
    }));
    expect(state.old).toMatchObject({ status: "expired", purchasedTokens: 0 });
    expect(state.replacement).toMatchObject({
      status: "active",
      purchasedTokens: 60,
    });
    expect(state.oldBoundary).toMatchObject({
      status: "settled",
      settlementReason: "terminal_entitlement",
      purchasedTokensDebited: 40,
    });
  });

  it("persists terminal manual review and rejects the replacement webhook ACK", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const periodStart = now - 31 * 24 * 60 * 60 * 1_000;
    const periodEnd = now - 24 * 60 * 60 * 1_000;
    const { userId, oldSubscriptionId } = await t.run(async (ctx) => {
      const insertedUserId = await ctx.db.insert("users", {});
      const subscriptionId = await ctx.db.insert("subscriptions", {
        userId: insertedUserId,
        lemonSqueezySubscriptionId: "4114",
        lemonSqueezyCustomerId: "2214",
        lemonSqueezyVariantId: PRO_VARIANT_ID,
        providerCreatedAt: periodStart,
        providerUpdatedAt: periodEnd,
        proEntitlementProvenance: {
          source: "lemon_squeezy_webhook",
          verifiedAt: periodStart,
        },
        plan: "pro",
        status: "canceled",
        includedTokens: PRO_INCLUDED_TOKENS,
        purchasedTokens: 30,
        serviceFeeRate: 0.18,
        periodStart,
        periodEnd,
        createdAt: periodStart,
        updatedAt: periodEnd,
      });
      await ctx.db.insert("subscriptionBillingBoundaries", {
        subscriptionId,
        periodStart,
        periodEnd,
        providerUpdatedAt: periodEnd,
        status: "pending",
        createdAt: periodStart,
        updatedAt: periodEnd,
      });
      await ctx.db.insert("tokenUsage", {
        purchasedTokensDebited: 0,
        userId: insertedUserId,
        usageType: "chat",
        inputTokens: PRO_INCLUDED_TOKENS + 40,
        outputTokens: 0,
        totalTokens: PRO_INCLUDED_TOKENS + 40,
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
      return { userId: insertedUserId, oldSubscriptionId: subscriptionId };
    });

    const body = JSON.stringify({
      meta: {
        event_name: "subscription_created",
        custom_data: { user_id: userId },
      },
      data: {
        id: "4115",
        type: "subscriptions",
        attributes: {
          store_id: 1001,
          test_mode: true,
          customer_id: 2215,
          variant_id: Number(PRO_VARIANT_ID),
          status: "active",
          created_at: new Date(now).toISOString(),
          updated_at: new Date(now).toISOString(),
          renews_at: new Date(now + 30 * 24 * 60 * 60 * 1_000).toISOString(),
        },
      },
    });
    const webhookSecret = process.env.LS_WEBHOOK_SECRET;
    if (!webhookSecret) throw new Error("Expected webhook test secret");
    const response = await t.fetch("/lemon-squeezy/webhook", {
      method: "POST",
      headers: { "x-signature": await signBody(body, webhookSecret) },
      body,
    });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Internal server error",
    });

    const state = await t.run(async (ctx) => ({
      old: await ctx.db.get(oldSubscriptionId),
      replacement: await ctx.db
        .query("subscriptions")
        .withIndex("by_lemon_squeezy_subscription_and_provenance_source", (q) =>
          q
            .eq("lemonSqueezySubscriptionId", "4115")
            .eq("proEntitlementProvenance.source", "lemon_squeezy_webhook"),
        )
        .unique(),
      boundary: await ctx.db
        .query("subscriptionBillingBoundaries")
        .withIndex("by_subscription_and_period_end", (q) =>
          q.eq("subscriptionId", oldSubscriptionId).eq("periodEnd", periodEnd),
        )
        .unique(),
    }));
    expect(state.old).toMatchObject({
      purchasedTokens: 30,
      billingBoundaryReconciliationRequired: true,
      billingBoundaryManualReviewReason:
        "Purchased-token wallet cannot cover the exact terminal settlement.",
    });
    expect(state.boundary).toMatchObject({
      status: "manual_review",
      manualReviewReason:
        "Purchased-token wallet cannot cover the exact terminal settlement.",
    });
    expect(state.replacement).toBeNull();
  });

  it("deduplicates success and recovered while excluding boundary usage", async () => {
    vi.useFakeTimers();
    const periodStart = Date.parse("2100-01-01T00:00:00.000Z");
    const invoiceCreatedAt = Date.parse("2100-02-01T00:00:00.000Z");
    const periodEnd = invoiceCreatedAt;
    vi.setSystemTime(invoiceCreatedAt);
    const t = convexTest(schema, modules);
    await pinSettlementConfiguration(t, periodStart);
    const { userId, subscriptionId } = await t.run(async (ctx) => {
      const insertedUserId = await ctx.db.insert("users", {});
      const insertedSubscriptionId = await ctx.db.insert("subscriptions", {
        userId: insertedUserId,
        lemonSqueezySubscriptionId: "4201",
        lemonSqueezyCustomerId: "2201",
        lemonSqueezyVariantId: PRO_VARIANT_ID,
        providerCreatedAt: periodStart,
        providerUpdatedAt: periodStart,
        proEntitlementProvenance: {
          source: "lemon_squeezy_webhook",
          verifiedAt: periodStart,
        },
        plan: "pro",
        status: "active",
        includedTokens: PRO_INCLUDED_TOKENS,
        purchasedTokens: 1_000_000,
        serviceFeeRate: 0.18,
        periodStart,
        periodEnd,
        createdAt: periodStart,
        updatedAt: periodStart,
      });
      const usage = [
        { createdAt: invoiceCreatedAt - 1, totalTokens: 2_600_000 },
        { createdAt: invoiceCreatedAt, totalTokens: 900_000 },
        { createdAt: invoiceCreatedAt + 1, totalTokens: 1_000_000 },
      ];
      for (const row of usage) {
        await ctx.db.insert("tokenUsage", {
          usageType: "chat",
          purchasedTokensDebited: 0,
          userId: insertedUserId,
          inputTokens: row.totalTokens,
          outputTokens: 0,
          totalTokens: row.totalTokens,
          inputCostCents: 0,
          outputCostCents: 0,
          baseCostCents: 0,
          serviceFeeCents: 0,
          totalCostCents: 0,
          model: "test-model",
          provider: "google",
          serviceFeeRate: 0,
          createdAt: row.createdAt,
        });
      }
      return {
        userId: insertedUserId,
        subscriptionId: insertedSubscriptionId,
      };
    });
    const args = await invoiceArgs("4201", "7101", invoiceCreatedAt);

    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.settleSubscriptionInvoice,
        args,
      ),
    ).resolves.toMatchObject({
      outcome: "applied",
      tokensUsed: 2_600_000,
      usedFromPurchased: 200_000,
    });
    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.settleSubscriptionInvoice,
        { ...args, eventName: "subscription_payment_recovered" },
      ),
    ).resolves.toMatchObject({ outcome: "duplicate" });

    const state = await t.run(async (ctx) => ({
      subscription: await ctx.db.get(subscriptionId),
      logs: await ctx.db
        .query("paymentLogs")
        .withIndex("by_invoice_status", (q) =>
          q.eq("lemonSqueezyInvoiceId", "7101").eq("status", "success"),
        )
        .take(2),
      receipts: await ctx.db
        .query("paymentSettlementReceipts")
        .withIndex("by_settlement_key_fingerprint", (q) =>
          q.eq("settlementKeyFingerprint", args.settlementKeyFingerprint),
        )
        .take(2),
      summary: await ctx.db
        .query("paymentStatsSummary")
        .withIndex("by_key", (q) => q.eq("key", "global"))
        .unique(),
    }));
    expect(state.subscription).toMatchObject({
      userId,
      periodStart: invoiceCreatedAt,
      purchasedTokens: 800_000,
    });
    expect(state.logs).toHaveLength(1);
    expect(state.logs[0]).toMatchObject({
      lemonSqueezyInvoiceId: "7101",
      lemonSqueezySubscriptionId: "4201",
    });
    expect(state.receipts).toHaveLength(1);
    expect(JSON.stringify(state.receipts[0])).not.toContain("7101");
    expect(state.summary).toMatchObject({
      totalOrders: 1,
      totalRevenueCents: 1_999,
      proSubscriptionCount: 1,
    });
  });

  it("debits Pro purchased tokens only at the settled billing boundary", async () => {
    vi.useFakeTimers();
    const periodStart = Date.parse("2100-01-01T00:00:00.000Z");
    const periodEnd = Date.parse("2100-02-01T00:00:00.000Z");
    vi.setSystemTime(Date.parse("2100-01-15T00:00:00.000Z"));
    const t = convexTest(schema, modules);
    const fingerprintKeyAttestation =
      await createSettlementFingerprintKeyAttestation();
    await t.run(async (ctx) => {
      await ctx.db.insert("paymentSettlementConfiguration", {
        key: "global",
        fingerprintKeyAttestation,
        updatedAt: periodStart,
      });
    });
    const { userId, subscriptionId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const subscriptionId = await ctx.db.insert("subscriptions", {
        userId,
        lemonSqueezySubscriptionId: "4202",
        lemonSqueezyCustomerId: "2201",
        lemonSqueezyVariantId: PRO_VARIANT_ID,
        providerCreatedAt: periodStart,
        providerUpdatedAt: periodStart,
        proEntitlementProvenance: {
          source: "lemon_squeezy_webhook",
          verifiedAt: periodStart,
        },
        plan: "pro",
        status: "active",
        includedTokens: PRO_INCLUDED_TOKENS,
        purchasedTokens: 100,
        serviceFeeRate: 0.18,
        periodStart,
        periodEnd,
        createdAt: periodStart,
        updatedAt: periodStart,
      });
      return { userId, subscriptionId };
    });

    const usageId = await t.mutation(
      internal.tokenUsage.internalMutation.recordUsage,
      {
        userId,
        inputTokens: PRO_INCLUDED_TOKENS + 60,
        outputTokens: 0,
        model: "claude-sonnet-5-5",
        provider: "anthropic",
      },
    );
    const beforeSettlement = await t.run(async (ctx) => ({
      subscription: await ctx.db.get(subscriptionId),
      usage: await ctx.db.get(usageId),
    }));
    expect(beforeSettlement.subscription?.purchasedTokens).toBe(100);
    expect(beforeSettlement.usage?.purchasedTokensDebited).toBe(0);

    vi.setSystemTime(periodEnd);
    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.settleSubscriptionInvoice,
        await invoiceArgs("4202", "7110", periodEnd),
      ),
    ).resolves.toMatchObject({
      outcome: "applied",
      tokensUsed: PRO_INCLUDED_TOKENS + 60,
      usedFromPurchased: 60,
    });
    await expect(
      t.run(async (ctx) => ctx.db.get(subscriptionId)),
    ).resolves.toMatchObject({ purchasedTokens: 40 });
  });

  it("durably defers an early renewal until the exact billing boundary", async () => {
    vi.useFakeTimers();
    const periodStart = Date.parse("2100-01-01T00:00:00.000Z");
    const periodEnd = Date.parse("2100-02-01T00:00:00.000Z");
    const earlyInvoiceCreatedAt = periodEnd - 12 * 60 * 60 * 1_000;
    vi.setSystemTime(earlyInvoiceCreatedAt);
    const t = convexTest(schema, modules);
    const fingerprintKeyAttestation =
      await createSettlementFingerprintKeyAttestation();
    await t.run(async (ctx) => {
      await ctx.db.insert("paymentSettlementConfiguration", {
        key: "global",
        fingerprintKeyAttestation,
        updatedAt: periodStart,
      });
    });
    const { userId, subscriptionId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const subscriptionId = await ctx.db.insert("subscriptions", {
        userId,
        lemonSqueezySubscriptionId: "4206",
        lemonSqueezyCustomerId: "2201",
        lemonSqueezyVariantId: PRO_VARIANT_ID,
        providerCreatedAt: periodStart,
        providerUpdatedAt: periodStart,
        proEntitlementProvenance: {
          source: "lemon_squeezy_webhook",
          verifiedAt: periodStart,
        },
        plan: "pro",
        status: "active",
        includedTokens: PRO_INCLUDED_TOKENS,
        purchasedTokens: 100,
        serviceFeeRate: 0.18,
        periodStart,
        periodEnd,
        createdAt: periodStart,
        updatedAt: periodStart,
      });
      return { userId, subscriptionId };
    });
    const invoice = await invoiceArgs("4206", "7112", earlyInvoiceCreatedAt);
    const { invoiceStatus: _invoiceStatus, ...enqueueArgs } = invoice;
    void _invoiceStatus;
    await t.mutation(
      internal.subscriptions.internalMutation.enqueueSubscriptionInvoice,
      enqueueArgs,
    );
    const inboxId = await t.run(async (ctx) => {
      const inbox = await ctx.db
        .query("lemonSqueezyInvoiceInbox")
        .withIndex("by_settlement_key_fingerprint", (q) =>
          q.eq("settlementKeyFingerprint", invoice.settlementKeyFingerprint),
        )
        .unique();
      if (!inbox) throw new Error("invoice inbox missing");
      return inbox._id;
    });

    await expect(
      t.action(internal.lemonSqueezy.webhook.processSubscriptionInvoiceInbox, {
        inboxId,
      }),
    ).resolves.toEqual({ outcome: "deferred" });
    const deferred = await t.run(async (ctx) => ({
      subscription: await ctx.db.get(subscriptionId),
      boundary: await ctx.db
        .query("subscriptionBillingBoundaries")
        .withIndex("by_subscription_and_period_end", (q) =>
          q.eq("subscriptionId", subscriptionId).eq("periodEnd", periodEnd),
        )
        .unique(),
      inbox: await ctx.db.get(inboxId),
      receipt: await ctx.db
        .query("paymentSettlementReceipts")
        .withIndex("by_settlement_key_fingerprint", (q) =>
          q.eq("settlementKeyFingerprint", invoice.settlementKeyFingerprint),
        )
        .unique(),
      logs: await ctx.db
        .query("paymentLogs")
        .withIndex("by_invoice_status", (q) =>
          q
            .eq("lemonSqueezyInvoiceId", invoice.invoiceId)
            .eq("status", "success"),
        )
        .collect(),
    }));
    expect(deferred.subscription).toMatchObject({
      periodStart,
      purchasedTokens: 100,
    });
    expect(deferred.boundary).toMatchObject({ status: "pending" });
    expect(deferred.inbox).toMatchObject({
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: periodEnd,
      lastError: "Subscription billing boundary has not been reached yet",
    });
    expect(deferred.receipt).toBeNull();
    expect(deferred.logs).toEqual([]);

    vi.setSystemTime(periodEnd - 60 * 60 * 1_000);
    await t.mutation(internal.tokenUsage.internalMutation.recordUsage, {
      userId,
      inputTokens: PRO_INCLUDED_TOKENS + 60,
      outputTokens: 0,
      model: "claude-sonnet-5-5",
      provider: "anthropic",
    });

    await t.finishAllScheduledFunctions(() => vi.advanceTimersToNextTimer());
    expect(Date.now()).toBeGreaterThanOrEqual(periodEnd);

    const settled = await t.run(async (ctx) => ({
      subscription: await ctx.db.get(subscriptionId),
      boundary: await ctx.db
        .query("subscriptionBillingBoundaries")
        .withIndex("by_subscription_and_period_end", (q) =>
          q.eq("subscriptionId", subscriptionId).eq("periodEnd", periodEnd),
        )
        .unique(),
      inbox: await ctx.db.get(inboxId),
      receipt: await ctx.db
        .query("paymentSettlementReceipts")
        .withIndex("by_settlement_key_fingerprint", (q) =>
          q.eq("settlementKeyFingerprint", invoice.settlementKeyFingerprint),
        )
        .unique(),
    }));
    expect(settled.subscription).toMatchObject({
      periodStart: periodEnd,
      purchasedTokens: 40,
    });
    expect(settled.boundary).toMatchObject({
      status: "settled",
      settlementReason: "renewal_invoice",
      purchasedTokensDebited: 60,
    });
    expect(settled.inbox).toBeNull();
    expect(settled.receipt).toMatchObject({ settlementType: "invoice" });
  });

  it("defers renewal until provider-started chat holds close", async () => {
    vi.useFakeTimers();
    const periodStart = Date.parse("2100-01-01T00:00:00.000Z");
    const periodEnd = Date.parse("2100-02-01T00:00:00.000Z");
    const providerStartedAt = periodEnd - 1_000;
    vi.setSystemTime(providerStartedAt);
    const t = convexTest(schema, modules);
    const fingerprintKeyAttestation =
      await createSettlementFingerprintKeyAttestation();
    await t.run(async (ctx) => {
      await ctx.db.insert("paymentSettlementConfiguration", {
        key: "global",
        fingerprintKeyAttestation,
        updatedAt: periodStart,
      });
    });
    const { userId, subscriptionId, boundaryId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const subscriptionId = await ctx.db.insert("subscriptions", {
        userId,
        lemonSqueezySubscriptionId: "4203",
        lemonSqueezyCustomerId: "2201",
        lemonSqueezyVariantId: PRO_VARIANT_ID,
        providerCreatedAt: periodStart,
        providerUpdatedAt: periodStart,
        proEntitlementProvenance: {
          source: "lemon_squeezy_webhook",
          verifiedAt: periodStart,
        },
        plan: "pro",
        status: "active",
        includedTokens: PRO_INCLUDED_TOKENS,
        purchasedTokens: 200,
        serviceFeeRate: 0.18,
        periodStart,
        periodEnd,
        createdAt: periodStart,
        updatedAt: periodStart,
      });
      const boundaryId = await ctx.db.insert("subscriptionBillingBoundaries", {
        subscriptionId,
        periodStart,
        periodEnd,
        providerUpdatedAt: periodStart,
        status: "pending",
        createdAt: periodStart,
        updatedAt: periodStart,
      });
      return { userId, subscriptionId, boundaryId };
    });
    const { repositoryId, ticketActionId } = await insertAiUsageScope(
      t,
      userId,
      providerStartedAt,
    );
    const chatReservation = {
      reservationKey: "renewal-chat-hold-4203",
      attemptToken: "renewal-chat-hold-4203-attempt-1",
      userId,
      repositoryId,
      ticketActionId,
      requirePendingTicketAction: true,
      generationKey: "renewal-chat-generation-4203",
      operation: "renewal billing hold regression",
      model: "claude-sonnet-5-5",
      provider: "anthropic" as const,
      requestFingerprint: "1".repeat(64),
      inputTokenLimit: PRO_INCLUDED_TOKENS + 40,
      outputTokenLimit: 20,
    };
    const safeChatReservation = {
      ...chatReservation,
      reservationKey: "renewal-safe-chat-hold-4203",
      attemptToken: "renewal-safe-chat-hold-4203-attempt-1",
      generationKey: "renewal-safe-chat-generation-4203",
      inputTokenLimit: 100,
    };
    await expect(
      t.mutation(
        internal._ai.chatBilling.reserveChatUsage,
        safeChatReservation,
      ),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      t.mutation(internal._ai.chatBilling.reserveChatUsage, chatReservation),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      t.mutation(internal._ai.chatBilling.markChatProviderStarted, {
        reservationKey: chatReservation.reservationKey,
        attemptToken: chatReservation.attemptToken,
        userId,
        repositoryId,
        ticketActionId,
      }),
    ).resolves.toEqual({ started: true, alreadyStarted: false });
    const invoice = await invoiceArgs("4203", "7111", periodEnd);
    const { invoiceStatus: _invoiceStatus, ...enqueueArgs } = invoice;
    void _invoiceStatus;
    await t.mutation(
      internal.subscriptions.internalMutation.enqueueSubscriptionInvoice,
      enqueueArgs,
    );
    const inboxId = await t.run(async (ctx) => {
      const inbox = await ctx.db
        .query("lemonSqueezyInvoiceInbox")
        .withIndex("by_settlement_key_fingerprint", (q) =>
          q.eq("settlementKeyFingerprint", invoice.settlementKeyFingerprint),
        )
        .unique();
      if (!inbox) throw new Error("invoice inbox missing");
      return inbox._id;
    });
    vi.setSystemTime(periodEnd);
    await expect(
      t.action(internal.lemonSqueezy.webhook.processSubscriptionInvoiceInbox, {
        inboxId,
      }),
    ).resolves.toEqual({ outcome: "deferred" });
    const deferred = await t.run(async (ctx) => ({
      subscription: await ctx.db.get(subscriptionId),
      boundary: await ctx.db.get(boundaryId),
      safeChat: await ctx.db
        .query("chatUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", safeChatReservation.reservationKey),
        )
        .unique(),
      inbox: await ctx.db.get(inboxId),
      receipt: await ctx.db
        .query("paymentSettlementReceipts")
        .withIndex("by_settlement_key_fingerprint", (q) =>
          q.eq("settlementKeyFingerprint", invoice.settlementKeyFingerprint),
        )
        .unique(),
      logs: await ctx.db
        .query("paymentLogs")
        .withIndex("by_invoice_status", (q) =>
          q
            .eq("lemonSqueezyInvoiceId", invoice.invoiceId)
            .eq("status", "success"),
        )
        .collect(),
    }));
    expect(deferred.subscription).toMatchObject({ purchasedTokens: 200 });
    expect(deferred.boundary).toMatchObject({ status: "pending" });
    expect(deferred.safeChat).toMatchObject({
      status: "released",
      releaseReason: "entitlement_period_ended",
    });
    expect(deferred.inbox).toMatchObject({
      status: "pending",
      attemptCount: 1,
      lastError:
        "Provider usage is still being finalized for this renewal period",
    });
    expect(deferred.receipt).toBeNull();
    expect(deferred.logs).toEqual([]);

    await t.mutation(internal.tokenUsage.internalMutation.recordUsage, {
      userId,
      repositoryId,
      ticketActionId,
      inputTokens: PRO_INCLUDED_TOKENS + 40,
      outputTokens: 20,
      model: chatReservation.model,
      provider: "anthropic",
      reservationKey: chatReservation.reservationKey,
      reservationAttemptToken: chatReservation.attemptToken,
      providerRequestId: "anthropic-request-4203",
    });
    await expect(
      t.run(async (ctx) =>
        ctx.db.patch(inboxId, { nextAttemptAt: Date.now() }),
      ),
    ).resolves.toBeNull();
    await expect(
      t.action(internal.lemonSqueezy.webhook.processSubscriptionInvoiceInbox, {
        inboxId,
      }),
    ).resolves.toEqual({ outcome: "applied" });

    const settled = await t.run(async (ctx) => ({
      subscription: await ctx.db.get(subscriptionId),
      boundary: await ctx.db.get(boundaryId),
      chat: await ctx.db
        .query("chatUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", chatReservation.reservationKey),
        )
        .unique(),
      receipt: await ctx.db
        .query("paymentSettlementReceipts")
        .withIndex("by_settlement_key_fingerprint", (q) =>
          q.eq("settlementKeyFingerprint", invoice.settlementKeyFingerprint),
        )
        .unique(),
      inbox: await ctx.db.get(inboxId),
    }));
    expect(settled.subscription).toMatchObject({
      periodStart: periodEnd,
      purchasedTokens: 140,
    });
    expect(settled.boundary).toMatchObject({
      status: "settled",
      settlementReason: "renewal_invoice",
      purchasedTokensDebited: 60,
    });
    expect(settled.chat).toMatchObject({ status: "finalized" });
    expect(settled.receipt).toMatchObject({ settlementType: "invoice" });
    expect(settled.inbox).toBeNull();
  });

  it("keeps a shortened expired boundary pending for an original-period chat hold", async () => {
    vi.useFakeTimers();
    const periodStart = Date.parse("2100-03-01T00:00:00.000Z");
    const originalPeriodEnd = Date.parse("2100-04-01T00:00:00.000Z");
    const shortenedPeriodEnd = Date.parse("2100-03-20T00:00:00.000Z");
    const providerStartedAt = shortenedPeriodEnd - 1_000;
    vi.setSystemTime(providerStartedAt);
    const t = convexTest(schema, modules);
    const { userId, subscriptionId, boundaryId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const subscriptionId = await ctx.db.insert("subscriptions", {
        userId,
        lemonSqueezySubscriptionId: "4204",
        lemonSqueezyCustomerId: "2201",
        lemonSqueezyVariantId: PRO_VARIANT_ID,
        providerCreatedAt: periodStart,
        providerUpdatedAt: periodStart,
        proEntitlementProvenance: {
          source: "lemon_squeezy_webhook",
          verifiedAt: periodStart,
        },
        plan: "pro",
        status: "active",
        includedTokens: PRO_INCLUDED_TOKENS,
        purchasedTokens: 100,
        serviceFeeRate: 0.18,
        periodStart,
        periodEnd: originalPeriodEnd,
        createdAt: periodStart,
        updatedAt: periodStart,
      });
      const boundaryId = await ctx.db.insert("subscriptionBillingBoundaries", {
        subscriptionId,
        periodStart,
        periodEnd: originalPeriodEnd,
        providerUpdatedAt: periodStart,
        status: "pending",
        createdAt: periodStart,
        updatedAt: periodStart,
      });
      return { userId, subscriptionId, boundaryId };
    });
    const { repositoryId, ticketActionId } = await insertAiUsageScope(
      t,
      userId,
      providerStartedAt,
    );
    const chatReservation = {
      reservationKey: "expired-chat-hold-4204",
      attemptToken: "expired-chat-hold-4204-attempt-1",
      userId,
      repositoryId,
      ticketActionId,
      requirePendingTicketAction: true,
      generationKey: "expired-chat-generation-4204",
      operation: "expired billing hold regression",
      model: "claude-sonnet-5-5",
      provider: "anthropic",
      requestFingerprint: "2".repeat(64),
      inputTokenLimit: 100,
      outputTokenLimit: 20,
    };
    await expect(
      t.mutation(internal._ai.chatBilling.reserveChatUsage, chatReservation),
    ).resolves.toMatchObject({ allowed: true });
    const started = await mutationWithTime(
      t,
      internal._ai.chatBilling.markChatProviderStarted,
      {
        reservationKey: chatReservation.reservationKey,
        attemptToken: chatReservation.attemptToken,
        userId,
        repositoryId,
        ticketActionId,
      },
    );
    expect(started.result).toEqual({ started: true, alreadyStarted: false });
    expect(started.now).toBeGreaterThanOrEqual(providerStartedAt);
    expect(started.now).toBeLessThan(shortenedPeriodEnd);

    vi.setSystemTime(shortenedPeriodEnd);
    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.syncLemonSqueezySubscription,
        {
          eventName: "subscription_expired",
          lemonSqueezySubscriptionId: "4204",
          lemonSqueezyCustomerId: "2201",
          lemonSqueezyVariantId: PRO_VARIANT_ID,
          status: "expired",
          providerCreatedAt: periodStart,
          providerUpdatedAt: shortenedPeriodEnd,
          periodEnd: shortenedPeriodEnd,
        },
      ),
    ).resolves.toMatchObject({ outcome: "applied" });
    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.settleEndedProSubscription,
        { subscriptionId },
      ),
    ).resolves.toEqual({ status: "in_progress" });

    const state = await t.run(async (ctx) => ({
      subscription: await ctx.db.get(subscriptionId),
      boundary: await ctx.db.get(boundaryId),
      reservation: await ctx.db
        .query("chatUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", chatReservation.reservationKey),
        )
        .unique(),
    }));
    expect(state.subscription).toMatchObject({
      status: "expired",
      periodEnd: shortenedPeriodEnd,
    });
    expect(state.boundary).toMatchObject({
      periodStart,
      periodEnd: shortenedPeriodEnd,
      status: "pending",
    });
    expect(state.reservation).toMatchObject({
      status: "pending",
      providerStartedAt: started.now,
      quotaPeriodStart: periodStart,
      quotaPeriodEnd: originalPeriodEnd,
    });
  });

  it("keeps an underfunded renewal boundary in durable manual review", async () => {
    vi.useFakeTimers();
    const periodStart = Date.parse("2100-01-01T00:00:00.000Z");
    const periodEnd = Date.parse("2100-02-01T00:00:00.000Z");
    vi.setSystemTime(periodEnd);
    const t = convexTest(schema, modules);
    await pinSettlementConfiguration(t, periodStart);
    const { userId, subscriptionId } = await t.run(async (ctx) => {
      const insertedUserId = await ctx.db.insert("users", {});
      const insertedSubscriptionId = await ctx.db.insert("subscriptions", {
        userId: insertedUserId,
        lemonSqueezySubscriptionId: "4209",
        lemonSqueezyCustomerId: "2201",
        lemonSqueezyVariantId: PRO_VARIANT_ID,
        providerCreatedAt: periodStart,
        providerUpdatedAt: periodStart,
        proEntitlementProvenance: {
          source: "lemon_squeezy_webhook",
          verifiedAt: periodStart,
        },
        plan: "pro",
        status: "active",
        includedTokens: PRO_INCLUDED_TOKENS,
        purchasedTokens: 50,
        serviceFeeRate: 0.18,
        periodStart,
        periodEnd,
        createdAt: periodStart,
        updatedAt: periodStart,
      });
      await ctx.db.insert("tokenUsage", {
        purchasedTokensDebited: 0,
        userId: insertedUserId,
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
        createdAt: periodEnd - 1,
      });
      return {
        userId: insertedUserId,
        subscriptionId: insertedSubscriptionId,
      };
    });
    const args = await invoiceArgs("4209", "7190", periodEnd);

    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.settleSubscriptionInvoice,
        args,
      ),
    ).resolves.toMatchObject({
      outcome: "manual_review",
      tokensUsed: PRO_INCLUDED_TOKENS + 60,
      usedFromPurchased: 60,
    });
    const state = await t.run(async (ctx) => ({
      subscription: await ctx.db.get(subscriptionId),
      boundary: await ctx.db
        .query("subscriptionBillingBoundaries")
        .withIndex("by_subscription_and_period_end", (q) =>
          q.eq("subscriptionId", subscriptionId).eq("periodEnd", periodEnd),
        )
        .unique(),
      receipt: await ctx.db
        .query("paymentSettlementReceipts")
        .withIndex("by_settlement_key_fingerprint", (q) =>
          q.eq("settlementKeyFingerprint", args.settlementKeyFingerprint),
        )
        .unique(),
      logs: await ctx.db
        .query("paymentLogs")
        .withIndex("by_invoice_status", (q) =>
          q.eq("lemonSqueezyInvoiceId", args.invoiceId).eq("status", "success"),
        )
        .collect(),
    }));
    expect(state.subscription).toMatchObject({
      userId,
      purchasedTokens: 50,
      periodStart,
      billingBoundaryReconciliationRequired: true,
    });
    expect(state.boundary).toMatchObject({
      status: "manual_review",
      manualReviewReason:
        "Purchased-token wallet cannot cover the exact renewal settlement.",
    });
    expect(state.receipt).toBeNull();
    expect(state.logs).toEqual([]);
  });

  it("never settles an underfunded invoice against a later pending boundary", async () => {
    vi.useFakeTimers();
    const periodStart = Date.parse("2100-01-01T00:00:00.000Z");
    const firstPeriodEnd = Date.parse("2100-02-01T00:00:00.000Z");
    const secondPeriodEnd = Date.parse("2100-03-01T00:00:00.000Z");
    vi.setSystemTime(firstPeriodEnd);
    const t = convexTest(schema, modules);
    await pinSettlementConfiguration(t, periodStart);
    const { subscriptionId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const insertedSubscriptionId = await ctx.db.insert("subscriptions", {
        userId,
        lemonSqueezySubscriptionId: "4210",
        lemonSqueezyCustomerId: "2201",
        lemonSqueezyVariantId: PRO_VARIANT_ID,
        providerCreatedAt: periodStart,
        providerUpdatedAt: firstPeriodEnd,
        proEntitlementProvenance: {
          source: "lemon_squeezy_webhook",
          verifiedAt: periodStart,
        },
        plan: "pro",
        status: "active",
        includedTokens: PRO_INCLUDED_TOKENS,
        purchasedTokens: 50,
        serviceFeeRate: 0.18,
        periodStart,
        periodEnd: secondPeriodEnd,
        createdAt: periodStart,
        updatedAt: firstPeriodEnd,
      });
      for (const [boundaryStart, boundaryEnd] of [
        [periodStart, firstPeriodEnd],
        [firstPeriodEnd, secondPeriodEnd],
      ] as const) {
        await ctx.db.insert("subscriptionBillingBoundaries", {
          subscriptionId: insertedSubscriptionId,
          periodStart: boundaryStart,
          periodEnd: boundaryEnd,
          providerUpdatedAt: boundaryEnd,
          status: "pending",
          createdAt: boundaryStart,
          updatedAt: boundaryStart,
        });
      }
      await ctx.db.insert("tokenUsage", {
        purchasedTokensDebited: 0,
        userId,
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
        createdAt: firstPeriodEnd - 1,
      });
      return { subscriptionId: insertedSubscriptionId };
    });
    const args = await invoiceArgs("4210", "7191", firstPeriodEnd);

    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.settleSubscriptionInvoice,
        args,
      ),
    ).resolves.toMatchObject({ outcome: "manual_review" });
    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.settleSubscriptionInvoice,
        args,
      ),
    ).rejects.toThrow("billing boundary requires reconciliation");

    const state = await t.run(async (ctx) => ({
      firstBoundary: await ctx.db
        .query("subscriptionBillingBoundaries")
        .withIndex("by_subscription_and_period_end", (q) =>
          q
            .eq("subscriptionId", subscriptionId)
            .eq("periodEnd", firstPeriodEnd),
        )
        .unique(),
      secondBoundary: await ctx.db
        .query("subscriptionBillingBoundaries")
        .withIndex("by_subscription_and_period_end", (q) =>
          q
            .eq("subscriptionId", subscriptionId)
            .eq("periodEnd", secondPeriodEnd),
        )
        .unique(),
      receipt: await ctx.db
        .query("paymentSettlementReceipts")
        .withIndex("by_settlement_key_fingerprint", (q) =>
          q.eq("settlementKeyFingerprint", args.settlementKeyFingerprint),
        )
        .unique(),
    }));
    expect(state.firstBoundary).toMatchObject({ status: "manual_review" });
    expect(state.secondBoundary).toMatchObject({ status: "pending" });
    expect(state.receipt).toBeNull();
  });

  it("recovers an exactly bound underfunded renewal after supported admin funding", async () => {
    vi.useFakeTimers();
    const periodStart = Date.parse("2099-01-01T00:00:00.000Z");
    const periodEnd = Date.parse("2099-02-01T00:00:00.000Z");
    vi.setSystemTime(periodEnd - 2 * 60 * 60 * 1_000);
    const t = convexTest(schema, modules);
    const invoice = await invoiceArgs("4211", "7192", periodEnd);
    const { adminUserId, subscriptionId } = await t.run(async (ctx) => {
      const adminUserId = await ctx.db.insert("users", {});
      await ctx.db.insert("userProfiles", {
        userId: adminUserId,
        githubUsername: "invoice-recovery-admin",
        isAdmin: true,
        createdAt: periodEnd,
        updatedAt: periodEnd,
      });
      const userId = await ctx.db.insert("users", {});
      const subscriptionId = await ctx.db.insert("subscriptions", {
        userId,
        lemonSqueezySubscriptionId: invoice.subscriptionId,
        lemonSqueezyCustomerId: invoice.customerId,
        lemonSqueezyVariantId: PRO_VARIANT_ID,
        providerCreatedAt: periodStart,
        providerUpdatedAt: periodEnd,
        proEntitlementProvenance: {
          source: "lemon_squeezy_webhook",
          verifiedAt: periodStart,
        },
        plan: "pro",
        status: "active",
        includedTokens: PRO_INCLUDED_TOKENS,
        purchasedTokens: 50,
        serviceFeeRate: 0.18,
        periodStart,
        periodEnd,
        createdAt: periodStart,
        updatedAt: periodEnd,
      });
      await ctx.db.insert("subscriptionBillingBoundaries", {
        subscriptionId,
        periodStart,
        periodEnd,
        providerUpdatedAt: periodEnd,
        status: "pending",
        createdAt: periodStart,
        updatedAt: periodStart,
      });
      await ctx.db.insert("tokenUsage", {
        purchasedTokensDebited: 0,
        userId,
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
        createdAt: periodEnd - 1,
      });
      return { adminUserId, subscriptionId };
    });
    const { invoiceStatus: _invoiceStatus, ...enqueueArgs } = invoice;
    void _invoiceStatus;
    await t.mutation(
      internal.subscriptions.internalMutation.enqueueSubscriptionInvoice,
      enqueueArgs,
    );
    const inboxId = await t.run(async (ctx) => {
      const inbox = await ctx.db
        .query("lemonSqueezyInvoiceInbox")
        .withIndex("by_settlement_key_fingerprint", (q) =>
          q.eq("settlementKeyFingerprint", invoice.settlementKeyFingerprint),
        )
        .unique();
      if (!inbox) throw new Error("invoice inbox missing");
      return inbox._id;
    });
    vi.setSystemTime(periodEnd + 1_000);

    await expect(
      t.action(internal.lemonSqueezy.webhook.processSubscriptionInvoiceInbox, {
        inboxId,
      }),
    ).resolves.toEqual({ outcome: "manual_review" });
    const firstAttemptReview = await t.run(async (ctx) => {
      const review = await ctx.db
        .query("paymentSettlementManualReviews")
        .withIndex("by_settlement_key_fingerprint", (q) =>
          q.eq("settlementKeyFingerprint", invoice.settlementKeyFingerprint),
        )
        .unique();
      if (!review) throw new Error("invoice review missing");
      return { review, inbox: await ctx.db.get(inboxId) };
    });
    expect(firstAttemptReview.review).toMatchObject({
      reviewType: "invoice_processing",
      invoiceInboxId: inboxId,
      status: "open",
    });
    expect(firstAttemptReview.inbox).toMatchObject({
      status: "manual_review",
      attemptCount: 1,
    });
    const reviewId = firstAttemptReview.review._id;
    const admin = t.withIdentity({
      subject: `${adminUserId}|admin-session`,
    });

    await expect(
      admin.mutation(api.admin.paymentMutation.addTokens, {
        subscriptionId,
        tokensToAdd: 10,
        operationId: "00000000-0000-4000-8000-000000000006",
        adminNote: "Fund exact renewal settlement",
      }),
    ).resolves.toMatchObject({ previousBalance: 50, newBalance: 60 });
    await expect(
      admin.mutation(api.admin.paymentMutation.addTokens, {
        subscriptionId,
        tokensToAdd: 10,
        operationId: "00000000-0000-4000-8000-000000000006",
        adminNote: "Fund exact renewal settlement",
      }),
    ).resolves.toEqual({ success: true });
    const funded = await t.run(async (ctx) => ({
      subscription: await ctx.db.get(subscriptionId),
      boundary: await ctx.db
        .query("subscriptionBillingBoundaries")
        .withIndex("by_subscription_and_period_end", (q) =>
          q.eq("subscriptionId", subscriptionId).eq("periodEnd", periodEnd),
        )
        .unique(),
      inbox: await ctx.db.get(inboxId),
    }));
    expect(funded.subscription).toMatchObject({
      purchasedTokens: 60,
      billingBoundaryReconciliationRequired: true,
    });
    expect(funded.boundary).toMatchObject({
      status: "manual_review",
      manualReviewInvoiceId: invoice.invoiceId,
      manualReviewSettlementKeyFingerprint: invoice.settlementKeyFingerprint,
      manualReviewIdentityFingerprint: invoice.identityFingerprint,
    });
    expect(funded.inbox).toMatchObject({ status: "manual_review" });

    const requeueArgs = {
      manualReviewId: reviewId,
      evidenceReference: "ls-support-case-underfunded-7192",
      confirmRetry: true as const,
    };
    await expect(
      admin.mutation(
        api.admin.paymentMutation.requeueSubscriptionInvoiceReview,
        requeueArgs,
      ),
    ).resolves.toEqual({ success: true, idempotent: false });
    const reopened = await t.run(async (ctx) => ({
      subscription: await ctx.db.get(subscriptionId),
      boundary: await ctx.db
        .query("subscriptionBillingBoundaries")
        .withIndex("by_subscription_and_period_end", (q) =>
          q.eq("subscriptionId", subscriptionId).eq("periodEnd", periodEnd),
        )
        .unique(),
      inbox: await ctx.db.get(inboxId),
    }));
    expect(reopened.subscription).not.toHaveProperty(
      "billingBoundaryReconciliationRequired",
    );
    expect(reopened.subscription).not.toHaveProperty(
      "billingBoundaryManualReviewReason",
    );
    expect(reopened.boundary).toMatchObject({ status: "pending" });
    expect(reopened.boundary).not.toHaveProperty("manualReviewInvoiceId");
    expect(reopened.inbox).toMatchObject({
      status: "pending",
      attemptCount: 0,
    });

    await expect(
      t.action(internal.lemonSqueezy.webhook.processSubscriptionInvoiceInbox, {
        inboxId,
      }),
    ).resolves.toEqual({ outcome: "applied" });
    const settled = await t.run(async (ctx) => ({
      subscription: await ctx.db.get(subscriptionId),
      boundary: await ctx.db
        .query("subscriptionBillingBoundaries")
        .withIndex("by_subscription_and_period_end", (q) =>
          q.eq("subscriptionId", subscriptionId).eq("periodEnd", periodEnd),
        )
        .unique(),
      inbox: await ctx.db.get(inboxId),
      receipt: await ctx.db
        .query("paymentSettlementReceipts")
        .withIndex("by_settlement_key_fingerprint", (q) =>
          q.eq("settlementKeyFingerprint", invoice.settlementKeyFingerprint),
        )
        .unique(),
    }));
    expect(settled.subscription).toMatchObject({
      periodStart: periodEnd,
      purchasedTokens: 0,
    });
    expect(settled.boundary).toMatchObject({
      status: "settled",
      settlementReason: "renewal_invoice",
      purchasedTokensDebited: 60,
    });
    expect(settled.inbox).toBeNull();
    expect(settled.receipt).toMatchObject({ settlementType: "invoice" });
    await expect(
      admin.mutation(
        api.admin.paymentMutation.requeueSubscriptionInvoiceReview,
        requeueArgs,
      ),
    ).resolves.toEqual({ success: true, idempotent: true });
  });

  it("rejects underfunded recovery without enough wallet or an exact invoice binding", async () => {
    vi.useFakeTimers();
    const periodStart = Date.parse("2099-03-01T00:00:00.000Z");
    const periodEnd = Date.parse("2099-04-01T00:00:00.000Z");
    vi.setSystemTime(periodEnd + 1_000);
    const t = convexTest(schema, modules);
    const invoice = await invoiceArgs("4212", "7193", periodEnd);
    const { adminUserId, subscriptionId, inboxId, reviewId, boundaryId } =
      await t.run(async (ctx) => {
        const adminUserId = await ctx.db.insert("users", {});
        await ctx.db.insert("userProfiles", {
          userId: adminUserId,
          githubUsername: "invoice-recovery-admin",
          isAdmin: true,
          createdAt: periodEnd,
          updatedAt: periodEnd,
        });
        const userId = await ctx.db.insert("users", {});
        const subscriptionId = await ctx.db.insert("subscriptions", {
          userId,
          lemonSqueezySubscriptionId: invoice.subscriptionId,
          lemonSqueezyCustomerId: invoice.customerId,
          lemonSqueezyVariantId: PRO_VARIANT_ID,
          providerCreatedAt: periodStart,
          providerUpdatedAt: periodEnd,
          proEntitlementProvenance: {
            source: "lemon_squeezy_webhook",
            verifiedAt: periodStart,
          },
          plan: "pro",
          status: "active",
          includedTokens: PRO_INCLUDED_TOKENS,
          purchasedTokens: 50,
          serviceFeeRate: 0.18,
          periodStart,
          periodEnd,
          billingBoundaryReconciliationRequired: true,
          billingBoundaryManualReviewReason:
            "Purchased-token wallet cannot cover the exact renewal settlement.",
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
            status: "manual_review",
            manualReviewReason:
              "Purchased-token wallet cannot cover the exact renewal settlement.",
            manualReviewInvoiceId: invoice.invoiceId,
            manualReviewSettlementKeyFingerprint:
              invoice.settlementKeyFingerprint,
            manualReviewIdentityFingerprint: invoice.identityFingerprint,
            createdAt: periodStart,
            updatedAt: periodEnd,
          },
        );
        await ctx.db.insert("tokenUsage", {
          purchasedTokensDebited: 0,
          userId,
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
          createdAt: periodEnd - 1,
        });
        const inboxId = await ctx.db.insert("lemonSqueezyInvoiceInbox", {
          settlementKeyFingerprint: invoice.settlementKeyFingerprint,
          identityFingerprint: invoice.identityFingerprint,
          fingerprintVersion: 1,
          eventName: invoice.eventName,
          invoiceId: invoice.invoiceId,
          subscriptionId: invoice.subscriptionId,
          customerId: invoice.customerId,
          billingReason: invoice.billingReason,
          invoiceCreatedAt: invoice.invoiceCreatedAt,
          invoiceUpdatedAt: invoice.invoiceUpdatedAt,
          amountCents: invoice.amountCents,
          currency: invoice.currency,
          status: "manual_review",
          attemptCount: 96,
          nextAttemptAt: periodEnd,
          expiresAt: periodEnd + 365 * 24 * 60 * 60 * 1_000,
          createdAt: periodEnd,
          updatedAt: periodEnd,
        });
        const reviewId = await ctx.db.insert("paymentSettlementManualReviews", {
          settlementKeyFingerprint: invoice.settlementKeyFingerprint,
          identityFingerprint: invoice.identityFingerprint,
          fingerprintVersion: 1,
          reviewType: "invoice_processing",
          providerResourceId: invoice.invoiceId,
          invoiceInboxId: inboxId,
          lemonSqueezySubscriptionId: invoice.subscriptionId,
          amountCents: invoice.amountCents,
          currency: invoice.currency,
          reason: "Invoice processing exhausted automatic retries",
          status: "open",
          expiresAt: periodEnd + 365 * 24 * 60 * 60 * 1_000,
          createdAt: periodEnd,
          updatedAt: periodEnd,
        });
        return {
          adminUserId,
          subscriptionId,
          inboxId,
          reviewId,
          boundaryId,
        };
      });
    const admin = t.withIdentity({
      subject: `${adminUserId}|admin-session`,
    });
    const requeueArgs = {
      manualReviewId: reviewId,
      evidenceReference: "ls-support-case-underfunded-7193",
      confirmRetry: true as const,
    };

    await expect(
      admin.mutation(
        api.admin.paymentMutation.requeueSubscriptionInvoiceReview,
        requeueArgs,
      ),
    ).rejects.toThrow("still cannot cover the renewal settlement");
    await expect(
      admin.mutation(api.admin.paymentMutation.addTokens, {
        subscriptionId,
        tokensToAdd: 10,
        operationId: "00000000-0000-4000-8000-000000000007",
      }),
    ).resolves.toMatchObject({ previousBalance: 50, newBalance: 60 });
    await t.run(async (ctx) => {
      await ctx.db.patch(inboxId, { invoiceId: "7194" });
      await ctx.db.patch(reviewId, { providerResourceId: "7194" });
    });
    await expect(
      admin.mutation(
        api.admin.paymentMutation.requeueSubscriptionInvoiceReview,
        requeueArgs,
      ),
    ).rejects.toThrow("does not match its manual billing boundary");

    const state = await t.run(async (ctx) => ({
      subscription: await ctx.db.get(subscriptionId),
      boundary: await ctx.db.get(boundaryId),
      inbox: await ctx.db.get(inboxId),
      review: await ctx.db.get(reviewId),
    }));
    expect(state.subscription).toMatchObject({
      purchasedTokens: 60,
      billingBoundaryReconciliationRequired: true,
    });
    expect(state.boundary).toMatchObject({ status: "manual_review" });
    expect(state.inbox).toMatchObject({ status: "manual_review" });
    expect(state.review).toMatchObject({ status: "open" });
  });

  it("defers R2 until the earlier exact billing boundary is settled", async () => {
    vi.useFakeTimers();
    const createdAt = Date.parse("2100-01-01T00:00:00.000Z");
    const invoiceCreatedAt = Date.parse("2100-02-01T00:00:00.000Z");
    const secondInvoiceCreatedAt = Date.parse("2100-03-01T00:00:00.000Z");
    vi.setSystemTime(invoiceCreatedAt);
    const t = convexTest(schema, modules);
    await pinSettlementConfiguration(t, createdAt);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const firstInvoice = await invoiceArgs("4301", "7102", invoiceCreatedAt);
    const secondInvoice = await invoiceArgs(
      "4301",
      "7105",
      secondInvoiceCreatedAt,
    );

    await t.mutation(
      internal.subscriptions.internalMutation.syncLemonSqueezySubscription,
      {
        eventName: "subscription_created",
        userId,
        lemonSqueezySubscriptionId: "4301",
        lemonSqueezyCustomerId: "2201",
        lemonSqueezyVariantId: PRO_VARIANT_ID,
        status: "active",
        providerCreatedAt: createdAt,
        providerUpdatedAt: createdAt,
        periodEnd: invoiceCreatedAt,
      },
    );
    await t.mutation(
      internal.subscriptions.internalMutation.syncLemonSqueezySubscription,
      {
        eventName: "subscription_updated",
        lemonSqueezySubscriptionId: "4301",
        lemonSqueezyCustomerId: "2201",
        lemonSqueezyVariantId: PRO_VARIANT_ID,
        status: "active",
        providerCreatedAt: createdAt,
        providerUpdatedAt: invoiceCreatedAt,
        periodEnd: secondInvoiceCreatedAt,
      },
    );
    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.settleSubscriptionInvoice,
        secondInvoice,
      ),
    ).rejects.toThrow("Earlier subscription invoice has not settled");
    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.settleSubscriptionInvoice,
        firstInvoice,
      ),
    ).resolves.toMatchObject({ outcome: "applied" });
    vi.setSystemTime(secondInvoiceCreatedAt);
    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.settleSubscriptionInvoice,
        secondInvoice,
      ),
    ).resolves.toMatchObject({ outcome: "applied" });
  });

  it("settles historical boundaries without reviving terminal access", async () => {
    vi.useFakeTimers();
    const periodStart = Date.parse("2100-01-01T00:00:00.000Z");
    const invoiceCreatedAt = Date.parse("2100-02-01T00:00:00.000Z");
    const periodEnd = invoiceCreatedAt;
    vi.setSystemTime(invoiceCreatedAt);
    const t = convexTest(schema, modules);
    await pinSettlementConfiguration(t, periodStart);
    const { canceledId, expiredId } = await t.run(async (ctx) => {
      const canceledUserId = await ctx.db.insert("users", {});
      const expiredUserId = await ctx.db.insert("users", {});
      const base = {
        lemonSqueezyCustomerId: "2201",
        lemonSqueezyVariantId: PRO_VARIANT_ID,
        providerCreatedAt: periodStart,
        providerUpdatedAt: invoiceCreatedAt,
        proEntitlementProvenance: {
          source: "lemon_squeezy_webhook" as const,
          verifiedAt: periodStart,
        },
        plan: "pro" as const,
        includedTokens: PRO_INCLUDED_TOKENS,
        purchasedTokens: 100,
        serviceFeeRate: 0.18,
        periodStart,
        periodEnd,
        createdAt: periodStart,
        updatedAt: periodStart,
      };
      const canceledId = await ctx.db.insert("subscriptions", {
        ...base,
        userId: canceledUserId,
        lemonSqueezySubscriptionId: "4401",
        status: "canceled",
      });
      const expiredId = await ctx.db.insert("subscriptions", {
        ...base,
        userId: expiredUserId,
        lemonSqueezySubscriptionId: "4402",
        status: "expired",
      });
      return { canceledId, expiredId };
    });

    const canceledInvoice = await invoiceArgs("4401", "7103", invoiceCreatedAt);
    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.settleSubscriptionInvoice,
        canceledInvoice,
      ),
    ).resolves.toMatchObject({ outcome: "applied" });
    await expect(
      t.run(async (ctx) => ctx.db.get(canceledId)),
    ).resolves.toMatchObject({
      status: "canceled",
      periodStart: invoiceCreatedAt,
    });

    const expiredInvoice = await invoiceArgs("4402", "7104", invoiceCreatedAt);
    await expect(
      t.mutation(
        internal.subscriptions.internalMutation.settleSubscriptionInvoice,
        expiredInvoice,
      ),
    ).resolves.toMatchObject({ outcome: "applied" });
    await expect(
      t.run(async (ctx) => ctx.db.get(expiredId)),
    ).resolves.toMatchObject({
      status: "expired",
      periodStart: invoiceCreatedAt,
    });
  });
});
