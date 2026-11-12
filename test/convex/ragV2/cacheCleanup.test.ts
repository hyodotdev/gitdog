import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../../../convex/_generated/api";
import { MAX_RAG_EMBEDDING_CACHE_BATCHES_PER_REPOSITORY } from "../../../convex/ragV2/chunkBudget";
import schema from "../../../convex/schema";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/ragV2/internalMutation.ts": () =>
    import("../../../convex/ragV2/internalMutation"),
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("RAG embedding batch cache cleanup", () => {
  it("keeps each active repository cache within the newest batch cap", async () => {
    const t = convexTest(schema, modules);
    const totalRows = MAX_RAG_EMBEDDING_CACHE_BATCHES_PER_REPOSITORY + 3;
    const repositoryId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      const id = await ctx.db.insert("repositories", {
        indexSyncPending: false,
        indexProgressAt: Date.now(),
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        userId,
        installationId: 900,
        githubRepositoryId: 9001,
        githubRepo: "owner/cache-cap",
        githubRepoKey: "owner/cache-cap",
        name: "cache-cap",
        githubUrl: "https://github.com/owner/cache-cap",
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

      for (let index = 0; index < totalRows; index++) {
        await ctx.db.insert("ragEmbeddingBatches", {
          repositoryId: id,
          reservationKey: `rag-index:${id}:cache-${index}`,
          embeddingKey: "google:gemini-embedding-2:1536:code_retrieval",
          embeddings: [[index]],
          createdAt: now + index,
          updatedAt: now + index,
        });
        vi.advanceTimersByTime(1);
      }
      return id;
    });

    await expect(
      t.mutation(internal.ragV2.internalMutation.trimEmbeddingBatchCache, {
        repositoryId,
      }),
    ).resolves.toEqual({ deleted: 1, hasMore: true });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());

    const state = await t.run(async (ctx) => ({
      cacheRows: await ctx.db
        .query("ragEmbeddingBatches")
        .withIndex("by_repository", (q) => q.eq("repositoryId", repositoryId))
        .order("asc")
        .collect(),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.cacheRows).toHaveLength(
      MAX_RAG_EMBEDDING_CACHE_BATCHES_PER_REPOSITORY,
    );
    expect(state.cacheRows.map((row) => row.reservationKey)).toEqual(
      Array.from(
        { length: MAX_RAG_EMBEDDING_CACHE_BATCHES_PER_REPOSITORY },
        (_, index) =>
          `rag-index:${repositoryId}:cache-${index + totalRows - MAX_RAG_EMBEDDING_CACHE_BATCHES_PER_REPOSITORY}`,
      ),
    );
    expect(
      state.scheduled.filter((scheduled) => scheduled.state.kind === "pending"),
    ).toHaveLength(0);
  });

  it("drains every cache row after its repository has already been deleted", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      const id = await ctx.db.insert("repositories", {
        indexSyncPending: false,
        indexProgressAt: Date.now(),
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        userId,
        installationId: 901,
        githubRepositoryId: 9011,
        githubRepo: "owner/cache-cleanup",
        githubRepoKey: "owner/cache-cleanup",
        name: "cache-cleanup",
        githubUrl: "https://github.com/owner/cache-cleanup",
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

      for (let index = 0; index < 3; index++) {
        await ctx.db.insert("ragEmbeddingBatches", {
          repositoryId: id,
          reservationKey: `rag-index:${id}:cache-${index}`,
          embeddingKey: "google:gemini-embedding-2:1536:code_retrieval",
          embeddings: [[index]],
          createdAt: now,
          updatedAt: now,
        });
      }

      await ctx.db.delete(id);
      return id;
    });

    await expect(
      t.mutation(
        internal.ragV2.internalMutation.deleteEmbeddingBatchCachePage,
        { repositoryId },
      ),
    ).resolves.toBe(1);
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());

    const state = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      cacheRows: await ctx.db
        .query("ragEmbeddingBatches")
        .withIndex("by_repository", (q) => q.eq("repositoryId", repositoryId))
        .collect(),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.repository).toBeNull();
    expect(state.cacheRows).toHaveLength(0);
    expect(
      state.scheduled.filter((scheduled) => scheduled.state.kind === "pending"),
    ).toHaveLength(0);
  });
});
