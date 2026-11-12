import { internalMutation, type MutationCtx } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { getExactGitHubInstallation } from "./installationAccess";
import {
  getInstallationWebhookStateRetryDelayMs,
  INSTALLATION_WEBHOOK_STATE_ATTEMPT_LEASE_MS,
  INSTALLATION_WEBHOOK_STATE_MAX_RETRY_COUNT,
} from "./webhookAccessStateAttestation";
import {
  getRepositoryAccessReconciliationRetryDelayMs,
  REPOSITORY_ACCESS_RECONCILIATION_ATTEMPT_LEASE_MS,
  REPOSITORY_ACCESS_RECONCILIATION_MAX_RETRY_COUNT,
} from "./repositoryAccessReconciliation";

const REPOSITORY_REMOVAL_PERMANENT_FAILURE_LIMIT = 3;

export async function allocateRepositoryAccessReconciliationRevision(
  ctx: MutationCtx,
): Promise<number> {
  const clocks = await ctx.db
    .query("githubRepositoryAccessReconciliationClock")
    .withIndex("by_key", (q) => q.eq("key", "global"))
    .take(2);
  if (clocks.length > 1) {
    throw new Error("Duplicate repository access reconciliation clock");
  }

  const clock = clocks[0];
  if (!clock) {
    const revision = 1;
    await ctx.db.insert("githubRepositoryAccessReconciliationClock", {
      key: "global",
      revision,
      updatedAt: Date.now(),
    });
    return revision;
  }
  if (
    !Number.isSafeInteger(clock.revision) ||
    clock.revision < 1 ||
    clock.revision >= Number.MAX_SAFE_INTEGER
  ) {
    throw new Error("Repository access reconciliation clock is invalid");
  }

  const revision = clock.revision + 1;
  await ctx.db.patch(clock._id, { revision, updatedAt: Date.now() });
  return revision;
}

async function beginInstallationAccessRemovalTransaction(
  ctx: MutationCtx,
  installationId: number,
  deleteInstallationAfterPause: boolean,
): Promise<number | null> {
  const installations = await ctx.db
    .query("githubInstallations")
    .withIndex("by_installation_id", (q) =>
      q.eq("installationId", installationId),
    )
    .take(2);
  if (installations.length === 0) {
    return null;
  }

  const generation = Math.max(
    Date.now(),
    ...installations.map((installation) => installation.updatedAt + 1),
    ...installations.map(
      (installation) =>
        (installation.repositoryAccessRemovalGeneration ?? 0) + 1,
    ),
  );
  const mergedDeleteInstallationAfterPause =
    deleteInstallationAfterPause ||
    installations.some(
      (installation) =>
        installation.repositoryAccessRemovalDeleteInstallation === true,
    );
  for (const installation of installations) {
    await ctx.db.patch(installation._id, {
      accessSuspendedAt: generation,
      webhookAccessStateAttestationGeneration: undefined,
      webhookAccessStateAttestationFailure: undefined,
      webhookAccessStateAttestationFailedAt: undefined,
      webhookAccessStateAttestationRetryCount: undefined,
      webhookAccessStateAttestationNextAttemptAt: undefined,
      repositoryAccessRemovalGeneration: generation,
      repositoryAccessRemovalCursor: null,
      repositoryAccessRemovalDeleteInstallation:
        mergedDeleteInstallationAfterPause,
      repositoryAccessRemovalPhase: "pausing",
      repositoryAccessReconciliationNextPage: undefined,
      repositoryAccessReconciliationRetryCount: undefined,
      repositoryAccessReconciliationNextAttemptAt: undefined,
      repositoryAccessReconciliationExpectedSuspendedAt: undefined,
      repositoryAccessReconciliationPhase: undefined,
      repositoryAccessReconciliationFailure: undefined,
      repositoryAccessReconciliationFailedAt: undefined,
      updatedAt: generation,
    });
  }
  await ctx.scheduler.runAfter(
    0,
    internal.repositories.internalMutation.continueInstallationAccessRemoval,
    {
      installationId,
      generation,
      cursor: null,
      deleteInstallationAfterPause: mergedDeleteInstallationAfterPause,
    },
  );
  return generation;
}

