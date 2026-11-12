import { getEmbeddingPricePer1M } from "../_ai/config";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { v } from "convex/values";
import {
  GENERATION_MODELS,
  LEGACY_GOOGLE_MODELS,
  PRICING,
} from "../_ai/config";
import {
  getEffectiveSubscriptionEntitlement,
  getSubscriptionForEntitlement,
  type SubscriptionEntitlementState,
} from "../subscriptions/entitlement";
import { refreshFreeSubscriptionPeriod } from "../subscriptions/quotaEntitlement";
import { debitPurchasedTokenWallet } from "../subscriptions/wallet";
import { readQuotaTokenUsage } from "./quota";
import {
  getUsageHourStart,
  hasUsageTotals,
  insertTokenUsage,
  rebuildUsageTotalsHour,
  USAGE_TOTALS_HOUR_MS,
} from "./totals";

export type ChatUsageReconciliationEvidenceSource =
  | "google_api_response"
  | "google_cloud_billing_export"
  | "google_support_confirmation"
  | "anthropic_api_response"
  | "anthropic_usage_report"
  | "anthropic_support_confirmation"
  | "openai_api_response"
  | "openai_usage_report"
  | "openai_support_confirmation";

export const CHAT_RECONCILIATION_EVIDENCE_REFERENCE_MAX_LENGTH = 500;
const CHAT_RECONCILIATION_RETENTION_MS = 5 * 365 * 24 * 60 * 60 * 1_000;

type ChatQuotaSnapshot = Pick<
  Doc<"chatUsageReservations">,
  | "subscriptionId"
  | "entitlementPlan"
  | "includedTokens"
  | "serviceFeeRate"
  | "quotaPeriodStart"
  | "quotaPeriodEnd"
>;

/** Keep fee selection aligned with the subscription quota policy. */
export function getEffectiveServiceFeeRate(
  subscription: SubscriptionEntitlementState | null,
  now: number = Date.now(),
): number {
  return getEffectiveSubscriptionEntitlement(subscription, now).serviceFeeRate;
}

function assertProviderTokenCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function getSafeTotalTokens(inputTokens: number, outputTokens: number): number {
  assertProviderTokenCount(inputTokens, "Input token count");
  assertProviderTokenCount(outputTokens, "Output token count");
  const totalTokens = inputTokens + outputTokens;
  if (!Number.isSafeInteger(totalTokens)) {
    throw new Error("Total token count exceeds the supported range");
  }
  return totalTokens;
}

async function applyQuotaUsageAccountingInTransaction(
  ctx: MutationCtx,
  args: {
    userId: Id<"users">;
    subscription: Doc<"subscriptions"> | null;
    totalTokens: number;
    now: number;
    quotaSnapshot?: ChatQuotaSnapshot;
    requireFullDebit?: boolean;
  },
): Promise<{
  entitlement: ReturnType<typeof getEffectiveSubscriptionEntitlement>;
  purchasedTokensDebited: number;
}> {
  if (args.quotaSnapshot) {
    const snapshot = args.quotaSnapshot;
    const entitlement = {
      plan: snapshot.entitlementPlan,
      status: "active" as const,
      includedTokens: snapshot.includedTokens,
      purchasedTokens: 0,
      serviceFeeRate: snapshot.serviceFeeRate,
      periodStart: snapshot.quotaPeriodStart,
      periodEnd: snapshot.quotaPeriodEnd,
      hasProAccess: snapshot.entitlementPlan === "pro",
    };
    if (snapshot.entitlementPlan === "pro") {
      return { entitlement, purchasedTokensDebited: 0 };
    }

    const usage = await readQuotaTokenUsage(ctx, {
      userId: args.userId,
      periodStart: snapshot.quotaPeriodStart,
      periodEndExclusive: snapshot.quotaPeriodEnd,
    });
    if (!usage.verified) {
      throw new Error("Usage history is too large to debit safely");
    }
    const purchasedTokensRequiredBefore = Math.max(
      0,
      usage.tokensUsed - snapshot.includedTokens,
    );
    if (usage.purchasedTokensDebited > purchasedTokensRequiredBefore) {
      throw new Error(
        "Purchased-token debit history cannot be verified safely",
      );
    }
    const tokensUsedAfter = usage.tokensUsed + args.totalTokens;
    if (!Number.isSafeInteger(tokensUsedAfter)) {
      throw new Error("Total token usage exceeds the supported range");
    }
    const tokensToDebit =
      Math.max(0, tokensUsedAfter - snapshot.includedTokens) -
      usage.purchasedTokensDebited;
    if (tokensToDebit <= 0) {
      return { entitlement, purchasedTokensDebited: 0 };
    }
    if (!snapshot.subscriptionId) {
      throw new Error("Reserved free usage has no canonical wallet");
    }
    const targetSubscription = await ctx.db.get(snapshot.subscriptionId);
    if (!targetSubscription || targetSubscription.userId !== args.userId) {
      throw new Error("Reserved free usage wallet identity is invalid");
    }
    const debit = await debitPurchasedTokenWallet(ctx, {
      userId: args.userId,
      targetSubscriptionId: targetSubscription._id,
      tokensToDebit,
      now: args.now,
    });
    if (args.requireFullDebit && debit.debited !== tokensToDebit) {
      throw new Error("Reserved free usage cannot be debited exactly");
    }
    return {
      entitlement: { ...entitlement, purchasedTokens: debit.remaining },
      purchasedTokensDebited: debit.debited,
    };
  }

  const entitlement = await refreshFreeSubscriptionPeriod(
    ctx,
    args.subscription,
    args.now,
  );
  if (entitlement.plan !== "free") {
    return { entitlement, purchasedTokensDebited: 0 };
  }

  const usage = await readQuotaTokenUsage(ctx, {
    userId: args.userId,
    periodStart: entitlement.periodStart,
    periodEndExclusive: entitlement.periodEnd,
  });
  if (!usage.verified) {
    throw new Error("Usage history is too large to debit safely");
  }
  const purchasedTokensRequiredBefore = Math.max(
    0,
    usage.tokensUsed - entitlement.includedTokens,
  );
  if (usage.purchasedTokensDebited > purchasedTokensRequiredBefore) {
    throw new Error("Purchased-token debit history cannot be verified safely");
  }
  const tokensUsedAfter = usage.tokensUsed + args.totalTokens;
  if (!Number.isSafeInteger(tokensUsedAfter)) {
    throw new Error("Total token usage exceeds the supported range");
  }
  const purchasedTokensRequiredAfter = Math.max(
    0,
    tokensUsedAfter - entitlement.includedTokens,
  );
  const tokensToDebit =
    purchasedTokensRequiredAfter - usage.purchasedTokensDebited;
  if (tokensToDebit <= 0 || !args.subscription) {
    return { entitlement, purchasedTokensDebited: 0 };
  }

  const debit = await debitPurchasedTokenWallet(ctx, {
    userId: args.userId,
    targetSubscriptionId: args.subscription._id,
    tokensToDebit,
    now: args.now,
  });
  return {
    entitlement: { ...entitlement, purchasedTokens: debit.remaining },
    purchasedTokensDebited: debit.debited,
  };
}

