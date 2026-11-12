import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "../../../convex/_generated/api";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import { getCanonicalGitHubRepositoryFullNameKey } from "../../../convex/github/repositoryIdentity";
import { REPOSITORY_ROUTE_DUPLICATE_LIMIT } from "../../../convex/repositories/query";
import schema from "../../../convex/schema";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/repositories/query.ts": () =>
    import("../../../convex/repositories/query"),
  "../../../convex/repoIndexing/mutation.ts": () =>
    import("../../../convex/repoIndexing/mutation"),
};

async function insertRepository(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  githubRepo = "owner/repo",
): Promise<Id<"repositories">> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("repositories", {
      indexSyncPending: false,
      userId,
      installationId: 123,
      githubRepositoryId: 456,
      githubRepo,
      githubRepoKey: getCanonicalGitHubRepositoryFullNameKey(githubRepo),
      name: githubRepo.split("/").at(-1) ?? githubRepo,
      githubUrl: `https://github.com/${githubRepo}`,
      isActive: true,
      indexVersion: 1,
      indexStatus: "completed",
      indexProgressAt: now,
      ragStatus: "completed",
      ragTotalChunks: 0,
      ragIndexedChunks: 0,
      ragFailedChunks: 0,
      settings: {
        issueAssistantEnabled: true,
        autoFormatIssue: true,
        autoAnswerQuestions: true,
        tagMaintainersForCodeChanges: true,
        requireApproval: false,
        discussionAssistantEnabled: true,
        autoFormatDiscussion: true,
        autoAnswerDiscussionQuestions: true,
        tagMaintainersForDiscussionCodeChanges: true,
        requireApprovalForDiscussions: false,
      },
      monthlyActions: 0,
      lastResetAt: now,
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function insertInstallation(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  state: Partial<
    Pick<
      Doc<"githubInstallations">,
      | "accessSuspendedAt"
      | "repositoryAccessRemovalPhase"
      | "repositoryRemovalPendingAt"
      | "repositoryAccessReconciliationPhase"
    >
  > = {},
): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("githubInstallations", {
      userId,
      installationId: 123,
      ownerGithubAccountId: "owner-account-id",
      ownershipVerifiedAt: now,
      accountLogin: "owner",
      accountType: "User",
      targetType: "User",
      createdAt: now,
      updatedAt: now,
      ...state,
    });
  });
}

async function insertTrustedPro(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("subscriptions", {
      userId,
      lemonSqueezySubscriptionId: `live-pro-${userId}`,
      proEntitlementProvenance: {
        source: "lemon_squeezy_webhook",
        verifiedAt: now,
      },
      plan: "pro",
      status: "active",
      includedTokens: 2_400_000,
      purchasedTokens: 0,
      serviceFeeRate: 0.18,
      periodStart: now,
      periodEnd: now + 60_000,
      createdAt: now,
      updatedAt: now,
    });
  });
}

