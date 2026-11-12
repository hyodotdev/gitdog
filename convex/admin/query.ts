import { query, type QueryCtx } from "../_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";

// Helper to check if current user is admin
async function requireAdmin(ctx: QueryCtx, userId: Id<"users">) {
  const profile = await ctx.db
    .query("userProfiles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();

  if (!profile?.isAdmin) {
    throw new Error("unauthorized");
  }
}

export const isAdmin = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return false;
    }

    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();

    return profile?.isAdmin === true;
  },
});

export const listAiLogs = query({
  args: {
    status: v.optional(
      v.union(
        v.literal("success"),
        v.literal("failed"),
        v.literal("pending_approval"),
        v.literal("approved"),
        v.literal("rejected"),
        v.literal("request_changes"),
      ),
    ),
    workflowType: v.optional(v.string()),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("not authenticated");
    }

    await requireAdmin(ctx, userId);

    const limit = args.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("AI log limit must be between 1 and 100");
    }

    const logsQuery = args.status
      ? args.workflowType
        ? ctx.db
            .query("aiLogs")
            .withIndex("by_status_workflow_type_and_created", (q) =>
              q
                .eq("status", args.status!)
                .eq("workflowType", args.workflowType!),
            )
            .order("desc")
        : ctx.db
            .query("aiLogs")
            .withIndex("by_status_and_created", (q) =>
              q.eq("status", args.status!),
            )
            .order("desc")
      : args.workflowType
        ? ctx.db
            .query("aiLogs")
            .withIndex("by_workflow_type_and_created", (q) =>
              q.eq("workflowType", args.workflowType!),
            )
            .order("desc")
        : ctx.db.query("aiLogs").withIndex("by_created").order("desc");
    const pagination = await logsQuery.paginate({
      numItems: limit,
      cursor: args.cursor ?? null,
    });

    return {
      items: pagination.page,
      hasMore: !pagination.isDone,
      nextCursor: pagination.isDone ? undefined : pagination.continueCursor,
    };
  },
});

export const getAiLogById = query({
  args: {
    logId: v.id("aiLogs"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("not authenticated");
    }

    await requireAdmin(ctx, userId);

    const log = await ctx.db.get(args.logId);
    if (!log) {
      throw new Error("log not found");
    }

    // Fetch related data
    let ticket = null;
    let ticketAction = null;
    let repository = null;
    let user = null;

    if (log.ticketId) {
      ticket = await ctx.db.get(log.ticketId);
    }
    if (log.ticketActionId) {
      ticketAction = await ctx.db.get(log.ticketActionId);
    }
    if (log.repositoryId) {
      repository = await ctx.db.get(log.repositoryId);
    }
    if (log.userId) {
      user = await ctx.db.get(log.userId);
    }

    return {
      ...log,
      ticket,
      ticketAction,
      repository,
      user,
    };
  },
});

export const listAiLogsByTicket = query({
  args: {
    limit: v.optional(v.number()),
    cursor: v.optional(v.number()), // createdAt timestamp for cursor-based pagination
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("not authenticated");
    }

    await requireAdmin(ctx, userId);

    const limit = args.limit ?? 50;

    // Get logs with cursor-based pagination
    const logsQuery = ctx.db.query("aiLogs").withIndex("by_created");

    let logs;
    if (args.cursor) {
      logs = await logsQuery
        .filter((q) => q.lt(q.field("createdAt"), args.cursor!))
        .order("desc")
        .take(limit + 1);
    } else {
      logs = await logsQuery.order("desc").take(limit + 1);
    }

    const hasMore = logs.length > limit;
    const items = logs.slice(0, limit);
    const nextCursor = hasMore ? items[items.length - 1]?.createdAt : undefined;

    // Group by ticket
    const ticketMap = new Map<
      string,
      {
        ticketId: Id<"tickets"> | null;
        githubRepo: string;
        githubNumber: number;
        ticketTitle: string;
        logs: typeof items;
        totalLogs: number;
        successCount: number;
        failedCount: number;
        pendingCount: number;
        latestCreatedAt: number;
      }
    >();

    for (const log of items) {
      const key = log.ticketId
        ? log.ticketId
        : `${log.githubRepo}-${log.githubNumber}`;

      if (!ticketMap.has(key)) {
        ticketMap.set(key, {
          ticketId: log.ticketId ?? null,
          githubRepo: log.githubRepo || "",
          githubNumber: log.githubNumber || 0,
          ticketTitle: log.ticketTitle || "",
          logs: [],
          totalLogs: 0,
          successCount: 0,
          failedCount: 0,
          pendingCount: 0,
          latestCreatedAt: log.createdAt,
        });
      }

      const ticket = ticketMap.get(key)!;
      ticket.logs.push(log);
      ticket.totalLogs++;

      if (log.status === "success" || log.status === "approved") {
        ticket.successCount++;
      } else if (log.status === "failed" || log.status === "rejected") {
        ticket.failedCount++;
      } else {
        ticket.pendingCount++;
      }

      if (log.createdAt > ticket.latestCreatedAt) {
        ticket.latestCreatedAt = log.createdAt;
      }
    }

    // Convert to array and sort by latest activity
    const tickets = Array.from(ticketMap.values()).sort(
      (a, b) => b.latestCreatedAt - a.latestCreatedAt,
    );

    return { tickets, hasMore, nextCursor };
  },
});

