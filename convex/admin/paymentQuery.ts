import { query } from "../_generated/server";
import { v } from "convex/values";
import type { Id, Doc } from "../_generated/dataModel";
import { checkAdmin } from "./utils";

const EXACT_USAGE_AGGREGATION_LIMIT = 1000;

type PaymentLogForClient = Pick<
  Doc<"paymentLogs">,
  | "_id"
  | "_creationTime"
  | "userId"
  | "lemonSqueezyEventId"
  | "lemonSqueezyOrderId"
  | "lemonSqueezySubscriptionId"
  | "lemonSqueezyCustomerId"
  | "lemonSqueezyVariantId"
  | "eventType"
  | "productType"
  | "amountCents"
  | "currency"
  | "tokensAdded"
  | "status"
  | "errorMessage"
  | "adminNote"
  | "refundedAt"
  | "refundedBy"
  | "createdAt"
> & {
  userName?: string;
  userAvatar?: string;
};

/** List bounded open payment reviews without exposing settlement fingerprints. */
export const listOpenSettlementReviews = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return { reviews: [] };
    const limit = args.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Review limit must be between 1 and 100");
    }
    const reviews = await ctx.db
      .query("paymentSettlementManualReviews")
      .withIndex("by_status_and_expiration", (q) => q.eq("status", "open"))
      .order("desc")
      .take(limit);
    return {
      reviews: reviews.map((review) => ({
        _id: review._id,
        reviewType: review.reviewType,
        providerResourceId: review.providerResourceId,
        userId: review.userId,
        lemonSqueezySubscriptionId: review.lemonSqueezySubscriptionId,
        amountCents: review.amountCents,
        refundedAmountCents: review.refundedAmountCents,
        currency: review.currency,
        reason: review.reason,
        status: review.status,
        expiresAt: review.expiresAt,
        createdAt: review.createdAt,
        updatedAt: review.updatedAt,
      })),
    };
  },
});

function selectPaymentLogForClient(
  log: Doc<"paymentLogs">,
  userProfile?: Doc<"userProfiles"> | null,
): PaymentLogForClient {
  return {
    _id: log._id,
    _creationTime: log._creationTime,
    userId: log.userId,
    lemonSqueezyEventId: log.lemonSqueezyEventId,
    lemonSqueezyOrderId: log.lemonSqueezyOrderId,
    lemonSqueezySubscriptionId: log.lemonSqueezySubscriptionId,
    lemonSqueezyCustomerId: log.lemonSqueezyCustomerId,
    lemonSqueezyVariantId: log.lemonSqueezyVariantId,
    eventType: log.eventType,
    productType: log.productType,
    amountCents: log.amountCents,
    currency: log.currency,
    tokensAdded: log.tokensAdded,
    status: log.status,
    errorMessage: log.errorMessage,
    adminNote: log.adminNote,
    refundedAt: log.refundedAt,
    refundedBy: log.refundedBy,
    createdAt: log.createdAt,
    userName: userProfile?.displayName || userProfile?.githubUsername,
    userAvatar: userProfile?.avatarUrl,
  };
}

/**
 * Get payment logs with pagination
 */
export const listPaymentLogs = query({
  args: {
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
    statusFilter: v.optional(
      v.union(
        v.literal("success"),
        v.literal("failed"),
        v.literal("pending"),
        v.literal("refunded"),
        v.literal("canceled"),
      ),
    ),
    eventTypeFilter: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) {
      return { logs: [], hasMore: false };
    }

    const limit = args.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Payment log limit must be between 1 and 100");
    }

    const logsQuery = args.statusFilter
      ? args.eventTypeFilter
        ? ctx.db
            .query("paymentLogs")
            .withIndex("by_status_event_type_and_created", (q) =>
              q
                .eq("status", args.statusFilter!)
                .eq("eventType", args.eventTypeFilter!),
            )
            .order("desc")
        : ctx.db
            .query("paymentLogs")
            .withIndex("by_status_and_created", (q) =>
              q.eq("status", args.statusFilter!),
            )
            .order("desc")
      : args.eventTypeFilter
        ? ctx.db
            .query("paymentLogs")
            .withIndex("by_event_type_and_created", (q) =>
              q.eq("eventType", args.eventTypeFilter!),
            )
            .order("desc")
        : ctx.db.query("paymentLogs").withIndex("by_created").order("desc");

    const pagination = await logsQuery.paginate({
      numItems: limit,
      cursor: args.cursor ?? null,
    });
    const paginatedLogs = pagination.page;

    // Batch fetch user profiles to avoid N+1 queries
    const userIds = [
      ...new Set(paginatedLogs.map((log) => log.userId).filter(Boolean)),
    ] as Id<"users">[];

    const userProfiles = await Promise.all(
      userIds.map((userId) =>
        ctx.db
          .query("userProfiles")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .first(),
      ),
    );

    const userProfileMap = new Map<string, Doc<"userProfiles">>();
    userProfiles.forEach((profile, index) => {
      if (profile) {
        userProfileMap.set(userIds[index], profile);
      }
    });

    // Enrich logs with user info using the cached map
    const enrichedLogs = paginatedLogs.map((log) => {
      const userProfile = log.userId ? userProfileMap.get(log.userId) : null;
      return selectPaymentLogForClient(log, userProfile);
    });

    return {
      logs: enrichedLogs,
      hasMore: !pagination.isDone,
      nextCursor: pagination.isDone ? undefined : pagination.continueCursor,
    };
  },
});

