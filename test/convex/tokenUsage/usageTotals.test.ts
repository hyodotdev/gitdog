import { convexTest } from "convex-test";
import { globSync } from "glob";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { MutationCtx } from "../../../convex/_generated/server";
import { MAX_COLLECT_LIMIT } from "../../../convex/_utils/pagination";
import schema from "../../../convex/schema";
import {
  readBillingPeriodUsage,
  readQuotaTokenUsage,
} from "../../../convex/tokenUsage/quota";
import {
  hasUsageTotals,
  insertTokenUsage,
  USAGE_TOTALS_HOUR_MS,
} from "../../../convex/tokenUsage/totals";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/tokenUsage/internalMutation.ts": () =>
    import("../../../convex/tokenUsage/internalMutation"),
  "../../../convex/tokenUsage/internalQuery.ts": () =>
    import("../../../convex/tokenUsage/internalQuery"),
};

const HOUR = USAGE_TOTALS_HOUR_MS;
const BASE = Date.UTC(2026, 10, 1);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function usageRow(
  userId: Id<"users">,
  createdAt: number,
  totalTokens: number,
  purchasedTokensDebited = 0,
) {
  return {
    userId,
    usageType: "chat" as const,
    inputTokens: totalTokens,
    outputTokens: 0,
    totalTokens,
    purchasedTokensDebited,
    inputCostCents: totalTokens / 1_000,
    outputCostCents: 0,
    baseCostCents: totalTokens / 1_000,
    serviceFeeCents: totalTokens / 4_000,
    totalCostCents: totalTokens / 800,
    model: "test-model",
    provider: "google" as const,
    serviceFeeRate: 0.25,
    createdAt,
  };
}

/** Count the documents a read returns, as a proxy for transaction read size. */
function countingCtx(ctx: MutationCtx) {
  const counts = { documents: 0, repositoryReads: 0 };
  const count = <T>(value: T): T => {
    counts.documents += Array.isArray(value) ? value.length : value ? 1 : 0;
    return value;
  };
  const wrapQuery = (query: unknown): unknown =>
    new Proxy(query as object, {
      get(target, property) {
        const member = Reflect.get(target, property) as unknown;
        if (typeof member !== "function") return member;
        return (...args: unknown[]) => {
          const result = (member as (...a: unknown[]) => unknown).apply(
            target,
            args,
          );
          return result instanceof Promise
            ? result.then(count)
            : wrapQuery(result);
        };
      },
    });
  const db = new Proxy(ctx.db, {
    get(target, property) {
      if (property === "query") {
        return (table: string) => {
          if (table === "repositories") counts.repositoryReads += 1;
          return wrapQuery(target.query(table as never));
        };
      }
      return Reflect.get(target, property) as unknown;
    },
  });
  return { ctx: { db } as Pick<MutationCtx, "db">, counts };
}

