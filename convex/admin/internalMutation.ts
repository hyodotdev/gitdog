import { internalMutation } from "../_generated/server";
import { v } from "convex/values";
import { PRICING } from "../_ai/config";
import {
  getEffectiveSubscriptionEntitlement,
  getSubscriptionForEntitlement,
} from "../subscriptions/entitlement";
import { refreshFreeSubscriptionPeriod } from "../subscriptions/quotaEntitlement";
import {
  consolidatePurchasedTokenWallet,
  readPurchasedTokenWalletBalance,
} from "../subscriptions/wallet";

const OWNER_TEST_CREDIT_OPERATION_ID = "a1fd0343-3e2c-462b-8a22-fd00697d3e0f";
const OWNER_TEST_CREDIT_TOKENS = Math.floor(
  (20_000_000 * PRICING.TOKEN_PACK_LARGE_SIZE) /
    Math.round(PRICING.TOKEN_PACK_LARGE_PRICE * 100),
);

/** One-time operator-approved, non-cash owner credit; never a provider top-up. */
export const provisionOwnerTestCredit = internalMutation({
  args: { expectedUserId: v.id("users") },
  returns: v.object({
    applied: v.boolean(),
    tokensGranted: v.number(),
    balance: v.number(),
    isAdmin: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const profiles = await ctx.db
      .query("userProfiles")
      .withIndex("by_github", (q) => q.eq("githubUsername", "hyochan"))
      .take(2);
    const profile = profiles[0];
    if (
      profiles.length !== 1 ||
      profile.userId !== args.expectedUserId ||
      !(await ctx.db.get(args.expectedUserId))
    ) {
      throw new Error("Owner identity does not match the approved account");
    }
    const existing = await ctx.db
      .query("paymentLogs")
      .withIndex("by_admin_operation", (q) =>
        q.eq("adminOperationId", OWNER_TEST_CREDIT_OPERATION_ID),
      )
      .unique();
    if (existing) {
      if (
        existing.userId !== args.expectedUserId ||
        existing.eventType !== "admin_credit" ||
        existing.status !== "success" ||
        existing.tokensAdded !== OWNER_TEST_CREDIT_TOKENS
      ) {
        throw new Error(
          "Owner test credit operation conflicts with its audit record",
        );
      }
      return {
        applied: false,
        tokensGranted: OWNER_TEST_CREDIT_TOKENS,
        balance: await readPurchasedTokenWalletBalance(
          ctx,
          args.expectedUserId,
        ),
        isAdmin: profile.isAdmin === true,
      };
    }
    const now = Date.now();
    const subscription = await getSubscriptionForEntitlement(
      ctx,
      args.expectedUserId,
      now,
    );
    if (subscription && subscription.plan !== "free") {
      throw new Error(
        "Review the existing owner subscription before granting test credit",
      );
    }
    let subscriptionId = subscription?._id;
    if (subscription)
      await refreshFreeSubscriptionPeriod(ctx, subscription, now);
    if (!subscriptionId) {
      const defaults = getEffectiveSubscriptionEntitlement(null, now);
      subscriptionId = await ctx.db.insert("subscriptions", {
        userId: args.expectedUserId,
        plan: "free",
        status: "active",
        includedTokens: defaults.includedTokens,
        purchasedTokens: 0,
        serviceFeeRate: defaults.serviceFeeRate,
        periodStart: defaults.periodStart,
        periodEnd: defaults.periodEnd,
        createdAt: now,
        updatedAt: now,
      });
    }
    const balance = await consolidatePurchasedTokenWallet(ctx, {
      userId: args.expectedUserId,
      targetSubscriptionId: subscriptionId,
      tokensToAdd: OWNER_TEST_CREDIT_TOKENS,
      now,
    });
    await ctx.db.patch(profile._id, { isAdmin: true, updatedAt: now });
    await ctx.db.insert("paymentLogs", {
      userId: args.expectedUserId,
      adminOperationId: OWNER_TEST_CREDIT_OPERATION_ID,
      eventType: "admin_credit",
      productType: "token_pack",
      tokensAdded: OWNER_TEST_CREDIT_TOKENS,
      status: "success",
      createdAt: now,
      adminNote:
        "2026-11-03 operator-approved owner test credit and admin restoration. Non-cash, one-time USD 200000 nominal value at the large token-pack list rate; no payment, provider recharge, or usage-history reset.",
    });
    return {
      applied: true,
      tokensGranted: OWNER_TEST_CREDIT_TOKENS,
      balance,
      isAdmin: true,
    };
  },
});

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
