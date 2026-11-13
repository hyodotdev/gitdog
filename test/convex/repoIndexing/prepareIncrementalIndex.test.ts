import { convexTest } from "convex-test";
import { drainScheduledFunctions, mutationWithTime } from "../scheduling";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  internalAction,
  internalMutation,
} from "../../../convex/_generated/server";
import { REFERENCED_BLOB_RECHECK_MS } from "../../../convex/repoIndexing/mutation";
import schema from "../../../convex/schema";
import { assertMapFilePublished } from "../../../convex/repoIndexing/action";
import { INDEXING_STALE_THRESHOLD_MS } from "../../../convex/repoIndexing/readiness";
import { v } from "convex/values";

const originalAppId = process.env.GITHUB_APP_ID;
const originalPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY;

type BlobPublicationFixture = {
  repositoryId: Id<"repositories">;
  userId: Id<"users">;
  installationId: number;
  githubRepositoryId: number;
  githubRepo: string;
  indexVersion: number;
};

async function insertBlobPublicationFixture(
  t: ReturnType<typeof convexTest>,
): Promise<BlobPublicationFixture> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", {});
    const installationId = 7_701;
    const githubRepositoryId = 8_701;
    const githubRepo = "owner/blob-publication";
    const indexVersion = 4;
    await ctx.db.insert("githubInstallations", {
      userId,
      installationId,
      ownerGithubAccountId: "blob-owner",
      ownershipVerifiedAt: now,
      accountLogin: "owner",
      accountType: "Organization",
      targetType: "Organization",
      createdAt: now,
      updatedAt: now,
    });
    const repositoryId = await ctx.db.insert("repositories", {
      indexSyncPending: false,
      indexProgressAt: Date.now(),
      ragTotalChunks: 0,
      ragIndexedChunks: 0,
      ragFailedChunks: 0,
      userId,
      installationId,
      githubRepositoryId,
      githubRepo,
      githubRepoKey: githubRepo,
      name: "blob-publication",
      githubUrl: `https://github.com/${githubRepo}`,
      isActive: true,
      indexVersion,
      indexStatus: "indexing",
      indexIdentityVerifiedVersion: indexVersion,
      indexIdentityVerifiedInstallationId: installationId,
      indexIdentityVerifiedGithubRepositoryId: githubRepositoryId,
      indexIdentityVerifiedGithubRepo: githubRepo,
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
    });
    return {
      repositoryId,
      userId,
      installationId,
      githubRepositoryId,
      githubRepo,
      indexVersion,
    };
  });
}

function blobPublicationArgs(
  fixture: BlobPublicationFixture,
  filePath: string,
  sha256: string,
  size: number,
) {
  return {
    repositoryId: fixture.repositoryId,
    expectedUserId: fixture.userId,
    expectedInstallationId: fixture.installationId,
    expectedGithubRepositoryId: fixture.githubRepositoryId,
    expectedGithubRepo: fixture.githubRepo,
    expectedIndexVersion: fixture.indexVersion,
    filePath,
    sha256,
    size,
    isText: true,
    language: "typescript",
  };
}

const noopIndexRepository = internalAction({
  args: {
    repositoryId: v.id("repositories"),
    expectedIndexVersion: v.number(),
  },
  handler: async (ctx, args) => {
    const started = await ctx.runMutation(
      internal.repoIndexing.mutation.updateIndexingStatus,
      {
        repositoryId: args.repositoryId,
        expectedIndexVersion: args.expectedIndexVersion,
        status: "indexing",
      },
    );
    if (started) {
      await ctx.runMutation(
        internal.repoIndexing.mutation.updateIndexingStatus,
        {
          repositoryId: args.repositoryId,
          expectedIndexVersion: args.expectedIndexVersion,
          status: "completed",
        },
      );
    }
    return { success: true };
  },
});

const noopGenerateChunkEmbeddings = internalAction({
  args: {
    repositoryId: v.id("repositories"),
    indexVersion: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const repository = await ctx.runQuery(
      internal.repositories.internalQuery.getById,
      { repositoryId: args.repositoryId },
    );
    const indexVersion = args.indexVersion ?? repository?.indexVersion ?? 0;
    const claimed = await ctx.runMutation(
      internal.ragV2.internalMutation.claimRagGeneration,
      {
        repositoryId: args.repositoryId,
        expectedIndexVersion: indexVersion,
      },
    );
    if (claimed) {
      await ctx.runMutation(internal.ragV2.internalMutation.updateRagStatus, {
        repositoryId: args.repositoryId,
        expectedIndexVersion: indexVersion,
        expectedCurrentStatus: "indexing",
        status: "completed",
      });
    }
    return {
      success: true,
      totalChunks: 0,
      successCount: 0,
      errorCount: 0,
    };
  },
});