async function runBackfill(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
): Promise<void> {
  await t.mutation(internal.tokenUsage.internalMutation.backfillUsageTotals, {
    userId,
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

describe("hourly usage totals", () => {
  it("inserts usage rows only through insertTokenUsage", () => {
    const direct = globSync("convex/**/*.ts", {
      ignore: ["convex/_generated/**", "convex/tokenUsage/totals.ts"],
    }).filter((file) =>
      /insert\(\s*"tokenUsage"/.test(readFileSync(file, "utf8")),
    );
    expect(direct).toEqual([]);
  });

  it("covers a new user from the first usage write", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {});
      await insertTokenUsage(ctx, usageRow(id, BASE + 5, 700, 100));
      await insertTokenUsage(ctx, usageRow(id, BASE + HOUR - 1, 300));
      await insertTokenUsage(ctx, usageRow(id, BASE + HOUR, 50));
      return id;
    });

    await t.run(async (ctx) => {
      expect(await hasUsageTotals(ctx, userId)).toBe(true);
      const hours = await ctx.db.query("tokenUsageHourlyTotals").collect();
      expect(
        hours.map(({ hourStart, rowCount, totalTokens }) => ({
          hourStart,
          rowCount,
          totalTokens,
        })),
      ).toEqual([
        { hourStart: BASE, rowCount: 2, totalTokens: 1_000 },
        { hourStart: BASE + HOUR, rowCount: 1, totalTokens: 50 },
      ]);
      expect(
        await readQuotaTokenUsage(ctx, {
          userId,
          periodStart: BASE,
          periodEndExclusive: BASE + 2 * HOUR,
        }),
      ).toEqual({
        verified: true,
        tokensUsed: 1_050,
        purchasedTokensDebited: 100,
      });
    });
  });

  it("keeps reading raw rows until existing usage is backfilled", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {});
      await ctx.db.insert("tokenUsage", usageRow(id, BASE + 10, 400));
      await insertTokenUsage(ctx, usageRow(id, BASE + 20, 600));
      return id;
    });
    const period = {
      userId,
      periodStart: BASE,
      periodEndExclusive: BASE + HOUR,
    };

    await t.run(async (ctx) => {
      expect(await hasUsageTotals(ctx, userId)).toBe(false);
      expect(await readQuotaTokenUsage(ctx, period)).toMatchObject({
        tokensUsed: 1_000,
      });
    });

    await runBackfill(t, userId);
    await t.run(async (ctx) => {
      expect(await hasUsageTotals(ctx, userId)).toBe(true);
      const hours = await ctx.db.query("tokenUsageHourlyTotals").collect();
      expect(hours).toHaveLength(1);
      expect(hours[0]).toMatchObject({ rowCount: 2, totalTokens: 1_000 });
    });
    await expect(
      t.query(internal.tokenUsage.internalQuery.verifyUsageTotals, period),
    ).resolves.toMatchObject({ ready: true, matches: true });
  });

  it("matches the raw-row sums for periods that start and end mid-hour", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {});
      // Legacy rows written before hourly totals existed.
      for (let index = 0; index < 400; index++) {
        await ctx.db.insert(
          "tokenUsage",
          usageRow(id, BASE + index * 11 * 60_000 + 17, 100 + index, index % 7),
        );
      }
      return id;
    });
    await runBackfill(t, userId);
    await t.run(async (ctx) => {
      // Live rows, including one backdated into an already rebuilt hour.
      await insertTokenUsage(ctx, usageRow(userId, BASE + 90 * 60_000, 999, 9));
      await insertTokenUsage(ctx, usageRow(userId, BASE + 80 * HOUR, 5));
    });

    const periods = [
      [BASE, BASE + 100 * HOUR],
      [BASE + 30 * 60_000 + 1, BASE + 50 * HOUR + 12_345],
      [BASE + 2 * HOUR + 5, BASE + 2 * HOUR + 50 * 60_000],
      [BASE + 2 * HOUR + 30 * 60_000, BASE + 3 * HOUR + 30 * 60_000],
      [BASE + 10 * HOUR, undefined],
      [BASE - 5 * HOUR - 1, BASE + 73 * HOUR],
    ] as const;
    await t.run(async (ctx) => {
      for (const [periodStart, periodEndExclusive] of periods) {
        const period = { userId, periodStart, periodEndExclusive };
        const rows = await readBillingPeriodUsage(ctx, period, "rows");
        const totals = await readBillingPeriodUsage(ctx, period, "auto");
        if (!rows.verified || !totals.verified) {
          throw new Error("usage must be verified");
        }
        expect(totals.tokensUsed).toBe(rows.tokensUsed);
        expect(totals.purchasedTokensDebited).toBe(rows.purchasedTokensDebited);
        expect(totals.totalCostCents).toBeCloseTo(rows.totalCostCents, 6);
        expect(totals.totalServiceFeeCents).toBeCloseTo(
          rows.totalServiceFeeCents,
          6,
        );
      }
    });
  });

  it("verifies a period with more than the raw-row limit at a bounded read size", async () => {
    const t = convexTest(schema, modules);
    const rowCount = MAX_COLLECT_LIMIT + 500;
    const userId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {});
      for (let index = 0; index < rowCount; index++) {
        await ctx.db.insert(
          "tokenUsage",
          usageRow(id, BASE + (index % 6) * HOUR + index, 3),
        );
      }
      return id;
    });
    const period = {
      userId,
      periodStart: BASE,
      periodEndExclusive: BASE + 31 * 24 * HOUR,
    };

    await t.run(async (ctx) => {
      expect(await readQuotaTokenUsage(ctx, period)).toEqual({
        verified: false,
        reason: "usage_history_too_large",
      });
    });

    await runBackfill(t, userId);
    await t.run(async (ctx) => {
      const counting = countingCtx(ctx);
      expect(await readQuotaTokenUsage(counting.ctx, period)).toEqual({
        verified: true,
        tokensUsed: rowCount * 3,
        purchasedTokensDebited: 0,
      });
      // One state row and six hourly totals, whatever the usage row count.
      expect(counting.counts.documents).toBe(7);
      expect(counting.counts.repositoryReads).toBe(0);
    });
  }, 120_000);

  it("rebuilds the same totals when the backfill is repeated from scratch", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {});
      for (let index = 0; index < 50; index++) {
        await ctx.db.insert(
          "tokenUsage",
          usageRow(id, BASE + index * 20 * 60_000, 10 + index),
        );
      }
      return id;
    });
    await runBackfill(t, userId);
    const first = await t.run(
      async (ctx) => await ctx.db.query("tokenUsageHourlyTotals").collect(),
    );
    await t.run(async (ctx) => {
      const states = await ctx.db.query("tokenUsageTotalsStates").collect();
      for (const state of states) await ctx.db.delete(state._id);
    });
    await runBackfill(t, userId);
    const second = await t.run(
      async (ctx) => await ctx.db.query("tokenUsageHourlyTotals").collect(),
    );

    const summarize = (hours: typeof first) =>
      hours.map(({ hourStart, rowCount, totalTokens }) => ({
        hourStart,
        rowCount,
        totalTokens,
      }));
    expect(summarize(second)).toEqual(summarize(first));
    expect(first.reduce((sum, hour) => sum + hour.rowCount, 0)).toBe(50);
  });
});
