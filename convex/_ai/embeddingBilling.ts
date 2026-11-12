import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { v } from "convex/values";
import {
  LEGACY_GOOGLE_MODELS,
  PRICING,
  getEmbeddingPricePer1M,
} from "./config";
import {
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_INPUT_TOKEN_LIMIT,
  type EmbeddingBatchResult,
} from "./retrievalEmbeddings";
import { isDevelopmentSiteUrl } from "../_utils/environment";
import { MAX_COLLECT_LIMIT } from "../_utils/pagination";
import {
  getSafeQuotaTokenLimit,
  hasValidPurchasedTokenDebitCoverage,
  readQuotaTokenUsage,
} from "../tokenUsage/quota";
import { getSubscriptionForEntitlement } from "../subscriptions/entitlement";
import { readEffectiveSubscriptionQuota } from "../subscriptions/quotaEntitlement";
import { recordEmbeddingUsageInTransaction } from "../tokenUsage/internalMutation";
import {
  settleAllEndedTrustedProQuotas,
  TerminalProQuotaUnavailableError,
} from "../subscriptions/billingBoundaries";
import {
  EmbeddingProviderError,
  type EmbeddingClientOptions,
  type EmbeddingKeys,
  type EmbeddingPaidReservationReason,
  type EmbeddingPolicy,
  type EmbeddingRoute,
} from "./embeddings";

export const PAID_USAGE_LIMIT_MESSAGE =
  "Paid embedding usage is unavailable because the account token limit was reached";
export const PAID_USAGE_RECONCILIATION_MESSAGE =
  "Paid embedding usage is paused until unresolved provider usage is reconciled";
export const USAGE_RESERVATION_TTL_MS = 10 * 60 * 1_000;
const USAGE_RESERVATION_RETENTION_MS = 24 * 60 * 60 * 1_000;
const USAGE_RESERVATION_CLEANUP_LIMIT = 100;
const PROVIDER_START_MAX_ATTEMPTS = 3;
const USAGE_MUTATION_MAX_ATTEMPTS = 3;
const USAGE_MUTATION_RETRY_BASE_DELAY_MS = 100;
const EMBEDDING_SETTLEMENT_INITIAL_DELAY_MS = 1_000;
const EMBEDDING_SETTLEMENT_RECOVERY_INTERVAL_MS = 5 * 60 * 1_000;
const EMBEDDING_SETTLEMENT_RECOVERY_LIMIT = 100;

export type EmbeddingBillingDecision = {
  policy: EmbeddingPolicy;
  canEmbed: boolean;
  paidUsageAllowed: boolean;
};

export type EmbeddingUsageOperation =
  | "RAG index"
  | "RAG search"
  | "repository learning create"
  | "repository learning search";

function isTerminalPaidEmbeddingReservationReason(
  reason: string,
): reason is EmbeddingPaidReservationReason {
  return (
    reason === "reservation_finalized" ||
    reason === "provider_already_started" ||
    reason === "reservation_closed"
  );
}

function getTerminalPaidEmbeddingReservationMessage(
  reason: EmbeddingPaidReservationReason,
): string {
  const state =
    reason === "reservation_finalized"
      ? "was already finalized"
      : reason === "provider_already_started"
        ? "already entered the provider boundary"
        : "is closed or has ambiguous provider usage";
  return `Paid AI embedding work cannot be retried safely because its reservation ${state}; reconcile provider usage manually before retrying repository indexing`;
}

/** A paid request the provider explicitly rejected before billable work. */
export function isExplicitPaidEmbeddingProviderRejection(
  error: unknown,
): boolean {
  return (
    error instanceof EmbeddingProviderError &&
    error.route === "paid" &&
    (error.kind === "rate_limit" ||
      error.kind === "authentication" ||
      (error.kind === "request" &&
        error.httpStatus !== undefined &&
        error.httpStatus !== 408 &&
        error.httpStatus !== 499))
  );
}

function getPaidQuotaTokens(
  providerTokens: number,
  provider: "google" | "openai" = "google",
  model = LEGACY_GOOGLE_MODELS.embeddingModelId as string,
): number {
  return Math.ceil(
    (providerTokens * getEmbeddingPricePer1M(provider, model)) /
      PRICING.QUOTA_REFERENCE_COST_PER_1M,
  );
}

/** Reserve against the model's documented maximum before provider usage. */
export function getEmbeddingReservationTokens(
  inputCount: number,
  providerTokenLimit: number = inputCount * EMBEDDING_INPUT_TOKEN_LIMIT,
  provider: "google" | "openai" = "google",
  model = LEGACY_GOOGLE_MODELS.embeddingModelId as string,
): number {
  if (
    !Number.isInteger(inputCount) ||
    inputCount < 1 ||
    inputCount > EMBEDDING_BATCH_SIZE
  ) {
    throw new EmbeddingProviderError(
      "invalid_input",
      `Embedding reservation input count must be between 1 and ${EMBEDDING_BATCH_SIZE}`,
      { retryable: false },
    );
  }

  if (
    !Number.isSafeInteger(providerTokenLimit) ||
    providerTokenLimit < 1 ||
    providerTokenLimit > inputCount * EMBEDDING_INPUT_TOKEN_LIMIT
  ) {
    throw new EmbeddingProviderError(
      "invalid_input",
      "AI embedding reservation token limit is invalid",
      { retryable: false },
    );
  }

  return getPaidQuotaTokens(providerTokenLimit, provider, model);
}

function canUseConfiguredCredential(
  policy: EmbeddingPolicy,
  keys: EmbeddingKeys,
  paidUsageAllowed: boolean,
): boolean {
  const hasFreeCredential = Boolean(keys.freeApiKey?.trim());
  const hasPaidCredential = Boolean(keys.paidApiKey?.trim());

  if (policy.route === "paid") {
    return paidUsageAllowed && hasPaidCredential;
  }

  if (hasFreeCredential) {
    return true;
  }

  const allowPaidFallback = policy.allowPaidFallback;
  return allowPaidFallback && paidUsageAllowed && hasPaidCredential;
}

/** Resolve credentials early; every paid provider call is rechecked atomically. */
export async function resolveEmbeddingBillingDecision(
  ctx: ActionCtx,
  args: {
    userId: Id<"users">;
    provider?: "google" | "openai";
    policy: EmbeddingPolicy;
    keys: EmbeddingKeys;
  },
): Promise<EmbeddingBillingDecision> {
  if (args.provider !== "openai") {
    return { policy: args.policy, canEmbed: false, paidUsageAllowed: false };
  }
  const hasFreeCredential = Boolean(args.keys.freeApiKey?.trim());
  const hasPaidCredential = Boolean(args.keys.paidApiKey?.trim());
  const paidUsagePossible =
    hasPaidCredential &&
    (args.policy.route === "paid" || args.policy.allowPaidFallback);

  if (!paidUsagePossible) {
    return {
      policy: args.policy,
      canEmbed: canUseConfiguredCredential(args.policy, args.keys, true),
      paidUsageAllowed: true,
    };
  }

  const allowance = await ctx.runQuery(
    internal.subscriptions.internalQuery.canPerformActionInternal,
    { userId: args.userId },
  );
  if (allowance.allowed) {
    // Select the effective paid policy before the RAG claim chooses its
    // durable tier and input mode. Otherwise a paid-only deployment would pay
    // for de-identified free-tier vectors and persist the wrong tier.
    const policy: EmbeddingPolicy =
      args.policy.route === "free" && !hasFreeCredential
        ? { route: "paid", allowPaidFallback: false }
        : args.policy;
    return {
      policy,
      canEmbed: canUseConfiguredCredential(policy, args.keys, true),
      paidUsageAllowed: true,
    };
  }

  const policy: EmbeddingPolicy =
    args.policy.route === "free"
      ? { route: "free", allowPaidFallback: false }
      : { route: "paid", allowPaidFallback: false };
  return {
    policy,
    canEmbed: canUseConfiguredCredential(policy, args.keys, false),
    paidUsageAllowed: false,
  };
}