export const getAiLogStats = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("not authenticated");
    }

    await requireAdmin(ctx, userId);

    // Get recent logs for stats (last 30 days)
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recentLogs = await ctx.db
      .query("aiLogs")
      .withIndex("by_created", (q) => q.gte("createdAt", thirtyDaysAgo))
      .take(10001);
    if (recentLogs.length > 10000) {
      throw new Error("AI log statistics exceed the exact aggregation limit");
    }

    // Calculate stats
    const total = recentLogs.length;
    const success = recentLogs.filter((l) => l.status === "success").length;
    const failed = recentLogs.filter((l) => l.status === "failed").length;
    const approved = recentLogs.filter((l) => l.status === "approved").length;
    const rejected = recentLogs.filter((l) => l.status === "rejected").length;
    const requestChanges = recentLogs.filter(
      (l) => l.status === "request_changes",
    ).length;
    const pendingApproval = recentLogs.filter(
      (l) => l.status === "pending_approval",
    ).length;

    // Success rate (approved + success) / (approved + success + rejected + failed)
    const completedTotal = success + approved + rejected + failed;
    const successRate =
      completedTotal > 0 ? ((success + approved) / completedTotal) * 100 : 0;

    // Approval rate (approved) / (approved + rejected + request_changes)
    const reviewedTotal = approved + rejected + requestChanges;
    const approvalRate =
      reviewedTotal > 0 ? (approved / reviewedTotal) * 100 : 0;

    // Group by workflow type
    const byWorkflowType = recentLogs.reduce(
      (acc, log) => {
        const type = log.workflowType;
        if (!acc[type]) {
          acc[type] = { total: 0, success: 0, failed: 0 };
        }
        acc[type].total++;
        if (log.status === "success" || log.status === "approved") {
          acc[type].success++;
        }
        if (log.status === "failed" || log.status === "rejected") {
          acc[type].failed++;
        }
        return acc;
      },
      {} as Record<string, { total: number; success: number; failed: number }>,
    );

    // Total tokens and cost
    const totalInputTokens = recentLogs.reduce(
      (sum, l) => sum + (l.inputTokens ?? 0),
      0,
    );
    const totalOutputTokens = recentLogs.reduce(
      (sum, l) => sum + (l.outputTokens ?? 0),
      0,
    );
    const totalCostCents = recentLogs.reduce(
      (sum, l) => sum + (l.totalCostCents ?? 0),
      0,
    );

    return {
      total,
      success,
      failed,
      approved,
      rejected,
      requestChanges,
      pendingApproval,
      successRate: Math.round(successRate * 10) / 10,
      approvalRate: Math.round(approvalRate * 10) / 10,
      byWorkflowType,
      totalInputTokens,
      totalOutputTokens,
      totalCostCents,
    };
  },
});

export const listAiLogsByIndexing = query({
  args: {
    limit: v.optional(v.number()),
    cursor: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("not authenticated");
    }

    await requireAdmin(ctx, userId);

    const limit = args.limit ?? 50;

    // Get logs where workflowType is "indexing" with cursor-based pagination
    const logsQuery = ctx.db
      .query("aiLogs")
      .withIndex("by_workflow_type", (q) => q.eq("workflowType", "indexing"));

    let logs;
    if (args.cursor) {
      logs = await logsQuery
        .filter((q) => q.lt(q.field("createdAt"), args.cursor!))
        .order("desc")
        .take(limit + 1);
    } else {
      logs = await logsQuery.order("desc").take(limit + 1);
    }

    const hasMore = logs.length > limit;
    const items = logs.slice(0, limit);
    const nextCursor = hasMore ? items[items.length - 1]?.createdAt : undefined;

    // Group by repository
    const repoMap = new Map<
      string,
      {
        repositoryId: Id<"repositories"> | null;
        githubRepo: string;
        logs: typeof items;
        totalLogs: number;
        successCount: number;
        failedCount: number;
        latestCreatedAt: number;
      }
    >();

    for (const log of items) {
      const key = log.repositoryId
        ? log.repositoryId
        : log.githubRepo || "unknown";

      if (!repoMap.has(key)) {
        repoMap.set(key, {
          repositoryId: log.repositoryId ?? null,
          githubRepo: log.githubRepo || "",
          logs: [],
          totalLogs: 0,
          successCount: 0,
          failedCount: 0,
          latestCreatedAt: log.createdAt,
        });
      }

      const repo = repoMap.get(key)!;
      repo.logs.push(log);
      repo.totalLogs++;

      if (log.status === "success") {
        repo.successCount++;
      } else if (log.status === "failed") {
        repo.failedCount++;
      }

      if (log.createdAt > repo.latestCreatedAt) {
        repo.latestCreatedAt = log.createdAt;
      }
    }

    // Convert to array and sort by latest activity
    const repositories = Array.from(repoMap.values()).sort(
      (a, b) => b.latestCreatedAt - a.latestCreatedAt,
    );

    return { repositories, hasMore, nextCursor };
  },
});
