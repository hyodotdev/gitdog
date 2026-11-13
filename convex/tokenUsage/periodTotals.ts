import type { WithoutSystemFields } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";

const USAGE_TOTALS_HOUR_MS = 60 * 60 * 1_000;

type ReadCtx = Pick<MutationCtx | QueryCtx, "db">;
type UsageRow = WithoutSystemFields<Doc<"tokenUsage">>;
type PeriodTotals = Doc<"tokenUsagePeriodTotals">;
type RepositoryEntry = PeriodTotals["repositories"][number];

// Longer periods are never aggregated; their readers keep the row path.
// Entitlement periods are calendar or billing months.
export const MAX_PERIOD_TOTALS_LENGTH_MS = 45 * 24 * USAGE_TOTALS_HOUR_MS;
// At most this many aggregates may start within one period length of each
// other, so every aggregate covering a timestamp is found with one bounded
// range read.
export const MAX_NEARBY_PERIOD_TOTALS = 16;
export const MAX_PERIOD_TOTALS_REPOSITORIES = 100;
export const MAX_PERIOD_TOTALS_BUILD_ROWS_PER_WINDOW = 8_000;
export const PERIOD_TOTALS_BUILD_ROW_BUDGET = 2_000;
export const MAX_PERIOD_TOTALS_BUILD_WINDOWS_PER_STEP = 250;
export const PERIOD_TOTALS_BUILD_STALL_MS = 10 * 60 * 1_000;

export const EMPTY_GITDOG_TOTALS: PeriodTotals["gitdog"] = {
  rowCount: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  purchasedTokensDebited: 0,
  baseCostCents: 0,
  serviceFeeCents: 0,
  totalCostCents: 0,
  chatActions: 0,
  embeddingTokens: 0,
};

export const EMPTY_USER_KEY_TOTALS: PeriodTotals["userKey"] = {
  rowCount: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  baseCostCents: 0,
};

const COST_PRECISION = 1_000_000;
const INVALID_ROW = "Token usage row cannot be added to period totals";

function addCount(current: number, value: number, sign: 1 | -1 = 1): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(INVALID_ROW);
  const total = current + sign * value;
  if (!Number.isSafeInteger(total) || total < 0) throw new Error(INVALID_ROW);
  return total;
}

function addCost(current: number, value: number, sign: 1 | -1 = 1): number {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error(INVALID_ROW);
  }
  // Round to a millionth of a cent so subtraction leaves no float dust;
  // costs are never negative.
  const total = Math.max(
    0,
    Math.round((current + sign * value) * COST_PRECISION) / COST_PRECISION,
  );
  if (!Number.isFinite(total) || total > Number.MAX_SAFE_INTEGER) {
    throw new Error(INVALID_ROW);
  }
  return total;
}

const EMPTY_REPOSITORY_ENTRY: Omit<RepositoryEntry, "repositoryId"> = {
  rowCount: 0,
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  baseCostCents: 0,
  serviceFeeCents: 0,
  totalCostCents: 0,
  chatActions: 0,
  userKeyTokens: 0,
  userKeyActions: 0,
};

function applyToRepositoryEntry(
  entry: RepositoryEntry,
  row: UsageRow,
  sign: 1 | -1,
): RepositoryEntry {
  entry = { ...entry, rowCount: addCount(entry.rowCount, 1, sign) };
  if (row.keySource === "user") {
    return {
      ...entry,
      userKeyTokens: addCount(entry.userKeyTokens, row.totalTokens, sign),
      userKeyActions: addCount(entry.userKeyActions, 1, sign),
    };
  }
  return {
    ...entry,
    totalTokens: addCount(entry.totalTokens, row.totalTokens, sign),
    inputTokens: addCount(entry.inputTokens, row.inputTokens, sign),
    outputTokens: addCount(entry.outputTokens, row.outputTokens, sign),
    baseCostCents: addCost(entry.baseCostCents, row.baseCostCents, sign),
    serviceFeeCents: addCost(entry.serviceFeeCents, row.serviceFeeCents, sign),
    totalCostCents: addCost(entry.totalCostCents, row.totalCostCents, sign),
    chatActions: addCount(
      entry.chatActions,
      row.usageType === "chat" ? 1 : 0,
      sign,
    ),
  };
}