type ChatUsageWriteArgs = {
  userId: Id<"users">;
  ticketActionId?: Id<"ticketActions">;
  repositoryId?: Id<"repositories">;
  inputTokens: number;
  outputTokens: number;
  model: string;
  provider: "google" | "anthropic" | "openai";
  reservationKey?: string;
  reservationAttemptToken?: string;
  providerRequestId?: string;
  reconciliation?: {
    evidenceSource: ChatUsageReconciliationEvidenceSource;
    evidenceReference: string;
    reconciledBy: Id<"users">;
    reconciledAt: number;
    retainUntil: number;
  };
};

function isUnresolvedChatReservation(
  reservation: Doc<"chatUsageReservations">,
  now: number,
): boolean {
  return (
    reservation.settlementState !== "staged" &&
    reservation.providerStartedAt !== undefined &&
    ((reservation.status === "pending" && reservation.expiresAt <= now) ||
      reservation.status === "ambiguous")
  );
}

function isWithinChatReservationCeiling(
  reservation: Doc<"chatUsageReservations">,
  inputTokens: number,
  outputTokens: number,
  totalTokens: number,
): boolean {
  return (
    inputTokens <= reservation.inputTokenLimit &&
    outputTokens <= reservation.outputTokenLimit &&
    totalTokens <= reservation.reservedTokens
  );
}

function assertFiniteNonNegativeCosts(
  costs: ReturnType<typeof calculateChatCost>,
): void {
  for (const [label, value] of Object.entries(costs)) {
    if (
      !Number.isFinite(value) ||
      value < 0 ||
      value > Number.MAX_SAFE_INTEGER
    ) {
      throw new Error(`${label} exceeds the supported cost range`);
    }
  }
}

/**
 * Get per-1M-token pricing based on model
 */
export function getModelPricing(
  model: string,
  provider: string,
): {
  inputPer1M: number;
  outputPer1M: number;
} {
  if (provider === "anthropic" || provider === "openai") {
    const pricing = GENERATION_MODELS[provider];
    if (model !== pricing.modelId)
      throw new Error(`Unsupported ${provider} model pricing: ${model}`);
    return { inputPer1M: pricing.inputPer1M, outputPer1M: pricing.outputPer1M };
  }
  if (
    provider !== LEGACY_GOOGLE_MODELS.provider ||
    model !== LEGACY_GOOGLE_MODELS.chatModelId
  ) {
    throw new Error(
      `Unsupported chat pricing: ${provider}/${model}. Add explicit pricing before enabling it.`,
    );
  }
  return {
    inputPer1M: LEGACY_GOOGLE_MODELS.chatInputPer1M,
    outputPer1M: LEGACY_GOOGLE_MODELS.chatOutputPer1M,
  };
}

/** Calculate uncached generation costs in cents, including context tiers. */
export function calculateChatCost(
  inputTokens: number,
  outputTokens: number,
  serviceFeeRate: number,
  model: string,
  provider: string,
): {
  inputCostCents: number;
  outputCostCents: number;
  baseCostCents: number;
  serviceFeeCents: number;
  totalCostCents: number;
} {
  const pricing = getModelPricing(model, provider);
  const longContext = provider === "openai" && inputTokens > 272_000;

  // Preserve fractional cents per request. Rounding each small request to whole
  // cents makes repeated low-token calls disappear from cost accounting.
  const inputCostCents =
    (inputTokens / 1_000_000) *
    pricing.inputPer1M *
    (longContext ? 2 : 1) *
    100;
  const outputCostCents =
    (outputTokens / 1_000_000) *
    pricing.outputPer1M *
    (longContext ? 1.5 : 1) *
    100;
  const baseCostCents = inputCostCents + outputCostCents;
  const serviceFeeCents = baseCostCents * serviceFeeRate;
  const totalCostCents = baseCostCents + serviceFeeCents;

  return {
    inputCostCents,
    outputCostCents,
    baseCostCents,
    serviceFeeCents,
    totalCostCents,
  };
}

