import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "../../../convex/_generated/api";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import schema from "../../../convex/schema";
import {
  readBillingPeriodUsage,
  readQuotaTokenUsage,
} from "../../../convex/tokenUsage/quota";
import {
  detachUsageRepositoryInPeriodTotals,
  readCompletePeriodTotals,
} from "../../../convex/tokenUsage/periodTotals";
import { insertTokenUsage } from "../../../convex/tokenUsage/totals";
import { drainScheduledFunctions } from "../scheduling";

const modules = import.meta.glob("../../../convex/**/*.ts");
type Backend = ReturnType<typeof convexTest>;

const now = () => Date.now();
// The pinned test clock sits in November 2026; a free user's period is the
// UTC calendar month.
const PERIOD_START = Date.UTC(2026, 10, 1);
const PERIOD_END = Date.UTC(2026, 11, 1);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function usageRow(
  userId: Id<"users">,
  createdAt: number,
  totalTokens: number,
  extra: Partial<Doc<"tokenUsage">> = {},
) {
  return {
    userId,
    usageType: "chat" as const,
    inputTokens: totalTokens - 10,
    outputTokens: 10,
    totalTokens,
    purchasedTokensDebited: 0,
    inputCostCents: totalTokens / 1_000,
    outputCostCents: 0,
    baseCostCents: totalTokens / 1_000,
    serviceFeeCents: totalTokens / 4_000,
    totalCostCents: totalTokens / 800,
    model: "test-model",
    provider: "anthropic" as const,
    serviceFeeRate: 0.25,
    createdAt,
    ...extra,
  };
}

async function insertRepository(t: Backend, userId: Id<"users">) {
  return await t.run(async (ctx) => {
    const time = now();
    return await ctx.db.insert("repositories", {
      userId,
      installationId: 1,
      githubRepositoryId: 1,
      githubRepo: "owner/repo",
      githubRepoKey: "owner/repo",
      name: "repo",
      githubUrl: "https://github.com/owner/repo",
      isActive: true,
      indexVersion: 1,
      indexStatus: "completed",
      indexProgressAt: time,
      ragStatus: "completed",
      ragTotalChunks: 0,
      ragIndexedChunks: 0,
      ragFailedChunks: 0,
      indexSyncPending: false,
      settings: {
        issueAssistantEnabled: true,
        autoFormatIssue: true,
        autoAnswerQuestions: true,
        tagMaintainersForCodeChanges: true,
        discussionAssistantEnabled: true,
        autoFormatDiscussion: true,
        autoAnswerDiscussionQuestions: true,
        tagMaintainersForDiscussionCodeChanges: true,
        requireApproval: false,
        requireApprovalForDiscussions: false,
      },
      monthlyActions: 0,
      lastResetAt: time,
      createdAt: time,
      updatedAt: time,
    });
  });
}

/** What the aggregate must equal: a direct sum over the period's rows. */
async function sumRows(t: Backend, userId: Id<"users">) {
  const rows = await t.run((ctx) =>
    ctx.db
      .query("tokenUsage")
      .withIndex("by_user_and_month", (q) =>
        q
          .eq("userId", userId)
          .gte("createdAt", PERIOD_START)
          .lt("createdAt", PERIOD_END),
      )
      .collect(),
  );
  const gitdog = rows.filter((row) => row.keySource !== "user");
  const userKey = rows.filter((row) => row.keySource === "user");
  const sum = (
    list: typeof rows,
    pick: (row: (typeof rows)[number]) => number,
  ) => list.reduce((total, row) => total + pick(row), 0);
  return {
    gitdogTokens: sum(gitdog, (row) => row.totalTokens),
    gitdogInput: sum(gitdog, (row) => row.inputTokens),
    gitdogRows: gitdog.length,
    purchased: sum(gitdog, (row) => row.purchasedTokensDebited),
    gitdogCost: sum(gitdog, (row) => row.totalCostCents),
    userKeyTokens: sum(userKey, (row) => row.totalTokens),
    userKeyRows: userKey.length,
  };
}

async function readTotals(t: Backend, userId: Id<"users">) {
  return await t.run((ctx) =>
    readCompletePeriodTotals(ctx, userId, PERIOD_START, PERIOD_END),
  );
}

