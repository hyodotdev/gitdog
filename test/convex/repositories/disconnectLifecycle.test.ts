import { convexTest } from "convex-test";
import { mutationWithTime } from "../scheduling";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { v } from "convex/values";

import { api, internal } from "../../../convex/_generated/api";
import { internalAction } from "../../../convex/_generated/server";
import schema from "../../../convex/schema";
import { CLAIMED_EXECUTION_RECOVERY_GRACE_MS } from "../../../convex/ticketActions/executionRecovery";

const noopIndexRepository = internalAction({
  args: {
    repositoryId: v.id("repositories"),
    expectedIndexVersion: v.number(),
  },
  handler: async () => ({ success: true }),
});

const noopReconcileClaimedExecution = internalAction({
  args: {
    actionId: v.id("ticketActions"),
    expectedClaimedAt: v.number(),
    expectedProposalVersion: v.number(),
    retryAttempt: v.optional(v.number()),
  },
  handler: async () => undefined,
});

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/invitations/mutation.ts": () =>
    import("../../../convex/invitations/mutation"),
  "../../../convex/invitations/query.ts": () =>
    import("../../../convex/invitations/query"),
  "../../../convex/repositories/mutation.ts": () =>
    import("../../../convex/repositories/mutation"),
  "../../../convex/repositories/query.ts": () =>
    import("../../../convex/repositories/query"),
  "../../../convex/repositories/internalQuery.ts": () =>
    import("../../../convex/repositories/internalQuery"),
  "../../../convex/repoIndexing/mutation.ts": () =>
    import("../../../convex/repoIndexing/mutation"),
  "../../../convex/repoIndexing/watchdog.ts": () =>
    import("../../../convex/repoIndexing/watchdog"),
  "../../../convex/repoIndexing/action.ts": async () => ({
    indexRepository: noopIndexRepository,
  }),
  "../../../convex/ticketActions/internalAction.ts": async () => ({
    reconcileClaimedExecution: noopReconcileClaimedExecution,
  }),
  "../../../convex/ticketActions/internalMutation.ts": () =>
    import("../../../convex/ticketActions/internalMutation"),
  "../../../convex/ragV2/internalMutation.ts": () =>
    import("../../../convex/ragV2/internalMutation"),
};

const settings = {
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
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function insertRepository(
  t: ReturnType<typeof convexTest>,
  fields: Record<string, unknown> = {},
) {
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
    const repositoryId = await ctx.db.insert("repositories", {
      indexSyncPending: false,
      userId,
      installationId: 812,
      githubRepositoryId: 456,
      githubRepo: "owner/repo",
      githubRepoKey: "owner/repo",
      name: "repo",
      githubUrl: "https://github.com/owner/repo",
      isActive: true,
      indexVersion: 4,
      indexStatus: "completed",
      indexProgressAt: now,
      ragStatus: "completed",
      ragTotalChunks: 0,
      ragIndexedChunks: 0,
      ragFailedChunks: 0,
      settings,
      monthlyActions: 0,
      lastResetAt: now,
      createdAt: now,
      updatedAt: now,
      ...fields,
    });
    return { userId, repositoryId };
  });
}

