import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { PRICING } from "../_ai/config";
import { readQuotaTokenUsage } from "../tokenUsage/quota";
import {
  hasTrustedProEntitlement,
  isLemonProviderProvenance,
} from "./entitlement";
import {
  debitPurchasedTokenWallet,
  getUserWalletRows,
  readPurchasedTokenWalletBalance,
} from "./wallet";

export const MAX_MONTHLY_BOUNDARY_SPAN_MS = 35 * 24 * 60 * 60 * 1_000;
export const INVOICE_BOUNDARY_TOLERANCE_MS = 24 * 60 * 60 * 1_000;
export const RENEWAL_INVOICE_WALLET_UNDERFUNDED_REASON =
  "Purchased-token wallet cannot cover the exact renewal settlement.";
const MAX_TERMINAL_BOUNDARIES = 100;
const MAX_PROVIDER_HOLDS_PER_SCOPE = 100;

type BoundaryReadCtx = Pick<MutationCtx | QueryCtx, "db">;

export type CurrentTrustedProPurchasedTokenLiability =
  | { verified: true; outstandingTokens: number }
  | {
      verified: false;
      reason:
        | "invalid_billing_period"
        | "untrusted_pro_entitlement"
        | "usage_history_too_large";
    };

/**
 * Read purchased-token usage already incurred in a live trusted Pro period.
 * The amount remains unsettled until the exact provider boundary closes.
 */
export async function readCurrentTrustedProPurchasedTokenLiability(
  ctx: BoundaryReadCtx,
  subscription: Doc<"subscriptions">,
  now: number,
): Promise<CurrentTrustedProPurchasedTokenLiability> {
  if (!hasTrustedProEntitlement(subscription, now)) {
    if (subscription.plan === "pro") {
      const provenance = subscription.proEntitlementProvenance;
      const isSettledEndedTrustedPro =
        provenance !== undefined &&
        (isLemonProviderProvenance(provenance.source) ||
          provenance.source === "admin_override") &&
        Number.isSafeInteger(provenance.verifiedAt) &&
        provenance.verifiedAt > 0 &&
        provenance.verifiedAt <= now &&
        Number.isSafeInteger(subscription.periodEnd) &&
        subscription.periodEnd <= now &&
        !(await hasUnsettledBoundary(ctx, subscription));
      if (isSettledEndedTrustedPro) {
        return { verified: true, outstandingTokens: 0 };
      }
      return { verified: false, reason: "untrusted_pro_entitlement" };
    }
    return { verified: true, outstandingTokens: 0 };
  }
  if (
    !Number.isSafeInteger(subscription.periodStart) ||
    !Number.isSafeInteger(subscription.periodEnd) ||
    subscription.periodStart < 0 ||
    subscription.periodStart > now ||
    subscription.periodEnd <= now ||
    subscription.periodEnd <= subscription.periodStart ||
    subscription.periodEnd - subscription.periodStart >
      MAX_MONTHLY_BOUNDARY_SPAN_MS ||
    !Number.isSafeInteger(subscription.includedTokens) ||
    subscription.includedTokens !== PRICING.PRO_INCLUDED_TOKENS ||
    subscription.billingBoundaryReconciliationRequired ||
    subscription.billingBoundaryManualReviewReason !== undefined
  ) {
    return { verified: false, reason: "invalid_billing_period" };
  }

  const usage = await readQuotaTokenUsage(ctx, {
    userId: subscription.userId,
    periodStart: subscription.periodStart,
    periodEndExclusive: subscription.periodEnd,
  });
  if (!usage.verified) return usage;

  const purchasedTokensRequired = Math.max(
    0,
    usage.tokensUsed - subscription.includedTokens,
  );
  if (usage.purchasedTokensDebited > purchasedTokensRequired) {
    return { verified: false, reason: "invalid_billing_period" };
  }
  return {
    verified: true,
    outstandingTokens: purchasedTokensRequired - usage.purchasedTokensDebited,
  };
}