describe("repository route access", () => {
  it("redacts internal recovery state from every public repository path", async () => {
    const t = convexTest(schema, modules);
    const callerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const repositoryId = await insertRepository(t, callerId);
    const internalFields = [
      "repositoryMetadataCheckedAt",
      "licenseOsiCheckedAt",
      "githubMetadataRevision",
      "isActiveBeforeAccessRevocation",
      "githubAccessRestoreIndexPending",
      "githubAccessRestoreIndexNextAttemptAt",
      "githubAccessRestoreIndexRetryCount",
      "githubAccessReconciliationEpoch",
      "githubAccessReconciliationRevision",
      "indexProgressAt",
      "indexSource",
      "indexSyncPendingSource",
      "indexWatchdogToken",
      "indexWatchdogScheduleId",
      "indexWatchdogSequence",
      "indexWatchdogRetryCount",
      "indexIdentityVerifiedVersion",
      "indexIdentityVerifiedInstallationId",
      "indexIdentityVerifiedGithubRepositoryId",
      "indexIdentityVerifiedGithubRepo",
      "indexRateLimitRetryToken",
      "indexRateLimitRetryAt",
      "indexTreeSnapshotId",
      "ragLegalEligibilityBlockedAt",
      "ragLegalEligibilityBlockedIndexVersion",
      "ragEmbeddingKey",
      "ragIndexPhase",
      "ragIndexCursor",
      "ragIndexFileOffset",
      "ragIndexChunkOffset",
      "ragContinuationToken",
      "ragProcessedFiles",
      "indexSyncPending",
      "disconnectCleanupPending",
      "disconnectCleanupPhase",
    ] as const;
    await t.run(async (ctx) => {
      const scheduleId = await ctx.scheduler.runAfter(
        60_000,
        internal.repoIndexing.mutation.touchIndexingProgress,
        { repositoryId, expectedIndexVersion: 1 },
      );
      const snapshotId = await ctx.db.insert("repoTreeSnapshots", {
        repositoryId,
        indexVersion: 1,
        defaultBranch: "main",
        commitSha: "private-commit-sha",
        treeSha: "private-tree-sha",
        totalFiles: 1,
        totalPages: 1,
        status: "ready",
        createdAt: 90,
        updatedAt: 90,
      });
      await ctx.db.patch(repositoryId, {
        indexSource: {
          indexVersion: 1,
          commitSha: "private-sha",
          defaultBranch: "main",
        },
        indexSyncPendingSource: {
          commitSha: "private-next-sha",
          defaultBranch: "main",
        },
        repositoryMetadataCheckedAt: 100,
        licenseOsiCheckedAt: 101,
        githubMetadataRevision: 102,
        isActiveBeforeAccessRevocation: true,
        githubAccessRestoreIndexPending: true,
        githubAccessRestoreIndexNextAttemptAt: 103,
        githubAccessRestoreIndexRetryCount: 2,
        githubAccessReconciliationEpoch: 104,
        githubAccessReconciliationRevision: 105,
        indexWatchdogToken: "private-watchdog-token",
        indexWatchdogScheduleId: scheduleId,
        indexWatchdogSequence: 3,
        indexWatchdogRetryCount: 4,
        indexIdentityVerifiedVersion: 1,
        indexIdentityVerifiedInstallationId: 123,
        indexIdentityVerifiedGithubRepositoryId: 456,
        indexIdentityVerifiedGithubRepo: "owner/repo",
        indexRateLimitRetryToken: "private-rate-limit-token",
        indexRateLimitRetryAt: 106,
        indexTreeSnapshotId: snapshotId,
        ragLegalEligibilityBlockedAt: 107,
        ragLegalEligibilityBlockedIndexVersion: 1,
        ragEmbeddingKey: "private-embedding-key",
        ragIndexPhase: "files",
        ragIndexCursor: "private-cursor",
        ragIndexFileOffset: 5,
        ragIndexChunkOffset: 6,
        ragContinuationToken: "private-continuation-token",
        ragProcessedFiles: 7,
        indexSyncPending: true,
        disconnectCleanupPending: false,
        disconnectCleanupPhase: "tree",
      });
    });

    const rawRepository = await t.run(async (ctx) => ctx.db.get(repositoryId));
    for (const field of internalFields) {
      expect(rawRepository).toHaveProperty(field);
    }
    expect(rawRepository).toMatchObject({
      indexTreeSnapshotId: expect.any(String),
      disconnectCleanupPending: false,
      disconnectCleanupPhase: "tree",
    });

    const caller = t.withIdentity({ subject: `${callerId}|test-session` });
    const [repositories, repositoryByRoute, repositoryById] = await Promise.all(
      [
        caller.query(api.repositories.query.list, {}),
        caller.query(api.repositories.query.get, {
          owner: "owner",
          repo: "repo",
        }),
        caller.query(api.repositories.query.getById, { repositoryId }),
      ],
    );

    const publicRepositories = [
      repositories[0],
      repositoryByRoute,
      repositoryById,
    ];
    for (const repository of publicRepositories) {
      expect(repository).toMatchObject({
        _id: repositoryId,
        userId: callerId,
        installationId: 123,
        githubRepositoryId: 456,
        githubRepo: "owner/repo",
        githubRepoKey: "owner/repo",
        name: "repo",
        githubUrl: "https://github.com/owner/repo",
        isActive: true,
        indexVersion: 1,
        indexStatus: "completed",
        ragStatus: "completed",
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        settings: expect.objectContaining({ issueAssistantEnabled: true }),
        monthlyActions: 0,
        userRole: "owner",
      });
      for (const field of internalFields) {
        expect(repository).not.toHaveProperty(field);
      }
    }
  });

  it("exposes only a bounded progress summary for authorized active work", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    const repositoryId = await insertRepository(t, userId, "owner/progress");
    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, {
        ragStatus: "indexing",
        ragIndexPhase: "files",
        ragProcessedFiles: 671,
        ragIndexedChunks: 4891,
        indexProgressAt: 1000,
        indexRateLimitRetryAt: 2000,
        indexSyncPending: true,
        ragIndexCursor: "private-cursor",
        indexWatchdogToken: "private-watchdog",
        ragContinuationToken: "private-token",
      });
    });
    const repo = await t
      .withIdentity({ subject: `${userId}|test-session` })
      .query(api.repositories.query.getById, { repositoryId });
    expect(repo?.indexingProgress).toEqual({
      phase: "search",
      lastProgressAt: 1000,
      staleAt: 2000 + 12 * 60_000,
      processedFiles: 671,
      syncQueued: true,
    });
    expect(JSON.stringify(repo)).not.toContain("private-");
    await expect(
      t.query(api.repositories.query.getById, { repositoryId }),
    ).rejects.toThrow("not authenticated");
  });

  it("resolves a keyed repository through a mixed-case route", async () => {
    const t = convexTest(schema, modules);
    const callerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const repositoryId = await insertRepository(t, callerId, "Owner/Repo");

    const repository = await t
      .withIdentity({ subject: `${callerId}|test-session` })
      .query(api.repositories.query.get, { owner: "owner", repo: "repo" });

    expect(repository).toMatchObject({
      _id: repositoryId,
      githubRepo: "Owner/Repo",
      githubRepoKey: "owner/repo",
      userRole: "owner",
    });
  });

  it("prefers the authenticated user's repository row", async () => {
    const t = convexTest(schema, modules);
    const { callerId, otherUserId } = await t.run(async (ctx) => ({
      callerId: await ctx.db.insert("users", {}),
      otherUserId: await ctx.db.insert("users", {}),
    }));
    await insertRepository(t, otherUserId);
    const ownedRepositoryId = await insertRepository(t, callerId);

    const repository = await t
      .withIdentity({ subject: `${callerId}|test-session` })
      .query(api.repositories.query.get, { owner: "owner", repo: "repo" });

    expect(repository).toMatchObject({
      _id: ownedRepositoryId,
      userRole: "owner",
    });
  });

  it("checks later duplicate rows for an accessible membership", async () => {
    const t = convexTest(schema, modules);
    const { callerId, firstOwnerId, sharedOwnerId } = await t.run(
      async (ctx) => ({
        callerId: await ctx.db.insert("users", {}),
        firstOwnerId: await ctx.db.insert("users", {}),
        sharedOwnerId: await ctx.db.insert("users", {}),
      }),
    );
    await insertRepository(t, firstOwnerId);
    const sharedRepositoryId = await insertRepository(t, sharedOwnerId);
    await insertTrustedPro(t, sharedOwnerId);
    await t.run(async (ctx) => {
      const now = Date.now();
      const invitationId = await ctx.db.insert("invitations", {
        repositoryId: sharedRepositoryId,
        invitedByUserId: sharedOwnerId,
        invitedByUsername: "owner",
        inviteeGithubUsername: "shared-user",
        inviteeUserId: callerId,
        role: "viewer",
        status: "accepted",
        createdAt: now,
        respondedAt: now,
      });
      await ctx.db.insert("repositoryMembers", {
        repositoryId: sharedRepositoryId,
        userId: callerId,
        githubUsername: "shared-user",
        role: "viewer",
        joinedVia: "invitation",
        invitationId,
        joinedAt: now,
      });
    });

    const repository = await t
      .withIdentity({ subject: `${callerId}|test-session` })
      .query(api.repositories.query.get, { owner: "owner", repo: "repo" });

    expect(repository).toMatchObject({
      _id: sharedRepositoryId,
      userRole: "viewer",
    });
  });

  it("omits an invitation reason when the exact installation is ready", async () => {
    const t = convexTest(schema, modules);
    const callerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertRepository(t, callerId);
    await insertInstallation(t, callerId);

    const repository = await t
      .withIdentity({ subject: `${callerId}|test-session` })
      .query(api.repositories.query.get, { owner: "owner", repo: "repo" });

    expect(repository).not.toHaveProperty("invitationUnavailableReason");
  });

  it.each([
    [
      "reconciliation",
      { repositoryAccessReconciliationPhase: "fetching" as const },
      "syncing",
    ],
    ["suspension", { accessSuspendedAt: 1 }, "revoked"],
    [
      "installation removal",
      { repositoryAccessRemovalPhase: "pausing" as const },
      "revoked",
    ],
    ["repository removal", { repositoryRemovalPendingAt: 1 }, "revoked"],
  ])(
    "reports invitation unavailability during installation %s",
    async (_label, state, expectedReason) => {
      const t = convexTest(schema, modules);
      const callerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
      await insertRepository(t, callerId);
      await insertInstallation(t, callerId, state);

      const repository = await t
        .withIdentity({ subject: `${callerId}|test-session` })
        .query(api.repositories.query.get, { owner: "owner", repo: "repo" });

      expect(repository).toMatchObject({
        invitationUnavailableReason: expectedReason,
      });
    },
  );

  it("fails visibly when duplicate rows exceed the bounded safety limit", async () => {
    const t = convexTest(schema, modules);
    const callerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    for (let index = 0; index <= REPOSITORY_ROUTE_DUPLICATE_LIMIT; index++) {
      await insertRepository(t, ownerId);
    }

    await expect(
      t
        .withIdentity({ subject: `${callerId}|test-session` })
        .query(api.repositories.query.get, { owner: "owner", repo: "repo" }),
    ).rejects.toThrow("repository lookup exceeded the duplicate safety limit");
  });
});