/**
 * Get payment stats for admin dashboard (with optional month filter)
 * Monthly stats: calculated from logs within date range (bounded query)
 * All-time stats: retrieved from summary table (O(1) lookup)
 */
export const getPaymentStats = query({
  args: {
    year: v.optional(v.number()),
    month: v.optional(v.number()), // 0-11 (January = 0)
  },
  handler: async (ctx, args) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) {
      return null;
    }

    // Calculate date range for filtering
    const now = new Date();
    const filterYear = args.year ?? now.getFullYear();
    const filterMonth = args.month ?? now.getMonth();

    const startOfFilterMonth = new Date(filterYear, filterMonth, 1).getTime();
    const endOfFilterMonth = new Date(filterYear, filterMonth + 1, 1).getTime();

    // Get monthly logs (bounded by date range - safe to query)
    const monthlyLogs = await ctx.db
      .query("paymentLogs")
      .withIndex("by_created", (q) =>
        q
          .gte("createdAt", startOfFilterMonth)
          .lt("createdAt", endOfFilterMonth),
      )
      .order("desc")
      .take(10001);
    if (monthlyLogs.length > 10000) {
      throw new Error(
        "Monthly payment statistics exceed the exact aggregation limit",
      );
    }

    // Get all-time stats from summary table (O(1) lookup)
    const summary = await ctx.db
      .query("paymentStatsSummary")
      .withIndex("by_key", (q) => q.eq("key", "global"))
      .first();

    const stats = {
      total: monthlyLogs.length,
      success: 0,
      failed: 0,
      pending: 0,
      refunded: 0,
      canceled: 0,
      totalRevenueCents: 0,
      monthlyRevenueCents: 0,
      totalTokensSold: 0,
      monthlyTokensSold: 0,
      byEventType: {} as Record<string, number>,
      byProductType: {} as Record<string, number>,
      // All-time totals from summary table
      allTimeRevenueCents: summary?.totalRevenueCents ?? 0,
      allTimeTokensSold: summary?.totalTokensSold ?? 0,
      allTimeTotal: summary?.totalOrders ?? 0,
      // Additional breakdown from summary
      allTimeRefundedCents: summary?.totalRefundedCents ?? 0,
      proSubscriptionCount: summary?.proSubscriptionCount ?? 0,
      tokenPackSmallCount: summary?.tokenPackSmallCount ?? 0,
      tokenPackLargeCount: summary?.tokenPackLargeCount ?? 0,
    };

    // Calculate monthly stats from filtered logs
    for (const log of monthlyLogs) {
      // Count by status
      if (log.status === "success") stats.success++;
      else if (log.status === "failed") stats.failed++;
      else if (log.status === "pending") stats.pending++;
      else if (log.status === "refunded") stats.refunded++;
      else if (log.status === "canceled") stats.canceled++;

      // Revenue (only from success)
      if (log.status === "success" && log.amountCents) {
        stats.totalRevenueCents += log.amountCents;
        stats.monthlyRevenueCents += log.amountCents;
      }

      // Tokens sold
      if (log.status === "success" && log.tokensAdded) {
        stats.totalTokensSold += log.tokensAdded;
        stats.monthlyTokensSold += log.tokensAdded;
      }

      // By event type
      stats.byEventType[log.eventType] =
        (stats.byEventType[log.eventType] || 0) + 1;

      // By product type
      if (log.productType) {
        stats.byProductType[log.productType] =
          (stats.byProductType[log.productType] || 0) + 1;
      }
    }

    return stats;
  },
});

/**
 * Get all subscriptions with user info for admin
 */
