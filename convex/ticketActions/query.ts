import { query } from "../_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { paginatedCollect } from "../_utils/pagination";
import type { Doc } from "../_generated/dataModel";

export function toPublicTicketAction(action: Doc<"ticketActions">) {
  const {
    resultCheckpointKey,
    resultCheckpointExpiresAt,
    resultRecoveryLeaseUntil,
    resultRecoveryScheduleId,
    pendingGenerationTarget,
    pendingGenerationExpiresAt,
    pendingGenerationScheduleId,
    pendingGenerationLeaseUntil,
    providerRetryStartedAt,
    autoExecutionRecoveryExpiresAt,
    autoExecutionRecoveryLeaseUntil,
    autoExecutionRecoveryScheduleId,
    executionIdempotencyKey,
    executionRecoveryMode,
    executionRecoveryReconcileOnly,
    executionRecoveryReconcileDeadlineAt,
    executionRecoveryExpiresAt,
    executionRecoveryLeaseUntil,
    executionRecoveryScheduleId,
    ...publicAction
  } = action;
  void resultCheckpointKey;
  void resultCheckpointExpiresAt;
  void resultRecoveryLeaseUntil;
  void resultRecoveryScheduleId;
  void pendingGenerationTarget;
  void pendingGenerationExpiresAt;
  void pendingGenerationScheduleId;
  void pendingGenerationLeaseUntil;
  void providerRetryStartedAt;
  void autoExecutionRecoveryExpiresAt;
  void autoExecutionRecoveryLeaseUntil;
  void autoExecutionRecoveryScheduleId;
  void executionIdempotencyKey;
  void executionRecoveryMode;
  void executionRecoveryReconcileOnly;
  void executionRecoveryReconcileDeadlineAt;
  void executionRecoveryExpiresAt;
  void executionRecoveryLeaseUntil;
  void executionRecoveryScheduleId;
  return publicAction;
}

/**
 * List all actions for a ticket
 */
export const listByTicket = query({
  args: {
    ticketId: v.id("tickets"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return [];
    }

    // Verify ticket ownership
    const ticket = await ctx.db.get(args.ticketId);
    if (!ticket || ticket.userId !== userId) {
      return [];
    }

    const actions = await paginatedCollect(
      ctx.db
        .query("ticketActions")
        .withIndex("by_ticket", (q) => q.eq("ticketId", args.ticketId))
        .order("asc"),
    );

    return actions.map(toPublicTicketAction);
  },
});

/**
 * Get a single action by ID
 */
export const getById = query({
  args: {
    id: v.id("ticketActions"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return null;
    }

    const action = await ctx.db.get(args.id);
    if (!action) {
      return null;
    }

    // Verify ticket ownership
    const ticket = await ctx.db.get(action.ticketId);
    if (!ticket || ticket.userId !== userId) {
      return null;
    }

    return toPublicTicketAction(action);
  },
});
