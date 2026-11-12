import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";

import { internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { persistRepositoryTreeSnapshot } from "../../../convex/repoIndexing/action";
import {
  buildRepositoryTreeSnapshotPages,
  getIndexableRepositoryFiles,
  getRepositoryTreeSnapshotAppendBatch,
  getRepositoryTreeSnapshotPagesBytes,
  REPOSITORY_TREE_SNAPSHOT_APPEND_MAX_BYTES,
  REPOSITORY_TREE_SNAPSHOT_CLEANUP_BATCH_SIZE,
} from "../../../convex/repoIndexing/treeSnapshot";
import schema from "../../../convex/schema";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/repoIndexing/internalQuery.ts": () =>
    import("../../../convex/repoIndexing/internalQuery"),
  "../../../convex/repoIndexing/internalAction.ts": () =>
    import("../../../convex/repoIndexing/internalAction"),
  "../../../convex/repoIndexing/mutation.ts": () =>
    import("../../../convex/repoIndexing/mutation"),
  "../../../convex/repoIndexing/watchdog.ts": () =>
    import("../../../convex/repoIndexing/watchdog"),
};

async function insertIndexingRepository(
  t: ReturnType<typeof convexTest>,
): Promise<Id<"repositories">> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const now = Date.now();
    return await ctx.db.insert("repositories", {
      indexSyncPending: false,
      ragTotalChunks: 0,
      ragIndexedChunks: 0,
      ragFailedChunks: 0,
      userId,
      installationId: 91,
      githubRepositoryId: 91 + 1_000,
      githubRepo: "owner/snapshot-repo",
      githubRepoKey: "owner/snapshot-repo",
      name: "snapshot-repo",
      githubUrl: "https://github.com/owner/snapshot-repo",
      isActive: true,
      indexVersion: 4,
      indexStatus: "indexing",
      ragStatus: "pending",
      indexProgressAt: now,
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

async function buildStagedSnapshot(
  t: ReturnType<typeof convexTest>,
  repositoryId: Id<"repositories">,
  pages: Array<Array<{ path: string; sha: string; size?: number }>>,
): Promise<Id<"repoTreeSnapshots">> {
  const begun = await t.mutation(
    internal.repoIndexing.mutation.beginIndexTreeSnapshot,
    {
      repositoryId,
      expectedIndexVersion: 4,
      defaultBranch: "main",
      commitSha: "commit",
      treeSha: "tree",
      totalFiles: pages.reduce((total, page) => total + page.length, 0),
      totalPages: pages.length,
    },
  );
  if (!begun) {
    throw new Error("snapshot construction was not accepted");
  }

  let nextPageIndex = begun.nextPageIndex;
  while (nextPageIndex < pages.length) {
    const batch = getRepositoryTreeSnapshotAppendBatch(pages, nextPageIndex);
    const appended = await t.mutation(
      internal.repoIndexing.mutation.appendIndexTreeSnapshotPages,
      {
        repositoryId,
        expectedIndexVersion: 4,
        snapshotId: begun.snapshotId,
        startPageIndex: nextPageIndex,
        pages: batch,
      },
    );
    if (!appended.accepted) {
      throw new Error("snapshot append was not accepted");
    }
    nextPageIndex = appended.nextPageIndex;
  }
  await t.mutation(internal.repoIndexing.mutation.finalizeIndexTreeSnapshot, {
    repositoryId,
    expectedIndexVersion: 4,
    snapshotId: begun.snapshotId,
  });
  return begun.snapshotId;
}

describe("repository tree snapshots", () => {
  it("filters and shards the recursive tree into bounded pages", () => {
    const files = getIndexableRepositoryFiles([
      { path: "src/index.ts", type: "blob", sha: "source", size: 50 },
      { path: "src", type: "tree", sha: "directory" },
      {
        path: "node_modules/pkg/index.js",
        type: "blob",
        sha: "dependency",
        size: 20,
      },
      {
        path: "large.txt",
        type: "blob",
        sha: "large",
        size: 1024 * 1024,
      },
      ...Array.from({ length: 80 }, (_, index) => ({
        path: `src/file-${index}.ts`,
        type: "blob" as const,
        sha: `sha-${index}`,
        size: 10,
      })),
    ]);

    expect(files[0]).toEqual({ path: "src/index.ts", sha: "source", size: 50 });
    expect(
      buildRepositoryTreeSnapshotPages(files).map((page) => page.length),
    ).toEqual([40, 40, 1]);
  });

  it("only excludes exact generated-directory path segments", () => {
    const files = getIndexableRepositoryFiles([
      { path: "src/layout/page.tsx", type: "blob", sha: "layout", size: 10 },
      { path: "src/rebuild/task.ts", type: "blob", sha: "rebuild", size: 10 },
      { path: "src/scout/report.ts", type: "blob", sha: "scout", size: 10 },
      { path: "out/generated.js", type: "blob", sha: "out", size: 10 },
      {
        path: "packages/app/build/generated.js",
        type: "blob",
        sha: "build",
        size: 10,
      },
      {
        path: "packages/app/node_modules/pkg/index.js",
        type: "blob",
        sha: "dependency",
        size: 10,
      },
    ]);

    expect(files.map((file) => file.path)).toEqual([
      "src/layout/page.tsx",
      "src/rebuild/task.ts",
      "src/scout/report.ts",
    ]);
  });

  it("splits a large synthetic tree across bounded append calls", () => {
    const pages = buildRepositoryTreeSnapshotPages(
      Array.from({ length: 20_001 }, (_, index) => ({
        path: `packages/${String(index).padStart(6, "0")}/${"nested/".repeat(12)}file.ts`,
        sha: `sha-${index}`,
        size: 10,
      })),
    );
    const batches: Array<
      Array<Array<{ path: string; sha: string; size?: number }>>
    > = [];
    let nextPageIndex = 0;
    while (nextPageIndex < pages.length) {
      const batch = getRepositoryTreeSnapshotAppendBatch(pages, nextPageIndex);
      batches.push(batch);
      nextPageIndex += batch.length;
    }

    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toHaveLength(pages.length);
    expect(
      batches.every(
        (batch) =>
          getRepositoryTreeSnapshotPagesBytes(batch) <=
          REPOSITORY_TREE_SNAPSHOT_APPEND_MAX_BYTES,
      ),
    ).toBe(true);
  });

  it("never sends all pages from a large tree in one function call", async () => {
    const repositoryId = "large-tree-repository" as Id<"repositories">;
    const snapshotId = "large-tree-snapshot" as Id<"repoTreeSnapshots">;
    const pages = buildRepositoryTreeSnapshotPages(
      Array.from({ length: 20_001 }, (_, index) => ({
        path: `packages/${String(index).padStart(6, "0")}/${"nested/".repeat(12)}file.ts`,
        sha: `sha-${index}`,
        size: 10,
      })),
    );
    const runMutation = vi.fn(async (_reference: unknown, args: unknown) => {
      if (typeof args === "object" && args !== null && "totalPages" in args) {
        return { snapshotId, nextPageIndex: 0, ready: false };
      }
      if (typeof args === "object" && args !== null && "pages" in args) {
        const append = args as {
          startPageIndex: number;
          pages: Array<Array<{ path: string; sha: string; size?: number }>>;
        };
        return {
          accepted: true,
          appended: append.pages.length,
          nextPageIndex: append.startPageIndex + append.pages.length,
          ready: false,
        };
      }
      return true;
    });

    await expect(
      persistRepositoryTreeSnapshot(
        { runMutation } as unknown as Parameters<
          typeof persistRepositoryTreeSnapshot
        >[0],
        {
          repositoryId,
          expectedIndexVersion: 4,
          defaultBranch: "main",
          commitSha: "commit",
          treeSha: "tree",
          pages,
        },
      ),
    ).resolves.toBe(snapshotId);

    const appendCalls = runMutation.mock.calls
      .map(([, args]) => args)
      .filter(
        (
          args,
        ): args is {
          pages: Array<Array<{ path: string; sha: string; size?: number }>>;
        } => typeof args === "object" && args !== null && "pages" in args,
      );
    expect(appendCalls.length).toBeGreaterThan(1);
    expect(
      appendCalls.every(
        (args) =>
          args.pages.length < pages.length &&
          getRepositoryTreeSnapshotPagesBytes(args.pages) <=
            REPOSITORY_TREE_SNAPSHOT_APPEND_MAX_BYTES,
      ),
    ).toBe(true);
  });

  it("stages contiguous pages, publishes exactly once, then cleans in bounded work", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertIndexingRepository(t);
    const pages = buildRepositoryTreeSnapshotPages(
      Array.from({ length: 81 }, (_, index) => ({
        path: `src/file-${index}.ts`,
        sha: `sha-${index}`,
        size: 10,
      })),
    );

    const begun = await t.mutation(
      internal.repoIndexing.mutation.beginIndexTreeSnapshot,
      {
        repositoryId,
        expectedIndexVersion: 4,
        defaultBranch: "main",
        commitSha: "commit",
        treeSha: "tree",
        totalFiles: 81,
        totalPages: 3,
      },
    );
    expect(begun).not.toBeNull();
    const snapshotId = begun!.snapshotId;

    await expect(
      t.query(internal.repoIndexing.internalQuery.getIndexTreeSnapshotPage, {
        repositoryId,
        expectedIndexVersion: 4,
        snapshotId,
        pageIndex: 0,
      }),
    ).resolves.toBeNull();
    const firstAppend = await t.mutation(
      internal.repoIndexing.mutation.appendIndexTreeSnapshotPages,
      {
        repositoryId,
        expectedIndexVersion: 4,
        snapshotId,
        startPageIndex: 0,
        pages: pages.slice(0, 2),
      },
    );
    expect(firstAppend).toMatchObject({
      accepted: true,
      appended: 2,
      nextPageIndex: 2,
    });
    await expect(
      t.mutation(internal.repoIndexing.mutation.appendIndexTreeSnapshotPages, {
        repositoryId,
        expectedIndexVersion: 4,
        snapshotId,
        startPageIndex: 0,
        pages: pages.slice(0, 2),
      }),
    ).resolves.toMatchObject({ accepted: true, appended: 0, nextPageIndex: 2 });
    await t.mutation(
      internal.repoIndexing.mutation.appendIndexTreeSnapshotPages,
      {
        repositoryId,
        expectedIndexVersion: 4,
        snapshotId,
        startPageIndex: 2,
        pages: pages.slice(2),
      },
    );
    await expect(
      t.mutation(internal.repoIndexing.mutation.finalizeIndexTreeSnapshot, {
        repositoryId,
        expectedIndexVersion: 4,
        snapshotId,
      }),
    ).resolves.toBe(true);

    const attached = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      manifest: await ctx.db.get(snapshotId),
      pages: await ctx.db
        .query("repoTreeSnapshotPages")
        .withIndex("by_snapshot", (q) => q.eq("snapshotId", snapshotId))
        .collect(),
    }));
    expect(attached.repository?.indexTreeSnapshotId).toBe(snapshotId);
    expect(attached.manifest).toMatchObject({
      totalFiles: 81,
      totalPages: 3,
      nextPageIndex: 3,
      status: "ready",
    });
    expect(attached.pages.map((page) => page.files.length)).toEqual([
      40, 40, 1,
    ]);

    await expect(
      t.query(internal.repoIndexing.internalQuery.getIndexTreeSnapshotPage, {
        repositoryId,
        expectedIndexVersion: 4,
        snapshotId,
        pageIndex: 1,
      }),
    ).resolves.toMatchObject({ pageIndex: 1, files: expect.any(Array) });
    await expect(
      t.mutation(internal.repoIndexing.mutation.releaseIndexTreeSnapshot, {
        repositoryId,
        expectedIndexVersion: 3,
        snapshotId,
      }),
    ).resolves.toBe(false);
    await expect(
      t.mutation(internal.repoIndexing.mutation.releaseIndexTreeSnapshot, {
        repositoryId,
        expectedIndexVersion: 4,
        snapshotId,
      }),
    ).resolves.toBe(true);

    await t.run(async (ctx) => {
      const scheduledCleanups = (
        await ctx.db.system.query("_scheduled_functions").collect()
      ).filter(
        (scheduled) =>
          scheduled.name ===
          "repoIndexing/mutation:continueIndexTreeSnapshotCleanup",
      );
      for (const cleanup of scheduledCleanups) {
        await ctx.scheduler.cancel(cleanup._id);
      }
    });

    const detached = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      manifest: await ctx.db.get(snapshotId),
    }));
    expect(detached.repository?.indexTreeSnapshotId).toBeUndefined();
    expect(detached.manifest?.status).toBe("deleting");

    await t.run(async (ctx) => {
      await ctx.db.patch(snapshotId, {
        updatedAt: Date.now() - 16 * 60 * 1000,
      });
    });
    await expect(
      t.action(
        internal.repoIndexing.internalAction.recoverTreeSnapshotCleanup,
        {},
      ),
    ).resolves.toEqual({ checked: 1, resumed: 1 });
    expect(await t.run(async (ctx) => await ctx.db.get(snapshotId))).toBeNull();
  });

  it("supports an empty repository without creating a synthetic page", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertIndexingRepository(t);
    const snapshotId = await buildStagedSnapshot(t, repositoryId, []);

    await expect(
      t.query(internal.repoIndexing.internalQuery.getIndexTreeSnapshotPage, {
        repositoryId,
        expectedIndexVersion: 4,
        snapshotId,
        pageIndex: 0,
      }),
    ).resolves.toMatchObject({ totalFiles: 0, totalPages: 0, files: [] });
  });

  it("cleans traversal queue rows and stored responses in bounded batches", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertIndexingRepository(t);
    const storedResponseIds = await t.run(async (ctx) => [
      await ctx.storage.store(new Blob(["first subtree response"])),
      await ctx.storage.store(new Blob(["second subtree response"])),
    ]);
    const snapshotId = await t.run(async (ctx) => {
      const now = Date.now();
      const createdSnapshotId = await ctx.db.insert("repoTreeSnapshots", {
        repositoryId,
        indexVersion: 4,
        defaultBranch: "main",
        commitSha: "commit",
        treeSha: "root-tree",
        totalFiles: 0,
        totalPages: 0,
        nextPageIndex: 0,
        traversalState: "traversing",
        traversalRequestCount: 2,
        traversalItemCount: 2,
        status: "deleting",
        createdAt: now,
        updatedAt: now,
      });
      for (
        let index = 0;
        index < REPOSITORY_TREE_SNAPSHOT_CLEANUP_BATCH_SIZE + 10;
        index++
      ) {
        await ctx.db.insert("repoTreeTraversalQueue", {
          snapshotId: createdSnapshotId,
          identityKey: `sha-${index}\u0000prefix-${index}`,
          sha: `sha-${index}`,
          prefix: `prefix-${index}`,
          ...(index < storedResponseIds.length
            ? { responseStorageId: storedResponseIds[index], totalItems: 1 }
            : {}),
          itemOffset: 0,
          createdAt: now,
          updatedAt: now,
        });
      }
      return createdSnapshotId;
    });

    await expect(
      t.mutation(
        internal.repoIndexing.mutation.continueIndexTreeSnapshotCleanup,
        { snapshotId },
      ),
    ).resolves.toEqual({
      deleted: REPOSITORY_TREE_SNAPSHOT_CLEANUP_BATCH_SIZE,
      hasMore: true,
      completed: false,
    });
    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query("repoTreeTraversalQueue")
          .withIndex("by_snapshot", (q) => q.eq("snapshotId", snapshotId))
          .collect(),
      ),
    ).toHaveLength(10);

    await expect(
      t.mutation(
        internal.repoIndexing.mutation.continueIndexTreeSnapshotCleanup,
        { snapshotId },
      ),
    ).resolves.toEqual({ deleted: 10, hasMore: false, completed: true });
    const cleaned = await t.run(async (ctx) => ({
      snapshot: await ctx.db.get(snapshotId),
      responseUrls: await Promise.all(
        storedResponseIds.map((storageId) => ctx.storage.getUrl(storageId)),
      ),
    }));
    expect(cleaned.snapshot).toBeNull();
    expect(cleaned.responseUrls).toEqual([null, null]);
  });
});
