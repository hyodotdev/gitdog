import { mutation } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { v } from "convex/values";
import { hasOpenUsageReservation } from "../_ai/chatBilling";
import { PRICING } from "../_ai/config";
import {
  ensureBillingBoundary,
  INVOICE_BOUNDARY_TOLERANCE_MS,
  MAX_MONTHLY_BOUNDARY_SPAN_MS,
  readCurrentTrustedProPurchasedTokenLiability,
  RENEWAL_INVOICE_WALLET_UNDERFUNDED_REASON,
  settleAllEndedTrustedProQuotas,
} from "../subscriptions/billingBoundaries";
import {
  getSubscriptionForEntitlement,
  hasTrustedProEntitlement,
  isLemonProviderProvenance,
} from "../subscriptions/entitlement";
import { refreshFreeSubscriptionPeriod } from "../subscriptions/quotaEntitlement";
import {
  consolidatePurchasedTokenWallet,
  debitPurchasedTokenWallet,
  getUserWalletRows,
  readPurchasedTokenWalletBalance,
} from "../subscriptions/wallet";
import {
  reconcileChatUsageInTransaction,
  reconcilePaidEmbeddingUsageInTransaction,
} from "../tokenUsage/internalMutation";
import { readQuotaTokenUsage } from "../tokenUsage/quota";
import { checkAdmin } from "./utils";

const embeddingReconciliationEvidenceSourceValidator = v.union(
  v.literal("google_api_response"),
  v.literal("google_cloud_billing_export"),
  v.literal("google_support_confirmation"),
  v.literal("openai_api_response"),
  v.literal("openai_billing_export"),
  v.literal("openai_support_confirmation"),
);

const chatReconciliationEvidenceSourceValidator = v.union(
  v.literal("google_api_response"),
  v.literal("google_cloud_billing_export"),
  v.literal("google_support_confirmation"),
  v.literal("anthropic_api_response"),
  v.literal("anthropic_usage_report"),
  v.literal("anthropic_support_confirmation"),
  v.literal("openai_api_response"),
  v.literal("openai_usage_report"),
  v.literal("openai_support_confirmation"),
);

const MAX_TERMINAL_SETTLEMENT_SCHEDULE_DELAY_MS = 24 * 24 * 60 * 60 * 1_000;
const SETTLEMENT_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const ADMIN_OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function getExistingAdminOperation(
  ctx: MutationCtx,
  operationId: string,
  eventType: string,
  userId: Doc<"subscriptions">["userId"],
): Promise<Doc<"paymentLogs"> | null> {
  if (!ADMIN_OPERATION_ID_PATTERN.test(operationId)) {
    throw new Error("Invalid admin operation ID");
  }
  const existing = await ctx.db
    .query("paymentLogs")
    .withIndex("by_admin_operation", (q) =>
      q.eq("adminOperationId", operationId),
    )
    .unique();
  if (
    existing &&
    (existing.eventType !== eventType || existing.userId !== userId)
  ) {
    throw new Error("Admin operation ID was already used for another action");
  }
  return existing;
}

async function getTrustedLemonSubscriptionForInvoiceRecovery(
  ctx: MutationCtx,
  lemonSqueezySubscriptionId: string,
): Promise<Doc<"subscriptions"> | null> {
  const rows = await ctx.db
    .query("subscriptions")
    .withIndex("by_lemon_squeezy_subscription_and_provenance_source", (q) =>
      q
        .eq("lemonSqueezySubscriptionId", lemonSqueezySubscriptionId)
        .eq("proEntitlementProvenance.source", "lemon_squeezy_webhook"),
    )
    .take(2);
  if (rows.length > 1) {
    throw new Error("Duplicate trusted billing subscriptions");
  }
  return rows[0] ?? null;
}