/**
 * Calculate cost in cents for embedding tokens
 * Embedding only has input tokens (no output)
 */
function calculateEmbeddingCost(
  tokens: number,
  serviceFeeRate: number,
  pricePer1M: number,
): {
  inputCostCents: number;
  outputCostCents: number;
  baseCostCents: number;
  serviceFeeCents: number;
  totalCostCents: number;
} {
  const inputCostCents = (tokens / 1_000_000) * pricePer1M * 100;
  const outputCostCents = 0; // Embeddings have no output tokens
  const baseCostCents = inputCostCents;
  const serviceFeeCents = baseCostCents * serviceFeeRate;
  const totalCostCents = baseCostCents + serviceFeeCents;

  return {
    inputCostCents,
    outputCostCents,
    baseCostCents,
    serviceFeeCents,
    totalCostCents,
  };
}

/** Record token usage for a ticket action (AI chat). */
export async function recordChatUsageInTransaction(
  ctx: MutationCtx,
  args: ChatUsageWriteArgs,
): Promise<Id<"tokenUsage">> {
  const totalTokens = getSafeTotalTokens(args.inputTokens, args.outputTokens);
  const reservationKey = args.reservationKey;
  const reservationAttemptToken = args.reservationAttemptToken;
  const reconciliation = args.reconciliation;
  if (
    (reservationKey === undefined) !==
    (reservationAttemptToken === undefined)
  ) {
    throw new Error("AI usage reservation ownership is incomplete");
  }
  if (reconciliation && !reservationKey) {
    throw new Error("Reconciled AI usage requires a reservation");
  }

  const now = Date.now();
  let reservation: Doc<"chatUsageReservations"> | null = null;
  if (reservationKey) {
    const [existingUsage, existingReservation] = await Promise.all([
      ctx.db
        .query("tokenUsage")
        .withIndex("by_chat_reservation", (q) =>
          q.eq("chatReservationKey", reservationKey),
        )
        .first(),
      ctx.db
        .query("chatUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", reservationKey),
        )
        .first(),
    ]);
    if (existingUsage) {
      if (
        !existingReservation ||
        existingReservation.usageId !== existingUsage._id ||
        existingReservation.userId !== args.userId ||
        existingReservation.ticketActionId !== args.ticketActionId ||
        existingReservation.repositoryId !== args.repositoryId ||
        existingUsage.userId !== args.userId ||
        existingUsage.ticketActionId !== args.ticketActionId ||
        existingUsage.repositoryId !== args.repositoryId ||
        existingUsage.chatReservationAttemptToken !== reservationAttemptToken ||
        existingUsage.inputTokens !== args.inputTokens ||
        existingUsage.outputTokens !== args.outputTokens ||
        existingUsage.model !== args.model ||
        existingUsage.provider !== args.provider ||
        existingUsage.providerRequestId !== args.providerRequestId ||
        existingUsage.keySource !== existingReservation.keySource
      ) {
        throw new Error("AI usage reservation identity mismatch");
      }
      return existingUsage._id;
    }

    reservation = existingReservation;
    const stagedOutcomeMatches =
      reservation?.settlementState !== "staged" ||
      (reservation.settlementOutcome?.kind === "known_billed" &&
        reservation.settlementOutcome.inputTokens === args.inputTokens &&
        reservation.settlementOutcome.outputTokens === args.outputTokens &&
        reservation.settlementOutcome.providerRequestId ===
          args.providerRequestId);
    const normalFinalization =
      reservation?.status === "pending" &&
      reservation.providerStartedAt !== undefined &&
      stagedOutcomeMatches &&
      isWithinChatReservationCeiling(
        reservation,
        args.inputTokens,
        args.outputTokens,
        totalTokens,
      );
    const reconciliationFinalization = Boolean(
      reconciliation &&
      reservation &&
      isUnresolvedChatReservation(reservation, now) &&
      isWithinChatReservationCeiling(
        reservation,
        args.inputTokens,
        args.outputTokens,
        totalTokens,
      ) &&
      reconciliation.reconciledAt <= reconciliation.retainUntil,
    );
    if (
      !reservation ||
      reservation.userId !== args.userId ||
      reservation.ticketActionId !== args.ticketActionId ||
      reservation.repositoryId !== args.repositoryId ||
      reservation.attemptToken !== reservationAttemptToken ||
      reservation.model !== args.model ||
      args.provider !== (reservation.provider ?? "google") ||
      (reconciliation ? !reconciliationFinalization : !normalFinalization)
    ) {
      throw new Error("AI usage reservation is not finalizable");
    }
    // Gitdog holds no billing evidence for calls on the user's own key.
    if (reconciliation && reservation.keySource === "user") {
      throw new Error("User-key AI usage cannot be reconciled");
    }
  }
  const userKey = reservation?.keySource === "user";

  const requestedAction = args.ticketActionId
    ? await ctx.db.get(args.ticketActionId)
    : null;
  const actionTicket = requestedAction
    ? await ctx.db.get(requestedAction.ticketId)
    : null;
  const validAction =
    requestedAction && actionTicket?.userId === args.userId
      ? requestedAction
      : null;
  const requestedRepository = args.repositoryId
    ? await ctx.db.get(args.repositoryId)
    : null;
  const validRepository =
    requestedRepository &&
    requestedRepository.userId === args.userId &&
    requestedRepository.disconnectCleanupPending !== true &&
    (!actionTicket || actionTicket.repositoryId === requestedRepository._id)
      ? requestedRepository
      : null;

  // Usage on the user's own key is recorded for reporting only and never
  // debits included or purchased tokens.
  const accounting = userKey
    ? { entitlement: { serviceFeeRate: 0 }, purchasedTokensDebited: 0 }
    : await applyQuotaUsageAccountingInTransaction(ctx, {
        userId: args.userId,
        subscription: reservation?.subscriptionId
          ? await ctx.db.get(reservation.subscriptionId)
          : await getSubscriptionForEntitlement(ctx, args.userId, now),
        totalTokens,
        now,
        ...(reservation
          ? {
              quotaSnapshot: reservation,
              requireFullDebit: true,
            }
          : {}),
      });
  const serviceFeeRate = accounting.entitlement.serviceFeeRate;
  const costs = calculateChatCost(
    args.inputTokens,
    args.outputTokens,
    serviceFeeRate,
    args.model,
    args.provider,
  );
  assertFiniteNonNegativeCosts(costs);

  const usageId = await insertTokenUsage(ctx, {
    userId: args.userId,
    ...(reservation
      ? { ticketActionId: reservation.ticketActionId }
      : validAction
        ? { ticketActionId: validAction._id }
        : {}),
    ...(reservation
      ? { repositoryId: reservation.repositoryId }
      : validRepository
        ? { repositoryId: validRepository._id }
        : {}),
    usageType: "chat",
    inputTokens: args.inputTokens,
    outputTokens: args.outputTokens,
    totalTokens,
    ...costs,
    model: args.model,
    provider: args.provider,
    serviceFeeRate,
    chatReservationKey: reservationKey,
    chatReservationAttemptToken: reservationAttemptToken,
    providerRequestId: args.providerRequestId,
    purchasedTokensDebited: accounting.purchasedTokensDebited,
    ...(userKey ? { keySource: "user" as const } : {}),
    createdAt: reservation?.providerStartedAt ?? now,
  });

  if (reservation) {
    await ctx.db.patch(reservation._id, {
      status: "finalized",
      usageId,
      providerRequestId: args.providerRequestId,
      settlementState: undefined,
      settlementOutcome: undefined,
      settlementStagedAt: undefined,
      settlementNextRecoveryAt: undefined,
      settlementScheduleId: undefined,
      ...(reconciliation
        ? {
            reconciliation: {
              outcome: "known_billed" as const,
              evidenceSource: reconciliation.evidenceSource,
              evidenceReference: reconciliation.evidenceReference,
              actualInputTokens: args.inputTokens,
              actualOutputTokens: args.outputTokens,
              reconciledBy: reconciliation.reconciledBy,
              reconciledAt: reconciliation.reconciledAt,
            },
            expiresAt: reconciliation.retainUntil,
          }
        : {}),
      updatedAt: now,
    });
  }
  return usageId;
}

