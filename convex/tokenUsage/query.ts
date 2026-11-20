import { v } from "convex/values";
import { query, type QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { getAuthUserId } from "../_utils/auth";
import { MAX_COLLECT_LIMIT } from "../_utils/pagination";
import { getSubscriptionForEntitlement } from "../subscriptions/entitlement";
import { readEffectiveSubscriptionQuota } from "../subscriptions/quotaEntitlement";
import { readCompletePeriodTotals } from "./periodTotals";
import { summarizeActionUsage, summarizeUserKeyUsage } from "./usageSummary";

export const MAX_TOKEN_USAGE_AGGREGATION_RECORDS = MAX_COLLECT_LIMIT;

const INVALID_USAGE_TOTAL_MESSAGE =
  "Usage data contains values outside the supported range. Please contact support.";

function checkedTokenSum(current: number, value: number): number {
  if (
    !Number.isSafeInteger(current) ||
    current < 0 ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error(INVALID_USAGE_TOTAL_MESSAGE);
  }
  const total = current + value;
  if (!Number.isSafeInteger(total)) {
    throw new Error(INVALID_USAGE_TOTAL_MESSAGE);
  }
  return total;
}

function checkedCostSum(current: number, value: number): number {
  if (
    !Number.isFinite(current) ||
    current < 0 ||
    current > Number.MAX_SAFE_INTEGER ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new Error(INVALID_USAGE_TOTAL_MESSAGE);
  }
  const total = current + value;
  if (!Number.isFinite(total) || total > Number.MAX_SAFE_INTEGER) {
    throw new Error(INVALID_USAGE_TOTAL_MESSAGE);
  }
  return total;
}

export function assertCompleteUsageAggregation(recordCount: number): void {
  if (recordCount > MAX_TOKEN_USAGE_AGGREGATION_RECORDS) {
    throw new Error(
      "Usage history is too large to aggregate safely. Please contact support.",
    );
  }
}

/**
 * Usage on the user's own provider keys. It never counts toward quota, so a
 * busy period is reported as a floor instead of failing the usage page. Rows
 * come newest first, so a partial read still holds the latest actions.
 */
async function readUserKeyUsage(
  ctx: QueryCtx,
  userId: Id<"users">,
  periodStart: number,
  periodEnd: number,
): Promise<{ rows: Doc<"tokenUsage">[]; isPartial: boolean }> {
  const rows = await ctx.db
    .query("tokenUsage")
    .withIndex("by_user_key_source_and_created_at", (q) =>
      q
        .eq("userId", userId)
        .eq("keySource", "user")
        .gte("createdAt", periodStart)
        .lt("createdAt", periodEnd),
    )
    .order("desc")
    .take(MAX_TOKEN_USAGE_AGGREGATION_RECORDS + 1);
  return {
    rows: rows.slice(0, MAX_TOKEN_USAGE_AGGREGATION_RECORDS),
    isPartial: rows.length > MAX_TOKEN_USAGE_AGGREGATION_RECORDS,
  };
}

/**
 * Get current billing period's usage summary for the authenticated user
 * Aggregates tokenUsage records on-demand to avoid race conditions
 */
export const getCurrentMonthUsage = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return null;
    }

    // Get subscription to determine billing period
    const subscription = await getSubscriptionForEntitlement(ctx, userId);

    const quota = await readEffectiveSubscriptionQuota(ctx, subscription);
    if (!quota.verified) throw new Error(INVALID_USAGE_TOTAL_MESSAGE);
    const entitlement = quota.entitlement;
    const { periodStart, periodEnd } = entitlement;
    const yearMonth = new Date().toISOString().slice(0, 7);
    const paymentStatus = entitlement.plan === "free" ? "waived" : "pending";

    const period = await readCompletePeriodTotals(
      ctx,
      userId,
      periodStart,
      periodEnd,
    );
    if (period) {
      return {
        yearMonth,
        totalInputTokens: period.gitdog.inputTokens,
        totalOutputTokens: period.gitdog.outputTokens,
        totalTokens: period.gitdog.totalTokens,
        totalBaseCostCents: period.gitdog.baseCostCents,
        totalServiceFeeCents: period.gitdog.serviceFeeCents,
        totalCostCents: period.gitdog.totalCostCents,
        totalActions: period.gitdog.chatActions,
        totalEmbeddingTokens: period.gitdog.embeddingTokens,
        paymentStatus: paymentStatus as "waived" | "pending" | "paid",
      };
    }

    // Aggregate tokenUsage records from periodStart
    const usageRecords = await ctx.db
      .query("tokenUsage")
      .withIndex("by_user_key_source_and_created_at", (q) =>
        q
          .eq("userId", userId)
          .eq("keySource", undefined)
          .gte("createdAt", periodStart)
          .lt("createdAt", periodEnd),
      )
      .take(MAX_TOKEN_USAGE_AGGREGATION_RECORDS + 1);
    assertCompleteUsageAggregation(usageRecords.length);

    // `totalTokens` keeps cost-equivalent quota usage, while
    // `embeddingTokens` preserves the provider's actual embedding input count.
    const totals = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      totalBaseCostCents: 0,
      totalServiceFeeCents: 0,
      totalCostCents: 0,
      totalActions: 0,
      totalEmbeddingTokens: 0,
    };
    for (const record of usageRecords) {
      totals.totalInputTokens = checkedTokenSum(
        totals.totalInputTokens,
        record.inputTokens,
      );
      totals.totalOutputTokens = checkedTokenSum(
        totals.totalOutputTokens,
        record.outputTokens,
      );
      totals.totalTokens = checkedTokenSum(
        totals.totalTokens,
        record.totalTokens,
      );
      totals.totalBaseCostCents = checkedCostSum(
        totals.totalBaseCostCents,
        record.baseCostCents,
      );
      totals.totalServiceFeeCents = checkedCostSum(
        totals.totalServiceFeeCents,
        record.serviceFeeCents,
      );
      totals.totalCostCents = checkedCostSum(
        totals.totalCostCents,
        record.totalCostCents,
      );
      totals.totalActions = checkedTokenSum(
        totals.totalActions,
        record.usageType === "chat" ? 1 : 0,
      );
      totals.totalEmbeddingTokens = checkedTokenSum(
        totals.totalEmbeddingTokens,
        record.usageType === "embedding"
          ? (record.embeddingTokens ?? record.totalTokens)
          : 0,
      );
    }

    return {
      yearMonth,
      ...totals,
      paymentStatus: paymentStatus as "waived" | "pending" | "paid",
    };
  },
});

