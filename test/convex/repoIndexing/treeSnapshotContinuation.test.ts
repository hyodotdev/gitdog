import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  internalAction,
  internalMutation,
} from "../../../convex/_generated/server";
import * as githubHelpers from "../../../convex/github/helpers";
import { attachTreeTraversalResponseWithCleanup } from "../../../convex/repoIndexing/action";
import schema from "../../../convex/schema";
import { v } from "convex/values";

const noopGenerateChunkEmbeddings = internalAction({
  args: {
    repositoryId: v.id("repositories"),
    indexVersion: v.optional(v.number()),
  },
  handler: async () => ({ success: true }),
});

const noopCreateAiLog = internalMutation({
  args: {
    repositoryId: v.optional(v.id("repositories")),
    userId: v.optional(v.id("users")),
    workflowType: v.string(),
    actionType: v.optional(v.string()),
    githubRepo: v.optional(v.string()),
    status: v.union(v.literal("success"), v.literal("failed")),
    errorMessage: v.optional(v.string()),
    durationMs: v.optional(v.number()),
  },
  handler: async () => undefined,
});

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/github/query.ts": () =>
    import("../../../convex/github/query"),
  "../../../convex/github/internalQuery.ts": () =>
    import("../../../convex/github/internalQuery"),
  "../../../convex/repositories/internalQuery.ts": () =>
    import("../../../convex/repositories/internalQuery"),
  "../../../convex/repositories/internalMutation.ts": () =>
    import("../../../convex/repositories/internalMutation"),
  "../../../convex/repoIndexing/internalQuery.ts": () =>
    import("../../../convex/repoIndexing/internalQuery"),
  "../../../convex/repoIndexing/action.ts": () =>
    import("../../../convex/repoIndexing/action"),
  "../../../convex/repoIndexing/mutation.ts": () =>
    import("../../../convex/repoIndexing/mutation"),
  "../../../convex/repoIndexing/watchdog.ts": () =>
    import("../../../convex/repoIndexing/watchdog"),
  "../../../convex/ragV2/action.ts": async () => ({
    generateChunkEmbeddings: noopGenerateChunkEmbeddings,
  }),
  "../../../convex/ragV2/internalMutation.ts": () =>
    import("../../../convex/ragV2/internalMutation"),
  "../../../convex/admin/internalMutation.ts": async () => ({
    createAiLog: noopCreateAiLog,
  }),
};

const originalGitHubAppId = process.env.GITHUB_APP_ID;
const originalGitHubAppPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY;
const originalFetch = globalThis.fetch;
const GITHUB_REPOSITORY_ID = 456;
const AUTHORITATIVE_REPOSITORY_URL = `https://api.github.com/repositories/${GITHUB_REPOSITORY_ID}`;

const timerApi = vi as unknown as {
  useFakeTimers?: () => void;
  useRealTimers?: () => void;
  isFakeTimers?: () => boolean;
  clearAllTimers?: () => void;
  advanceTimersByTime?: (milliseconds: number) => void;
  advanceTimersByTimeAsync?: (milliseconds: number) => Promise<void>;
};
const supportsManagedTimers =
  typeof timerApi.useFakeTimers === "function" &&
  (typeof timerApi.advanceTimersByTimeAsync === "function" ||
    typeof timerApi.advanceTimersByTime === "function");

async function yieldToRuntime(): Promise<void> {
  await new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(undefined);
  });
}

async function advanceTestTime(milliseconds: number): Promise<void> {
  if (timerApi.advanceTimersByTimeAsync) {
    await timerApi.advanceTimersByTimeAsync(milliseconds);
    return;
  }
  if (timerApi.advanceTimersByTime) {
    await yieldToRuntime();
    timerApi.advanceTimersByTime(milliseconds);
    await yieldToRuntime();
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function restoreEnvironmentValue(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function insertPendingRepository(
  t: ReturnType<typeof convexTest>,
): Promise<Id<"repositories">> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const now = Date.now();
    await ctx.db.insert("githubInstallations", {
      userId,
      installationId: 812,
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
      installationId: 812,
      githubRepositoryId: GITHUB_REPOSITORY_ID,
      githubRepo: "owner/large-repo",
      githubRepoKey: "owner/large-repo",
      name: "large-repo",
      githubUrl: "https://github.com/owner/large-repo",
      githubVisibility: "public",
      licenseKey: "mit",
      licenseSpdxId: "MIT",
      licenseOsiApproved: true,
      licenseOsiCheckedAt: now,
      repositoryMetadataCheckedAt: now,
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
    });
  });
}

async function seedAttachedTraversalResponse(
  t: ReturnType<typeof convexTest>,
  repositoryId: Id<"repositories">,
) {
  await t.run(async (ctx) => {
    await ctx.db.patch(repositoryId, {
      indexStatus: "indexing",
      indexIdentityVerifiedVersion: 1,
      indexIdentityVerifiedInstallationId: 812,
      indexIdentityVerifiedGithubRepositoryId: GITHUB_REPOSITORY_ID,
      indexIdentityVerifiedGithubRepo: "owner/large-repo",
    });
  });
  const traversal = await t.mutation(
    internal.repoIndexing.mutation.beginIndexTreeTraversal,
    {
      repositoryId,
      expectedIndexVersion: 1,
      defaultBranch: "main",
      commitSha: "attached-commit",
      treeSha: "attached-root",
    },
  );
  if (!traversal) throw new Error("traversal fixture was not created");
  const claim = await t.mutation(
    internal.repoIndexing.mutation.claimIndexTreeTraversal,
    {
      repositoryId,
      expectedIndexVersion: 1,
      snapshotId: traversal.snapshotId,
    },
  );
  if (!claim) throw new Error("traversal fixture was not claimed");
  const responseStorageId = await t.run(async (ctx) =>
    ctx.storage.store(
      new Blob([
        JSON.stringify({
          tree: [
            {
              path: "src/recovered.ts",
              mode: "100644",
              type: "blob",
              sha: "recovered-blob",
              size: 20,
            },
          ],
          truncated: false,
        }),
      ]),
    ),
  );
  await t.mutation(
    internal.repoIndexing.mutation.attachIndexTreeTraversalResponse,
    {
      repositoryId,
      expectedIndexVersion: 1,
      snapshotId: traversal.snapshotId,
      queueId: claim.queueId,
      claimToken: claim.claimToken,
      responseStorageId,
      totalItems: 1,
    },
  );
  await t.run(async (ctx) => {
    await ctx.db.patch(traversal.snapshotId, {
      traversalClaimToken: undefined,
      traversalClaimedAt: undefined,
    });
  });
  return { snapshotId: traversal.snapshotId, responseStorageId };
}

