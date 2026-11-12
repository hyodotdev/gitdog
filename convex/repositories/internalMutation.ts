import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { armIndexWatchdog } from "../repoIndexing/watchdog";
import { scheduleRepositoryTreeSnapshotCleanup } from "../repoIndexing/treeSnapshot";
import { getCanonicalGitHubRepositoryFullNameKey } from "../github/repositoryIdentity";
import {
  canApplyGitHubRepositoryMetadataWebhook,
  getExactGitHubInstallation,
  isGitHubInstallationReady,
} from "../github/installationAccess";
import { allocateRepositoryAccessReconciliationRevision } from "../github/internalMutation";
import { REPOSITORY_ACCESS_RECONCILIATION_ATTEMPT_LEASE_MS } from "../github/repositoryAccessReconciliation";
import { pauseRepositoryForAccessRemoval } from "./accessLifecycle";
import {
  getRepositoryNameQuarantineFullName,
  readCanonicalRepositoryNameMatches,
} from "./nameIdentity";
import {
  readRepositoriesByInstallationAndGitHubRepositoryId,
  readRepositoriesByUserAndGitHubRepositoryId,
  resolveUniquePreferredRepositoryIdentity,
} from "./immutableIdentity";

const ACCESS_REMOVAL_PAGE_SIZE = 25;

function nextMetadataRevision(repository: Doc<"repositories">): number {
  return Math.max(
    Date.now(),
    (repository.repositoryMetadataCheckedAt ?? 0) + 1,
  );
}

function shouldRestartRepositoryIndexGeneration(
  repository: Doc<"repositories">,
  identityChanged: boolean,
  embeddingPolicyChanged: boolean,
): boolean {
  const fileIndexActive =
    repository.indexStatus === "pending" ||
    repository.indexStatus === "indexing";
  const ragIndexActive =
    repository.ragStatus === "pending" || repository.ragStatus === "indexing";
  return (
    fileIndexActive ||
    (identityChanged && ragIndexActive) ||
    (embeddingPolicyChanged && repository.ragStatus === "indexing")
  );
}

/**
 * Invalidate the exact publication identity without stranding active work.
 * A metadata change during indexing advances the generation atomically so
 * late writers fail their version fence while a fresh generation is durable.
 */
async function invalidateRepositoryIndexIdentity(
  ctx: MutationCtx,
  repository: Doc<"repositories">,
  identityChanged: boolean,
  embeddingPolicyChanged: boolean,
): Promise<void> {
  if (
    !shouldRestartRepositoryIndexGeneration(
      repository,
      identityChanged,
      embeddingPolicyChanged,
    )
  ) {
    await ctx.db.patch(repository._id, {
      indexIdentityVerifiedVersion: undefined,
      indexIdentityVerifiedInstallationId: undefined,
      indexIdentityVerifiedGithubRepositoryId: undefined,
      indexIdentityVerifiedGithubRepo: undefined,
    });
    return;
  }

  await scheduleRepositoryTreeSnapshotCleanup(
    ctx,
    repository.indexTreeSnapshotId,
  );

  const now = Date.now();
  const indexVersion = repository.indexVersion + 1;
  const watchdog = await armIndexWatchdog(ctx, {
    repositoryId: repository._id,
    expectedIndexVersion: indexVersion,
    previousScheduleId: repository.indexWatchdogScheduleId,
    previousSequence: repository.indexWatchdogSequence,
  });
  await ctx.db.patch(repository._id, {
    indexVersion,
    indexStatus: "pending",
    indexError: undefined,
    ragStatus: "pending",
    ragError: undefined,
    ragTotalChunks: 0,
    ragIndexedChunks: 0,
    ragFailedChunks: 0,
    ragEmbeddingMode: undefined,
    ragEmbeddingBillingTier: undefined,
    ragEmbeddingKey: undefined,
    ragEmbeddingError: undefined,
    ragIndexPhase: undefined,
    ragIndexCursor: undefined,
    ragIndexFileOffset: undefined,
    ragIndexChunkOffset: undefined,
    ragContinuationToken: undefined,
    ragProcessedFiles: undefined,
    indexSyncPending: false,
    indexWatchdogToken: watchdog.token,
    indexWatchdogScheduleId: watchdog.scheduleId,
    indexWatchdogSequence: watchdog.sequence,
    indexWatchdogRetryCount: 0,
    indexTreeSnapshotId: undefined,
    indexRateLimitRetryToken: undefined,
    indexRateLimitRetryAt: undefined,
    indexIdentityVerifiedVersion: undefined,
    indexIdentityVerifiedInstallationId: undefined,
    indexIdentityVerifiedGithubRepositoryId: undefined,
    indexIdentityVerifiedGithubRepo: undefined,
    indexProgressAt: now,
    updatedAt: now,
  });
  await ctx.scheduler.runAfter(
    0,
    internal.repoIndexing.action.indexRepository,
    { repositoryId: repository._id, expectedIndexVersion: indexVersion },
  );
}