async function startRepositoryAccessReconciliationTransaction(
  ctx: MutationCtx,
  installationId: number,
  expectedAccessSuspendedAt: number | null,
): Promise<number | null> {
  const installation = await getExactGitHubInstallation(ctx, installationId);
  if (
    !installation ||
    installation.repositoryAccessRemovalDeleteInstallation === true ||
    (installation.accessSuspendedAt ?? null) !== expectedAccessSuspendedAt
  ) {
    return null;
  }

  const revision = await allocateRepositoryAccessReconciliationRevision(ctx);
  const epoch = Math.max(
    Date.now(),
    installation.updatedAt + 1,
    (installation.repositoryAccessReconciliationEpoch ?? 0) + 1,
  );
  await ctx.db.patch(installation._id, {
    // Gate every repository workflow until the authoritative final sweep has
    // paused rows that are no longer present. This marker is intentionally
    // shared with removal reconciliation because existing access checks
    // already fail closed while it is set.
    repositoryRemovalPendingAt:
      installation.repositoryRemovalPendingAt ?? epoch,
    webhookAccessStateAttestationGeneration: undefined,
    webhookAccessStateAttestationFailure: undefined,
    webhookAccessStateAttestationFailedAt: undefined,
    webhookAccessStateAttestationRetryCount: undefined,
    webhookAccessStateAttestationNextAttemptAt: undefined,
    repositoryAccessReconciliationEpoch: epoch,
    repositoryAccessReconciliationRevision: revision,
    repositoryAccessReconciliationNextPage: 1,
    repositoryAccessReconciliationRetryCount: 0,
    repositoryAccessReconciliationNextAttemptAt:
      Date.now() + REPOSITORY_ACCESS_RECONCILIATION_ATTEMPT_LEASE_MS,
    repositoryAccessReconciliationExpectedSuspendedAt:
      expectedAccessSuspendedAt,
    repositoryAccessReconciliationPhase: "fetching",
    repositoryAccessReconciliationFailure: undefined,
    repositoryAccessReconciliationFailedAt: undefined,
    repositoryAccessRemovalGeneration: undefined,
    repositoryAccessRemovalCursor: undefined,
    repositoryAccessRemovalDeleteInstallation: undefined,
    repositoryAccessRemovalPhase: undefined,
    updatedAt: epoch,
  });
  await ctx.scheduler.runAfter(
    0,
    internal.github.action.continueRepositoryAccessReconciliation,
    { installationId, epoch, retryCount: 0 },
  );
  return epoch;
}

export const saveInstallation = internalMutation({
  args: {
    userId: v.id("users"),
    installationId: v.number(),
    accountLogin: v.string(),
    accountType: v.string(),
    targetType: v.string(),
    permissions: v.any(),
    requireExisting: v.optional(v.boolean()),
    ownerGithubAccountId: v.optional(v.string()),
    startRepositoryAccessReconciliation: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const installations = await ctx.db
      .query("githubInstallations")
      .withIndex("by_installation_id", (q) =>
        q.eq("installationId", args.installationId),
      )
      .take(2);
    if (installations.length > 1) {
      await beginInstallationAccessRemovalTransaction(
        ctx,
        args.installationId,
        false,
      );
      return { status: "not_found" as const, installationId: null };
    }
    const existing = installations[0];

    const now = Date.now();

    const ownerGithubAccountId = args.ownerGithubAccountId;
    const hasOwnershipAttestation = ownerGithubAccountId !== undefined;

    if (existing) {
      if (
        hasOwnershipAttestation &&
        existing.ownerGithubAccountId !== ownerGithubAccountId
      ) {
        return { status: "owner_mismatch" as const, installationId: null };
      }

      if (hasOwnershipAttestation && existing.userId !== args.userId) {
        return { status: "owner_mismatch" as const, installationId: null };
      }

      if (!hasOwnershipAttestation && existing.userId !== args.userId) {
        return { status: "owner_mismatch" as const, installationId: null };
      }

      if (
        !hasOwnershipAttestation &&
        existing.accessSuspendedAt !== undefined
      ) {
        return { status: "not_found" as const, installationId: null };
      }

      await ctx.db.patch(existing._id, {
        accountLogin: args.accountLogin,
        accountType: args.accountType,
        targetType: args.targetType,
        permissions: args.permissions,
        updatedAt: now,
      });
      if (args.startRepositoryAccessReconciliation === true) {
        const epoch = await startRepositoryAccessReconciliationTransaction(
          ctx,
          args.installationId,
          existing.accessSuspendedAt ?? null,
        );
        if (epoch === null) {
          throw new Error("Installation reconciliation could not start");
        }
      }
      return {
        status: "updated" as const,
        installationId: existing._id,
        accessSuspendedAt: existing.accessSuspendedAt ?? null,
      };
    } else {
      if (args.requireExisting === true || !hasOwnershipAttestation) {
        return { status: "not_found" as const, installationId: null };
      }

      const installationId = await ctx.db.insert("githubInstallations", {
        userId: args.userId,
        installationId: args.installationId,
        ownerGithubAccountId,
        ownershipVerifiedAt: now,
        accountLogin: args.accountLogin,
        accountType: args.accountType,
        targetType: args.targetType,
        permissions: args.permissions,
        createdAt: now,
        updatedAt: now,
      });
      if (args.startRepositoryAccessReconciliation === true) {
        const epoch = await startRepositoryAccessReconciliationTransaction(
          ctx,
          args.installationId,
          null,
        );
        if (epoch === null) {
          throw new Error("Installation reconciliation could not start");
        }
      }
      return {
        status: "created" as const,
        installationId,
        accessSuspendedAt: null,
      };
    }
  },
});