const noopCreateAiLog = internalMutation({
  args: {
    repositoryId: v.optional(v.id("repositories")),
    userId: v.optional(v.id("users")),
    workflowType: v.string(),
    actionType: v.string(),
    githubRepo: v.optional(v.string()),
    status: v.string(),
  },
  handler: async () => undefined,
});

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/repoIndexing/mutation.ts": () =>
    import("../../../convex/repoIndexing/mutation"),
  "../../../convex/repoIndexing/internalQuery.ts": () =>
    import("../../../convex/repoIndexing/internalQuery"),
  "../../../convex/repoIndexing/internalAction.ts": () =>
    import("../../../convex/repoIndexing/internalAction"),
  "../../../convex/repoIndexing/watchdog.ts": () =>
    import("../../../convex/repoIndexing/watchdog"),
  "../../../convex/ragV2/internalMutation.ts": () =>
    import("../../../convex/ragV2/internalMutation"),
  "../../../convex/repositories/internalQuery.ts": () =>
    import("../../../convex/repositories/internalQuery"),
  "../../../convex/repositories/internalMutation.ts": () =>
    import("../../../convex/repositories/internalMutation"),
  "../../../convex/github/internalQuery.ts": () =>
    import("../../../convex/github/internalQuery"),
  "../../../convex/github/internalMutation.ts": () =>
    import("../../../convex/github/internalMutation"),
  "../../../convex/github/action.ts": () =>
    import("../../../convex/github/action"),
  "../../../convex/ragV2/action.ts": async () => ({
    generateChunkEmbeddings: noopGenerateChunkEmbeddings,
  }),
  "../../../convex/repoIndexing/action.ts": async () => ({
    indexRepository: noopIndexRepository,
  }),
  "../../../convex/admin/internalMutation.ts": async () => ({
    createAiLog: noopCreateAiLog,
  }),
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  if (originalAppId === undefined) delete process.env.GITHUB_APP_ID;
  else process.env.GITHUB_APP_ID = originalAppId;
  if (originalPrivateKey === undefined)
    delete process.env.GITHUB_APP_PRIVATE_KEY;
  else process.env.GITHUB_APP_PRIVATE_KEY = originalPrivateKey;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("prepareIncrementalIndex", () => {
  it("clears a restored-access retry marker in the same reservation transaction", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 98,
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
        installationId: 98,
        githubRepositoryId: 198,
        githubRepo: "owner/restored-repo",
        githubRepoKey: "owner/restored-repo",
        name: "restored-repo",
        githubUrl: "https://github.com/owner/restored-repo",
        isActive: true,
        githubAccessRestoreIndexPending: true,
        githubAccessRestoreIndexNextAttemptAt: now,
        githubAccessRestoreIndexRetryCount: 2,
        indexVersion: 2,
        indexStatus: "completed",
        ragStatus: "completed",
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
      });
    });

    const result = await t.mutation(
      internal.repoIndexing.mutation.prepareIncrementalIndex,
      {
        repositoryId,
        clearAccessRestorePending: true,
        queueIfBusy: false,
      },
    );
    const repository = await t.run(async (ctx) => ctx.db.get(repositoryId));

    expect(result).toMatchObject({ success: true, newVersion: 3 });
    expect(repository?.githubAccessRestoreIndexPending).toBeUndefined();
    expect(repository?.githubAccessRestoreIndexNextAttemptAt).toBeUndefined();
    expect(repository?.githubAccessRestoreIndexRetryCount).toBeUndefined();
    expect(repository?.indexStatus).toBe("pending");
  });

  it("persists a failed restore retry and lets the watchdog clear it after recovery", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 97,
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
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        userId,
        installationId: 97,
        githubRepositoryId: 197,
        githubRepo: "owner/retry-restored-repo",
        githubRepoKey: "owner/retry-restored-repo",
        name: "retry-restored-repo",
        githubUrl: "https://github.com/owner/retry-restored-repo",
        isActive: true,
        githubAccessRestoreIndexPending: true,
        githubAccessRestoreIndexNextAttemptAt: now,
        githubAccessRestoreIndexRetryCount: 0,
        indexVersion: 2,
        indexStatus: "indexing",
        indexProgressAt: now,
        ragStatus: "completed",
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
      });
    });

    await t.action(internal.github.action.prepareRestoredRepositoryIndex, {
      repositoryId,
    });
    const deferredRepository = await t.run(async (ctx) =>
      ctx.db.get(repositoryId),
    );

    expect(deferredRepository).toMatchObject({
      githubAccessRestoreIndexPending: true,
      githubAccessRestoreIndexRetryCount: 1,
      indexStatus: "indexing",
    });
    expect(deferredRepository?.githubAccessRestoreIndexNextAttemptAt).toEqual(
      expect.any(Number),
    );
    expect(
      deferredRepository!.githubAccessRestoreIndexNextAttemptAt!,
    ).toBeGreaterThan(Date.now());

    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, {
        indexStatus: "completed",
        ragStatus: "completed",
        githubAccessRestoreIndexNextAttemptAt: Date.now() - 1,
      });
    });
    await t.action(
      internal.github.action.recoverPendingAccessRestoreIndexes,
      {},
    );
    const recoveredRepository = await t.run(async (ctx) =>
      ctx.db.get(repositoryId),
    );

    expect(recoveredRepository).toMatchObject({
      indexVersion: 3,
      indexStatus: "pending",
    });
    expect(
      recoveredRepository?.githubAccessRestoreIndexPending,
    ).toBeUndefined();
    expect(
      recoveredRepository?.githubAccessRestoreIndexNextAttemptAt,
    ).toBeUndefined();
    expect(
      recoveredRepository?.githubAccessRestoreIndexRetryCount,
    ).toBeUndefined();
  });

  it("guards file writes by generation and schedules RAG atomically", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const repositoryId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 99,
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
        installationId: 99,
        githubRepositoryId: 199,
        githubRepo: "owner/index-repo",
        githubRepoKey: "owner/index-repo",
        name: "index-repo",
        githubUrl: "https://github.com/owner/index-repo",
        isActive: true,
        indexVersion: 2,
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
      });
    });

    // Without an explicit version, only the repository's current pending
    // generation can be claimed.
    expect(
      await t.mutation(internal.repoIndexing.mutation.updateIndexingStatus, {
        repositoryId,
        status: "indexing",
      }),
    ).toBe(true);

    await expect(
      t.mutation(internal.repoIndexing.mutation.mapFile, {
        repositoryId,
        filePath: "stale.ts",
        sha256: "old",
        size: 1,
        isText: true,
        indexVersion: 1,
      }),
    ).rejects.toThrow("stale repository indexing generation");

    expect(
      await t.mutation(internal.repoIndexing.mutation.updateIndexingStatus, {
        repositoryId,
        status: "completed",
        expectedIndexVersion: 1,
      }),
    ).toBe(false);
    expect(
      await t.mutation(internal.repoIndexing.mutation.updateIndexingStatus, {
        repositoryId,
        status: "completed",
        expectedIndexVersion: 2,
      }),
    ).toBe(true);

    const state = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.repository).toMatchObject({
      indexStatus: "completed",
      ragStatus: "pending",
      indexVersion: 2,
    });
    expect(
      state.scheduled.filter(
        (scheduled) =>
          scheduled.name === "ragV2/action:generateChunkEmbeddings",
      ),
    ).toHaveLength(1);
    await drainScheduledFunctions(t);
  });

  it("allows only one action to claim a pending RAG generation", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const repositoryId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 100,
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
        installationId: 100,
        githubRepositoryId: 200,
        githubRepo: "owner/rag-repo",
        githubRepoKey: "owner/rag-repo",
        name: "rag-repo",
        githubUrl: "https://github.com/owner/rag-repo",
        isActive: true,
        indexVersion: 9,
        indexStatus: "completed",
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
      });
    });

    const first = await t.mutation(
      internal.ragV2.internalMutation.claimRagGeneration,
      { repositoryId, expectedIndexVersion: 9 },
    );
    const second = await t.mutation(
      internal.ragV2.internalMutation.claimRagGeneration,
      { repositoryId, expectedIndexVersion: 9 },
    );

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("selects by installation and repository and coalesces a busy retry", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { firstRepositoryId, targetRepositoryId } = await t.run(
      async (ctx) => {
        const userId = await ctx.db.insert("users", {});
        const now = Date.now();
        await ctx.db.insert("githubInstallations", {
          userId,
          installationId: 202,
          ownerGithubAccountId: "verified-owner",
          ownershipVerifiedAt: now,
          accountLogin: "owner",
          accountType: "Organization",
          targetType: "Organization",
          createdAt: now,
          updatedAt: now,
        });
        const repository = {
          userId,
          githubRepo: "owner/repo",
          githubRepoKey: "owner/repo",
          name: "repo",
          githubUrl: "https://github.com/owner/repo",
          isActive: true,
          indexVersion: 3,
          indexStatus: "completed" as const,
          ragStatus: "completed" as const,
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
        };
        const firstRepositoryId = await ctx.db.insert("repositories", {
          indexSyncPending: false,
          indexVersion: 1,
          indexStatus: "completed",
          indexProgressAt: Date.now(),
          ragStatus: "completed",
          ragTotalChunks: 0,
          ragIndexedChunks: 0,
          ragFailedChunks: 0,
          ...repository,
          installationId: 101,
          githubRepositoryId: 1_101,
        });
        const targetRepositoryId = await ctx.db.insert("repositories", {
          indexSyncPending: false,
          indexVersion: 1,
          indexStatus: "completed",
          indexProgressAt: Date.now(),
          ragStatus: "completed",
          ragTotalChunks: 0,
          ragIndexedChunks: 0,
          ragFailedChunks: 0,
          ...repository,
          installationId: 202,
          githubRepositoryId: 1_202,
        });
        return { firstRepositoryId, targetRepositoryId };
      },
    );

    const firstAttempt = await t.mutation(
      internal.repoIndexing.mutation.prepareIncrementalIndex,
      {
        installationId: 202,
        githubRepositoryId: 1_202,
      },
    );
    const busyAttempt = await t.mutation(
      internal.repoIndexing.mutation.prepareIncrementalIndex,
      {
        installationId: 202,
        githubRepositoryId: 1_202,
      },
    );

    expect(firstAttempt).toMatchObject({
      success: true,
      repositoryId: targetRepositoryId,
      newVersion: 4,
    });
    expect(busyAttempt).toMatchObject({ success: false, queued: true });

    const state = await t.run(async (ctx) => ({
      firstRepository: await ctx.db.get(firstRepositoryId),
      targetRepository: await ctx.db.get(targetRepositoryId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.firstRepository?.indexStatus).toBe("completed");
    expect(state.firstRepository?.indexVersion).toBe(3);
    expect(state.targetRepository).toMatchObject({
      indexStatus: "pending",
      ragStatus: "pending",
      indexVersion: 4,
      indexSyncPending: true,
    });
    expect(
      state.scheduled.filter(
        (scheduled) => scheduled.name === "repoIndexing/action:indexRepository",
      ),
    ).toHaveLength(1);

    await t.run(async (ctx) => {
      await ctx.db.patch(targetRepositoryId, {
        indexStatus: "completed",
        ragStatus: "indexing",
      });
    });
    await t.mutation(internal.ragV2.internalMutation.updateRagStatus, {
      repositoryId: targetRepositoryId,
      status: "completed",
      expectedIndexVersion: 4,
      totalChunks: 10,
      indexedChunks: 10,
      failedChunks: 0,
    });
    const queuedAttempt = await t.run(async (ctx) =>
      ctx.db.get(targetRepositoryId),
    );
    expect(queuedAttempt).toMatchObject({ indexVersion: 5 });

    const coalescedState = await t.run(async (ctx) => ({
      repository: await ctx.db.get(targetRepositoryId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(coalescedState.repository).toMatchObject({
      indexStatus: "pending",
      ragStatus: "pending",
      indexVersion: 5,
      indexSyncPending: false,
    });
    expect(
      coalescedState.scheduled.filter(
        (scheduled) => scheduled.name === "repoIndexing/action:indexRepository",
      ),
    ).toHaveLength(2);
    await drainScheduledFunctions(t);
  });

  it("indexes the active row after an earlier revoked immutable-ID duplicate", async () => {
    const t = convexTest(schema, modules);
    const activeRepositoryId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 249,
        ownerGithubAccountId: "verified-owner",
        ownershipVerifiedAt: now,
        accountLogin: "owner",
        accountType: "Organization",
        targetType: "Organization",
        createdAt: now,
        updatedAt: now,
      });
      const repository = {
        userId,
        installationId: 249,
        githubRepositoryId: 349,
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
      };
      await ctx.db.insert("repositories", {
        indexSyncPending: false,
        indexProgressAt: Date.now(),
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        ...repository,
        githubRepo: "owner/stale",
        githubRepoKey: "owner/stale",
        name: "stale",
        githubUrl: "https://github.com/owner/stale",
        isActive: false,
        githubAccessRevokedAt: 1,
        isActiveBeforeAccessRevocation: true,
        indexVersion: 2,
        indexStatus: "failed",
        ragStatus: "failed",
      });
      return await ctx.db.insert("repositories", {
        indexSyncPending: false,
        indexProgressAt: Date.now(),
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        ...repository,
        githubRepo: "owner/live",
        githubRepoKey: "owner/live",
        name: "live",
        githubUrl: "https://github.com/owner/live",
        isActive: true,
        indexVersion: 3,
        indexStatus: "completed",
        ragStatus: "completed",
      });
    });

    await expect(
      t.mutation(internal.repoIndexing.mutation.prepareIncrementalIndex, {
        installationId: 249,
        githubRepositoryId: 349,
      }),
    ).resolves.toMatchObject({
      success: true,
      repositoryId: activeRepositoryId,
      newVersion: 4,
    });
  });

  it("fails closed instead of indexing an arbitrary active immutable-ID duplicate", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 248,
        ownerGithubAccountId: "verified-owner",
        ownershipVerifiedAt: now,
        accountLogin: "owner",
        accountType: "Organization",
        targetType: "Organization",
        createdAt: now,
        updatedAt: now,
      });
      for (const githubRepo of ["owner/first", "owner/second"]) {
        await ctx.db.insert("repositories", {
          indexSyncPending: false,
          indexProgressAt: Date.now(),
          ragTotalChunks: 0,
          ragIndexedChunks: 0,
          ragFailedChunks: 0,
          userId,
          installationId: 248,
          githubRepositoryId: 348,
          githubRepo,
          githubRepoKey: githubRepo,
          name: githubRepo.split("/").at(-1) ?? githubRepo,
          githubUrl: `https://github.com/${githubRepo}`,
          isActive: true,
          indexVersion: 3,
          indexStatus: "completed",
          ragStatus: "completed",
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
        });
      }
    });

    await expect(
      t.mutation(internal.repoIndexing.mutation.prepareIncrementalIndex, {
        installationId: 248,
        githubRepositoryId: 348,
      }),
    ).resolves.toEqual({ success: false, error: "repository not found" });
  });

  it("resolves signed pushes by immutable repository ID", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { repositoryId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 250,
        ownerGithubAccountId: "verified-owner",
        ownershipVerifiedAt: now,
        accountLogin: "owner",
        accountType: "Organization",
        targetType: "Organization",
        createdAt: now,
        updatedAt: now,
      });
      const repositoryId = await ctx.db.insert("repositories", {
        indexSyncPending: false,
        indexProgressAt: Date.now(),
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        userId,
        installationId: 250,
        githubRepositoryId: 350,
        githubRepo: "owner/name-c",
        githubRepoKey: "owner/name-c",
        name: "name-c",
        githubUrl: "https://github.com/owner/name-c",
        isActive: true,
        indexVersion: 3,
        indexStatus: "completed",
        ragStatus: "completed",
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
      });
      return { repositoryId };
    });

    const immutableMatch = await t.mutation(
      internal.repoIndexing.mutation.prepareIncrementalIndex,
      {
        installationId: 250,
        githubRepositoryId: 350,
      },
    );
    const pinnedMismatch = await t.mutation(
      internal.repoIndexing.mutation.prepareIncrementalIndex,
      {
        installationId: 250,
        githubRepositoryId: 999,
      },
    );

    expect(immutableMatch).toMatchObject({
      success: true,
      repositoryId,
      newVersion: 4,
    });
    expect(pinnedMismatch).toMatchObject({
      success: false,
      error: "repository not found",
    });
    await drainScheduledFunctions(t);
  });

  it("allows an explicit retry of a failed file index", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const repositoryId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 303,
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
        installationId: 303,
        githubRepositoryId: 403,
        githubRepo: "owner/failed-repo",
        githubRepoKey: "owner/failed-repo",
        name: "failed-repo",
        githubUrl: "https://github.com/owner/failed-repo",
        isActive: true,
        indexVersion: 1,
        indexStatus: "failed",
        ragStatus: "failed",
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
      });
    });

    const automaticAttempt = await t.mutation(
      internal.repoIndexing.mutation.prepareIncrementalIndex,
      { repositoryId },
    );
    const manualAttempt = await t.mutation(
      internal.repoIndexing.mutation.prepareIncrementalIndex,
      { repositoryId, allowFailedIndexRecovery: true },
    );

    expect(automaticAttempt).toMatchObject({ success: false });
    expect(manualAttempt).toMatchObject({ success: true, newVersion: 2 });
    expect(
      await t.run(async (ctx) => await ctx.db.get(repositoryId)),
    ).toMatchObject({
      indexStatus: "pending",
      ragStatus: "pending",
      indexVersion: 2,
    });
    await drainScheduledFunctions(t);
  });

  it("advances and schedules exactly once only after active work is stale", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-07-17T00:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const t = convexTest(schema, modules);
    const repositoryId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 404,
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
        installationId: 404,
        githubRepositoryId: 504,
        githubRepo: "owner/stale-repo",
        githubRepoKey: "owner/stale-repo",
        name: "stale-repo",
        githubUrl: "https://github.com/owner/stale-repo",
        isActive: true,
        indexVersion: 7,
        indexStatus: "indexing",
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
      });
    });

    const freshAttempt = await t.mutation(
      internal.repoIndexing.mutation.prepareIncrementalIndex,
      {
        repositoryId,
        allowStaleIndexRecovery: true,
        queueIfBusy: false,
      },
    );
    expect(freshAttempt).toMatchObject({ success: false, queued: false });
    expect(
      await t.run(async (ctx) => await ctx.db.get(repositoryId)),
    ).toMatchObject({ indexVersion: 7, updatedAt: now });
    expect(
      await t.run(async (ctx) =>
        ctx.db.system.query("_scheduled_functions").collect(),
      ),
    ).toHaveLength(0);

    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, {
        updatedAt: now - INDEXING_STALE_THRESHOLD_MS,
        indexProgressAt: now - INDEXING_STALE_THRESHOLD_MS,
      });
    });

    const staleAttempt = await t.mutation(
      internal.repoIndexing.mutation.prepareIncrementalIndex,
      {
        repositoryId,
        allowStaleIndexRecovery: true,
        queueIfBusy: false,
      },
    );
    const duplicateAttempt = await t.mutation(
      internal.repoIndexing.mutation.prepareIncrementalIndex,
      {
        repositoryId,
        allowStaleIndexRecovery: true,
        queueIfBusy: false,
      },
    );

    expect(staleAttempt).toMatchObject({ success: true, newVersion: 8 });
    expect(duplicateAttempt).toMatchObject({
      success: false,
      queued: false,
    });
    const state = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.repository).toMatchObject({
      indexVersion: 8,
      indexStatus: "pending",
      ragStatus: "pending",
      indexSyncPending: false,
    });
    expect(
      state.scheduled.filter(
        (scheduled) => scheduled.name === "repoIndexing/action:indexRepository",
      ),
    ).toHaveLength(1);
    await drainScheduledFunctions(t);
  });

  it("touches progress only for the exact active file-index generation", async () => {
    vi.useFakeTimers();
    const heartbeatTime = Date.parse("2026-07-17T01:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(heartbeatTime);
    const t = convexTest(schema, modules);
    const initialUpdatedAt = heartbeatTime - 60_000;
    const repositoryId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      return await ctx.db.insert("repositories", {
        indexSyncPending: false,
        indexProgressAt: Date.now(),
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        userId,
        installationId: 505,
        githubRepositoryId: 505 + 1_000,
        githubRepo: "owner/heartbeat-repo",
        githubRepoKey: "owner/heartbeat-repo",
        name: "heartbeat-repo",
        githubUrl: "https://github.com/owner/heartbeat-repo",
        isActive: true,
        indexVersion: 4,
        indexStatus: "indexing",
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
        lastResetAt: initialUpdatedAt,
        createdAt: initialUpdatedAt,
        updatedAt: initialUpdatedAt,
      });
    });

    expect(
      await t.mutation(internal.repoIndexing.mutation.touchIndexingProgress, {
        repositoryId,
        expectedIndexVersion: 3,
      }),
    ).toBe(false);
    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, { indexStatus: "completed" });
    });
    expect(
      await t.mutation(internal.repoIndexing.mutation.touchIndexingProgress, {
        repositoryId,
        expectedIndexVersion: 4,
      }),
    ).toBe(false);
    expect(
      await t.run(async (ctx) => (await ctx.db.get(repositoryId))?.updatedAt),
    ).toBe(initialUpdatedAt);

    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, { indexStatus: "indexing" });
    });
    const heartbeat = await mutationWithTime(
      t,
      internal.repoIndexing.mutation.touchIndexingProgress,
      { repositoryId, expectedIndexVersion: 4 },
    );
    expect(heartbeat.result).toBe(true);
    expect(heartbeat.now).toBeGreaterThanOrEqual(heartbeatTime);
    expect(
      await t.run(async (ctx) => {
        const repository = await ctx.db.get(repositoryId);
        return {
          updatedAt: repository?.updatedAt,
          indexProgressAt: repository?.indexProgressAt,
        };
      }),
    ).toEqual({
      updatedAt: heartbeat.now,
      indexProgressAt: heartbeat.now,
    });
  });

  it("deletes a redundant storage object when reusing a file blob", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const fixture = await insertBlobPublicationFixture(t);
    const { firstStorageId, redundantStorageId } = await t.run(async (ctx) => ({
      firstStorageId: await ctx.storage.store(new Blob(["same content"])),
      redundantStorageId: await ctx.storage.store(new Blob(["same content"])),
    }));

    const firstBlobId = await t.mutation(
      internal.repoIndexing.mutation.storeFileBlob,
      {
        ...blobPublicationArgs(fixture, "first.ts", "shared-sha", 12),
        storageId: firstStorageId,
      },
    );
    const reusedBlobId = await t.mutation(
      internal.repoIndexing.mutation.storeFileBlob,
      {
        ...blobPublicationArgs(fixture, "second.ts", "shared-sha", 12),
        storageId: redundantStorageId,
      },
    );

    const state = await t.run(async (ctx) => ({
      blob: await ctx.db
        .query("repoFileBlobs")
        .withIndex("by_sha256", (q) => q.eq("sha256", "shared-sha"))
        .first(),
      firstUrl: await ctx.storage.getUrl(firstStorageId),
      redundantUrl: await ctx.storage.getUrl(redundantStorageId),
    }));
    expect(reusedBlobId).toBe(firstBlobId);
    expect(state.blob).toMatchObject({
      storageId: firstStorageId,
      accessCount: 2,
    });
    expect(state.firstUrl).not.toBeNull();
    expect(state.redundantUrl).toBeNull();
  });

  it("deletes a late upload and refuses blob touches after the indexing fence is lost", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertBlobPublicationFixture(t);
    const { sharedStorageId, lateStorageId } = await t.run(async (ctx) => ({
      sharedStorageId: await ctx.storage.store(new Blob(["shared-private"])),
      lateStorageId: await ctx.storage.store(new Blob(["late-private"])),
    }));
    const sharedBlobId = await t.mutation(
      internal.repoIndexing.mutation.storeFileBlob,
      {
        ...blobPublicationArgs(
          fixture,
          "published.ts",
          "shared-private-sha",
          14,
        ),
        storageId: sharedStorageId,
      },
    );
    if (!sharedBlobId) {
      throw new Error("initial blob publication lost ownership");
    }
    const beforeDisconnect = await t.run(async (ctx) =>
      ctx.db.get(sharedBlobId),
    );
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.repositoryId, {
        disconnectCleanupPending: true,
      });
    });

    await expect(
      t.mutation(internal.repoIndexing.mutation.storeFileBlob, {
        ...blobPublicationArgs(fixture, "late.ts", "late-private-sha", 12),
        storageId: lateStorageId,
      }),
    ).resolves.toBeNull();
    await expect(
      t.mutation(internal.repoIndexing.mutation.reuseFileBlob, {
        ...blobPublicationArgs(
          fixture,
          "stale-reuse.ts",
          "shared-private-sha",
          14,
        ),
      }),
    ).resolves.toBe("stale");

    const state = await t.run(async (ctx) => ({
      sharedBlob: await ctx.db.get(sharedBlobId),
      lateBlob: await ctx.db
        .query("repoFileBlobs")
        .withIndex("by_sha256", (q) => q.eq("sha256", "late-private-sha"))
        .first(),
      staleMap: await ctx.db
        .query("repoFileMap")
        .withIndex("by_repository_and_path", (q) =>
          q
            .eq("repositoryId", fixture.repositoryId)
            .eq("filePath", "stale-reuse.ts"),
        )
        .first(),
      lateUrl: await ctx.storage.getUrl(lateStorageId),
      sharedUrl: await ctx.storage.getUrl(sharedStorageId),
    }));
    expect(state.sharedBlob).toMatchObject({
      accessCount: beforeDisconnect?.accessCount,
      lastAccessedAt: beforeDisconnect?.lastAccessedAt,
    });
    expect(state.lateBlob).toBeNull();
    expect(state.staleMap).toBeNull();
    expect(state.lateUrl).toBeNull();
    expect(state.sharedUrl).not.toBeNull();
  });

  it("deletes a late upload after the expected indexing generation advances", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertBlobPublicationFixture(t);
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["stale-generation-private"])),
    );
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.repositoryId, {
        indexVersion: fixture.indexVersion + 1,
        indexStatus: "pending",
        indexIdentityVerifiedVersion: undefined,
        indexIdentityVerifiedInstallationId: undefined,
        indexIdentityVerifiedGithubRepositoryId: undefined,
        indexIdentityVerifiedGithubRepo: undefined,
      });
    });

    await expect(
      t.mutation(internal.repoIndexing.mutation.storeFileBlob, {
        ...blobPublicationArgs(
          fixture,
          "stale-generation.ts",
          "stale-generation-sha",
          24,
        ),
        storageId,
      }),
    ).resolves.toBeNull();
    await expect(
      t.run(async (ctx) => ({
        url: await ctx.storage.getUrl(storageId),
        blob: await ctx.db
          .query("repoFileBlobs")
          .withIndex("by_sha256", (q) => q.eq("sha256", "stale-generation-sha"))
          .first(),
        map: await ctx.db
          .query("repoFileMap")
          .withIndex("by_repository_and_path", (q) =>
            q
              .eq("repositoryId", fixture.repositoryId)
              .eq("filePath", "stale-generation.ts"),
          )
          .first(),
      })),
    ).resolves.toEqual({ url: null, blob: null, map: null });
  });

  it("refreshes reused blobs before stale cleanup can delete them", async () => {
    const now = Date.parse("2026-07-17T02:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const t = convexTest(schema, modules);
    const fixture = await insertBlobPublicationFixture(t);
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["cached content"])),
    );
    const blobId = await t.mutation(
      internal.repoIndexing.mutation.storeFileBlob,
      {
        ...blobPublicationArgs(fixture, "first.ts", "reused-sha", 14),
        storageId,
      },
    );
    if (!blobId) {
      throw new Error("blob publication fixture lost ownership");
    }
    await t.run(async (ctx) => {
      await ctx.db.patch(blobId, {
        lastAccessedAt: now - 8 * 24 * 60 * 60 * 1000,
        accessCount: 1,
      });
    });

    const reused = await mutationWithTime(
      t,
      internal.repoIndexing.mutation.reuseFileBlob,
      blobPublicationArgs(fixture, "second.ts", "reused-sha", 14),
    );
    expect(reused.result).toBe(true);
    expect(reused.now).toBeGreaterThanOrEqual(now);
    expect(
      await t.mutation(internal.repoIndexing.mutation.deleteFileBlobIfStale, {
        blobId,
        threshold: now - 7 * 24 * 60 * 60 * 1000,
      }),
    ).toBe(false);

    const state = await t.run(async (ctx) => ({
      blob: await ctx.db.get(blobId),
      url: await ctx.storage.getUrl(storageId),
    }));
    expect(state.blob).toMatchObject({
      lastAccessedAt: reused.now,
      accessCount: 2,
    });
    expect(state.url).not.toBeNull();
  });

  it("deletes a stale high-access blob after its reference is removed", async () => {
    const now = Date.parse("2026-07-17T02:30:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const threshold = now - 7 * 24 * 60 * 60 * 1000;
    const t = convexTest(schema, modules);
    const fixture = await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["cached content"]));
      const blobId = await ctx.db.insert("repoFileBlobs", {
        sha256: "high-access-sha",
        storageId,
        size: 21,
        createdAt: now - 30 * 24 * 60 * 60 * 1000,
        lastAccessedAt: now - 8 * 24 * 60 * 60 * 1000,
        accessCount: 42,
      });
      const userId = await ctx.db.insert("users", {});
      const repositoryId = await ctx.db.insert("repositories", {
        indexSyncPending: false,
        indexProgressAt: Date.now(),
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        userId,
        installationId: 607,
        githubRepositoryId: 607 + 1_000,
        githubRepo: "owner/high-access-blob",
        githubRepoKey: "owner/high-access-blob",
        name: "high-access-blob",
        githubUrl: "https://github.com/owner/high-access-blob",
        isActive: true,
        indexVersion: 1,
        indexStatus: "completed",
        ragStatus: "completed",
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
      });
      const fileMapId = await ctx.db.insert("repoFileMap", {
        repositoryId,
        filePath: "cache.ts",
        sha256: "high-access-sha",
        size: 21,
        isText: true,
        indexVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
      return { blobId, fileMapId, storageId };
    });
    await t.run(async (ctx) => ctx.db.delete(fixture.fileMapId));

    const candidates = await t.query(
      internal.repoIndexing.internalQuery.getStaleFileBlobs,
      { threshold },
    );
    expect(candidates.map((blob) => blob._id)).toContain(fixture.blobId);

    await expect(
      t.mutation(internal.repoIndexing.mutation.deleteFileBlobIfStale, {
        blobId: fixture.blobId,
        threshold,
      }),
    ).resolves.toBe(true);
    await expect(
      t.run(async (ctx) => ({
        blob: await ctx.db.get(fixture.blobId),
        url: await ctx.storage.getUrl(fixture.storageId),
      })),
    ).resolves.toEqual({ blob: null, url: null });
  });

  it("moves referenced blobs out of the stale cleanup window", async () => {
    const now = Date.parse("2026-07-17T03:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const t = convexTest(schema, modules);
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["referenced content"])),
    );
    const blobId = await t.run(async (ctx) =>
      ctx.db.insert("repoFileBlobs", {
        sha256: "referenced-sha",
        storageId,
        size: 18,
        createdAt: now,
        lastAccessedAt: now,
        accessCount: 1,
      }),
    );
    await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const repositoryId = await ctx.db.insert("repositories", {
        indexSyncPending: false,
        indexProgressAt: Date.now(),
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        userId,
        installationId: 606,
        githubRepositoryId: 606 + 1_000,
        githubRepo: "owner/referenced-blob",
        githubRepoKey: "owner/referenced-blob",
        name: "referenced-blob",
        githubUrl: "https://github.com/owner/referenced-blob",
        isActive: true,
        indexVersion: 1,
        indexStatus: "completed",
        ragStatus: "completed",
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
      });
      await ctx.db.insert("repoFileMap", {
        repositoryId,
        filePath: "referenced.ts",
        sha256: "referenced-sha",
        size: 18,
        isText: true,
        indexVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.patch(blobId, {
        lastAccessedAt: now - 8 * 24 * 60 * 60 * 1000,
        accessCount: 1,
      });
    });

    const cleanup = await mutationWithTime(
      t,
      internal.repoIndexing.mutation.deleteFileBlobIfStale,
      { blobId, threshold: now - 7 * 24 * 60 * 60 * 1000 },
    );
    expect(cleanup.result).toBe(false);
    expect(cleanup.now).toBeGreaterThanOrEqual(now);

    const state = await t.run(async (ctx) => ({
      blob: await ctx.db.get(blobId),
      url: await ctx.storage.getUrl(storageId),
    }));
    expect(state.blob?.lastAccessedAt).toBe(
      cleanup.now + REFERENCED_BLOB_RECHECK_MS,
    );
    expect(state.url).not.toBeNull();
  });

  it("cleans old file maps in bounded scheduled mutations before publishing", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const repositoryId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 606,
        ownerGithubAccountId: "verified-owner",
        ownershipVerifiedAt: now,
        accountLogin: "owner",
        accountType: "Organization",
        targetType: "Organization",
        createdAt: now,
        updatedAt: now,
      });
      const id = await ctx.db.insert("repositories", {
        indexSyncPending: false,
        indexProgressAt: Date.now(),
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        userId,
        installationId: 606,
        githubRepositoryId: 706,
        githubRepo: "owner/cleanup-repo",
        githubRepoKey: "owner/cleanup-repo",
        name: "cleanup-repo",
        githubUrl: "https://github.com/owner/cleanup-repo",
        isActive: true,
        indexVersion: 3,
        indexStatus: "indexing",
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
      });

      for (let index = 0; index < 205; index++) {
        await ctx.db.insert("repoFileMap", {
          repositoryId: id,
          filePath: `old-${index}.ts`,
          sha256: `old-${index}`,
          size: 1,
          isText: true,
          indexVersion: 2,
          createdAt: now,
          updatedAt: now,
        });
      }
      await ctx.db.insert("repoFileMap", {
        repositoryId: id,
        filePath: "current.ts",
        sha256: "current",
        size: 1,
        isText: true,
        indexVersion: 3,
        createdAt: now,
        updatedAt: now,
      });
      return id;
    });

    const firstBatch = await t.mutation(
      internal.repoIndexing.mutation.continueFileMapCleanup,
      { repositoryId, expectedIndexVersion: 3, totalFiles: 1 },
    );
    expect(firstBatch).toEqual({
      accepted: true,
      deleted: 100,
      hasMore: true,
      completed: false,
    });
    expect(
      await t.run(async (ctx) => (await ctx.db.get(repositoryId))?.indexStatus),
    ).toBe("indexing");

    await drainScheduledFunctions(t);

    const state = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      fileMaps: await ctx.db
        .query("repoFileMap")
        .withIndex("by_index_version", (q) =>
          q.eq("repositoryId", repositoryId),
        )
        .collect(),
    }));
    expect(state.repository).toMatchObject({
      indexStatus: "completed",
      ragStatus: "completed",
      indexVersion: 3,
    });
    expect(state.fileMaps).toHaveLength(1);
    expect(state.fileMaps[0]?.filePath).toBe("current.ts");
  });

  it("defers file publication until installation reconciliation completes", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const fixture = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      const installationDocId = await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 607,
        ownerGithubAccountId: "verified-owner",
        ownershipVerifiedAt: now,
        accountLogin: "owner",
        accountType: "Organization",
        targetType: "Organization",
        repositoryRemovalPendingAt: now,
        repositoryAccessReconciliationEpoch: now,
        repositoryAccessReconciliationPhase: "fetching",
        createdAt: now,
        updatedAt: now,
      });
      const repositoryId = await ctx.db.insert("repositories", {
        indexSyncPending: false,
        indexProgressAt: Date.now(),
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        userId,
        installationId: 607,
        githubRepositoryId: 90_607,
        githubRepo: "owner/deferred-publication",
        githubRepoKey: "owner/deferred-publication",
        name: "deferred-publication",
        githubUrl: "https://github.com/owner/deferred-publication",
        isActive: true,
        indexVersion: 2,
        indexStatus: "indexing",
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
      });
      await ctx.db.insert("repoFileMap", {
        repositoryId,
        filePath: "old.ts",
        sha256: "old",
        size: 1,
        isText: true,
        indexVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("repoFileMap", {
        repositoryId,
        filePath: "current.ts",
        sha256: "current",
        size: 1,
        isText: true,
        indexVersion: 2,
        createdAt: now,
        updatedAt: now,
      });
      return { installationDocId, repositoryId };
    });

    const mapResult = await t.mutation(internal.repoIndexing.mutation.mapFile, {
      repositoryId: fixture.repositoryId,
      filePath: "blocked.ts",
      sha256: "blocked",
      size: 1,
      isText: true,
      indexVersion: 2,
    });
    expect(mapResult).toEqual({ status: "deferred" });
    await expect(
      t.mutation(internal.repoIndexing.mutation.continueFileMapCleanup, {
        repositoryId: fixture.repositoryId,
        expectedIndexVersion: 2,
        totalFiles: 1,
      }),
    ).resolves.toEqual({
      accepted: true,
      deleted: 0,
      hasMore: true,
      completed: false,
    });

    const deferred = await t.run(async (ctx) => ({
      repository: await ctx.db.get(fixture.repositoryId),
      fileMaps: await ctx.db
        .query("repoFileMap")
        .withIndex("by_repository", (q) =>
          q.eq("repositoryId", fixture.repositoryId),
        )
        .collect(),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(deferred.repository?.indexStatus).toBe("indexing");
    expect(deferred.fileMaps).toHaveLength(2);
    expect(
      deferred.scheduled.some(
        (scheduled) =>
          scheduled.name === "repoIndexing/mutation:continueFileMapCleanup",
      ),
    ).toBe(true);

    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.installationDocId, {
        repositoryRemovalPendingAt: undefined,
        repositoryAccessReconciliationPhase: undefined,
      });
    });
    expect(() => assertMapFilePublished(mapResult)).toThrow(
      "GitHub installation access changed while mapping repository files",
    );
    await drainScheduledFunctions(t);

    const resumed = await t.run(async (ctx) => ({
      repository: await ctx.db.get(fixture.repositoryId),
      fileMaps: await ctx.db
        .query("repoFileMap")
        .withIndex("by_repository", (q) =>
          q.eq("repositoryId", fixture.repositoryId),
        )
        .collect(),
    }));
    expect(resumed.repository).toMatchObject({
      indexStatus: "completed",
      ragStatus: "completed",
      indexVersion: 2,
    });
    expect(resumed.fileMaps).toHaveLength(1);
    expect(resumed.fileMaps[0]?.filePath).toBe("current.ts");
  });

  it("persists verified license metadata only for the active generation", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 707,
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
        installationId: 707,
        githubRepositoryId: 90_707,
        githubRepo: "owner/licensed-repo",
        githubRepoKey: "owner/licensed-repo",
        name: "licensed-repo",
        githubUrl: "https://github.com/owner/licensed-repo",
        isActive: true,
        indexVersion: 4,
        indexStatus: "indexing",
        indexIdentityVerifiedVersion: 4,
        indexIdentityVerifiedInstallationId: 707,
        indexIdentityVerifiedGithubRepositoryId: 90_707,
        indexIdentityVerifiedGithubRepo: "owner/licensed-repo",
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
      });
    });

    expect(
      await t.mutation(
        internal.repoIndexing.mutation.updateRepositoryMetadata,
        {
          repositoryId,
          expectedIndexVersion: 4,
          expectedMetadataCheckedAt: undefined,
          defaultBranch: "main",
          githubVisibility: "public",
          licenseKey: "mit",
          licenseSpdxId: "MIT",
          licenseOsiApproved: true,
          licenseOsiCheckedAt: 123,
        },
      ),
    ).toBe(true);

    expect(
      await t.mutation(
        internal.repoIndexing.mutation.updateRepositoryMetadata,
        {
          repositoryId,
          expectedIndexVersion: 3,
          expectedMetadataCheckedAt: undefined,
          defaultBranch: "stale",
          githubVisibility: "private",
          licenseKey: null,
          licenseSpdxId: null,
          licenseOsiApproved: false,
          licenseOsiCheckedAt: null,
        },
      ),
    ).toBe(false);

    const repository = await t.run(async (ctx) => ctx.db.get(repositoryId));
    expect(repository).toMatchObject({
      defaultBranch: "main",
      githubVisibility: "public",
      licenseKey: "mit",
      licenseSpdxId: "MIT",
      licenseOsiApproved: true,
      licenseOsiCheckedAt: 123,
    });
    expect(repository?.repositoryMetadataCheckedAt).toEqual(expect.any(Number));
    expect(repository?.licenseOsiCheckedAt).toBe(123);
  });

  it("rejects indexing metadata captured before a signed webhook revision", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await t.run(async (ctx) => {
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
        githubRepositoryId: 90_808,
        githubRepo: "owner/race-repo",
        githubRepoKey: "owner/race-repo",
        name: "race-repo",
        githubUrl: "https://github.com/owner/race-repo",
        githubVisibility: "public",
        licenseKey: "mit",
        licenseSpdxId: "MIT",
        licenseOsiApproved: true,
        licenseOsiCheckedAt: 50,
        repositoryMetadataCheckedAt: 100,
        isActive: true,
        indexVersion: 7,
        indexStatus: "indexing",
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
      });
    });

    const webhookResult = await t.mutation(
      internal.repositories.internalMutation.applyRepositoryWebhookUpdate,
      {
        repositoryId,
        expectedGithubRepo: "owner/race-repo",
        githubRepositoryId: 90_808,
        installationId: 808,
        githubRepo: "owner/race-repo",
        githubVisibility: "private",
        licenseKey: "mit",
        licenseSpdxId: "MIT",
      },
    );
    expect(webhookResult.persisted).toBe(true);

    expect(
      await t.mutation(
        internal.repoIndexing.mutation.updateRepositoryMetadata,
        {
          repositoryId,
          expectedIndexVersion: 7,
          expectedMetadataCheckedAt: 100,
          defaultBranch: "main",
          githubVisibility: "public",
          licenseKey: "mit",
          licenseSpdxId: "MIT",
          licenseOsiApproved: true,
          licenseOsiCheckedAt: 200,
        },
      ),
    ).toBe(false);

    const repository = await t.run(async (ctx) => ctx.db.get(repositoryId));
    expect((repository?.repositoryMetadataCheckedAt ?? 0) > 100).toBe(true);
    expect(repository).toMatchObject({
      githubVisibility: "private",
      licenseOsiApproved: false,
      repositoryMetadataCheckedAt: expect.any(Number),
    });
  });

  it("does not reserve a generation while installation access is reconciling", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 919,
        ownerGithubAccountId: "verified-owner",
        ownershipVerifiedAt: now,
        accountLogin: "owner",
        accountType: "Organization",
        targetType: "Organization",
        repositoryRemovalPendingAt: now,
        repositoryAccessReconciliationEpoch: now,
        repositoryAccessReconciliationPhase: "finalizing",
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
        installationId: 919,
        githubRepositoryId: 920,
        githubRepo: "owner/reconciliation-race",
        githubRepoKey: "owner/reconciliation-race",
        name: "reconciliation-race",
        githubUrl: "https://github.com/owner/reconciliation-race",
        isActive: true,
        indexVersion: 4,
        indexStatus: "completed",
        ragStatus: "completed",
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
      });
    });

    await expect(
      t.mutation(internal.repoIndexing.mutation.prepareIncrementalIndex, {
        repositoryId,
      }),
    ).resolves.toEqual({
      success: false,
      error: "repository installation access is not ready",
    });
    const state = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.repository).toMatchObject({
      indexVersion: 4,
      indexStatus: "completed",
      ragStatus: "completed",
    });
    expect(state.scheduled).toHaveLength(0);
  });

  it("durably consumes a signed push deferred by installation reconciliation", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      const installationDocId = await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 929,
        ownerGithubAccountId: "verified-owner",
        ownershipVerifiedAt: now,
        accountLogin: "owner",
        accountType: "Organization",
        targetType: "Organization",
        createdAt: now,
        updatedAt: now,
      });
      const repositoryId = await ctx.db.insert("repositories", {
        indexSyncPending: false,
        indexProgressAt: Date.now(),
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        userId,
        installationId: 929,
        githubRepositoryId: 930,
        githubRepo: "owner/deferred-push",
        githubRepoKey: "owner/deferred-push",
        name: "deferred-push",
        githubUrl: "https://github.com/owner/deferred-push",
        isActive: true,
        indexVersion: 4,
        indexStatus: "completed",
        ragStatus: "completed",
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
      });
      return { installationDocId, repositoryId };
    });

    const epoch = await t.mutation(
      internal.github.internalMutation.startRepositoryAccessReconciliation,
      { installationId: 929, expectedAccessSuspendedAt: null },
    );
    if (epoch === null) throw new Error("reconciliation did not start");

    await expect(
      t.action(internal.repoIndexing.internalAction.triggerIncrementalIndex, {
        installationId: 929,
        githubRepositoryId: 930,
        repositoryFullName: "owner/deferred-push",
        reason: "push",
      }),
    ).resolves.toEqual({
      success: false,
      error: "repository installation access is not ready",
    });
    await expect(
      t.run(async (ctx) => ctx.db.get(fixture.repositoryId)),
    ).resolves.toMatchObject({
      indexVersion: 4,
      indexStatus: "completed",
      indexSyncPending: true,
      githubAccessRestoreIndexPending: true,
      githubAccessRestoreIndexNextAttemptAt: expect.any(Number),
    });

    await t.mutation(
      internal.repositories.internalMutation
        .applyRepositoryAccessReconciliationPage,
      {
        installationId: 929,
        epoch,
        page: 1,
        hasMore: false,
        repositories: [
          {
            githubRepositoryId: 930,
            githubRepo: "owner/deferred-push",
            githubVisibility: "public",
            licenseKey: "mit",
            licenseSpdxId: "MIT",
          },
        ],
      },
    );
    await t.mutation(
      internal.repositories.internalMutation
        .finalizeRepositoryAccessReconciliation,
      {
        installationId: 929,
        epoch,
        paginationOpts: { numItems: 25, cursor: null },
      },
    );

    const afterFinalization = await t.run(async (ctx) => ({
      installation: await ctx.db.get(fixture.installationDocId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(
      afterFinalization.installation?.repositoryAccessReconciliationPhase,
    ).toBeUndefined();
    expect(afterFinalization.scheduled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "github/action:prepareRestoredRepositoryIndex",
        }),
      ]),
    );

    const dueAt = await t.run(
      async (ctx) =>
        (await ctx.db.get(fixture.repositoryId))
          ?.githubAccessRestoreIndexNextAttemptAt,
    );
    expect(dueAt).toEqual(expect.any(Number));
    vi.setSystemTime(dueAt!);
    await t.action(internal.github.action.prepareRestoredRepositoryIndex, {
      repositoryId: fixture.repositoryId,
    });
    await expect(
      t.run(async (ctx) => ctx.db.get(fixture.repositoryId)),
    ).resolves.toMatchObject({
      indexVersion: 5,
      indexStatus: "pending",
      ragStatus: "pending",
      indexSyncPending: false,
    });
    const repository = await t.run(async (ctx) =>
      ctx.db.get(fixture.repositoryId),
    );
    expect(repository?.githubAccessRestoreIndexPending).toBeUndefined();
  });
});