beforeEach(() => {
  if (supportsManagedTimers) {
    timerApi.useFakeTimers?.();
  }
  process.env.GITHUB_APP_ID = "test-app-id";
  process.env.GITHUB_APP_PRIVATE_KEY = "test-private-key";
  vi.clearAllMocks();
  vi.spyOn(githubHelpers, "getRepositoryInstallationToken").mockResolvedValue(
    "installation-token",
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  if (timerApi.isFakeTimers?.()) {
    timerApi.clearAllTimers?.();
  }
  timerApi.useRealTimers?.();
  restoreEnvironmentValue("GITHUB_APP_ID", originalGitHubAppId);
  restoreEnvironmentValue(
    "GITHUB_APP_PRIVATE_KEY",
    originalGitHubAppPrivateKey,
  );
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("repository tree snapshot continuations", () => {
  it("requests reference-aware cleanup after an ambiguous traversal attach", async () => {
    const ambiguousError = new Error("ambiguous traversal attach");
    const runMutation = vi
      .fn()
      .mockRejectedValueOnce(ambiguousError)
      .mockResolvedValueOnce(true);
    const responseStorageId = "response-storage" as Id<"_storage">;

    await expect(
      attachTreeTraversalResponseWithCleanup(
        { runMutation } as unknown as Parameters<
          typeof attachTreeTraversalResponseWithCleanup
        >[0],
        {
          repositoryId: "repository" as Id<"repositories">,
          expectedIndexVersion: 1,
          snapshotId: "snapshot" as Id<"repoTreeSnapshots">,
          queueId: "queue" as Id<"repoTreeTraversalQueue">,
          claimToken: "claim",
          responseStorageId,
          totalItems: 1,
        },
      ),
    ).rejects.toBe(ambiguousError);
    expect(runMutation).toHaveBeenNthCalledWith(
      2,
      internal.repoIndexing.mutation
        .deleteUnpublishedTreeTraversalResponseStorage,
      { storageId: responseStorageId },
    );
  });

  it("deletes only unreferenced traversal response uploads", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertPendingRepository(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, { indexStatus: "indexing" });
    });
    const traversal = await t.mutation(
      internal.repoIndexing.mutation.beginIndexTreeTraversal,
      {
        repositoryId,
        expectedIndexVersion: 1,
        defaultBranch: "main",
        commitSha: "cleanup-commit",
        treeSha: "cleanup-root",
      },
    );
    if (!traversal) throw new Error("traversal fixture was not created");
    const claim = await t.mutation(
      internal.repoIndexing.mutation.claimIndexTreeTraversal,
      {
        repositoryId,
        expectedIndexVersion: 1,
        snapshotId: traversal.snapshotId,
      },
    );
    if (!claim) throw new Error("traversal fixture was not claimed");
    const referencedStorageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["referenced response"])),
    );
    await t.mutation(
      internal.repoIndexing.mutation.attachIndexTreeTraversalResponse,
      {
        repositoryId,
        expectedIndexVersion: 1,
        snapshotId: traversal.snapshotId,
        queueId: claim.queueId,
        claimToken: claim.claimToken,
        responseStorageId: referencedStorageId,
        totalItems: 1,
      },
    );
    const orphanStorageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["orphan response"])),
    );

    await expect(
      t.mutation(
        internal.repoIndexing.mutation
          .deleteUnpublishedTreeTraversalResponseStorage,
        { storageId: referencedStorageId },
      ),
    ).resolves.toBe(false);
    await expect(
      t.mutation(
        internal.repoIndexing.mutation
          .deleteUnpublishedTreeTraversalResponseStorage,
        { storageId: orphanStorageId },
      ),
    ).resolves.toBe(true);
    const storage = await t.run(async (ctx) => ({
      referenced: await ctx.storage.getUrl(referencedStorageId),
      orphan: await ctx.storage.getUrl(orphanStorageId),
    }));
    expect(storage.referenced).not.toBeNull();
    expect(storage.orphan).toBeNull();
  });

  it("durably defers a continuation while installation reconciliation is active", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertPendingRepository(t);
    await t.run(async (ctx) => {
      const installation = await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) => q.eq("installationId", 812))
        .unique();
      if (!installation) throw new Error("installation fixture missing");
      await ctx.db.patch(installation._id, {
        repositoryAccessReconciliationPhase: "fetching",
      });
      await ctx.db.patch(repositoryId, { indexStatus: "indexing" });
    });
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      t.action(internal.repoIndexing.action.indexRepository, {
        repositoryId,
        expectedIndexVersion: 1,
        continuation: true,
      }),
    ).resolves.toMatchObject({ success: true, filesIndexed: 0 });

    const deferred = await t.run(async (ctx) => ctx.db.get(repositoryId));
    expect(deferred?.indexStatus).toBe("indexing");
    expect(typeof deferred?.indexRateLimitRetryToken).toBe("string");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("durably resumes the exact continuation after token rate limiting", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertPendingRepository(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, { indexStatus: "indexing" });
    });
    const snapshot = await t.mutation(
      internal.repoIndexing.mutation.beginIndexTreeSnapshot,
      {
        repositoryId,
        expectedIndexVersion: 1,
        defaultBranch: "main",
        commitSha: "token-rate-limit-commit",
        treeSha: "token-rate-limit-tree",
        totalFiles: 80,
        totalPages: 2,
      },
    );
    if (!snapshot) throw new Error("snapshot fixture was not created");
    const snapshotPages = Array.from({ length: 2 }, (_, pageIndex) =>
      Array.from({ length: 40 }, (_, fileIndex) => ({
        path: `src/page-${pageIndex}-file-${fileIndex}.ts`,
        sha: `page-${pageIndex}-sha-${fileIndex}`,
        size: 20,
      })),
    );
    await expect(
      t.mutation(internal.repoIndexing.mutation.appendIndexTreeSnapshotPages, {
        repositoryId,
        expectedIndexVersion: 1,
        snapshotId: snapshot.snapshotId,
        startPageIndex: 0,
        pages: snapshotPages,
      }),
    ).resolves.toMatchObject({ accepted: true, nextPageIndex: 2 });
    await expect(
      t.mutation(internal.repoIndexing.mutation.finalizeIndexTreeSnapshot, {
        repositoryId,
        expectedIndexVersion: 1,
        snapshotId: snapshot.snapshotId,
      }),
    ).resolves.toBe(true);

    const retryAt = Date.now() + 90_000;
    vi.spyOn(
      githubHelpers,
      "getRepositoryInstallationToken",
    ).mockRejectedValueOnce(
      new githubHelpers.GitHubAppRateLimitError(
        "GitHub repository-scoped installation token request",
        retryAt,
        429,
      ),
    );

    await expect(
      t.action(internal.repoIndexing.action.indexRepository, {
        repositoryId,
        expectedIndexVersion: 1,
        continuation: true,
        pageIndex: 1,
        treeSnapshotId: snapshot.snapshotId,
        fileOffset: 7,
      }),
    ).resolves.toMatchObject({
      success: true,
      filesIndexed: 47,
      indexVersion: 1,
    });

    const deferred = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(deferred.repository).toMatchObject({
      indexVersion: 1,
      indexStatus: "indexing",
      ragStatus: "pending",
      indexRateLimitRetryAt: retryAt,
    });
    expect(deferred.repository?.indexError).toBeUndefined();
    expect(typeof deferred.repository?.indexRateLimitRetryToken).toBe("string");

    const retryJob = deferred.scheduled.find(
      (job) =>
        job.name === "repoIndexing/action:indexRepository" &&
        (job.args[0] as { rateLimitResume?: boolean }).rateLimitResume === true,
    );
    expect(retryJob).toBeDefined();
    expect(retryJob?.args[0]).toMatchObject({
      repositoryId,
      expectedIndexVersion: 1,
      continuation: true,
      pageIndex: 1,
      treeSnapshotId: snapshot.snapshotId,
      fileOffset: 7,
      rateLimitResume: true,
      rateLimitRetryToken: deferred.repository?.indexRateLimitRetryToken,
    });

    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, {
        indexRateLimitRetryAt: Date.now() - 1,
      });
    });
    await expect(
      t.mutation(internal.repoIndexing.mutation.claimRateLimitedIndexRetry, {
        repositoryId,
        expectedIndexVersion: 1,
        retryToken: deferred.repository!.indexRateLimitRetryToken!,
      }),
    ).resolves.toBe(true);
    expect(await t.run(async (ctx) => ctx.db.get(repositoryId))).toMatchObject({
      indexVersion: 1,
      indexStatus: "indexing",
      ragStatus: "pending",
    });
    expect(
      (await t.run(async (ctx) => ctx.db.get(repositoryId)))
        ?.indexRateLimitRetryToken,
    ).toBeUndefined();
  });

  it("atomically releases the exact subtree claim for a rate-limit resume", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertPendingRepository(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, { indexStatus: "indexing" });
    });
    const traversal = await t.mutation(
      internal.repoIndexing.mutation.beginIndexTreeTraversal,
      {
        repositoryId,
        expectedIndexVersion: 1,
        defaultBranch: "main",
        commitSha: "rate-limit-commit",
        treeSha: "rate-limit-root",
      },
    );
    const snapshotId = traversal!.snapshotId;
    const firstClaim = await t.mutation(
      internal.repoIndexing.mutation.claimIndexTreeTraversal,
      {
        repositoryId,
        expectedIndexVersion: 1,
        snapshotId,
      },
    );

    await expect(
      t.mutation(internal.repoIndexing.mutation.scheduleRateLimitedIndexRetry, {
        repositoryId,
        expectedIndexVersion: 1,
        retryAt: Date.now() + 1_000,
        continuation: true,
        treeTraversal: true,
        treeSnapshotId: snapshotId,
        treeTraversalClaimToken: "stale-claim",
      }),
    ).resolves.toBe(false);
    expect(
      await t.run(
        async (ctx) => (await ctx.db.get(snapshotId))?.traversalClaimToken,
      ),
    ).toBe(firstClaim!.claimToken);

    await expect(
      t.mutation(internal.repoIndexing.mutation.scheduleRateLimitedIndexRetry, {
        repositoryId,
        expectedIndexVersion: 1,
        retryAt: Date.now() + 1_000,
        continuation: true,
        treeTraversal: true,
        treeSnapshotId: snapshotId,
        treeTraversalClaimToken: firstClaim!.claimToken,
      }),
    ).resolves.toBe(true);
    const deferred = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      snapshot: await ctx.db.get(snapshotId),
    }));
    expect(deferred.snapshot?.traversalClaimToken).toBeUndefined();
    expect(typeof deferred.repository?.indexRateLimitRetryToken).toBe("string");

    await expect(
      t.mutation(internal.repoIndexing.mutation.claimRateLimitedIndexRetry, {
        repositoryId,
        expectedIndexVersion: 1,
        retryToken: deferred.repository!.indexRateLimitRetryToken!,
      }),
    ).resolves.toBe(true);
    await expect(
      t.mutation(internal.repoIndexing.mutation.claimIndexTreeTraversal, {
        repositoryId,
        expectedIndexVersion: 1,
        snapshotId,
      }),
    ).resolves.toMatchObject({
      queueId: firstClaim!.queueId,
      sha: "rate-limit-root",
    });
  });

  it("retries an attached subtree response at the exact durable cursor", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertPendingRepository(t);
    const { snapshotId, responseStorageId } =
      await seedAttachedTraversalResponse(t, repositoryId);
    let storageReads = 0;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.startsWith("https://api.github.com/")) {
        throw new Error(`Unexpected GitHub request: ${url}`);
      }
      storageReads++;
      if (storageReads === 1) {
        return new Response("temporarily unavailable", { status: 503 });
      }
      return Response.json({
        tree: [
          {
            path: "src/recovered.ts",
            mode: "100644",
            type: "blob",
            sha: "recovered-blob",
            size: 20,
          },
        ],
        truncated: false,
      });
    }) as typeof fetch;

    await expect(
      t.action(internal.repoIndexing.action.indexRepository, {
        repositoryId,
        expectedIndexVersion: 1,
        continuation: true,
        treeTraversal: true,
        treeSnapshotId: snapshotId,
      }),
    ).resolves.toMatchObject({ success: true, filesIndexed: 0 });
    const deferred = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      snapshot: await ctx.db.get(snapshotId),
      queue: await ctx.db
        .query("repoTreeTraversalQueue")
        .withIndex("by_snapshot", (q) => q.eq("snapshotId", snapshotId))
        .first(),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(storageReads).toBe(1);
    expect(deferred.repository?.indexStatus).toBe("indexing");
    expect(typeof deferred.repository?.indexRateLimitRetryToken).toBe("string");
    expect(deferred.snapshot?.traversalClaimToken).toBeUndefined();
    expect(deferred.queue).toMatchObject({
      responseStorageId,
      itemOffset: 0,
      totalItems: 1,
    });
    expect(
      deferred.scheduled.some(
        (job) =>
          job.name === "repoIndexing/action:indexRepository" &&
          (job.args[0] as { treeResponseRetryAttempt?: number })
            .treeResponseRetryAttempt === 1,
      ),
    ).toBe(true);

    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, {
        indexRateLimitRetryAt: Date.now() - 1,
      });
    });
    await expect(
      t.action(internal.repoIndexing.action.indexRepository, {
        repositoryId,
        expectedIndexVersion: 1,
        continuation: true,
        treeTraversal: true,
        treeSnapshotId: snapshotId,
        rateLimitResume: true,
        rateLimitRetryToken: deferred.repository!.indexRateLimitRetryToken!,
        treeResponseRetryAttempt: 1,
      }),
    ).resolves.toMatchObject({ success: true, filesIndexed: 1 });

    const recovered = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      snapshot: await ctx.db.get(snapshotId),
      queue: await ctx.db
        .query("repoTreeTraversalQueue")
        .withIndex("by_snapshot", (q) => q.eq("snapshotId", snapshotId))
        .collect(),
    }));
    expect(storageReads).toBe(2);
    expect(recovered.repository?.indexStatus).toBe("indexing");
    expect(recovered.snapshot).toMatchObject({
      status: "ready",
      totalFiles: 1,
    });
    expect(recovered.queue).toHaveLength(0);
  });

  it("fails an attached subtree response after the bounded retry maximum", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertPendingRepository(t);
    const { snapshotId } = await seedAttachedTraversalResponse(t, repositoryId);
    let storageReads = 0;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.startsWith("https://api.github.com/")) {
        throw new Error(`Unexpected GitHub request: ${url}`);
      }
      storageReads++;
      return new Response("still unavailable", { status: 503 });
    }) as typeof fetch;

    await expect(
      t.action(internal.repoIndexing.action.indexRepository, {
        repositoryId,
        expectedIndexVersion: 1,
        continuation: true,
        treeTraversal: true,
        treeSnapshotId: snapshotId,
        treeResponseRetryAttempt: 6,
      }),
    ).rejects.toThrow("retry limit reached after 6 attempts");

    const failed = await t.run(async (ctx) => ctx.db.get(repositoryId));
    expect(storageReads).toBe(1);
    expect(failed).toMatchObject({
      indexStatus: "failed",
      indexError: expect.stringContaining(
        "retry limit reached after 6 attempts",
      ),
      ragStatus: "failed",
      ragError: expect.stringContaining("retry limit reached after 6 attempts"),
    });
    expect(failed?.indexRateLimitRetryToken).toBeUndefined();
  });

  it("resumes a deferred subtree immediately after installation recovery", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertPendingRepository(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, {
        indexStatus: "indexing",
        indexIdentityVerifiedVersion: 1,
        indexIdentityVerifiedInstallationId: 812,
        indexIdentityVerifiedGithubRepositoryId: GITHUB_REPOSITORY_ID,
        indexIdentityVerifiedGithubRepo: "owner/large-repo",
      });
    });
    const traversal = await t.mutation(
      internal.repoIndexing.mutation.beginIndexTreeTraversal,
      {
        repositoryId,
        expectedIndexVersion: 1,
        defaultBranch: "main",
        commitSha: "deferred-commit",
        treeSha: "deferred-root",
      },
    );
    const snapshotId = traversal!.snapshotId;
    let installationRecovered = false;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (!url.endsWith("/git/trees/deferred-root")) {
        throw new Error(`Unexpected request: ${url}`);
      }
      if (!installationRecovered) {
        await t.run(async (ctx) => {
          const installation = await ctx.db
            .query("githubInstallations")
            .withIndex("by_installation_id", (q) => q.eq("installationId", 812))
            .first();
          if (!installation) throw new Error("installation fixture missing");
          await ctx.db.patch(installation._id, {
            repositoryRemovalPendingAt: Date.now(),
          });
        });
        return new Response("installation changed", { status: 404 });
      }
      return Response.json({ tree: [], truncated: false });
    }) as typeof fetch;

    await expect(
      t.action(internal.repoIndexing.action.indexRepository, {
        repositoryId,
        expectedIndexVersion: 1,
        continuation: true,
        treeTraversal: true,
        treeSnapshotId: snapshotId,
      }),
    ).resolves.toMatchObject({ success: true, filesIndexed: 0 });
    const deferred = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      snapshot: await ctx.db.get(snapshotId),
    }));
    expect(deferred.snapshot?.traversalClaimToken).toBeUndefined();
    expect(typeof deferred.repository?.indexRateLimitRetryToken).toBe("string");

    installationRecovered = true;
    await t.run(async (ctx) => {
      const installation = await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) => q.eq("installationId", 812))
        .first();
      if (!installation) throw new Error("installation fixture missing");
      await ctx.db.patch(installation._id, {
        repositoryRemovalPendingAt: undefined,
      });
      await ctx.db.patch(repositoryId, {
        indexRateLimitRetryAt: Date.now() - 1,
      });
    });
    await expect(
      t.action(internal.repoIndexing.action.indexRepository, {
        repositoryId,
        expectedIndexVersion: 1,
        continuation: true,
        treeTraversal: true,
        treeSnapshotId: snapshotId,
        rateLimitResume: true,
        rateLimitRetryToken: deferred.repository!.indexRateLimitRetryToken!,
      }),
    ).resolves.toMatchObject({ success: true, filesIndexed: 0 });
    expect(await t.run(async (ctx) => ctx.db.get(snapshotId))).toMatchObject({
      status: "ready",
      totalFiles: 0,
    });
  });

  it("reuses the tree without another token for a content-free page", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertPendingRepository(t);
    const recursiveTreeUrl =
      "https://api.github.com/repos/owner/large-repo/git/trees/tree-sha?recursive=1";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url === AUTHORITATIVE_REPOSITORY_URL) {
        return new Response(
          JSON.stringify({
            id: GITHUB_REPOSITORY_ID,
            full_name: "owner/large-repo",
            default_branch: "main",
            visibility: "public",
            private: false,
            license: { key: "mit", spdx_id: "MIT" },
          }),
          { status: 200 },
        );
      }
      if (
        url === "https://api.github.com/repos/owner/large-repo/commits/main"
      ) {
        return new Response(
          JSON.stringify({
            sha: "commit-sha",
            commit: { tree: { sha: "tree-sha" } },
          }),
          { status: 200 },
        );
      }
      if (url === recursiveTreeUrl) {
        return new Response(
          JSON.stringify({
            truncated: false,
            tree: Array.from({ length: 81 }, (_, index) => ({
              path: `assets/image-${index}.png`,
              mode: "100644",
              type: "blob",
              sha: `sha-${index}`,
              size: 100,
              url: `https://api.github.com/blob/${index}`,
            })),
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      t.action(internal.repoIndexing.action.indexRepository, {
        repositoryId,
        expectedIndexVersion: 1,
      }),
    ).resolves.toMatchObject({ success: true, filesIndexed: 40 });

    const afterFirstPage = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      fileCount: (
        await ctx.db
          .query("repoFileMap")
          .withIndex("by_repository", (q) => q.eq("repositoryId", repositoryId))
          .collect()
      ).length,
    }));
    const treeSnapshotId = afterFirstPage.repository?.indexTreeSnapshotId;
    expect(treeSnapshotId).toBeDefined();
    expect(afterFirstPage.fileCount).toBe(40);
    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query("repoTreeSnapshotPages")
          .withIndex("by_snapshot", (q) => q.eq("snapshotId", treeSnapshotId!))
          .collect(),
      ),
    ).toEqual([
      expect.objectContaining({ pageIndex: 0, files: expect.any(Array) }),
      expect.objectContaining({ pageIndex: 1, files: expect.any(Array) }),
      expect.objectContaining({ pageIndex: 2, files: expect.any(Array) }),
    ]);

    await expect(
      t.action(internal.repoIndexing.action.indexRepository, {
        repositoryId,
        expectedIndexVersion: 1,
        continuation: true,
        pageIndex: 1,
        treeSnapshotId: treeSnapshotId!,
      }),
    ).resolves.toMatchObject({ success: true, filesIndexed: 80 });

    const finalFileCount = await t.run(async (ctx) =>
      ctx.db
        .query("repoFileMap")
        .withIndex("by_repository", (q) => q.eq("repositoryId", repositoryId))
        .collect(),
    );
    expect(finalFileCount).toHaveLength(80);
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => requestUrl(input) === recursiveTreeUrl,
      ),
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => requestUrl(input) === AUTHORITATIVE_REPOSITORY_URL,
      ),
    ).toHaveLength(1);
    expect(githubHelpers.getRepositoryInstallationToken).toHaveBeenCalledTimes(
      2,
    );
    expect(githubHelpers.getRepositoryInstallationToken).toHaveBeenCalledWith(
      812,
      GITHUB_REPOSITORY_ID,
      "test-app-id",
      "test-private-key",
    );
  });

  it("stores every recognized text file for RAG and read_file", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertPendingRepository(t);
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url === AUTHORITATIVE_REPOSITORY_URL) {
        return Response.json({
          id: GITHUB_REPOSITORY_ID,
          full_name: "owner/large-repo",
          default_branch: "main",
          visibility: "public",
          private: false,
          license: { key: "mit", spdx_id: "MIT" },
        });
      }
      if (
        url === "https://api.github.com/repos/owner/large-repo/commits/main"
      ) {
        return Response.json({
          sha: "empty-commit",
          commit: { tree: { sha: "empty-tree" } },
        });
      }
      if (url.endsWith("/git/trees/empty-tree?recursive=1")) {
        return Response.json({
          truncated: false,
          tree: [
            {
              path: "src/empty.ts",
              mode: "100644",
              type: "blob",
              sha: "empty-blob",
              size: 0,
            },
            {
              path: ".github/workflows/ci.yml",
              mode: "100644",
              type: "blob",
              sha: "workflow-blob",
              size: 9,
            },
          ],
        });
      }
      if (url.endsWith("/git/blobs/empty-blob")) {
        return Response.json({ content: "", encoding: "base64" });
      }
      if (url.endsWith("/git/blobs/workflow-blob")) {
        return Response.json({ content: "bmFtZTogQ0kK", encoding: "base64" });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    await expect(
      t.action(internal.repoIndexing.action.indexRepository, {
        repositoryId,
        expectedIndexVersion: 1,
      }),
    ).resolves.toMatchObject({ success: true, filesIndexed: 2 });

    const indexed = await t.run(async (ctx) => {
      const emptyFileMap = await ctx.db
        .query("repoFileMap")
        .withIndex("by_repository_and_path", (q) =>
          q.eq("repositoryId", repositoryId).eq("filePath", "src/empty.ts"),
        )
        .unique();
      const emptyFileBlob = await ctx.db
        .query("repoFileBlobs")
        .withIndex("by_sha256", (q) => q.eq("sha256", "empty-blob"))
        .unique();
      const emptyContent = emptyFileBlob
        ? await ctx.storage.get(emptyFileBlob.storageId)
        : null;
      const workflowFileMap = await ctx.db
        .query("repoFileMap")
        .withIndex("by_repository_and_path", (q) =>
          q
            .eq("repositoryId", repositoryId)
            .eq("filePath", ".github/workflows/ci.yml"),
        )
        .unique();
      const workflowFileBlob = await ctx.db
        .query("repoFileBlobs")
        .withIndex("by_sha256", (q) => q.eq("sha256", "workflow-blob"))
        .unique();
      const workflowContent = workflowFileBlob
        ? await ctx.storage.get(workflowFileBlob.storageId)
        : null;
      return {
        emptyFileMap,
        emptyFileBlob,
        emptyContent: emptyContent ? await emptyContent.text() : null,
        workflowFileMap,
        workflowFileBlob,
        workflowContent: workflowContent ? await workflowContent.text() : null,
      };
    });
    expect(indexed.emptyFileMap).toMatchObject({
      filePath: "src/empty.ts",
      sha256: "empty-blob",
      size: 0,
      isText: true,
    });
    expect(indexed.emptyFileBlob).toMatchObject({
      sha256: "empty-blob",
      size: 0,
    });
    expect(indexed.emptyContent).toBe("");
    expect(indexed.workflowFileMap).toMatchObject({
      filePath: ".github/workflows/ci.yml",
      sha256: "workflow-blob",
      language: "YAML",
      isText: true,
    });
    expect(indexed.workflowFileBlob).toMatchObject({
      sha256: "workflow-blob",
      size: 9,
    });
    expect(indexed.workflowContent).toBe("name: CI\n");

    const ragFiles = await t.query(
      internal.repoIndexing.internalQuery.getRepositoryFilesPage,
      { repositoryId, indexVersion: 1, limit: 10 },
    );
    expect(ragFiles.files.map((file) => file.path).sort()).toEqual([
      ".github/workflows/ci.yml",
      "src/empty.ts",
    ]);
  });

  it("durably traverses a truncated tree across bounded continuations", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertPendingRepository(t);
    const sharedItems = Array.from({ length: 130 }, (_, index) => ({
      path: `file-${String(index).padStart(3, "0")}.ts`,
      mode: "100644",
      type: "blob",
      sha: `blob-${index}`,
      size: 10,
      url: `https://api.github.com/blob/${index}`,
    }));
    const githubTreeRequests: Array<string> = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url === AUTHORITATIVE_REPOSITORY_URL) {
        return new Response(
          JSON.stringify({
            id: GITHUB_REPOSITORY_ID,
            full_name: "owner/large-repo",
            default_branch: "main",
            visibility: "public",
            private: false,
            license: { key: "mit", spdx_id: "MIT" },
          }),
          { status: 200 },
        );
      }
      if (
        url === "https://api.github.com/repos/owner/large-repo/commits/main"
      ) {
        return new Response(
          JSON.stringify({
            sha: "commit-sha",
            commit: { tree: { sha: "root-tree" } },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/git/trees/root-tree?recursive=1")) {
        githubTreeRequests.push(url);
        return new Response(JSON.stringify({ tree: [], truncated: true }), {
          status: 200,
        });
      }
      if (url.endsWith("/git/trees/root-tree")) {
        githubTreeRequests.push(url);
        return new Response(
          JSON.stringify({
            tree: [
              {
                path: "packages/a",
                mode: "040000",
                type: "tree",
                sha: "shared-tree",
                url: "https://api.github.com/tree/shared-tree",
              },
              {
                path: "packages/b",
                mode: "040000",
                type: "tree",
                sha: "shared-tree",
                url: "https://api.github.com/tree/shared-tree",
              },
            ],
            truncated: false,
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/git/trees/shared-tree")) {
        githubTreeRequests.push(url);
        return new Response(
          JSON.stringify({ tree: sharedItems, truncated: false }),
          { status: 200 },
        );
      }

      // Convex-test storage URLs contain the durable subtree response used by
      // the second item-cursor continuation.
      return new Response(
        JSON.stringify({ tree: sharedItems, truncated: false }),
        { status: 200 },
      );
    }) as typeof fetch;

    await expect(
      t.action(internal.repoIndexing.action.indexRepository, {
        repositoryId,
        expectedIndexVersion: 1,
      }),
    ).resolves.toMatchObject({ success: true, filesIndexed: 0 });

    const snapshotId = await t.run(
      async (ctx) => (await ctx.db.get(repositoryId))?.indexTreeSnapshotId,
    );
    expect(snapshotId).toBeDefined();

    for (let continuation = 0; continuation < 8; continuation++) {
      const manifest = await t.run(async (ctx) => ctx.db.get(snapshotId!));
      if (manifest?.status === "ready") {
        break;
      }
      await expect(
        t.action(internal.repoIndexing.action.indexRepository, {
          repositoryId,
          expectedIndexVersion: 1,
          continuation: true,
          treeTraversal: true,
          treeSnapshotId: snapshotId!,
        }),
      ).resolves.toMatchObject({ success: true });
    }

    const state = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      manifests: await ctx.db
        .query("repoTreeSnapshots")
        .withIndex("by_repository_and_version", (q) =>
          q.eq("repositoryId", repositoryId).eq("indexVersion", 1),
        )
        .collect(),
      manifest: await ctx.db.get(snapshotId!),
      pages: await ctx.db
        .query("repoTreeSnapshotPages")
        .withIndex("by_snapshot", (q) => q.eq("snapshotId", snapshotId!))
        .collect(),
      queue: await ctx.db
        .query("repoTreeTraversalQueue")
        .withIndex("by_snapshot", (q) => q.eq("snapshotId", snapshotId!))
        .collect(),
    }));
    const files = state.pages
      .sort((left, right) => left.pageIndex - right.pageIndex)
      .flatMap((page) => page.files);
    expect(state.repository).toMatchObject({
      indexVersion: 1,
      indexStatus: "indexing",
      indexTreeSnapshotId: snapshotId,
    });
    expect(state.manifests).toHaveLength(1);
    expect(state.manifest).toMatchObject({
      status: "ready",
      commitSha: "commit-sha",
      treeSha: "root-tree",
      totalFiles: 260,
      totalPages: 7,
      nextPageIndex: 7,
    });
    expect(state.manifest?.traversalPendingFiles).toBeUndefined();
    expect(state.queue).toHaveLength(0);
    expect(files).toHaveLength(260);
    expect(new Set(files.map((file) => file.path))).toHaveLength(260);
    expect(files.some((file) => file.path.startsWith("packages/a/"))).toBe(
      true,
    );
    expect(files.some((file) => file.path.startsWith("packages/b/"))).toBe(
      true,
    );
    expect(
      githubTreeRequests.filter((url) =>
        url.endsWith("/git/trees/shared-tree"),
      ),
    ).toHaveLength(2);
  });

  it("fails closed when a non-recursive subtree is itself truncated", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertPendingRepository(t);
    const subtreeRequests: Array<string> = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url === AUTHORITATIVE_REPOSITORY_URL) {
        return new Response(
          JSON.stringify({
            id: GITHUB_REPOSITORY_ID,
            full_name: "owner/large-repo",
            default_branch: "main",
            visibility: "public",
            private: false,
            license: { key: "mit", spdx_id: "MIT" },
          }),
          { status: 200 },
        );
      }
      if (
        url === "https://api.github.com/repos/owner/large-repo/commits/main"
      ) {
        return new Response(
          JSON.stringify({
            sha: "commit-sha",
            commit: { tree: { sha: "root-tree" } },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/git/trees/root-tree?recursive=1")) {
        return new Response(JSON.stringify({ tree: [], truncated: true }), {
          status: 200,
        });
      }
      if (url.endsWith("/git/trees/root-tree")) {
        subtreeRequests.push(url);
        return new Response(JSON.stringify({ tree: [], truncated: true }), {
          status: 200,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    await expect(
      t.action(internal.repoIndexing.action.indexRepository, {
        repositoryId,
        expectedIndexVersion: 1,
      }),
    ).resolves.toMatchObject({ success: true, filesIndexed: 0 });
    const snapshotId = await t.run(
      async (ctx) => (await ctx.db.get(repositoryId))?.indexTreeSnapshotId,
    );
    expect(snapshotId).toBeDefined();

    await expect(
      t.action(internal.repoIndexing.action.indexRepository, {
        repositoryId,
        expectedIndexVersion: 1,
        continuation: true,
        treeTraversal: true,
        treeSnapshotId: snapshotId!,
      }),
    ).rejects.toThrow("truncated repository tree");

    const failed = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      manifest: await ctx.db.get(snapshotId!),
      queue: await ctx.db
        .query("repoTreeTraversalQueue")
        .withIndex("by_snapshot", (q) => q.eq("snapshotId", snapshotId!))
        .collect(),
    }));
    expect(failed.repository).toMatchObject({
      indexVersion: 1,
      indexStatus: "failed",
    });
    expect(failed.repository?.indexTreeSnapshotId).toBeUndefined();
    expect(failed.manifest?.status).toBe("deleting");
    expect(failed.queue).toHaveLength(1);

    await expect(
      t.action(internal.repoIndexing.action.indexRepository, {
        repositoryId,
        expectedIndexVersion: 1,
        continuation: true,
        treeTraversal: true,
        treeSnapshotId: snapshotId!,
      }),
    ).resolves.toMatchObject({ success: false, indexVersion: 1 });
    expect(subtreeRequests).toHaveLength(1);
  });

  it("does not publish tree data when the authoritative response mismatches the pinned ID", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertPendingRepository(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, {
        githubRepo: "owner/old-name",
        name: "old-name",
        githubUrl: "https://github.com/owner/old-name",
      });
    });
    const requestedUrls: Array<string> = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      requestedUrls.push(url);
      if (url === AUTHORITATIVE_REPOSITORY_URL) {
        return new Response(
          JSON.stringify({
            id: 999,
            full_name: "other/reused-name",
            default_branch: "main",
            visibility: "public",
            license: { key: "mit", spdx_id: "MIT" },
          }),
          { status: 200 },
        );
      }
      if (url === "https://api.github.com/repos/owner/old-name") {
        return new Response(
          JSON.stringify({
            id: 999,
            full_name: "owner/old-name",
            default_branch: "main",
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    await expect(
      t.action(internal.repoIndexing.action.indexRepository, {
        repositoryId,
        expectedIndexVersion: 1,
      }),
    ).rejects.toThrow("identity did not match");

    const state = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      files: await ctx.db
        .query("repoFileMap")
        .withIndex("by_repository", (q) => q.eq("repositoryId", repositoryId))
        .collect(),
      snapshots: await ctx.db
        .query("repoTreeSnapshots")
        .withIndex("by_repository_and_version", (q) =>
          q.eq("repositoryId", repositoryId).eq("indexVersion", 1),
        )
        .collect(),
    }));
    expect(state.repository).toMatchObject({
      githubRepositoryId: GITHUB_REPOSITORY_ID,
      githubRepo: "owner/old-name",
      indexStatus: "failed",
    });
    expect(state.files).toHaveLength(0);
    expect(state.snapshots).toHaveLength(0);
    expect(requestedUrls).toEqual([AUTHORITATIVE_REPOSITORY_URL]);
  });

  it("restarts after an authoritative rename before publishing tree data", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertPendingRepository(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, {
        githubRepo: "owner/old-name",
        name: "old-name",
        githubUrl: "https://github.com/owner/old-name",
      });
    });
    const requestedUrls: Array<string> = [];
    const renamedRepo = "owner/renamed-repo";
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      requestedUrls.push(url);
      if (url === AUTHORITATIVE_REPOSITORY_URL) {
        return new Response(
          JSON.stringify({
            id: GITHUB_REPOSITORY_ID,
            full_name: renamedRepo,
            default_branch: "main",
            visibility: "public",
            private: false,
            license: { key: "mit", spdx_id: "MIT" },
          }),
          { status: 200 },
        );
      }
      if (url === "https://api.github.com/repos/owner/old-name") {
        return new Response(
          JSON.stringify({
            id: 999,
            full_name: "owner/old-name",
            default_branch: "main",
          }),
          { status: 200 },
        );
      }
      if (url === "https://opensource.org/api/licenses?spdx=MIT") {
        return new Response(JSON.stringify([{ spdx_id: "MIT" }]), {
          status: 200,
        });
      }
      if (url === `https://api.github.com/repos/${renamedRepo}/commits/main`) {
        return new Response(
          JSON.stringify({
            sha: "renamed-commit-sha",
            commit: { tree: { sha: "renamed-tree-sha" } },
          }),
          { status: 200 },
        );
      }
      if (
        url ===
        `https://api.github.com/repos/${renamedRepo}/git/trees/renamed-tree-sha?recursive=1`
      ) {
        return new Response(
          JSON.stringify({
            truncated: false,
            tree: Array.from({ length: 41 }, (_, index) => ({
              path: `assets/image-${index}.png`,
              mode: "100644",
              type: "blob",
              sha: `renamed-sha-${index}`,
              size: 100,
              url: `https://api.github.com/blob/renamed-${index}`,
            })),
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    await expect(
      t.action(internal.repoIndexing.action.indexRepository, {
        repositoryId,
        expectedIndexVersion: 1,
      }),
    ).resolves.toMatchObject({ success: false, filesIndexed: 0 });

    const state = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      files: await ctx.db
        .query("repoFileMap")
        .withIndex("by_repository", (q) => q.eq("repositoryId", repositoryId))
        .collect(),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.repository).toMatchObject({
      githubRepositoryId: GITHUB_REPOSITORY_ID,
      githubRepo: renamedRepo,
      name: "renamed-repo",
      githubUrl: `https://github.com/${renamedRepo}`,
      indexVersion: 2,
      indexStatus: "pending",
      ragStatus: "pending",
    });
    expect(state.files).toHaveLength(0);
    expect(
      state.scheduled.filter(
        (scheduled) => scheduled.name === "repoIndexing/action:indexRepository",
      ),
    ).toHaveLength(1);
    expect(
      requestedUrls.some((url) => url.includes("/repos/owner/old-name")),
    ).toBe(false);
    expect(
      requestedUrls.some((url) =>
        url.includes(`/repos/${renamedRepo}/git/trees/`),
      ),
    ).toBe(false);
  });

  it("resumes a rate-limited page at the exact file group without duplicate blob fetches", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertPendingRepository(t);
    const blobCalls = new Map<string, number>();
    let releaseRateLimit = false;
    let successfulRetryPending = false;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url === AUTHORITATIVE_REPOSITORY_URL) {
        return Response.json({
          id: GITHUB_REPOSITORY_ID,
          full_name: "owner/large-repo",
          default_branch: "main",
          visibility: "public",
          private: false,
          license: { key: "mit", spdx_id: "MIT" },
        });
      }
      if (
        url === "https://api.github.com/repos/owner/large-repo/commits/main"
      ) {
        return Response.json({
          sha: "rate-commit",
          commit: { tree: { sha: "rate-tree" } },
        });
      }
      if (url.endsWith("/git/trees/rate-tree?recursive=1")) {
        return Response.json({
          truncated: false,
          tree: Array.from({ length: 10 }, (_, index) => ({
            // Keep the first group metadata-only and exercise the rate-limit
            // boundary with two text files in the final group. This avoids a
            // convex-test-only overlap between its global fake transaction and
            // ctx.storage.store while preserving the cache-reuse assertion.
            path: [8, 9].includes(index)
              ? `src/file-${index}.ts`
              : `assets/image-${index}.png`,
            mode: "100644",
            type: "blob",
            sha: `rate-${index}`,
            size: 10,
          })),
        });
      }
      const blobMatch = url.match(/\/git\/blobs\/(rate-\d+)$/);
      if (blobMatch) {
        const sha = blobMatch[1];
        blobCalls.set(sha, (blobCalls.get(sha) ?? 0) + 1);
        if (sha === "rate-8" && !releaseRateLimit) {
          return Response.json(
            {
              message: "You have exceeded a secondary rate limit. Please wait.",
            },
            { status: 403 },
          );
        }
        if (sha === "rate-8") {
          // Let the cached sibling finish its mutation before convex-test's
          // global fake transaction handles this storage write.
          successfulRetryPending = true;
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        return Response.json({
          content: btoa(`export const value = "${sha}";`),
          encoding: "base64",
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    const initialIndex = t.action(
      internal.repoIndexing.action.indexRepository,
      {
        repositoryId,
        expectedIndexVersion: 1,
      },
    );
    // Let the headerless secondary limit reach the durable retry path. Keeping
    // fake time below its one-minute fallback prevents convex-test from
    // auto-running the job that this assertion intentionally invokes manually.
    for (let attempt = 0; attempt < 20; attempt++) {
      await advanceTestTime(1);
      if (blobCalls.get("rate-8") === 1) {
        break;
      }
    }
    expect(blobCalls.get("rate-8")).toBe(1);
    await expect(initialIndex).resolves.toMatchObject({
      success: true,
      filesIndexed: 8,
    });
    const deferred = await t.run(async (ctx) => {
      const repository = await ctx.db.get(repositoryId);
      if (repository) {
        await ctx.db.patch(repositoryId, {
          indexRateLimitRetryAt: Date.now() - 1,
        });
      }
      return repository;
    });
    expect(deferred?.indexStatus).toBe("indexing");
    expect(typeof deferred?.indexRateLimitRetryToken).toBe("string");
    expect(typeof deferred?.indexRateLimitRetryAt).toBe("number");
    expect(blobCalls.get("rate-8")).toBe(1);
    expect(blobCalls.get("rate-9")).toBe(1);

    releaseRateLimit = true;
    const retry = t.action(internal.repoIndexing.action.indexRepository, {
      repositoryId,
      expectedIndexVersion: 1,
      continuation: true,
      pageIndex: 0,
      treeSnapshotId: deferred!.indexTreeSnapshotId!,
      fileOffset: 8,
      rateLimitResume: true,
      rateLimitRetryToken: deferred!.indexRateLimitRetryToken!,
    });
    for (let attempt = 0; attempt < 20; attempt++) {
      await advanceTestTime(0);
      if (successfulRetryPending) {
        break;
      }
    }
    expect(successfulRetryPending).toBe(true);
    await advanceTestTime(1);
    const retryResult = await retry;
    expect(retryResult).toMatchObject({ success: true, filesIndexed: 10 });

    const fileMaps = await t.run(async (ctx) =>
      ctx.db
        .query("repoFileMap")
        .withIndex("by_repository", (q) => q.eq("repositoryId", repositoryId))
        .collect(),
    );
    expect(fileMaps).toHaveLength(10);
    expect(blobCalls.get("rate-8")).toBe(2);
    expect(blobCalls.get("rate-9")).toBe(1);
  });

  it("refetches after a late blob upload loses the publication fence", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertPendingRepository(t);
    let blobCalls = 0;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url === AUTHORITATIVE_REPOSITORY_URL) {
        return Response.json({
          id: GITHUB_REPOSITORY_ID,
          full_name: "owner/large-repo",
          default_branch: "main",
          visibility: "public",
          private: false,
          license: { key: "mit", spdx_id: "MIT" },
        });
      }
      if (
        url === "https://api.github.com/repos/owner/large-repo/commits/main"
      ) {
        return Response.json({
          sha: "map-deferred-commit",
          commit: { tree: { sha: "map-deferred-tree" } },
        });
      }
      if (url.endsWith("/git/trees/map-deferred-tree?recursive=1")) {
        return Response.json({
          truncated: false,
          tree: [
            {
              path: "src/map-deferred.ts",
              mode: "100644",
              type: "blob",
              sha: "map-deferred-blob",
              size: 34,
            },
          ],
        });
      }
      if (url.endsWith("/git/blobs/map-deferred-blob")) {
        blobCalls++;
        if (blobCalls === 1) {
          await t.run(async (ctx) => {
            const installation = await ctx.db
              .query("githubInstallations")
              .withIndex("by_installation_id", (q) =>
                q.eq("installationId", 812),
              )
              .first();
            if (!installation) throw new Error("installation fixture missing");
            const now = Date.now();
            await ctx.db.patch(installation._id, {
              repositoryRemovalPendingAt: now,
              repositoryAccessReconciliationPhase: "fetching",
              updatedAt: now,
            });
          });
        }
        return Response.json({
          content: btoa("export const mapDeferred = true;"),
          encoding: "base64",
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    await expect(
      t.action(internal.repoIndexing.action.indexRepository, {
        repositoryId,
        expectedIndexVersion: 1,
      }),
    ).resolves.toMatchObject({ success: true, filesIndexed: 0 });
    const deferred = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      maps: await ctx.db
        .query("repoFileMap")
        .withIndex("by_repository", (q) => q.eq("repositoryId", repositoryId))
        .collect(),
      blobs: await ctx.db.query("repoFileBlobs").collect(),
    }));
    expect(deferred.maps).toEqual([]);
    expect(deferred.blobs).toEqual([]);
    expect(deferred.repository?.indexStatus).toBe("indexing");
    expect(deferred.repository?.indexTreeSnapshotId).toBeDefined();
    expect(typeof deferred.repository?.indexRateLimitRetryToken).toBe("string");

    await t.run(async (ctx) => {
      const installation = await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) => q.eq("installationId", 812))
        .first();
      if (!installation) throw new Error("installation fixture missing");
      await ctx.db.patch(installation._id, {
        repositoryRemovalPendingAt: undefined,
        repositoryAccessReconciliationPhase: undefined,
      });
      await ctx.db.patch(repositoryId, {
        indexRateLimitRetryAt: Date.now() - 1,
      });
    });

    await expect(
      t.action(internal.repoIndexing.action.indexRepository, {
        repositoryId,
        expectedIndexVersion: 1,
        continuation: true,
        pageIndex: 0,
        treeSnapshotId: deferred.repository!.indexTreeSnapshotId!,
        fileOffset: 0,
        rateLimitResume: true,
        rateLimitRetryToken: deferred.repository!.indexRateLimitRetryToken!,
      }),
    ).resolves.toMatchObject({ success: true, filesIndexed: 1 });

    const resumed = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      maps: await ctx.db
        .query("repoFileMap")
        .withIndex("by_repository", (q) => q.eq("repositoryId", repositoryId))
        .collect(),
    }));
    expect(resumed.repository?.indexStatus).toBe("completed");
    expect(resumed.maps).toHaveLength(1);
    expect(resumed.maps[0]?.filePath).toBe("src/map-deferred.ts");
    expect(blobCalls).toBe(2);
  });

  it("defers an unrelated active index during a large removal reconciliation and resumes it", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertPendingRepository(t);
    const otherRepositoryId = await t.run(async (ctx) => {
      const repository = await ctx.db.get(repositoryId);
      if (!repository) throw new Error("fixture missing");
      const now = Date.now();
      return await ctx.db.insert("repositories", {
        indexSyncPending: false,
        indexVersion: 1,
        indexStatus: "completed",
        indexProgressAt: Date.now(),
        ragStatus: "completed",
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        userId: repository.userId,
        installationId: 812,
        githubRepositoryId: 457,
        githubRepo: "owner/removed-repo",
        githubRepoKey: "owner/removed-repo",
        name: "removed-repo",
        githubUrl: "https://github.com/owner/removed-repo",
        isActive: true,
        settings: repository.settings,
        monthlyActions: 0,
        lastResetAt: now,
        createdAt: now,
        updatedAt: now,
      });
    });
    let reconciliationStarted = false;
    const requestedUrls: Array<string> = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      requestedUrls.push(url);
      if (url === AUTHORITATIVE_REPOSITORY_URL) {
        if (!reconciliationStarted) {
          reconciliationStarted = true;
          await t.run(async (ctx) => {
            const installation = await ctx.db
              .query("githubInstallations")
              .withIndex("by_installation_id", (q) =>
                q.eq("installationId", 812),
              )
              .first();
            if (!installation) throw new Error("installation fixture missing");
            const now = Date.now();
            await ctx.db.patch(installation._id, {
              repositoryRemovalPendingAt: now,
              repositoryAccessReconciliationPhase: "fetching",
              updatedAt: now,
            });
            await ctx.db.insert("githubRepositoryRemovalJobs", {
              deliveryId: "large-removal",
              installationId: 812,
              totalRepositories: 1_000,
              nextOffset: 0,
              status: "pending",
              retryCount: 0,
              nextAttemptAt: now,
              createdAt: now,
              updatedAt: now,
            });
          });
        }
        return Response.json({
          id: GITHUB_REPOSITORY_ID,
          full_name: "owner/large-repo",
          default_branch: "main",
          visibility: "public",
          private: false,
          license: { key: "mit", spdx_id: "MIT" },
        });
      }
      if (
        url === "https://api.github.com/repos/owner/large-repo/commits/main"
      ) {
        return Response.json({
          sha: "deferred-commit",
          commit: { tree: { sha: "deferred-tree" } },
        });
      }
      if (url.endsWith("/git/trees/deferred-tree?recursive=1")) {
        return Response.json({
          truncated: false,
          tree: Array.from({ length: 41 }, (_, index) => ({
            path: `assets/image-${index}.png`,
            mode: "100644",
            type: "blob",
            sha: `deferred-${index}`,
            size: 10,
          })),
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    await expect(
      t.action(internal.repoIndexing.action.indexRepository, {
        repositoryId,
        expectedIndexVersion: 1,
      }),
    ).resolves.toMatchObject({ success: true, filesIndexed: 0 });
    const deferred = await t.run(async (ctx) => ctx.db.get(repositoryId));
    expect(deferred?.indexStatus).toBe("indexing");
    expect(deferred?.ragStatus).toBe("pending");
    expect(deferred?.indexError).toBeUndefined();
    expect(typeof deferred?.indexRateLimitRetryToken).toBe("string");
    expect(
      await t.run(
        async (ctx) => (await ctx.db.get(otherRepositoryId))?.isActive,
      ),
    ).toBe(true);
    expect(requestedUrls.some((url) => url.includes("/commits/main"))).toBe(
      false,
    );

    await t.run(async (ctx) => {
      const installation = await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) => q.eq("installationId", 812))
        .first();
      if (!installation) throw new Error("installation fixture missing");
      await ctx.db.patch(installation._id, {
        repositoryRemovalPendingAt: undefined,
        repositoryAccessReconciliationPhase: undefined,
      });
      const job = await ctx.db
        .query("githubRepositoryRemovalJobs")
        .withIndex("by_delivery_id", (q) => q.eq("deliveryId", "large-removal"))
        .first();
      if (job) {
        await ctx.db.patch(job._id, {
          status: "completed",
          completedAt: Date.now(),
        });
      }
      await ctx.db.patch(repositoryId, {
        indexRateLimitRetryAt: Date.now() - 1,
      });
    });

    await expect(
      t.action(internal.repoIndexing.action.indexRepository, {
        repositoryId,
        expectedIndexVersion: 1,
        rateLimitResume: true,
        rateLimitRetryToken: deferred!.indexRateLimitRetryToken!,
      }),
    ).resolves.toMatchObject({ success: true, filesIndexed: 40 });
    const resumed = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      maps: await ctx.db
        .query("repoFileMap")
        .withIndex("by_repository", (q) => q.eq("repositoryId", repositoryId))
        .collect(),
    }));
    expect(resumed.repository?.indexStatus).toBe("indexing");
    expect(resumed.maps).toHaveLength(40);
  });
});