export const recordUsage = internalMutation({
  args: {
    userId: v.id("users"),
    ticketActionId: v.optional(v.id("ticketActions")),
    repositoryId: v.optional(v.id("repositories")),
    inputTokens: v.number(),
    outputTokens: v.number(),
    model: v.string(),
    provider: v.union(
      v.literal("google"),
      v.literal("anthropic"),
      v.literal("openai"),
    ),
    reservationKey: v.optional(v.string()),
    reservationAttemptToken: v.optional(v.string()),
    providerRequestId: v.optional(v.string()),
  },
  handler: recordChatUsageInTransaction,
});

export type ChatUsageReconciliationArgs = {
  reservationKey: string;
  evidenceSource: ChatUsageReconciliationEvidenceSource;
  evidenceReference: string;
  reconciledBy: Id<"users">;
  outcome:
    | { kind: "known_not_billed" }
    | {
        kind: "known_billed";
        actualInputTokens: number;
        actualOutputTokens: number;
        providerRequestId?: string;
      };
};

/** Resolve one provider-started AI ambiguity from explicit evidence. */
export async function reconcileChatUsageInTransaction(
  ctx: MutationCtx,
  args: ChatUsageReconciliationArgs,
): Promise<
  { status: "released" } | { status: "finalized"; usageId: Id<"tokenUsage"> }