type EmbeddingQuotaSnapshot = {
  subscriptionId?: Id<"subscriptions">;
  entitlementPlan: "free" | "pro";
  includedTokens: number;
  serviceFeeRate: number;
  quotaPeriodStart: number;
  quotaPeriodEnd: number;
};

type PaidEmbeddingQuotaDecision =
  | { allowed: true; snapshot: EmbeddingQuotaSnapshot }
  | {
      allowed: false;
      reason:
        | "invalid_subscription_balance"
        | "usage_history_too_large"
        | "reservation_history_too_large"
        | "provider_attempt_in_progress"
        | "unresolved_provider_usage"
        | "limit_reached";
    };

function blocksActiveEmbeddingProvider(reservation: {
  provider?: string;
}): boolean {
  return (reservation.provider ?? "google") !== "google";
}

async function hasBlockingProviderUsage(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<boolean> {
  const [ambiguousChat, ambiguousEmbedding, activeChat, activeEmbedding] =
    await Promise.all([
      ctx.db
        .query("chatUsageReservations")
        .withIndex("by_user_key_source_and_status", (q) =>
          q
            .eq("userId", userId)
            .eq("keySource", undefined)
            .eq("status", "ambiguous"),
        )
        .take(USAGE_RESERVATION_CLEANUP_LIMIT + 1),
      ctx.db
        .query("embeddingUsageReservations")
        .withIndex("by_user_and_status", (q) =>
          q.eq("userId", userId).eq("status", "ambiguous"),
        )
        .take(USAGE_RESERVATION_CLEANUP_LIMIT + 1),
      ctx.db
        .query("chatUsageReservations")
        .withIndex("by_user_key_source_status_and_provider_started_at", (q) =>
          q
            .eq("userId", userId)
            .eq("keySource", undefined)
            .eq("status", "pending")
            .gte("providerStartedAt", 0),
        )
        .take(USAGE_RESERVATION_CLEANUP_LIMIT + 1),
      ctx.db
        .query("embeddingUsageReservations")
        .withIndex("by_user_status_and_provider_started_at", (q) =>
          q
            .eq("userId", userId)
            .eq("status", "pending")
            .gte("providerStartedAt", 0),
        )
        .take(USAGE_RESERVATION_CLEANUP_LIMIT + 1),
    ]);
  return Boolean(
    [ambiguousChat, ambiguousEmbedding, activeChat, activeEmbedding].some(
      (rows) =>
        rows.length > USAGE_RESERVATION_CLEANUP_LIMIT ||
        rows.some(blocksActiveEmbeddingProvider),
    ),
  );
}

/**
 * Resolve expired rows and fail closed on any provider-started ambiguity.
 * This guard runs before development and subscription-plan bypasses.
 */
async function checkUnresolvedPaidEmbeddingUsage(
  ctx: MutationCtx,
  args: { userId: Id<"users">; now: number },
): Promise<PaidEmbeddingQuotaDecision | null> {
  const ambiguousChat = await ctx.db
    .query("chatUsageReservations")
    .withIndex("by_user_key_source_and_status", (q) =>
      q
        .eq("userId", args.userId)
        .eq("keySource", undefined)
        .eq("status", "ambiguous"),
    )
    .take(USAGE_RESERVATION_CLEANUP_LIMIT + 1);
  if (ambiguousChat.length > USAGE_RESERVATION_CLEANUP_LIMIT) {
    return { allowed: false, reason: "reservation_history_too_large" };
  }
  if (ambiguousChat.some(blocksActiveEmbeddingProvider)) {
    return { allowed: false, reason: "unresolved_provider_usage" };
  }
  const expiredChat = await ctx.db
    .query("chatUsageReservations")
    .withIndex("by_user_key_source_status_settlement_and_expiration", (q) =>
      q
        .eq("userId", args.userId)
        .eq("keySource", undefined)
        .eq("status", "pending")
        .eq("settlementState", undefined)
        .lte("expiresAt", args.now),
    )
    .take(USAGE_RESERVATION_CLEANUP_LIMIT + 1);
  if (expiredChat.length > USAGE_RESERVATION_CLEANUP_LIMIT) {
    return { allowed: false, reason: "reservation_history_too_large" };
  }
  for (const reservation of expiredChat) {
    const providerStarted = reservation.providerStartedAt !== undefined;
    await ctx.db.patch(reservation._id, {
      status: providerStarted ? "ambiguous" : "released",
      releaseReason: providerStarted ? "ambiguous_provider_attempt" : "expired",
      updatedAt: args.now,
    });
    if (providerStarted && blocksActiveEmbeddingProvider(reservation)) {
      return { allowed: false, reason: "unresolved_provider_usage" };
    }
  }
  const activeChatAttempt = await ctx.db
    .query("chatUsageReservations")
    .withIndex("by_user_key_source_status_and_provider_started_at", (q) =>
      q
        .eq("userId", args.userId)
        .eq("keySource", undefined)
        .eq("status", "pending")
        .gte("providerStartedAt", 0),
    )
    .take(USAGE_RESERVATION_CLEANUP_LIMIT + 1);
  if (activeChatAttempt.length > USAGE_RESERVATION_CLEANUP_LIMIT) {
    return { allowed: false, reason: "reservation_history_too_large" };
  }
  if (activeChatAttempt.some(blocksActiveEmbeddingProvider)) {
    return { allowed: false, reason: "provider_attempt_in_progress" };
  }

  const ambiguous = await ctx.db
    .query("embeddingUsageReservations")
    .withIndex("by_user_and_status", (q) =>
      q.eq("userId", args.userId).eq("status", "ambiguous"),
    )
    .take(USAGE_RESERVATION_CLEANUP_LIMIT + 1);
  if (ambiguous.length > USAGE_RESERVATION_CLEANUP_LIMIT) {
    return { allowed: false, reason: "reservation_history_too_large" };
  }
  if (ambiguous.some(blocksActiveEmbeddingProvider)) {
    return { allowed: false, reason: "unresolved_provider_usage" };
  }

  const expiredPending = await ctx.db
    .query("embeddingUsageReservations")
    .withIndex("by_user_status_settlement_and_expiration", (q) =>
      q
        .eq("userId", args.userId)
        .eq("status", "pending")
        .eq("settlementState", undefined)
        .lte("expiresAt", args.now),
    )
    .take(USAGE_RESERVATION_CLEANUP_LIMIT + 1);
  if (expiredPending.length > USAGE_RESERVATION_CLEANUP_LIMIT) {
    return { allowed: false, reason: "reservation_history_too_large" };
  }
  for (const reservation of expiredPending) {
    const providerStarted = reservation.providerStartedAt !== undefined;
    await ctx.db.patch(reservation._id, {
      status: providerStarted ? "ambiguous" : "released",
      releaseReason: providerStarted ? "ambiguous_provider_attempt" : "expired",
      updatedAt: args.now,
    });
    if (providerStarted && blocksActiveEmbeddingProvider(reservation)) {
      return { allowed: false, reason: "unresolved_provider_usage" };
    }
  }

  // A provider-started action can disappear before its catch handler records
  // ambiguity. Block another paid call while it is still live; expiration above
  // promotes a crashed attempt to the durable reconciliation state.
  const providerAttemptInProgress = await ctx.db
    .query("embeddingUsageReservations")
    .withIndex("by_user_status_and_provider_started_at", (q) =>
      q
        .eq("userId", args.userId)
        .eq("status", "pending")
        .gte("providerStartedAt", 0),
    )
    .take(USAGE_RESERVATION_CLEANUP_LIMIT + 1);
  if (providerAttemptInProgress.length > USAGE_RESERVATION_CLEANUP_LIMIT) {
    return { allowed: false, reason: "reservation_history_too_large" };
  }
  if (providerAttemptInProgress.some(blocksActiveEmbeddingProvider)) {
    return { allowed: false, reason: "provider_attempt_in_progress" };
  }

  return null;
}

async function checkPaidEmbeddingQuota(
  ctx: MutationCtx,
  args: {
    userId: Id<"users">;
    newReservationTokens: number;
    now: number;
  },
): Promise<PaidEmbeddingQuotaDecision> {
  const unresolved = await checkUnresolvedPaidEmbeddingUsage(ctx, args);
  if (unresolved) {
    return unresolved;
  }
  try {
    await settleAllEndedTrustedProQuotas(ctx, args.userId, args.now);
  } catch (error) {
    if (error instanceof TerminalProQuotaUnavailableError) {
      return { allowed: false, reason: "invalid_subscription_balance" };
    }
    throw error;
  }
  const subscription = await getSubscriptionForEntitlement(
    ctx,
    args.userId,
    args.now,
  );
  const quota = await readEffectiveSubscriptionQuota(
    ctx,
    subscription,
    args.now,
  );
  if (!quota.verified) {
    return { allowed: false, reason: quota.reason };
  }
  const entitlement = quota.entitlement;
  const snapshot: EmbeddingQuotaSnapshot = {
    ...(subscription ? { subscriptionId: subscription._id } : {}),
    entitlementPlan: entitlement.plan,
    includedTokens: entitlement.includedTokens,
    serviceFeeRate: entitlement.serviceFeeRate,
    quotaPeriodStart: entitlement.periodStart,
    quotaPeriodEnd: entitlement.periodEnd,
  };
  if (isDevelopmentSiteUrl()) {
    return { allowed: true, snapshot };
  }
  const { includedTokens, purchasedTokens, periodStart, periodEnd } =
    entitlement;

  const usage = await readQuotaTokenUsage(ctx, {
    userId: args.userId,
    periodStart,
    periodEndExclusive: periodEnd,
  });
  if (!usage.verified) {
    return { allowed: false, reason: "usage_history_too_large" };
  }
  if (
    !hasValidPurchasedTokenDebitCoverage(
      usage.tokensUsed,
      includedTokens,
      usage.purchasedTokensDebited,
    )
  ) {
    return { allowed: false, reason: "invalid_subscription_balance" };
  }
  const tokenLimit = getSafeQuotaTokenLimit(
    includedTokens,
    purchasedTokens,
    usage.purchasedTokensDebited,
  );
  if (tokenLimit === null) {
    return { allowed: false, reason: "invalid_subscription_balance" };
  }

  const [
    pendingReservations,
    pendingChatReservations,
    ambiguousReservations,
    ambiguousChatReservations,
  ] = await Promise.all([
    ctx.db
      .query("embeddingUsageReservations")
      .withIndex("by_user_and_status", (q) =>
        q.eq("userId", args.userId).eq("status", "pending"),
      )
      .take(MAX_COLLECT_LIMIT + 1),
    ctx.db
      .query("chatUsageReservations")
      .withIndex("by_user_key_source_and_status", (q) =>
        q
          .eq("userId", args.userId)
          .eq("keySource", undefined)
          .eq("status", "pending"),
      )
      .take(MAX_COLLECT_LIMIT + 1),
    ctx.db
      .query("embeddingUsageReservations")
      .withIndex("by_user_and_status", (q) =>
        q.eq("userId", args.userId).eq("status", "ambiguous"),
      )
      .take(USAGE_RESERVATION_CLEANUP_LIMIT + 1),
    ctx.db
      .query("chatUsageReservations")
      .withIndex("by_user_key_source_and_status", (q) =>
        q
          .eq("userId", args.userId)
          .eq("keySource", undefined)
          .eq("status", "ambiguous"),
      )
      .take(USAGE_RESERVATION_CLEANUP_LIMIT + 1),
  ]);
  if (
    ambiguousReservations.length > USAGE_RESERVATION_CLEANUP_LIMIT ||
    ambiguousChatReservations.length > USAGE_RESERVATION_CLEANUP_LIMIT ||
    pendingReservations.length > MAX_COLLECT_LIMIT ||
    pendingChatReservations.length > MAX_COLLECT_LIMIT ||
    pendingReservations.length + pendingChatReservations.length >
      MAX_COLLECT_LIMIT
  ) {
    return { allowed: false, reason: "reservation_history_too_large" };
  }

  let reservedTokens = 0;
  for (const reservation of pendingReservations) {
    if (reservation.expiresAt <= args.now) {
      if (reservation.settlementState === "staged") {
        reservedTokens += reservation.reservedTokens;
        continue;
      }
      const ambiguous = reservation.providerStartedAt !== undefined;
      await ctx.db.patch(reservation._id, {
        status: ambiguous ? "ambiguous" : "released",
        releaseReason: ambiguous ? "ambiguous_provider_attempt" : "expired",
        updatedAt: args.now,
      });
      if (ambiguous) {
        reservedTokens += reservation.reservedTokens;
      }
    } else {
      reservedTokens += reservation.reservedTokens;
    }
  }
  for (const reservation of [
    ...pendingChatReservations,
    ...ambiguousReservations,
    ...ambiguousChatReservations,
  ]) {
    reservedTokens += reservation.reservedTokens;
    if (!Number.isSafeInteger(reservedTokens)) {
      return { allowed: false, reason: "invalid_subscription_balance" };
    }
  }

  if (
    usage.tokensUsed + reservedTokens + args.newReservationTokens >
    tokenLimit
  ) {
    return { allowed: false, reason: "limit_reached" };
  }

  return { allowed: true, snapshot };
}

/**
 * Atomically reserve account quota before a paid AI request. Pending
 * reservations are included so concurrent actions cannot all spend the same
 * prepaid allowance.
 */
export const reservePaidEmbeddingUsage = internalMutation({
  args: {
    reservationKey: v.string(),
    attemptToken: v.string(),
    userId: v.id("users"),
    repositoryId: v.id("repositories"),
    operation: v.string(),
    inputCount: v.number(),
    providerTokenLimit: v.number(),
    provider: v.optional(v.union(v.literal("google"), v.literal("openai"))),
    model: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!args.attemptToken.trim()) {
      throw new Error("embedding usage attempt token is invalid");
    }
    const newReservationTokens = getEmbeddingReservationTokens(
      args.inputCount,
      args.providerTokenLimit,
      args.provider ?? "google",
      args.model ?? LEGACY_GOOGLE_MODELS.embeddingModelId,
    );

    const recordedUsage = await ctx.db
      .query("tokenUsage")
      .withIndex("by_embedding_reservation", (q) =>
        q.eq("embeddingReservationKey", args.reservationKey),
      )
      .first();
    if (recordedUsage) {
      return {
        allowed: false as const,
        reason: "reservation_finalized" as const,
      };
    }

    const existing = await ctx.db
      .query("embeddingUsageReservations")
      .withIndex("by_reservation_key", (q) =>
        q.eq("reservationKey", args.reservationKey),
      )
      .first();
    if (existing) {
      const matches =
        (existing.provider ?? "google") === (args.provider ?? "google") &&
        (existing.model ?? LEGACY_GOOGLE_MODELS.embeddingModelId) ===
          (args.model ?? LEGACY_GOOGLE_MODELS.embeddingModelId) &&
        existing.userId === args.userId &&
        existing.repositoryId === args.repositoryId &&
        existing.operation === args.operation &&
        existing.inputCount === args.inputCount &&
        existing.providerTokenLimit === args.providerTokenLimit &&
        existing.reservedTokens === newReservationTokens;
      if (!matches) {
        throw new Error("embedding usage reservation identity mismatch");
      }
      const now = Date.now();
      if (
        existing.status === "pending" &&
        existing.settlementState === "staged"
      ) {
        return {
          allowed: false as const,
          reason: "provider_already_started" as const,
        };
      }
      if (existing.status === "pending" && existing.expiresAt <= now) {
        if (existing.providerStartedAt !== undefined) {
          await ctx.db.patch(existing._id, {
            status: "ambiguous",
            releaseReason: "ambiguous_provider_attempt",
            updatedAt: now,
          });
          return {
            allowed: false as const,
            reason: "reservation_closed" as const,
          };
        }
      }
      const safelyReleased =
        existing.status === "released" &&
        (existing.releaseReason === "request_finished_without_paid_usage" ||
          (existing.releaseReason === "entitlement_period_ended" &&
            existing.providerStartedAt === undefined) ||
          (existing.releaseReason === "expired" &&
            existing.providerStartedAt === undefined));
      const safelyExpired =
        existing.status === "pending" &&
        existing.expiresAt <= now &&
        existing.providerStartedAt === undefined;
      if (safelyReleased || safelyExpired) {
        const quota = await checkPaidEmbeddingQuota(ctx, {
          userId: args.userId,
          newReservationTokens,
          now,
        });
        if (!quota.allowed) {
          return quota;
        }

        await ctx.db.patch(existing._id, {
          attemptToken: args.attemptToken,
          ...quota.snapshot,
          status: "pending",
          releaseReason: undefined,
          providerStartedAt: undefined,
          settlementState: undefined,
          settlementTokens: undefined,
          settlementStagedAt: undefined,
          settlementNextRecoveryAt: undefined,
          settlementScheduleId: undefined,
          // This row represents a new provider attempt. Keep the indexed
          // quota-period timestamp aligned with the attempt that can become
          // ambiguous, even though the deterministic key row is reused.
          createdAt: now,
          expiresAt: now + USAGE_RESERVATION_TTL_MS,
          updatedAt: now,
        });
        return {
          allowed: true as const,
          reservationKey: existing.reservationKey,
        };
      }
      if (existing.status === "pending" && existing.providerStartedAt) {
        return {
          allowed: false as const,
          reason: "provider_already_started" as const,
        };
      }
      if (existing.status === "pending") {
        return existing.attemptToken === args.attemptToken
          ? { allowed: true as const, reservationKey: existing.reservationKey }
          : { allowed: false as const, reason: "attempt_in_progress" as const };
      }
      return { allowed: false as const, reason: "reservation_closed" as const };
    }

    const now = Date.now();
    const quota = await checkPaidEmbeddingQuota(ctx, {
      userId: args.userId,
      newReservationTokens,
      now,
    });
    if (!quota.allowed) {
      return quota;
    }

    await ctx.db.insert("embeddingUsageReservations", {
      reservationKey: args.reservationKey,
      attemptToken: args.attemptToken,
      userId: args.userId,
      repositoryId: args.repositoryId,
      operation: args.operation,
      provider: args.provider,
      model: args.model,
      inputCount: args.inputCount,
      providerTokenLimit: args.providerTokenLimit,
      reservedTokens: newReservationTokens,
      ...quota.snapshot,
      status: "pending",
      expiresAt: now + USAGE_RESERVATION_TTL_MS,
      createdAt: now,
      updatedAt: now,
    });
    return { allowed: true as const, reservationKey: args.reservationKey };
  },
});

