import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "../../../convex/_generated/api";
import schema from "../../../convex/schema";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/repoIndexing/query.ts": () =>
    import("../../../convex/repoIndexing/query"),
  "../../../convex/repoIndexing/internalAction.ts": () =>
    import("../../../convex/repoIndexing/internalAction"),
  "../../../convex/repoIndexing/internalQuery.ts": () =>
    import("../../../convex/repoIndexing/internalQuery"),
  "../../../convex/repositories/internalQuery.ts": () =>
    import("../../../convex/repositories/internalQuery"),
};

describe("repository query bounds", () => {
  it("caps caller-supplied file and indexing log limits at 500 rows", async () => {
    const t = convexTest(schema, modules);
    const { userId, repositoryId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 123,
        ownerGithubAccountId: "owner",
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
        installationId: 123,
        githubRepositoryId: 1_123,
        githubRepo: "owner/bounded",
        githubRepoKey: "owner/bounded",
        name: "bounded",
        githubUrl: "https://github.com/owner/bounded",
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
      for (let index = 0; index < 501; index++) {
        await ctx.db.insert("repoFileMap", {
          repositoryId,
          filePath: `src/file-${index}.ts`,
          sha256: `sha-${index}`,
          language: "TypeScript",
          size: 1,
          isText: true,
          indexVersion: 1,
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.insert("repoIndexingLogs", {
          repositoryId,
          indexVersion: 1,
          level: "info",
          message: `log-${index}`,
          createdAt: now + index,
        });
      }
      return { userId, repositoryId };
    });

    const files = await t
      .withIdentity({ subject: `${userId}|test-session` })
      .query(api.repoIndexing.query.getFileList, {
        repositoryId,
        limit: 1_000,
      });

    expect(files).toHaveLength(500);
    const logs = await t
      .withIdentity({ subject: `${userId}|test-session` })
      .query(api.repoIndexing.query.getIndexingLogs, {
        repositoryId,
        limit: 1_000,
      });
    expect(logs).toHaveLength(500);
  });

  it("fails closed while installation or repository access is unavailable", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      const installationId = await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 456,
        ownerGithubAccountId: "owner",
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
        installationId: 456,
        githubRepositoryId: 789,
        githubRepo: "owner/private-cache",
        githubRepoKey: "owner/private-cache",
        name: "private-cache",
        githubUrl: "https://github.com/owner/private-cache",
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
      const storageId = await ctx.storage.store(new Blob(["private source"]));
      await ctx.db.insert("repoFileBlobs", {
        sha256: "private-sha",
        storageId,
        size: 14,
        createdAt: now,
        lastAccessedAt: now,
        accessCount: 1,
      });
      await ctx.db.insert("repoFileMap", {
        repositoryId,
        filePath: "src/private.ts",
        sha256: "private-sha",
        language: "TypeScript",
        size: 14,
        isText: true,
        indexVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
      return { userId, installationId, repositoryId, now };
    });
    const authenticated = t.withIdentity({
      subject: `${fixture.userId}|test-session`,
    });

    await expect(
      authenticated.query(api.repoIndexing.query.getFileContent, {
        repositoryId: fixture.repositoryId,
        filePath: "src/private.ts",
      }),
    ).resolves.toMatchObject({ filePath: "src/private.ts" });

    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.installationId, {
        repositoryRemovalPendingAt: fixture.now,
        repositoryAccessReconciliationEpoch: fixture.now,
        repositoryAccessReconciliationPhase: "fetching",
      });
    });
    await expect(
      authenticated.query(api.repoIndexing.query.getFileContent, {
        repositoryId: fixture.repositoryId,
        filePath: "src/private.ts",
      }),
    ).resolves.toBeNull();
    await expect(
      authenticated.query(api.repoIndexing.query.getFileList, {
        repositoryId: fixture.repositoryId,
      }),
    ).resolves.toEqual([]);

    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.installationId, {
        repositoryRemovalPendingAt: undefined,
        repositoryAccessReconciliationPhase: undefined,
      });
      await ctx.db.patch(fixture.repositoryId, {
        isActive: false,
        githubAccessRevokedAt: fixture.now,
      });
    });
    await expect(
      authenticated.query(api.repoIndexing.query.getFileContent, {
        repositoryId: fixture.repositoryId,
        filePath: "src/private.ts",
      }),
    ).resolves.toBeNull();
    await expect(
      authenticated.query(api.repoIndexing.query.getFileList, {
        repositoryId: fixture.repositoryId,
      }),
    ).resolves.toEqual([]);
  });

  it("drops fetched file content when installation reconciliation starts in flight", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      const installationDocId = await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 654,
        ownerGithubAccountId: "owner",
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
        installationId: 654,
        githubRepositoryId: 987,
        githubRepo: "owner/private-action-cache",
        githubRepoKey: "owner/private-action-cache",
        name: "private-action-cache",
        githubUrl: "https://github.com/owner/private-action-cache",
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
      const storageId = await ctx.storage.store(
        new Blob(["export const privateMarker = true;"]),
      );
      await ctx.db.insert("repoFileBlobs", {
        sha256: "private-action-sha",
        storageId,
        size: 34,
        createdAt: now,
        lastAccessedAt: now,
        accessCount: 1,
      });
      await ctx.db.insert("repoFileMap", {
        repositoryId,
        filePath: "src/privateMarker.ts",
        sha256: "private-action-sha",
        language: "TypeScript",
        size: 34,
        isText: true,
        indexVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
      return { installationDocId, repositoryId, now };
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      await t.run(async (ctx) => {
        await ctx.db.patch(fixture.installationDocId, {
          repositoryRemovalPendingAt: fixture.now,
          repositoryAccessReconciliationPhase: "fetching",
        });
      });
      return new Response("export const privateMarker = true;");
    };

    try {
      await expect(
        t.action(
          internal.repoIndexing.internalAction.getRepositoryFilesWithContent,
          {
            repositoryId: fixture.repositoryId,
            filePaths: ["src/privateMarker.ts"],
            indexVersion: 1,
          },
        ),
      ).resolves.toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
