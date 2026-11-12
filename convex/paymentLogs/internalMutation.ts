import { internalMutation, type MutationCtx } from "../_generated/server";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";

export type PaymentLogStatus =
  "success" | "failed" | "pending" | "refunded" | "canceled";

export type PaymentLogWriteArgs = {
  userId?: Id<"users">;
  lemonSqueezyEventId?: string;
  lemonSqueezyOrderId?: string;
  lemonSqueezyOrderCreatedAt?: number;
  lemonSqueezyInvoiceId?: string;
  lemonSqueezySubscriptionId?: string;
  lemonSqueezyCustomerId?: string;
  lemonSqueezyVariantId?: string;
  lemonSqueezyBillingReason?: string;
  lemonSqueezyInvoiceCreatedAt?: number;
  eventType: string;
  productType?: string;
  amountCents?: number;
  currency?: string;
  tokensAdded?: number;
  status: PaymentLogStatus;
  errorMessage?: string;
  createdAt?: number;
  settlementReceiptVerified?: boolean;
};

const PAYMENT_SUMMARY_COUNTER_FIELDS = [
  "totalRevenueCents",
  "totalTokensSold",
  "totalOrders",
  "proSubscriptionCount",
  "tokenPackSmallCount",
  "tokenPackLargeCount",
  "totalRefundedCents",
  "totalRefundedTokens",
] as const;
const LEMON_SQUEEZY_ID_PATTERN = /^[1-9]\d*$/;

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function checkedAdd(current: number, increment: number, label: string): number {
  assertNonNegativeSafeInteger(current, label);
  assertNonNegativeSafeInteger(increment, `${label} increment`);
  const next = current + increment;
  if (!Number.isSafeInteger(next)) {
    throw new Error(`${label} exceeds the supported range`);
  }
  return next;
}

function assertPaymentLogNumbers(args: PaymentLogWriteArgs): void {
  if (args.createdAt !== undefined) {
    assertNonNegativeSafeInteger(args.createdAt, "Payment log timestamp");
  }
  if (args.amountCents !== undefined) {
    assertNonNegativeSafeInteger(args.amountCents, "Payment amount");
  }
  if (
    args.tokensAdded !== undefined &&
    !Number.isSafeInteger(args.tokensAdded)
  ) {
    throw new Error("Payment token amount must be a safe integer");
  }
  if (
    args.status === "success" &&
    args.tokensAdded !== undefined &&
    args.tokensAdded < 0
  ) {
    throw new Error("Successful payment tokens cannot be negative");
  }
  if (args.settlementReceiptVerified && !hasAtomicSettlementReceipt(args)) {
    throw new Error("Payment log has no matching atomic settlement receipt");
  }
}

function assertPaymentSummary(
  summary: Awaited<ReturnType<typeof getOrCreateSummary>>,
): void {
  for (const field of PAYMENT_SUMMARY_COUNTER_FIELDS) {
    assertNonNegativeSafeInteger(summary[field], `Payment summary ${field}`);
  }
  assertNonNegativeSafeInteger(summary.updatedAt, "Payment summary timestamp");
}

function hasAtomicSettlementReceipt(args: PaymentLogWriteArgs): boolean {
  if (
    args.status === "refunded" &&
    args.eventType === "order_refunded" &&
    (args.productType === "token_pack_small" ||
      args.productType === "token_pack_large")
  ) {
    return LEMON_SQUEEZY_ID_PATTERN.test(args.lemonSqueezyOrderId ?? "");
  }
  if (args.status !== "success") return false;
  if (
    args.eventType === "order_created" &&
    (args.productType === "token_pack_small" ||
      args.productType === "token_pack_large")
  ) {
    return LEMON_SQUEEZY_ID_PATTERN.test(args.lemonSqueezyOrderId ?? "");
  }
  if (
    (args.eventType === "subscription_payment_success" ||
      args.eventType === "subscription_payment_recovered") &&
    args.productType === "pro"
  ) {
    return LEMON_SQUEEZY_ID_PATTERN.test(args.lemonSqueezyInvoiceId ?? "");
  }
  return false;
}

/**
 * Get or create the global payment stats summary
 * Returns a non-null summary document
 */
async function getOrCreateSummary(ctx: MutationCtx) {
  const existing = await ctx.db
    .query("paymentStatsSummary")
    .withIndex("by_key", (q) => q.eq("key", "global"))
    .take(2);

  if (existing.length > 1) {
    throw new Error("Duplicate global payment summaries");
  }
  if (existing[0]) return existing[0];

  // Create initial summary
  const id = await ctx.db.insert("paymentStatsSummary", {
    key: "global" as const,
    totalRevenueCents: 0,
    totalTokensSold: 0,
    totalOrders: 0,
    proSubscriptionCount: 0,
    tokenPackSmallCount: 0,
    tokenPackLargeCount: 0,
    totalRefundedCents: 0,
    totalRefundedTokens: 0,
    updatedAt: Date.now(),
  });

  const created = await ctx.db.get(id);
  if (!created) throw new Error("Failed to create payment stats summary");
  return created;
}