/** Persist the point after which retrying the same paid-capable request is ambiguous. */
export const markEmbeddingUsageProviderStarted = internalMutation({
  args: {
    reservationKey: v.string(),
    attemptToken: v.string(),
    userId: v.id("users"),
    repositoryId: v.id("repositories"),
  },
  handler: async (ctx, args) => {
    const reservation = await ctx.db
      .query("embeddingUsageReservations")
      .withIndex("by_reservation_key", (q) =>
        q.eq("reservationKey", args.reservationKey),
      )
      .first();
    const now = Date.now();
    if (!reservation) {
      return { started: false as const, reason: "reservation_closed" as const };
    }
    if (
      reservation.userId !== args.userId ||
      reservation.repositoryId !== args.repositoryId ||
      reservation.attemptToken !== args.attemptToken
    ) {
      throw new Error("embedding usage reservation identity mismatch");
    }
    if (reservation.status !== "pending" || reservation.expiresAt <= now) {
      return { started: false as const, reason: "reservation_closed" as const };
    }
    if (reservation.quotaPeriodEnd <= now) {
      await ctx.db.patch(reservation._id, {
        status: "released",
        releaseReason: "entitlement_period_ended",
        updatedAt: now,
      });
      return { started: false as const, reason: "reservation_closed" as const };
    }
    if (reservation.providerStartedAt !== undefined) {
      return { started: true as const, alreadyStarted: true as const };
    }
    const hasUnresolvedUsage = await hasBlockingProviderUsage(ctx, args.userId);
    if (hasUnresolvedUsage) {
      return {
        started: false as const,
        reason: "provider_attempt_in_progress" as const,
      };
    }
    await ctx.db.patch(reservation._id, {
      providerStartedAt: now,
      updatedAt: now,
    });
    return { started: true as const, alreadyStarted: false as const };
  },
});

