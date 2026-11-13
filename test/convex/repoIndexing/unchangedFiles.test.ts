import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import schema from "../../../convex/schema";
import { RAG_CHUNKER_VERSION } from "../../../convex/ragV2/chunkPaths";
import { REFERENCED_BLOB_RECHECK_MS } from "../../../convex/repoIndexing/mutation";

const modules = import.meta.glob("../../../convex/**/*.ts");
type Backend = ReturnType<typeof convexTest>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function insertIndexingRepository(t: Backend) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("githubInstallations", {
      userId,
      installationId: 101,
      ownerGithubAccountId: "5001",
      ownershipVerifiedAt: now,
      accountLogin: "owner",
      accountType: "Organization",
      targetType: "Organization",
      createdAt: now,
      updatedAt: now,
    });
    const repositoryId = await ctx.db.insert("repositories", {
      userId,
      installationId: 101,
      githubRepositoryId: 1001,
      githubRepo: "owner/repo",
      githubRepoKey: "owner/repo",
      name: "repo",
      githubUrl: "https://github.com/owner/repo",
      isActive: true,
      indexVersion: 4,
      indexStatus: "indexing",
      indexProgressAt: now,
      indexIdentityVerifiedVersion: 4,
      indexIdentityVerifiedInstallationId: 101,
      indexIdentityVerifiedGithubRepositoryId: 1001,
      indexIdentityVerifiedGithubRepo: "owner/repo",
      ragStatus: "pending",
      ragTotalChunks: 0,
      ragIndexedChunks: 0,
      ragFailedChunks: 0,
      ragChunkLayout: "path_v1",
      ragChunkerVersion: RAG_CHUNKER_VERSION,
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
      lastResetAt: now,
      createdAt: now,
      updatedAt: now,
    });
    return { userId, repositoryId };
  });
}

