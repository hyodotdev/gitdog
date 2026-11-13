import { query, type QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { MAX_COLLECT_LIMIT } from "../_utils/pagination";
import { getSubscriptionForEntitlement } from "../subscriptions/entitlement";
import { readEffectiveSubscriptionQuota } from "../subscriptions/quotaEntitlement";
import { readCompletePeriodTotals } from "./periodTotals";

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
 * busy period is reported as a floor instead of failing the usage page.
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
        userKey: {
          inputTokens: period.userKey.inputTokens,
          outputTokens: period.userKey.outputTokens,
          totalTokens: period.userKey.totalTokens,
          totalActions: period.userKey.rowCount,
          estimatedProviderCostCents: period.userKey.baseCostCents,
          isPartial: false,
        },
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
    const userKeyRecords = await readUserKeyUsage(
      ctx,
      userId,
      periodStart,
      periodEnd,
    );

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

    const userKey = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalActions: 0,
      estimatedProviderCostCents: 0,
      isPartial: userKeyRecords.isPartial,
    };
    for (const record of userKeyRecords.rows) {
      userKey.inputTokens = checkedTokenSum(
        userKey.inputTokens,
        record.inputTokens,
      );
      userKey.outputTokens = checkedTokenSum(
        userKey.outputTokens,
        record.outputTokens,
      );
      userKey.totalTokens = checkedTokenSum(
        userKey.totalTokens,
        record.totalTokens,
      );
      userKey.totalActions = checkedTokenSum(userKey.totalActions, 1);
      userKey.estimatedProviderCostCents = checkedCostSum(
        userKey.estimatedProviderCostCents,
        record.baseCostCents,
      );
    }

    return {
      yearMonth,
      ...totals,
      userKey,
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