async function getExactUnderfundedRenewalBoundary(
  ctx: MutationCtx,
  subscription: Doc<"subscriptions">,
): Promise<Doc<"subscriptionBillingBoundaries"> | null> {
  if (
    subscription.plan !== "pro" ||
    !isLemonProviderProvenance(subscription.proEntitlementProvenance?.source)
  ) {
    return null;
  }
  const manualBoundaries = await ctx.db
    .query("subscriptionBillingBoundaries")
    .withIndex("by_subscription_status_and_period_end", (q) =>
      q.eq("subscriptionId", subscription._id).eq("status", "manual_review"),
    )
    .take(2);
  const hasReviewState =
    subscription.billingBoundaryReconciliationRequired === true ||
    subscription.billingBoundaryManualReviewReason !== undefined ||
    manualBoundaries.length > 0;
  if (!hasReviewState) return null;
  if (
    subscription.billingBoundaryReconciliationRequired !== true ||
    subscription.billingBoundaryManualReviewReason !==
      RENEWAL_INVOICE_WALLET_UNDERFUNDED_REASON ||
    manualBoundaries.length !== 1
  ) {
    throw new Error(
      "Subscription billing boundary is not eligible for invoice recovery",
    );
  }
  const boundary = manualBoundaries[0];
  if (
    boundary.manualReviewReason !== RENEWAL_INVOICE_WALLET_UNDERFUNDED_REASON ||
    !boundary.manualReviewInvoiceId ||
    !SETTLEMENT_FINGERPRINT_PATTERN.test(
      boundary.manualReviewSettlementKeyFingerprint ?? "",
    ) ||
    !SETTLEMENT_FINGERPRINT_PATTERN.test(
      boundary.manualReviewIdentityFingerprint ?? "",
    ) ||
    boundary.settledInvoiceCreatedAt !== undefined ||
    boundary.settlementReason !== undefined ||
    boundary.purchasedTokensDebited !== undefined
  ) {
    throw new Error(
      "Subscription billing boundary recovery evidence is incomplete",
    );
  }
  return boundary;
}

async function reopenExactUnderfundedRenewalBoundary(
  ctx: MutationCtx,
  inbox: Doc<"lemonSqueezyInvoiceInbox">,
): Promise<boolean> {
  const subscription = await getTrustedLemonSubscriptionForInvoiceRecovery(
    ctx,
    inbox.subscriptionId,
  );
  if (!subscription) return false;
  const boundary = await getExactUnderfundedRenewalBoundary(ctx, subscription);
  if (!boundary) return false;
  if (
    inbox.billingReason !== "renewal" ||
    subscription.lemonSqueezyCustomerId !== inbox.customerId ||
    subscription.periodStart !== boundary.periodStart ||
    subscription.includedTokens !== PRICING.PRO_INCLUDED_TOKENS ||
    boundary.manualReviewInvoiceId !== inbox.invoiceId ||
    boundary.manualReviewSettlementKeyFingerprint !==
      inbox.settlementKeyFingerprint ||
    boundary.manualReviewIdentityFingerprint !== inbox.identityFingerprint ||
    !Number.isSafeInteger(boundary.periodStart) ||
    boundary.periodStart < 0 ||
    !Number.isSafeInteger(boundary.periodEnd) ||
    boundary.periodEnd <= boundary.periodStart ||
    Math.abs(inbox.invoiceCreatedAt - boundary.periodEnd) >
      INVOICE_BOUNDARY_TOLERANCE_MS
  ) {
    throw new Error("Invoice does not match its manual billing boundary");
  }
  const earlierPending = await ctx.db
    .query("subscriptionBillingBoundaries")
    .withIndex("by_subscription_status_and_period_end", (q) =>
      q.eq("subscriptionId", subscription._id).eq("status", "pending"),
    )
    .order("asc")
    .first();
  if (earlierPending && earlierPending.periodEnd <= boundary.periodEnd) {
    throw new Error(
      "An earlier subscription billing boundary is still pending",
    );
  }
  if (await hasOpenUsageReservation(ctx, subscription.userId)) {
    throw new Error(
      "Invoice recovery is blocked until provider usage is finalized",
    );
  }
  const usage = await readQuotaTokenUsage(ctx, {
    userId: subscription.userId,
    periodStart: boundary.periodStart,
    periodEndExclusive: boundary.periodEnd,
  });
  if (!usage.verified) {
    throw new Error("Usage history is too large to recover invoice safely");
  }
  const purchasedTokensRequiredBefore = Math.max(
    0,
    usage.tokensUsed - subscription.includedTokens,
  );
  if (usage.purchasedTokensDebited > purchasedTokensRequiredBefore) {
    throw new Error("Invoice usage debit history cannot be verified safely");
  }
  const purchasedTokensRequired =
    purchasedTokensRequiredBefore - usage.purchasedTokensDebited;
  const walletBalance = await readPurchasedTokenWalletBalance(
    ctx,
    subscription.userId,
  );
  if (walletBalance < purchasedTokensRequired) {
    throw new Error(
      "Purchased-token wallet still cannot cover the renewal settlement",
    );
  }

  const now = Date.now();
  await ctx.db.patch(boundary._id, {
    status: "pending",
    manualReviewReason: undefined,
    manualReviewInvoiceId: undefined,
    manualReviewSettlementKeyFingerprint: undefined,
    manualReviewIdentityFingerprint: undefined,
    updatedAt: now,
  });
  await ctx.db.patch(subscription._id, {
    billingBoundaryReconciliationRequired: undefined,
    billingBoundaryManualReviewReason: undefined,
    updatedAt: now,
  });
  return true;
}

