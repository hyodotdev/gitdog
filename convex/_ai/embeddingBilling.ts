/**
 * Settlement for embedding reservations created before Gitdog retired
 * embeddings. Nothing writes new reservations; these crons finish staged
 * outcomes and clean up old rows so historical usage stays exact.
 */
import { internal } from "../_generated/api";
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
} from "./legacyEmbeddings";
import { recordEmbeddingUsageInTransaction } from "../tokenUsage/internalMutation";
import { EmbeddingProviderError } from "./embeddings";

const USAGE_RESERVATION_RETENTION_MS = 24 * 60 * 60 * 1_000;
const USAGE_RESERVATION_CLEANUP_LIMIT = 100;
const EMBEDDING_SETTLEMENT_RECOVERY_INTERVAL_MS = 5 * 60 * 1_000;
const EMBEDDING_SETTLEMENT_RECOVERY_LIMIT = 100;

export type EmbeddingUsageOperation =
  | "RAG index"
  | "RAG search"
  | "repository learning create"
  | "repository learning search";

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
    // Nothing can finish an unstaged embedding call anymore, so it is
    // released rather than left ambiguous. Staged outcomes settle through
    // recoverStagedEmbeddingOutcomes.
    for (const reservation of expiredPending) {
      await ctx.db.patch(reservation._id, {
        status: "released",
        releaseReason: "embeddings_retired",
        updatedAt: now,
      });
    }
    const ambiguous = await ctx.db
      .query("embeddingUsageReservations")
      .withIndex("by_status_and_expiration", (q) => q.eq("status", "ambiguous"))
      .take(USAGE_RESERVATION_CLEANUP_LIMIT);
    for (const reservation of ambiguous) {
      if (reservation.settlementState === "staged") continue;
      await ctx.db.patch(reservation._id, {
        status: "released",
        releaseReason: "embeddings_retired",
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
      ambiguous.length === USAGE_RESERVATION_CLEANUP_LIMIT ||
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
