import type { WithoutSystemFields } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  getEffectiveSubscriptionEntitlement,
  getSubscriptionForEntitlement,
} from "../subscriptions/entitlement";
import { addUsageToPeriodTotals, ensurePeriodTotals } from "./periodTotals";

export const USAGE_TOTALS_HOUR_MS = 60 * 60 * 1_000;
// One hour is rebuilt in one transaction so it stays exact under concurrent
// writes. Keep the scan well inside the per-transaction read limits.
export const MAX_USAGE_ROWS_PER_REBUILT_HOUR = 8_000;

type TotalsReadCtx = Pick<MutationCtx | QueryCtx, "db">;

export type UsageTotals = {
  rowCount: number;
  totalTokens: number;
  purchasedTokensDebited: number;
  totalCostCents: number;
  serviceFeeCents: number;
};

type UsageAmounts = Pick<
  Doc<"tokenUsage">,
  | "totalTokens"
  | "purchasedTokensDebited"
  | "totalCostCents"
  | "serviceFeeCents"
>;

export const EMPTY_USAGE_TOTALS: UsageTotals = {
  rowCount: 0,
  totalTokens: 0,
  purchasedTokensDebited: 0,
  totalCostCents: 0,
  serviceFeeCents: 0,
};

export function getUsageHourStart(createdAt: number): number {
  if (!Number.isFinite(createdAt)) {
    throw new Error("Token usage timestamp is invalid");
  }
  return Math.floor(createdAt / USAGE_TOTALS_HOUR_MS) * USAGE_TOTALS_HOUR_MS;
}

function addSafeCount(current: number, value: number): number | null {
  if (!Number.isSafeInteger(value) || value < 0) return null;
  const total = current + value;
  return Number.isSafeInteger(total) ? total : null;
}

function addSafeCost(current: number, value: number): number | null {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    return null;
  }
  const total = current + value;
  return total <= Number.MAX_SAFE_INTEGER ? total : null;
}

/** Add quota-bearing token counts, or null when they cannot be verified. */
export function addUsageTokens(
  current: Pick<UsageTotals, "totalTokens" | "purchasedTokensDebited">,
  value: Pick<UsageAmounts, "totalTokens" | "purchasedTokensDebited">,
): Pick<UsageTotals, "totalTokens" | "purchasedTokensDebited"> | null {
  const totalTokens = addSafeCount(current.totalTokens, value.totalTokens);
  const purchasedTokensDebited = addSafeCount(
    current.purchasedTokensDebited,
    value.purchasedTokensDebited,
  );
  return totalTokens === null || purchasedTokensDebited === null
    ? null
    : { totalTokens, purchasedTokensDebited };
}

/** Add display costs, or null when they cannot be verified. */
export function addUsageCosts(
  current: Pick<UsageTotals, "totalCostCents" | "serviceFeeCents">,
  value: Pick<UsageAmounts, "totalCostCents" | "serviceFeeCents">,
): Pick<UsageTotals, "totalCostCents" | "serviceFeeCents"> | null {
  const totalCostCents = addSafeCost(
    current.totalCostCents,
    value.totalCostCents,
  );
  const serviceFeeCents = addSafeCost(
    current.serviceFeeCents,
    value.serviceFeeCents,
  );
  return totalCostCents === null || serviceFeeCents === null
    ? null
    : { totalCostCents, serviceFeeCents };
}

function addUsageRows(current: UsageTotals, rows: UsageAmounts[]): UsageTotals {
  let totals = current;
  for (const row of rows) {
    const tokens = addUsageTokens(totals, row);
    const costs = addUsageCosts(totals, row);
    if (!tokens || !costs) {
      throw new Error("Token usage row cannot be added to hourly totals");
    }
    totals = { rowCount: totals.rowCount + 1, ...tokens, ...costs };
  }
  return totals;
}

export async function hasUsageTotals(
  ctx: TotalsReadCtx,
  userId: Id<"users">,
): Promise<boolean> {
  const state = await ctx.db
    .query("tokenUsageTotalsStates")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  return state !== null;
}