async function insertFileMap(
  t: Backend,
  repositoryId: Id<"repositories">,
  filePath: string,
  sha256: string,
  indexVersion = 3,
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("repoFileMap", {
      repositoryId,
      filePath,
      sha256,
      language: "typescript",
      size: 10,
      isText: true,
      indexVersion,
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function insertChunk(
  t: Backend,
  repositoryId: Id<"repositories">,
  path: string,
) {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("repoChunks", {
      repositoryId,
      repositoryIndexKey: `${repositoryId}:3`,
      chunkId: `${path}#1#1`,
      path,
      language: "typescript",
      code: "x",
      startLine: 1,
      endLine: 1,
      symbols: [],
      searchableText: "x",
      contentHash: "h",
      indexVersion: 3,
      createdAt: now,
      updatedAt: now,
    });
  });
}

function publication(userId: Id<"users">, repositoryId: Id<"repositories">) {
  return {
    repositoryId,
    expectedUserId: userId,
    expectedInstallationId: 101,
    expectedGithubRepositoryId: 1001,
    expectedGithubRepo: "owner/repo",
    expectedIndexVersion: 4,
  };
}

describe("unchanged file reuse", () => {
  it("moves unchanged maps to the new generation and reports changed paths", async () => {
    const t = convexTest(schema, modules);
    const { userId, repositoryId } = await insertIndexingRepository(t);
    const sameId = await insertFileMap(t, repositoryId, "same.ts", "sha-same");
    await insertFileMap(t, repositoryId, "edited.ts", "sha-old");

    const result = await t.mutation(
      internal.repoIndexing.mutation.reuseUnchangedFileMaps,
      {
        ...publication(userId, repositoryId),
        files: [
          {
            filePath: "same.ts",
            sha256: "sha-same",
            language: "typescript",
            size: 10,
            isText: true,
          },
          {
            filePath: "edited.ts",
            sha256: "sha-new",
            language: "typescript",
            size: 10,
            isText: true,
          },
          {
            filePath: "added.ts",
            sha256: "sha-added",
            language: "typescript",
            size: 10,
            isText: true,
          },
        ],
      },
    );

    expect(result).toEqual({ changedPaths: ["edited.ts", "added.ts"] });
    const same = await t.run((ctx) => ctx.db.get(sameId));
    expect(same).toMatchObject({ indexVersion: 4, sha256: "sha-same" });
    expect(same?.ragPending).toBeUndefined();
  });

  it("refuses work for a generation it does not own", async () => {
    const t = convexTest(schema, modules);
    const { userId, repositoryId } = await insertIndexingRepository(t);
    const mapId = await insertFileMap(t, repositoryId, "same.ts", "sha-same");
    const result = await t.mutation(
      internal.repoIndexing.mutation.reuseUnchangedFileMaps,
      {
        ...publication(userId, repositoryId),
        expectedIndexVersion: 3,
        files: [
          {
            filePath: "same.ts",
            sha256: "sha-same",
            language: "typescript",
            size: 10,
            isText: true,
          },
        ],
      },
    );
    expect(result).toBe("stale");
    expect(await t.run((ctx) => ctx.db.get(mapId))).toMatchObject({
      indexVersion: 3,
    });
  });

  it("flags only new or edited paths for re-chunking", async () => {
    const t = convexTest(schema, modules);
    const { repositoryId } = await insertIndexingRepository(t);
    await insertFileMap(t, repositoryId, "edited.ts", "sha-old");
    for (const [filePath, sha256] of [
      ["edited.ts", "sha-new"],
      ["added.bin", "sha-bin"],
    ]) {
      await t.mutation(internal.repoIndexing.mutation.mapFile, {
        repositoryId,
        filePath,
        sha256,
        size: 10,
        isText: false,
        indexVersion: 4,
      });
    }
    const maps = await t.run((ctx) =>
      ctx.db
        .query("repoFileMap")
        .withIndex("by_repository", (q) => q.eq("repositoryId", repositoryId))
        .collect(),
    );
    expect(maps.map((map) => [map.filePath, map.ragPending]).sort()).toEqual([
      ["added.bin", true],
      ["edited.ts", true],
    ]);
  });

  it("removes the chunks of paths that left the tree with their map rows", async () => {
    const t = convexTest(schema, modules);
    const { repositoryId } = await insertIndexingRepository(t);
    await insertFileMap(t, repositoryId, "kept.ts", "sha-kept", 4);
    await insertFileMap(t, repositoryId, "removed.ts", "sha-removed", 3);
    await insertChunk(t, repositoryId, "kept.ts");
    await insertChunk(t, repositoryId, "removed.ts");

    const result = await t.mutation(
      internal.repoIndexing.mutation.continueFileMapCleanup,
      { repositoryId, expectedIndexVersion: 4, totalFiles: 1 },
    );
    expect(result).toMatchObject({ accepted: true, completed: true });

    const state = await t.run(async (ctx) => ({
      maps: await ctx.db
        .query("repoFileMap")
        .withIndex("by_repository", (q) => q.eq("repositoryId", repositoryId))
        .collect(),
      chunks: await ctx.db
        .query("repoChunks")
        .withIndex("by_repository", (q) => q.eq("repositoryId", repositoryId))
        .collect(),
    }));
    expect(state.maps.map((map) => map.filePath)).toEqual(["kept.ts"]);
    expect(state.chunks.map((chunk) => chunk.path)).toEqual(["kept.ts"]);
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system
        .query("_scheduled_functions")
        .take(100)) {
        if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
      }
    });
  });

  it("marks an owner-requested sync as a full chunk rebuild", async () => {
    const t = convexTest(schema, modules);
    const { repositoryId } = await insertIndexingRepository(t);
    await t.run((ctx) =>
      ctx.db.patch(repositoryId, {
        indexStatus: "completed",
        ragStatus: "completed",
      }),
    );
    const prepared = await t.mutation(
      internal.repoIndexing.mutation.prepareIncrementalIndex,
      { repositoryId, fullRebuild: true },
    );
    expect(prepared.success).toBe(true);
    expect(await t.run((ctx) => ctx.db.get(repositoryId))).toMatchObject({
      ragFullRebuildRequested: true,
    });
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system
        .query("_scheduled_functions")
        .take(100)) {
        if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
      }
    });
  });

  it("rechecks a referenced stale blob only after a long interval", async () => {
    const t = convexTest(schema, modules);
    const { repositoryId } = await insertIndexingRepository(t);
    await insertFileMap(t, repositoryId, "kept.ts", "sha-kept", 4);
    const blobId = await t.run(async (ctx) => {
      const old = Date.now() - 8 * 24 * 60 * 60 * 1_000;
      return await ctx.db.insert("repoFileBlobs", {
        sha256: "sha-kept",
        storageId: await ctx.storage.store(new Blob(["x"])),
        size: 1,
        createdAt: old,
        lastAccessedAt: old,
        accessCount: 1,
      });
    });
    const threshold = Date.now() - 7 * 24 * 60 * 60 * 1_000;
    expect(
      await t.mutation(internal.repoIndexing.mutation.deleteFileBlobIfStale, {
        blobId,
        threshold,
      }),
    ).toBe(false);
    const blob = await t.run((ctx) => ctx.db.get(blobId));
    expect(blob?.lastAccessedAt).toBeGreaterThanOrEqual(
      Date.now() + REFERENCED_BLOB_RECHECK_MS - 1_000,
    );
    const stale = await t.query(
      internal.repoIndexing.internalQuery.getStaleFileBlobs,
      { threshold },
    );
    expect(stale).toHaveLength(0);
  });
});