/** Persist an unresolved provider-started attempt immediately after failure. */
export const markEmbeddingUsageAmbiguous = internalMutation({
  args: {
    reservationKey: v.string(),
    attemptToken: v.string(),
    userId: v.id("users"),
    repositoryId: v.id("repositories"),
  },
  handler: async (ctx, args) => {
    const reservation = await ctx.db
      .query("embeddingUsageReservations")
      .withIndex("by_reservation_key", (q) =>
        q.eq("reservationKey", args.reservationKey),
      )
      .first();
    if (!reservation) {
      return false;
    }
    if (
      reservation.userId !== args.userId ||
      reservation.repositoryId !== args.repositoryId ||
      reservation.attemptToken !== args.attemptToken
    ) {
      throw new Error("embedding usage reservation identity mismatch");
    }
    if (reservation.status === "ambiguous") {
      return true;
    }
    if (
      reservation.status !== "pending" ||
      reservation.settlementState === "staged" ||
      reservation.providerStartedAt === undefined
    ) {
      return false;
    }
    await ctx.db.patch(reservation._id, {
      status: "ambiguous",
      releaseReason: "ambiguous_provider_attempt",
      updatedAt: Date.now(),
    });
    return true;
  },
});

export const releasePaidEmbeddingUsage = internalMutation({
  args: {
    reservationKey: v.string(),
    attemptToken: v.string(),
    userId: v.id("users"),
    repositoryId: v.id("repositories"),
    confirmedNotBilled: v.boolean(),
  },
  handler: async (ctx, args) => {
    const reservation = await ctx.db
      .query("embeddingUsageReservations")
      .withIndex("by_reservation_key", (q) =>
        q.eq("reservationKey", args.reservationKey),
      )
      .first();
    if (!reservation) {
      return false;
    }
    if (
      reservation.userId !== args.userId ||
      reservation.repositoryId !== args.repositoryId
    ) {
      throw new Error("embedding usage reservation identity mismatch");
    }
    if (
      reservation.status !== "pending" ||
      reservation.settlementState === "staged"
    ) {
      return false;
    }
    if (
      reservation.attemptToken !== args.attemptToken ||
      (reservation.providerStartedAt !== undefined && !args.confirmedNotBilled)
    ) {
      return false;
    }
    await ctx.db.patch(reservation._id, {
      status: "released",
      releaseReason: "request_finished_without_paid_usage",
      updatedAt: Date.now(),
    });
    return true;
  },
});

