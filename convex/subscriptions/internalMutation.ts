import { internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { v } from "convex/values";
import { createPaymentLogInTransaction } from "../paymentLogs/internalMutation";
import { assertAndPinSettlementConfiguration } from "../paymentLogs/settlementConfiguration";
import { hasOpenUsageReservation } from "../_ai/chatBilling";
import { readQuotaTokenUsage } from "../tokenUsage/quota";
import {
  checkBillingBoundaryProviderHolds,
  INVOICE_BOUNDARY_TOLERANCE_MS,
  readCurrentTrustedProPurchasedTokenLiability,
  RENEWAL_INVOICE_WALLET_UNDERFUNDED_REASON,
  settleAllEndedTrustedProQuotas,
  settleEndedTrustedProSubscriptionQuota,
  synchronizeBillingBoundaryQueue as synchronizeExactBillingBoundaryQueue,
  TerminalProQuotaUnavailableError,
} from "./billingBoundaries";
import { PRICING } from "../_ai/config";
import {
  getSubscriptionForEntitlement,
  isLemonProviderProvenance,
  type ProEntitlementProvenance,
} from "./entitlement";
import { refreshFreeSubscriptionPeriod } from "./quotaEntitlement";
import { creditPurchasedTokens, grantTrialCreditOnce } from "./credit";
import {
  consolidatePurchasedTokenWallet,
  debitPurchasedTokenWallet,
  readTrialTokens,
  getUserWalletRows,
} from "./wallet";

const PAYMENT_ID_PATTERN = /^[1-9]\d*$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const SETTLEMENT_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const MAX_MONTHLY_BOUNDARY_SPAN_MS = 35 * 24 * 60 * 60 * 1000;
const RENEWAL_INVOICE_BOUNDARY_NOT_DUE_REASON =
  "Subscription billing boundary has not been reached yet";

function getFiveYearExpiration(now: number): number {
  const expiration = new Date(now);
  expiration.setUTCFullYear(expiration.getUTCFullYear() + 5);
  return expiration.getTime();
}

type SubscriptionStatus = "active" | "canceled" | "expired";
type SubscriptionStateEvent =
  | "subscription_created"
  | "subscription_updated"
  | "subscription_cancelled"
  | "subscription_resumed"
  | "subscription_expired"
  | "subscription_paused"
  | "subscription_unpaused";
type TokenPackProductType = "token_pack_small" | "token_pack_large";
const TERMINAL_SETTLEMENT_RETRY_MS = 60 * 1_000;

type LemonSubscriptionState = {
  eventName: SubscriptionStateEvent;
  userId?: string;
  lemonSqueezySubscriptionId: string;
  lemonSqueezyCustomerId: string;
  lemonSqueezyVariantId: string;
  status: SubscriptionStatus;
  providerCreatedAt: number;
  providerUpdatedAt: number;
  periodEnd: number;
};

async function scheduleTerminalQuotaSettlement(
  ctx: MutationCtx,
  args: {
    subscriptionId: Id<"subscriptions">;
    status: SubscriptionStatus;
    periodEnd: number;
    now: number;
  },
): Promise<void> {
  if (args.status === "active") return;
  await ctx.scheduler.runAfter(
    Math.max(0, args.periodEnd - args.now),
    internal.subscriptions.internalMutation.settleEndedProSubscription,
    { subscriptionId: args.subscriptionId },
  );
}

function assertPositiveProviderId(value: string, label: string): void {
  if (!PAYMENT_ID_PATTERN.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
}

function assertTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid ${label}`);
  }
}

function assertNonNegativeMoney(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid payment amount");
  }
}

function assertCurrency(value: string): void {
  if (!CURRENCY_PATTERN.test(value)) {
    throw new Error("Invalid payment currency");
  }
}

function assertSettlementFingerprint(value: string, label: string): void {
  if (!SETTLEMENT_FINGERPRINT_PATTERN.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
}

async function getSettlementReceipt(
  ctx: MutationCtx,
  settlementKeyFingerprint: string,
): Promise<Doc<"paymentSettlementReceipts"> | null> {
  const receipts = await ctx.db
    .query("paymentSettlementReceipts")
    .withIndex("by_settlement_key_fingerprint", (q) =>
      q.eq("settlementKeyFingerprint", settlementKeyFingerprint),
    )
    .take(2);
  if (receipts.length > 1) {
    throw new Error("Duplicate payment settlement receipts");
  }
  return receipts[0] ?? null;
}

async function insertSettlementReceipt(
  ctx: MutationCtx,
  args: {
    settlementKeyFingerprint: string;
    settlementType: "order" | "invoice" | "order_refund" | "invoice_refund";
    identityFingerprint: string;
    createdAt: number;
  },
): Promise<void> {
  await ctx.db.insert("paymentSettlementReceipts", {
    ...args,
    fingerprintVersion: 1,
  });
}

function receiptMatches(
  receipt: Doc<"paymentSettlementReceipts">,
  settlementType: Doc<"paymentSettlementReceipts">["settlementType"],
  identityFingerprint: string,
): boolean {
  return (
    receipt.settlementType === settlementType &&
    receipt.identityFingerprint === identityFingerprint
  );
}

async function getSettlementManualReview(
  ctx: MutationCtx,
  settlementKeyFingerprint: string,
): Promise<Doc<"paymentSettlementManualReviews"> | null> {
  const reviews = await ctx.db
    .query("paymentSettlementManualReviews")
    .withIndex("by_settlement_key_fingerprint", (q) =>
      q.eq("settlementKeyFingerprint", settlementKeyFingerprint),
    )
    .take(2);
  if (reviews.length > 1) {
    throw new Error("Duplicate payment settlement manual reviews");
  }
  return reviews[0] ?? null;
}

async function createSettlementManualReview(
  ctx: MutationCtx,
  args: Omit<
    Doc<"paymentSettlementManualReviews">,
    "_id" | "_creationTime" | "fingerprintVersion" | "status"
  >,
): Promise<void> {
  await ctx.db.insert("paymentSettlementManualReviews", {
    ...args,
    fingerprintVersion: 1,
    status: "open",
  });
}

function isInvoiceManualReview(
  review: Doc<"paymentSettlementManualReviews">,
): boolean {
  return review.reviewType === "invoice_processing";
}

async function createOrReopenInvoiceProcessingReview(
  ctx: MutationCtx,
  inbox: Doc<"lemonSqueezyInvoiceInbox">,
  reason: string,
  now: number,
): Promise<void> {
  const existing = await getSettlementManualReview(
    ctx,
    inbox.settlementKeyFingerprint,
  );
  if (existing) {
    if (
      existing.reviewType !== "invoice_processing" ||
      existing.identityFingerprint !== inbox.identityFingerprint ||
      existing.invoiceInboxId !== inbox._id ||
      existing.providerResourceId !== inbox.invoiceId ||
      existing.lemonSqueezySubscriptionId !== inbox.subscriptionId
    ) {
      throw new Error("Invoice processing review conflicts with durable inbox");
    }
    await ctx.db.patch(existing._id, {
      reason,
      status: "open",
      resolutionAction: undefined,
      resolutionEvidenceReference: undefined,
      resolvedAt: undefined,
      resolvedBy: undefined,
      updatedAt: now,
    });
    return;
  }

  await createSettlementManualReview(ctx, {
    settlementKeyFingerprint: inbox.settlementKeyFingerprint,
    identityFingerprint: inbox.identityFingerprint,
    reviewType: "invoice_processing",
    providerResourceId: inbox.invoiceId,
    invoiceInboxId: inbox._id,
    lemonSqueezySubscriptionId: inbox.subscriptionId,
    amountCents: inbox.amountCents,
    currency: inbox.currency,
    reason,
    expiresAt: inbox.expiresAt,
    createdAt: now,
    updatedAt: now,
  });
}

async function hasExactUnderfundedRenewalReview(
  ctx: MutationCtx,
  inbox: Doc<"lemonSqueezyInvoiceInbox">,
): Promise<boolean> {
  if (inbox.billingReason !== "renewal") return false;
  const subscription = await getTrustedLemonSubscriptionById(
    ctx,
    inbox.subscriptionId,
  );
  if (
    !subscription ||
    subscription.lemonSqueezyCustomerId !== inbox.customerId ||
    subscription.billingBoundaryReconciliationRequired !== true ||
    subscription.billingBoundaryManualReviewReason !==
      RENEWAL_INVOICE_WALLET_UNDERFUNDED_REASON
  ) {
    return false;
  }
  const boundaries = await ctx.db
    .query("subscriptionBillingBoundaries")
    .withIndex("by_subscription_status_and_period_end", (q) =>
      q.eq("subscriptionId", subscription._id).eq("status", "manual_review"),
    )
    .take(2);
  if (boundaries.length > 1) {
    throw new Error("Duplicate subscription billing boundary reviews");
  }
  const boundary = boundaries[0];
  return Boolean(
    boundary &&
    boundary.manualReviewReason === RENEWAL_INVOICE_WALLET_UNDERFUNDED_REASON &&
    boundary.manualReviewInvoiceId === inbox.invoiceId &&
    boundary.manualReviewSettlementKeyFingerprint ===
      inbox.settlementKeyFingerprint &&
    boundary.manualReviewIdentityFingerprint === inbox.identityFingerprint,
  );
}

async function terminalizeExactInvoiceProcessingReview(
  ctx: MutationCtx,
  inbox: Doc<"lemonSqueezyInvoiceInbox">,
  reason: string,
  now: number,
): Promise<boolean> {
  const existing = await getSettlementManualReview(
    ctx,
    inbox.settlementKeyFingerprint,
  );
  const hasOpenExactProcessingReview = Boolean(
    existing &&
    existing.reviewType === "invoice_processing" &&
    existing.status === "open" &&
    existing.identityFingerprint === inbox.identityFingerprint &&
    existing.invoiceInboxId === inbox._id &&
    existing.providerResourceId === inbox.invoiceId &&
    existing.lemonSqueezySubscriptionId === inbox.subscriptionId,
  );
  if (
    !hasOpenExactProcessingReview &&
    !(await hasExactUnderfundedRenewalReview(ctx, inbox))
  ) {
    return false;
  }

  await createOrReopenInvoiceProcessingReview(ctx, inbox, reason, now);
  await ctx.db.patch(inbox._id, {
    status: "manual_review",
    leaseToken: undefined,
    nextAttemptAt: inbox.expiresAt,
    lastError: reason.slice(0, 300),
    updatedAt: now,
  });
  return true;
}

async function enforceTrustedSubscriptionReplacementPolicy(
  ctx: MutationCtx,
  args: {
    userId: Id<"users">;
    targetSubscriptionId?: Id<"subscriptions">;
    now: number;
  },
): Promise<
  | {
      subscriptionId: Id<"subscriptions">;
      outcome: "manual_review";
    }
  | undefined
> {
  const rows = await getUserWalletRows(ctx, args.userId);
  for (const row of rows) {
    if (
      row._id === args.targetSubscriptionId ||
      row.plan !== "pro" ||
      row.proEntitlementProvenance === undefined
    ) {
      continue;
    }
    if (row.status === "active" || row.periodEnd > args.now) {
      throw new Error("User already has an active trusted subscription");
    }
    const settlement = await settleEndedTrustedProSubscriptionQuota(
      ctx,
      row,
      args.now,
    );
    if (settlement.status === "manual_review") {
      return { subscriptionId: row._id, outcome: "manual_review" };
    }
    if (settlement.status !== "settled") {
      throw new Error("Ended Pro subscription quota is not settled");
    }
    await ctx.db.patch(row._id, {
      status: "expired",
      updatedAt: args.now,
    });
  }
  return undefined;
}

async function ensureBillingBoundary(
  ctx: MutationCtx,
  args: {
    subscriptionId: Id<"subscriptions">;
    periodStart: number;
    periodEnd: number;
    providerUpdatedAt: number;
    now: number;
  },
): Promise<void> {
  if (args.periodEnd <= args.periodStart) {
    throw new Error("Invalid subscription billing boundary");
  }
  const existing = await ctx.db
    .query("subscriptionBillingBoundaries")
    .withIndex("by_subscription_and_period_end", (q) =>
      q
        .eq("subscriptionId", args.subscriptionId)
        .eq("periodEnd", args.periodEnd),
    )
    .take(2);
  if (existing.length > 1) {
    throw new Error("Duplicate subscription billing boundaries");
  }
  if (existing[0]) {
    if (existing[0].periodStart !== args.periodStart) {
      throw new Error("Conflicting subscription billing boundary");
    }
    return;
  }
  await ctx.db.insert("subscriptionBillingBoundaries", {
    subscriptionId: args.subscriptionId,
    periodStart: args.periodStart,
    periodEnd: args.periodEnd,
    providerUpdatedAt: args.providerUpdatedAt,
    status: "pending",
    createdAt: args.now,
    updatedAt: args.now,
  });
}

async function synchronizeBillingBoundaryQueue(
  ctx: MutationCtx,
  subscription: Doc<"subscriptions">,
  args: LemonSubscriptionState,
  now: number,
): Promise<boolean> {
  return await synchronizeExactBillingBoundaryQueue(
    ctx,
    subscription,
    args,
    now,
  );
}

function assertConfiguredProVariant(variantId: string): void {
  const configuredVariantId = process.env.LS_PRO_VARIANT_ID?.trim();
  if (!configuredVariantId || variantId !== configuredVariantId) {
    throw new Error("Subscription is not for the configured Pro variant");
  }
}

function getTokenPackProduct(variantId: string): {
  productType: TokenPackProductType;
  tokensPerUnit: number;
} | null {
  if (variantId === process.env.LS_TOKEN_PACK_SMALL_VARIANT_ID?.trim()) {
    return {
      productType: "token_pack_small",
      tokensPerUnit: PRICING.TOKEN_PACK_SMALL_SIZE,
    };
  }
  if (variantId === process.env.LS_TOKEN_PACK_LARGE_VARIANT_ID?.trim()) {
    return {
      productType: "token_pack_large",
      tokensPerUnit: PRICING.TOKEN_PACK_LARGE_SIZE,
    };
  }
  return null;
}

async function getValidatedUserId(
  ctx: MutationCtx,
  userId: string,
): Promise<Id<"users">> {
  const normalizedUserId = ctx.db.normalizeId("users", userId);
  if (!normalizedUserId || !(await ctx.db.get(normalizedUserId))) {
    throw new Error("Payment user does not exist");
  }
  return normalizedUserId;
}

async function getTrustedSubscriptionByLemonSqueezyId(
  ctx: MutationCtx,
  lemonSqueezySubscriptionId: string,
  source: ProEntitlementProvenance["source"],
): Promise<Doc<"subscriptions"> | null> {
  const subscriptions = await ctx.db
    .query("subscriptions")
    .withIndex("by_lemon_squeezy_subscription_and_provenance_source", (q) =>
      q
        .eq("lemonSqueezySubscriptionId", lemonSqueezySubscriptionId)
        .eq("proEntitlementProvenance.source", source),
    )
    .take(2);
  if (subscriptions.length > 1) {
    throw new Error("Duplicate trusted billing subscriptions");
  }
  return subscriptions[0] ?? null;
}

async function getTrustedLemonSubscriptionById(
  ctx: MutationCtx,
  lemonSqueezySubscriptionId: string,
): Promise<Doc<"subscriptions"> | null> {
  return await getTrustedSubscriptionByLemonSqueezyId(
    ctx,
    lemonSqueezySubscriptionId,
    "lemon_squeezy_webhook",
  );
}

function validateLemonSubscriptionState(args: LemonSubscriptionState): void {
  assertPositiveProviderId(
    args.lemonSqueezySubscriptionId,
    "Lemon Squeezy subscription ID",
  );
  assertPositiveProviderId(
    args.lemonSqueezyCustomerId,
    "Lemon Squeezy customer ID",
  );
  assertPositiveProviderId(
    args.lemonSqueezyVariantId,
    "Lemon Squeezy variant ID",
  );
  assertConfiguredProVariant(args.lemonSqueezyVariantId);
  assertTimestamp(args.providerCreatedAt, "provider creation timestamp");
  assertTimestamp(args.providerUpdatedAt, "provider update timestamp");
  assertTimestamp(args.periodEnd, "provider period end");
  if (args.providerUpdatedAt < args.providerCreatedAt) {
    throw new Error("Provider update predates subscription creation");
  }
  if (args.periodEnd <= args.providerCreatedAt) {
    throw new Error(
      "Provider period does not extend beyond subscription creation",
    );
  }
  if (args.status === "active" && args.periodEnd <= args.providerUpdatedAt) {
    throw new Error("Active subscription has no future period end");
  }
}

function hasExactProviderState(
  subscription: Doc<"subscriptions">,
  args: LemonSubscriptionState,
): boolean {
  return (
    subscription.lemonSqueezyCustomerId === args.lemonSqueezyCustomerId &&
    subscription.lemonSqueezyVariantId === args.lemonSqueezyVariantId &&
    subscription.providerCreatedAt === args.providerCreatedAt &&
    subscription.providerUpdatedAt === args.providerUpdatedAt &&
    subscription.periodEnd === args.periodEnd &&
    subscription.status === args.status &&
    subscription.plan === "pro" &&
    isLemonProviderProvenance(subscription.proEntitlementProvenance?.source)
  );
}

async function syncLemonSubscriptionInTransaction(
  ctx: MutationCtx,
  args: LemonSubscriptionState,
): Promise<{
  subscriptionId: Id<"subscriptions">;
  outcome: "applied" | "duplicate" | "stale" | "manual_review";
}> {
  validateLemonSubscriptionState(args);
  const [trustedWebhook, trustedAdminOverride] = await Promise.all([
    getTrustedSubscriptionByLemonSqueezyId(
      ctx,
      args.lemonSqueezySubscriptionId,
      "lemon_squeezy_webhook",
    ),
    getTrustedSubscriptionByLemonSqueezyId(
      ctx,
      args.lemonSqueezySubscriptionId,
      "admin_override",
    ),
  ]);
  if (trustedAdminOverride) {
    throw new Error("Admin billing subscription ID cannot be rebound");
  }

  const boundUserId = args.userId
    ? await getValidatedUserId(ctx, args.userId)
    : undefined;
  const subscription = trustedWebhook;
  if (boundUserId && subscription && subscription.userId !== boundUserId) {
    throw new Error("Trusted billing subscription belongs to another user");
  }
  if (args.eventName === "subscription_created" && !boundUserId) {
    throw new Error("Subscription creation is missing its bound user");
  }

  if (!subscription) {
    if (!boundUserId) {
      throw new Error("Trusted billing subscription not found");
    }
    const now = Date.now();
    const replacementBlock = await enforceTrustedSubscriptionReplacementPolicy(
      ctx,
      {
        userId: boundUserId,
        now,
      },
    );
    if (replacementBlock) return replacementBlock;
    const subscriptionId = await ctx.db.insert("subscriptions", {
      userId: boundUserId,
      lemonSqueezySubscriptionId: args.lemonSqueezySubscriptionId,
      lemonSqueezyCustomerId: args.lemonSqueezyCustomerId,
      lemonSqueezyVariantId: args.lemonSqueezyVariantId,
      providerCreatedAt: args.providerCreatedAt,
      providerUpdatedAt: args.providerUpdatedAt,
      proEntitlementProvenance: {
        source: "lemon_squeezy_webhook",
        verifiedAt: now,
      },
      plan: "pro",
      status: args.status,
      serviceFeeRate: PRICING.PLATFORM_FEE_PRO,
      includedTokens: PRICING.PRO_INCLUDED_TOKENS,
      purchasedTokens: 0,
      periodStart: args.providerCreatedAt,
      periodEnd: args.periodEnd,
      createdAt: now,
      updatedAt: now,
    });
    const created = await ctx.db.get(subscriptionId);
    if (!created) throw new Error("Failed to create trusted subscription");
    const reconciliationRequired = await synchronizeBillingBoundaryQueue(
      ctx,
      created,
      args,
      now,
    );
    if (reconciliationRequired) {
      await ctx.db.patch(subscriptionId, {
        billingBoundaryReconciliationRequired: true,
      });
    }
    await consolidatePurchasedTokenWallet(ctx, {
      userId: boundUserId,
      targetSubscriptionId: subscriptionId,
      now,
    });
    await scheduleTerminalQuotaSettlement(ctx, {
      subscriptionId,
      status: args.status,
      periodEnd: args.periodEnd,
      now,
    });
    return { subscriptionId, outcome: "applied" };
  }

  if (subscription.lemonSqueezyCustomerId !== args.lemonSqueezyCustomerId) {
    throw new Error("Lemon Squeezy customer binding is immutable");
  }
  if (subscription.providerCreatedAt !== args.providerCreatedAt) {
    throw new Error("Lemon Squeezy creation timestamp is immutable");
  }
  if (subscription.lemonSqueezyVariantId !== args.lemonSqueezyVariantId) {
    throw new Error("Lemon Squeezy variant changes are not supported");
  }

  if (
    subscription.providerUpdatedAt !== undefined &&
    args.providerUpdatedAt < subscription.providerUpdatedAt
  ) {
    return { subscriptionId: subscription._id, outcome: "stale" };
  }
  if (
    subscription.providerUpdatedAt !== undefined &&
    args.providerUpdatedAt === subscription.providerUpdatedAt
  ) {
    if (!hasExactProviderState(subscription, args)) {
      throw new Error("Conflicting subscription state at provider timestamp");
    }
    const now = Date.now();
    const reconciliationRequired = await synchronizeBillingBoundaryQueue(
      ctx,
      subscription,
      args,
      now,
    );
    if (
      reconciliationRequired !==
      (subscription.billingBoundaryReconciliationRequired ?? false)
    ) {
      await ctx.db.patch(subscription._id, {
        billingBoundaryReconciliationRequired:
          reconciliationRequired || undefined,
      });
    }
    await scheduleTerminalQuotaSettlement(ctx, {
      subscriptionId: subscription._id,
      status: args.status,
      periodEnd: args.periodEnd,
      now,
    });
    return { subscriptionId: subscription._id, outcome: "duplicate" };
  }

  const now = Date.now();
  const replacementBlock = await enforceTrustedSubscriptionReplacementPolicy(
    ctx,
    {
      userId: subscription.userId,
      targetSubscriptionId: subscription._id,
      now,
    },
  );
  if (replacementBlock) return replacementBlock;
  const reconciliationRequired = await synchronizeBillingBoundaryQueue(
    ctx,
    subscription,
    args,
    now,
  );
  await ctx.db.patch(subscription._id, {
    lemonSqueezyCustomerId: args.lemonSqueezyCustomerId,
    lemonSqueezyVariantId: args.lemonSqueezyVariantId,
    providerCreatedAt: args.providerCreatedAt,
    providerUpdatedAt: args.providerUpdatedAt,
    proEntitlementProvenance: {
      source: "lemon_squeezy_webhook",
      verifiedAt: now,
    },
    plan: "pro",
    status: args.status,
    serviceFeeRate: PRICING.PLATFORM_FEE_PRO,
    includedTokens: PRICING.PRO_INCLUDED_TOKENS,
    billingBoundaryReconciliationRequired: reconciliationRequired || undefined,
    periodEnd: args.periodEnd,
    updatedAt: now,
  });
  await consolidatePurchasedTokenWallet(ctx, {
    userId: subscription.userId,
    targetSubscriptionId: subscription._id,
    now,
  });
  await scheduleTerminalQuotaSettlement(ctx, {
    subscriptionId: subscription._id,
    status: args.status,
    periodEnd: args.periodEnd,
    now,
  });
  return { subscriptionId: subscription._id, outcome: "applied" };
}

/** Apply a validated Lemon subscription object with stale-event fencing. */
export const syncLemonSqueezySubscription = internalMutation({
  args: {
    eventName: v.union(
      v.literal("subscription_created"),
      v.literal("subscription_updated"),
      v.literal("subscription_cancelled"),
      v.literal("subscription_resumed"),
      v.literal("subscription_expired"),
      v.literal("subscription_paused"),
      v.literal("subscription_unpaused"),
    ),
    userId: v.optional(v.string()),
    lemonSqueezySubscriptionId: v.string(),
    lemonSqueezyCustomerId: v.string(),
    lemonSqueezyVariantId: v.string(),
    status: v.union(
      v.literal("active"),
      v.literal("canceled"),
      v.literal("expired"),
    ),
    providerCreatedAt: v.number(),
    providerUpdatedAt: v.number(),
    periodEnd: v.number(),
  },
  handler: syncLemonSubscriptionInTransaction,
});

/** Settle an ended Pro period before its lifetime wallet can be exposed again. */
export const settleEndedProSubscription = internalMutation({
  args: { subscriptionId: v.id("subscriptions") },
  handler: async (ctx, args) => {
    const subscription = await ctx.db.get(args.subscriptionId);
    if (!subscription) return { status: "missing" as const };
    const result = await settleEndedTrustedProSubscriptionQuota(
      ctx,
      subscription,
      Date.now(),
    );
    if (result.status === "not_due") {
      await ctx.scheduler.runAfter(
        Math.max(0, result.retryAt - Date.now()),
        internal.subscriptions.internalMutation.settleEndedProSubscription,
        args,
      );
    } else if (result.status === "in_progress") {
      await ctx.scheduler.runAfter(
        TERMINAL_SETTLEMENT_RETRY_MS,
        internal.subscriptions.internalMutation.settleEndedProSubscription,
        args,
      );
    }
    return result;
  },
});

/** Credit and log one token-pack order in a single idempotent transaction. */
export const fulfillTokenPackOrder = internalMutation({
  args: {
    userId: v.string(),
    orderId: v.string(),
    orderCreatedAt: v.number(),
    customerId: v.string(),
    variantId: v.string(),
    quantity: v.number(),
    amountCents: v.number(),
    currency: v.string(),
    fingerprintKeyAttestation: v.string(),
    settlementKeyFingerprint: v.string(),
    identityFingerprint: v.string(),
  },
  handler: async (ctx, args) => {
    await assertAndPinSettlementConfiguration(ctx, args);
    assertSettlementFingerprint(
      args.settlementKeyFingerprint,
      "settlement key fingerprint",
    );
    assertSettlementFingerprint(
      args.identityFingerprint,
      "settlement identity fingerprint",
    );
    const receipt = await getSettlementReceipt(
      ctx,
      args.settlementKeyFingerprint,
    );
    if (receipt) {
      if (!receiptMatches(receipt, "order", args.identityFingerprint)) {
        throw new Error("Token-pack order replay does not match settlement");
      }
      return { outcome: "duplicate" as const };
    }
    const existingManualReview = await getSettlementManualReview(
      ctx,
      args.settlementKeyFingerprint,
    );
    if (existingManualReview) {
      throw new Error("Token-pack order conflicts with manual review");
    }

    assertPositiveProviderId(args.orderId, "Lemon Squeezy order ID");
    assertPositiveProviderId(args.customerId, "Lemon Squeezy customer ID");
    assertPositiveProviderId(args.variantId, "Lemon Squeezy variant ID");
    assertTimestamp(args.orderCreatedAt, "order creation timestamp");
    assertNonNegativeMoney(args.amountCents);
    assertCurrency(args.currency);
    if (args.quantity !== 1) {
      throw new Error("Invalid token-pack quantity");
    }
    const userId = await getValidatedUserId(ctx, args.userId);
    const product = getTokenPackProduct(args.variantId);
    if (!product) {
      throw new Error("Order is not for a configured token pack");
    }
    const tokensAdded = product.tokensPerUnit * args.quantity;
    if (!Number.isSafeInteger(tokensAdded) || tokensAdded <= 0) {
      throw new Error("Token-pack fulfillment exceeds the supported range");
    }

    const now = Date.now();
    const subscriptionId = await creditPurchasedTokens(ctx, {
      userId,
      tokensToAdd: tokensAdded,
      now,
    });
    await insertSettlementReceipt(ctx, {
      settlementKeyFingerprint: args.settlementKeyFingerprint,
      settlementType: "order",
      identityFingerprint: args.identityFingerprint,
      createdAt: now,
    });
    await createPaymentLogInTransaction(ctx, {
      userId,
      lemonSqueezyEventId: args.orderId,
      lemonSqueezyOrderId: args.orderId,
      lemonSqueezyOrderCreatedAt: args.orderCreatedAt,
      lemonSqueezyCustomerId: args.customerId,
      lemonSqueezyVariantId: args.variantId,
      eventType: "order_created",
      productType: product.productType,
      amountCents: args.amountCents,
      currency: args.currency,
      tokensAdded,
      status: "success",
      settlementReceiptVerified: true,
      createdAt: now,
    });

    return {
      outcome: "applied" as const,
      subscriptionId,
      tokensAdded,
    };
  },
});

/** Apply only an unambiguous full token-pack refund; defer every other case. */
export const processTokenPackRefund = internalMutation({
  args: {
    userId: v.string(),
    orderId: v.string(),
    orderCreatedAt: v.number(),
    orderUpdatedAt: v.number(),
    customerId: v.string(),
    variantId: v.string(),
    quantity: v.number(),
    amountCents: v.number(),
    refundedAmountCents: v.number(),
    currency: v.string(),
    refundStatus: v.union(v.literal("refunded"), v.literal("partial_refund")),
    fingerprintKeyAttestation: v.string(),
    originalSettlementKeyFingerprint: v.string(),
    originalIdentityFingerprint: v.string(),
    settlementKeyFingerprint: v.string(),
    identityFingerprint: v.string(),
  },
  handler: async (ctx, args) => {
    await assertAndPinSettlementConfiguration(ctx, args);
    for (const [value, label] of [
      [
        args.originalSettlementKeyFingerprint,
        "original settlement key fingerprint",
      ],
      [
        args.originalIdentityFingerprint,
        "original settlement identity fingerprint",
      ],
      [args.settlementKeyFingerprint, "refund settlement key fingerprint"],
      [args.identityFingerprint, "refund identity fingerprint"],
    ] as const) {
      assertSettlementFingerprint(value, label);
    }
    const receipt = await getSettlementReceipt(
      ctx,
      args.settlementKeyFingerprint,
    );
    if (receipt) {
      if (!receiptMatches(receipt, "order_refund", args.identityFingerprint)) {
        throw new Error("Token-pack refund replay does not match settlement");
      }
      return { outcome: "duplicate" as const };
    }
    const existingReview = await getSettlementManualReview(
      ctx,
      args.settlementKeyFingerprint,
    );
    if (existingReview) {
      if (
        existingReview.reviewType !== "order_refund" ||
        existingReview.identityFingerprint !== args.identityFingerprint
      ) {
        throw new Error(
          "Token-pack refund replay does not match manual review",
        );
      }
      return { outcome: "manual_review" as const };
    }

    assertPositiveProviderId(args.orderId, "Lemon Squeezy order ID");
    assertPositiveProviderId(args.customerId, "Lemon Squeezy customer ID");
    assertPositiveProviderId(args.variantId, "Lemon Squeezy variant ID");
    assertTimestamp(args.orderCreatedAt, "order creation timestamp");
    assertTimestamp(args.orderUpdatedAt, "order update timestamp");
    if (args.orderUpdatedAt < args.orderCreatedAt) {
      throw new Error("Order refund update predates order creation");
    }
    assertNonNegativeMoney(args.amountCents);
    assertNonNegativeMoney(args.refundedAmountCents);
    if (
      args.refundedAmountCents <= 0 ||
      args.refundedAmountCents > args.amountCents
    ) {
      throw new Error("Invalid token-pack refunded amount");
    }
    assertCurrency(args.currency);
    if (args.quantity !== 1) {
      throw new Error("Invalid token-pack quantity");
    }
    const normalizedUserId = ctx.db.normalizeId("users", args.userId);
    const userId =
      normalizedUserId && (await ctx.db.get(normalizedUserId))
        ? normalizedUserId
        : undefined;
    const product = getTokenPackProduct(args.variantId);
    const originalReceipt = await getSettlementReceipt(
      ctx,
      args.originalSettlementKeyFingerprint,
    );

    const now = Date.now();
    const recordManualReview = async (reason: string) => {
      await createSettlementManualReview(ctx, {
        settlementKeyFingerprint: args.settlementKeyFingerprint,
        identityFingerprint: args.identityFingerprint,
        reviewType: "order_refund",
        providerResourceId: args.orderId,
        userId,
        amountCents: args.amountCents,
        refundedAmountCents: args.refundedAmountCents,
        currency: args.currency,
        reason,
        expiresAt: getFiveYearExpiration(now),
        createdAt: now,
        updatedAt: now,
      });
      return { outcome: "manual_review" as const };
    };

    if (!userId) {
      return await recordManualReview(
        "Token-pack refund user is no longer available.",
      );
    }
    if (!product) {
      return await recordManualReview(
        "Token-pack refund product is no longer configured.",
      );
    }
    const tokensToClawBack = product.tokensPerUnit * args.quantity;
    if (!Number.isSafeInteger(tokensToClawBack) || tokensToClawBack <= 0) {
      return await recordManualReview(
        "Token-pack refund exceeds the supported range.",
      );
    }
    if (
      !originalReceipt ||
      originalReceipt.settlementType !== "order" ||
      originalReceipt.identityFingerprint !== args.originalIdentityFingerprint
    ) {
      return await recordManualReview(
        "Original token-pack settlement identity cannot be verified exactly.",
      );
    }
    if (
      args.refundStatus !== "refunded" ||
      args.refundedAmountCents !== args.amountCents
    ) {
      return await recordManualReview(
        "Partial token-pack refunds require an operator decision.",
      );
    }
    if (await hasOpenUsageReservation(ctx, userId)) {
      return await recordManualReview(
        "Token-pack refund is blocked by in-flight or unresolved provider usage.",
      );
    }
    const subscription = await getSubscriptionForEntitlement(ctx, userId);
    if (!subscription) {
      return await recordManualReview(
        "Token-pack refund user has no canonical wallet.",
      );
    }
    try {
      await settleAllEndedTrustedProQuotas(ctx, userId, now);
    } catch (error) {
      if (error instanceof TerminalProQuotaUnavailableError) {
        return await recordManualReview(
          `Token-pack refund requires terminal Pro settlement: ${error.message}`,
        );
      }
      throw error;
    }
    const currentProLiability =
      await readCurrentTrustedProPurchasedTokenLiability(
        ctx,
        subscription,
        now,
      );
    if (!currentProLiability.verified) {
      return await recordManualReview(
        currentProLiability.reason === "usage_history_too_large"
          ? "Current Pro usage history is too large to verify before refund."
          : currentProLiability.reason === "untrusted_pro_entitlement"
            ? "Current Pro entitlement provenance must be reconciled before refund."
            : "Current Pro billing period cannot be verified before refund.",
      );
    }
    if (currentProLiability.outstandingTokens > 0) {
      return await recordManualReview(
        "Current Pro purchased-token usage cannot be settled before its exact billing boundary.",
      );
    }
    await refreshFreeSubscriptionPeriod(ctx, subscription, now);
    const walletBalance = await consolidatePurchasedTokenWallet(ctx, {
      userId,
      targetSubscriptionId: subscription._id,
      now,
    });
    if (walletBalance < tokensToClawBack) {
      return await recordManualReview(
        "Token-pack refund balance was already consumed.",
      );
    }
    // The trial is spent before paid tokens, so a refund may only take back
    // what is left beyond the unspent trial.
    if (
      walletBalance - tokensToClawBack <
      (await readTrialTokens(ctx, subscription._id))
    ) {
      return await recordManualReview(
        "Token-pack refund balance was already consumed.",
      );
    }

    await ctx.db.patch(subscription._id, {
      purchasedTokens: walletBalance - tokensToClawBack,
      updatedAt: now,
    });
    await insertSettlementReceipt(ctx, {
      settlementKeyFingerprint: args.settlementKeyFingerprint,
      settlementType: "order_refund",
      identityFingerprint: args.identityFingerprint,
      createdAt: now,
    });
    await createPaymentLogInTransaction(ctx, {
      userId,
      lemonSqueezyEventId: args.orderId,
      lemonSqueezyOrderId: args.orderId,
      lemonSqueezyOrderCreatedAt: args.orderCreatedAt,
      lemonSqueezyCustomerId: args.customerId,
      lemonSqueezyVariantId: args.variantId,
      eventType: "order_refunded",
      productType: product.productType,
      amountCents: args.refundedAmountCents,
      currency: args.currency,
      tokensAdded: -tokensToClawBack,
      status: "refunded",
      settlementReceiptVerified: true,
      createdAt: now,
    });
    return { outcome: "applied" as const, tokensClawedBack: tokensToClawBack };
  },
});

/** Subscription refunds always require review; they never rewrite entitlement. */
export const recordSubscriptionInvoiceRefundManualReview = internalMutation({
  args: {
    invoiceId: v.string(),
    subscriptionId: v.string(),
    customerId: v.string(),
    billingReason: v.union(
      v.literal("initial"),
      v.literal("renewal"),
      v.literal("updated"),
    ),
    invoiceCreatedAt: v.number(),
    invoiceUpdatedAt: v.number(),
    amountCents: v.number(),
    refundedAmountCents: v.number(),
    currency: v.string(),
    refundStatus: v.union(v.literal("refunded"), v.literal("partial_refund")),
    fingerprintKeyAttestation: v.string(),
    settlementKeyFingerprint: v.string(),
    identityFingerprint: v.string(),
  },
  handler: async (ctx, args) => {
    await assertAndPinSettlementConfiguration(ctx, args);
    assertSettlementFingerprint(
      args.settlementKeyFingerprint,
      "refund settlement key fingerprint",
    );
    assertSettlementFingerprint(
      args.identityFingerprint,
      "refund identity fingerprint",
    );
    const existing = await getSettlementManualReview(
      ctx,
      args.settlementKeyFingerprint,
    );
    if (existing) {
      if (
        existing.reviewType !== "invoice_refund" ||
        existing.identityFingerprint !== args.identityFingerprint
      ) {
        throw new Error(
          "Subscription refund replay does not match manual review",
        );
      }
      return { outcome: "manual_review" as const };
    }
    assertPositiveProviderId(args.invoiceId, "Lemon Squeezy invoice ID");
    assertPositiveProviderId(
      args.subscriptionId,
      "Lemon Squeezy subscription ID",
    );
    assertPositiveProviderId(args.customerId, "Lemon Squeezy customer ID");
    assertTimestamp(args.invoiceCreatedAt, "invoice creation timestamp");
    assertTimestamp(args.invoiceUpdatedAt, "invoice update timestamp");
    if (args.invoiceUpdatedAt < args.invoiceCreatedAt) {
      throw new Error("Invoice refund update predates invoice creation");
    }
    assertNonNegativeMoney(args.amountCents);
    assertNonNegativeMoney(args.refundedAmountCents);
    if (
      args.refundedAmountCents <= 0 ||
      args.refundedAmountCents > args.amountCents
    ) {
      throw new Error("Invalid subscription refunded amount");
    }
    assertCurrency(args.currency);
    const subscription = await getTrustedLemonSubscriptionById(
      ctx,
      args.subscriptionId,
    );
    const customerBindingMismatch =
      subscription !== null &&
      subscription.lemonSqueezyCustomerId !== args.customerId;
    const now = Date.now();
    await createSettlementManualReview(ctx, {
      settlementKeyFingerprint: args.settlementKeyFingerprint,
      identityFingerprint: args.identityFingerprint,
      reviewType: "invoice_refund",
      providerResourceId: args.invoiceId,
      userId: subscription?.userId,
      lemonSqueezySubscriptionId: args.subscriptionId,
      amountCents: args.amountCents,
      refundedAmountCents: args.refundedAmountCents,
      currency: args.currency,
      reason: customerBindingMismatch
        ? "Subscription refund customer binding requires operator review."
        : "Subscription invoice refunds require entitlement and usage review.",
      expiresAt: getFiveYearExpiration(now),
      createdAt: now,
      updatedAt: now,
    });
    return { outcome: "manual_review" as const };
  },
});

async function getEarliestPendingBillingBoundary(
  ctx: MutationCtx,
  subscriptionId: Id<"subscriptions">,
): Promise<Doc<"subscriptionBillingBoundaries"> | null> {
  return await ctx.db
    .query("subscriptionBillingBoundaries")
    .withIndex("by_subscription_status_and_period_end", (q) =>
      q.eq("subscriptionId", subscriptionId).eq("status", "pending"),
    )
    .order("asc")
    .first();
}

async function assertNoBillingBoundaryReview(
  ctx: MutationCtx,
  subscription: Doc<"subscriptions">,
): Promise<void> {
  if (
    subscription.billingBoundaryReconciliationRequired ||
    subscription.billingBoundaryManualReviewReason !== undefined
  ) {
    throw new Error("Subscription billing boundary requires reconciliation");
  }
  const manualReview = await ctx.db
    .query("subscriptionBillingBoundaries")
    .withIndex("by_subscription_status_and_period_end", (q) =>
      q.eq("subscriptionId", subscription._id).eq("status", "manual_review"),
    )
    .first();
  if (manualReview) {
    throw new Error("Subscription billing boundary requires reconciliation");
  }
}

/** Settle one paid subscription invoice exactly once. */
export const settleSubscriptionInvoice = internalMutation({
  args: {
    eventName: v.union(
      v.literal("subscription_payment_success"),
      v.literal("subscription_payment_recovered"),
    ),
    invoiceId: v.string(),
    invoiceStatus: v.literal("paid"),
    subscriptionId: v.string(),
    customerId: v.string(),
    billingReason: v.union(
      v.literal("initial"),
      v.literal("renewal"),
      v.literal("updated"),
    ),
    invoiceCreatedAt: v.number(),
    invoiceUpdatedAt: v.number(),
    amountCents: v.number(),
    currency: v.string(),
    fingerprintKeyAttestation: v.string(),
    settlementKeyFingerprint: v.string(),
    identityFingerprint: v.string(),
  },
  handler: async (ctx, args) => {
    await assertAndPinSettlementConfiguration(ctx, args);
    assertSettlementFingerprint(
      args.settlementKeyFingerprint,
      "settlement key fingerprint",
    );
    assertSettlementFingerprint(
      args.identityFingerprint,
      "settlement identity fingerprint",
    );
    const receipt = await getSettlementReceipt(
      ctx,
      args.settlementKeyFingerprint,
    );
    if (receipt) {
      if (!receiptMatches(receipt, "invoice", args.identityFingerprint)) {
        throw new Error(
          "Subscription invoice replay does not match settlement",
        );
      }
      return { outcome: "duplicate" as const };
    }
    const existingManualReview = await getSettlementManualReview(
      ctx,
      args.settlementKeyFingerprint,
    );
    if (existingManualReview) {
      if (
        !isInvoiceManualReview(existingManualReview) ||
        existingManualReview.identityFingerprint !== args.identityFingerprint
      ) {
        throw new Error(
          "Subscription invoice replay does not match manual review",
        );
      }
      if (existingManualReview.status === "open") {
        return { outcome: "manual_review" as const };
      }
    }

    assertPositiveProviderId(args.invoiceId, "Lemon Squeezy invoice ID");
    assertPositiveProviderId(
      args.subscriptionId,
      "Lemon Squeezy subscription ID",
    );
    assertPositiveProviderId(args.customerId, "Lemon Squeezy customer ID");
    assertTimestamp(args.invoiceCreatedAt, "invoice creation timestamp");
    assertTimestamp(args.invoiceUpdatedAt, "invoice update timestamp");
    if (args.invoiceUpdatedAt < args.invoiceCreatedAt) {
      throw new Error("Invoice update predates invoice creation");
    }
    assertNonNegativeMoney(args.amountCents);
    assertCurrency(args.currency);

    const subscription = await getTrustedLemonSubscriptionById(
      ctx,
      args.subscriptionId,
    );
    if (!subscription) {
      throw new Error("Trusted billing subscription not found");
    }
    if (subscription.lemonSqueezyCustomerId !== args.customerId) {
      throw new Error("Invoice does not match its trusted subscription");
    }
    const resolvedVariantId = subscription.lemonSqueezyVariantId;
    if (!resolvedVariantId) {
      throw new Error("Trusted subscription has no Lemon Squeezy variant");
    }
    assertPositiveProviderId(resolvedVariantId, "Lemon Squeezy variant ID");
    assertConfiguredProVariant(resolvedVariantId);

    if (args.billingReason === "renewal") {
      await assertNoBillingBoundaryReview(ctx, subscription);
    }

    if (subscription.providerCreatedAt === undefined) {
      throw new Error("Trusted subscription has no provider creation time");
    }
    if (args.invoiceCreatedAt < subscription.providerCreatedAt) {
      throw new Error("Invoice predates its subscription");
    }

    const now = Date.now();
    let tokensUsed: number | undefined;
    let usedFromPurchased: number | undefined;
    let stale = false;
    if (args.billingReason === "renewal") {
      let boundary = await getEarliestPendingBillingBoundary(
        ctx,
        subscription._id,
      );
      if (
        !boundary &&
        subscription.periodEnd > subscription.periodStart &&
        subscription.periodEnd - subscription.periodStart <=
          MAX_MONTHLY_BOUNDARY_SPAN_MS
      ) {
        await ensureBillingBoundary(ctx, {
          subscriptionId: subscription._id,
          periodStart: subscription.periodStart,
          periodEnd: subscription.periodEnd,
          providerUpdatedAt:
            subscription.providerUpdatedAt ?? subscription.providerCreatedAt,
          now,
        });
        boundary = await getEarliestPendingBillingBoundary(
          ctx,
          subscription._id,
        );
      }
      if (!boundary) {
        throw new Error("Subscription billing boundary is not ready");
      }
      if (
        args.invoiceCreatedAt <
        boundary.periodEnd - INVOICE_BOUNDARY_TOLERANCE_MS
      ) {
        stale = true;
      } else if (
        args.invoiceCreatedAt >
        boundary.periodEnd + INVOICE_BOUNDARY_TOLERANCE_MS
      ) {
        throw new Error("Earlier subscription invoice has not settled");
      }
      if (!stale) {
        if (boundary.periodEnd > now) {
          return {
            outcome: "deferred" as const,
            retryReason: RENEWAL_INVOICE_BOUNDARY_NOT_DUE_REASON,
            subscriptionId: subscription._id,
            quotaReset: false,
          };
        }
        const providerHolds = await checkBillingBoundaryProviderHolds(
          ctx,
          subscription,
          boundary,
          now,
        );
        if (providerHolds === "in_progress") {
          return {
            outcome: "deferred" as const,
            retryReason:
              "Provider usage is still being finalized for this renewal period",
            subscriptionId: subscription._id,
            quotaReset: false,
          };
        }
        if (providerHolds === "ambiguous") {
          return {
            outcome: "deferred" as const,
            retryReason:
              "Provider usage for this renewal period requires reconciliation",
            subscriptionId: subscription._id,
            quotaReset: false,
          };
        }
        const usage = await readQuotaTokenUsage(ctx, {
          userId: subscription.userId,
          periodStart: boundary.periodStart,
          periodEndExclusive: boundary.periodEnd,
        });
        if (!usage.verified) {
          throw new Error("Usage history is too large to settle safely");
        }
        tokensUsed = usage.tokensUsed;
        usedFromPurchased = Math.max(
          0,
          tokensUsed -
            subscription.includedTokens -
            usage.purchasedTokensDebited,
        );
        const walletBalance = await consolidatePurchasedTokenWallet(ctx, {
          userId: subscription.userId,
          targetSubscriptionId: subscription._id,
          now,
        });
        if (walletBalance < usedFromPurchased) {
          const reason = RENEWAL_INVOICE_WALLET_UNDERFUNDED_REASON;
          await ctx.db.patch(boundary._id, {
            status: "manual_review",
            manualReviewReason: reason,
            manualReviewInvoiceId: args.invoiceId,
            manualReviewSettlementKeyFingerprint: args.settlementKeyFingerprint,
            manualReviewIdentityFingerprint: args.identityFingerprint,
            updatedAt: now,
          });
          await ctx.db.patch(subscription._id, {
            billingBoundaryReconciliationRequired: true,
            billingBoundaryManualReviewReason: reason,
            updatedAt: now,
          });
          return {
            outcome: "manual_review" as const,
            subscriptionId: subscription._id,
            quotaReset: false,
            tokensUsed,
            usedFromPurchased,
          };
        }
        const debit = await debitPurchasedTokenWallet(ctx, {
          userId: subscription.userId,
          targetSubscriptionId: subscription._id,
          tokensToDebit: usedFromPurchased,
          now,
        });
        if (debit.debited !== usedFromPurchased) {
          throw new Error("Renewal purchased-token debit was not exact");
        }
        await ctx.db.patch(subscription._id, {
          periodStart: Math.max(subscription.periodStart, boundary.periodEnd),
          purchasedTokens: debit.remaining,
          proEntitlementProvenance: {
            source: "lemon_squeezy_webhook",
            verifiedAt: now,
          },
          updatedAt: now,
        });
        await ctx.db.patch(boundary._id, {
          status: "settled",
          settledInvoiceCreatedAt: args.invoiceCreatedAt,
          settlementReason: "renewal_invoice",
          purchasedTokensDebited: debit.debited,
          updatedAt: now,
        });
      }
    }
    if (args.billingReason !== "renewal" || stale) {
      await ctx.db.patch(subscription._id, {
        proEntitlementProvenance: {
          source: "lemon_squeezy_webhook",
          verifiedAt: now,
        },
        updatedAt: now,
      });
    }

    await insertSettlementReceipt(ctx, {
      settlementKeyFingerprint: args.settlementKeyFingerprint,
      settlementType: "invoice",
      identityFingerprint: args.identityFingerprint,
      createdAt: now,
    });
    await createPaymentLogInTransaction(ctx, {
      userId: subscription.userId,
      lemonSqueezyEventId: args.invoiceId,
      lemonSqueezyInvoiceId: args.invoiceId,
      lemonSqueezySubscriptionId: args.subscriptionId,
      lemonSqueezyCustomerId: args.customerId,
      lemonSqueezyVariantId: resolvedVariantId,
      lemonSqueezyBillingReason: args.billingReason,
      lemonSqueezyInvoiceCreatedAt: args.invoiceCreatedAt,
      eventType: args.eventName,
      productType: "pro",
      amountCents: args.amountCents,
      currency: args.currency,
      status: "success",
      settlementReceiptVerified: true,
      createdAt: now,
    });

    return {
      outcome: stale ? ("stale" as const) : ("applied" as const),
      subscriptionId: subscription._id,
      quotaReset: args.billingReason === "renewal",
      tokensUsed,
      usedFromPurchased,
    };
  },
});

const INVOICE_INBOX_LEASE_MS = 5 * 60 * 1000;
const INVOICE_INBOX_MAX_ATTEMPTS = 96;
const INVOICE_INBOX_RECOVERY_BATCH_SIZE = 50;

/** Persist a normalized signed invoice before acknowledging its webhook. */
export const enqueueSubscriptionInvoice = internalMutation({
  args: {
    eventName: v.union(
      v.literal("subscription_payment_success"),
      v.literal("subscription_payment_recovered"),
    ),
    invoiceId: v.string(),
    subscriptionId: v.string(),
    customerId: v.string(),
    billingReason: v.union(
      v.literal("initial"),
      v.literal("renewal"),
      v.literal("updated"),
    ),
    invoiceCreatedAt: v.number(),
    invoiceUpdatedAt: v.number(),
    amountCents: v.number(),
    currency: v.string(),
    fingerprintKeyAttestation: v.string(),
    settlementKeyFingerprint: v.string(),
    identityFingerprint: v.string(),
  },
  handler: async (ctx, args) => {
    await assertAndPinSettlementConfiguration(ctx, args);
    assertSettlementFingerprint(
      args.settlementKeyFingerprint,
      "settlement key fingerprint",
    );
    assertSettlementFingerprint(
      args.identityFingerprint,
      "settlement identity fingerprint",
    );
    assertPositiveProviderId(args.invoiceId, "Lemon Squeezy invoice ID");
    assertPositiveProviderId(
      args.subscriptionId,
      "Lemon Squeezy subscription ID",
    );
    assertPositiveProviderId(args.customerId, "Lemon Squeezy customer ID");
    assertTimestamp(args.invoiceCreatedAt, "invoice creation timestamp");
    assertTimestamp(args.invoiceUpdatedAt, "invoice update timestamp");
    if (args.invoiceUpdatedAt < args.invoiceCreatedAt) {
      throw new Error("Invoice update predates invoice creation");
    }
    assertNonNegativeMoney(args.amountCents);
    assertCurrency(args.currency);

    const receipt = await getSettlementReceipt(
      ctx,
      args.settlementKeyFingerprint,
    );
    if (receipt) {
      if (!receiptMatches(receipt, "invoice", args.identityFingerprint)) {
        throw new Error(
          "Subscription invoice replay does not match settlement",
        );
      }
      return { outcome: "duplicate" as const };
    }
    const existingReview = await getSettlementManualReview(
      ctx,
      args.settlementKeyFingerprint,
    );
    if (existingReview) {
      if (
        !isInvoiceManualReview(existingReview) ||
        existingReview.identityFingerprint !== args.identityFingerprint
      ) {
        throw new Error(
          "Subscription invoice replay does not match manual review",
        );
      }
      if (existingReview.status === "open") {
        return { outcome: "manual_review" as const };
      }
    }
    const existing = await ctx.db
      .query("lemonSqueezyInvoiceInbox")
      .withIndex("by_settlement_key_fingerprint", (q) =>
        q.eq("settlementKeyFingerprint", args.settlementKeyFingerprint),
      )
      .take(2);
    if (existing.length > 1) {
      throw new Error("Duplicate subscription invoice inbox entries");
    }
    if (existing[0]) {
      if (existing[0].identityFingerprint !== args.identityFingerprint) {
        throw new Error("Subscription invoice replay does not match inbox");
      }
      return {
        outcome:
          existing[0].status === "manual_review"
            ? ("manual_review" as const)
            : ("queued" as const),
      };
    }

    const { fingerprintKeyAttestation: _fingerprintKeyAttestation, ...inbox } =
      args;
    void _fingerprintKeyAttestation;
    const now = Date.now();
    const inboxId = await ctx.db.insert("lemonSqueezyInvoiceInbox", {
      ...inbox,
      fingerprintVersion: 1,
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: now,
      expiresAt: getFiveYearExpiration(now),
      createdAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.lemonSqueezy.webhook.processSubscriptionInvoiceInbox,
      { inboxId },
    );
    return { outcome: "queued" as const };
  },
});

/** Lease one durable invoice work item for an action worker. */
export const claimSubscriptionInvoiceInbox = internalMutation({
  args: {
    inboxId: v.id("lemonSqueezyInvoiceInbox"),
    fingerprintKeyAttestation: v.string(),
  },
  handler: async (ctx, args) => {
    await assertAndPinSettlementConfiguration(ctx, args);
    const inbox = await ctx.db.get(args.inboxId);
    const now = Date.now();
    if (
      !inbox ||
      inbox.status === "manual_review" ||
      inbox.nextAttemptAt > now
    ) {
      return null;
    }
    const receipt = await getSettlementReceipt(
      ctx,
      inbox.settlementKeyFingerprint,
    );
    if (receipt) {
      if (!receiptMatches(receipt, "invoice", inbox.identityFingerprint)) {
        const error = "Invoice receipt conflicts with durable inbox identity.";
        await createOrReopenInvoiceProcessingReview(
          ctx,
          inbox,
          `Invoice processing stopped: ${error}`,
          now,
        );
        await ctx.db.patch(inbox._id, {
          status: "manual_review",
          lastError: error,
          updatedAt: now,
        });
        return null;
      }
      await ctx.db.delete(inbox._id);
      return null;
    }
    const attemptCount = inbox.attemptCount + 1;
    const leaseToken = `${inbox._id}:${attemptCount}:${now}`;
    await ctx.db.patch(inbox._id, {
      status: "processing",
      attemptCount,
      leaseToken,
      nextAttemptAt: now + INVOICE_INBOX_LEASE_MS,
      updatedAt: now,
    });
    return { ...inbox, attemptCount, leaseToken };
  },
});

/** Delete a terminal inbox item only after its durable outcome is visible. */
export const completeSubscriptionInvoiceInbox = internalMutation({
  args: {
    inboxId: v.id("lemonSqueezyInvoiceInbox"),
    leaseToken: v.string(),
    settlementOutcome: v.union(
      v.literal("applied"),
      v.literal("duplicate"),
      v.literal("stale"),
      v.literal("manual_review"),
    ),
    fingerprintKeyAttestation: v.string(),
  },
  handler: async (ctx, args) => {
    await assertAndPinSettlementConfiguration(ctx, args);
    const inbox = await ctx.db.get(args.inboxId);
    if (!inbox || inbox.leaseToken !== args.leaseToken) return false;
    const receipt = await getSettlementReceipt(
      ctx,
      inbox.settlementKeyFingerprint,
    );
    if (receipt) {
      if (!receiptMatches(receipt, "invoice", inbox.identityFingerprint)) {
        throw new Error(
          "Invoice receipt conflicts with durable inbox identity",
        );
      }
      await ctx.db.delete(inbox._id);
      return true;
    }
    if (args.settlementOutcome === "manual_review") {
      if (
        await terminalizeExactInvoiceProcessingReview(
          ctx,
          inbox,
          `Subscription invoice settlement requires operator review: ${RENEWAL_INVOICE_WALLET_UNDERFUNDED_REASON}`,
          Date.now(),
        )
      ) {
        return true;
      }
      throw new Error(
        "Cannot complete invoice inbox without its exact manual review",
      );
    }
    throw new Error("Cannot complete invoice inbox without its exact receipt");
  },
});

/** Persist a bounded retry and schedule it atomically with the state change. */
export const deferSubscriptionInvoiceInbox = internalMutation({
  args: {
    inboxId: v.id("lemonSqueezyInvoiceInbox"),
    leaseToken: v.string(),
    error: v.string(),
    fingerprintKeyAttestation: v.string(),
  },
  handler: async (ctx, args) => {
    await assertAndPinSettlementConfiguration(ctx, args);
    const inbox = await ctx.db.get(args.inboxId);
    if (!inbox || inbox.leaseToken !== args.leaseToken) return false;
    const now = Date.now();
    const boundedError = args.error.slice(0, 300);
    if (
      args.error === RENEWAL_INVOICE_BOUNDARY_NOT_DUE_REASON &&
      inbox.billingReason === "renewal"
    ) {
      const subscription = await getTrustedLemonSubscriptionById(
        ctx,
        inbox.subscriptionId,
      );
      const boundary = subscription
        ? await getEarliestPendingBillingBoundary(ctx, subscription._id)
        : null;
      if (
        subscription?.lemonSqueezyCustomerId === inbox.customerId &&
        boundary &&
        boundary.periodEnd > now &&
        inbox.invoiceCreatedAt >=
          boundary.periodEnd - INVOICE_BOUNDARY_TOLERANCE_MS &&
        inbox.invoiceCreatedAt <=
          boundary.periodEnd + INVOICE_BOUNDARY_TOLERANCE_MS
      ) {
        const delayMs = boundary.periodEnd - now;
        await ctx.db.patch(inbox._id, {
          status: "pending",
          attemptCount: Math.max(0, inbox.attemptCount - 1),
          leaseToken: undefined,
          nextAttemptAt: boundary.periodEnd,
          lastError: boundedError,
          updatedAt: now,
        });
        await ctx.scheduler.runAfter(
          delayMs,
          internal.lemonSqueezy.webhook.processSubscriptionInvoiceInbox,
          { inboxId: inbox._id },
        );
        return true;
      }
    }

    if (
      await terminalizeExactInvoiceProcessingReview(
        ctx,
        inbox,
        `Subscription invoice settlement requires operator review: ${RENEWAL_INVOICE_WALLET_UNDERFUNDED_REASON}`,
        now,
      )
    ) {
      return true;
    }

    const terminal = inbox.attemptCount >= INVOICE_INBOX_MAX_ATTEMPTS;
    const delayMs = Math.min(
      60 * 60 * 1000,
      30_000 * 2 ** Math.min(Math.max(0, inbox.attemptCount - 1), 7),
    );
    if (terminal) {
      await createOrReopenInvoiceProcessingReview(
        ctx,
        inbox,
        `Invoice processing exhausted automatic retries: ${boundedError}`,
        now,
      );
    }
    await ctx.db.patch(inbox._id, {
      status: terminal ? "manual_review" : "pending",
      leaseToken: undefined,
      nextAttemptAt: terminal ? inbox.expiresAt : now + delayMs,
      lastError: boundedError,
      updatedAt: now,
    });
    if (!terminal) {
      await ctx.scheduler.runAfter(
        delayMs,
        internal.lemonSqueezy.webhook.processSubscriptionInvoiceInbox,
        { inboxId: inbox._id },
      );
    }
    return true;
  },
});

/** Recover due work or an action that disappeared while holding a lease. */
export const recoverSubscriptionInvoiceInbox = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const [pending, processing] = await Promise.all(
      (["pending", "processing"] as const).map((status) =>
        ctx.db
          .query("lemonSqueezyInvoiceInbox")
          .withIndex("by_status_and_next_attempt", (q) =>
            q.eq("status", status).lte("nextAttemptAt", now),
          )
          .take(INVOICE_INBOX_RECOVERY_BATCH_SIZE),
      ),
    );
    const due = [...pending, ...processing].slice(
      0,
      INVOICE_INBOX_RECOVERY_BATCH_SIZE,
    );
    for (const inbox of due) {
      if (inbox.status === "processing") {
        await ctx.db.patch(inbox._id, {
          status: "pending",
          leaseToken: undefined,
          updatedAt: now,
        });
      }
      await ctx.scheduler.runAfter(
        0,
        internal.lemonSqueezy.webhook.processSubscriptionInvoiceInbox,
        { inboxId: inbox._id },
      );
    }
    return { scheduled: due.length };
  },
});

export const grantTrialCredit = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => await grantTrialCreditOnce(ctx, args.userId),
});