function getLatestRepositoryIdentityRevision(
  repository: Doc<"repositories">,
): number | undefined {
  const revisions = [
    repository.githubMetadataRevision,
    repository.githubAccessReconciliationRevision,
  ].filter((revision): revision is number => revision !== undefined);
  return revisions.length === 0 ? undefined : Math.max(...revisions);
}

async function quarantineRepositoryForNameReuse(
  ctx: MutationCtx,
  repository: Doc<"repositories">,
): Promise<void> {
  await pauseRepositoryForAccessRemoval(ctx, repository);

  const githubRepo = getRepositoryNameQuarantineFullName(repository);
  await ctx.db.patch(repository._id, {
    githubRepo,
    githubRepoKey: getCanonicalGitHubRepositoryFullNameKey(githubRepo),
    githubUrl: `https://github.com/${githubRepo}`,
    indexIdentityVerifiedVersion: undefined,
    indexIdentityVerifiedInstallationId: undefined,
    indexIdentityVerifiedGithubRepositoryId: undefined,
    indexIdentityVerifiedGithubRepo: undefined,
    updatedAt: Date.now(),
  });
}

/**
 * Let a live immutable identity claim its authoritative mutable name. A newer
 * active metadata revision may defer an older reconciliation, but stale rows
 * are fenced and moved off the canonical lookup key in this transaction.
 */
async function releaseRepositoryNameForAuthoritativeIdentity(
  ctx: MutationCtx,
  repository: Doc<"repositories">,
  githubRepo: string,
  incomingRevision: number | undefined,
): Promise<boolean> {
  const { repositories: matches } = await readCanonicalRepositoryNameMatches(
    ctx,
    {
      userId: repository.userId,
      githubRepo,
    },
  );

  const conflicts = matches.filter((match) => match._id !== repository._id);
  const hasNewerActiveConflict = conflicts.some((conflict) => {
    const revision = getLatestRepositoryIdentityRevision(conflict);
    return (
      conflict.disconnectCleanupPending !== true &&
      conflict.isActive === true &&
      conflict.githubAccessRevokedAt === undefined &&
      revision !== undefined &&
      (incomingRevision === undefined || revision > incomingRevision)
    );
  });
  if (hasNewerActiveConflict) {
    return false;
  }

  for (const conflict of conflicts) {
    await quarantineRepositoryForNameReuse(ctx, conflict);
  }
  return true;
}

/** Refresh metadata only after immutable repository identity already matches. */
export const updateInstallationId = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    installationId: v.number(),
    githubRepositoryId: v.number(),
    githubRepo: v.string(),
    name: v.string(),
    githubUrl: v.string(),
    description: v.optional(v.string()),
    language: v.optional(v.string()),
    stars: v.number(),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const [repository, installation] = await Promise.all([
      ctx.db.get(args.repositoryId),
      getExactGitHubInstallation(ctx, args.installationId),
    ]);
    if (
      !repository ||
      repository.userId !== args.userId ||
      !isGitHubInstallationReady(installation) ||
      installation.userId !== args.userId ||
      repository.installationId !== args.installationId ||
      repository.isActive !== true ||
      repository.disconnectCleanupPending === true
    ) {
      return { status: "not_authorized" as const };
    }
    if (repository.githubAccessRevokedAt !== undefined) {
      return { status: "access_revoked" as const };
    }
    if (repository.githubRepositoryId !== args.githubRepositoryId) {
      return { status: "identity_mismatch" as const };
    }
    const metadataRevision =
      await allocateRepositoryAccessReconciliationRevision(ctx);
    const identityChanged = repository.githubRepo !== args.githubRepo;
    const nameReleased = await releaseRepositoryNameForAuthoritativeIdentity(
      ctx,
      repository,
      args.githubRepo,
      metadataRevision,
    );
    if (!nameReleased) {
      return { status: "name_conflict" as const };
    }

    if (identityChanged) {
      await invalidateRepositoryIndexIdentity(ctx, repository, true, false);
    }
    await ctx.db.patch(args.repositoryId, {
      installationId: args.installationId,
      githubRepositoryId: args.githubRepositoryId,
      githubRepo: args.githubRepo,
      githubRepoKey: getCanonicalGitHubRepositoryFullNameKey(args.githubRepo),
      name: args.name,
      githubUrl: args.githubUrl,
      description: args.description,
      language: args.language,
      stars: args.stars,
      githubMetadataRevision: metadataRevision,
      updatedAt: Date.now(),
    });
    return { status: "updated" as const };
  },
});

