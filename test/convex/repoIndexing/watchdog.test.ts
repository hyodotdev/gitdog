import { convexTest } from "convex-test";
import { mutationWithTime } from "../scheduling";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { v } from "convex/values";

import { internal } from "../../../convex/_generated/api";
import { internalAction } from "../../../convex/_generated/server";
import { INDEXING_STALE_THRESHOLD_MS } from "../../../convex/repoIndexing/readiness";
import { INDEX_WATCHDOG_MAX_RECOVERIES } from "../../../convex/repoIndexing/watchdog";
import schema from "../../../convex/schema";

const TEST_NOW = Date.parse("2026-07-19T00:00:00.000Z");

const noopIndexRepository = internalAction({
  args: {
    repositoryId: v.id("repositories"),
    expectedIndexVersion: v.number(),
    continuation: v.optional(v.boolean()),
    treeTraversal: v.optional(v.boolean()),
    treeSnapshotId: v.optional(v.id("repoTreeSnapshots")),
  },
  handler: async () => ({ success: true }),
});

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/repoIndexing/watchdog.ts": () =>
    import("../../../convex/repoIndexing/watchdog"),
  "../../../convex/repoIndexing/mutation.ts": () =>
    import("../../../convex/repoIndexing/mutation"),
  "../../../convex/ragV2/internalMutation.ts": () =>
    import("../../../convex/ragV2/internalMutation"),
  "../../../convex/ragV2/internalQuery.ts": () =>
    import("../../../convex/ragV2/internalQuery"),
  "../../../convex/repoIndexing/action.ts": async () => ({
    indexRepository: noopIndexRepository,
  }),
};