describe("repository lifecycle fencing", () => {
  it("applies repeated desired activity states without toggling or duplicate jobs", async () => {
    const t = convexTest(schema, modules);
    const { userId, repositoryId } = await insertRepository(t);
    const owner = t.withIdentity({ subject: `${userId}|test-session` });
    for (let i = 0; i < 2; i++)
      await owner.mutation(api.repositories.mutation.toggleActive, {
        repositoryId,
        isActive: false,
      });
    expect(await t.run((ctx) => ctx.db.get(repositoryId))).toMatchObject({
      isActive: false,
      indexVersion: 5,
    });
    for (let i = 0; i < 2; i++)
      await owner.mutation(api.repositories.mutation.toggleActive, {
        repositoryId,
        isActive: true,
      });
    expect(await t.run((ctx) => ctx.db.get(repositoryId))).toMatchObject({
      isActive: true,
      indexVersion: 5,
    });
    const scheduled = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").take(100)).filter(
        (job) => job.name === "repoIndexing/action:indexRepository",
      ),
    );
    expect(scheduled).toHaveLength(1);
  });

  it("bumps on pause, schedules a fresh resume, and rejects stale publication", async () => {
    const t = convexTest(schema, modules);
    const { userId, repositoryId } = await insertRepository(t);
    const authenticated = t.withIdentity({
      subject: `${userId}|test-session`,
    });

    await authenticated.mutation(api.repositories.mutation.toggleActive, {
      repositoryId,
    });
    await authenticated.mutation(api.repositories.mutation.toggleActive, {
      repositoryId,
    });

    const repository = await t.run(async (ctx) => ctx.db.get(repositoryId));
    expect(repository).toMatchObject({
      isActive: true,
      indexVersion: 5,
      indexStatus: "pending",
      ragStatus: "pending",
    });
    const scheduled = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (job) => job.name === "repoIndexing/action:indexRepository",
      ),
    );
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].args).toEqual([
      { repositoryId, expectedIndexVersion: 5 },
    ]);
    await expect(
      t.mutation(internal.repoIndexing.mutation.mapFile, {
        repositoryId,
        filePath: "src/stale.ts",
        sha256: "stale",
        language: "typescript",
        size: 10,
        isText: true,
        indexVersion: 4,
      }),
    ).rejects.toThrow("stale repository indexing generation");
    await expect(
      t.mutation(internal.ragV2.internalMutation.claimRagGeneration, {
        repositoryId,
        expectedIndexVersion: 4,
      }),
    ).resolves.toBe(false);
  });

  it("rejects an invitation accepted after disconnect starts", async () => {
    const t = convexTest(schema, modules);
    const { userId, repositoryId } = await insertRepository(t);
    const fixture = await t.run(async (ctx) => {
      const now = Date.now();
      const inviteeUserId = await ctx.db.insert("users", {});
      await ctx.db.insert("userProfiles", {
        userId: inviteeUserId,
        githubUsername: "invitee",
        createdAt: now,
        updatedAt: now,
      });
      const invitationId = await ctx.db.insert("invitations", {
        repositoryId,
        invitedByUserId: userId,
        invitedByUsername: "owner",
        inviteeGithubUsername: "invitee",
        inviteeUserId,
        role: "viewer",
        status: "pending",
        createdAt: now,
      });
      return { invitationId, inviteeUserId };
    });
    const owner = t.withIdentity({ subject: `${userId}|test-session` });
    const invitee = t.withIdentity({
      subject: `${fixture.inviteeUserId}|test-session`,
    });

    await owner.mutation(api.repositories.mutation.remove, { repositoryId });

    await expect(
      invitee.query(api.invitations.query.listPending, {}),
    ).resolves.toEqual([]);
    await expect(
      invitee.mutation(api.invitations.mutation.accept, {
        invitationId: fixture.invitationId,
      }),
    ).rejects.toThrow("Repository is no longer available");

    const state = await t.run(async (ctx) => ({
      invitation: await ctx.db.get(fixture.invitationId),
      member: await ctx.db
        .query("repositoryMembers")
        .withIndex("by_repository_and_user", (q) =>
          q
            .eq("repositoryId", repositoryId)
            .eq("userId", fixture.inviteeUserId),
        )
        .first(),
      acceptedNotification: await ctx.db
        .query("notifications")
        .withIndex("by_repository", (q) => q.eq("repositoryId", repositoryId))
        .filter((q) => q.eq(q.field("type"), "invitation_accepted"))
        .first(),
    }));
    expect(state.invitation).toMatchObject({ status: "pending" });
    expect(state.invitation?.respondedAt).toBeUndefined();
    expect(state.member).toBeNull();
    expect(state.acceptedNotification).toBeNull();
  });

  it("hides immediately, resumes every bounded cleanup phase, and preserves only detached history", async () => {
    const t = convexTest(schema, modules);
    const { userId, repositoryId } = await insertRepository(t, {
      indexStatus: "indexing",
      ragStatus: "indexing",
      ragIndexPhase: "files",
    });
    const seeded = await t.run(async (ctx) => {
      const now = Date.now();
      const otherUserId = await ctx.db.insert("users", {});
      const foreignRepositoryId = await ctx.db.insert("repositories", {
        indexSyncPending: false,
        userId: otherUserId,
        installationId: 999,
        githubRepositoryId: 999,
        githubRepo: "other/shared",
        githubRepoKey: "other/shared",
        name: "shared",
        githubUrl: "https://github.com/other/shared",
        isActive: true,
        indexVersion: 1,
        indexStatus: "completed",
        indexProgressAt: now,
        ragStatus: "completed",
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        settings,
        monthlyActions: 0,
        lastResetAt: now,
        createdAt: now,
        updatedAt: now,
      });
      const sharedStorageId = await ctx.storage.store(new Blob(["shared"]));
      await ctx.db.insert("repoFileBlobs", {
        sha256: "shared-sha",
        storageId: sharedStorageId,
        size: 6,
        createdAt: now,
        lastAccessedAt: now,
        accessCount: 1,
      });
      await ctx.db.insert("repoFileMap", {
        repositoryId: foreignRepositoryId,
        filePath: "shared.ts",
        sha256: "shared-sha",
        size: 6,
        isText: true,
        indexVersion: 1,
        createdAt: now,
        updatedAt: now,
      });

      for (let index = 0; index < 55; index++) {
        await ctx.db.insert("repoChunks", {
          repositoryId,
          repositoryIndexKey: `${repositoryId}:4`,
          chunkId: `chunk-${index}`,
          path: `src/file-${index}.ts`,
          language: "typescript",
          code: "export const value = 1;",
          startLine: 1,
          endLine: 1,
          symbols: ["value"],
          searchableText: "value",
          contentHash: `hash-${index}`,
          indexVersion: 4,
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.insert("repoFileMap", {
          repositoryId,
          filePath: `src/file-${index}.ts`,
          sha256: "shared-sha",
          size: 6,
          isText: true,
          indexVersion: 4,
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.insert("repoIndexingLogs", {
          repositoryId,
          indexVersion: 4,
          level: "info",
          message: `log-${index}`,
          createdAt: now,
        });
        await ctx.db.insert("tokenUsage", {
          userId,
          repositoryId,
          usageType: "chat",
          inputTokens: 1,
          outputTokens: 0,
          totalTokens: 1,
          purchasedTokensDebited: 0,
          inputCostCents: 0,
          outputCostCents: 0,
          baseCostCents: 0,
          serviceFeeCents: 0,
          totalCostCents: 0,
          model: "test",
          provider: "google",
          serviceFeeRate: 0,
          createdAt: now,
        });
      }
      await ctx.db.insert("repoLearnings", {
        repositoryId,
        content: "learning",
        source: "test",
        sourceType: "correction",
        isTrusted: false,
        embeddingDataProvenance: "private_user_input",
        createdAt: now,
      });
      await ctx.db.insert("ragEmbeddingBatches", {
        reservationKey: "batch",
        repositoryId,
        embeddingKey: "openai:test",
        embeddings: [[]],
        createdAt: now,
        updatedAt: now,
      });
      const invitationId = await ctx.db.insert("invitations", {
        repositoryId,
        invitedByUserId: userId,
        invitedByUsername: "owner",
        inviteeGithubUsername: "member",
        inviteeUserId: otherUserId,
        role: "viewer",
        status: "pending",
        createdAt: now,
      });
      await ctx.db.insert("repositoryMembers", {
        repositoryId,
        userId: otherUserId,
        githubUsername: "member",
        role: "viewer",
        joinedVia: "invitation",
        invitationId,
        joinedAt: now,
      });
      const notificationId = await ctx.db.insert("notifications", {
        userId: otherUserId,
        type: "invitation_received",
        invitationId,
        repositoryId,
        title: "Invitation",
        message: "Join",
        isRead: false,
        createdAt: now,
      });
      const ticketId = await ctx.db.insert("tickets", {
        aiInputVersion: 1,
        repositoryId,
        userId,
        githubRepo: "owner/repo",
        ticketType: "issue",
        githubNumber: 1,
        githubTitle: "Issue",
        status: "open",
        createdAt: now,
      });
      const referencedActionId = await ctx.db.insert("ticketActions", {
        ticketId,
        actionType: "answer",
        chatHistory: [],
        proposalVersion: 0,
        status: "pending_approval",
        createdAt: now,
      });
      for (let index = 1; index < 55; index++) {
        await ctx.db.insert("ticketActions", {
          ticketId,
          actionType: "answer",
          chatHistory: [],
          proposalVersion: 0,
          status: "pending_approval",
          createdAt: now,
        });
      }
      const linkedUsageId = await ctx.db.insert("tokenUsage", {
        userId,
        ticketActionId: referencedActionId,
        repositoryId,
        usageType: "chat",
        inputTokens: 1,
        outputTokens: 0,
        totalTokens: 1,
        purchasedTokensDebited: 0,
        inputCostCents: 0,
        outputCostCents: 0,
        baseCostCents: 0,
        serviceFeeCents: 0,
        totalCostCents: 0,
        model: "test",
        provider: "google",
        serviceFeeRate: 0,
        createdAt: now,
      });
      const aiLogId = await ctx.db.insert("aiLogs", {
        repositoryId,
        userId,
        ticketActionId: referencedActionId,
        workflowType: "indexing",
        status: "success",
        createdAt: now,
      });
      const reservationId = await ctx.db.insert("embeddingUsageReservations", {
        reservationKey: "pending-provider-attempt",
        attemptToken: "pending-provider-attempt:attempt:1",
        userId,
        repositoryId,
        operation: "rag",
        inputCount: 1,
        providerTokenLimit: 10,
        reservedTokens: 10,
        entitlementPlan: "free",
        includedTokens: 100_000,
        serviceFeeRate: 0.25,
        quotaPeriodStart: 0,
        quotaPeriodEnd: Number.MAX_SAFE_INTEGER,
        status: "ambiguous",
        expiresAt: now + 60_000,
        createdAt: now,
        updatedAt: now,
      });
      const queueStorageId = await ctx.storage.store(
        new Blob(["tree-response"]),
      );
      const snapshotId = await ctx.db.insert("repoTreeSnapshots", {
        repositoryId,
        indexVersion: 4,
        defaultBranch: "main",
        commitSha: "commit",
        treeSha: "tree",
        totalFiles: 0,
        totalPages: 0,
        status: "ready",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("repoTreeTraversalQueue", {
        snapshotId,
        identityKey: "tree:",
        sha: "tree",
        prefix: "",
        responseStorageId: queueStorageId,
        itemOffset: 0,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.patch(repositoryId, { indexTreeSnapshotId: snapshotId });
      return {
        aiLogId,
        foreignRepositoryId,
        linkedUsageId,
        notificationId,
        queueStorageId,
        referencedActionId,
        reservationId,
        sharedStorageId,
        snapshotId,
        ticketId,
      };
    });

    const authenticated = t.withIdentity({
      subject: `${userId}|test-session`,
    });
    await authenticated.mutation(api.repositories.mutation.remove, {
      repositoryId,
    });
    await expect(
      authenticated.query(api.repositories.query.list, {}),
    ).resolves.toEqual([]);
    await expect(
      t.query(internal.repositories.internalQuery.getById, { repositoryId }),
    ).resolves.toBeNull();
    await expect(
      authenticated.mutation(api.repositories.mutation.create, {
        installationId: 812,
        githubRepositoryId: 456,
        githubRepo: "owner/repo",
        name: "repo",
        githubUrl: "https://github.com/owner/repo",
      }),
    ).rejects.toThrow("disconnect cleanup is still in progress");

    for (let attempt = 0; attempt < 100; attempt++) {
      const repository = await t.run(async (ctx) => ctx.db.get(repositoryId));
      if (!repository) break;
      const snapshot = await t.run(async (ctx) =>
        ctx.db.get(seeded.snapshotId),
      );
      if (snapshot?.status === "deleting") {
        await t.mutation(
          internal.repoIndexing.mutation.continueIndexTreeSnapshotCleanup,
          { snapshotId: seeded.snapshotId },
        );
      }
      await t.mutation(
        internal.repositories.mutation.continueRepositoryDisconnectCleanup,
        { repositoryId },
      );
    }

    await expect(
      t.mutation(internal.repoIndexing.mutation.addIndexingLog, {
        repositoryId,
        indexVersion: 5,
        level: "info",
        message: "late worker",
      }),
    ).resolves.toBeNull();

    const final = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      chunks: await ctx.db
        .query("repoChunks")
        .withIndex("by_repository", (q) => q.eq("repositoryId", repositoryId))
        .collect(),
      maps: await ctx.db
        .query("repoFileMap")
        .withIndex("by_repository", (q) => q.eq("repositoryId", repositoryId))
        .collect(),
      indexingLogs: await ctx.db
        .query("repoIndexingLogs")
        .withIndex("by_repository", (q) => q.eq("repositoryId", repositoryId))
        .collect(),
      usage: await ctx.db
        .query("tokenUsage")
        .withIndex("by_repository", (q) => q.eq("repositoryId", repositoryId))
        .collect(),
      ticket: await ctx.db.get(seeded.ticketId),
      pendingActions: await ctx.db
        .query("ticketActions")
        .withIndex("by_ticket_and_status", (q) =>
          q.eq("ticketId", seeded.ticketId).eq("status", "pending_approval"),
        )
        .collect(),
      actions: await ctx.db
        .query("ticketActions")
        .withIndex("by_ticket", (q) => q.eq("ticketId", seeded.ticketId))
        .collect(),
      referencedAction: await ctx.db.get(seeded.referencedActionId),
      linkedUsage: await ctx.db.get(seeded.linkedUsageId),
      aiLog: await ctx.db.get(seeded.aiLogId),
      notification: await ctx.db.get(seeded.notificationId),
      reservation: await ctx.db.get(seeded.reservationId),
      foreignMap: await ctx.db
        .query("repoFileMap")
        .withIndex("by_repository", (q) =>
          q.eq("repositoryId", seeded.foreignRepositoryId),
        )
        .first(),
      sharedStorageUrl: await ctx.storage.getUrl(seeded.sharedStorageId),
      queueStorageUrl: await ctx.storage.getUrl(seeded.queueStorageId),
    }));
    expect(final.repository).toBeNull();
    expect(final.chunks).toHaveLength(0);
    expect(final.maps).toHaveLength(0);
    expect(final.indexingLogs).toHaveLength(0);
    expect(final.usage).toHaveLength(0);
    expect(final.ticket?.repositoryId).toBeUndefined();
    expect(final.pendingActions).toHaveLength(0);
    expect(final.actions).toHaveLength(55);
    expect(final.actions.every((action) => action.status === "failed")).toBe(
      true,
    );
    expect(final.referencedAction).not.toBeNull();
    expect(final.linkedUsage?.ticketActionId).toBe(seeded.referencedActionId);
    expect(final.linkedUsage?.repositoryId).toBeUndefined();
    expect(final.aiLog?.repositoryId).toBeUndefined();
    expect(final.notification?.repositoryId).toBeUndefined();
    expect(final.notification?.invitationId).toBeUndefined();
    expect(final.reservation).toMatchObject({
      repositoryId,
      status: "ambiguous",
    });
    expect(final.foreignMap).not.toBeNull();
    expect(final.sharedStorageUrl).not.toBeNull();
    expect(final.queueStorageUrl).toBeNull();
  });

  it("keeps a freshly reused shared blob across the disconnect map phase", async () => {
    const t = convexTest(schema, modules);
    const { userId, repositoryId } = await insertRepository(t);
    const fixture = await t.run(async (ctx) => {
      const now = Date.now();
      const otherUserId = await ctx.db.insert("users", {});
      await ctx.db.insert("githubInstallations", {
        userId: otherUserId,
        installationId: 999,
        ownerGithubAccountId: "reusing-owner",
        ownershipVerifiedAt: now,
        accountLogin: "other",
        accountType: "Organization",
        targetType: "Organization",
        createdAt: now,
        updatedAt: now,
      });
      const foreignRepositoryId = await ctx.db.insert("repositories", {
        indexSyncPending: false,
        userId: otherUserId,
        installationId: 999,
        githubRepositoryId: 1_999,
        githubRepo: "other/reusing",
        githubRepoKey: "other/reusing",
        name: "reusing",
        githubUrl: "https://github.com/other/reusing",
        isActive: true,
        indexVersion: 1,
        indexStatus: "indexing",
        indexProgressAt: now,
        indexIdentityVerifiedVersion: 1,
        indexIdentityVerifiedInstallationId: 999,
        indexIdentityVerifiedGithubRepositoryId: 1_999,
        indexIdentityVerifiedGithubRepo: "other/reusing",
        ragStatus: "pending",
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        settings,
        monthlyActions: 0,
        lastResetAt: now,
        createdAt: now,
        updatedAt: now,
      });
      const storageId = await ctx.storage.store(new Blob(["race"]));
      await ctx.db.insert("repoFileBlobs", {
        sha256: "race-sha",
        storageId,
        size: 4,
        createdAt: now - 10 * 24 * 60 * 60 * 1_000,
        lastAccessedAt: now - 10 * 24 * 60 * 60 * 1_000,
        accessCount: 1,
      });
      await ctx.db.insert("repoFileMap", {
        repositoryId,
        filePath: "old.ts",
        sha256: "race-sha",
        size: 4,
        isText: true,
        indexVersion: 4,
        createdAt: now,
        updatedAt: now,
      });
      return { foreignRepositoryId, otherUserId, storageId };
    });
    const authenticated = t.withIdentity({
      subject: `${userId}|test-session`,
    });
    await authenticated.mutation(api.repositories.mutation.remove, {
      repositoryId,
    });
    for (let step = 0; step < 3; step++) {
      await t.mutation(
        internal.repositories.mutation.continueRepositoryDisconnectCleanup,
        { repositoryId },
      );
    }

    await expect(
      t.mutation(internal.repoIndexing.mutation.reuseFileBlob, {
        repositoryId: fixture.foreignRepositoryId,
        expectedUserId: fixture.otherUserId,
        expectedInstallationId: 999,
        expectedGithubRepositoryId: 1_999,
        expectedGithubRepo: "other/reusing",
        expectedIndexVersion: 1,
        filePath: "new.ts",
        sha256: "race-sha",
        size: 4,
        isText: true,
      }),
    ).resolves.toBe(true);

    const state = await t.run(async (ctx) => ({
      map: await ctx.db
        .query("repoFileMap")
        .withIndex("by_repository_and_path", (q) =>
          q
            .eq("repositoryId", fixture.foreignRepositoryId)
            .eq("filePath", "new.ts"),
        )
        .first(),
      storageUrl: await ctx.storage.getUrl(fixture.storageId),
    }));
    expect(state.map?.sha256).toBe("race-sha");
    expect(state.storageUrl).not.toBeNull();
  });

  it("re-enqueues a stale cleanup workflow", async () => {
    const t = convexTest(schema, modules);
    const { repositoryId } = await insertRepository(t, {
      isActive: false,
      disconnectCleanupPending: true,
      disconnectCleanupPhase: "chunks",
      updatedAt: Date.now() - 10 * 60 * 1_000,
    });

    await expect(
      t.mutation(
        internal.repositories.mutation.recoverStalledDisconnectCleanups,
        {},
      ),
    ).resolves.toBe(1);
    const scheduled = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (job) =>
          job.name ===
          "repositories/mutation:continueRepositoryDisconnectCleanup",
      ),
    );
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].args).toEqual([{ repositoryId }]);
  });

  it("reconciles a claimed GitHub write before disconnect cleanup detaches its ticket", async () => {
    const t = convexTest(schema, modules);
    const { userId, repositoryId } = await insertRepository(t, {
      isActive: false,
      disconnectCleanupPending: true,
      disconnectCleanupPhase: "tickets",
    });
    const now = Date.now();
    const { ticketId, actionId } = await t.run(async (ctx) => {
      const ticketId = await ctx.db.insert("tickets", {
        repositoryId,
        userId,
        githubRepo: "owner/repo",
        ticketType: "issue",
        githubNumber: 42,
        githubTitle: "Original title",
        githubBody: "Original body",
        aiInputVersion: 1,
        status: "open",
        createdAt: now,
      });
      const actionId = await ctx.db.insert("ticketActions", {
        ticketId,
        actionType: "answer",
        chatHistory: [],
        proposedChanges: {
          originalTitle: "Original title",
          originalBody: "Original body",
          suggestedResponse: "Answer",
          groundedIndexVersion: 4,
        },
        proposalVersion: 0,
        status: "approved",
        executionClaimedAt: now,
        executionIdempotencyKey: "00000000-0000-4000-8000-000000000000",
        executionRecoveryMode: "auto_approved",
        executionRecoveryExpiresAt: now + 60_000,
        executionRecoveryLeaseUntil: now + 60_000,
        createdAt: now,
      });
      return { ticketId, actionId };
    });

    const cleanup = await mutationWithTime(
      t,
      internal.repositories.mutation.continueRepositoryDisconnectCleanup,
      { repositoryId },
    );
    expect(cleanup.result).toEqual({ completed: false, processed: 1 });
    expect(cleanup.now).toBeGreaterThanOrEqual(now);
    const reconciling = await t.run(async (ctx) => ({
      action: await ctx.db.get(actionId),
      ticket: await ctx.db.get(ticketId),
      schedules: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(reconciling.action).toMatchObject({
      status: "approved",
      executionClaimedAt: now,
      executionRecoveryReconcileOnly: true,
      executionRecoveryReconcileDeadlineAt: expect.any(Number),
      executionRecoveryScheduleId: expect.any(String),
    });
    expect(reconciling.ticket?.repositoryId).toBe(repositoryId);
    const reconciliationSchedule = reconciling.schedules.find(
      (job) =>
        job.name === "ticketActions/internalAction:reconcileClaimedExecution",
    );
    expect(reconciliationSchedule).toMatchObject({
      scheduledTime: cleanup.now + CLAIMED_EXECUTION_RECOVERY_GRACE_MS,
      state: { kind: "pending" },
    });

    await t.run(async (ctx) => {
      await ctx.db.patch(actionId, {
        executionRecoveryReconcileDeadlineAt: Date.now() - 1,
      });
    });
    await expect(
      t.mutation(
        internal.repositories.mutation.continueRepositoryDisconnectCleanup,
        { repositoryId },
      ),
    ).resolves.toEqual({ completed: false, processed: 1 });
    const terminal = await t.run(async (ctx) => ctx.db.get(actionId));
    expect(terminal).toMatchObject({
      status: "failed",
      executionClaimedAt: now,
      errorMessage:
        "Repository disconnect completed before the external GitHub outcome could be verified",
      completedAt: expect.any(Number),
    });
    expect(terminal?.executionIdempotencyKey).toBeUndefined();
    expect(terminal?.executionRecoveryScheduleId).toBeUndefined();
  });

  it("allows an in-flight claimed write to complete during the disconnect grace", async () => {
    const t = convexTest(schema, modules);
    const { userId, repositoryId } = await insertRepository(t, {
      isActive: false,
      disconnectCleanupPending: true,
      disconnectCleanupPhase: "tickets",
    });
    const claimedAt = Date.now();
    const { ticketId, actionId } = await t.run(async (ctx) => {
      const ticketId = await ctx.db.insert("tickets", {
        repositoryId,
        userId,
        githubRepo: "owner/repo",
        ticketType: "issue",
        githubNumber: 43,
        githubTitle: "Original title",
        githubBody: "Original body",
        aiInputVersion: 1,
        status: "open",
        createdAt: claimedAt,
      });
      const actionId = await ctx.db.insert("ticketActions", {
        ticketId,
        actionType: "answer",
        chatHistory: [],
        proposedChanges: {
          originalTitle: "Original title",
          originalBody: "Original body",
          suggestedResponse: "Answer",
          groundedIndexVersion: 4,
        },
        proposalVersion: 0,
        status: "approved",
        executionClaimedAt: claimedAt,
        executionIdempotencyKey: "00000000-0000-4000-8000-000000000001",
        executionRecoveryMode: "auto_approved",
        executionRecoveryExpiresAt: claimedAt + 60_000,
        executionRecoveryLeaseUntil: claimedAt + 60_000,
        createdAt: claimedAt,
      });
      return { ticketId, actionId };
    });

    await t.mutation(
      internal.repositories.mutation.continueRepositoryDisconnectCleanup,
      { repositoryId },
    );
    const armed = await t.run(async (ctx) => ctx.db.get(actionId));
    expect(armed).toMatchObject({
      status: "approved",
      executionRecoveryReconcileOnly: true,
      executionRecoveryScheduleId: expect.any(String),
    });

    await expect(
      t.mutation(
        internal.ticketActions.internalMutation.completeClaimedExecution,
        {
          actionId,
          expectedClaimedAt: claimedAt,
          expectedProposalVersion: 0,
          result: {
            success: true,
            commentId: 9_001,
            postedComment: true,
          },
        },
      ),
    ).resolves.toBe(true);
    await expect(
      t.mutation(
        internal.repositories.mutation.continueRepositoryDisconnectCleanup,
        { repositoryId },
      ),
    ).resolves.toEqual({ completed: false, processed: 1 });

    const settled = await t.run(async (ctx) => ({
      action: await ctx.db.get(actionId),
      ticket: await ctx.db.get(ticketId),
    }));
    expect(settled.action).toMatchObject({
      status: "completed",
      executionResult: {
        success: true,
        commentId: 9_001,
        postedComment: true,
      },
    });
    expect(settled.action?.executionRecoveryScheduleId).toBeUndefined();
    expect(settled.ticket?.repositoryId).toBeUndefined();
  });
});