/** Persist one live GitHub metadata check without overwriting a newer check. */
export const updateEmbeddingPolicyMetadata = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    expectedMetadataCheckedAt: v.optional(v.number()),
    expectedInstallationId: v.number(),
    expectedGithubRepositoryId: v.number(),
    expectedGithubRepo: v.string(),
    githubVisibility: v.union(
      v.literal("public"),
      v.literal("private"),
      v.literal("internal"),
      v.null(),
    ),
    licenseKey: v.union(v.string(), v.null()),
    licenseSpdxId: v.union(v.string(), v.null()),
    licenseOsiApproved: v.boolean(),
    licenseOsiCheckedAt: v.union(v.number(), v.null()),
  },
  returns: v.union(v.number(), v.null()),
  handler: async (ctx, args): Promise<number | null> => {
    const [repository, installation] = await Promise.all([
      ctx.db.get(args.repositoryId),
      getExactGitHubInstallation(ctx, args.expectedInstallationId),
    ]);
    if (
      !repository ||
      !repository.isActive ||
      repository.disconnectCleanupPending === true ||
      repository.githubAccessRevokedAt !== undefined ||
      repository.installationId !== args.expectedInstallationId ||
      repository.githubRepositoryId !== args.expectedGithubRepositoryId ||
      repository.githubRepo !== args.expectedGithubRepo ||
      repository.repositoryMetadataCheckedAt !==
        args.expectedMetadataCheckedAt ||
      !isGitHubInstallationReady(installation) ||
      installation.userId !== repository.userId
    ) {
      return null;
    }

    const now = Date.now();
    const repositoryMetadataCheckedAt = nextMetadataRevision(repository);
    await ctx.db.patch(args.repositoryId, {
      githubVisibility: args.githubVisibility ?? undefined,
      licenseKey: args.licenseKey ?? undefined,
      licenseSpdxId: args.licenseSpdxId ?? undefined,
      licenseOsiApproved: args.licenseOsiApproved,
      licenseOsiCheckedAt: args.licenseOsiCheckedAt ?? undefined,
      repositoryMetadataCheckedAt,
      updatedAt: now,
    });
    return repositoryMetadataCheckedAt;
  },
});

/** Apply a fail-closed downgrade from a verified GitHub repository webhook. */
export const downgradeEmbeddingPolicyMetadata = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    expectedMetadataCheckedAt: v.optional(v.number()),
    expectedInstallationId: v.number(),
    expectedGithubRepositoryId: v.number(),
    expectedGithubRepo: v.string(),
    githubVisibility: v.union(
      v.literal("public"),
      v.literal("private"),
      v.literal("internal"),
      v.null(),
    ),
    licenseKey: v.union(v.string(), v.null()),
    licenseSpdxId: v.union(v.string(), v.null()),
  },
  returns: v.union(v.number(), v.null()),
  handler: async (ctx, args): Promise<number | null> => {
    const [repository, installation] = await Promise.all([
      ctx.db.get(args.repositoryId),
      getExactGitHubInstallation(ctx, args.expectedInstallationId),
    ]);
    if (
      !repository ||
      !repository.isActive ||
      repository.disconnectCleanupPending === true ||
      repository.githubAccessRevokedAt !== undefined ||
      repository.installationId !== args.expectedInstallationId ||
      repository.githubRepositoryId !== args.expectedGithubRepositoryId ||
      repository.githubRepo !== args.expectedGithubRepo ||
      repository.repositoryMetadataCheckedAt !==
        args.expectedMetadataCheckedAt ||
      !isGitHubInstallationReady(installation) ||
      installation.userId !== repository.userId
    ) {
      return null;
    }

    const now = Date.now();
    const repositoryMetadataCheckedAt = nextMetadataRevision(repository);
    await ctx.db.patch(args.repositoryId, {
      githubVisibility: args.githubVisibility ?? undefined,
      licenseKey: args.licenseKey ?? undefined,
      licenseSpdxId: args.licenseSpdxId ?? undefined,
      licenseOsiApproved: false,
      licenseOsiCheckedAt: undefined,
      repositoryMetadataCheckedAt,
      updatedAt: now,
    });
    return repositoryMetadataCheckedAt;
  },
});

/** Pause one repository removed from a GitHub App installation selection. */
export const pauseRepositoryAfterAccessRemoval = internalMutation({
  args: {
    installationId: v.number(),
    githubRepositoryId: v.number(),
  },
  returns: v.number(),
  handler: async (ctx, args): Promise<number> => {
    const identityMatches =
      await readRepositoriesByInstallationAndGitHubRepositoryId(
        ctx,
        args.installationId,
        args.githubRepositoryId,
      );
    if (identityMatches.length > 0) {
      for (const identityMatch of identityMatches) {
        await pauseRepositoryForAccessRemoval(ctx, identityMatch);
      }
      return identityMatches.length;
    }
    return 0;
  },
});

