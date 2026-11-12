import { convexTest } from "convex-test";
import { mutationWithTime } from "../scheduling";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { v } from "convex/values";

import { internal } from "../../../convex/_generated/api";
import { internalAction } from "../../../convex/_generated/server";
import { INDEXING_STALE_THRESHOLD_MS } from "../../../convex/repoIndexing/readiness";
import schema from "../../../convex/schema";

const TEST_NOW = Date.parse("2026-07-19T03:00:00.000Z");
let dateNowSpy: ReturnType<typeof vi.spyOn>;
let nextInstallationId: number;

const noopIndexRepository = internalAction({
  args: {
    repositoryId: v.id("repositories"),
    expectedIndexVersion: v.number(),
  },
  handler: async () => ({ success: true }),
});

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/repoIndexing/internalAction.ts": () =>
    import("../../../convex/repoIndexing/internalAction"),
  "../../../convex/repoIndexing/internalQuery.ts": () =>
    import("../../../convex/repoIndexing/internalQuery"),
  "../../../convex/repoIndexing/mutation.ts": () =>
    import("../../../convex/repoIndexing/mutation"),
  "../../../convex/repoIndexing/watchdog.ts": () =>
    import("../../../convex/repoIndexing/watchdog"),
  "../../../convex/repositories/internalMutation.ts": () =>
    import("../../../convex/repositories/internalMutation"),
  "../../../convex/repoIndexing/action.ts": async () => ({
    indexRepository: noopIndexRepository,
  }),
};

async function insertRepository(
  t: ReturnType<typeof convexTest>,
  name: string,
  fields: Record<string, unknown> = {},
) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const now = Date.now();
    const installationId =
      typeof fields.installationId === "number"
        ? fields.installationId
        : nextInstallationId++;
    await ctx.db.insert("githubInstallations", {
      userId,
      installationId,
      ownerGithubAccountId: `verified-owner-${installationId}`,
      ownershipVerifiedAt: now,
      accountLogin: "owner",
      accountType: "Organization",
      targetType: "Organization",
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.insert("repositories", {
      indexSyncPending: false,
      indexVersion: 1,
      indexStatus: "pending",
      indexProgressAt: Date.now(),
      ragStatus: "pending",
      ragTotalChunks: 0,
      ragIndexedChunks: 0,
      ragFailedChunks: 0,
      userId,
      installationId,
      githubRepositoryId: installationId + 1_000,
      githubRepo: `owner/${name}`,
      githubRepoKey: `owner/${name}`,
      name,
      githubUrl: `https://github.com/owner/${name}`,
      isActive: true,
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
      lastResetAt: now,
      createdAt: now,
      updatedAt: now,
      ...fields,
    });
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  nextInstallationId = 909;
  dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(TEST_NOW);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("repository watchdog enrollment", () => {
  it("keeps the enrolled progress anchor when unrelated metadata is updated", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, "metadata-write", {
      githubRepositoryId: 1_910,
    });

    await t.action(
      internal.repoIndexing.internalAction.recoverStaleRepositoryIndexes,
      { pageSize: 10 },
    );

    const staleNow = TEST_NOW + INDEXING_STALE_THRESHOLD_MS;
    dateNowSpy.mockReturnValue(staleNow);
    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, { updatedAt: staleNow });
    });

    await expect(
      t.action(
        internal.repoIndexing.internalAction.recoverStaleRepositoryIndexes,
        { pageSize: 10 },
      ),
    ).resolves.toMatchObject({ recovered: 1, skipped: 0, failed: 0 });

    expect(
      await t.run(async (ctx) => await ctx.db.get(repositoryId)),
    ).toMatchObject({
      indexVersion: 2,
      indexStatus: "pending",
      indexProgressAt: staleNow,
      indexWatchdogToken: "2:2",
    });
  });

  it("ignores a stale recovery observation after a live heartbeat wins the CAS", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const repositoryId = await insertRepository(t, "live-race", {
      githubRepositoryId: 1_911,
      indexVersion: 3,
      indexStatus: "indexing",
      ragStatus: "pending",
      indexProgressAt: now - INDEXING_STALE_THRESHOLD_MS,
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, {
        indexWatchdogToken: "3:7",
        indexWatchdogSequence: 7,
      });
    });

    const heartbeat = await mutationWithTime(
      t,
      internal.repoIndexing.mutation.touchIndexingProgress,
      { repositoryId, expectedIndexVersion: 3 },
    );
    expect(heartbeat.result).toBe(true);
    expect(heartbeat.now).toBeGreaterThanOrEqual(now);
    await expect(
      t.mutation(internal.repoIndexing.watchdog.recoverStalledIndex, {
        repositoryId,
        expectedIndexVersion: 3,
        watchdogToken: "3:7",
      }),
    ).resolves.toEqual({ outcome: "ignored" });

    expect(
      await t.run(async (ctx) => await ctx.db.get(repositoryId)),
    ).toMatchObject({
      indexVersion: 3,
      indexStatus: "indexing",
      indexWatchdogToken: "3:8",
      indexProgressAt: heartbeat.now,
    });
  });

  it("continues the active-repository scan with a bounded cursor page", async () => {
    const t = convexTest(schema, modules);
    const staleAt = Date.now() - INDEXING_STALE_THRESHOLD_MS;
    const repositoryIds = await Promise.all(
      ["page-one-a", "page-one-b", "page-two"].map((name, index) =>
        insertRepository(t, name, {
          githubRepositoryId: 2_000 + index,
          updatedAt: staleAt,
        }),
      ),
    );

    const firstPage = await t.action(
      internal.repoIndexing.internalAction.recoverStaleRepositoryIndexes,
      { pageSize: 2 },
    );
    expect(firstPage).toMatchObject({
      scanned: 2,
      recovered: 2,
      failed: 0,
      hasMore: true,
    });
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const scheduledContinuation = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (scheduled) =>
          scheduled.name ===
          "repoIndexing/internalAction:recoverStaleRepositoryIndexes",
      ),
    );
    expect(scheduledContinuation).toHaveLength(1);

    const secondPage = await t.action(
      internal.repoIndexing.internalAction.recoverStaleRepositoryIndexes,
      { cursor: firstPage.nextCursor, pageSize: 2 },
    );
    expect(secondPage).toEqual({
      scanned: 1,
      recovered: 1,
      skipped: 0,
      failed: 0,
      hasMore: false,
      nextCursor: null,
    });

    const repositories = await t.run(async (ctx) =>
      Promise.all(
        repositoryIds.map((repositoryId) => ctx.db.get(repositoryId)),
      ),
    );
    expect(repositories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          indexVersion: 1,
          indexWatchdogToken: "1:1",
        }),
        expect.objectContaining({
          indexVersion: 1,
          indexWatchdogToken: "1:1",
        }),
        expect.objectContaining({
          indexVersion: 1,
          indexWatchdogToken: "1:1",
        }),
      ]),
    );
  });
});