> {
  const evidenceReference = args.evidenceReference.trim();
  if (
    evidenceReference.length === 0 ||
    evidenceReference.length > CHAT_RECONCILIATION_EVIDENCE_REFERENCE_MAX_LENGTH
  ) {
    throw new Error("A bounded AI evidence reference is required");
  }
  const reservation = await ctx.db
    .query("chatUsageReservations")
    .withIndex("by_reservation_key", (q) =>
      q.eq("reservationKey", args.reservationKey),
    )
    .unique();
  if (!reservation) {
    throw new Error("AI usage reservation not found");
  }
  if (reservation.keySource === "user") {
    throw new Error("User-key AI usage cannot be reconciled");
  }

  const prior = reservation.reconciliation;
  const reconciledProviderRequestId =
    args.outcome.kind === "known_billed"
      ? (args.outcome.providerRequestId ?? reservation.providerRequestId)
      : undefined;
  if (prior) {
    const evidenceMatches =
      prior.evidenceSource === args.evidenceSource &&
      prior.evidenceReference === evidenceReference;
    if (
      evidenceMatches &&
      args.outcome.kind === "known_not_billed" &&
      prior.outcome === "known_not_billed" &&
      reservation.status === "released" &&
      reservation.releaseReason === "provider_reconciliation_not_billed"
    ) {
      return { status: "released" };
    }
    if (
      evidenceMatches &&
      args.outcome.kind === "known_billed" &&
      prior.outcome === "known_billed" &&
      prior.actualInputTokens === args.outcome.actualInputTokens &&
      prior.actualOutputTokens === args.outcome.actualOutputTokens &&
      reservation.providerRequestId === reconciledProviderRequestId &&
      reservation.status === "finalized" &&
      reservation.usageId
    ) {
      return { status: "finalized", usageId: reservation.usageId };
    }
    throw new Error("AI usage reservation was already reconciled");
  }
  const provider = reservation.provider ?? "google";
  if (!args.evidenceSource.startsWith(`${provider}_`)) {
    throw new Error("Reconciliation evidence must match the AI provider");
  }
  if (!isUnresolvedChatReservation(reservation, Date.now())) {
    throw new Error(
      "Only unresolved provider-started AI usage can be reconciled",
    );
  }

  const reconciledAt = Date.now();
  const retainUntil = reconciledAt + CHAT_RECONCILIATION_RETENTION_MS;
  if (args.outcome.kind === "known_not_billed") {
    await ctx.db.patch(reservation._id, {
      status: "released",
      releaseReason: "provider_reconciliation_not_billed",
      reconciliation: {
        outcome: "known_not_billed",
        evidenceSource: args.evidenceSource,
        evidenceReference,
        reconciledBy: args.reconciledBy,
        reconciledAt,
      },
      expiresAt: retainUntil,
      updatedAt: reconciledAt,
    });
    return { status: "released" };
  }

  const totalTokens = getSafeTotalTokens(
    args.outcome.actualInputTokens,
    args.outcome.actualOutputTokens,
  );
  if (totalTokens <= 0) {
    throw new Error("Known billed AI usage must be positive");
  }
  if (
    !isWithinChatReservationCeiling(
      reservation,
      args.outcome.actualInputTokens,
      args.outcome.actualOutputTokens,
      totalTokens,
    )
  ) {
    throw new Error(
      "Known billed AI usage exceeds its reservation ceiling and requires manual reconciliation",
    );
  }
  const usageId = await recordChatUsageInTransaction(ctx, {
    userId: reservation.userId,
    repositoryId: reservation.repositoryId,
    ticketActionId: reservation.ticketActionId,
    inputTokens: args.outcome.actualInputTokens,
    outputTokens: args.outcome.actualOutputTokens,
    model: reservation.model,
    provider: reservation.provider ?? "google",
    reservationKey: reservation.reservationKey,
    reservationAttemptToken: reservation.attemptToken,
    providerRequestId: reconciledProviderRequestId,
    reconciliation: {
      evidenceSource: args.evidenceSource,
      evidenceReference,
      reconciledBy: args.reconciledBy,
      reconciledAt,
      retainUntil,
    },
  });
  return { status: "finalized", usageId };
}

export type EmbeddingUsageWriteArgs = {
  userId: Id<"users">;
  repositoryId: Id<"repositories">;
  tokens: number;
  model: string;
  provider: "google" | "openai";
  billingTier: "free" | "paid";
  reservationKey?: string;
  reservationAttemptToken?: string;
  reconciliation?: {
    evidenceSource: EmbeddingUsageReconciliationEvidenceSource;
    evidenceReference: string;
    reconciledBy: Id<"users">;
    reconciledAt: number;
    retainUntil: number;
  };
};

export type EmbeddingUsageReconciliationEvidenceSource =
  | "google_api_response"
  | "google_cloud_billing_export"
  | "google_support_confirmation"
  | "openai_api_response"
  | "openai_billing_export"
  | "openai_support_confirmation";

export const EMBEDDING_RECONCILIATION_EVIDENCE_REFERENCE_MAX_LENGTH = 500;
const EMBEDDING_RECONCILIATION_RETENTION_MS = 5 * 365 * 24 * 60 * 60 * 1_000;

function isUnresolvedPaidEmbeddingReservation(
  reservation: Doc<"embeddingUsageReservations">,
  now: number,
): boolean {
  return (
    reservation.providerStartedAt !== undefined &&
    ((reservation.status === "pending" && reservation.expiresAt <= now) ||
      reservation.status === "ambiguous")
  );
}