export const listSubscriptions = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) {
      return { subscriptions: [] };
    }

    const limit = args.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Subscription limit must be between 1 and 100");
    }
    const subscriptions = await ctx.db
      .query("subscriptions")
      .order("desc")
      .take(limit);

    // Batch fetch user profiles
    const userIds = [...new Set(subscriptions.map((sub) => sub.userId))];
    const userProfiles = await Promise.all(
      userIds.map((userId) =>
        ctx.db
          .query("userProfiles")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .first(),
      ),
    );

    const userProfileMap = new Map<string, Doc<"userProfiles">>();
    userProfiles.forEach((profile, index) => {
      if (profile) {
        userProfileMap.set(userIds[index], profile);
      }
    });

    // Enrich with user info and calculate token usage
    const enrichedSubscriptions = await Promise.all(
      subscriptions.map(async (sub) => {
        const userProfile = userProfileMap.get(sub.userId);

        // Get token usage for this user
        const usageRecords = await ctx.db
          .query("tokenUsage")
          .withIndex("by_user_and_month", (q) =>
            q
              .eq("userId", sub.userId)
              .gte("createdAt", sub.periodStart)
              .lt("createdAt", sub.periodEnd),
          )
          .take(EXACT_USAGE_AGGREGATION_LIMIT + 1);
        // One busy user must not take down the page: this is also the only UI
        // for granting and refunding tokens, so report a floor and say it is a
        // floor rather than failing the whole query.
        const tokensUsedIsPartial =
          usageRecords.length > EXACT_USAGE_AGGREGATION_LIMIT;
        const tokensUsed = usageRecords
          .slice(0, EXACT_USAGE_AGGREGATION_LIMIT)
          .reduce((sum, record) => sum + record.totalTokens, 0);

        return {
          ...sub,
          userName: userProfile?.displayName || userProfile?.githubUsername,
          userAvatar: userProfile?.avatarUrl,
          githubUsername: userProfile?.githubUsername,
          tokensUsed,
          tokensUsedIsPartial,
        };
      }),
    );

    return { subscriptions: enrichedSubscriptions };
  },
});

/**
 * Get payment logs grouped by user (for admin payments page, with optional month filter)
 */
export const listPaymentLogsByUser = query({
  args: {
    year: v.optional(v.number()),
    month: v.optional(v.number()), // 0-11 (January = 0)
  },
  handler: async (ctx, args) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) {
      return { users: [] };
    }

    // Calculate date range for filtering
    const now = new Date();
    const filterYear = args.year ?? now.getFullYear();
    const filterMonth = args.month ?? now.getMonth();

    const startOfFilterMonth = new Date(filterYear, filterMonth, 1).getTime();
    const endOfFilterMonth = new Date(filterYear, filterMonth + 1, 1).getTime();

    // Use index-based filtering instead of collecting all logs
    const filteredLogs = await ctx.db
      .query("paymentLogs")
      .withIndex("by_created", (q) =>
        q
          .gte("createdAt", startOfFilterMonth)
          .lt("createdAt", endOfFilterMonth),
      )
      .order("desc")
      .take(10001);
    if (filteredLogs.length > 10000) {
      throw new Error(
        "Monthly payment history exceeds the exact aggregation limit",
      );
    }

    // Group logs by userId
    const userLogsMap = new Map<string, typeof filteredLogs>();
    for (const log of filteredLogs) {
      const key = log.userId ?? "unknown";
      if (!userLogsMap.has(key)) {
        userLogsMap.set(key, []);
      }
      userLogsMap.get(key)!.push(log);
    }

    // Batch fetch user profiles to avoid N+1 queries
    const userIdStrings = Array.from(userLogsMap.keys()).filter(
      (id) => id !== "unknown",
    );
    const userIds = userIdStrings as Id<"users">[];

    const userProfiles = await Promise.all(
      userIds.map((userId) =>
        ctx.db
          .query("userProfiles")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .first(),
      ),
    );

    const userProfileMap = new Map<string, Doc<"userProfiles">>();
    userProfiles.forEach((profile, index) => {
      if (profile) {
        userProfileMap.set(userIds[index], profile);
      }
    });

    // Enrich with user info and calculate stats
    const users = Array.from(userLogsMap.entries()).map(([userId, logs]) => {
      const userProfile =
        userId !== "unknown" ? userProfileMap.get(userId) : null;

      // Calculate user stats
      const totalRevenueCents = logs.reduce((sum, log) => {
        return log.status === "success" && log.amountCents
          ? sum + log.amountCents
          : sum;
      }, 0);

      const totalTokens = logs.reduce((sum, log) => {
        return log.status === "success" && log.tokensAdded
          ? sum + log.tokensAdded
          : sum;
      }, 0);

      const successCount = logs.filter((l) => l.status === "success").length;
      const failedCount = logs.filter((l) => l.status === "failed").length;

      return {
        userId,
        userName:
          userProfile?.displayName ||
          userProfile?.githubUsername ||
          "Unknown User",
        userAvatar: userProfile?.avatarUrl,
        githubUsername: userProfile?.githubUsername,
        totalRevenueCents,
        totalTokens,
        successCount,
        failedCount,
        totalLogs: logs.length,
        logs: logs.slice(0, 10).map((log) => selectPaymentLogForClient(log)),
        hasMoreLogs: logs.length > 10,
      };
    });

    // Sort by total revenue descending
    users.sort((a, b) => b.totalRevenueCents - a.totalRevenueCents);

    return { users };
  },
});