export const settleStagedEmbeddingOutcome = internalMutation({
  args: {
    reservationKey: v.string(),
    attemptToken: v.string(),
    fromScheduler: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const reservation = await ctx.db
      .query("embeddingUsageReservations")
      .withIndex("by_reservation_key", (q) =>
        q.eq("reservationKey", args.reservationKey),
      )
      .first();
    if (!reservation) return { status: "missing" as const };
    if (reservation.attemptToken !== args.attemptToken) {
      throw new Error("AI embedding settlement ownership mismatch");
    }

    const clearStagedOutcome = async () => {
      if (!args.fromScheduler && reservation.settlementScheduleId) {
        const scheduled = await ctx.db.system.get(
          reservation.settlementScheduleId,
        );
        if (scheduled?.state.kind === "pending") {
          await ctx.scheduler.cancel(reservation.settlementScheduleId);
        }
      }
      await ctx.db.patch(reservation._id, {
        settlementState: undefined,
        settlementTokens: undefined,
        settlementStagedAt: undefined,
        settlementNextRecoveryAt: undefined,
        settlementScheduleId: undefined,
        updatedAt: Date.now(),
      });
    };

    if (reservation.status === "finalized") {
      if (reservation.settlementState === "staged") {
        const usage = reservation.usageId
          ? await ctx.db.get(reservation.usageId)
          : null;
        if (
          !usage ||
          usage.embeddingReservationKey !== reservation.reservationKey ||
          usage.embeddingReservationAttemptToken !== reservation.attemptToken ||
          usage.embeddingTokens !== reservation.settlementTokens ||
          usage.model !==
            (reservation.model ?? LEGACY_GOOGLE_MODELS.embeddingModelId) ||
          usage.provider !== (reservation.provider ?? "google")
        ) {
          throw new Error("AI embedding settlement outcome mismatch");
        }
        await clearStagedOutcome();
      }
      return { status: "finalized" as const, usageId: reservation.usageId };
    }
    if (reservation.status === "released") {
      return { status: "released" as const };
    }
    if (
      (reservation.status !== "pending" &&
        reservation.status !== "ambiguous") ||
      reservation.settlementState !== "staged" ||
      reservation.settlementTokens === undefined
    ) {
      return { status: "not_staged" as const };
    }
    if (reservation.status === "ambiguous") {
      await ctx.db.patch(reservation._id, {
        status: "pending",
        releaseReason: undefined,
        updatedAt: Date.now(),
      });
    }
    if (!args.fromScheduler && reservation.settlementScheduleId) {
      const scheduled = await ctx.db.system.get(
        reservation.settlementScheduleId,
      );
      if (scheduled?.state.kind === "pending") {
        await ctx.scheduler.cancel(reservation.settlementScheduleId);
      }
    }

    const usageId = await recordEmbeddingUsageInTransaction(ctx, {
      userId: reservation.userId,
      repositoryId: reservation.repositoryId,
      tokens: reservation.settlementTokens,
      model: reservation.model ?? LEGACY_GOOGLE_MODELS.embeddingModelId,
      provider: reservation.provider ?? "google",
      billingTier: "paid",
      reservationKey: reservation.reservationKey,
      reservationAttemptToken: reservation.attemptToken,
    });
    if (!usageId) {
      throw new Error("AI embedding settlement did not record usage");
    }
    await ctx.db.patch(reservation._id, {
      settlementState: undefined,
      settlementTokens: undefined,
      settlementStagedAt: undefined,
      settlementNextRecoveryAt: undefined,
      settlementScheduleId: undefined,
      updatedAt: Date.now(),
    });
    return { status: "finalized" as const, usageId };
  },
});