/** Admin: resolve one ambiguous AI attempt from provider evidence. */
export const reconcileChatUsage = mutation({
  args: {
    reservationKey: v.string(),
    evidenceSource: chatReconciliationEvidenceSourceValidator,
    evidenceReference: v.string(),
    outcome: v.union(
      v.object({ kind: v.literal("known_not_billed") }),
      v.object({
        kind: v.literal("known_billed"),
        actualInputTokens: v.number(),
        actualOutputTokens: v.number(),
        providerRequestId: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const { isAdmin, userId: adminUserId } = await checkAdmin(ctx);
    if (!isAdmin || !adminUserId) {
      throw new Error("Unauthorized: Admin access required");
    }
    return await reconcileChatUsageInTransaction(ctx, {
      ...args,
      reconciledBy: adminUserId,
    });
  },
});

/** Admin: resolve one ambiguous paid AI attempt from provider evidence. */
export const reconcileEmbeddingUsage = mutation({
  args: {
    reservationKey: v.string(),
    evidenceSource: embeddingReconciliationEvidenceSourceValidator,
    evidenceReference: v.string(),
    outcome: v.union(
      v.object({ kind: v.literal("known_not_billed") }),
      v.object({
        kind: v.literal("known_billed"),
        actualProviderTokens: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const { isAdmin, userId: adminUserId } = await checkAdmin(ctx);
    if (!isAdmin || !adminUserId) {
      throw new Error("Unauthorized: Admin access required");
    }

    return await reconcilePaidEmbeddingUsageInTransaction(ctx, {
      ...args,
      reconciledBy: adminUserId,
    });
  },
});

/**
 * Admin: Refund tokens from a user's subscription
 * Use to reverse a manual admin credit. Lemon Squeezy refunds are settled by
 * its webhook and are rejected here.
 */
export const refundTokens = mutation({
  args: {
    subscriptionId: v.id("subscriptions"),
    tokensToRefund: v.number(),
    adminNote: v.optional(v.string()),
    paymentLogId: v.id("paymentLogs"),
  },
  handler: async (ctx, args) => {
    const { isAdmin, userId: adminUserId } = await checkAdmin(ctx);
    if (!isAdmin) {
      throw new Error("Unauthorized: Admin access required");
    }

    const subscription = await ctx.db.get(args.subscriptionId);
    if (!subscription) {
      throw new Error("Subscription not found");
    }
    const paymentLog = await ctx.db.get(args.paymentLogId);
    if (
      !paymentLog ||
      paymentLog.userId !== subscription.userId ||
      paymentLog.eventType !== "admin_credit" ||
      paymentLog.productType !== "token_pack" ||
      paymentLog.tokensAdded !== args.tokensToRefund
    ) {
      throw new Error("Refund must match a manual token credit for this user");
    }
    if (
      paymentLog.lemonSqueezyOrderId ||
      paymentLog.lemonSqueezyEventId ||
      paymentLog.lemonSqueezySubscriptionId
    ) {
      throw new Error("Lemon Squeezy refunds must be processed by its webhook");
    }
    if (paymentLog.status === "refunded") {
      return { success: true, alreadyRefunded: true };
    }
    if (paymentLog.status !== "success") {
      throw new Error("Only a successful manual credit can be refunded");
    }
    if (
      !Number.isSafeInteger(args.tokensToRefund) ||
      args.tokensToRefund <= 0
    ) {
      throw new Error("Refund amount must be a positive safe integer");
    }

    const now = Date.now();
    if (await hasOpenUsageReservation(ctx, subscription.userId)) {
      throw new Error(
        "Refund is blocked until in-flight provider usage is finalized or reconciled",
      );
    }
    const walletSubscription = await getSubscriptionForEntitlement(
      ctx,
      subscription.userId,
      now,
    );
    if (!walletSubscription) {
      throw new Error("Refund user has no canonical wallet");
    }
    await settleAllEndedTrustedProQuotas(ctx, subscription.userId, now);
    const currentProLiability =
      await readCurrentTrustedProPurchasedTokenLiability(
        ctx,
        walletSubscription,
        now,
      );
    if (!currentProLiability.verified) {
      throw new Error("Current Pro billing period requires reconciliation");
    }
    await refreshFreeSubscriptionPeriod(ctx, walletSubscription, now);
    const walletBalance = await readPurchasedTokenWalletBalance(
      ctx,
      subscription.userId,
    );
    if (walletBalance < args.tokensToRefund) {
      throw new Error("Purchased token balance is too small for this refund");
    }
    if (
      walletBalance - args.tokensToRefund <
      currentProLiability.outstandingTokens
    ) {
      throw new Error(
        "Refund would consume tokens reserved for current Pro usage",
      );
    }
    const debit = await debitPurchasedTokenWallet(ctx, {
      userId: subscription.userId,
      targetSubscriptionId: walletSubscription._id,
      tokensToDebit: args.tokensToRefund,
      now,
    });
    if (debit.debited !== args.tokensToRefund) {
      throw new Error("Purchased token balance is too small for this refund");
    }
    const currentPurchased = debit.remaining + debit.debited;
    const newPurchased = debit.remaining;

    // Update payment log if provided
    await ctx.db.patch(args.paymentLogId, {
      status: "refunded",
      adminNote: args.adminNote,
      refundedAt: now,
      refundedBy: adminUserId || undefined,
    });

    // Create a payment log for the refund action
    await ctx.db.insert("paymentLogs", {
      userId: subscription.userId,
      eventType: "admin_refund",
      productType: "token_pack",
      tokensAdded: -args.tokensToRefund,
      status: "refunded",
      adminNote: args.adminNote || `Refunded ${args.tokensToRefund} tokens`,
      refundedAt: Date.now(),
      refundedBy: adminUserId || undefined,
      createdAt: now,
    });

    console.log("Admin refunded tokens:", {
      subscriptionId: args.subscriptionId,
      tokensRefunded: args.tokensToRefund,
      previousBalance: currentPurchased,
      newBalance: newPurchased,
      adminUserId,
    });

    return {
      success: true,
      previousBalance: currentPurchased,
      newBalance: newPurchased,
    };
  },
});

/**
 * Admin: Add tokens to a user's subscription (manual credit)
 */
export const addTokens = mutation({
  args: {
    subscriptionId: v.id("subscriptions"),
    tokensToAdd: v.number(),
    operationId: v.string(),
    adminNote: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { isAdmin, userId: adminUserId } = await checkAdmin(ctx);
    if (!isAdmin) {
      throw new Error("Unauthorized: Admin access required");
    }

    const subscription = await ctx.db.get(args.subscriptionId);
    if (!subscription) {
      throw new Error("Subscription not found");
    }
    if (!Number.isSafeInteger(args.tokensToAdd) || args.tokensToAdd <= 0) {
      throw new Error("Credit amount must be a positive safe integer");
    }
    const existingOperation = await getExistingAdminOperation(
      ctx,
      args.operationId,
      "admin_credit",
      subscription.userId,
    );
    if (existingOperation) {
      return { success: true };
    }

    const now = Date.now();
    const fundableBoundary = await getExactUnderfundedRenewalBoundary(
      ctx,
      subscription,
    );
    if (!fundableBoundary) {
      await refreshFreeSubscriptionPeriod(ctx, subscription, now);
    }
    const newPurchased = await consolidatePurchasedTokenWallet(ctx, {
      userId: subscription.userId,
      targetSubscriptionId: subscription._id,
      tokensToAdd: args.tokensToAdd,
      now,
    });
    const currentPurchased = newPurchased - args.tokensToAdd;

    // Create a payment log for the manual credit
    await ctx.db.insert("paymentLogs", {
      userId: subscription.userId,
      adminOperationId: args.operationId,
      eventType: "admin_credit",
      productType: "token_pack",
      tokensAdded: args.tokensToAdd,
      status: "success",
      adminNote: args.adminNote || `Admin added ${args.tokensToAdd} tokens`,
      createdAt: now,
    });

    console.log("Admin added tokens:", {
      subscriptionId: args.subscriptionId,
      tokensAdded: args.tokensToAdd,
      previousBalance: currentPurchased,
      newBalance: newPurchased,
      adminUserId,
    });

    return {
      success: true,
      previousBalance: currentPurchased,
      newBalance: newPurchased,
    };
  },
});

/**
 * Admin: Cancel a subscription manually
 */
export const cancelSubscription = mutation({
  args: {
    subscriptionId: v.id("subscriptions"),
    operationId: v.string(),
    adminNote: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { isAdmin, userId: adminUserId } = await checkAdmin(ctx);
    if (!isAdmin) {
      throw new Error("Unauthorized: Admin access required");
    }

    const subscription = await ctx.db.get(args.subscriptionId);
    if (!subscription) {
      throw new Error("Subscription not found");
    }
    if (
      isLemonProviderProvenance(subscription.proEntitlementProvenance?.source)
    ) {
      throw new Error(
        "Lemon Squeezy subscriptions must be canceled in Lemon Squeezy",
      );
    }
    const existingOperation = await getExistingAdminOperation(
      ctx,
      args.operationId,
      "admin_cancel",
      subscription.userId,
    );
    if (existingOperation) {
      return { success: true };
    }
    const now = Date.now();
    await ctx.db.patch(args.subscriptionId, {
      status: "canceled",
      updatedAt: now,
    });
    if (
      subscription.plan === "pro" &&
      subscription.proEntitlementProvenance &&
      Number.isSafeInteger(subscription.periodEnd)
    ) {
      await ctx.scheduler.runAfter(
        Math.max(0, subscription.periodEnd - now),
        internal.subscriptions.internalMutation.settleEndedProSubscription,
        { subscriptionId: subscription._id },
      );
    }

    // Create a payment log for the cancellation
    await ctx.db.insert("paymentLogs", {
      userId: subscription.userId,
      adminOperationId: args.operationId,
      lemonSqueezySubscriptionId: subscription.lemonSqueezySubscriptionId,
      eventType: "admin_cancel",
      productType: subscription.plan,
      status: "canceled",
      adminNote: args.adminNote || "Subscription canceled by admin",
      createdAt: Date.now(),
    });

    console.log("Admin canceled subscription:", {
      subscriptionId: args.subscriptionId,
      adminUserId,
    });

    return { success: true };
  },
});

/**
 * Admin: Reactivate a subscription manually
 */
export const reactivateSubscription = mutation({
  args: {
    subscriptionId: v.id("subscriptions"),
    operationId: v.string(),
    adminNote: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { isAdmin, userId: adminUserId } = await checkAdmin(ctx);
    if (!isAdmin) {
      throw new Error("Unauthorized: Admin access required");
    }

    const subscription = await ctx.db.get(args.subscriptionId);
    if (!subscription) {
      throw new Error("Subscription not found");
    }
    if (
      isLemonProviderProvenance(subscription.proEntitlementProvenance?.source)
    ) {
      throw new Error(
        "Lemon Squeezy subscriptions must be reactivated in Lemon Squeezy",
      );
    }
    const existingOperation = await getExistingAdminOperation(
      ctx,
      args.operationId,
      "admin_reactivate",
      subscription.userId,
    );
    if (existingOperation) {
      return { success: true };
    }

    const now = Date.now();
    const thirtyDaysLater = now + 30 * 24 * 60 * 60 * 1000;

    if (subscription.plan === "free") {
      await refreshFreeSubscriptionPeriod(ctx, subscription, now);
      await ctx.db.patch(args.subscriptionId, {
        status: "active",
        periodStart: now,
        periodEnd: thirtyDaysLater,
        updatedAt: now,
      });
    } else {
      const walletRows = await getUserWalletRows(ctx, subscription.userId);
      if (
        walletRows.some(
          (row) =>
            row._id !== subscription._id && hasTrustedProEntitlement(row, now),
        )
      ) {
        throw new Error("User already has an active trusted subscription");
      }

      const preserveExistingPeriod = hasTrustedProEntitlement(
        subscription,
        now,
      );
      await settleAllEndedTrustedProQuotas(ctx, subscription.userId, now);

      if (preserveExistingPeriod) {
        if (
          !Number.isSafeInteger(subscription.periodStart) ||
          subscription.periodStart < 0 ||
          !Number.isSafeInteger(subscription.periodEnd) ||
          subscription.periodStart > now ||
          subscription.periodEnd <= subscription.periodStart ||
          subscription.periodEnd - subscription.periodStart >
            MAX_MONTHLY_BOUNDARY_SPAN_MS ||
          subscription.billingBoundaryReconciliationRequired ||
          subscription.billingBoundaryManualReviewReason !== undefined
        ) {
          throw new Error(
            "Existing Pro billing period requires reconciliation",
          );
        }
        await ensureBillingBoundary(ctx, {
          subscriptionId: subscription._id,
          periodStart: subscription.periodStart,
          periodEnd: subscription.periodEnd,
          providerUpdatedAt:
            subscription.providerUpdatedAt ??
            subscription.proEntitlementProvenance!.verifiedAt,
          now,
        });
        if (subscription.status === "active") {
          return { success: true };
        }
        await ctx.db.patch(args.subscriptionId, {
          status: "active",
          updatedAt: now,
        });
        await ctx.scheduler.runAfter(
          Math.min(
            Math.max(0, subscription.periodEnd - now),
            MAX_TERMINAL_SETTLEMENT_SCHEDULE_DELAY_MS,
          ),
          internal.subscriptions.internalMutation.settleEndedProSubscription,
          { subscriptionId: subscription._id },
        );
      } else {
        await ensureBillingBoundary(ctx, {
          subscriptionId: subscription._id,
          periodStart: now,
          periodEnd: thirtyDaysLater,
          providerUpdatedAt: now,
          now,
        });
        await ctx.db.patch(args.subscriptionId, {
          status: "active",
          periodStart: now,
          periodEnd: thirtyDaysLater,
          proEntitlementProvenance: {
            source: "admin_override",
            verifiedAt: now,
          },
          updatedAt: now,
        });
        await ctx.scheduler.runAfter(
          Math.min(
            thirtyDaysLater - now,
            MAX_TERMINAL_SETTLEMENT_SCHEDULE_DELAY_MS,
          ),
          internal.subscriptions.internalMutation.settleEndedProSubscription,
          { subscriptionId: subscription._id },
        );
      }
    }

    // Create a payment log
    await ctx.db.insert("paymentLogs", {
      userId: subscription.userId,
      adminOperationId: args.operationId,
      lemonSqueezySubscriptionId: subscription.lemonSqueezySubscriptionId,
      eventType: "admin_reactivate",
      productType: subscription.plan,
      status: "success",
      adminNote: args.adminNote || "Subscription reactivated by admin",
      createdAt: now,
    });

    console.log("Admin reactivated subscription:", {
      subscriptionId: args.subscriptionId,
      adminUserId,
    });

    return { success: true };
  },
});

/**
 * Admin: Update payment log status/note
 */
export const updatePaymentLog = mutation({
  args: {
    paymentLogId: v.id("paymentLogs"),
    status: v.optional(
      v.union(
        v.literal("success"),
        v.literal("failed"),
        v.literal("pending"),
        v.literal("refunded"),
        v.literal("canceled"),
      ),
    ),
    adminNote: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) {
      throw new Error("Unauthorized: Admin access required");
    }

    const updates: {
      status?: "success" | "failed" | "pending" | "refunded" | "canceled";
      adminNote?: string;
    } = {};
    if (args.status) updates.status = args.status;
    if (args.adminNote) updates.adminNote = args.adminNote;

    await ctx.db.patch(args.paymentLogId, updates);

    return { success: true };
  },
});

/** Admin: requeue one terminal invoice after recording external evidence. */
export const requeueSubscriptionInvoiceReview = mutation({
  args: {
    manualReviewId: v.id("paymentSettlementManualReviews"),
    evidenceReference: v.string(),
    confirmRetry: v.literal(true),
  },
  handler: async (ctx, args) => {
    const { isAdmin, userId: adminUserId } = await checkAdmin(ctx);
    if (!isAdmin || !adminUserId) {
      throw new Error("Unauthorized: Admin access required");
    }
    const evidenceReference = args.evidenceReference.trim();
    if (evidenceReference.length === 0 || evidenceReference.length > 500) {
      throw new Error("A bounded provider evidence reference is required");
    }

    const review = await ctx.db.get(args.manualReviewId);
    if (!review || review.reviewType !== "invoice_processing") {
      throw new Error("Invoice processing review not found");
    }
    if (
      review.status === "resolved" &&
      review.resolutionAction === "requeue" &&
      review.resolutionEvidenceReference === evidenceReference
    ) {
      return { success: true, idempotent: true };
    }
    if (review.status !== "open") {
      throw new Error("Invoice processing review was already resolved");
    }
    if (!review.invoiceInboxId) {
      throw new Error("Invoice processing review has no durable inbox binding");
    }

    const inbox = await ctx.db.get(review.invoiceInboxId);
    if (!inbox) {
      throw new Error("Invoice processing inbox no longer exists");
    }
    if (
      inbox.status !== "manual_review" ||
      inbox.settlementKeyFingerprint !== review.settlementKeyFingerprint ||
      inbox.identityFingerprint !== review.identityFingerprint ||
      inbox.invoiceId !== review.providerResourceId ||
      inbox.subscriptionId !== review.lemonSqueezySubscriptionId
    ) {
      throw new Error("Invoice processing review conflicts with durable inbox");
    }

    const receipts = await ctx.db
      .query("paymentSettlementReceipts")
      .withIndex("by_settlement_key_fingerprint", (q) =>
        q.eq("settlementKeyFingerprint", review.settlementKeyFingerprint),
      )
      .take(2);
    if (receipts.length > 0) {
      throw new Error("Invoice processing review conflicts with a settlement");
    }

    await reopenExactUnderfundedRenewalBoundary(ctx, inbox);
    const now = Date.now();
    await ctx.db.patch(review._id, {
      status: "resolved",
      resolutionAction: "requeue",
      resolutionEvidenceReference: evidenceReference,
      resolvedAt: now,
      resolvedBy: adminUserId,
      updatedAt: now,
    });
    await ctx.db.patch(inbox._id, {
      status: "pending",
      attemptCount: 0,
      leaseToken: undefined,
      nextAttemptAt: now,
      lastError: undefined,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.lemonSqueezy.webhook.processSubscriptionInvoiceInbox,
      { inboxId: inbox._id },
    );

    return { success: true, idempotent: false };
  },
});