export const markInstallationSuspended = internalMutation({
  args: {
    installationId: v.number(),
  },
  returns: v.union(v.number(), v.null()),
  handler: async (ctx, args): Promise<number | null> =>
    await beginInstallationAccessRemovalTransaction(
      ctx,
      args.installationId,
      false,
    ),
});

/** Gate repository work before checking a signed suspend/deleted webhook live. */
export const beginInstallationWebhookAccessStateAttestation = internalMutation({
  args: {
    installationId: v.number(),
  },
  returns: v.union(v.number(), v.null()),
  handler: async (ctx, args): Promise<number | null> => {
    const generation = await beginInstallationAccessRemovalTransaction(
      ctx,
      args.installationId,
      false,
    );
    if (generation === null) {
      return null;
    }

    const installations = await ctx.db
      .query("githubInstallations")
      .withIndex("by_installation_id", (q) =>
        q.eq("installationId", args.installationId),
      )
      .take(2);
    for (const installation of installations) {
      if (installation.accessSuspendedAt !== generation) {
        continue;
      }
      await ctx.db.patch(installation._id, {
        webhookAccessStateAttestationGeneration: generation,
        webhookAccessStateAttestationFailure: undefined,
        webhookAccessStateAttestationFailedAt: undefined,
        webhookAccessStateAttestationRetryCount: 0,
        webhookAccessStateAttestationNextAttemptAt:
          Date.now() + INSTALLATION_WEBHOOK_STATE_ATTEMPT_LEASE_MS,
      });
    }
    await ctx.scheduler.runAfter(
      0,
      internal.github.action.reconcileInstallationWebhookAccessState,
      {
        installationId: args.installationId,
        expectedGeneration: generation,
        retryCount: 0,
      },
    );
    return generation;
  },
});

/** Claim one exact scheduled attempt and extend its crash-recovery lease. */
export const claimInstallationWebhookAccessStateAttestationAttempt =
  internalMutation({
    args: {
      installationId: v.number(),
      expectedGeneration: v.number(),
      retryCount: v.number(),
    },
    returns: v.boolean(),
    handler: async (ctx, args): Promise<boolean> => {
      const installation = await getExactGitHubInstallation(
        ctx,
        args.installationId,
      );
      if (
        !installation ||
        installation.accessSuspendedAt !== args.expectedGeneration ||
        installation.webhookAccessStateAttestationGeneration !==
          args.expectedGeneration ||
        installation.webhookAccessStateAttestationFailure !== undefined ||
        installation.webhookAccessStateAttestationRetryCount !== args.retryCount
      ) {
        return false;
      }

      const now = Date.now();
      await ctx.db.patch(installation._id, {
        webhookAccessStateAttestationNextAttemptAt:
          now + INSTALLATION_WEBHOOK_STATE_ATTEMPT_LEASE_MS,
        updatedAt: Math.max(now, installation.updatedAt + 1),
      });
      return true;
    },
  });

/** Persist and schedule an unknown-state retry in one transaction. */
export const scheduleInstallationWebhookAccessStateAttestationRetry =
  internalMutation({
    args: {
      installationId: v.number(),
      expectedGeneration: v.number(),
      expectedRetryCount: v.number(),
    },
    returns: v.boolean(),
    handler: async (ctx, args): Promise<boolean> => {
      const installation = await getExactGitHubInstallation(
        ctx,
        args.installationId,
      );
      if (
        !installation ||
        installation.accessSuspendedAt !== args.expectedGeneration ||
        installation.webhookAccessStateAttestationGeneration !==
          args.expectedGeneration ||
        installation.webhookAccessStateAttestationFailure !== undefined ||
        installation.webhookAccessStateAttestationRetryCount !==
          args.expectedRetryCount ||
        args.expectedRetryCount >= INSTALLATION_WEBHOOK_STATE_MAX_RETRY_COUNT
      ) {
        return false;
      }

      const retryCount = args.expectedRetryCount + 1;
      const delayMs = getInstallationWebhookStateRetryDelayMs(
        args.expectedRetryCount,
      );
      const now = Date.now();
      await ctx.scheduler.runAfter(
        delayMs,
        internal.github.action.reconcileInstallationWebhookAccessState,
        {
          installationId: args.installationId,
          expectedGeneration: args.expectedGeneration,
          retryCount,
        },
      );
      await ctx.db.patch(installation._id, {
        webhookAccessStateAttestationRetryCount: retryCount,
        webhookAccessStateAttestationNextAttemptAt:
          now + delayMs + INSTALLATION_WEBHOOK_STATE_ATTEMPT_LEASE_MS,
        updatedAt: Math.max(now, installation.updatedAt + 1),
      });
      return true;
    },
  });