export async function stageEmbeddingProviderOutcomeInTransaction(
  ctx: MutationCtx,
  args: {
    reservationKey: string;
    attemptToken: string;
    userId: Id<"users">;
    repositoryId: Id<"repositories">;
    tokens: number;
    provider?: "google" | "openai";
    model?: string;
  },
): Promise<{ staged: boolean; alreadySettled: boolean }> {
  const reservation = await ctx.db
    .query("embeddingUsageReservations")
    .withIndex("by_reservation_key", (q) =>
      q.eq("reservationKey", args.reservationKey),
    )
    .first();
  if (!reservation) {
    throw new Error("AI embedding reservation is missing");
  }
  if (
    (reservation.provider ?? "google") !== (args.provider ?? "google") ||
    (reservation.model ?? LEGACY_GOOGLE_MODELS.embeddingModelId) !==
      (args.model ?? LEGACY_GOOGLE_MODELS.embeddingModelId) ||
    reservation.userId !== args.userId ||
    reservation.repositoryId !== args.repositoryId ||
    reservation.attemptToken !== args.attemptToken
  ) {
    throw new Error("AI embedding settlement identity mismatch");
  }
  if (!Number.isSafeInteger(args.tokens) || args.tokens <= 0) {
    throw new Error("AI embedding settlement token count is invalid");
  }

  if (reservation.status === "finalized") {
    const usage = reservation.usageId
      ? await ctx.db.get(reservation.usageId)
      : null;
    if (
      !usage ||
      usage.embeddingReservationKey !== reservation.reservationKey ||
      usage.embeddingReservationAttemptToken !== reservation.attemptToken ||
      usage.embeddingTokens !== args.tokens ||
      usage.model !==
        (reservation.model ?? LEGACY_GOOGLE_MODELS.embeddingModelId) ||
      usage.provider !== (reservation.provider ?? "google")
    ) {
      throw new Error("AI embedding settlement outcome mismatch");
    }
    return { staged: false, alreadySettled: true };
  }
  if (
    reservation.settlementState === "staged" &&
    reservation.settlementTokens !== undefined
  ) {
    if (reservation.settlementTokens !== args.tokens) {
      throw new Error("AI embedding settlement outcome mismatch");
    }
    return { staged: true, alreadySettled: false };
  }
  if (
    (reservation.status !== "pending" && reservation.status !== "ambiguous") ||
    reservation.providerStartedAt === undefined ||
    args.tokens > reservation.providerTokenLimit
  ) {
    throw new Error("AI embedding reservation cannot stage provider usage");
  }

  const now = Date.now();
  const settlementScheduleId = await ctx.scheduler.runAfter(
    EMBEDDING_SETTLEMENT_INITIAL_DELAY_MS,
    internal._ai.embeddingBilling.settleStagedEmbeddingOutcome,
    {
      reservationKey: reservation.reservationKey,
      attemptToken: reservation.attemptToken,
      fromScheduler: true,
    },
  );
  await ctx.db.patch(reservation._id, {
    status: "pending",
    releaseReason: undefined,
    settlementState: "staged",
    settlementTokens: args.tokens,
    settlementStagedAt: now,
    settlementNextRecoveryAt: now + EMBEDDING_SETTLEMENT_RECOVERY_INTERVAL_MS,
    settlementScheduleId,
    updatedAt: now,
  });
  return { staged: true, alreadySettled: false };
}

export const stageEmbeddingProviderOutcome = internalMutation({
  args: {
    reservationKey: v.string(),
    attemptToken: v.string(),
    userId: v.id("users"),
    repositoryId: v.id("repositories"),
    tokens: v.number(),
    provider: v.optional(v.union(v.literal("google"), v.literal("openai"))),
    model: v.optional(v.string()),
  },
  handler: stageEmbeddingProviderOutcomeInTransaction,
});

export const recoverStagedEmbeddingOutcomes = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const staged = await ctx.db
      .query("embeddingUsageReservations")
      .withIndex("by_settlement_state_and_recovery", (q) =>
        q.eq("settlementState", "staged").lte("settlementNextRecoveryAt", now),
      )
      .take(EMBEDDING_SETTLEMENT_RECOVERY_LIMIT);
    for (const reservation of staged) {
      const settlementScheduleId = await ctx.scheduler.runAfter(
        0,
        internal._ai.embeddingBilling.settleStagedEmbeddingOutcome,
        {
          reservationKey: reservation.reservationKey,
          attemptToken: reservation.attemptToken,
          fromScheduler: true,
        },
      );
      await ctx.db.patch(reservation._id, {
        settlementNextRecoveryAt:
          now + EMBEDDING_SETTLEMENT_RECOVERY_INTERVAL_MS,
        settlementScheduleId,
        updatedAt: now,
      });
    }
    return { scheduled: staged.length };
  },
});

/** Expire abandoned safe reservations and bound non-ambiguous history. */
export const cleanupEmbeddingUsageReservations = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const expiredPending = await ctx.db
      .query("embeddingUsageReservations")
      .withIndex("by_status_settlement_and_expiration", (q) =>
        q
          .eq("status", "pending")
          .eq("settlementState", undefined)
          .lte("expiresAt", now),
      )
      .take(USAGE_RESERVATION_CLEANUP_LIMIT);
    for (const reservation of expiredPending) {
      const ambiguous = reservation.providerStartedAt !== undefined;
      await ctx.db.patch(reservation._id, {
        status: ambiguous ? "ambiguous" : "released",
        releaseReason: ambiguous ? "ambiguous_provider_attempt" : "expired",
        updatedAt: now,
      });
    }

    const retentionCutoff = now - USAGE_RESERVATION_RETENTION_MS;
    let deleted = 0;
    let retainedHistoryProcessed = 0;
    for (const status of ["finalized", "released"] as const) {
      const reservations = await ctx.db
        .query("embeddingUsageReservations")
        .withIndex("by_status_and_expiration", (q) =>
          q.eq("status", status).lte("expiresAt", retentionCutoff),
        )
        .take(USAGE_RESERVATION_CLEANUP_LIMIT - retainedHistoryProcessed);
      for (const reservation of reservations) {
        await ctx.db.delete(reservation._id);
        deleted++;
        retainedHistoryProcessed++;
      }
      if (retainedHistoryProcessed === USAGE_RESERVATION_CLEANUP_LIMIT) {
        break;
      }
    }

    const continuationScheduled =
      expiredPending.length === USAGE_RESERVATION_CLEANUP_LIMIT ||
      retainedHistoryProcessed === USAGE_RESERVATION_CLEANUP_LIMIT;
    if (continuationScheduled) {
      await ctx.scheduler.runAfter(
        0,
        internal._ai.embeddingBilling.cleanupEmbeddingUsageReservations,
        {},
      );
    }

    return {
      expired: expiredPending.length,
      deleted,
      continuationScheduled,
    };
  },
});

/** Meter paid usage and durably close any known-free fallback reservation. */
export async function recordEmbeddingUsage(
  ctx: ActionCtx,
  args: {
    userId: Id<"users">;
    repositoryId: Id<"repositories">;
    result: EmbeddingBatchResult;
    operation: EmbeddingUsageOperation;
    reservationKey?: string;
    reservationAttemptToken?: string;
  },
): Promise<void> {
  if (args.result.route === "free" && !args.reservationKey) {
    return;
  }
  if (args.result.route === "paid" && args.result.tokens <= 0) {
    throw new EmbeddingProviderError(
      "invalid_response",
      "Paid AI embedding response did not include positive token usage",
      { retryable: false, route: "paid" },
    );
  }

  try {
    await ctx.runMutation(
      internal.tokenUsage.internalMutation.recordEmbeddingUsage,
      {
        userId: args.userId,
        repositoryId: args.repositoryId,
        tokens: args.result.tokens,
        model: args.result.model,
        provider: args.result.provider,
        billingTier: args.result.route,
        reservationKey: args.reservationKey,
        reservationAttemptToken: args.reservationAttemptToken,
      },
    );
  } catch {
    if (args.result.route === "paid" || args.reservationKey) {
      throw new EmbeddingProviderError(
        "provider",
        args.result.route === "paid"
          ? "Paid AI embedding usage could not be recorded"
          : "Known-free embedding reservation could not be released",
        {
          retryable: args.result.route === "free",
          route: args.result.route,
          durableRetrySafe: args.result.route === "free",
        },
      );
    }

    console.warn(
      `[EmbeddingBilling] Free ${args.operation} usage metering failed for repository ${args.repositoryId}; continuing without a usage record`,
    );
  }
}

