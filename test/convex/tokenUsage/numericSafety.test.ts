import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "../../../convex/_generated/api";
import { MAX_COLLECT_LIMIT } from "../../../convex/_utils/pagination";
import schema from "../../../convex/schema";
import { calculateSafeBillingCosts } from "../../../convex/subscriptions/query";
import { readQuotaTokenUsage } from "../../../convex/tokenUsage/quota";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/tokenUsage/internalMutation.ts": () =>
    import("../../../convex/tokenUsage/internalMutation"),
  "../../../convex/tokenUsage/query.ts": () =>
    import("../../../convex/tokenUsage/query"),
};

async function insertUserAndRepository(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const now = Date.now();
    const repositoryId = await ctx.db.insert("repositories", {
      indexSyncPending: false,
      userId,
      installationId: 101,
      githubRepositoryId: 101,
      githubRepo: "owner/repo",
      githubRepoKey: "owner/repo",
      name: "repo",
      githubUrl: "https://github.com/owner/repo",
      isActive: true,
      indexVersion: 1,
      indexStatus: "completed",
      indexProgressAt: now,
      ragStatus: "completed",
      ragTotalChunks: 0,
      ragIndexedChunks: 0,
      ragFailedChunks: 0,
      settings: {
        issueAssistantEnabled: true,
        autoFormatIssue: true,
        autoAnswerQuestions: true,
        tagMaintainersForCodeChanges: true,
        requireApproval: false,
        discussionAssistantEnabled: true,
        autoFormatDiscussion: true,
        autoAnswerDiscussionQuestions: true,
        tagMaintainersForDiscussionCodeChanges: true,
        requireApprovalForDiscussions: false,
      },
      monthlyActions: 0,
      lastResetAt: now,
      createdAt: now,
      updatedAt: now,
    });
    return { userId, repositoryId };
  });
}

describe("token usage numeric safety", () => {
  it("calculates proportional billing without an unsafe intermediate", () => {
    const maximum = Number.MAX_SAFE_INTEGER;
    expect(calculateSafeBillingCosts(maximum, maximum - 1, maximum, 0)).toEqual(
      {
        overageCostCents: maximum - 1,
        totalCostCents: maximum - 1,
      },
    );
  });

  it("rejects a final billing total outside the safe integer range", () => {
    const maximum = Number.MAX_SAFE_INTEGER;
    expect(() =>
      calculateSafeBillingCosts(maximum, maximum, maximum, 1),
    ).toThrow(
      "Usage data is too large or contains unsupported values. Please contact support.",
    );
  });

  it("fails closed after one bounded quota read", async () => {
    const takeLimits: number[] = [];
    const ctx = {
      db: {
        query: () => ({
          withIndex: () => ({
            first: async () => null,
            take: async (limit: number) => {
              takeLimits.push(limit);
              return Array.from({ length: limit }, () => ({}));
            },
          }),
        }),
      },
    };

    await expect(
      readQuotaTokenUsage(ctx as never, {
        userId: "user" as never,
        periodStart: 0,
      }),
    ).resolves.toEqual({
      verified: false,
      reason: "usage_history_too_large",
    });
    expect(takeLimits).toEqual([MAX_COLLECT_LIMIT + 1]);
  });

  it("rejects invalid provider token counts before writing usage", async () => {
    const invalidCounts = [
      {
        inputTokens: -1,
        outputTokens: 0,
        message: "Input token count must be a non-negative safe integer",
      },
      {
        inputTokens: 1.5,
        outputTokens: 0,
        message: "Input token count must be a non-negative safe integer",
      },
      {
        inputTokens: 0,
        outputTokens: Number.MAX_SAFE_INTEGER + 1,
        message: "Output token count must be a non-negative safe integer",
      },
      {
        inputTokens: Number.MAX_SAFE_INTEGER,
        outputTokens: 1,
        message: "Total token count exceeds the supported range",
      },
    ];

    for (const invalid of invalidCounts) {
      const t = convexTest(schema, modules);
      const { userId } = await insertUserAndRepository(t);
      await expect(
        t.mutation(internal.tokenUsage.internalMutation.recordUsage, {
          userId,
          inputTokens: invalid.inputTokens,
          outputTokens: invalid.outputTokens,
          model: "claude-sonnet-5-5",
          provider: "anthropic",
        }),
      ).rejects.toThrow(invalid.message);
      await expect(
        t.run(async (ctx) => await ctx.db.query("tokenUsage").take(1)),
      ).resolves.toEqual([]);
    }
  });

  it("fails current and repository token aggregates on integer overflow", async () => {
    const t = convexTest(schema, modules);
    const { userId, repositoryId } = await insertUserAndRepository(t);
    await t.run(async (ctx) => {
      for (const tokens of [Number.MAX_SAFE_INTEGER, 1]) {
        await ctx.db.insert("tokenUsage", {
          userId,
          repositoryId,
          usageType: "chat",
          inputTokens: tokens,
          outputTokens: 0,
          totalTokens: tokens,
          inputCostCents: 0,
          outputCostCents: 0,
          baseCostCents: 0,
          serviceFeeCents: 0,
          totalCostCents: 0,
          purchasedTokensDebited: 0,
          model: "claude-sonnet-5-5",
          provider: "anthropic",
          serviceFeeRate: 0.25,
          createdAt: Date.now(),
        });
      }
    });
    const authenticated = t.withIdentity({ subject: `${userId}|session` });

    await expect(
      authenticated.query(api.tokenUsage.query.getCurrentMonthUsage, {}),
    ).rejects.toThrow("Usage data contains values outside the supported range");
    await expect(
      authenticated.query(api.tokenUsage.query.getUsageByRepository, {}),
    ).rejects.toThrow("Usage data contains values outside the supported range");
  });

  it("fails current and repository cost aggregates on non-finite values", async () => {
    const t = convexTest(schema, modules);
    const { userId, repositoryId } = await insertUserAndRepository(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("tokenUsage", {
        userId,
        repositoryId,
        usageType: "chat",
        inputTokens: 1,
        outputTokens: 0,
        totalTokens: 1,
        inputCostCents: Number.POSITIVE_INFINITY,
        outputCostCents: 0,
        baseCostCents: Number.POSITIVE_INFINITY,
        serviceFeeCents: 0,
        totalCostCents: Number.POSITIVE_INFINITY,
        purchasedTokensDebited: 0,
        model: "claude-sonnet-5-5",
        provider: "anthropic",
        serviceFeeRate: 0.25,
        createdAt: Date.now(),
      });
    });
    const authenticated = t.withIdentity({ subject: `${userId}|session` });

    await expect(
      authenticated.query(api.tokenUsage.query.getCurrentMonthUsage, {}),
    ).rejects.toThrow("Usage data contains values outside the supported range");
    await expect(
      authenticated.query(api.tokenUsage.query.getUsageByRepository, {}),
    ).rejects.toThrow("Usage data contains values outside the supported range");
  });
});
