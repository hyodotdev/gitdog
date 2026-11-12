import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import schema from "../../../convex/schema";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/github/action.ts": () =>
    import("../../../convex/github/action"),
  "../../../convex/github/internalMutation.ts": () =>
    import("../../../convex/github/internalMutation"),
  "../../../convex/github/internalQuery.ts": () =>
    import("../../../convex/github/internalQuery"),
  "../../../convex/repositories/internalMutation.ts": () =>
    import("../../../convex/repositories/internalMutation"),
};

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function insertInstallationAndRepository(
  t: ReturnType<typeof convexTest>,
  githubRepositoryId: number,
): Promise<{
  installationDocId: Id<"githubInstallations">;
  repositoryId: Id<"repositories">;
}> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const now = Date.now();
    const installationDocId = await ctx.db.insert("githubInstallations", {
      userId,
      installationId: 321,
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
      installationId: 321,
      githubRepositoryId,
      githubRepo: `owner/repo-${githubRepositoryId}`,
      githubRepoKey: `owner/repo-${githubRepositoryId}`,
      name: `repo-${githubRepositoryId}`,
      githubUrl: `https://github.com/owner/repo-${githubRepositoryId}`,
      isActive: true,
      indexVersion: 1,
      indexStatus: "completed",
      ragStatus: "completed",
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
    return { installationDocId, repositoryId };
  });
}

async function storeRemovalPayload(
  t: ReturnType<typeof convexTest>,
  repositories: Array<{
    githubRepositoryId: number;
    githubRepo: string;
  }>,
): Promise<Id<"_storage">> {
  return await t.run(
    async (ctx) =>
      await ctx.storage.store(
        new Blob([JSON.stringify(repositories)], { type: "application/json" }),
      ),
  );
}