describe("token usage period totals", () => {
  it("equals the row sums across Gitdog, BYOK and repository detach writes", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    const repositoryId = await insertRepository(t, userId);

    await t.run(async (ctx) => {
      await insertTokenUsage(
        ctx,
        usageRow(userId, now() - 5_000, 1_200, {
          repositoryId,
          purchasedTokensDebited: 200,
        }),
      );
      await insertTokenUsage(
        ctx,
        usageRow(userId, now() - 4_000, 800, {
          repositoryId,
          keySource: "user",
        }),
      );
      await insertTokenUsage(ctx, usageRow(userId, now() - 3_000, 300));
    });

    const expected = await sumRows(t, userId);
    const totals = await readTotals(t, userId);
    expect(totals?.gitdog).toMatchObject({
      rowCount: expected.gitdogRows,
      totalTokens: expected.gitdogTokens,
      inputTokens: expected.gitdogInput,
      purchasedTokensDebited: expected.purchased,
      chatActions: 2,
    });
    expect(totals?.gitdog.totalCostCents).toBeCloseTo(expected.gitdogCost);
    expect(totals?.userKey).toMatchObject({
      rowCount: expected.userKeyRows,
      totalTokens: expected.userKeyTokens,
    });

    // BYOK rows never count toward quota.
    const quota = await t.run((ctx) =>
      readQuotaTokenUsage(ctx, {
        userId,
        periodStart: PERIOD_START,
        periodEndExclusive: PERIOD_END,
      }),
    );
    const rowsQuota = await t.run((ctx) =>
      readQuotaTokenUsage(
        ctx,
        { userId, periodStart: PERIOD_START, periodEndExclusive: PERIOD_END },
        "rows",
      ),
    );
    expect(quota).toEqual(rowsQuota);
    expect(quota).toMatchObject({
      tokensUsed: 1_500,
      purchasedTokensDebited: 200,
    });

    // Disconnect moves the repository's share to the unattributed bucket.
    await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("tokenUsage")
        .withIndex("by_repository", (q) => q.eq("repositoryId", repositoryId))
        .collect();
      for (const row of rows) {
        await detachUsageRepositoryInPeriodTotals(ctx, row);
        await ctx.db.patch(row._id, { repositoryId: undefined });
      }
    });
    const detached = await readTotals(t, userId);
    const repoEntry = detached?.repositories.find(
      (entry) => entry.repositoryId === repositoryId,
    );
    const unknownEntry = detached?.repositories.find(
      (entry) => entry.repositoryId === undefined,
    );
    expect(repoEntry).toMatchObject({
      totalTokens: 0,
      chatActions: 0,
      userKeyTokens: 0,
      userKeyActions: 0,
    });
    expect(unknownEntry).toMatchObject({
      totalTokens: 1_500,
      chatActions: 2,
      userKeyTokens: 800,
      userKeyActions: 1,
    });
    expect(detached?.gitdog.totalTokens).toBe(1_500);
  });

  it("never under-counts quota while no aggregate exists or one is building", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    // Rows written before aggregates existed.
    await t.run(async (ctx) => {
      for (let index = 0; index < 5; index++) {
        await ctx.db.insert(
          "tokenUsage",
          usageRow(userId, now() - 60_000 * (index + 1), 100),
        );
      }
    });
    const read = () =>
      t.run((ctx) =>
        readBillingPeriodUsage(ctx, {
          userId,
          periodStart: PERIOD_START,
          periodEndExclusive: PERIOD_END,
        }),
      );
    expect(await readTotals(t, userId)).toBeNull();
    expect(await read()).toMatchObject({ tokensUsed: 500 });

    // The next insert creates the aggregate in its building state; quota
    // reads keep counting rows until the build completes.
    await t.run((ctx) =>
      insertTokenUsage(ctx, usageRow(userId, now() - 1_000, 50)),
    );
    const building = await t.run((ctx) =>
      ctx.db
        .query("tokenUsagePeriodTotals")
        .withIndex("by_user_and_period_start", (q) => q.eq("userId", userId))
        .first(),
    );
    expect(building?.builtThrough).toBe(PERIOD_START);
    expect(await readTotals(t, userId)).toBeNull();
    expect(await read()).toMatchObject({ tokensUsed: 550 });

    // A row written while the build is pending is read by the build, not
    // added twice.
    await t.run((ctx) =>
      insertTokenUsage(ctx, usageRow(userId, now() - 500, 17)),
    );
    await drainScheduledFunctions(t);

    const expected = await sumRows(t, userId);
    const totals = await readTotals(t, userId);
    expect(totals?.gitdog.totalTokens).toBe(expected.gitdogTokens);
    expect(await read()).toMatchObject({ tokensUsed: expected.gitdogTokens });

    // A late row dated inside the completed period is added in place.
    await t.run((ctx) =>
      insertTokenUsage(ctx, usageRow(userId, PERIOD_START + 1_000, 33)),
    );
    expect((await readTotals(t, userId))?.gitdog.totalTokens).toBe(
      expected.gitdogTokens + 33,
    );
  });

  it("serves usage pages from the aggregate with the same numbers as the rows", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    const repositoryId = await insertRepository(t, userId);
    await t.run(async (ctx) => {
      await insertTokenUsage(
        ctx,
        usageRow(userId, now() - 2_000, 400, { repositoryId }),
      );
      await insertTokenUsage(
        ctx,
        usageRow(userId, now() - 1_000, 90, {
          repositoryId,
          keySource: "user",
        }),
      );
    });
    const asUser = t.withIdentity({ subject: `${userId}|session` });
    const fromTotals = {
      month: await asUser.query(api.tokenUsage.query.getCurrentMonthUsage, {}),
      repositories: await asUser.query(
        api.tokenUsage.query.getUsageByRepository,
        {},
      ),
    };
    await t.run(async (ctx) => {
      for (const totals of await ctx.db
        .query("tokenUsagePeriodTotals")
        .collect()) {
        await ctx.db.delete(totals._id);
      }
    });
    const fromRows = {
      month: await asUser.query(api.tokenUsage.query.getCurrentMonthUsage, {}),
      repositories: await asUser.query(
        api.tokenUsage.query.getUsageByRepository,
        {},
      ),
    };
    expect(fromTotals).toEqual(fromRows);
  });

  it("backfills the current period of existing users", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    await t.run(async (ctx) => {
      await ctx.db.insert("tokenUsage", usageRow(userId, now() - 5_000, 321));
    });
    await t.mutation(
      internal.tokenUsage.internalMutation.backfillUsagePeriodTotals,
      {},
    );
    await drainScheduledFunctions(t);
    expect((await readTotals(t, userId))?.gitdog.totalTokens).toBe(321);
  });
});
