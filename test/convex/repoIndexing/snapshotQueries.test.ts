import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import schema from "../../../convex/schema";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/repoIndexing/internalQuery.ts": () =>
    import("../../../convex/repoIndexing/internalQuery"),
  "../../../convex/ragV2/internalQuery.ts": () =>
    import("../../../convex/ragV2/internalQuery"),
};

async function insertRepository(
  t: ReturnType<typeof convexTest>,
  indexVersion = 2,
  identity: { installationId: number; githubRepositoryId: number } = {
    installationId: 101,
    githubRepositoryId: 10_101,
  },
): Promise<Id<"repositories">> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const now = Date.now();
    await ctx.db.insert("githubInstallations", {
      userId,
      installationId: identity.installationId,
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
      installationId: identity.installationId,
      githubRepositoryId: identity.githubRepositoryId,
      githubRepo: "owner/repo",
      githubRepoKey: "owner/repo",
      name: "repo",
      githubUrl: "https://github.com/owner/repo",
      isActive: true,
      indexVersion,
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
}

describe("repository snapshot queries", () => {
  it("bounds stale cleanup by last access time regardless of access count", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["stale"]));
      for (let index = 0; index < 125; index++) {
        await ctx.db.insert("repoFileBlobs", {
          sha256: `stale-${index}`,
          storageId,
          size: 5,
          createdAt: now - 10_000,
          lastAccessedAt: now - 5_000 + index,
          accessCount: 1,
        });
      }
      for (let index = 0; index < 125; index++) {
        await ctx.db.insert("repoFileBlobs", {
          sha256: `too-frequently-accessed-${index}`,
          storageId,
          size: 5,
          createdAt: now - 20_000,
          lastAccessedAt: now - 15_000 + index,
          accessCount: 6,
        });
      }
    });

    const blobs = await t.query(
      internal.repoIndexing.internalQuery.getStaleFileBlobs,
      { threshold: now },
    );

    expect(blobs).toHaveLength(100);
    expect(blobs.every((blob) => blob.accessCount === 6)).toBe(true);
    expect(blobs[0]?.sha256).toBe("too-frequently-accessed-0");
  });

  it("returns file metadata only from the requested index version", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, 1);

    await t.run(async (ctx) => {
      const now = Date.now();
      const oldStorageId = await ctx.storage.store(new Blob(["old"]));
      const newStorageId = await ctx.storage.store(new Blob(["new"]));
      await ctx.db.insert("repoFileBlobs", {
        sha256: "old-sha",
        storageId: oldStorageId,
        size: 3,
        createdAt: now,
        lastAccessedAt: now,
        accessCount: 1,
      });
      await ctx.db.insert("repoFileBlobs", {
        sha256: "new-sha",
        storageId: newStorageId,
        size: 3,
        createdAt: now,
        lastAccessedAt: now,
        accessCount: 1,
      });
      await ctx.db.insert("repoFileMap", {
        repositoryId,
        filePath: "src/index.ts",
        sha256: "old-sha",
        language: "Old snapshot",
        size: 3,
        isText: true,
        indexVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("repoFileMap", {
        repositoryId,
        filePath: "src/index.ts",
        sha256: "new-sha",
        language: "New snapshot",
        size: 3,
        isText: true,
        indexVersion: 2,
        createdAt: now,
        updatedAt: now,
      });
    });

    const files = await t.query(
      internal.repoIndexing.internalQuery.getRepositoryFiles,
      {
        repositoryId,
        filePaths: ["src/index.ts"],
        indexVersion: 1,
      },
    );

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      path: "src/index.ts",
      language: "Old snapshot",
    });

    const listedFiles = await t.query(
      internal.repoIndexing.internalQuery.getRepositoryFiles,
      {
        repositoryId,
        indexVersion: 1,
        limit: 10,
      },
    );
    expect(listedFiles).toHaveLength(1);
    expect(listedFiles[0]?.language).toBe("Old snapshot");
  });

  it("keeps the raw page cursor while omitting non-text RAG files", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, 1);
    await t.run(async (ctx) => {
      const now = Date.now();
      const storageId = await ctx.storage.store(new Blob(["shared content"]));
      await ctx.db.insert("repoFileBlobs", {
        sha256: "shared-sha",
        storageId,
        size: 14,
        createdAt: now,
        lastAccessedAt: now,
        accessCount: 1,
      });
      for (const filePath of ["assets/first.png", "assets/second.png"]) {
        await ctx.db.insert("repoFileMap", {
          repositoryId,
          filePath,
          sha256: "shared-sha",
          size: 14,
          isText: false,
          indexVersion: 1,
          createdAt: now,
          updatedAt: now,
        });
      }
      await ctx.db.insert("repoFileMap", {
        repositoryId,
        filePath: "src/index.ts",
        sha256: "shared-sha",
        language: "TypeScript",
        size: 14,
        isText: true,
        indexVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
    });

    const binaryPage = await t.query(
      internal.repoIndexing.internalQuery.getRepositoryFilesPage,
      { repositoryId, indexVersion: 1, limit: 2 },
    );
    expect(binaryPage.files).toEqual([]);
    expect(binaryPage.hasMore).toBe(true);
    expect(binaryPage.cursor).toEqual(expect.any(String));

    const textPage = await t.query(
      internal.repoIndexing.internalQuery.getRepositoryFilesPage,
      {
        repositoryId,
        indexVersion: 1,
        limit: 2,
        cursor: binaryPage.cursor ?? undefined,
      },
    );
    expect(textPage).toMatchObject({ hasMore: false, cursor: null });
    expect(textPage.files).toHaveLength(1);
    expect(textPage.files[0]).toMatchObject({
      path: "src/index.ts",
      isText: true,
    });
  });

  it("hydrates reused chunk IDs from the requested index version", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, 1);

    await t.run(async (ctx) => {
      const now = Date.now();
      const insertChunk = async (indexVersion: number, code: string) => {
        await ctx.db.insert("repoChunks", {
          repositoryId,
          repositoryIndexKey: `${repositoryId}:${indexVersion}`,
          chunkId: "src/index.ts#1#1",
          path: "src/index.ts",
          language: "typescript",
          code,
          startLine: 1,
          endLine: 1,
          symbols: ["snapshot"],
          searchableText: code,
          contentHash: `${indexVersion}-hash`,
          indexVersion,
          createdAt: now,
          updatedAt: now,
        });
      };

      await insertChunk(1, "export const snapshot = 'old';");
      await insertChunk(2, "export const snapshot = 'new';");
    });

    const chunks = await t.query(internal.ragV2.internalQuery.getChunksByIds, {
      repositoryId,
      indexVersion: 1,
      chunkIds: ["src/index.ts#1#1"],
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      indexVersion: 1,
      code: "export const snapshot = 'old';",
    });

    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, { indexVersion: 2 });
    });

    const staleChunks = await t.query(
      internal.ragV2.internalQuery.getChunksByIds,
      {
        repositoryId,
        indexVersion: 1,
        chunkIds: ["src/index.ts#1#1"],
      },
    );

    expect(staleChunks).toEqual([]);
  });

  it("derives keyword scope server-side and rejects cross-repository keyed rows", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, 2, {
      installationId: 201,
      githubRepositoryId: 20_001,
    });
    const otherRepositoryId = await insertRepository(t, 2, {
      installationId: 202,
      githubRepositoryId: 20_002,
    });

    await t.run(async (ctx) => {
      const now = Date.now();
      const insertChunk = async (args: {
        repositoryId: Id<"repositories">;
        repositoryIndexKey: string;
        chunkId: string;
        path: string;
      }) =>
        await ctx.db.insert("repoChunks", {
          ...args,
          language: "typescript",
          code: "export const crossRepoNeedle = true;",
          startLine: 1,
          endLine: 1,
          symbols: ["crossRepoNeedle"],
          searchableText: "crossRepoNeedle export const true",
          contentHash: args.chunkId,
          indexVersion: 2,
          createdAt: now,
          updatedAt: now,
        });

      await insertChunk({
        repositoryId,
        repositoryIndexKey: `${repositoryId}:2`,
        chunkId: "owned-result",
        path: "src/owned.ts",
      });
      await insertChunk({
        repositoryId: otherRepositoryId,
        // Simulate a malformed or caller-targeted denormalized key. The
        // authoritative repositoryId must still keep this row out of scope.
        repositoryIndexKey: `${repositoryId}:2`,
        chunkId: "cross-repository-result",
        path: "src/other.ts",
      });
    });

    const results = await t.query(internal.ragV2.internalQuery.keywordSearch, {
      repositoryId,
      indexVersion: 2,
      query: "crossRepoNeedle",
      topK: 10,
    });

    expect(results.map((result) => result.chunkId)).toEqual(["owned-result"]);
  });

  it("blocks every cached RAG read while access-restore indexing is pending", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, 2, {
      installationId: 301,
      githubRepositoryId: 30_001,
    });
    const chunkId = await t.run(async (ctx) => {
      const now = Date.now();
      const id = await ctx.db.insert("repoChunks", {
        repositoryId,
        repositoryIndexKey: `${repositoryId}:2`,
        chunkId: "restore-pending-result",
        path: "src/pending.ts",
        language: "typescript",
        code: "export const restorePendingNeedle = true;",
        startLine: 1,
        endLine: 1,
        symbols: ["restorePendingNeedle"],
        embedding: [0.5],
        embeddingKey: "test-key",
        searchableText: "restorePendingNeedle export const true",
        contentHash: "restore-pending-hash",
        indexVersion: 2,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.patch(repositoryId, {
        githubAccessRestoreIndexPending: true,
        githubAccessRestoreIndexNextAttemptAt: now,
      });
      return id;
    });

    await expect(
      t.query(internal.ragV2.internalQuery.getChunksByDocIds, {
        repositoryId,
        indexVersion: 2,
        ids: [chunkId],
      }),
    ).resolves.toEqual([]);
    await expect(
      t.query(internal.ragV2.internalQuery.keywordSearch, {
        repositoryId,
        indexVersion: 2,
        query: "restorePendingNeedle",
        topK: 10,
      }),
    ).resolves.toEqual([]);
  });

  it("bounds direct cached RAG query fan-out and keyword results", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, 2, {
      installationId: 401,
      githubRepositoryId: 40_001,
    });
    const firstChunkId = await t.run(async (ctx) => {
      const now = Date.now();
      let firstId: Id<"repoChunks"> | undefined;
      for (let index = 0; index < 270; index++) {
        const id = await ctx.db.insert("repoChunks", {
          repositoryId,
          repositoryIndexKey: `${repositoryId}:2`,
          chunkId: `bounded-${index}`,
          path: `src/bounded-${index}.ts`,
          language: "typescript",
          code: `export const boundedNeedle${index} = true;`,
          startLine: 1,
          endLine: 1,
          symbols: [`boundedNeedle${index}`],
          embedding: [index / 1_000],
          embeddingKey: "test-key",
          searchableText: `boundedNeedle ${"x".repeat(40 * 1024)}`,
          contentHash: `bounded-hash-${index}`,
          indexVersion: 2,
          createdAt: now,
          updatedAt: now,
        });
        firstId ??= id;
      }
      if (!firstId) throw new Error("chunk fixture missing");
      return firstId;
    });

    await expect(
      t.query(internal.ragV2.internalQuery.getChunksByDocIds, {
        repositoryId,
        indexVersion: 2,
        ids: Array.from({ length: 257 }, () => firstChunkId),
      }),
    ).rejects.toThrow("vector chunk document batch exceeded its limit");

    const keywordResults = await t.query(
      internal.ragV2.internalQuery.keywordSearch,
      {
        repositoryId,
        indexVersion: 2,
        query: "boundedNeedle",
        topK: 1_000_000,
      },
    );
    expect(keywordResults).toHaveLength(128);

    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("repoChunks", {
        repositoryId,
        repositoryIndexKey: `${repositoryId}:2`,
        chunkId: "balanced-python",
        path: "src/balanced.py",
        language: "python",
        code: "balanced_needle = True",
        startLine: 1,
        endLine: 1,
        symbols: ["balanced_needle"],
        searchableText: `boundedNeedle ${"y".repeat(40 * 1024)}`,
        contentHash: "balanced-python-hash",
        indexVersion: 2,
        createdAt: now,
        updatedAt: now,
      });
    });
    const balancedResults = await t.query(
      internal.ragV2.internalQuery.keywordSearch,
      {
        repositoryId,
        indexVersion: 2,
        query: "boundedNeedle",
        topK: 128,
        filters: { language: ["TypeScript", "Python"] },
      },
    );
    expect(
      balancedResults.filter((result) => result.chunkId.startsWith("bounded-")),
    ).toHaveLength(64);
    expect(balancedResults.map((result) => result.chunkId)).toContain(
      "balanced-python",
    );
  });
});
