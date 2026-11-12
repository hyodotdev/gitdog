import { query } from "../_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { MAX_COLLECT_LIMIT } from "../_utils/pagination";
import { getSubscriptionForEntitlement } from "../subscriptions/entitlement";
import { readEffectiveSubscriptionQuota } from "../subscriptions/quotaEntitlement";

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

    // Aggregate tokenUsage records from periodStart
    const usageRecords = await ctx.db
      .query("tokenUsage")
      .withIndex("by_user_and_month", (q) =>
        q
          .eq("userId", userId)
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

    const yearMonth = new Date().toISOString().slice(0, 7);
    const paymentStatus = entitlement.plan === "free" ? "waived" : "pending";

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

    // Get all tokenUsage records for the billing period
    const usageRecords = await ctx.db
      .query("tokenUsage")
      .withIndex("by_user_and_month", (q) =>
        q
          .eq("userId", userId)
          .gte("createdAt", periodStart)
          .lt("createdAt", periodEnd),
      )
      .take(MAX_TOKEN_USAGE_AGGREGATION_RECORDS + 1);
    assertCompleteUsageAggregation(usageRecords.length);

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
      }
    >();

    for (const record of usageRecords) {
      const repoId = record.repositoryId ?? "unknown";
      const existing = usageByRepo.get(repoId) ?? {
        repositoryId: repoId,
        totalTokens: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalBaseCostCents: 0,
        totalServiceFeeCents: 0,
        totalCostCents: 0,
        totalActions: 0,
      };

      usageByRepo.set(repoId, {
        repositoryId: repoId,
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

    return Array.from(usageByRepo.values());
  },
});