/** Apply a live access-state read only to the exact gated webhook generation. */
export const applyInstallationWebhookAccessStateAttestation = internalMutation({
  args: {
    installationId: v.number(),
    expectedGeneration: v.number(),
    expectedRetryCount: v.number(),
    accessState: v.union(
      v.literal("active"),
      v.literal("suspended"),
      v.literal("deleted"),
    ),
  },
  returns: v.union(
    v.literal("stale"),
    v.literal("reconciling"),
    v.literal("removing"),
  ),
  handler: async (ctx, args) => {
    const installation = await getExactGitHubInstallation(
      ctx,
      args.installationId,
    );
    if (
      !installation ||
      installation.accessSuspendedAt !== args.expectedGeneration ||
      installation.webhookAccessStateAttestationGeneration !==
        args.expectedGeneration ||
      installation.webhookAccessStateAttestationFailure !== undefined ||
      installation.webhookAccessStateAttestationRetryCount !==
        args.expectedRetryCount
    ) {
      return "stale" as const;
    }

    if (args.accessState === "active") {
      const epoch = await startRepositoryAccessReconciliationTransaction(
        ctx,
        args.installationId,
        args.expectedGeneration,
      );
      return epoch === null ? ("stale" as const) : ("reconciling" as const);
    }

    const generation = await beginInstallationAccessRemovalTransaction(
      ctx,
      args.installationId,
      args.accessState === "deleted",
    );
    return generation === null ? ("stale" as const) : ("removing" as const);
  },
});

/** Persist a bounded attestation failure while keeping installation access gated. */
export const failInstallationWebhookAccessStateAttestation = internalMutation({
  args: {
    installationId: v.number(),
    expectedGeneration: v.number(),
    expectedRetryCount: v.number(),
    failure: v.union(v.literal("configuration"), v.literal("github_request")),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const installation = await getExactGitHubInstallation(
      ctx,
      args.installationId,
    );
    if (
      !installation ||
      installation.accessSuspendedAt !== args.expectedGeneration ||
      installation.webhookAccessStateAttestationGeneration !==
        args.expectedGeneration ||
      installation.webhookAccessStateAttestationFailure !== undefined ||
      installation.webhookAccessStateAttestationRetryCount !==
        args.expectedRetryCount
    ) {
      return false;
    }

    const now = Math.max(Date.now(), installation.updatedAt + 1);
    await ctx.db.patch(installation._id, {
      webhookAccessStateAttestationFailure: args.failure,
      webhookAccessStateAttestationFailedAt: now,
      webhookAccessStateAttestationNextAttemptAt:
        now + INSTALLATION_WEBHOOK_STATE_ATTEMPT_LEASE_MS,
      updatedAt: now,
    });
    return true;
  },
});

/** Atomically recover one stale in-flight or terminal attestation. */
export const recoverStaleInstallationWebhookAccessStateAttestation =
  internalMutation({
    args: {
      installationId: v.number(),
      generation: v.number(),
      expectedRetryCount: v.number(),
      expectedFailure: v.union(
        v.literal("configuration"),
        v.literal("github_request"),
        v.null(),
      ),
      now: v.number(),
    },
    returns: v.boolean(),
    handler: async (ctx, args): Promise<boolean> => {
      const installation = await getExactGitHubInstallation(
        ctx,
        args.installationId,
      );
      if (
        !installation ||
        installation.accessSuspendedAt !== args.generation ||
        installation.webhookAccessStateAttestationGeneration !==
          args.generation ||
        installation.webhookAccessStateAttestationRetryCount !==
          args.expectedRetryCount ||
        (installation.webhookAccessStateAttestationFailure ?? null) !==
          args.expectedFailure ||
        installation.webhookAccessStateAttestationNextAttemptAt === undefined ||
        installation.webhookAccessStateAttestationNextAttemptAt > args.now
      ) {
        return false;
      }

      const retryCount =
        args.expectedFailure === null ? args.expectedRetryCount : 0;
      await ctx.scheduler.runAfter(
        0,
        internal.github.action.reconcileInstallationWebhookAccessState,
        {
          installationId: args.installationId,
          expectedGeneration: args.generation,
          retryCount,
        },
      );
      await ctx.db.patch(installation._id, {
        webhookAccessStateAttestationFailure: undefined,
        webhookAccessStateAttestationFailedAt: undefined,
        webhookAccessStateAttestationRetryCount: retryCount,
        webhookAccessStateAttestationNextAttemptAt:
          args.now + INSTALLATION_WEBHOOK_STATE_ATTEMPT_LEASE_MS,
        updatedAt: Math.max(args.now, installation.updatedAt + 1),
      });
      return true;
    },
  });