function applyToRepositories(
  totals: Pick<PeriodTotals, "repositories" | "repositoriesOverflow">,
  repositoryId: Id<"repositories"> | undefined,
  row: UsageRow,
  sign: 1 | -1,
): Pick<PeriodTotals, "repositories" | "repositoriesOverflow"> {
  const index = totals.repositories.findIndex(
    (entry) => entry.repositoryId === repositoryId,
  );
  if (index === -1) {
    if (sign === -1 || totals.repositoriesOverflow === true) {
      return {
        repositories: totals.repositories,
        repositoriesOverflow: totals.repositoriesOverflow,
      };
    }
    if (totals.repositories.length >= MAX_PERIOD_TOTALS_REPOSITORIES) {
      return { repositories: totals.repositories, repositoriesOverflow: true };
    }
    const entry: RepositoryEntry = {
      ...(repositoryId ? { repositoryId } : {}),
      ...EMPTY_REPOSITORY_ENTRY,
    };
    return {
      repositories: [
        ...totals.repositories,
        applyToRepositoryEntry(entry, row, 1),
      ],
      repositoriesOverflow: totals.repositoriesOverflow,
    };
  }
  const repositories = [...totals.repositories];
  repositories[index] = applyToRepositoryEntry(repositories[index], row, sign);
  return { repositories, repositoriesOverflow: totals.repositoriesOverflow };
}

/** Add one usage row to an aggregate's running sums. */
export function addRowToPeriodTotals(
  totals: Pick<
    PeriodTotals,
    "gitdog" | "userKey" | "repositories" | "repositoriesOverflow"
  >,
  row: UsageRow,
): Pick<
  PeriodTotals,
  "gitdog" | "userKey" | "repositories" | "repositoriesOverflow"
> {
  const repositories = applyToRepositories(totals, row.repositoryId, row, 1);
  if (row.keySource === "user") {
    const userKey = totals.userKey;
    return {
      gitdog: totals.gitdog,
      userKey: {
        rowCount: addCount(userKey.rowCount, 1),
        inputTokens: addCount(userKey.inputTokens, row.inputTokens),
        outputTokens: addCount(userKey.outputTokens, row.outputTokens),
        totalTokens: addCount(userKey.totalTokens, row.totalTokens),
        baseCostCents: addCost(userKey.baseCostCents, row.baseCostCents),
      },
      ...repositories,
    };
  }
  const gitdog = totals.gitdog;
  return {
    gitdog: {
      rowCount: addCount(gitdog.rowCount, 1),
      inputTokens: addCount(gitdog.inputTokens, row.inputTokens),
      outputTokens: addCount(gitdog.outputTokens, row.outputTokens),
      totalTokens: addCount(gitdog.totalTokens, row.totalTokens),
      purchasedTokensDebited: addCount(
        gitdog.purchasedTokensDebited,
        row.purchasedTokensDebited,
      ),
      baseCostCents: addCost(gitdog.baseCostCents, row.baseCostCents),
      serviceFeeCents: addCost(gitdog.serviceFeeCents, row.serviceFeeCents),
      totalCostCents: addCost(gitdog.totalCostCents, row.totalCostCents),
      chatActions: addCount(
        gitdog.chatActions,
        row.usageType === "chat" ? 1 : 0,
      ),
      embeddingTokens: addCount(
        gitdog.embeddingTokens,
        row.usageType === "embedding"
          ? (row.embeddingTokens ?? row.totalTokens)
          : 0,
      ),
    },
    userKey: totals.userKey,
    ...repositories,
  };
}

/** Every aggregate whose period contains the timestamp. */
async function readCoveringPeriodTotals(
  ctx: ReadCtx,
  userId: Id<"users">,
  createdAt: number,
): Promise<PeriodTotals[]> {
  const nearby = await ctx.db
    .query("tokenUsagePeriodTotals")
    .withIndex("by_user_and_period_start", (q) =>
      q
        .eq("userId", userId)
        .gte("periodStart", createdAt - MAX_PERIOD_TOTALS_LENGTH_MS)
        .lte("periodStart", createdAt),
    )
    .take(MAX_NEARBY_PERIOD_TOTALS + 1);
  if (nearby.length > MAX_NEARBY_PERIOD_TOTALS) {
    // Creation keeps this impossible; never skip an aggregate silently.
    throw new Error("Token usage period totals exceed their bound");
  }
  return nearby.filter((totals) => totals.periodEnd > createdAt);
}

/** True when a paged build will still read this row itself. */
function buildWillReadRow(totals: PeriodTotals, createdAt: number): boolean {
  return totals.builtThrough !== undefined && createdAt >= totals.builtThrough;
}

/**
 * Add a just-inserted usage row to every aggregate covering it. Must run in
 * the same transaction as the insert.
 */