async function restoreRepositoryFromLiveAccess(
  ctx: MutationCtx,
  repository: Doc<"repositories">,
  args: {
    installationId: number;
    githubRepositoryId: number;
    githubRepo: string;
    metadataRevision?: number;
  },
): Promise<boolean> {
  if (repository.disconnectCleanupPending === true) {
    return false;
  }
  if (repository.githubAccessRevokedAt === undefined) {
    const shouldIndex =
      repository.githubAccessRestoreIndexPending === true ||
      repository.indexSyncPending;
    if (
      repository.indexSyncPending &&
      repository.githubAccessRestoreIndexPending !== true
    ) {
      const now = Date.now();
      await ctx.db.patch(repository._id, {
        githubAccessRestoreIndexPending: true,
        githubAccessRestoreIndexNextAttemptAt: now,
        githubAccessRestoreIndexRetryCount: 0,
      });
    }
    return shouldIndex;
  }
  if (
    !(await releaseRepositoryNameForAuthoritativeIdentity(
      ctx,
      repository,
      args.githubRepo,
      args.metadataRevision,
    ))
  ) {
    return false;
  }

  const repositoryPath = args.githubRepo.split("/");
  const name = repositoryPath[repositoryPath.length - 1] ?? args.githubRepo;
  const now = Date.now();
  const shouldReactivate = repository.isActiveBeforeAccessRevocation === true;
  await ctx.db.patch(repository._id, {
    installationId: args.installationId,
    githubRepositoryId: args.githubRepositoryId,
    githubRepo: args.githubRepo,
    githubRepoKey: getCanonicalGitHubRepositoryFullNameKey(args.githubRepo),
    name,
    githubUrl: `https://github.com/${args.githubRepo}`,
    isActive: shouldReactivate,
    githubAccessRevokedAt: undefined,
    isActiveBeforeAccessRevocation: undefined,
    githubInstallationReconnectRequired: undefined,
    githubAccessRestoreIndexPending: shouldReactivate || undefined,
    githubAccessRestoreIndexNextAttemptAt: shouldReactivate ? now : undefined,
    githubAccessRestoreIndexRetryCount: shouldReactivate ? 0 : undefined,
    licenseOsiApproved: false,
    licenseOsiCheckedAt: undefined,
    ragEmbeddingBillingTier: undefined,
    repositoryMetadataCheckedAt: nextMetadataRevision(repository),
    ...(args.metadataRevision === undefined
      ? {}
      : { githubMetadataRevision: args.metadataRevision }),
    indexIdentityVerifiedVersion: undefined,
    indexIdentityVerifiedInstallationId: undefined,
    indexIdentityVerifiedGithubRepositoryId: undefined,
    indexIdentityVerifiedGithubRepo: undefined,
    updatedAt: now,
  });
  return shouldReactivate;
}

/** Persist exponential retry state while a restored repository still needs indexing. */
export const deferAccessRestoreIndexRetry = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const repository = await ctx.db.get(args.repositoryId);
    if (!repository || repository.githubAccessRestoreIndexPending !== true) {
      return false;
    }

    const retryCount = Math.min(
      (repository.githubAccessRestoreIndexRetryCount ?? 0) + 1,
      12,
    );
    const delayMs = Math.min(
      5 * 60 * 1_000,
      1_000 * 2 ** Math.min(retryCount - 1, 8),
    );
    const now = Date.now();
    await ctx.db.patch(args.repositoryId, {
      githubAccessRestoreIndexNextAttemptAt: now + delayMs,
      githubAccessRestoreIndexRetryCount: retryCount,
      updatedAt: now,
    });
    return true;
  },
});

/** Restore a previously connected repository after GitHub grants access again. */
export const restoreRepositoryAfterAccessAdded = internalMutation({
  args: {
    installationId: v.number(),
    githubRepositoryId: v.number(),
    githubRepo: v.string(),
  },
  returns: v.array(v.id("repositories")),
  handler: async (ctx, args) => {
    const installation = await getExactGitHubInstallation(
      ctx,
      args.installationId,
    );
    if (!isGitHubInstallationReady(installation)) {
      return [];
    }

    const identityMatches = await readRepositoriesByUserAndGitHubRepositoryId(
      ctx,
      installation.userId,
      args.githubRepositoryId,
    );
    const identityMatch =
      resolveUniquePreferredRepositoryIdentity(identityMatches).repository;
    if (!identityMatch) {
      return [];
    }

    const restored: Array<Id<"repositories">> = [];
    const metadataRevision =
      identityMatch.githubAccessRevokedAt === undefined
        ? undefined
        : await allocateRepositoryAccessReconciliationRevision(ctx);
    if (
      await restoreRepositoryFromLiveAccess(ctx, identityMatch, {
        ...args,
        metadataRevision,
      })
    ) {
      restored.push(identityMatch._id);
    }
    return restored;
  },
});