export const beginInstallationAccessRemoval = internalMutation({
  args: {
    installationId: v.number(),
    deleteInstallationAfterPause: v.boolean(),
  },
  returns: v.union(v.number(), v.null()),
  handler: async (ctx, args): Promise<number | null> =>
    await beginInstallationAccessRemovalTransaction(
      ctx,
      args.installationId,
      args.deleteInstallationAfterPause,
    ),
});

/** Start one durable, authoritative repository-access reconciliation epoch. */
export const startRepositoryAccessReconciliation = internalMutation({
  args: {
    installationId: v.number(),
    expectedAccessSuspendedAt: v.union(v.number(), v.null()),
  },
  returns: v.union(v.number(), v.null()),
  handler: async (ctx, args): Promise<number | null> =>
    await startRepositoryAccessReconciliationTransaction(
      ctx,
      args.installationId,
      args.expectedAccessSuspendedAt,
    ),
});

/** Claim one exact reconciliation retry generation and extend its lease. */
export const claimRepositoryAccessReconciliationAttempt = internalMutation({
  args: {
    installationId: v.number(),
    epoch: v.number(),
    retryCount: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const installation = await getExactGitHubInstallation(
      ctx,
      args.installationId,
    );
    if (
      !installation ||
      installation.repositoryAccessReconciliationEpoch !== args.epoch ||
      installation.repositoryAccessReconciliationPhase !== "fetching" ||
      installation.repositoryAccessReconciliationNextPage === undefined ||
      installation.repositoryAccessReconciliationRetryCount !==
        args.retryCount ||
      installation.repositoryAccessReconciliationNextAttemptAt === undefined ||
      (installation.accessSuspendedAt ?? null) !==
        installation.repositoryAccessReconciliationExpectedSuspendedAt
    ) {
      return false;
    }

    const now = Date.now();
    await ctx.db.patch(installation._id, {
      repositoryAccessReconciliationNextAttemptAt:
        now + REPOSITORY_ACCESS_RECONCILIATION_ATTEMPT_LEASE_MS,
      updatedAt: Math.max(now, installation.updatedAt + 1),
    });
    return true;
  },
});

/** Persist and schedule the next exact reconciliation retry atomically. */
export const scheduleRepositoryAccessReconciliationRetry = internalMutation({
  args: {
    installationId: v.number(),
    epoch: v.number(),
    expectedRetryCount: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const installation = await getExactGitHubInstallation(
      ctx,
      args.installationId,
    );
    if (
      !installation ||
      installation.repositoryAccessReconciliationEpoch !== args.epoch ||
      installation.repositoryAccessReconciliationPhase !== "fetching" ||
      installation.repositoryAccessReconciliationNextPage === undefined ||
      installation.repositoryAccessReconciliationRetryCount !==
        args.expectedRetryCount ||
      installation.repositoryAccessReconciliationNextAttemptAt === undefined ||
      (installation.accessSuspendedAt ?? null) !==
        installation.repositoryAccessReconciliationExpectedSuspendedAt ||
      !Number.isSafeInteger(args.expectedRetryCount) ||
      args.expectedRetryCount < 0 ||
      args.expectedRetryCount >=
        REPOSITORY_ACCESS_RECONCILIATION_MAX_RETRY_COUNT
    ) {
      return false;
    }

    const retryCount = args.expectedRetryCount + 1;
    const delayMs = getRepositoryAccessReconciliationRetryDelayMs(
      args.expectedRetryCount,
    );
    const now = Date.now();
    await ctx.scheduler.runAfter(
      delayMs,
      internal.github.action.continueRepositoryAccessReconciliation,
      {
        installationId: args.installationId,
        epoch: args.epoch,
        retryCount,
      },
    );
    await ctx.db.patch(installation._id, {
      repositoryAccessReconciliationRetryCount: retryCount,
      repositoryAccessReconciliationNextAttemptAt:
        now + delayMs + REPOSITORY_ACCESS_RECONCILIATION_ATTEMPT_LEASE_MS,
      updatedAt: Math.max(now, installation.updatedAt + 1),
    });
    return true;
  },
});