async function readUsageTotalsHour(
  ctx: TotalsReadCtx,
  userId: Id<"users">,
  hourStart: number,
): Promise<Doc<"tokenUsageHourlyTotals"> | null> {
  return await ctx.db
    .query("tokenUsageHourlyTotals")
    .withIndex("by_user_and_hour", (q) =>
      q.eq("userId", userId).eq("hourStart", hourStart),
    )
    .unique();
}

/**
 * Insert a usage row with its hourly and period totals in one transaction.
 * Every tokenUsage insert must go through here, or quota checks undercount.
 */
export async function insertTokenUsage(
  ctx: MutationCtx,
  row: WithoutSystemFields<Doc<"tokenUsage">>,
): Promise<Id<"tokenUsage">> {
  // The current entitlement period gets its aggregate before the row lands,
  // so a period without earlier rows starts complete.
  const now = Date.now();
  const entitlement = getEffectiveSubscriptionEntitlement(
    await getSubscriptionForEntitlement(ctx, row.userId, now),
    now,
  );
  await ensurePeriodTotals(
    ctx,
    row.userId,
    entitlement.periodStart,
    entitlement.periodEnd,
  );
  const usageId = await insertUsageRowAndHourlyTotals(ctx, row);
  await addUsageToPeriodTotals(ctx, row);
  return usageId;
}

async function insertUsageRowAndHourlyTotals(
  ctx: MutationCtx,
  row: WithoutSystemFields<Doc<"tokenUsage">>,
): Promise<Id<"tokenUsage">> {
  // Usage on the user's own provider key never counts toward Gitdog quota.
  if (row.keySource === "user") return await ctx.db.insert("tokenUsage", row);
  const hourStart = getUsageHourStart(row.createdAt);
  const now = Date.now();
  if (!(await hasUsageTotals(ctx, row.userId))) {
    // A user with no earlier rows is fully covered from the first write.
    // Users with earlier rows wait for backfillUsageTotals.
    const earlier = await ctx.db
      .query("tokenUsage")
      .withIndex("by_user_key_source_and_created_at", (q) =>
        q.eq("userId", row.userId).eq("keySource", undefined),
      )
      .first();
    if (!earlier) {
      await ctx.db.insert("tokenUsageTotalsStates", {
        userId: row.userId,
        readyAt: now,
      });
    }
  }

  const usageId = await ctx.db.insert("tokenUsage", row);
  const existing = await readUsageTotalsHour(ctx, row.userId, hourStart);
  const totals = addUsageRows(existing ?? EMPTY_USAGE_TOTALS, [row]);
  if (existing) {
    await ctx.db.patch(existing._id, { ...totals, updatedAt: now });
  } else {
    await ctx.db.insert("tokenUsageHourlyTotals", {
      userId: row.userId,
      hourStart,
      ...totals,
      updatedAt: now,
    });
  }
  return usageId;
}

/**
 * Recompute one hour from its usage rows. The scan and the write share a
 * transaction, so a concurrent insertTokenUsage lands before or after it.
 */
export async function rebuildUsageTotalsHour(
  ctx: MutationCtx,
  userId: Id<"users">,
  hourStart: number,
): Promise<number> {
  const rows = await ctx.db
    .query("tokenUsage")
    .withIndex("by_user_key_source_and_created_at", (q) =>
      q
        .eq("userId", userId)
        .eq("keySource", undefined)
        .gte("createdAt", hourStart)
        .lt("createdAt", hourStart + USAGE_TOTALS_HOUR_MS),
    )
    .take(MAX_USAGE_ROWS_PER_REBUILT_HOUR + 1);
  if (rows.length > MAX_USAGE_ROWS_PER_REBUILT_HOUR) {
    throw new Error("Token usage hour is too large to rebuild");
  }
  const totals = addUsageRows(EMPTY_USAGE_TOTALS, rows);
  const existing = await readUsageTotalsHour(ctx, userId, hourStart);
  const now = Date.now();
  switch (true) {
    case existing !== null && rows.length === 0:
      await ctx.db.delete(existing._id);
      break;
    case existing !== null:
      await ctx.db.patch(existing._id, { ...totals, updatedAt: now });
      break;
    case rows.length > 0:
      await ctx.db.insert("tokenUsageHourlyTotals", {
        userId,
        hourStart,
        ...totals,
        updatedAt: now,
      });
      break;
  }
  return rows.length;
}