/** Apply one authoritative GitHub installation repository page atomically. */
export const applyRepositoryAccessReconciliationPage = internalMutation({
  args: {
    installationId: v.number(),
    epoch: v.number(),
    page: v.number(),
    hasMore: v.boolean(),
    repositories: v.array(
      v.object({
        githubRepositoryId: v.number(),
        githubRepo: v.string(),
        githubVisibility: v.union(
          v.literal("public"),
          v.literal("private"),
          v.literal("internal"),
          v.null(),
        ),
        licenseKey: v.union(v.string(), v.null()),
        licenseSpdxId: v.union(v.string(), v.null()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    if (
      !Number.isSafeInteger(args.installationId) ||
      args.installationId <= 0 ||
      !Number.isSafeInteger(args.epoch) ||
      args.epoch <= 0 ||
      !Number.isSafeInteger(args.page) ||
      args.page <= 0 ||
      args.repositories.length > 50
    ) {
      throw new Error("invalid repository reconciliation page");
    }
    const repositoryIds = new Set<number>();
    const repositoryFullNames = new Set<string>();
    for (const repository of args.repositories) {
      if (
        !Number.isSafeInteger(repository.githubRepositoryId) ||
        repository.githubRepositoryId <= 0 ||
        repositoryIds.has(repository.githubRepositoryId)
      ) {
        throw new Error("invalid repository reconciliation identity");
      }
      let githubRepoKey: string;
      try {
        githubRepoKey = getCanonicalGitHubRepositoryFullNameKey(
          repository.githubRepo,
        );
      } catch {
        throw new Error("invalid repository reconciliation identity");
      }
      if (repositoryFullNames.has(githubRepoKey)) {
        throw new Error("invalid repository reconciliation identity");
      }
      repositoryIds.add(repository.githubRepositoryId);
      repositoryFullNames.add(githubRepoKey);
    }
    const installation = await getExactGitHubInstallation(
      ctx,
      args.installationId,
    );
    if (
      !installation ||
      installation.repositoryAccessReconciliationEpoch !== args.epoch ||
      installation.repositoryAccessReconciliationPhase !== "fetching" ||
      installation.repositoryAccessReconciliationNextPage !== args.page ||
      installation.repositoryAccessReconciliationRevision === undefined ||
      (installation.accessSuspendedAt ?? null) !==
        installation.repositoryAccessReconciliationExpectedSuspendedAt
    ) {
      return { applied: 0, stale: true };
    }

    let applied = 0;
    for (const liveRepository of args.repositories) {
      const installationIdentityMatches = (
        await readRepositoriesByInstallationAndGitHubRepositoryId(
          ctx,
          args.installationId,
          liveRepository.githubRepositoryId,
        )
      ).filter((candidate) => candidate.userId === installation.userId);
      const installationResolution = resolveUniquePreferredRepositoryIdentity(
        installationIdentityMatches,
      );
      if (installationResolution.ambiguous) {
        continue;
      }

      let repository = installationResolution.repository;
      if (!repository && installationIdentityMatches.length === 0) {
        const userIdentityMatches =
          await readRepositoriesByUserAndGitHubRepositoryId(
            ctx,
            installation.userId,
            liveRepository.githubRepositoryId,
          );
        const userResolution =
          resolveUniquePreferredRepositoryIdentity(userIdentityMatches);
        if (userResolution.ambiguous) {
          continue;
        }
        repository = userResolution.repository;
      }
      if (!repository) {
        continue;
      }
      const incomingRevision =
        installation.repositoryAccessReconciliationRevision;
      const existingRevision = repository.githubAccessReconciliationRevision;
      const staleRevision =
        existingRevision !== undefined &&
        (existingRevision > incomingRevision ||
          (repository.installationId !== args.installationId &&
            existingRevision === incomingRevision));
      if (staleRevision) {
        continue;
      }

      const hasNewerWebhookMetadata =
        repository.githubMetadataRevision !== undefined &&
        (incomingRevision === undefined ||
          repository.githubMetadataRevision > incomingRevision);
      const canApplyLiveMetadata =
        !hasNewerWebhookMetadata &&
        (await releaseRepositoryNameForAuthoritativeIdentity(
          ctx,
          repository,
          liveRepository.githubRepo,
          incomingRevision,
        ));

      const name =
        liveRepository.githubRepo.split("/").pop() ?? liveRepository.githubRepo;
      const identityChanged =
        repository.installationId !== args.installationId ||
        (canApplyLiveMetadata &&
          repository.githubRepo !== liveRepository.githubRepo);
      const embeddingPolicyChanged =
        canApplyLiveMetadata &&
        (repository.githubVisibility !==
          (liveRepository.githubVisibility ?? undefined) ||
          repository.licenseKey !== (liveRepository.licenseKey ?? undefined) ||
          repository.licenseSpdxId !==
            (liveRepository.licenseSpdxId ?? undefined) ||
          repository.licenseOsiApproved === true ||
          repository.ragEmbeddingBillingTier !== undefined);
      if (identityChanged || embeddingPolicyChanged) {
        await invalidateRepositoryIndexIdentity(
          ctx,
          repository,
          identityChanged,
          embeddingPolicyChanged,
        );
      }
      await ctx.db.patch(repository._id, {
        installationId: args.installationId,
        githubRepositoryId: liveRepository.githubRepositoryId,
        ...(canApplyLiveMetadata
          ? {
              githubRepo: liveRepository.githubRepo,
              githubRepoKey: getCanonicalGitHubRepositoryFullNameKey(
                liveRepository.githubRepo,
              ),
              name,
              githubUrl: `https://github.com/${liveRepository.githubRepo}`,
              githubVisibility: liveRepository.githubVisibility ?? undefined,
              licenseKey: liveRepository.licenseKey ?? undefined,
              licenseSpdxId: liveRepository.licenseSpdxId ?? undefined,
              licenseOsiApproved: false,
              licenseOsiCheckedAt: undefined,
              ragEmbeddingBillingTier: undefined,
              repositoryMetadataCheckedAt: nextMetadataRevision(repository),
              githubMetadataRevision: incomingRevision,
            }
          : {
              githubRepoKey: getCanonicalGitHubRepositoryFullNameKey(
                repository.githubRepo,
              ),
            }),
        githubAccessReconciliationEpoch: args.epoch,
        githubAccessReconciliationRevision: incomingRevision,
        updatedAt: Date.now(),
      });
      applied += 1;
    }

    if (args.hasMore) {
      const now = Date.now();
      await ctx.db.patch(installation._id, {
        repositoryAccessReconciliationNextPage: args.page + 1,
        repositoryAccessReconciliationRetryCount: 0,
        repositoryAccessReconciliationNextAttemptAt:
          now + REPOSITORY_ACCESS_RECONCILIATION_ATTEMPT_LEASE_MS,
        updatedAt: Math.max(now, installation.updatedAt + 1),
      });
      await ctx.scheduler.runAfter(
        0,
        internal.github.action.continueRepositoryAccessReconciliation,
        {
          installationId: args.installationId,
          epoch: args.epoch,
          retryCount: 0,
        },
      );
    } else {
      await ctx.db.patch(installation._id, {
        accessSuspendedAt: undefined,
        repositoryAccessReconciliationNextPage: undefined,
        repositoryAccessReconciliationRetryCount: undefined,
        repositoryAccessReconciliationNextAttemptAt: undefined,
        repositoryAccessReconciliationExpectedSuspendedAt: null,
        repositoryAccessReconciliationPhase: "finalizing",
        updatedAt: Math.max(Date.now(), installation.updatedAt + 1),
      });
      await ctx.scheduler.runAfter(
        0,
        internal.repositories.internalMutation
          .finalizeRepositoryAccessReconciliation,
        {
          installationId: args.installationId,
          epoch: args.epoch,
          paginationOpts: {
            numItems: ACCESS_REMOVAL_PAGE_SIZE,
            cursor: null,
          },
        },
      );
    }
    return { applied, stale: false };
  },
});

/** Pause unseen rows and restore seen rows in bounded durable pages. */
export const finalizeRepositoryAccessReconciliation = internalMutation({
  args: {
    installationId: v.number(),
    epoch: v.number(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const installation = await getExactGitHubInstallation(
      ctx,
      args.installationId,
    );
    if (
      !installation ||
      installation.accessSuspendedAt !== undefined ||
      installation.repositoryAccessReconciliationEpoch !== args.epoch ||
      installation.repositoryAccessReconciliationPhase !== "finalizing"
    ) {
      return { processed: 0, complete: true, stale: true };
    }

    const page = await ctx.db
      .query("repositories")
      .withIndex("by_installation", (q) =>
        q.eq("installationId", args.installationId),
      )
      .paginate(args.paginationOpts);
    for (const repository of page.page) {
      if (
        repository.userId !== installation.userId ||
        repository.githubAccessReconciliationEpoch !== args.epoch ||
        (installation.repositoryAccessReconciliationRevision !== undefined
          ? repository.githubAccessReconciliationRevision !==
            installation.repositoryAccessReconciliationRevision
          : repository.githubAccessReconciliationRevision !== undefined)
      ) {
        await pauseRepositoryForAccessRemoval(ctx, repository);
        continue;
      }
      const shouldIndex = await restoreRepositoryFromLiveAccess(
        ctx,
        repository,
        {
          installationId: args.installationId,
          githubRepositoryId: repository.githubRepositoryId,
          githubRepo: repository.githubRepo,
          metadataRevision: installation.repositoryAccessReconciliationRevision,
        },
      );
      if (shouldIndex) {
        await ctx.scheduler.runAfter(
          0,
          internal.github.action.prepareRestoredRepositoryIndex,
          { repositoryId: repository._id },
        );
      }
    }

    if (!page.isDone) {
      await ctx.db.patch(installation._id, {
        updatedAt: Math.max(Date.now(), installation.updatedAt + 1),
      });
      await ctx.scheduler.runAfter(
        0,
        internal.repositories.internalMutation
          .finalizeRepositoryAccessReconciliation,
        {
          installationId: args.installationId,
          epoch: args.epoch,
          paginationOpts: {
            numItems: ACCESS_REMOVAL_PAGE_SIZE,
            cursor: page.continueCursor,
          },
        },
      );
    } else {
      const pendingRemovalJob = await ctx.db
        .query("githubRepositoryRemovalJobs")
        .withIndex("by_installation_and_status", (q) =>
          q.eq("installationId", args.installationId).eq("status", "pending"),
        )
        .first();
      await ctx.db.patch(installation._id, {
        repositoryAccessReconciliationNextPage: undefined,
        repositoryAccessReconciliationRetryCount: undefined,
        repositoryAccessReconciliationNextAttemptAt: undefined,
        repositoryAccessReconciliationExpectedSuspendedAt: undefined,
        repositoryAccessReconciliationPhase: undefined,
        repositoryAccessReconciliationFailure: undefined,
        repositoryAccessReconciliationFailedAt: undefined,
        repositoryRemovalPendingAt: pendingRemovalJob
          ? installation.repositoryRemovalPendingAt
          : undefined,
        updatedAt: Math.max(Date.now(), installation.updatedAt + 1),
      });
    }
    return { processed: page.page.length, complete: page.isDone, stale: false };
  },
});

/** Continue one exact durable page of installation-wide access removal. */
export const continueInstallationAccessRemoval = internalMutation({
  args: {
    installationId: v.number(),
    generation: v.number(),
    cursor: v.union(v.string(), v.null()),
    deleteInstallationAfterPause: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    if (
      !Number.isSafeInteger(args.installationId) ||
      args.installationId <= 0 ||
      !Number.isSafeInteger(args.generation) ||
      args.generation <= 0
    ) {
      throw new Error("invalid installation access removal continuation");
    }
    const installations = await ctx.db
      .query("githubInstallations")
      .withIndex("by_installation_id", (q) =>
        q.eq("installationId", args.installationId),
      )
      .take(2);
    if (installations.length === 0) {
      return { paused: 0, complete: true, stale: true };
    }
    const hasDuplicateInstallation = installations.length > 1;
    const installation = installations[0];
    const matchingInstallations = installations.filter(
      (candidate) =>
        candidate.accessSuspendedAt === args.generation &&
        candidate.repositoryAccessRemovalGeneration === args.generation &&
        candidate.repositoryAccessRemovalPhase === "pausing" &&
        candidate.repositoryAccessRemovalCursor === args.cursor &&
        candidate.repositoryAccessRemovalDeleteInstallation !== undefined,
    );
    if (matchingInstallations.length === 0) {
      return { paused: 0, complete: true, stale: true };
    }
    const deleteInstallationAfterPause =
      args.deleteInstallationAfterPause ??
      matchingInstallations.some(
        (candidate) =>
          candidate.repositoryAccessRemovalDeleteInstallation === true,
      );

    const page = await ctx.db
      .query("repositories")
      .withIndex("by_installation", (q) =>
        q.eq("installationId", args.installationId),
      )
      .paginate({ numItems: ACCESS_REMOVAL_PAGE_SIZE, cursor: args.cursor });
    for (const repository of page.page) {
      await pauseRepositoryForAccessRemoval(ctx, repository, {
        installationReconnectRequired: deleteInstallationAfterPause,
      });
    }

    if (!page.isDone) {
      for (const candidate of matchingInstallations) {
        await ctx.db.patch(candidate._id, {
          repositoryAccessRemovalCursor: page.continueCursor,
          updatedAt: Math.max(Date.now(), candidate.updatedAt + 1),
        });
      }
      await ctx.scheduler.runAfter(
        0,
        internal.repositories.internalMutation
          .continueInstallationAccessRemoval,
        {
          installationId: args.installationId,
          generation: args.generation,
          cursor: page.continueCursor,
          deleteInstallationAfterPause,
        },
      );
    } else if (deleteInstallationAfterPause && !hasDuplicateInstallation) {
      await ctx.db.delete(installation._id);
    } else {
      for (const candidate of matchingInstallations) {
        await ctx.db.patch(candidate._id, {
          repositoryAccessRemovalGeneration: undefined,
          repositoryAccessRemovalCursor: undefined,
          repositoryAccessRemovalDeleteInstallation: hasDuplicateInstallation
            ? deleteInstallationAfterPause
            : undefined,
          repositoryAccessRemovalPhase: undefined,
          updatedAt: Math.max(Date.now(), candidate.updatedAt + 1),
        });
      }
    }

    return {
      paused: page.page.length,
      complete: page.isDone,
      stale: false,
    };
  },
});

/** Apply a safe rename and revoke cached free policy for a pinned repository. */
export const applyRepositoryWebhookUpdate = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    expectedGithubRepo: v.string(),
    githubRepositoryId: v.number(),
    installationId: v.number(),
    githubRepo: v.string(),
    previousGithubRepo: v.optional(v.string()),
    liveIdentityVerified: v.optional(v.boolean()),
    githubVisibility: v.union(
      v.literal("public"),
      v.literal("private"),
      v.literal("internal"),
      v.null(),
    ),
    licenseKey: v.union(v.string(), v.null()),
    licenseSpdxId: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const [repository, installation] = await Promise.all([
      ctx.db.get(args.repositoryId),
      getExactGitHubInstallation(ctx, args.installationId),
    ]);
    if (
      !repository ||
      !canApplyGitHubRepositoryMetadataWebhook(installation) ||
      installation.userId !== repository.userId ||
      repository.isActive !== true ||
      repository.githubAccessRevokedAt !== undefined ||
      repository.disconnectCleanupPending === true ||
      repository.githubRepo !== args.expectedGithubRepo ||
      repository.installationId !== args.installationId ||
      repository.githubRepositoryId !== args.githubRepositoryId
    ) {
      return { persisted: false, identityUpdated: false, paused: false };
    }

    const canApplyIdentityTransition =
      args.liveIdentityVerified === true ||
      repository.githubRepo === args.githubRepo ||
      (args.previousGithubRepo !== undefined &&
        repository.githubRepo === args.previousGithubRepo);
    const metadataRevision =
      await allocateRepositoryAccessReconciliationRevision(ctx);
    const canUpdateName =
      canApplyIdentityTransition &&
      (await releaseRepositoryNameForAuthoritativeIdentity(
        ctx,
        repository,
        args.githubRepo,
        metadataRevision,
      ));

    const now = Date.now();
    const repositoryPath = args.githubRepo.split("/");
    const name = repositoryPath[repositoryPath.length - 1] ?? args.githubRepo;
    const identityChanged =
      canUpdateName && repository.githubRepo !== args.githubRepo;
    const embeddingPolicyChanged =
      repository.githubVisibility !== (args.githubVisibility ?? undefined) ||
      repository.licenseKey !== (args.licenseKey ?? undefined) ||
      repository.licenseSpdxId !== (args.licenseSpdxId ?? undefined) ||
      repository.licenseOsiApproved === true ||
      repository.ragEmbeddingBillingTier !== undefined;
    if (identityChanged || embeddingPolicyChanged) {
      await invalidateRepositoryIndexIdentity(
        ctx,
        repository,
        identityChanged,
        embeddingPolicyChanged,
      );
    }
    await ctx.db.patch(args.repositoryId, {
      githubRepositoryId: args.githubRepositoryId,
      githubRepo: canUpdateName ? args.githubRepo : repository.githubRepo,
      githubRepoKey: getCanonicalGitHubRepositoryFullNameKey(
        canUpdateName ? args.githubRepo : repository.githubRepo,
      ),
      name: canUpdateName ? name : repository.name,
      githubUrl: canUpdateName
        ? `https://github.com/${args.githubRepo}`
        : repository.githubUrl,
      githubVisibility: args.githubVisibility ?? undefined,
      licenseKey: args.licenseKey ?? undefined,
      licenseSpdxId: args.licenseSpdxId ?? undefined,
      licenseOsiApproved: false,
      licenseOsiCheckedAt: undefined,
      ragEmbeddingBillingTier: undefined,
      repositoryMetadataCheckedAt: nextMetadataRevision(repository),
      githubMetadataRevision: metadataRevision,
      updatedAt: now,
    });

    return {
      persisted: true,
      identityUpdated: canApplyIdentityTransition && canUpdateName,
      paused: false,
    };
  },
});