export const failRepositoryAccessReconciliation = internalMutation({
  args: {
    installationId: v.number(),
    epoch: v.number(),
    expectedRetryCount: v.number(),
    failure: v.union(
      v.literal("configuration"),
      v.literal("authorization"),
      v.literal("network"),
      v.literal("github_request"),
      v.literal("invalid_response"),
      v.literal("internal"),
    ),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const installation = await getExactGitHubInstallation(
      ctx,
      args.installationId,
    );
    if (
      !installation ||
      installation.repositoryAccessReconciliationEpoch !== args.epoch ||
      installation.repositoryAccessReconciliationPhase !== "fetching" ||
      installation.repositoryAccessReconciliationRetryCount !==
        args.expectedRetryCount ||
      !Number.isSafeInteger(args.expectedRetryCount) ||
      args.expectedRetryCount < REPOSITORY_ACCESS_RECONCILIATION_MAX_RETRY_COUNT
    ) {
      return false;
    }

    const now = Math.max(Date.now(), installation.updatedAt + 1);
    await ctx.db.patch(installation._id, {
      repositoryAccessReconciliationNextPage: undefined,
      repositoryAccessReconciliationRetryCount: undefined,
      repositoryAccessReconciliationNextAttemptAt: undefined,
      repositoryAccessReconciliationExpectedSuspendedAt: undefined,
      repositoryAccessReconciliationPhase: undefined,
      repositoryAccessReconciliationFailure: args.failure,
      repositoryAccessReconciliationFailedAt: now,
      updatedAt: now,
    });
    return true;
  },
});

export const retryFailedRepositoryAccessReconciliation = internalMutation({
  args: {
    userId: v.id("users"),
    installationId: v.number(),
  },
  returns: v.union(
    v.object({ status: v.literal("started"), epoch: v.number() }),
    v.object({ status: v.literal("not_found") }),
    v.object({ status: v.literal("not_failed") }),
  ),
  handler: async (ctx, args) => {
    const installation = await getExactGitHubInstallation(
      ctx,
      args.installationId,
    );
    if (!installation || installation.userId !== args.userId) {
      return { status: "not_found" as const };
    }
    if (
      installation.repositoryAccessReconciliationFailure === undefined ||
      installation.repositoryAccessReconciliationPhase !== undefined
    ) {
      return { status: "not_failed" as const };
    }

    const epoch = await startRepositoryAccessReconciliationTransaction(
      ctx,
      args.installationId,
      installation.accessSuspendedAt ?? null,
    );
    return epoch === null
      ? { status: "not_found" as const }
      : { status: "started" as const, epoch };
  },
});

export const startRepositoryRemovalReconciliation = internalMutation({
  args: { installationId: v.number() },
  returns: v.union(v.number(), v.null()),
  handler: async (ctx, args): Promise<number | null> => {
    const installations = await ctx.db
      .query("githubInstallations")
      .withIndex("by_installation_id", (q) =>
        q.eq("installationId", args.installationId),
      )
      .take(2);
    if (installations.length > 1) {
      await beginInstallationAccessRemovalTransaction(
        ctx,
        args.installationId,
        false,
      );
      return null;
    }
    const installation = installations[0];
    if (!installation || installation.accessSuspendedAt !== undefined) {
      return null;
    }
    const now = Date.now();
    await ctx.db.patch(installation._id, {
      repositoryRemovalPendingAt:
        installation.repositoryRemovalPendingAt ??
        Math.max(now, installation.updatedAt + 1),
      updatedAt: Math.max(now, installation.updatedAt + 1),
    });
    return await startRepositoryAccessReconciliationTransaction(
      ctx,
      args.installationId,
      null,
    );
  },
});