/**
 * Get token usage aggregated by repository for the current billing period
 */
export const getUsageByRepository = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return [];
    }

    // Get subscription to determine billing period
    const subscription = await getSubscriptionForEntitlement(ctx, userId);

    const quota = await readEffectiveSubscriptionQuota(ctx, subscription);
    if (!quota.verified) throw new Error(INVALID_USAGE_TOTAL_MESSAGE);
    const { periodStart, periodEnd } = quota.entitlement;

    const period = await readCompletePeriodTotals(
      ctx,
      userId,
      periodStart,
      periodEnd,
    );
    if (period && period.repositoriesOverflow !== true) {
      // Like the row path: one entry per repository that still has rows.
      return period.repositories
        .filter((entry) => entry.rowCount > 0)
        .map((entry) => ({
          repositoryId: entry.repositoryId ?? "unknown",
          totalTokens: entry.totalTokens,
          totalInputTokens: entry.inputTokens,
          totalOutputTokens: entry.outputTokens,
          totalBaseCostCents: entry.baseCostCents,
          totalServiceFeeCents: entry.serviceFeeCents,
          totalCostCents: entry.totalCostCents,
          totalActions: entry.chatActions,
          userKeyTokens: entry.userKeyTokens,
          userKeyActions: entry.userKeyActions,
        }));
    }

    // Get all tokenUsage records for the billing period
    const usageRecords = await ctx.db
      .query("tokenUsage")
      .withIndex("by_user_key_source_and_created_at", (q) =>
        q
          .eq("userId", userId)
          .eq("keySource", undefined)
          .gte("createdAt", periodStart)
          .lt("createdAt", periodEnd),
      )
      .take(MAX_TOKEN_USAGE_AGGREGATION_RECORDS + 1);
    assertCompleteUsageAggregation(usageRecords.length);
    const userKeyRecords = await readUserKeyUsage(
      ctx,
      userId,
      periodStart,
      periodEnd,
    );

    // Group by repositoryId
    const usageByRepo = new Map<
      string,
      {
        repositoryId: string;
        totalTokens: number;
        totalInputTokens: number;
        totalOutputTokens: number;
        totalBaseCostCents: number;
        totalServiceFeeCents: number;
        totalCostCents: number;
        totalActions: number;
        userKeyTokens: number;
        userKeyActions: number;
      }
    >();
    const emptyRepositoryUsage = (repositoryId: string) => ({
      repositoryId,
      totalTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalBaseCostCents: 0,
      totalServiceFeeCents: 0,
      totalCostCents: 0,
      totalActions: 0,
      userKeyTokens: 0,
      userKeyActions: 0,
    });

    for (const record of usageRecords) {
      const repoId = record.repositoryId ?? "unknown";
      const existing = usageByRepo.get(repoId) ?? emptyRepositoryUsage(repoId);

      usageByRepo.set(repoId, {
        ...existing,
        totalTokens: checkedTokenSum(existing.totalTokens, record.totalTokens),
        totalInputTokens: checkedTokenSum(
          existing.totalInputTokens,
          record.inputTokens,
        ),
        totalOutputTokens: checkedTokenSum(
          existing.totalOutputTokens,
          record.outputTokens,
        ),
        totalBaseCostCents: checkedCostSum(
          existing.totalBaseCostCents,
          record.baseCostCents,
        ),
        totalServiceFeeCents: checkedCostSum(
          existing.totalServiceFeeCents,
          record.serviceFeeCents,
        ),
        totalCostCents: checkedCostSum(
          existing.totalCostCents,
          record.totalCostCents,
        ),
        totalActions: checkedTokenSum(
          existing.totalActions,
          record.usageType === "chat" ? 1 : 0,
        ),
      });
    }

    for (const record of userKeyRecords.rows) {
      const repoId = record.repositoryId ?? "unknown";
      const existing = usageByRepo.get(repoId) ?? emptyRepositoryUsage(repoId);
      usageByRepo.set(repoId, {
        ...existing,
        userKeyTokens: checkedTokenSum(
          existing.userKeyTokens,
          record.totalTokens,
        ),
        userKeyActions: checkedTokenSum(existing.userKeyActions, 1),
      });
    }

    return Array.from(usageByRepo.values());
  },
});