function getEmbeddingQuotaSnapshot(
  reservation: Doc<"embeddingUsageReservations"> | null,
): ChatQuotaSnapshot | undefined {
  if (!reservation) return undefined;
  return {
    subscriptionId: reservation.subscriptionId,
    entitlementPlan: reservation.entitlementPlan,
    includedTokens: reservation.includedTokens,
    serviceFeeRate: reservation.serviceFeeRate,
    quotaPeriodStart: reservation.quotaPeriodStart,
    quotaPeriodEnd: reservation.quotaPeriodEnd,
  };
}

/** Write metering inside a caller's larger atomic publication transaction. */
export async function recordEmbeddingUsageInTransaction(
  ctx: MutationCtx,
  args: EmbeddingUsageWriteArgs,
): Promise<Id<"tokenUsage"> | undefined> {
  const usageReservationKey = args.reservationKey;
  const usageReservationAttemptToken = args.reservationAttemptToken;
  const reconciliation = args.reconciliation;
  const now = Date.now();
  let usageReservation: Doc<"embeddingUsageReservations"> | null = null;
  if (!Number.isSafeInteger(args.tokens) || args.tokens < 0) {
    throw new Error("invalid embedding token usage");
  }
  if (args.billingTier === "paid" && args.tokens === 0) {
    throw new Error("paid embedding usage must be positive");
  }
  if (reconciliation && args.billingTier !== "paid") {
    throw new Error("only paid embedding usage can be reconciled");
  }
  if (
    args.billingTier === "paid" &&
    (!usageReservationKey || !usageReservationAttemptToken)
  ) {
    throw new Error("paid embedding usage requires a quota reservation");
  }
  if (
    (usageReservationKey === undefined) !==
    (usageReservationAttemptToken === undefined)
  ) {
    throw new Error("embedding usage reservation ownership is incomplete");
  }

  // Free-route calls cost the service and user nothing. Persisting one row
  // per search would eventually crowd real quota-bearing usage out of bounded
  // monthly accounting. When a paid-fallback reservation exists, release it
  // in the same transaction as the free result publication.
  if (args.billingTier === "free") {
    if (usageReservationKey) {
      const reservation = await ctx.db
        .query("embeddingUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", usageReservationKey),
        )
        .first();
      if (
        !reservation ||
        reservation.userId !== args.userId ||
        reservation.repositoryId !== args.repositoryId ||
        (reservation.provider ?? "google") !== args.provider ||
        (reservation.model ?? LEGACY_GOOGLE_MODELS.embeddingModelId) !==
          args.model ||
        reservation.attemptToken !== usageReservationAttemptToken ||
        reservation.status === "finalized" ||
        reservation.providerStartedAt !== undefined
      ) {
        throw new Error("embedding usage reservation is not releasable");
      }
      if (
        reservation.status !== "released" ||
        reservation.releaseReason !== "request_finished_without_paid_usage"
      ) {
        await ctx.db.patch(reservation._id, {
          status: "released",
          releaseReason: "request_finished_without_paid_usage",
          updatedAt: Date.now(),
        });
      }
    }
    return undefined;
  }

  if (usageReservationKey) {
    const [existingUsage, reservation] = await Promise.all([
      ctx.db
        .query("tokenUsage")
        .withIndex("by_embedding_reservation", (q) =>
          q.eq("embeddingReservationKey", usageReservationKey),
        )
        .first(),
      ctx.db
        .query("embeddingUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", usageReservationKey),
        )
        .first(),
    ]);
    if (existingUsage) {
      if (
        (reservation !== null &&
          (reservation.userId !== args.userId ||
            reservation.repositoryId !== args.repositoryId ||
            reservation.usageId !== existingUsage._id)) ||
        existingUsage.userId !== args.userId ||
        (existingUsage.repositoryId !== undefined &&
          existingUsage.repositoryId !== args.repositoryId) ||
        existingUsage.embeddingBillingTier !== "paid" ||
        existingUsage.embeddingReservationAttemptToken !==
          usageReservationAttemptToken ||
        existingUsage.embeddingTokens !== args.tokens ||
        existingUsage.model !== args.model ||
        existingUsage.provider !== args.provider
      ) {
        throw new Error("embedding usage reservation identity mismatch");
      }
      return existingUsage._id;
    }

    usageReservation = reservation;

    const normalFinalization =
      reservation?.status === "pending" &&
      reservation.providerStartedAt !== undefined &&
      args.tokens <= reservation.providerTokenLimit;
    const reconciliationFinalization = Boolean(
      reconciliation &&
      reservation &&
      isUnresolvedPaidEmbeddingReservation(reservation, now) &&
      args.tokens <= reservation.providerTokenLimit &&
      reconciliation.reconciledAt <= reconciliation.retainUntil,
    );
    if (
      !reservation ||
      reservation.userId !== args.userId ||
      reservation.repositoryId !== args.repositoryId ||
      (reservation.provider ?? "google") !== args.provider ||
      (reservation.model ?? LEGACY_GOOGLE_MODELS.embeddingModelId) !==
        args.model ||
      reservation.attemptToken !== usageReservationAttemptToken ||
      (reconciliation ? !reconciliationFinalization : !normalFinalization)
    ) {
      throw new Error("embedding usage reservation is not finalizable");
    }
  }

  // Get user's subscription to determine platform fee rate
  const subscription = usageReservation?.subscriptionId
    ? await ctx.db.get(usageReservation.subscriptionId)
    : await getSubscriptionForEntitlement(ctx, args.userId, now);

  const pricePer1M = getEmbeddingPricePer1M(args.provider, args.model);

  // Keep quota accounting proportional to actual provider cost. Free-route
  // calls do not consume a user's paid token allowance.
  const equivalentTokens = Math.ceil(
    (args.tokens * pricePer1M) / PRICING.QUOTA_REFERENCE_COST_PER_1M,
  );

  const accounting = await applyQuotaUsageAccountingInTransaction(ctx, {
    userId: args.userId,
    subscription,
    totalTokens: equivalentTokens,
    now,
    ...(getEmbeddingQuotaSnapshot(usageReservation)
      ? {
          quotaSnapshot: getEmbeddingQuotaSnapshot(usageReservation),
          requireFullDebit: true,
        }
      : {}),
  });
  const serviceFeeRate = accounting.entitlement.serviceFeeRate;
  const costs = calculateEmbeddingCost(args.tokens, serviceFeeRate, pricePer1M);
  const requestedRepository = await ctx.db.get(args.repositoryId);
  const validRepository =
    requestedRepository?.userId === args.userId &&
    requestedRepository.disconnectCleanupPending !== true
      ? requestedRepository
      : null;

  // Insert token usage record
  const usageId = await insertTokenUsage(ctx, {
    userId: args.userId,
    ...(validRepository ? { repositoryId: validRepository._id } : {}),
    usageType: "embedding",
    inputTokens: equivalentTokens,
    outputTokens: 0,
    totalTokens: equivalentTokens,
    embeddingTokens: args.tokens,
    embeddingBillingTier: args.billingTier,
    embeddingReservationKey: usageReservationKey,
    embeddingReservationAttemptToken: usageReservationAttemptToken,
    purchasedTokensDebited: accounting.purchasedTokensDebited,
    ...costs,
    model: args.model,
    provider: args.provider,
    serviceFeeRate,
    createdAt: usageReservation?.providerStartedAt ?? now,
  });

  if (usageReservationKey) {
    const reservation = await ctx.db
      .query("embeddingUsageReservations")
      .withIndex("by_reservation_key", (q) =>
        q.eq("reservationKey", usageReservationKey),
      )
      .first();
    if (!reservation) {
      throw new Error("embedding usage reservation disappeared");
    }
    if (reservation.attemptToken !== usageReservationAttemptToken) {
      throw new Error("embedding usage reservation ownership changed");
    }
    if (equivalentTokens > reservation.reservedTokens) {
      console.error(
        `[EmbeddingBilling] Actual paid usage exceeded its reservation for repository ${args.repositoryId}`,
      );
    }
    await ctx.db.patch(reservation._id, {
      status: "finalized",
      usageId,
      ...(reconciliation
        ? {
            reconciliation: {
              outcome: "known_billed" as const,
              evidenceSource: reconciliation.evidenceSource,
              evidenceReference: reconciliation.evidenceReference,
              actualProviderTokens: args.tokens,
              reconciledBy: reconciliation.reconciledBy,
              reconciledAt: reconciliation.reconciledAt,
            },
            expiresAt: reconciliation.retainUntil,
          }
        : {}),
      updatedAt: now,
    });
  }

  return usageId;
}