async function stageEmbeddingOutcomeWithRetry(
  ctx: ActionCtx,
  args: {
    reservationKey: string;
    attemptToken: string;
    userId: Id<"users">;
    repositoryId: Id<"repositories">;
    tokens: number;
    provider?: "google" | "openai";
    model?: string;
  },
): Promise<void> {
  let stagingError: unknown;
  for (let attempt = 0; attempt < USAGE_MUTATION_MAX_ATTEMPTS; attempt++) {
    try {
      await ctx.runMutation(
        internal._ai.embeddingBilling.stageEmbeddingProviderOutcome,
        args,
      );
      return;
    } catch (error) {
      stagingError = error;
      if (attempt + 1 < USAGE_MUTATION_MAX_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            USAGE_MUTATION_RETRY_BASE_DELAY_MS * 2 ** attempt,
          ),
        );
      }
    }
  }
  throw (
    stagingError ??
    new Error("AI embedding provider outcome could not be staged")
  );
}

async function settleEmbeddingOutcomeWithRetry(
  ctx: ActionCtx,
  args: { reservationKey: string; attemptToken: string },
): Promise<boolean> {
  for (let attempt = 0; attempt < USAGE_MUTATION_MAX_ATTEMPTS; attempt++) {
    try {
      const result = await ctx.runMutation(
        internal._ai.embeddingBilling.settleStagedEmbeddingOutcome,
        { ...args, fromScheduler: false },
      );
      if (result.status !== "finalized" && result.status !== "released") {
        throw new Error("AI embedding provider outcome is no longer staged");
      }
      return true;
    } catch {
      if (attempt + 1 < USAGE_MUTATION_MAX_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            USAGE_MUTATION_RETRY_BASE_DELAY_MS * 2 ** attempt,
          ),
        );
      }
    }
  }
  console.error("AI embedding usage settlement deferred to durable recovery");
  return false;
}

async function releaseReservationBestEffort(
  ctx: ActionCtx,
  args: {
    reservationKey: string;
    attemptToken: string;
    userId: Id<"users">;
    repositoryId: Id<"repositories">;
    confirmedNotBilled: boolean;
  },
): Promise<void> {
  for (let attempt = 0; attempt < USAGE_MUTATION_MAX_ATTEMPTS; attempt++) {
    try {
      await ctx.runMutation(
        internal._ai.embeddingBilling.releasePaidEmbeddingUsage,
        args,
      );
      return;
    } catch {
      if (attempt + 1 < USAGE_MUTATION_MAX_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            USAGE_MUTATION_RETRY_BASE_DELAY_MS * 2 ** attempt,
          ),
        );
      }
    }
  }
  console.warn(
    `[EmbeddingBilling] Could not release an AI usage reservation for repository ${args.repositoryId}; it will expire automatically`,
  );
}

async function markReservationAmbiguousBestEffort(
  ctx: ActionCtx,
  args: {
    reservationKey: string;
    attemptToken: string;
    userId: Id<"users">;
    repositoryId: Id<"repositories">;
  },
): Promise<void> {
  try {
    await ctx.runMutation(
      internal._ai.embeddingBilling.markEmbeddingUsageAmbiguous,
      args,
    );
  } catch {
    console.warn(
      `[EmbeddingBilling] Could not mark ambiguous AI usage for repository ${args.repositoryId}; the reservation remains fail-closed until cleanup`,
    );
  }
}