async function insertRepository(
  t: ReturnType<typeof convexTest>,
  fields: Record<string, unknown>,
) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const now = Date.now();
    await ctx.db.insert("githubInstallations", {
      userId,
      installationId: 808,
      ownerGithubAccountId: "verified-owner",
      ownershipVerifiedAt: now,
      accountLogin: "owner",
      accountType: "Organization",
      targetType: "Organization",
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.insert("repositories", {
      indexSyncPending: false,
      indexProgressAt: Date.now(),
      ragTotalChunks: 0,
      ragIndexedChunks: 0,
      ragFailedChunks: 0,
      userId,
      installationId: 808,
      githubRepositoryId: 1_808,
      githubRepo: "owner/watchdog-repo",
      githubRepoKey: "owner/watchdog-repo",
      name: "watchdog-repo",
      githubUrl: "https://github.com/owner/watchdog-repo",
      isActive: true,
      indexVersion: 1,
      indexStatus: "pending",
      ragStatus: "pending",
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
  vi.spyOn(Date, "now").mockReturnValue(TEST_NOW);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("indexing watchdog", () => {
  it("quarantines a numeric repository when its installation row disappeared", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, {
      indexVersion: 7,
      indexStatus: "indexing",
      ragStatus: "pending",
      indexProgressAt: TEST_NOW - INDEXING_STALE_THRESHOLD_MS,
      indexWatchdogToken: "7:1",
      indexWatchdogSequence: 1,
      indexWatchdogRetryCount: 0,
    });
    await t.run(async (ctx) => {
      const installation = await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) => q.eq("installationId", 808))
        .first();
      if (!installation) throw new Error("installation fixture missing");
      await ctx.db.delete(installation._id);
    });

    const recovery = await mutationWithTime(
      t,
      internal.repoIndexing.watchdog.recoverStalledIndex,
      { repositoryId, expectedIndexVersion: 7, watchdogToken: "7:1" },
    );
    expect(recovery.result).toEqual({ outcome: "failed" });
    expect(recovery.now).toBeGreaterThanOrEqual(TEST_NOW);

    const state = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.repository).toMatchObject({
      githubRepositoryId: 1_808,
      isActive: false,
      githubAccessRevokedAt: recovery.now,
      isActiveBeforeAccessRevocation: true,
      githubInstallationReconnectRequired: true,
      indexVersion: 8,
      indexStatus: "failed",
      indexError: expect.stringContaining("must be reconnected"),
      ragStatus: "failed",
      ragError: expect.stringContaining("must be reconnected"),
    });
    expect(state.repository?.indexWatchdogToken).toBeUndefined();
    expect(state.scheduled).toHaveLength(0);
  });

  it.each([
    ["suspended", { accessSuspendedAt: TEST_NOW }],
    [
      "reconciling",
      {
        repositoryRemovalPendingAt: TEST_NOW,
        repositoryAccessReconciliationEpoch: TEST_NOW + 1,
        repositoryAccessReconciliationNextPage: 1,
        repositoryAccessReconciliationExpectedSuspendedAt: null,
        repositoryAccessReconciliationPhase: "fetching" as const,
      },
    ],
  ])(
    "defers a stalled repository while its verified installation is %s",
    async (_state, installationPatch) => {
      const t = convexTest(schema, modules);
      const repositoryId = await insertRepository(t, {
        indexVersion: 9,
        indexStatus: "indexing",
        ragStatus: "pending",
        indexProgressAt: TEST_NOW - INDEXING_STALE_THRESHOLD_MS,
        indexWatchdogToken: "9:1",
        indexWatchdogSequence: 1,
        indexWatchdogRetryCount: 0,
      });
      await t.run(async (ctx) => {
        const installation = await ctx.db
          .query("githubInstallations")
          .withIndex("by_installation_id", (q) => q.eq("installationId", 808))
          .first();
        if (!installation) throw new Error("installation fixture missing");
        await ctx.db.patch(installation._id, installationPatch);
      });

      const recovery = await mutationWithTime(
        t,
        internal.repoIndexing.watchdog.recoverStalledIndex,
        { repositoryId, expectedIndexVersion: 9, watchdogToken: "9:1" },
      );
      expect(recovery.result).toEqual({ outcome: "deferred" });
      expect(recovery.now).toBeGreaterThanOrEqual(TEST_NOW);

      const state = await t.run(async (ctx) => ({
        repository: await ctx.db.get(repositoryId),
        scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
      }));
      expect(state.repository).toMatchObject({
        isActive: true,
        indexVersion: 9,
        indexStatus: "indexing",
        ragStatus: "pending",
        indexWatchdogToken: "9:2",
        indexWatchdogSequence: 2,
        indexProgressAt: recovery.now,
      });
      expect(
        state.repository?.githubInstallationReconnectRequired,
      ).toBeUndefined();
      expect(
        state.scheduled.filter(
          (scheduled) =>
            scheduled.name === "repoIndexing/watchdog:recoverStalledIndex",
        ),
      ).toHaveLength(1);
    },
  );

  it("terminates a stalled generation after access reconciliation fails", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, {
      indexVersion: 10,
      indexStatus: "indexing",
      ragStatus: "pending",
      indexProgressAt: TEST_NOW - INDEXING_STALE_THRESHOLD_MS,
      indexWatchdogToken: "10:1",
      indexWatchdogSequence: 1,
      indexWatchdogRetryCount: 0,
    });
    await t.run(async (ctx) => {
      const installation = await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) => q.eq("installationId", 808))
        .unique();
      if (!installation) throw new Error("installation fixture missing");
      await ctx.db.patch(installation._id, {
        repositoryAccessReconciliationFailure: "configuration",
        repositoryAccessReconciliationFailedAt: TEST_NOW,
      });
    });

    const recovery = await mutationWithTime(
      t,
      internal.repoIndexing.watchdog.recoverStalledIndex,
      { repositoryId, expectedIndexVersion: 10, watchdogToken: "10:1" },
    );
    expect(recovery.result).toEqual({ outcome: "failed" });
    expect(recovery.now).toBeGreaterThanOrEqual(TEST_NOW);

    const state = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.repository).toMatchObject({
      isActive: false,
      githubAccessRevokedAt: recovery.now,
      isActiveBeforeAccessRevocation: true,
      indexVersion: 11,
      indexStatus: "failed",
      indexError: expect.stringContaining("reconciliation failed"),
      ragStatus: "failed",
      ragError: expect.stringContaining("reconciliation failed"),
    });
    expect(
      state.repository?.githubInstallationReconnectRequired,
    ).toBeUndefined();
    expect(state.repository?.indexWatchdogToken).toBeUndefined();
    expect(
      state.scheduled.filter(
        (scheduled) =>
          scheduled.name === "repoIndexing/watchdog:recoverStalledIndex",
      ),
    ).toHaveLength(0);
  });

  it("terminates file-map cleanup after access reconciliation fails", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, {
      indexVersion: 11,
      indexStatus: "indexing",
      ragStatus: "pending",
      indexProgressAt: TEST_NOW,
      indexWatchdogToken: "11:1",
      indexWatchdogSequence: 1,
      indexWatchdogRetryCount: 0,
    });
    await t.run(async (ctx) => {
      const installation = await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) => q.eq("installationId", 808))
        .unique();
      if (!installation) throw new Error("installation fixture missing");
      await ctx.db.patch(installation._id, {
        repositoryAccessReconciliationFailure: "network",
        repositoryAccessReconciliationFailedAt: TEST_NOW,
      });
    });

    await expect(
      t.mutation(internal.repoIndexing.mutation.continueFileMapCleanup, {
        repositoryId,
        expectedIndexVersion: 11,
        totalFiles: 3,
      }),
    ).resolves.toEqual({
      accepted: false,
      deleted: 0,
      hasMore: false,
      completed: false,
    });

    const state = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.repository).toMatchObject({
      isActive: false,
      indexVersion: 12,
      indexStatus: "failed",
      indexError: expect.stringContaining("reconciliation failed"),
      ragStatus: "failed",
    });
    expect(
      state.scheduled.filter(
        (scheduled) =>
          scheduled.name === "repoIndexing/mutation:continueFileMapCleanup" ||
          scheduled.name === "repoIndexing/watchdog:recoverStalledIndex",
      ),
    ).toHaveLength(0);
  });

  it("restarts one stale file generation with a fresh CAS version", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const repositoryId = await insertRepository(t, {
      indexVersion: 7,
      indexStatus: "indexing",
      ragStatus: "pending",
      indexProgressAt: now - INDEXING_STALE_THRESHOLD_MS,
      indexWatchdogToken: "7:1",
      indexWatchdogSequence: 1,
      indexWatchdogRetryCount: 0,
    });

    await expect(
      t.mutation(internal.repoIndexing.watchdog.recoverStalledIndex, {
        repositoryId,
        expectedIndexVersion: 7,
        watchdogToken: "7:1",
      }),
    ).resolves.toEqual({
      outcome: "restarted",
      indexVersion: 8,
      retryCount: 1,
    });

    const state = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.repository).toMatchObject({
      indexVersion: 8,
      indexStatus: "pending",
      ragStatus: "pending",
      indexWatchdogToken: "8:2",
      indexWatchdogSequence: 2,
      indexWatchdogRetryCount: 1,
      indexProgressAt: now,
    });
    expect(
      state.scheduled.filter(
        (scheduled) => scheduled.name === "repoIndexing/action:indexRepository",
      ),
    ).toHaveLength(1);
    expect(
      state.scheduled.filter(
        (scheduled) =>
          scheduled.name === "repoIndexing/watchdog:recoverStalledIndex",
      ),
    ).toHaveLength(1);

    await expect(
      t.mutation(internal.repoIndexing.watchdog.recoverStalledIndex, {
        repositoryId,
        expectedIndexVersion: 7,
        watchdogToken: "7:1",
      }),
    ).resolves.toEqual({ outcome: "ignored" });
  });

  it("recovers a RAG action that disappears after claiming its checkpoint", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, {
      indexVersion: 4,
      indexStatus: "completed",
      ragStatus: "indexing",
      ragIndexPhase: "files",
      ragIndexFileOffset: 0,
      ragIndexChunkOffset: 0,
      ragContinuationToken: "claimed-unit",
      ragTotalChunks: 0,
      ragIndexedChunks: 0,
      ragFailedChunks: 0,
      ragProcessedFiles: 0,
    });

    await expect(
      t.mutation(internal.ragV2.internalMutation.claimRagContinuation, {
        repositoryId,
        expectedIndexVersion: 4,
        phase: "files",
        fileOffset: 0,
        chunkOffset: 0,
        continuationToken: "claimed-unit",
      }),
    ).resolves.toMatchObject({
      totalChunks: 0,
      successCount: 0,
      errorCount: 0,
      processedFiles: 0,
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, {
        indexProgressAt: TEST_NOW - INDEXING_STALE_THRESHOLD_MS,
      });
    });

    vi.advanceTimersToNextTimer();
    await t.finishInProgressScheduledFunctions();

    expect(
      await t.run(async (ctx) => await ctx.db.get(repositoryId)),
    ).toMatchObject({
      indexVersion: 5,
      indexStatus: "pending",
      ragStatus: "pending",
      indexWatchdogRetryCount: 1,
    });
    expect(
      (await t.run(async (ctx) => await ctx.db.get(repositoryId)))
        ?.ragContinuationToken,
    ).toBeUndefined();
  });

  it("resumes stale keyword-only RAG work without replacing its generation", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, {
      indexVersion: 4,
      indexStatus: "completed",
      ragStatus: "indexing",
      ragEmbeddingMode: "keyword_only",
      ragIndexPhase: "files",
      ragIndexCursor: "rag-page",
      ragIndexFileOffset: 3,
      ragIndexChunkOffset: 32,
      ragContinuationToken: undefined,
      ragTotalChunks: 800,
      ragIndexedChunks: 750,
      ragFailedChunks: 0,
      ragProcessedFiles: 169,
      indexProgressAt: TEST_NOW - INDEXING_STALE_THRESHOLD_MS,
      indexWatchdogToken: "4:1",
      indexWatchdogSequence: 1,
      indexWatchdogRetryCount: 0,
    });

    await expect(
      t.mutation(internal.repoIndexing.watchdog.recoverStalledIndex, {
        repositoryId,
        expectedIndexVersion: 4,
        watchdogToken: "4:1",
      }),
    ).resolves.toEqual({
      outcome: "resumed",
      indexVersion: 4,
      retryCount: 1,
    });

    const resumed = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(resumed.repository).toMatchObject({
      indexVersion: 4,
      indexStatus: "completed",
      ragStatus: "indexing",
      ragEmbeddingMode: "keyword_only",
      ragIndexPhase: "files",
      ragIndexCursor: "rag-page",
      ragIndexFileOffset: 3,
      ragIndexChunkOffset: 32,
      ragTotalChunks: 800,
      ragIndexedChunks: 750,
      ragFailedChunks: 0,
      ragProcessedFiles: 169,
      ragContinuationToken: expect.any(String),
      indexWatchdogRetryCount: 1,
      indexWatchdogToken: "4:2",
    });
    expect(
      resumed.scheduled.filter(
        (scheduled) =>
          scheduled.name === "ragV2/action:generateChunkEmbeddings" &&
          scheduled.state.kind === "pending",
      ),
    ).toHaveLength(1);
    expect(
      resumed.scheduled.some(
        (scheduled) =>
          scheduled.name === "repoIndexing/action:indexRepository" &&
          scheduled.state.kind === "pending",
      ),
    ).toBe(false);
  });

  it("re-dispatches a lost RAG kickoff without discarding the file generation", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, {
      indexVersion: 4,
      indexStatus: "completed",
      ragStatus: "pending",
      indexProgressAt: TEST_NOW - INDEXING_STALE_THRESHOLD_MS,
      indexWatchdogToken: "4:1",
      indexWatchdogSequence: 1,
      indexWatchdogRetryCount: 0,
    });

    await expect(
      t.mutation(internal.repoIndexing.watchdog.recoverStalledIndex, {
        repositoryId,
        expectedIndexVersion: 4,
        watchdogToken: "4:1",
      }),
    ).resolves.toEqual({
      outcome: "resumed",
      indexVersion: 4,
      retryCount: 1,
    });

    const resumed = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
      logs: await ctx.db
        .query("repoIndexingLogs")
        .withIndex("by_repository_and_version", (q) =>
          q.eq("repositoryId", repositoryId).eq("indexVersion", 4),
        )
        .collect(),
    }));
    expect(resumed.repository).toMatchObject({
      indexVersion: 4,
      indexStatus: "completed",
      ragStatus: "pending",
      indexWatchdogRetryCount: 1,
      indexWatchdogToken: "4:2",
      indexProgressAt: TEST_NOW,
    });
    const kickoffs = resumed.scheduled.filter(
      (scheduled) =>
        scheduled.name === "ragV2/action:generateChunkEmbeddings" &&
        scheduled.state.kind === "pending",
    );
    expect(kickoffs).toHaveLength(1);
    expect(kickoffs[0]?.args?.[0]).toMatchObject({
      repositoryId,
      indexVersion: 4,
    });
    expect(
      resumed.scheduled.some(
        (scheduled) =>
          scheduled.name === "repoIndexing/action:indexRepository" &&
          scheduled.state.kind === "pending",
      ),
    ).toBe(false);
    expect(
      resumed.logs.some(
        (log) =>
          log.level === "warning" &&
          log.message.includes("AI search indexing did not start in time"),
      ),
    ).toBe(true);
  });

  it("keeps an action-crash snapshot discoverable and cleans it on restart", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, {
      indexVersion: 9,
      indexStatus: "indexing",
      ragStatus: "pending",
      indexProgressAt: TEST_NOW,
    });
    const begun = await t.mutation(
      internal.repoIndexing.mutation.beginIndexTreeSnapshot,
      {
        repositoryId,
        expectedIndexVersion: 9,
        defaultBranch: "main",
        commitSha: "commit",
        treeSha: "tree",
        totalFiles: 41,
        totalPages: 2,
      },
    );
    const snapshotId = begun!.snapshotId;
    const attached = await t.run(async (ctx) => ctx.db.get(repositoryId));
    expect(attached?.indexTreeSnapshotId).toBe(snapshotId);
    expect(
      await t.run(async (ctx) => await ctx.db.get(snapshotId)),
    ).toMatchObject({ status: "building", nextPageIndex: 0 });

    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, {
        indexProgressAt: TEST_NOW - INDEXING_STALE_THRESHOLD_MS,
      });
    });
    await expect(
      t.mutation(internal.repoIndexing.watchdog.recoverStalledIndex, {
        repositoryId,
        expectedIndexVersion: 9,
        watchdogToken: attached!.indexWatchdogToken!,
      }),
    ).resolves.toMatchObject({ outcome: "restarted", indexVersion: 10 });

    const retired = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      manifest: await ctx.db.get(snapshotId),
    }));
    expect(retired.repository?.indexTreeSnapshotId).toBeUndefined();
    expect(retired.manifest?.status).toBe("deleting");

    await t.mutation(
      internal.repoIndexing.mutation.continueIndexTreeSnapshotCleanup,
      { snapshotId },
    );
    expect(await t.run(async (ctx) => await ctx.db.get(snapshotId))).toBeNull();
  });

  it("resumes a claimed subtree cursor without replacing its generation", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, {
      indexVersion: 11,
      indexStatus: "indexing",
      ragStatus: "pending",
      indexProgressAt: TEST_NOW,
    });
    const begun = await t.mutation(
      internal.repoIndexing.mutation.beginIndexTreeTraversal,
      {
        repositoryId,
        expectedIndexVersion: 11,
        defaultBranch: "main",
        commitSha: "pinned-commit",
        treeSha: "root-tree",
      },
    );
    const snapshotId = begun!.snapshotId;
    const firstClaim = await t.mutation(
      internal.repoIndexing.mutation.claimIndexTreeTraversal,
      {
        repositoryId,
        expectedIndexVersion: 11,
        snapshotId,
      },
    );
    const responseStorageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["durable subtree response"])),
    );
    await t.mutation(
      internal.repoIndexing.mutation.attachIndexTreeTraversalResponse,
      {
        repositoryId,
        expectedIndexVersion: 11,
        snapshotId,
        queueId: firstClaim!.queueId,
        claimToken: firstClaim!.claimToken,
        responseStorageId,
        totalItems: 200,
      },
    );
    await t.mutation(
      internal.repoIndexing.mutation.commitIndexTreeTraversalSlice,
      {
        repositoryId,
        expectedIndexVersion: 11,
        snapshotId,
        queueId: firstClaim!.queueId,
        claimToken: firstClaim!.claimToken,
        expectedItemOffset: 0,
        nextItemOffset: 128,
        complete: false,
        children: [],
        files: Array.from({ length: 128 }, (_, index) => ({
          path: `src/file-${index}.ts`,
          sha: `sha-${index}`,
          size: 10,
        })),
      },
    );
    const secondClaim = await t.mutation(
      internal.repoIndexing.mutation.claimIndexTreeTraversal,
      {
        repositoryId,
        expectedIndexVersion: 11,
        snapshotId,
      },
    );
    expect(secondClaim).toMatchObject({
      queueId: firstClaim!.queueId,
      itemOffset: 128,
      responseStorageId,
    });

    const claimedRepository = await t.run(async (ctx) =>
      ctx.db.get(repositoryId),
    );
    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, {
        indexProgressAt: TEST_NOW - INDEXING_STALE_THRESHOLD_MS,
      });
    });
    await expect(
      t.mutation(internal.repoIndexing.watchdog.recoverStalledIndex, {
        repositoryId,
        expectedIndexVersion: 11,
        watchdogToken: claimedRepository!.indexWatchdogToken!,
      }),
    ).resolves.toEqual({
      outcome: "resumed",
      indexVersion: 11,
      retryCount: 1,
    });

    const resumed = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      manifest: await ctx.db.get(snapshotId),
      queue: await ctx.db.get(firstClaim!.queueId),
      responseUrl: await ctx.storage.getUrl(responseStorageId),
    }));
    expect(resumed.repository).toMatchObject({
      indexVersion: 11,
      indexStatus: "indexing",
      indexTreeSnapshotId: snapshotId,
      indexWatchdogRetryCount: 1,
    });
    expect(resumed.manifest).toMatchObject({
      status: "building",
      traversalState: "traversing",
      nextPageIndex: 3,
      totalFiles: 128,
    });
    expect(resumed.manifest?.traversalPendingFiles).toHaveLength(8);
    expect(resumed.manifest?.traversalPendingFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/file-120.ts" }),
      ]),
    );
    expect(resumed.manifest?.traversalClaimToken).toBeUndefined();
    expect(resumed.queue).toMatchObject({
      itemOffset: 128,
      responseStorageId,
    });
    expect(resumed.responseUrl).not.toBeNull();
  });

  it("marks a stalled RAG generation failed after the retry cap", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const repositoryId = await insertRepository(t, {
      indexVersion: 12,
      indexStatus: "completed",
      ragStatus: "indexing",
      ragIndexPhase: "cleanup",
      ragIndexFileOffset: 0,
      ragIndexChunkOffset: 0,
      indexProgressAt: now - INDEXING_STALE_THRESHOLD_MS,
      indexWatchdogToken: "12:9",
      indexWatchdogSequence: 9,
      indexWatchdogRetryCount: INDEX_WATCHDOG_MAX_RECOVERIES,
    });

    await expect(
      t.mutation(internal.repoIndexing.watchdog.recoverStalledIndex, {
        repositoryId,
        expectedIndexVersion: 12,
        watchdogToken: "12:9",
      }),
    ).resolves.toEqual({ outcome: "failed" });

    const repository = await t.run(async (ctx) => ctx.db.get(repositoryId));
    expect(repository).toMatchObject({
      indexVersion: 12,
      indexStatus: "completed",
      ragStatus: "failed",
      ragError: expect.stringContaining("automatic recovery attempts"),
    });
    expect(repository?.indexWatchdogToken).toBeUndefined();
    expect(repository?.indexWatchdogScheduleId).toBeUndefined();
  });

  it("cancels and clears the lease when RAG reaches a terminal state", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, {
      indexVersion: 6,
      indexStatus: "completed",
      ragStatus: "pending",
    });

    await expect(
      t.mutation(internal.ragV2.internalMutation.claimRagGeneration, {
        repositoryId,
        expectedIndexVersion: 6,
      }),
    ).resolves.toBe(true);
    await t.mutation(internal.ragV2.internalMutation.updateRagStatus, {
      repositoryId,
      status: "completed",
      expectedIndexVersion: 6,
      expectedCurrentStatus: "indexing",
    });

    const state = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.repository).toMatchObject({
      ragStatus: "completed",
    });
    expect(state.repository?.indexWatchdogToken).toBeUndefined();
    expect(state.repository?.indexWatchdogScheduleId).toBeUndefined();
    expect(state.scheduled).toHaveLength(1);
    expect(state.scheduled[0]?.name).toBe(
      "repoIndexing/watchdog:recoverStalledIndex",
    );
    expect(state.scheduled[0]?.state.kind).toBe("canceled");
  });
});