export type PaidEmbeddingUsageReconciliationArgs = {
  reservationKey: string;
  evidenceSource: EmbeddingUsageReconciliationEvidenceSource;
  evidenceReference: string;
  reconciledBy: Id<"users">;
  outcome:
    | { kind: "known_not_billed" }
    | { kind: "known_billed"; actualProviderTokens: number };
};

/** Resolve one provider-started ambiguity from explicit provider evidence. */
export async function reconcilePaidEmbeddingUsageInTransaction(
  ctx: MutationCtx,
  args: PaidEmbeddingUsageReconciliationArgs,
): Promise<
  { status: "released" } | { status: "finalized"; usageId: Id<"tokenUsage"> }
> {
  const evidenceReference = args.evidenceReference.trim();
  if (
    evidenceReference.length === 0 ||
    evidenceReference.length >
      EMBEDDING_RECONCILIATION_EVIDENCE_REFERENCE_MAX_LENGTH
  ) {
    throw new Error("A bounded provider evidence reference is required");
  }

  const reservation = await ctx.db
    .query("embeddingUsageReservations")
    .withIndex("by_reservation_key", (q) =>
      q.eq("reservationKey", args.reservationKey),
    )
    .unique();
  if (!reservation) {
    throw new Error("Embedding usage reservation not found");
  }

  const evidenceProvider = args.evidenceSource.startsWith("openai_")
    ? "openai"
    : "google";
  if (evidenceProvider !== (reservation.provider ?? "google"))
    throw new Error(
      "Embedding evidence provider does not match the reservation",
    );
  const priorReconciliation = reservation.reconciliation;
  if (priorReconciliation) {
    const evidenceMatches =
      priorReconciliation.evidenceSource === args.evidenceSource &&
      priorReconciliation.evidenceReference === evidenceReference;
    if (
      evidenceMatches &&
      args.outcome.kind === "known_not_billed" &&
      priorReconciliation.outcome === "known_not_billed" &&
      reservation.status === "released" &&
      reservation.releaseReason === "provider_reconciliation_not_billed"
    ) {
      return { status: "released" };
    }
    if (
      evidenceMatches &&
      args.outcome.kind === "known_billed" &&
      priorReconciliation.outcome === "known_billed" &&
      priorReconciliation.actualProviderTokens ===
        args.outcome.actualProviderTokens &&
      reservation.status === "finalized" &&
      reservation.usageId
    ) {
      return { status: "finalized", usageId: reservation.usageId };
    }
    throw new Error("Embedding usage reservation was already reconciled");
  }

  if (!isUnresolvedPaidEmbeddingReservation(reservation, Date.now())) {
    throw new Error(
      "Only unresolved provider-started embedding usage can be reconciled",
    );
  }

  const reconciledAt = Date.now();
  const retainUntil = reconciledAt + EMBEDDING_RECONCILIATION_RETENTION_MS;
  if (args.outcome.kind === "known_not_billed") {
    await ctx.db.patch(reservation._id, {
      status: "released",
      releaseReason: "provider_reconciliation_not_billed",
      reconciliation: {
        outcome: "known_not_billed",
        evidenceSource: args.evidenceSource,
        evidenceReference,
        reconciledBy: args.reconciledBy,
        reconciledAt,
      },
      expiresAt: retainUntil,
      updatedAt: reconciledAt,
    });
    return { status: "released" };
  }

  const actualProviderTokens = args.outcome.actualProviderTokens;
  if (
    !Number.isSafeInteger(actualProviderTokens) ||
    actualProviderTokens <= 0 ||
    actualProviderTokens > reservation.providerTokenLimit
  ) {
    throw new Error(
      "Actual provider token usage must be positive and within the reserved input limit",
    );
  }

  const usageId = await recordEmbeddingUsageInTransaction(ctx, {
    userId: reservation.userId,
    repositoryId: reservation.repositoryId,
    tokens: actualProviderTokens,
    model: reservation.model ?? LEGACY_GOOGLE_MODELS.embeddingModelId,
    provider: reservation.provider ?? "google",
    billingTier: "paid",
    reservationKey: reservation.reservationKey,
    reservationAttemptToken: reservation.attemptToken,
    reconciliation: {
      evidenceSource: args.evidenceSource,
      evidenceReference,
      reconciledBy: args.reconciledBy,
      reconciledAt,
      retainUntil,
    },
  });
  if (!usageId) {
    throw new Error("Reconciled paid embedding usage was not recorded");
  }
  return { status: "finalized", usageId };
}