export async function ensureBillingBoundary(
  ctx: MutationCtx,
  args: {
    subscriptionId: Id<"subscriptions">;
    periodStart: number;
    periodEnd: number;
    providerUpdatedAt: number;
    now: number;
  },
): Promise<void> {
  if (
    !Number.isSafeInteger(args.periodStart) ||
    !Number.isSafeInteger(args.periodEnd) ||
    args.periodEnd <= args.periodStart
  ) {
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

export async function getLatestBillingBoundary(
  ctx: BoundaryReadCtx,
  subscriptionId: Id<"subscriptions">,
): Promise<Doc<"subscriptionBillingBoundaries"> | null> {
  return await ctx.db
    .query("subscriptionBillingBoundaries")
    .withIndex("by_subscription_and_period_end", (q) =>
      q.eq("subscriptionId", subscriptionId),
    )
    .order("desc")
    .first();
}

export async function getEarliestPendingBillingBoundary(
  ctx: BoundaryReadCtx,
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

export async function synchronizeBillingBoundaryQueue(
  ctx: MutationCtx,
  subscription: Doc<"subscriptions">,
  args: {
    status: "active" | "canceled" | "expired";
    providerCreatedAt: number;
    providerUpdatedAt: number;
    periodEnd: number;
  },
  now: number,
): Promise<boolean> {
  let latest = await getLatestBillingBoundary(ctx, subscription._id);
  if (
    !latest &&
    isLemonProviderProvenance(subscription.proEntitlementProvenance?.source) &&
    subscription.periodEnd > subscription.periodStart &&
    subscription.periodEnd - subscription.periodStart <=
      MAX_MONTHLY_BOUNDARY_SPAN_MS
  ) {
    await ensureBillingBoundary(ctx, {
      subscriptionId: subscription._id,
      periodStart: subscription.periodStart,
      periodEnd: subscription.periodEnd,
      providerUpdatedAt:
        subscription.providerUpdatedAt ?? args.providerUpdatedAt,
      now,
    });
    latest = await getLatestBillingBoundary(ctx, subscription._id);
  }

  if (!latest) {
    if (
      args.periodEnd - args.providerCreatedAt >
      MAX_MONTHLY_BOUNDARY_SPAN_MS
    ) {
      return true;
    }
    await ensureBillingBoundary(ctx, {
      subscriptionId: subscription._id,
      periodStart: args.providerCreatedAt,
      periodEnd: args.periodEnd,
      providerUpdatedAt: args.providerUpdatedAt,
      now,
    });
    return false;
  }

  if (args.periodEnd < latest.periodEnd) {
    if (
      args.status === "expired" &&
      latest.status === "pending" &&
      args.periodEnd > latest.periodStart
    ) {
      await ctx.db.patch(latest._id, {
        periodEnd: args.periodEnd,
        providerUpdatedAt: args.providerUpdatedAt,
        updatedAt: now,
      });
      return subscription.billingBoundaryReconciliationRequired ?? false;
    }
    return subscription.billingBoundaryReconciliationRequired ?? false;
  }
  if (args.periodEnd === latest.periodEnd) {
    return subscription.billingBoundaryReconciliationRequired ?? false;
  }
  if (args.periodEnd - latest.periodEnd > MAX_MONTHLY_BOUNDARY_SPAN_MS) {
    return true;
  }
  await ensureBillingBoundary(ctx, {
    subscriptionId: subscription._id,
    periodStart: latest.periodEnd,
    periodEnd: args.periodEnd,
    providerUpdatedAt: args.providerUpdatedAt,
    now,
  });
  return false;
}

async function getExactBoundary(
  ctx: BoundaryReadCtx,
  subscription: Doc<"subscriptions">,
): Promise<Doc<"subscriptionBillingBoundaries"> | null> {
  const rows = await ctx.db
    .query("subscriptionBillingBoundaries")
    .withIndex("by_subscription_and_period_end", (q) =>
      q
        .eq("subscriptionId", subscription._id)
        .eq("periodEnd", subscription.periodEnd),
    )
    .take(2);
  if (rows.length > 1) {
    throw new Error("Duplicate subscription billing boundaries");
  }
  return rows[0] ?? null;
}

async function hasUnsettledBoundary(
  ctx: BoundaryReadCtx,
  subscription: Doc<"subscriptions">,
): Promise<boolean> {
  if (
    subscription.billingBoundaryReconciliationRequired ||
    subscription.billingBoundaryManualReviewReason !== undefined
  ) {
    return true;
  }
  const [pending, manualReview, exact] = await Promise.all([
    ctx.db
      .query("subscriptionBillingBoundaries")
      .withIndex("by_subscription_status_and_period_end", (q) =>
        q.eq("subscriptionId", subscription._id).eq("status", "pending"),
      )
      .first(),
    ctx.db
      .query("subscriptionBillingBoundaries")
      .withIndex("by_subscription_status_and_period_end", (q) =>
        q.eq("subscriptionId", subscription._id).eq("status", "manual_review"),
      )
      .first(),
    getExactBoundary(ctx, subscription),
  ]);
  return Boolean(
    pending ||
    manualReview ||
    !exact ||
    exact.status !== "settled" ||
    exact.periodStart < subscription.periodStart,
  );
}

export async function hasUnsettledEndedTrustedProQuota(
  ctx: BoundaryReadCtx,
  userId: Id<"users">,
  now: number,
): Promise<boolean> {
  const rows = await getUserWalletRows(ctx, userId);
  for (const row of rows) {
    if (
      row.plan !== "pro" ||
      row.proEntitlementProvenance === undefined ||
      hasTrustedProEntitlement(row, now)
    ) {
      continue;
    }
    if (await hasUnsettledBoundary(ctx, row)) {
      return true;
    }
  }
  return false;
}

type ProviderHoldDecision = "clear" | "in_progress" | "ambiguous";

function reservationBelongsToBoundary(
  reservation: {
    subscriptionId?: Id<"subscriptions">;
    entitlementPlan: "free" | "pro";
    quotaPeriodStart: number;
    quotaPeriodEnd: number;
    providerStartedAt?: number;
    createdAt: number;
  },
  subscription: Doc<"subscriptions">,
  boundary: Doc<"subscriptionBillingBoundaries">,
): boolean {
  if (reservation.entitlementPlan === "free") return false;
  if (
    reservation.subscriptionId !== undefined &&
    reservation.subscriptionId !== subscription._id
  ) {
    return false;
  }
  if (
    !Number.isSafeInteger(reservation.quotaPeriodStart) ||
    !Number.isSafeInteger(reservation.quotaPeriodEnd)
  ) {
    return false;
  }

  const snapshotCoversBoundary =
    reservation.quotaPeriodStart <= boundary.periodStart &&
    reservation.quotaPeriodEnd >= boundary.periodEnd;
  if (!snapshotCoversBoundary) return false;
  const activityAt = reservation.providerStartedAt ?? reservation.createdAt;
  if (activityAt >= boundary.periodStart && activityAt < boundary.periodEnd) {
    return true;
  }
  return (
    subscription.status !== "active" &&
    boundary.periodEnd === subscription.periodEnd &&
    reservation.quotaPeriodStart === boundary.periodStart &&
    reservation.quotaPeriodEnd > boundary.periodEnd &&
    activityAt >= boundary.periodEnd
  );
}

async function classifyPendingProviderHolds(
  ctx: MutationCtx,
  reservations: Array<
    Doc<"chatUsageReservations"> | Doc<"embeddingUsageReservations">
  >,
  boundary: Doc<"subscriptionBillingBoundaries">,
  now: number,
): Promise<ProviderHoldDecision> {
  for (const reservation of reservations) {
    if (
      "settlementState" in reservation &&
      reservation.settlementState === "staged"
    ) {
      return "in_progress";
    }
    if (reservation.providerStartedAt !== undefined) {
      if (
        reservation.providerStartedAt < boundary.periodStart ||
        reservation.providerStartedAt >= boundary.periodEnd ||
        reservation.expiresAt <= now
      ) {
        await ctx.db.patch(reservation._id, {
          status: "ambiguous",
          releaseReason: "ambiguous_provider_attempt",
          updatedAt: now,
        });
        return "ambiguous";
      }
      return "in_progress";
    }
    await ctx.db.patch(reservation._id, {
      status: "released",
      releaseReason: "entitlement_period_ended",
      updatedAt: now,
    });
  }
  return "clear";
}

async function checkChatProviderHolds(
  ctx: MutationCtx,
  subscription: Doc<"subscriptions">,
  boundary: Doc<"subscriptionBillingBoundaries">,
  now: number,
): Promise<ProviderHoldDecision> {
  const ambiguous = await ctx.db
    .query("chatUsageReservations")
    .withIndex("by_subscription_status_and_period_start", (q) =>
      q.eq("subscriptionId", subscription._id).eq("status", "ambiguous"),
    )
    .take(MAX_PROVIDER_HOLDS_PER_SCOPE + 1);
  if (ambiguous.length > MAX_PROVIDER_HOLDS_PER_SCOPE) return "ambiguous";
  if (
    ambiguous.some((reservation) =>
      reservationBelongsToBoundary(reservation, subscription, boundary),
    )
  ) {
    return "ambiguous";
  }

  const pending = await ctx.db
    .query("chatUsageReservations")
    .withIndex("by_subscription_status_and_period_start", (q) =>
      q.eq("subscriptionId", subscription._id).eq("status", "pending"),
    )
    .take(MAX_PROVIDER_HOLDS_PER_SCOPE + 1);
  if (pending.length > MAX_PROVIDER_HOLDS_PER_SCOPE) return "ambiguous";
  return await classifyPendingProviderHolds(
    ctx,
    pending.filter((reservation) =>
      reservationBelongsToBoundary(reservation, subscription, boundary),
    ),
    boundary,
    now,
  );
}

/**
 * Embeddings are retired: an unsettled embedding hold can no longer finish,
 * so it is released instead of blocking renewal. Only a staged, known-billed
 * outcome waits for its settlement cron.
 */
async function checkEmbeddingProviderHolds(
  ctx: MutationCtx,
  subscription: Doc<"subscriptions">,
  boundary: Doc<"subscriptionBillingBoundaries">,
  now: number,
): Promise<ProviderHoldDecision> {
  let staged = false;
  for (const status of ["pending", "ambiguous"] as const) {
    const reservations = await ctx.db
      .query("embeddingUsageReservations")
      .withIndex("by_subscription_status_and_period_start", (q) =>
        q.eq("subscriptionId", subscription._id).eq("status", status),
      )
      .take(MAX_PROVIDER_HOLDS_PER_SCOPE + 1);
    if (reservations.length > MAX_PROVIDER_HOLDS_PER_SCOPE) return "ambiguous";
    for (const reservation of reservations) {
      if (!reservationBelongsToBoundary(reservation, subscription, boundary))
        continue;
      if (reservation.settlementState === "staged") {
        staged = true;
        continue;
      }
      await ctx.db.patch(reservation._id, {
        status: "released",
        releaseReason: "embeddings_retired",
        updatedAt: now,
      });
    }
  }
  return staged ? "in_progress" : "clear";
}

export async function checkBillingBoundaryProviderHolds(
  ctx: MutationCtx,
  subscription: Doc<"subscriptions">,
  boundary: Doc<"subscriptionBillingBoundaries">,
  now: number,
): Promise<ProviderHoldDecision> {
  const [chatHolds, embeddingHolds] = await Promise.all([
    checkChatProviderHolds(ctx, subscription, boundary, now),
    checkEmbeddingProviderHolds(ctx, subscription, boundary, now),
  ]);
  if (chatHolds === "ambiguous" || embeddingHolds === "ambiguous") {
    return "ambiguous";
  }
  if (chatHolds === "in_progress" || embeddingHolds === "in_progress") {
    return "in_progress";
  }
  return "clear";
}

async function markBoundaryManualReview(
  ctx: MutationCtx,
  subscription: Doc<"subscriptions">,
  boundary: Doc<"subscriptionBillingBoundaries"> | null,
  reason: string,
  now: number,
): Promise<void> {
  if (boundary) {
    await ctx.db.patch(boundary._id, {
      status: "manual_review",
      manualReviewReason: reason,
      updatedAt: now,
    });
  }
  await ctx.db.patch(subscription._id, {
    billingBoundaryReconciliationRequired: true,
    billingBoundaryManualReviewReason: reason,
    updatedAt: now,
  });
}

export type TerminalProSettlementResult =
  | { status: "not_due"; retryAt: number }
  | { status: "in_progress" }
  | { status: "manual_review"; reason: string }
  | { status: "settled"; boundariesSettled: number };

export class TerminalProQuotaUnavailableError extends Error {
  constructor(
    readonly reason: "in_progress" | "manual_review" | "not_due",
    message: string,
  ) {
    super(message);
    this.name = "TerminalProQuotaUnavailableError";
  }
}

export async function settleEndedTrustedProSubscriptionQuota(
  ctx: MutationCtx,
  subscription: Doc<"subscriptions">,
  now: number,
): Promise<TerminalProSettlementResult> {
  if (
    subscription.plan !== "pro" ||
    subscription.proEntitlementProvenance === undefined
  ) {
    return { status: "settled", boundariesSettled: 0 };
  }
  if (
    hasTrustedProEntitlement(subscription, now) ||
    subscription.periodEnd > now
  ) {
    return { status: "not_due", retryAt: subscription.periodEnd };
  }
  if (
    subscription.billingBoundaryReconciliationRequired ||
    subscription.billingBoundaryManualReviewReason !== undefined
  ) {
    const reason =
      subscription.billingBoundaryManualReviewReason ??
      "Subscription billing boundary history requires reconciliation.";
    await markBoundaryManualReview(ctx, subscription, null, reason, now);
    return { status: "manual_review", reason };
  }

  let exact = await getExactBoundary(ctx, subscription);
  if (!exact) {
    if (
      subscription.periodEnd <= subscription.periodStart ||
      subscription.periodEnd - subscription.periodStart >
        MAX_MONTHLY_BOUNDARY_SPAN_MS
    ) {
      const reason = "Exact terminal subscription period is unavailable.";
      await markBoundaryManualReview(ctx, subscription, null, reason, now);
      return { status: "manual_review", reason };
    }
    await ensureBillingBoundary(ctx, {
      subscriptionId: subscription._id,
      periodStart: subscription.periodStart,
      periodEnd: subscription.periodEnd,
      providerUpdatedAt:
        subscription.providerUpdatedAt ??
        subscription.proEntitlementProvenance.verifiedAt,
      now,
    });
    exact = await getExactBoundary(ctx, subscription);
  }
  if (!exact) {
    throw new Error("Failed to create exact terminal billing boundary");
  }

  let boundariesSettled = 0;
  while (boundariesSettled < MAX_TERMINAL_BOUNDARIES) {
    const boundary = await getEarliestPendingBillingBoundary(
      ctx,
      subscription._id,
    );
    if (!boundary || boundary.periodEnd > now) break;
    if (
      boundary.periodStart < subscription.periodStart ||
      boundary.periodEnd > subscription.periodEnd ||
      boundary.periodEnd <= boundary.periodStart
    ) {
      const reason = "Subscription billing boundary chain is inconsistent.";
      await markBoundaryManualReview(ctx, subscription, boundary, reason, now);
      return { status: "manual_review", reason };
    }

    const providerHolds = await checkBillingBoundaryProviderHolds(
      ctx,
      subscription,
      boundary,
      now,
    );
    if (providerHolds === "ambiguous") {
      return { status: "in_progress" };
    }
    if (providerHolds === "in_progress") {
      return { status: "in_progress" };
    }

    const usage = await readQuotaTokenUsage(ctx, {
      userId: subscription.userId,
      periodStart: boundary.periodStart,
      periodEndExclusive: boundary.periodEnd,
    });
    if (!usage.verified) {
      const reason = "Usage history is too large to settle safely.";
      await markBoundaryManualReview(ctx, subscription, boundary, reason, now);
      return { status: "manual_review", reason };
    }
    const purchasedTokensRequired = Math.max(
      0,
      usage.tokensUsed -
        PRICING.PRO_INCLUDED_TOKENS -
        usage.purchasedTokensDebited,
    );
    const walletBalance = await readPurchasedTokenWalletBalance(
      ctx,
      subscription.userId,
    );
    if (walletBalance < purchasedTokensRequired) {
      const reason =
        "Purchased-token wallet cannot cover the exact terminal settlement.";
      await markBoundaryManualReview(ctx, subscription, boundary, reason, now);
      return { status: "manual_review", reason };
    }
    const debit = await debitPurchasedTokenWallet(ctx, {
      userId: subscription.userId,
      targetSubscriptionId: subscription._id,
      tokensToDebit: purchasedTokensRequired,
      now,
    });
    if (debit.debited !== purchasedTokensRequired) {
      throw new Error("Terminal purchased-token debit was not exact");
    }
    await ctx.db.patch(boundary._id, {
      status: "settled",
      settlementReason: "terminal_entitlement",
      purchasedTokensDebited: debit.debited,
      updatedAt: now,
    });
    boundariesSettled++;
  }

  if (boundariesSettled === MAX_TERMINAL_BOUNDARIES) {
    const remaining = await getEarliestPendingBillingBoundary(
      ctx,
      subscription._id,
    );
    if (remaining && remaining.periodEnd <= now) {
      const reason = "Subscription has too many unsettled billing boundaries.";
      await markBoundaryManualReview(ctx, subscription, remaining, reason, now);
      return { status: "manual_review", reason };
    }
  }
  if (await hasUnsettledBoundary(ctx, subscription)) {
    const reason = "Exact terminal subscription settlement is incomplete.";
    await markBoundaryManualReview(ctx, subscription, exact, reason, now);
    return { status: "manual_review", reason };
  }
  return { status: "settled", boundariesSettled };
}

/**
 * True while any Pro row of the user still needs boundary settlement or an
 * operator. Read-only, so callers can skip optional writes such as the trial
 * grant instead of tripping the settlement errors.
 */
export async function hasUnsettledProHistory(
  ctx: BoundaryReadCtx,
  userId: Id<"users">,
  now: number,
): Promise<boolean> {
  try {
    return await readUnsettledProHistory(ctx, userId, now);
  } catch {
    // Corrupt boundary history (for example duplicate boundaries) needs an
    // operator; callers only skip optional work, so report it as unsettled.
    return true;
  }
}

async function readUnsettledProHistory(
  ctx: BoundaryReadCtx,
  userId: Id<"users">,
  now: number,
): Promise<boolean> {
  const rows = await ctx.db
    .query("subscriptions")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(101);
  if (rows.length > 100) return true;
  for (const row of rows) {
    if (row.plan !== "pro" || row.proEntitlementProvenance === undefined)
      continue;
    if (hasTrustedProEntitlement(row, now)) continue;
    if (
      row.periodEnd > now ||
      row.billingBoundaryReconciliationRequired ||
      row.billingBoundaryManualReviewReason !== undefined
    )
      return true;
    const exact = await getExactBoundary(ctx, row);
    if (exact?.status !== "settled") return true;
    const open = await ctx.db
      .query("subscriptionBillingBoundaries")
      .withIndex("by_subscription_status_and_period_end", (q) =>
        q.eq("subscriptionId", row._id).eq("status", "pending"),
      )
      .first();
    const review = await ctx.db
      .query("subscriptionBillingBoundaries")
      .withIndex("by_subscription_status_and_period_end", (q) =>
        q.eq("subscriptionId", row._id).eq("status", "manual_review"),
      )
      .first();
    if (open || review) return true;
  }
  return false;
}

export async function settleAllEndedTrustedProQuotas(
  ctx: MutationCtx,
  userId: Id<"users">,
  now: number,
): Promise<void> {
  const rows = (await getUserWalletRows(ctx, userId))
    .filter(
      (row) =>
        row.plan === "pro" &&
        row.proEntitlementProvenance !== undefined &&
        !hasTrustedProEntitlement(row, now),
    )
    .sort((left, right) => left.periodEnd - right.periodEnd);
  for (const row of rows) {
    const result = await settleEndedTrustedProSubscriptionQuota(ctx, row, now);
    if (result.status === "in_progress") {
      throw new TerminalProQuotaUnavailableError(
        "in_progress",
        "Provider usage is still being finalized for the ended Pro period",
      );
    }
    if (result.status === "manual_review") {
      throw new TerminalProQuotaUnavailableError(
        "manual_review",
        result.reason,
      );
    }
    if (result.status === "not_due") {
      throw new TerminalProQuotaUnavailableError(
        "not_due",
        "Trusted Pro entitlement has not reached its exact period end",
      );
    }
  }
}