describe("durable repository removal jobs", () => {
  it("blocks the whole installation before a late removal batch runs", async () => {
    const t = convexTest(schema, modules);
    const lateRepositoryId = 1_050;
    const { installationDocId, repositoryId } =
      await insertInstallationAndRepository(t, lateRepositoryId);
    const removals = Array.from({ length: 51 }, (_, index) => ({
      githubRepositoryId: 1_000 + index,
      githubRepo: `owner/repo-${1_000 + index}`,
    }));
    const payloadStorageId = await storeRemovalPayload(t, removals);

    const created = await t.mutation(
      internal.github.internalMutation.createRepositoryRemovalJob,
      {
        deliveryId: "delivery-late-batch",
        installationId: 321,
        payloadStorageId,
        totalRepositories: removals.length,
      },
    );
    const verifiedBeforeWorker = await t.query(
      internal.github.internalQuery.getVerifiedInstallationByInstallationId,
      { installationId: 321 },
    );
    const repositoryBeforeWorker = await t.run(
      async (ctx) => await ctx.db.get(repositoryId),
    );

    expect(created.created).toBe(true);
    expect(verifiedBeforeWorker).toBeNull();
    expect(repositoryBeforeWorker?.isActive).toBe(true);
    expect(
      (await t.run(async (ctx) => await ctx.db.get(installationDocId)))
        ?.repositoryRemovalPendingAt,
    ).toEqual(expect.any(Number));
  });

  it("deduplicates a repeated delivery and removes its redundant blob", async () => {
    const t = convexTest(schema, modules);
    await insertInstallationAndRepository(t, 654);
    const payload = [{ githubRepositoryId: 654, githubRepo: "owner/repo-654" }];
    const firstStorageId = await storeRemovalPayload(t, payload);
    const secondStorageId = await storeRemovalPayload(t, payload);

    const first = await t.mutation(
      internal.github.internalMutation.createRepositoryRemovalJob,
      {
        deliveryId: "same-delivery",
        installationId: 321,
        payloadStorageId: firstStorageId,
        totalRepositories: 1,
      },
    );
    const duplicate = await t.mutation(
      internal.github.internalMutation.createRepositoryRemovalJob,
      {
        deliveryId: "same-delivery",
        installationId: 321,
        payloadStorageId: secondStorageId,
        totalRepositories: 1,
      },
    );
    const state = await t.run(async (ctx) => ({
      jobs: await ctx.db.query("githubRepositoryRemovalJobs").collect(),
      redundantUrl: await ctx.storage.getUrl(secondStorageId),
    }));

    expect(first.created).toBe(true);
    expect(duplicate).toEqual({ jobId: first.jobId, created: false });
    expect(state.jobs).toHaveLength(1);
    expect(state.redundantUrl).toBeNull();
  });

  it("processes 1,001 removals in bounded batches and clears the gate only after finalization", async () => {
    const t = convexTest(schema, modules);
    const lateRepositoryId = 2_000;
    const { installationDocId, repositoryId } =
      await insertInstallationAndRepository(t, lateRepositoryId);
    const removals = Array.from({ length: 1_001 }, (_, index) => ({
      githubRepositoryId: 1_000 + index,
      githubRepo: `owner/repo-${1_000 + index}`,
    }));
    const payloadStorageId = await storeRemovalPayload(t, removals);
    const created = await t.mutation(
      internal.github.internalMutation.createRepositoryRemovalJob,
      {
        deliveryId: "delivery-1001",
        installationId: 321,
        payloadStorageId,
        totalRepositories: removals.length,
      },
    );

    for (let batch = 0; batch < 20; batch++) {
      await t.action(internal.github.action.continueRepositoryRemovalJob, {
        jobId: created.jobId,
      });
    }
    const beforeLateBatch = await t.run(async (ctx) => ({
      job: await ctx.db.get(created.jobId),
      repository: await ctx.db.get(repositoryId),
      installation: await ctx.db.get(installationDocId),
    }));
    expect(beforeLateBatch.job?.nextOffset).toBe(1_000);
    expect(beforeLateBatch.repository?.isActive).toBe(true);
    expect(beforeLateBatch.installation?.repositoryRemovalPendingAt).toEqual(
      expect.any(Number),
    );

    await t.action(internal.github.action.continueRepositoryRemovalJob, {
      jobId: created.jobId,
    });
    const afterCompletion = await t.run(async (ctx) => ({
      job: await ctx.db.get(created.jobId),
      repository: await ctx.db.get(repositoryId),
      installation: await ctx.db.get(installationDocId),
    }));
    expect(afterCompletion.job).toMatchObject({
      status: "completed",
      nextOffset: 1_001,
    });
    expect(afterCompletion.repository).toMatchObject({
      isActive: false,
      githubAccessRevokedAt: expect.any(Number),
    });
    const epoch =
      afterCompletion.installation?.repositoryAccessReconciliationEpoch;
    expect(typeof epoch).toBe("number");
    expect(afterCompletion.installation).toMatchObject({
      repositoryRemovalPendingAt: expect.any(Number),
      repositoryAccessReconciliationPhase: "fetching",
    });

    if (epoch === undefined) throw new Error("reconciliation epoch missing");
    await t.action(internal.github.action.continueRepositoryRemovalJob, {
      jobId: created.jobId,
    });
    expect(
      (await t.run(async (ctx) => await ctx.db.get(installationDocId)))
        ?.repositoryAccessReconciliationEpoch,
    ).toBe(epoch);

    await t.mutation(
      internal.repositories.internalMutation
        .applyRepositoryAccessReconciliationPage,
      {
        installationId: 321,
        epoch,
        page: 1,
        hasMore: false,
        repositories: [
          {
            githubRepositoryId: lateRepositoryId,
            githubRepo: `owner/repo-${lateRepositoryId}`,
            githubVisibility: "private",
            licenseKey: null,
            licenseSpdxId: null,
          },
        ],
      },
    );
    const beforeFinalization = await t.run(
      async (ctx) => await ctx.db.get(installationDocId),
    );
    expect(beforeFinalization?.repositoryRemovalPendingAt).toEqual(
      expect.any(Number),
    );
    expect(beforeFinalization?.repositoryAccessReconciliationPhase).toBe(
      "finalizing",
    );

    await t.mutation(
      internal.repositories.internalMutation
        .finalizeRepositoryAccessReconciliation,
      {
        installationId: 321,
        epoch,
        paginationOpts: { numItems: 25, cursor: null },
      },
    );
    const finalState = await t.run(async (ctx) => ({
      installation: await ctx.db.get(installationDocId),
      repository: await ctx.db.get(repositoryId),
    }));
    expect(finalState.installation?.repositoryRemovalPendingAt).toBeUndefined();
    expect(finalState.installation?.repositoryAccessReconciliationPhase).toBe(
      undefined,
    );
    expect(finalState.repository).toMatchObject({
      isActive: true,
      githubAccessRestoreIndexPending: true,
    });
    expect(finalState.repository?.githubAccessRevokedAt).toBeUndefined();
  });

  it("defers a failed payload read and recovery re-enqueues the job", async () => {
    const t = convexTest(schema, modules);
    await insertInstallationAndRepository(t, 654);
    const payloadStorageId = await t.run(
      async (ctx) => await ctx.storage.store(new Blob(["invalid json"])),
    );
    const created = await t.mutation(
      internal.github.internalMutation.createRepositoryRemovalJob,
      {
        deliveryId: "delivery-recovery",
        installationId: 321,
        payloadStorageId,
        totalRepositories: 1,
      },
    );
    await t.action(internal.github.action.continueRepositoryRemovalJob, {
      jobId: created.jobId,
    });
    const deferred = await t.run(
      async (ctx) => await ctx.db.get(created.jobId),
    );
    expect(deferred).toMatchObject({
      status: "pending",
      nextOffset: 0,
      retryCount: 1,
      lastError: expect.any(String),
    });
    await t.run(async (ctx) => {
      const replacementStorageId = await ctx.storage.store(
        new Blob([
          JSON.stringify([
            { githubRepositoryId: 654, githubRepo: "owner/repo-654" },
          ]),
        ]),
      );
      await ctx.db.patch(created.jobId, {
        payloadStorageId: replacementStorageId,
        nextAttemptAt: Date.now() - 1,
      });
    });
    const scheduledBefore = await t.run(
      async (ctx) =>
        (await ctx.db.system.query("_scheduled_functions").collect()).filter(
          (scheduled) =>
            scheduled.name === "github/action:continueRepositoryRemovalJob",
        ).length,
    );

    await t.action(internal.github.action.recoverRepositoryRemovalJobs, {});
    const scheduledAfter = await t.run(
      async (ctx) =>
        (await ctx.db.system.query("_scheduled_functions").collect()).filter(
          (scheduled) =>
            scheduled.name === "github/action:continueRepositoryRemovalJob",
        ).length,
    );
    expect(scheduledAfter).toBe(scheduledBefore + 1);

    await t.action(internal.github.action.continueRepositoryRemovalJob, {
      jobId: created.jobId,
    });
    expect(
      (await t.run(async (ctx) => await ctx.db.get(created.jobId)))?.status,
    ).toBe("completed");
  });

  it("falls back to authoritative reconciliation after bounded damaged-payload failures", async () => {
    const t = convexTest(schema, modules);
    const { installationDocId, repositoryId } =
      await insertInstallationAndRepository(t, 654);
    const payloadStorageId = await t.run(
      async (ctx) => await ctx.storage.store(new Blob(["invalid json"])),
    );
    const created = await t.mutation(
      internal.github.internalMutation.createRepositoryRemovalJob,
      {
        deliveryId: "delivery-damaged-terminal",
        installationId: 321,
        payloadStorageId,
        totalRepositories: 1,
      },
    );

    for (let attempt = 0; attempt < 3; attempt++) {
      await t.action(internal.github.action.continueRepositoryRemovalJob, {
        jobId: created.jobId,
      });
    }

    const fallback = await t.run(async (ctx) => ({
      job: await ctx.db.get(created.jobId),
      installation: await ctx.db.get(installationDocId),
      payloadUrl: await ctx.storage.getUrl(payloadStorageId),
    }));
    const epoch = fallback.installation?.repositoryAccessReconciliationEpoch;
    expect(fallback.job).toMatchObject({
      status: "completed",
      retryCount: 3,
      lastError: "PayloadInvalidJson",
      completedAt: expect.any(Number),
    });
    expect(fallback.job?.payloadStorageId).toBeUndefined();
    expect(fallback.payloadUrl).toBeNull();
    expect(fallback.installation).toMatchObject({
      repositoryRemovalPendingAt: expect.any(Number),
      repositoryAccessReconciliationEpoch: expect.any(Number),
      repositoryAccessReconciliationPhase: "fetching",
    });

    if (epoch === undefined) throw new Error("reconciliation epoch missing");
    await t.mutation(
      internal.repositories.internalMutation
        .applyRepositoryAccessReconciliationPage,
      {
        installationId: 321,
        epoch,
        page: 1,
        hasMore: false,
        repositories: [
          {
            githubRepositoryId: 654,
            githubRepo: "owner/repo-654",
            githubVisibility: "private",
            licenseKey: null,
            licenseSpdxId: null,
          },
        ],
      },
    );
    await t.mutation(
      internal.repositories.internalMutation
        .finalizeRepositoryAccessReconciliation,
      {
        installationId: 321,
        epoch,
        paginationOpts: { numItems: 25, cursor: null },
      },
    );
    const finalState = await t.run(async (ctx) => ({
      installation: await ctx.db.get(installationDocId),
      repository: await ctx.db.get(repositoryId),
    }));
    expect(finalState.installation?.repositoryRemovalPendingAt).toBeUndefined();
    expect(finalState.installation?.repositoryAccessReconciliationPhase).toBe(
      undefined,
    );
    expect(finalState.repository?.isActive).toBe(true);
  });

  it("falls back when a removal payload blob has disappeared", async () => {
    const t = convexTest(schema, modules);
    const { installationDocId } = await insertInstallationAndRepository(t, 654);
    const payloadStorageId = await storeRemovalPayload(t, [
      { githubRepositoryId: 654, githubRepo: "owner/repo-654" },
    ]);
    const created = await t.mutation(
      internal.github.internalMutation.createRepositoryRemovalJob,
      {
        deliveryId: "delivery-missing-terminal",
        installationId: 321,
        payloadStorageId,
        totalRepositories: 1,
      },
    );
    await t.run(async (ctx) => await ctx.storage.delete(payloadStorageId));

    for (let attempt = 0; attempt < 3; attempt++) {
      await t.action(internal.github.action.continueRepositoryRemovalJob, {
        jobId: created.jobId,
      });
    }

    const state = await t.run(async (ctx) => ({
      job: await ctx.db.get(created.jobId),
      installation: await ctx.db.get(installationDocId),
    }));
    expect(state.job).toMatchObject({
      status: "completed",
      retryCount: 3,
      lastError: "PayloadBlobMissing",
    });
    expect(state.job?.payloadStorageId).toBeUndefined();
    expect(state.installation).toMatchObject({
      repositoryAccessReconciliationEpoch: expect.any(Number),
      repositoryAccessReconciliationPhase: "fetching",
    });
  });

  it("cannot pause a repository transferred away before a stale job runs", async () => {
    const t = convexTest(schema, modules);
    const { repositoryId } = await insertInstallationAndRepository(t, 654);
    const payloadStorageId = await storeRemovalPayload(t, [
      { githubRepositoryId: 654, githubRepo: "owner/repo-654" },
    ]);
    const created = await t.mutation(
      internal.github.internalMutation.createRepositoryRemovalJob,
      {
        deliveryId: "delivery-transfer-race",
        installationId: 321,
        payloadStorageId,
        totalRepositories: 1,
      },
    );
    await t.run(async (ctx) => {
      const repository = await ctx.db.get(repositoryId);
      if (!repository) throw new Error("repository missing");
      const now = Date.now();
      await ctx.db.insert("githubInstallations", {
        userId: repository.userId,
        installationId: 322,
        ownerGithubAccountId: "verified-owner-new",
        ownershipVerifiedAt: now,
        accountLogin: "owner",
        accountType: "Organization",
        targetType: "Organization",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.patch(repositoryId, { installationId: 322 });
    });

    await t.action(internal.github.action.continueRepositoryRemovalJob, {
      jobId: created.jobId,
    });
    const repository = await t.run(
      async (ctx) => await ctx.db.get(repositoryId),
    );
    expect(repository).toMatchObject({
      installationId: 322,
      isActive: true,
    });
    expect(repository?.githubAccessRevokedAt).toBeUndefined();
  });
});