/** Record embedding usage for repository indexing. */
export const recordEmbeddingUsage = internalMutation({
  args: {
    userId: v.id("users"),
    repositoryId: v.id("repositories"),
    tokens: v.number(),
    model: v.string(),
    provider: v.union(v.literal("google"), v.literal("openai")),
    billingTier: v.union(v.literal("free"), v.literal("paid")),
    reservationKey: v.optional(v.string()),
    reservationAttemptToken: v.optional(v.string()),
  },
  handler: recordEmbeddingUsageInTransaction,
});

const USAGE_TOTALS_BACKFILL_ROW_BUDGET = 2_000;
const USAGE_TOTALS_BACKFILL_USER_BATCH = 100;

/**
 * Build hourly totals for a user's existing usage rows, then switch the
 * user's quota checks to them. Safe to rerun and to run during live writes.
 */
export const backfillUsageTotals = internalMutation({
  args: {
    userId: v.id("users"),
    cursor: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (await hasUsageTotals(ctx, args.userId)) {
      return { done: true as const };
    }
    let cursor = args.cursor;
    let rowBudget = USAGE_TOTALS_BACKFILL_ROW_BUDGET;
    while (rowBudget > 0) {
      const after = cursor;
      const next = await ctx.db
        .query("tokenUsage")
        .withIndex("by_user_key_source_and_created_at", (q) => {
          const range = q.eq("userId", args.userId).eq("keySource", undefined);
          return after === undefined ? range : range.gte("createdAt", after);
        })
        .first();
      if (!next) {
        await ctx.db.insert("tokenUsageTotalsStates", {
          userId: args.userId,
          readyAt: Date.now(),
        });
        return { done: true as const };
      }
      const hourStart = getUsageHourStart(next.createdAt);
      rowBudget -= await rebuildUsageTotalsHour(ctx, args.userId, hourStart);
      cursor = hourStart + USAGE_TOTALS_HOUR_MS;
    }
    await ctx.scheduler.runAfter(
      0,
      internal.tokenUsage.internalMutation.backfillUsageTotals,
      { userId: args.userId, cursor },
    );
    return { done: false as const, cursor };
  },
});

/** Schedule backfillUsageTotals for every user, one page at a time. */
export const backfillAllUsageTotals = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("users").paginate({
      cursor: args.cursor ?? null,
      numItems: USAGE_TOTALS_BACKFILL_USER_BATCH,
    });
    for (const user of page.page) {
      await ctx.scheduler.runAfter(
        0,
        internal.tokenUsage.internalMutation.backfillUsageTotals,
        { userId: user._id },
      );
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.tokenUsage.internalMutation.backfillAllUsageTotals,
        { cursor: page.continueCursor },
      );
    }
    return { scheduled: page.page.length, done: page.isDone };
  },
});