export const createRepositoryRemovalJob = internalMutation({
  args: {
    deliveryId: v.string(),
    installationId: v.number(),
    payloadStorageId: v.id("_storage"),
    totalRepositories: v.number(),
  },
  handler: async (ctx, args) => {
    if (
      args.deliveryId.length === 0 ||
      args.deliveryId.length > 200 ||
      !Number.isSafeInteger(args.installationId) ||
      args.installationId <= 0 ||
      !Number.isSafeInteger(args.totalRepositories) ||
      args.totalRepositories <= 0 ||
      args.totalRepositories > 5_000
    ) {
      await ctx.storage.delete(args.payloadStorageId);
      throw new Error("Invalid repository removal job");
    }

    const existing = await ctx.db
      .query("githubRepositoryRemovalJobs")
      .withIndex("by_delivery_id", (q) => q.eq("deliveryId", args.deliveryId))
      .first();
    if (existing) {
      await ctx.storage.delete(args.payloadStorageId);
      return { jobId: existing._id, created: false as const };
    }

    const installations = await ctx.db
      .query("githubInstallations")
      .withIndex("by_installation_id", (q) =>
        q.eq("installationId", args.installationId),
      )
      .take(2);
    if (installations.length > 1) {
      await ctx.storage.delete(args.payloadStorageId);
      await beginInstallationAccessRemovalTransaction(
        ctx,
        args.installationId,
        false,
      );
      return { jobId: null, created: false as const };
    }
    const installation = installations[0];
    if (!installation || installation.accessSuspendedAt !== undefined) {
      await ctx.storage.delete(args.payloadStorageId);
      throw new Error("Installation is not active");
    }

    const now = Date.now();
    const pendingAt =
      installation.repositoryRemovalPendingAt ??
      Math.max(now, installation.updatedAt + 1);
    await ctx.db.patch(installation._id, {
      repositoryRemovalPendingAt: pendingAt,
      updatedAt: Math.max(now, installation.updatedAt + 1),
    });
    const jobId = await ctx.db.insert("githubRepositoryRemovalJobs", {
      deliveryId: args.deliveryId,
      installationId: args.installationId,
      payloadStorageId: args.payloadStorageId,
      totalRepositories: args.totalRepositories,
      nextOffset: 0,
      status: "pending",
      retryCount: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.github.action.continueRepositoryRemovalJob,
      { jobId },
    );
    return { jobId, created: true as const };
  },
});

export const advanceRepositoryRemovalJob = internalMutation({
  args: {
    jobId: v.id("githubRepositoryRemovalJobs"),
    expectedOffset: v.number(),
    processedCount: v.number(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (
      !job ||
      job.status !== "pending" ||
      job.nextOffset !== args.expectedOffset ||
      !Number.isSafeInteger(args.processedCount) ||
      args.processedCount <= 0 ||
      args.processedCount > 50
    ) {
      return false;
    }

    const nextOffset = Math.min(
      job.totalRepositories,
      job.nextOffset + args.processedCount,
    );
    const now = Date.now();
    if (nextOffset < job.totalRepositories) {
      await ctx.db.patch(job._id, {
        nextOffset,
        retryCount: 0,
        lastError: undefined,
        nextAttemptAt: now + 5 * 60 * 1_000,
        updatedAt: now,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.github.action.continueRepositoryRemovalJob,
        { jobId: job._id },
      );
      return true;
    }

    await startRepositoryAccessReconciliationTransaction(
      ctx,
      job.installationId,
      null,
    );
    if (job.payloadStorageId !== undefined) {
      await ctx.storage.delete(job.payloadStorageId);
    }
    await ctx.db.patch(job._id, {
      payloadStorageId: undefined,
      nextOffset,
      status: "completed",
      retryCount: 0,
      lastError: undefined,
      nextAttemptAt: now,
      updatedAt: now,
      completedAt: now,
    });
    return true;
  },
});

export const deferRepositoryRemovalJob = internalMutation({
  args: {
    jobId: v.id("githubRepositoryRemovalJobs"),
    expectedOffset: v.number(),
    expectedRetryCount: v.number(),
    failureKind: v.union(v.literal("permanent"), v.literal("transient")),
    deletePayload: v.boolean(),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (
      !job ||
      job.status !== "pending" ||
      job.nextOffset !== args.expectedOffset ||
      job.retryCount !== args.expectedRetryCount
    ) {
      return false;
    }
    const retryCount = Math.min(job.retryCount + 1, 12);
    const now = Date.now();
    if (
      args.failureKind === "permanent" &&
      retryCount >= REPOSITORY_REMOVAL_PERMANENT_FAILURE_LIMIT
    ) {
      const reconciliationEpoch =
        await startRepositoryAccessReconciliationTransaction(
          ctx,
          job.installationId,
          null,
        );
      const installation = await getExactGitHubInstallation(
        ctx,
        job.installationId,
      );
      const pendingJobs = await ctx.db
        .query("githubRepositoryRemovalJobs")
        .withIndex("by_installation_and_status", (q) =>
          q.eq("installationId", job.installationId).eq("status", "pending"),
        )
        .take(2);
      const hasOtherPendingJob = pendingJobs.some(
        (pendingJob) => pendingJob._id !== job._id,
      );

      if (
        args.deletePayload &&
        job.payloadStorageId !== undefined &&
        (await ctx.storage.getUrl(job.payloadStorageId)) !== null
      ) {
        await ctx.storage.delete(job.payloadStorageId);
      }
      await ctx.db.patch(job._id, {
        payloadStorageId: undefined,
        status: "completed",
        retryCount,
        lastError: args.errorMessage.slice(0, 500),
        nextAttemptAt: now,
        updatedAt: now,
        completedAt: now,
      });
      if (
        reconciliationEpoch === null &&
        installation &&
        !hasOtherPendingJob &&
        installation.accessSuspendedAt !== undefined
      ) {
        await ctx.db.patch(installation._id, {
          repositoryRemovalPendingAt: undefined,
          updatedAt: Math.max(now, installation.updatedAt + 1),
        });
      }
      return true;
    }
    const delayMs = Math.min(
      5 * 60 * 1_000,
      1_000 * 2 ** Math.min(job.retryCount, 8),
    );
    await ctx.db.patch(job._id, {
      retryCount,
      lastError: args.errorMessage.slice(0, 500),
      nextAttemptAt: now + delayMs,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(
      delayMs,
      internal.github.action.continueRepositoryRemovalJob,
      { jobId: job._id },
    );
    return true;
  },
});

export const claimStaleInstallationAccessRemoval = internalMutation({
  args: {
    installationId: v.number(),
    generation: v.number(),
    cursor: v.union(v.string(), v.null()),
    staleBefore: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const installations = await ctx.db
      .query("githubInstallations")
      .withIndex("by_installation_id", (q) =>
        q.eq("installationId", args.installationId),
      )
      .take(2);
    if (installations.length === 0) {
      return false;
    }
    const matchingInstallations = installations.filter(
      (installation) =>
        installation.accessSuspendedAt === args.generation &&
        installation.repositoryAccessRemovalGeneration === args.generation &&
        installation.repositoryAccessRemovalPhase === "pausing" &&
        installation.repositoryAccessRemovalCursor === args.cursor &&
        installation.updatedAt <= args.staleBefore,
    );
    if (matchingInstallations.length === 0) {
      return false;
    }

    for (const installation of matchingInstallations) {
      await ctx.db.patch(installation._id, {
        updatedAt: Math.max(Date.now(), installation.updatedAt + 1),
      });
    }
    return true;
  },
});

export const recoverStaleRepositoryAccessReconciliation = internalMutation({
  args: {
    installationId: v.number(),
    epoch: v.number(),
    phase: v.union(v.literal("fetching"), v.literal("finalizing")),
    expectedRetryCount: v.optional(v.number()),
    expectedNextAttemptAt: v.optional(v.number()),
    now: v.number(),
    staleBefore: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const installation = await getExactGitHubInstallation(
      ctx,
      args.installationId,
    );
    if (
      !installation ||
      installation.repositoryAccessReconciliationEpoch !== args.epoch ||
      installation.repositoryAccessReconciliationPhase !== args.phase
    ) {
      return false;
    }

    if (args.phase === "fetching") {
      const retryCount = args.expectedRetryCount;
      const nextAttemptAt = args.expectedNextAttemptAt;
      if (
        retryCount === undefined ||
        nextAttemptAt === undefined ||
        installation.repositoryAccessReconciliationNextPage === undefined ||
        installation.repositoryAccessReconciliationRetryCount !== retryCount ||
        installation.repositoryAccessReconciliationNextAttemptAt !==
          nextAttemptAt ||
        nextAttemptAt > args.now ||
        (installation.accessSuspendedAt ?? null) !==
          installation.repositoryAccessReconciliationExpectedSuspendedAt
      ) {
        return false;
      }
      await ctx.scheduler.runAfter(
        0,
        internal.github.action.continueRepositoryAccessReconciliation,
        {
          installationId: args.installationId,
          epoch: args.epoch,
          retryCount,
        },
      );
      await ctx.db.patch(installation._id, {
        repositoryAccessReconciliationNextAttemptAt:
          args.now + REPOSITORY_ACCESS_RECONCILIATION_ATTEMPT_LEASE_MS,
        updatedAt: Math.max(args.now, installation.updatedAt + 1),
      });
      return true;
    }

    if (
      installation.accessSuspendedAt !== undefined ||
      installation.updatedAt > args.staleBefore
    ) {
      return false;
    }

    await ctx.scheduler.runAfter(
      0,
      internal.repositories.internalMutation
        .finalizeRepositoryAccessReconciliation,
      {
        installationId: args.installationId,
        epoch: args.epoch,
        paginationOpts: {
          numItems: 25,
          cursor: null,
        },
      },
    );
    await ctx.db.patch(installation._id, {
      updatedAt: Math.max(args.now, installation.updatedAt + 1),
    });
    return true;
  },
});

export const markInstallationActiveAfterReconciliation = internalMutation({
  args: {
    installationId: v.number(),
    expectedAccessSuspendedAt: v.union(v.number(), v.null()),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const installation = await getExactGitHubInstallation(
      ctx,
      args.installationId,
    );
    if (
      !installation ||
      installation.repositoryAccessRemovalDeleteInstallation === true ||
      installation.accessSuspendedAt !==
        (args.expectedAccessSuspendedAt ?? undefined)
    ) {
      return false;
    }
    await ctx.db.patch(installation._id, {
      accessSuspendedAt: undefined,
      repositoryAccessRemovalGeneration: undefined,
      repositoryAccessRemovalCursor: undefined,
      repositoryAccessRemovalDeleteInstallation: undefined,
      repositoryAccessRemovalPhase: undefined,
      updatedAt: Math.max(Date.now(), installation.updatedAt + 1),
    });
    return true;
  },
});