/** Insert one payment log and update its summary in the caller's transaction. */
export async function createPaymentLogInTransaction(
  ctx: MutationCtx,
  args: PaymentLogWriteArgs,
): Promise<Id<"paymentLogs">> {
  assertPaymentLogNumbers(args);
  const createdAt = args.createdAt ?? Date.now();
  assertNonNegativeSafeInteger(createdAt, "Payment log timestamp");

  let summaryUpdates: Record<string, number> | null = null;
  let summaryId: Id<"paymentStatsSummary"> | null = null;
  if (args.status === "success" || args.status === "refunded") {
    const summary = await getOrCreateSummary(ctx);
    assertPaymentSummary(summary);
    summaryId = summary._id;
    summaryUpdates = { updatedAt: createdAt };

    if (args.status === "success") {
      if (args.amountCents !== undefined) {
        summaryUpdates.totalRevenueCents = checkedAdd(
          summary.totalRevenueCents,
          args.amountCents,
          "Payment summary totalRevenueCents",
        );
      }
      if (args.tokensAdded !== undefined) {
        summaryUpdates.totalTokensSold = checkedAdd(
          summary.totalTokensSold,
          args.tokensAdded,
          "Payment summary totalTokensSold",
        );
      }

      summaryUpdates.totalOrders = checkedAdd(
        summary.totalOrders,
        1,
        "Payment summary totalOrders",
      );
      if (args.productType === "pro") {
        summaryUpdates.proSubscriptionCount = checkedAdd(
          summary.proSubscriptionCount,
          1,
          "Payment summary proSubscriptionCount",
        );
      } else if (args.productType === "token_pack_small") {
        summaryUpdates.tokenPackSmallCount = checkedAdd(
          summary.tokenPackSmallCount,
          1,
          "Payment summary tokenPackSmallCount",
        );
      } else if (args.productType === "token_pack_large") {
        summaryUpdates.tokenPackLargeCount = checkedAdd(
          summary.tokenPackLargeCount,
          1,
          "Payment summary tokenPackLargeCount",
        );
      }
    } else {
      if (args.amountCents !== undefined) {
        summaryUpdates.totalRefundedCents = checkedAdd(
          summary.totalRefundedCents,
          args.amountCents,
          "Payment summary totalRefundedCents",
        );
      }
      if (args.tokensAdded !== undefined && args.tokensAdded < 0) {
        summaryUpdates.totalRefundedTokens = checkedAdd(
          summary.totalRefundedTokens,
          Math.abs(args.tokensAdded),
          "Payment summary totalRefundedTokens",
        );
      }
    }
  }

  const logId = await ctx.db.insert("paymentLogs", {
    userId: args.userId,
    lemonSqueezyEventId: args.lemonSqueezyEventId,
    lemonSqueezyOrderId: args.lemonSqueezyOrderId,
    lemonSqueezyOrderCreatedAt: args.lemonSqueezyOrderCreatedAt,
    lemonSqueezyInvoiceId: args.lemonSqueezyInvoiceId,
    lemonSqueezySubscriptionId: args.lemonSqueezySubscriptionId,
    lemonSqueezyCustomerId: args.lemonSqueezyCustomerId,
    lemonSqueezyVariantId: args.lemonSqueezyVariantId,
    lemonSqueezyBillingReason: args.lemonSqueezyBillingReason,
    lemonSqueezyInvoiceCreatedAt: args.lemonSqueezyInvoiceCreatedAt,
    eventType: args.eventType,
    productType: args.productType,
    amountCents: args.amountCents,
    currency: args.currency,
    tokensAdded: args.tokensAdded,
    status: args.status,
    errorMessage: args.errorMessage,
    createdAt,
  });

  if (summaryId && summaryUpdates) {
    await ctx.db.patch(summaryId, summaryUpdates);
  }

  return logId;
}

/**
 * Create a payment log entry and update summary stats
 */
export const createLog = internalMutation({
  args: {
    userId: v.optional(v.string()),
    lemonSqueezyEventId: v.optional(v.string()),
    lemonSqueezyOrderId: v.optional(v.string()),
    lemonSqueezyOrderCreatedAt: v.optional(v.number()),
    lemonSqueezyInvoiceId: v.optional(v.string()),
    lemonSqueezySubscriptionId: v.optional(v.string()),
    lemonSqueezyCustomerId: v.optional(v.string()),
    lemonSqueezyVariantId: v.optional(v.string()),
    lemonSqueezyBillingReason: v.optional(v.string()),
    lemonSqueezyInvoiceCreatedAt: v.optional(v.number()),
    eventType: v.string(),
    productType: v.optional(v.string()),
    amountCents: v.optional(v.number()),
    currency: v.optional(v.string()),
    tokensAdded: v.optional(v.number()),
    status: v.union(
      v.literal("success"),
      v.literal("failed"),
      v.literal("pending"),
      v.literal("refunded"),
      v.literal("canceled"),
    ),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { userId, ...sanitizedArgs } = args;
    return await createPaymentLogInTransaction(ctx, {
      ...sanitizedArgs,
      userId: userId as Id<"users"> | undefined,
    });
  },
});

/**
 * Update a payment log status
 */
export const updateLogStatus = internalMutation({
  args: {
    logId: v.id("paymentLogs"),
    status: v.union(
      v.literal("success"),
      v.literal("failed"),
      v.literal("pending"),
      v.literal("refunded"),
      v.literal("canceled"),
    ),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.logId, {
      status: args.status,
      errorMessage: args.errorMessage,
    });
  },
});