/** Reserve, execute, and meter one AI request as a single billing protocol. */
export async function executeEmbeddingRequest(
  ctx: ActionCtx,
  args: {
    userId: Id<"users">;
    provider?: "google" | "openai";
    model?: string;
    repositoryId: Id<"repositories">;
    policy: EmbeddingPolicy;
    keys: EmbeddingKeys;
    inputCount: number;
    inputTokenLimit: number;
    operation: EmbeddingUsageOperation;
    reservationKey?: string;
    validateProviderRequest?: (route: EmbeddingRoute) => Promise<void>;
    request: (
      policy: EmbeddingPolicy,
      client: Required<Pick<EmbeddingClientOptions, "beforeProviderRequest">>,
    ) => Promise<EmbeddingBatchResult>;
    stageProviderOutcome?: (args: {
      result: EmbeddingBatchResult;
      reservationKey: string;
      reservationAttemptToken: string;
    }) => Promise<void>;
    finalize?: (args: {
      result: EmbeddingBatchResult;
      reservationKey?: string;
      reservationAttemptToken?: string;
    }) => Promise<void>;
  },
): Promise<EmbeddingBatchResult> {
  const provider = args.provider ?? "google";
  const model = args.model ?? LEGACY_GOOGLE_MODELS.embeddingModelId;
  getEmbeddingPricePer1M(provider, model);
  if (provider === "google")
    throw new EmbeddingProviderError(
      "configuration",
      "Google embeddings are no longer supported",
    );
  if (
    !args.keys.paidApiKey?.trim() ||
    args.policy.route !== "paid" ||
    args.policy.allowPaidFallback
  ) {
    throw new EmbeddingProviderError(
      "configuration",
      "OpenAI embeddings require paid credentials and policy",
    );
  }
  const finalizeResult = async (
    result: EmbeddingBatchResult,
    reservationKey?: string,
    reservationAttemptToken?: string,
  ): Promise<void> => {
    if (result.route === "paid" && result.tokens <= 0) {
      throw new EmbeddingProviderError(
        "invalid_response",
        "Paid AI embedding response did not include positive token usage",
        { retryable: false, route: "paid" },
      );
    }
    if (args.finalize) {
      await args.finalize({
        result,
        reservationKey,
        reservationAttemptToken,
      });
      return;
    }
    await recordEmbeddingUsage(ctx, {
      userId: args.userId,
      repositoryId: args.repositoryId,
      result,
      operation: args.operation,
      reservationKey,
      reservationAttemptToken,
    });
  };

  const candidateKey = args.reservationKey ?? crypto.randomUUID();
  const attemptToken = crypto.randomUUID();
  let reservation:
    | { allowed: true; reservationKey: string }
    | { allowed: false; reason: string };
  try {
    reservation = await ctx.runMutation(
      internal._ai.embeddingBilling.reservePaidEmbeddingUsage,
      {
        reservationKey: candidateKey,
        attemptToken,
        userId: args.userId,
        repositoryId: args.repositoryId,
        operation: args.operation,
        inputCount: args.inputCount,
        providerTokenLimit: args.inputTokenLimit,
        provider,
        model,
      },
    );
  } catch {
    throw new EmbeddingProviderError(
      "request",
      "Paid AI embedding quota could not be reserved",
      { retryable: true, route: "paid", durableRetrySafe: true },
    );
  }

  if (!reservation.allowed) {
    if (isTerminalPaidEmbeddingReservationReason(reservation.reason)) {
      throw new EmbeddingProviderError(
        "request",
        getTerminalPaidEmbeddingReservationMessage(reservation.reason),
        {
          retryable: false,
          route: "paid",
          paidReservationReason: reservation.reason,
        },
      );
    }
    if (reservation.reason === "attempt_in_progress") {
      throw new EmbeddingProviderError(
        "reservation_busy",
        "The same paid AI embedding work is already in progress",
        { retryable: true, route: "paid", durableRetrySafe: true },
      );
    }
    if (reservation.reason === "provider_attempt_in_progress") {
      throw new EmbeddingProviderError(
        "reservation_busy",
        "Another paid AI embedding request is already in progress for this account",
        { retryable: true, route: "paid", durableRetrySafe: true },
      );
    }
    if (reservation.reason === "unresolved_provider_usage") {
      throw new EmbeddingProviderError(
        "request",
        PAID_USAGE_RECONCILIATION_MESSAGE,
        { retryable: false, route: "paid" },
      );
    }
    throw new EmbeddingProviderError("request", PAID_USAGE_LIMIT_MESSAGE, {
      retryable: false,
      route: "paid",
    });
  }
  const reservationKey = reservation.reservationKey;

  const stagePaidResultWithRetry = async (
    result: EmbeddingBatchResult,
  ): Promise<void> => {
    if (!args.stageProviderOutcome) {
      await stageEmbeddingOutcomeWithRetry(ctx, {
        reservationKey,
        attemptToken,
        userId: args.userId,
        repositoryId: args.repositoryId,
        tokens: result.tokens,
        provider,
        model,
      });
      return;
    }

    let stagingError: unknown;
    for (let attempt = 0; attempt < USAGE_MUTATION_MAX_ATTEMPTS; attempt++) {
      try {
        await args.stageProviderOutcome({
          result,
          reservationKey,
          reservationAttemptToken: attemptToken,
        });
        return;
      } catch (error) {
        stagingError = error;
        if (attempt + 1 < USAGE_MUTATION_MAX_ATTEMPTS) {
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              USAGE_MUTATION_RETRY_BASE_DELAY_MS * 2 ** attempt,
            ),
          );
        }
      }
    }
    throw (
      stagingError ??
      new Error("AI embedding provider outcome could not be staged")
    );
  };

  let paidResultReceived = false;
  let paidProviderStarted = false;
  let outcomeStaged = false;
  let settled = false;
  let receivedResult: EmbeddingBatchResult | undefined;
  try {
    const result = await args.request(
      {
        route: "paid",
        allowPaidFallback: false,
      },
      {
        beforeProviderRequest: async (route) => {
          if (route !== "paid") {
            throw new EmbeddingProviderError(
              "configuration",
              "Paid AI embedding request selected a free credential",
              { route: "paid", durableRetrySafe: true },
            );
          }
          await args.validateProviderRequest?.(route);
          if (paidProviderStarted) {
            return;
          }

          let providerStart:
            | { started: true; alreadyStarted: boolean }
            | { started: false; reason: string }
            | undefined;
          for (
            let attempt = 0;
            attempt < PROVIDER_START_MAX_ATTEMPTS;
            attempt++
          ) {
            try {
              providerStart = await ctx.runMutation(
                internal._ai.embeddingBilling.markEmbeddingUsageProviderStarted,
                {
                  reservationKey,
                  attemptToken,
                  userId: args.userId,
                  repositoryId: args.repositoryId,
                },
              );
              break;
            } catch {
              // Repeating this exact identity is idempotent and still precedes fetch.
            }
          }
          if (!providerStart?.started) {
            throw new EmbeddingProviderError(
              providerStart?.reason === "provider_attempt_in_progress"
                ? "reservation_busy"
                : "request",
              "Paid AI embedding request could not be durably started",
              { retryable: true, route: "paid", durableRetrySafe: true },
            );
          }
          paidProviderStarted = true;
        },
      },
    );
    if (!paidProviderStarted) {
      throw new EmbeddingProviderError(
        "configuration",
        "Paid AI embedding request bypassed durable billing",
        { route: "paid", durableRetrySafe: true },
      );
    }
    if (result.provider !== provider || result.model !== model) {
      throw new EmbeddingProviderError(
        "invalid_response",
        "Embedding response provider/model does not match the reservation",
        { route: "paid", provider },
      );
    }
    if (result.route !== "paid") {
      throw new EmbeddingProviderError(
        "invalid_response",
        "Paid AI embedding request returned an invalid billing route",
        { retryable: false, route: "paid" },
      );
    }
    if (!Number.isSafeInteger(result.tokens) || result.tokens <= 0) {
      throw new EmbeddingProviderError(
        "invalid_response",
        "Paid AI embedding response did not include valid positive token usage",
        { retryable: false, route: "paid" },
      );
    }
    paidResultReceived = true;
    receivedResult = result;
    await stagePaidResultWithRetry(result);
    outcomeStaged = true;
    await finalizeResult(result, reservationKey, attemptToken);
    settled = await settleEmbeddingOutcomeWithRetry(ctx, {
      reservationKey,
      attemptToken,
    });
    return result;
  } catch (error) {
    const knownBilledTokens =
      error instanceof EmbeddingProviderError &&
      error.route === "paid" &&
      error.provider === provider &&
      Number.isSafeInteger(error.knownBilledTokens) &&
      (error.knownBilledTokens ?? 0) > 0
        ? error.knownBilledTokens
        : undefined;
    const exactProviderTokens = receivedResult?.tokens ?? knownBilledTokens;
    if (
      reservationKey &&
      paidProviderStarted &&
      !outcomeStaged &&
      exactProviderTokens !== undefined
    ) {
      try {
        if (receivedResult) {
          await stagePaidResultWithRetry(receivedResult);
        } else {
          await stageEmbeddingOutcomeWithRetry(ctx, {
            reservationKey,
            attemptToken,
            userId: args.userId,
            repositoryId: args.repositoryId,
            tokens: exactProviderTokens,
            provider,
            model,
          });
        }
        outcomeStaged = true;
      } catch {
        console.error(
          `[EmbeddingBilling] Known paid AI usage could not be staged for repository ${args.repositoryId}`,
        );
      }
    }
    if (outcomeStaged && !settled) {
      await settleEmbeddingOutcomeWithRetry(ctx, {
        reservationKey,
        attemptToken,
      });
    }

    const explicitPaidRejection =
      isExplicitPaidEmbeddingProviderRejection(error) &&
      error instanceof EmbeddingProviderError &&
      error.provider === provider;
    if (
      reservationKey &&
      paidProviderStarted &&
      !explicitPaidRejection &&
      !outcomeStaged
    ) {
      // Never release or silently forget a provider-started request whose
      // billing outcome is unknown. Persist the account-wide hold immediately;
      // expiration cleanup is only a crash-recovery fallback.
      await markReservationAmbiguousBestEffort(ctx, {
        reservationKey,
        attemptToken,
        userId: args.userId,
        repositoryId: args.repositoryId,
      });
    }
    if (
      reservationKey &&
      !paidResultReceived &&
      !outcomeStaged &&
      (!paidProviderStarted || explicitPaidRejection)
    ) {
      await releaseReservationBestEffort(ctx, {
        reservationKey,
        attemptToken,
        userId: args.userId,
        repositoryId: args.repositoryId,
        confirmedNotBilled: !paidProviderStarted || explicitPaidRejection,
      });
    }
    throw error;
  }
}