export async function addUsageToPeriodTotals(
  ctx: MutationCtx,
  row: UsageRow,
): Promise<void> {
  const now = Date.now();
  for (const totals of await readCoveringPeriodTotals(
    ctx,
    row.userId,
    row.createdAt,
  )) {
    if (
      totals.buildAbandonedAt !== undefined ||
      buildWillReadRow(totals, row.createdAt)
    ) {
      continue;
    }
    let sums: ReturnType<typeof addRowToPeriodTotals>;
    try {
      sums = addRowToPeriodTotals(totals, row);
    } catch {
      // Aggregate upkeep never blocks recording usage: a row the aggregate
      // cannot hold moves this period to the row path for good.
      await ctx.db.patch(totals._id, { buildAbandonedAt: now, updatedAt: now });
      continue;
    }
    await ctx.db.patch(totals._id, { ...sums, updatedAt: now });
  }
}

/**
 * Move a row's per-repository amounts to the unattributed bucket, for the
 * transaction that clears the row's repositoryId.
 */
export async function detachUsageRepositoryInPeriodTotals(
  ctx: MutationCtx,
  row: Doc<"tokenUsage">,
): Promise<void> {
  if (row.repositoryId === undefined) return;
  const now = Date.now();
  for (const totals of await readCoveringPeriodTotals(
    ctx,
    row.userId,
    row.createdAt,
  )) {
    if (
      totals.buildAbandonedAt !== undefined ||
      buildWillReadRow(totals, row.createdAt)
    ) {
      continue;
    }
    let moved: ReturnType<typeof applyToRepositories>;
    try {
      const removed = applyToRepositories(totals, row.repositoryId, row, -1);
      moved = applyToRepositories({ ...totals, ...removed }, undefined, row, 1);
    } catch {
      await ctx.db.patch(totals._id, { buildAbandonedAt: now, updatedAt: now });
      continue;
    }
    await ctx.db.patch(totals._id, { ...moved, updatedAt: now });
  }
}

/** The complete aggregate of exactly this period, or null. */
export async function readCompletePeriodTotals(
  ctx: ReadCtx,
  userId: Id<"users">,
  periodStart: number,
  periodEnd: number,
): Promise<PeriodTotals | null> {
  if (!Number.isFinite(periodStart) || !Number.isFinite(periodEnd)) {
    return null;
  }
  const totals = await ctx.db
    .query("tokenUsagePeriodTotals")
    .withIndex("by_user_and_period_start", (q) =>
      q
        .eq("userId", userId)
        .eq("periodStart", periodStart)
        .eq("periodEnd", periodEnd),
    )
    .first();
  return totals &&
    totals.builtThrough === undefined &&
    totals.buildAbandonedAt === undefined
    ? totals
    : null;
}

/**
 * Make sure an aggregate exists for the period. A period with no rows yet
 * starts complete; otherwise a paged build is scheduled and readers keep the
 * row path until it finishes. Returns null when the period cannot be
 * aggregated safely.
 */
export async function ensurePeriodTotals(
  ctx: MutationCtx,
  userId: Id<"users">,
  periodStart: number,
  periodEnd: number,
): Promise<Id<"tokenUsagePeriodTotals"> | null> {
  if (
    !Number.isSafeInteger(periodStart) ||
    !Number.isSafeInteger(periodEnd) ||
    periodEnd <= periodStart ||
    periodEnd - periodStart > MAX_PERIOD_TOTALS_LENGTH_MS
  ) {
    return null;
  }
  const existing = await ctx.db
    .query("tokenUsagePeriodTotals")
    .withIndex("by_user_and_period_start", (q) =>
      q
        .eq("userId", userId)
        .eq("periodStart", periodStart)
        .eq("periodEnd", periodEnd),
    )
    .first();
  if (existing) {
    // Restart a build whose scheduled step was lost or failed, at most once
    // per stall interval.
    if (
      existing.builtThrough !== undefined &&
      existing.buildAbandonedAt === undefined &&
      existing.updatedAt <= Date.now() - PERIOD_TOTALS_BUILD_STALL_MS
    ) {
      await ctx.db.patch(existing._id, { updatedAt: Date.now() });
      await ctx.scheduler.runAfter(
        0,
        internal.tokenUsage.internalMutation.buildUsagePeriodTotals,
        { totalsId: existing._id },
      );
    }
    return existing._id;
  }

  const nearby = await ctx.db
    .query("tokenUsagePeriodTotals")
    .withIndex("by_user_and_period_start", (q) =>
      q
        .eq("userId", userId)
        .gte("periodStart", periodStart - MAX_PERIOD_TOTALS_LENGTH_MS)
        .lte("periodStart", periodStart + MAX_PERIOD_TOTALS_LENGTH_MS),
    )
    .take(MAX_NEARBY_PERIOD_TOTALS);
  if (nearby.length >= MAX_NEARBY_PERIOD_TOTALS) return null;

  const firstRow = await ctx.db
    .query("tokenUsage")
    .withIndex("by_user_and_month", (q) =>
      q
        .eq("userId", userId)
        .gte("createdAt", periodStart)
        .lt("createdAt", periodEnd),
    )
    .first();
  const now = Date.now();
  const totalsId = await ctx.db.insert("tokenUsagePeriodTotals", {
    userId,
    periodStart,
    periodEnd,
    ...(firstRow ? { builtThrough: periodStart } : {}),
    gitdog: EMPTY_GITDOG_TOTALS,
    userKey: EMPTY_USER_KEY_TOTALS,
    repositories: [],
    createdAt: now,
    updatedAt: now,
  });
  if (firstRow) {
    await ctx.scheduler.runAfter(
      0,
      internal.tokenUsage.internalMutation.buildUsagePeriodTotals,
      { totalsId },
    );
  }
  return totalsId;
}