const RECENT_USER_KEY_ACTIONS = 10;

/**
 * This period's usage on the owner's own keys, priced as the provider bills
 * it: totals, each model, each repository and the most recent actions.
 */
export const getUserKeyUsage = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    const subscription = await getSubscriptionForEntitlement(ctx, userId);
    const quota = await readEffectiveSubscriptionQuota(ctx, subscription);
    // Own-key usage never touches quota, so a quota problem only hides it;
    // the keys page that shows it must keep working.
    if (!quota.verified) return null;
    const { periodStart, periodEnd } = quota.entitlement;

    const { rows, isPartial } = await readUserKeyUsage(
      ctx,
      userId,
      periodStart,
      periodEnd,
    );
    const { actions, ...summary } = summarizeUserKeyUsage(rows);

    const recentActions = await Promise.all(
      actions.slice(0, RECENT_USER_KEY_ACTIONS).map(async (usage) => {
        const action = await ctx.db.get(usage.ticketActionId);
        const ticket = action && (await ctx.db.get(action.ticketId));
        if (!action || !ticket || ticket.userId !== userId) return null;
        return {
          ...usage,
          actionType: action.actionType,
          // Deleted tickets keep their cost but no longer link anywhere.
          ticketId: ticket.deletedAt ? null : ticket._id,
          ticketType: ticket.ticketType,
          githubRepo: ticket.githubRepo,
          githubNumber: ticket.githubNumber,
          githubTitle: ticket.githubTitle,
        };
      }),
    );

    return {
      isPartial,
      ...summary,
      recentActions: recentActions.filter((entry) => entry !== null),
    };
  },
});

// Bounded well under a query's read limit: the newest actions, and more rows
// per action than the largest batched review writes.
const MAX_TICKET_USAGE_ACTIONS = 40;
const MAX_ACTION_USAGE_ROWS = 300;

/** What each action on a ticket used and whose key paid for it. */
export const getTicketUsage = query({
  args: { ticketId: v.id("tickets") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const ticket = await ctx.db.get(args.ticketId);
    if (!ticket || ticket.userId !== userId || ticket.deletedAt) return [];

    const actions = await ctx.db
      .query("ticketActions")
      .withIndex("by_ticket", (q) => q.eq("ticketId", ticket._id))
      .order("desc")
      .take(MAX_TICKET_USAGE_ACTIONS);
    return await Promise.all(
      actions.map(async (action) => {
        const rows = await ctx.db
          .query("tokenUsage")
          .withIndex("by_ticket_action", (q) =>
            q.eq("ticketActionId", action._id),
          )
          .take(MAX_ACTION_USAGE_ROWS + 1);
        return {
          ticketActionId: action._id,
          isPartial: rows.length > MAX_ACTION_USAGE_ROWS,
          ...summarizeActionUsage(rows.slice(0, MAX_ACTION_USAGE_ROWS)),
        };
      }),
    );
  },
});
