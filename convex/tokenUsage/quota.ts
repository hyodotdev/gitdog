import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { MAX_COLLECT_LIMIT } from "../_utils/pagination";
import {
  addUsageCosts,
  addUsageTokens,
  getUsageHourStart,
  hasUsageTotals,
  USAGE_TOTALS_HOUR_MS,
} from "./totals";

type QuotaReaderContext = Pick<MutationCtx | QueryCtx, "db">;
type QuotaPeriodArgs = {
  userId: Id<"users">;
  periodStart: number;
  periodEndExclusive?: number;
};
export type QuotaUsageSource = "auto" | "rows" | "totals";
type UnverifiedUsage = {
  verified: false;
  reason: "usage_history_too_large";
};

export function getSafeQuotaTokenLimit(
  includedTokens: number,
  purchasedTokens: number,
  purchasedTokensDebited: number,
): number | null {
  const values = [includedTokens, purchasedTokens, purchasedTokensDebited];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    return null;
  }
  const total = includedTokens + purchasedTokens + purchasedTokensDebited;
  return Number.isSafeInteger(total) ? total : null;
}

export function hasValidPurchasedTokenDebitCoverage(
  tokensUsed: number,
  includedTokens: number,
  purchasedTokensDebited: number,
): boolean {
  return (
    Number.isSafeInteger(tokensUsed) &&
    tokensUsed >= 0 &&
    Number.isSafeInteger(includedTokens) &&
    includedTokens >= 0 &&
    Number.isSafeInteger(purchasedTokensDebited) &&
    purchasedTokensDebited >= 0 &&
    purchasedTokensDebited <= Math.max(0, tokensUsed - includedTokens)
  );
}

type QuotaUsageAmounts = Pick<
  Doc<"tokenUsage">,
  | "totalTokens"
  | "purchasedTokensDebited"
  | "totalCostCents"
  | "serviceFeeCents"
>;
type PeriodUsage = {
  tokensUsed: number;
  purchasedTokensDebited: number;
  costs: { totalCostCents: number; totalServiceFeeCents: number } | null;
};

async function readBoundedQuotaRows(
  ctx: QuotaReaderContext,
  args: QuotaPeriodArgs,
): Promise<Doc<"tokenUsage">[] | null> {
  const quotaRange = ctx.db
    .query("tokenUsage")
    .withIndex("by_user_key_source_and_created_at", (q) => {
      const range = q
        .eq("userId", args.userId)
        .eq("keySource", undefined)
        .gte("createdAt", args.periodStart);
      return args.periodEndExclusive === undefined
        ? range
        : range.lt("createdAt", args.periodEndExclusive);
    });
  const quotaRows = await quotaRange.take(MAX_COLLECT_LIMIT + 1);
  return quotaRows.length > MAX_COLLECT_LIMIT ? null : quotaRows;
}

/**
 * Read the period as whole-hour totals plus the raw rows of the partial
 * hours at either end, so the cost does not grow with the row count.
 */
async function readQuotaAmountsFromTotals(
  ctx: QuotaReaderContext,
  args: QuotaPeriodArgs,
): Promise<QuotaUsageAmounts[] | null> {
  const periodEnd = args.periodEndExclusive;
  const firstHour =
    Math.ceil(args.periodStart / USAGE_TOTALS_HOUR_MS) * USAGE_TOTALS_HOUR_MS;
  const lastHour =
    periodEnd === undefined ? undefined : getUsageHourStart(periodEnd);
  if (lastHour !== undefined && lastHour <= firstHour) {
    return await readBoundedQuotaRows(ctx, args);
  }

  const [leadingRows, hours, trailingRows] = await Promise.all([
    firstHour > args.periodStart
      ? readBoundedQuotaRows(ctx, {
          userId: args.userId,
          periodStart: args.periodStart,
          periodEndExclusive: firstHour,
        })
      : [],
    ctx.db
      .query("tokenUsageHourlyTotals")
      .withIndex("by_user_and_hour", (q) => {
        const range = q.eq("userId", args.userId).gte("hourStart", firstHour);
        return lastHour === undefined ? range : range.lt("hourStart", lastHour);
      })
      .take(MAX_COLLECT_LIMIT + 1),
    periodEnd !== undefined && lastHour !== undefined && lastHour < periodEnd
      ? readBoundedQuotaRows(ctx, {
          userId: args.userId,
          periodStart: lastHour,
          periodEndExclusive: periodEnd,
        })
      : [],
  ]);
  if (!leadingRows || !trailingRows || hours.length > MAX_COLLECT_LIMIT) {
    return null;
  }
  return [...leadingRows, ...hours, ...trailingRows];
}

async function readPeriodUsage(
  ctx: QuotaReaderContext,
  args: QuotaPeriodArgs,
  source: QuotaUsageSource,
): Promise<PeriodUsage | null> {
  const useTotals =
    source !== "rows" &&
    Number.isFinite(args.periodStart) &&
    (args.periodEndExclusive === undefined ||
      Number.isFinite(args.periodEndExclusive)) &&
    (source === "totals" || (await hasUsageTotals(ctx, args.userId)));
  const amounts = useTotals
    ? await readQuotaAmountsFromTotals(ctx, args)
    : await readBoundedQuotaRows(ctx, args);
  if (!amounts) return null;

  let tokens = { totalTokens: 0, purchasedTokensDebited: 0 };
  let costs: { totalCostCents: number; serviceFeeCents: number } | null = {
    totalCostCents: 0,
    serviceFeeCents: 0,
  };
  for (const amount of amounts) {
    const nextTokens = addUsageTokens(tokens, amount);
    if (!nextTokens) return null;
    tokens = nextTokens;
    costs = costs && addUsageCosts(costs, amount);
  }
  return {
    tokensUsed: tokens.totalTokens,
    purchasedTokensDebited: tokens.purchasedTokensDebited,
    costs: costs && {
      totalCostCents: costs.totalCostCents,
      totalServiceFeeCents: costs.serviceFeeCents,
    },
  };
}

/** Sum quota-bearing usage without exceeding the database read ceiling. */
export async function readQuotaTokenUsage(
  ctx: QuotaReaderContext,
  args: QuotaPeriodArgs,
  source: QuotaUsageSource = "auto",
): Promise<
  | {
      verified: true;
      tokensUsed: number;
      purchasedTokensDebited: number;
    }
  | UnverifiedUsage
> {
  const usage = await readPeriodUsage(ctx, args, source);
  if (!usage) {
    return { verified: false, reason: "usage_history_too_large" };
  }
  return {
    verified: true,
    tokensUsed: usage.tokensUsed,
    purchasedTokensDebited: usage.purchasedTokensDebited,
  };
}

/** Read the quota-bearing token and cost totals for billing UI calculations. */
export async function readBillingPeriodUsage(
  ctx: QuotaReaderContext,
  args: QuotaPeriodArgs,
  source: QuotaUsageSource = "auto",
): Promise<
  | {
      verified: true;
      tokensUsed: number;
      purchasedTokensDebited: number;
      totalCostCents: number;
      totalServiceFeeCents: number;
    }
  | UnverifiedUsage
> {
  const usage = await readPeriodUsage(ctx, args, source);
  if (!usage?.costs) {
    return { verified: false, reason: "usage_history_too_large" };
  }
  return {
    verified: true,
    tokensUsed: usage.tokensUsed,
    purchasedTokensDebited: usage.purchasedTokensDebited,
    ...usage.costs,
  };
}
