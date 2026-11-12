import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { internal } from "../../../convex/_generated/api";
import schema from "../../../convex/schema";

const modules = import.meta.glob("../../../convex/**/*.ts");

describe("retired embedding purge", () => {
  it("clears stored vectors and the batch cache without touching search data", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const now = Date.now();
      const userId = await ctx.db.insert("users", {});
      const repositoryId = await ctx.db.insert("repositories", {
        indexSyncPending: false,
        indexVersion: 1,
        indexStatus: "completed",
        indexProgressAt: now,
        ragStatus: "completed",
        ragTotalChunks: 1,
        ragIndexedChunks: 1,
        ragFailedChunks: 0,
        userId,
        installationId: 1,
        githubRepositoryId: 1,
        githubRepo: "owner/repo",
        githubRepoKey: "owner/repo",
        name: "repo",
        githubUrl: "https://github.com/owner/repo",
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
      });
      const chunkId = await ctx.db.insert("repoChunks", {
        repositoryId,
        repositoryIndexKey: `${repositoryId}:1`,
        chunkId: "chunk",
        path: "src/a.ts",
        language: "typescript",
        code: "export const a = 1;",
        startLine: 1,
        endLine: 1,
        symbols: ["a"],
        embedding: [0.1, 0.2],
        searchableText: "a export const",
        contentHash: "hash",
        indexVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("ragEmbeddingBatches", {
        reservationKey: "batch",
        repositoryId,
        embeddingKey: "openai:text-embedding-3-small:1536:code_retrieval",
        embeddings: [[0.1]],
        createdAt: now,
        updatedAt: now,
      });
      return { chunkId };
    });

    await t.mutation(internal.ragV2.internalMutation.purgeRetiredEmbeddings, {
      confirm: "delete-retired-embeddings",
    });
    await t.finishAllScheduledFunctions(() => undefined);

    const state = await t.run(async (ctx) => ({
      chunk: await ctx.db.get(ids.chunkId),
      batches: await ctx.db.query("ragEmbeddingBatches").collect(),
    }));
    expect(state.chunk?.embedding).toBeUndefined();
    expect(state.chunk?.searchableText).toBe("a export const");
    expect(state.batches).toEqual([]);
  });
});