describe("push indexing deduplication", () => {
  const source = { commitSha: "a".repeat(40), defaultBranch: "main" };

  async function fixture() {
    const t = convexTest(schema, modules);
    const { repositoryId } = await insertBlobPublicationFixture(t);
    return { t, repositoryId };
  }

  async function pinSnapshot(
    t: ReturnType<typeof convexTest>,
    repositoryId: Id<"repositories">,
  ) {
    await t.mutation(internal.repoIndexing.mutation.beginIndexTreeSnapshot, {
      repositoryId,
      expectedIndexVersion: 4,
      ...source,
      treeSha: "b".repeat(40),
      totalFiles: 0,
      totalPages: 0,
    });
  }

  it.each(["indexing", "completed"] as const)(
    "preserves an exact pinned %s generation on a duplicate push",
    async (status) => {
      const { t, repositoryId } = await fixture();
      await pinSnapshot(t, repositoryId);
      await t.run(async (ctx) => {
        await ctx.db.patch(repositoryId, {
          indexStatus: status,
          ragStatus: status,
          ragIndexedChunks: 8354,
        });
      });
      const before = await t.run((ctx) => ctx.db.get(repositoryId));
      const result = await t.mutation(
        internal.repoIndexing.mutation.prepareIncrementalIndex,
        { repositoryId, source },
      );
      expect(result).toMatchObject({ success: false, queued: false });
      expect(await t.run((ctx) => ctx.db.get(repositoryId))).toEqual(before);
    },
  );

  it("consumes an early duplicate queued before the snapshot was pinned", async () => {
    const { t, repositoryId } = await fixture();
    expect(
      await t.mutation(internal.repoIndexing.mutation.prepareIncrementalIndex, {
        repositoryId,
        source,
      }),
    ).toMatchObject({ queued: true });
    await pinSnapshot(t, repositoryId);
    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, {
        indexStatus: "completed",
        ragStatus: "indexing",
      });
    });
    await t.mutation(internal.ragV2.internalMutation.updateRagStatus, {
      repositoryId,
      expectedIndexVersion: 4,
      status: "completed",
    });
    const repo = await t.run((ctx) => ctx.db.get(repositoryId));
    expect(repo).toMatchObject({
      indexVersion: 4,
      indexSyncPending: false,
      ragStatus: "completed",
    });
    expect(repo?.indexSyncPendingSource).toBeUndefined();
  });

  it.each([
    undefined,
    { commitSha: "c".repeat(40), defaultBranch: "main" },
    { ...source, defaultBranch: "release" },
  ])(
    "retains unknown or different queued work despite an out-of-order duplicate: %j",
    async (otherSource) => {
      const { t, repositoryId } = await fixture();
      for (const nextSource of [source, otherSource, source]) {
        await t.mutation(
          internal.repoIndexing.mutation.prepareIncrementalIndex,
          { repositoryId, source: nextSource },
        );
      }
      await pinSnapshot(t, repositoryId);
      await t.run(async (ctx) => {
        await ctx.db.patch(repositoryId, {
          indexStatus: "completed",
          ragStatus: "indexing",
        });
      });
      await t.mutation(internal.ragV2.internalMutation.updateRagStatus, {
        repositoryId,
        expectedIndexVersion: 4,
        status: "completed",
      });
      expect(await t.run((ctx) => ctx.db.get(repositoryId))).toMatchObject({
        indexVersion: 5,
        indexStatus: "pending",
        indexSyncPending: false,
      });
    },
  );

  it("does not let a duplicate erase a newer queued push or disable manual recovery", async () => {
    const { t, repositoryId } = await fixture();
    await pinSnapshot(t, repositoryId);
    const nextSource = { ...source, commitSha: "c".repeat(40) };
    await t.mutation(internal.repoIndexing.mutation.prepareIncrementalIndex, {
      repositoryId,
      source: nextSource,
    });
    await t.mutation(internal.repoIndexing.mutation.prepareIncrementalIndex, {
      repositoryId,
      source,
    });
    expect(await t.run((ctx) => ctx.db.get(repositoryId))).toMatchObject({
      indexSyncPending: true,
      indexSyncPendingSource: nextSource,
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, {
        indexStatus: "completed",
        ragStatus: "failed",
      });
    });
    expect(
      await t.mutation(internal.repoIndexing.mutation.prepareIncrementalIndex, {
        repositoryId,
        source,
      }),
    ).toMatchObject({ success: true, newVersion: 5 });
  });

  it("lets the queued worker consume a verified no-op without resetting search", async () => {
    const { t, repositoryId } = await fixture();
    await pinSnapshot(t, repositoryId);
    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, {
        indexStatus: "completed",
        ragStatus: "completed",
        indexSyncPending: true,
        indexSyncPendingSource: source,
        ragIndexedChunks: 8354,
      });
    });
    expect(
      await t.mutation(
        internal.repoIndexing.mutation.startQueuedIncrementalIndex,
        { repositoryId },
      ),
    ).toEqual({ scheduled: false });
    expect(await t.run((ctx) => ctx.db.get(repositoryId))).toMatchObject({
      indexVersion: 4,
      ragIndexedChunks: 8354,
      indexSyncPending: false,
    });
  });

  it("never trusts source evidence from an older generation", async () => {
    const { t, repositoryId } = await fixture();
    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, {
        indexSource: { ...source, indexVersion: 3 },
      });
    });
    expect(
      await t.mutation(internal.repoIndexing.mutation.prepareIncrementalIndex, {
        repositoryId,
        source,
      }),
    ).toMatchObject({ success: false, queued: true });
  });

  it("does not deduplicate a manual refresh without push evidence", async () => {
    const { t, repositoryId } = await fixture();
    await pinSnapshot(t, repositoryId);
    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, {
        indexStatus: "completed",
        ragStatus: "completed",
      });
    });
    expect(
      await t.mutation(internal.repoIndexing.mutation.prepareIncrementalIndex, {
        repositoryId,
      }),
    ).toMatchObject({ success: true, newVersion: 5 });
  });
});
