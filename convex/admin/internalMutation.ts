import { internalMutation } from "../_generated/server";
import { v } from "convex/values";

export const createAiLog = internalMutation({
  args: {
    ticketId: v.optional(v.id("tickets")),
    ticketActionId: v.optional(v.id("ticketActions")),
    repositoryId: v.optional(v.id("repositories")),
    userId: v.optional(v.id("users")),
    workflowType: v.string(),
    actionType: v.optional(v.string()),
    systemPrompt: v.optional(v.string()),
    userPrompt: v.optional(v.string()),
    aiResponse: v.optional(v.string()),
    githubRepo: v.optional(v.string()),
    githubNumber: v.optional(v.number()),
    ticketTitle: v.optional(v.string()),
    ticketBody: v.optional(v.string()),
    status: v.union(
      v.literal("success"),
      v.literal("failed"),
      v.literal("pending_approval"),
      v.literal("approved"),
      v.literal("rejected"),
      v.literal("request_changes"),
    ),
    errorMessage: v.optional(v.string()),
    userFeedback: v.optional(v.string()),
    requestChangesCount: v.optional(v.number()),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    totalCostCents: v.optional(v.number()),
    model: v.optional(v.string()),
    durationMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const requestedTicket = args.ticketId
      ? await ctx.db.get(args.ticketId)
      : null;
    const validRequestedTicket =
      requestedTicket &&
      (args.userId === undefined || requestedTicket.userId === args.userId)
        ? requestedTicket
        : null;

    const requestedAction = args.ticketActionId
      ? await ctx.db.get(args.ticketActionId)
      : null;
    const actionTicket = requestedAction
      ? validRequestedTicket?._id === requestedAction.ticketId
        ? validRequestedTicket
        : args.ticketId === undefined
          ? await ctx.db.get(requestedAction.ticketId)
          : null
      : null;
    const validAction =
      requestedAction &&
      actionTicket &&
      (args.userId === undefined || actionTicket.userId === args.userId)
        ? requestedAction
        : null;
    const contextTicket =
      validRequestedTicket ?? (validAction ? actionTicket : null);

    const requestedRepository = args.repositoryId
      ? await ctx.db.get(args.repositoryId)
      : null;
    const validRepository =
      requestedRepository &&
      requestedRepository.disconnectCleanupPending !== true &&
      (args.userId === undefined ||
        requestedRepository.userId === args.userId) &&
      (!contextTicket || contextTicket.repositoryId === requestedRepository._id)
        ? requestedRepository
        : null;

    const {
      ticketId: _ticketId,
      ticketActionId: _ticketActionId,
      repositoryId: _repositoryId,
      ...history
    } = args;
    const logId = await ctx.db.insert("aiLogs", {
      ...history,
      ...(validRequestedTicket ? { ticketId: validRequestedTicket._id } : {}),
      ...(validAction ? { ticketActionId: validAction._id } : {}),
      ...(validRepository ? { repositoryId: validRepository._id } : {}),
      createdAt: Date.now(),
    });

    return logId;
  },
});

export const updateAiLogStatus = internalMutation({
  args: {
    logId: v.id("aiLogs"),
    status: v.union(
      v.literal("success"),
      v.literal("failed"),
      v.literal("pending_approval"),
      v.literal("approved"),
      v.literal("rejected"),
      v.literal("request_changes"),
    ),
    errorMessage: v.optional(v.string()),
    userFeedback: v.optional(v.string()),
    aiResponse: v.optional(v.string()),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    totalCostCents: v.optional(v.number()),
    durationMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { logId, ...updates } = args;

    const log = await ctx.db.get(logId);
    if (!log) {
      return;
    }

    const patchData: Record<string, unknown> = {};

    if (updates.status !== undefined) patchData.status = updates.status;
    if (updates.errorMessage !== undefined)
      patchData.errorMessage = updates.errorMessage;
    if (updates.userFeedback !== undefined)
      patchData.userFeedback = updates.userFeedback;
    if (updates.aiResponse !== undefined)
      patchData.aiResponse = updates.aiResponse;
    if (updates.inputTokens !== undefined)
      patchData.inputTokens = updates.inputTokens;
    if (updates.outputTokens !== undefined)
      patchData.outputTokens = updates.outputTokens;
    if (updates.totalCostCents !== undefined)
      patchData.totalCostCents = updates.totalCostCents;
    if (updates.durationMs !== undefined)
      patchData.durationMs = updates.durationMs;

    if (updates.status === "request_changes") {
      patchData.requestChangesCount = (log.requestChangesCount ?? 0) + 1;
    }

    await ctx.db.patch(logId, patchData);
  },
});