/**
 * Add the existing rows of one aggregate's period, one bounded window at a
 * time. Inserts that land meanwhile are added by addUsageToPeriodTotals when
 * they are older than builtThrough and read here otherwise.
 */
export async function buildPeriodTotalsStep(
  ctx: MutationCtx,
  totalsId: Id<"tokenUsagePeriodTotals">,
): Promise<{ done: boolean }> {
  const totals = await ctx.db.get(totalsId);
  if (
    !totals ||
    totals.builtThrough === undefined ||
    totals.buildAbandonedAt !== undefined
  ) {
    return { done: true };
  }
  const { userId, periodEnd } = totals;
  let builtThrough: number | undefined = totals.builtThrough;
  let windowMs = totals.buildWindowMs ?? USAGE_TOTALS_HOUR_MS;
  let sums: Pick<
    PeriodTotals,
    "gitdog" | "userKey" | "repositories" | "repositoriesOverflow"
  > = totals;
  let rowBudget = PERIOD_TOTALS_BUILD_ROW_BUDGET;
  // Each iteration makes two range reads; the cap keeps a sparse period far
  // below the per-transaction read limits.
  for (
    let windows = 0;
    builtThrough !== undefined &&
    rowBudget > 0 &&
    windows < MAX_PERIOD_TOTALS_BUILD_WINDOWS_PER_STEP;
    windows++
  ) {
    const from: number = builtThrough;
    const next = await ctx.db
      .query("tokenUsage")
      .withIndex("by_user_and_month", (q) =>
        q
          .eq("userId", userId)
          .gte("createdAt", from)
          .lt("createdAt", periodEnd),
      )
      .first();
    if (!next) {
      builtThrough = undefined;
      break;
    }
    const windowEnd = Math.min(next.createdAt + windowMs, periodEnd);
    const rows = await ctx.db
      .query("tokenUsage")
      .withIndex("by_user_and_month", (q) =>
        q
          .eq("userId", userId)
          .gte("createdAt", next.createdAt)
          .lt("createdAt", windowEnd),
      )
      .take(MAX_PERIOD_TOTALS_BUILD_ROWS_PER_WINDOW + 1);
    if (rows.length > MAX_PERIOD_TOTALS_BUILD_ROWS_PER_WINDOW) {
      if (windowMs <= 1) {
        // One millisecond holds more rows than a step may read: keep this
        // period on the row path for good.
        const now = Date.now();
        await ctx.db.patch(totalsId, { buildAbandonedAt: now, updatedAt: now });
        return { done: true };
      }
      // Retry with half the window in the next step, so one step never reads
      // more than one oversized window.
      windowMs = Math.floor(windowMs / 2);
      break;
    }
    try {
      for (const row of rows) sums = addRowToPeriodTotals(sums, row);
    } catch {
      // A row the aggregate cannot hold keeps this period on the row path.
      const now = Date.now();
      await ctx.db.patch(totalsId, { buildAbandonedAt: now, updatedAt: now });
      return { done: true };
    }
    builtThrough = windowEnd;
    rowBudget -= rows.length;
    // A sparse window lets the window grow back toward the default.
    if (rows.length * 4 <= MAX_PERIOD_TOTALS_BUILD_ROWS_PER_WINDOW) {
      windowMs = Math.min(windowMs * 2, USAGE_TOTALS_HOUR_MS);
    }
  }
  await ctx.db.patch(totalsId, {
    ...sums,
    builtThrough,
    buildWindowMs: windowMs === USAGE_TOTALS_HOUR_MS ? undefined : windowMs,
    updatedAt: Date.now(),
  });
  if (builtThrough === undefined) return { done: true };
  await ctx.scheduler.runAfter(
    0,
    internal.tokenUsage.internalMutation.buildUsagePeriodTotals,
    { totalsId },
  );
  return { done: false };
}
