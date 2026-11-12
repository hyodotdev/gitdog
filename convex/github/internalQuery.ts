import { internalQuery, type QueryCtx } from "../_generated/server";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import {
  canApplyGitHubRepositoryMetadataWebhook,
  getExactGitHubInstallation,
  isGitHubInstallationReady,
} from "./installationAccess";
import { readRepositoriesByUserAndGitHubRepositoryId } from "../repositories/immutableIdentity";
import { hasCurrentLegalAttestation } from "../users/legal";
import {
  GITHUB_INSTALLATION_ATTESTATION_MAX_INSTALLATIONS,
  GITHUB_INSTALLATION_ATTESTATION_TTL_MS,
} from "./oauthInstallationAttestation";

type StaleRepositoryAccessReconciliation =
  | {
      installationId: number;
      epoch: number;
      phase: "fetching";
      expectedRetryCount: number;
      expectedNextAttemptAt: number;
    }
  | {
      installationId: number;
      epoch: number;
      phase: "finalizing";
    };

type FreshOAuthInstallationAttestation = {
  githubAccountId: string;
  installationIds: number[];
  attestedAt: number;
  expiresAt: number;
};

type OAuthInstallationRecoveryTarget =
  | { status: "candidate"; installationId: number }
  | { status: "configure_required"; installationId: number }
  | { status: "complete" }
  | { status: "none" }
  | { status: "reauth_required" }
  | { status: "unavailable" };

type OAuthInstallationRecoveryPostRefreshResult =
  | { status: "recovered"; installationId: number }
  | Exclude<OAuthInstallationRecoveryTarget, { status: "candidate" }>;

type OAuthInstallationRecoveryScan =
  | { status: "unavailable" }
  | {
      status: "available";
      attemptedInstallationRecovered: boolean;
      firstCandidate: number | null;
      firstConfigurationRequired: number | null;
    };

async function readFreshOAuthInstallationAttestation(
  ctx: Pick<QueryCtx, "db">,
  userId: Id<"users">,
  now: number,
): Promise<FreshOAuthInstallationAttestation | null> {
  if (!Number.isSafeInteger(now) || now <= 0) {
    return null;
  }

  const [user, accounts, attestations] = await Promise.all([
    ctx.db.get(userId),
    ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) =>
        q.eq("userId", userId).eq("provider", "github"),
      )
      .take(2),
    ctx.db
      .query("githubOAuthInstallationAttestations")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(2),
  ]);
  if (!user || accounts.length !== 1 || attestations.length !== 1) {
    return null;
  }

  const account = accounts[0];
  const attestation = attestations[0];
  if (!/^[1-9]\d*$/.test(account.providerAccountId)) {
    return null;
  }
  const [matchingAccounts, matchingAttestations] = await Promise.all([
    ctx.db
      .query("authAccounts")
      .withIndex("providerAndAccountId", (q) =>
        q
          .eq("provider", "github")
          .eq("providerAccountId", account.providerAccountId),
      )
      .take(2),
    ctx.db
      .query("githubOAuthInstallationAttestations")
      .withIndex("by_github_account", (q) =>
        q.eq("githubAccountId", account.providerAccountId),
      )
      .take(2),
  ]);
  if (
    matchingAccounts.length !== 1 ||
    matchingAccounts[0]._id !== account._id ||
    matchingAttestations.length !== 1 ||
    matchingAttestations[0]._id !== attestation._id ||
    attestation.userId !== userId ||
    attestation.githubAccountId !== account.providerAccountId ||
    !Number.isSafeInteger(attestation.attestedAt) ||
    attestation.attestedAt <= 0 ||
    !Number.isSafeInteger(attestation.expiresAt) ||
    attestation.expiresAt !==
      attestation.attestedAt + GITHUB_INSTALLATION_ATTESTATION_TTL_MS ||
    attestation.updatedAt !== attestation.attestedAt ||
    attestation.attestedAt > now ||
    attestation.expiresAt <= now ||
    attestation.installationIds.length >
      GITHUB_INSTALLATION_ATTESTATION_MAX_INSTALLATIONS ||
    attestation.installationIds.some(
      (installationId, index, installationIds) =>
        !Number.isSafeInteger(installationId) ||
        installationId <= 0 ||
        (index > 0 && installationIds[index - 1] >= installationId),
    )
  ) {
    return null;
  }

  return {
    githubAccountId: account.providerAccountId,
    installationIds: attestation.installationIds,
    attestedAt: attestation.attestedAt,
    expiresAt: attestation.expiresAt,
  };
}

async function scanOAuthInstallationRecoveryState(
  ctx: Pick<QueryCtx, "db">,
  userId: Id<"users">,
  attestation: FreshOAuthInstallationAttestation,
  attemptedInstallationId: number | null,
): Promise<OAuthInstallationRecoveryScan> {
  let attemptedInstallationRecovered = false;
  let firstCandidate: number | null = null;
  let firstConfigurationRequired: number | null = null;

  const installationsByAttestedId = await Promise.all(
    attestation.installationIds.map(async (installationId) => ({
      installationId,
      installations: await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) =>
          q.eq("installationId", installationId),
        )
        .take(2),
    })),
  );

  for (const { installationId, installations } of installationsByAttestedId) {
    if (installations.length > 1) {
      return { status: "unavailable" };
    }
    const installation = installations[0];
    if (!installation) {
      firstCandidate ??= installationId;
      continue;
    }
    if (
      installation.userId !== userId ||
      installation.ownerGithubAccountId !== attestation.githubAccountId ||
      !Number.isSafeInteger(installation.ownershipVerifiedAt) ||
      installation.ownershipVerifiedAt <= 0
    ) {
      return { status: "unavailable" };
    }
    if (installation.accessSuspendedAt !== undefined) {
      firstConfigurationRequired ??= installationId;
      continue;
    }
    if (installationId === attemptedInstallationId) {
      attemptedInstallationRecovered = true;
    }
  }

  return {
    status: "available",
    attemptedInstallationRecovered,
    firstCandidate,
    firstConfigurationRequired,
  };
}

function getOAuthInstallationRecoveryTargetFromScan(
  scan: OAuthInstallationRecoveryScan,
): Exclude<
  OAuthInstallationRecoveryTarget,
  { status: "none" } | { status: "reauth_required" }
> {
  if (scan.status === "unavailable") {
    return scan;
  }
  if (scan.firstConfigurationRequired !== null) {
    return {
      status: "configure_required",
      installationId: scan.firstConfigurationRequired,
    };
  }
  return scan.firstCandidate === null
    ? { status: "complete" }
    : { status: "candidate", installationId: scan.firstCandidate };
}

export const getUserIdByGithubAccountId = internalQuery({
  args: {
    githubAccountId: v.string(),
  },
  handler: async (ctx, args) => {
    const accounts = await ctx.db
      .query("authAccounts")
      .withIndex("providerAndAccountId", (q) =>
        q
          .eq("provider", "github")
          .eq("providerAccountId", args.githubAccountId),
      )
      .take(2);
    if (accounts.length !== 1) {
      return null;
    }

    return (await ctx.db.get(accounts[0].userId)) ? accounts[0].userId : null;
  },
});

export const getFreshOAuthInstallationAttestation = internalQuery({
  args: {
    userId: v.id("users"),
    installationId: v.number(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    if (
      !Number.isSafeInteger(args.installationId) ||
      args.installationId <= 0
    ) {
      return null;
    }

    const attestation = await readFreshOAuthInstallationAttestation(
      ctx,
      args.userId,
      args.now,
    );
    if (
      !attestation ||
      !attestation.installationIds.includes(args.installationId)
    ) {
      return null;
    }

    return {
      githubAccountId: attestation.githubAccountId,
      attestedAt: attestation.attestedAt,
      expiresAt: attestation.expiresAt,
    };
  },
});

export const getOAuthInstallationRecoveryTarget = internalQuery({
  args: {
    userId: v.id("users"),
    now: v.number(),
  },
  handler: async (ctx, args): Promise<OAuthInstallationRecoveryTarget> => {
    const attestation = await readFreshOAuthInstallationAttestation(
      ctx,
      args.userId,
      args.now,
    );
    if (!attestation) {
      return { status: "reauth_required" };
    }
    if (attestation.installationIds.length === 0) {
      return { status: "none" };
    }

    const scan = await scanOAuthInstallationRecoveryState(
      ctx,
      args.userId,
      attestation,
      null,
    );
    return getOAuthInstallationRecoveryTargetFromScan(scan);
  },
});

export const getOAuthInstallationRecoveryResultAfterRefresh = internalQuery({
  args: {
    userId: v.id("users"),
    attemptedInstallationId: v.number(),
    now: v.number(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<OAuthInstallationRecoveryPostRefreshResult> => {
    if (
      !Number.isSafeInteger(args.attemptedInstallationId) ||
      args.attemptedInstallationId <= 0
    ) {
      return { status: "unavailable" };
    }

    const attestation = await readFreshOAuthInstallationAttestation(
      ctx,
      args.userId,
      args.now,
    );
    if (!attestation) {
      return { status: "reauth_required" };
    }
    if (attestation.installationIds.length === 0) {
      return { status: "none" };
    }

    const attemptedInstallationIsAttested =
      attestation.installationIds.includes(args.attemptedInstallationId);
    const scan = await scanOAuthInstallationRecoveryState(
      ctx,
      args.userId,
      attestation,
      args.attemptedInstallationId,
    );
    if (scan.status === "unavailable") {
      return scan;
    }
    if (
      attemptedInstallationIsAttested &&
      scan.attemptedInstallationRecovered
    ) {
      return {
        status: "recovered",
        installationId: args.attemptedInstallationId,
      };
    }
    if (scan.firstConfigurationRequired !== null) {
      return {
        status: "configure_required",
        installationId: scan.firstConfigurationRequired,
      };
    }
    if (attemptedInstallationIsAttested) {
      return {
        status: "configure_required",
        installationId: args.attemptedInstallationId,
      };
    }

    const refreshedTarget = getOAuthInstallationRecoveryTargetFromScan(scan);
    return refreshedTarget.status === "candidate"
      ? { status: "reauth_required" }
      : refreshedTarget;
  },
});

/** Resolve one live, currently attested Gitdog user for a direct GitHub actor. */
export const getLegallyEligibleUserIdByGithubAccountId = internalQuery({
  args: {
    githubAccountId: v.string(),
  },
  handler: async (ctx, args) => {
    if (!/^[1-9]\d*$/.test(args.githubAccountId)) return null;
    const accounts = await ctx.db
      .query("authAccounts")
      .withIndex("providerAndAccountId", (q) =>
        q
          .eq("provider", "github")
          .eq("providerAccountId", args.githubAccountId),
      )
      .take(2);
    if (accounts.length !== 1) return null;
    const userId = accounts[0].userId;
    if (!(await ctx.db.get(userId))) return null;
    const profiles = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(2);
    return profiles.length === 1 && hasCurrentLegalAttestation(profiles[0])
      ? userId
      : null;
  },
});

export const getInstallationByInstallationId = internalQuery({
  args: {
    installationId: v.number(),
  },
  handler: async (ctx, args) => {
    const installation = await getExactGitHubInstallation(
      ctx,
      args.installationId,
    );

    return installation;
  },
});

export const getVerifiedInstallationByInstallationId = internalQuery({
  args: {
    installationId: v.number(),
  },
  handler: async (ctx, args) => {
    const installation = await getExactGitHubInstallation(
      ctx,
      args.installationId,
    );
    return isGitHubInstallationReady(installation) ? installation : null;
  },
});

export const getRepositoryMetadataWebhookInstallation = internalQuery({
  args: {
    installationId: v.number(),
  },
  handler: async (ctx, args) => {
    const installation = await getExactGitHubInstallation(
      ctx,
      args.installationId,
    );
    return canApplyGitHubRepositoryMetadataWebhook(installation)
      ? installation
      : null;
  },
});

export const getRepositoryRemovalJob = internalQuery({
  args: { jobId: v.id("githubRepositoryRemovalJobs") },
  handler: async (ctx, args) => await ctx.db.get(args.jobId),
});

export const listDueRepositoryRemovalJobs = internalQuery({
  args: { now: v.number() },
  handler: async (ctx, args) =>
    await ctx.db
      .query("githubRepositoryRemovalJobs")
      .withIndex("by_status_and_next_attempt", (q) =>
        q.eq("status", "pending").lte("nextAttemptAt", args.now),
      )
      .take(25),
});

export const listStaleInstallationAccessRemovals = internalQuery({
  args: { staleBefore: v.number() },
  handler: async (ctx, args) => {
    const installations = await ctx.db
      .query("githubInstallations")
      .withIndex("by_access_removal_phase_and_updated_at", (q) =>
        q
          .eq("repositoryAccessRemovalPhase", "pausing")
          .lte("updatedAt", args.staleBefore),
      )
      .take(25);
    return installations.flatMap((installation) => {
      const generation = installation.repositoryAccessRemovalGeneration;
      const cursor = installation.repositoryAccessRemovalCursor;
      if (
        generation === undefined ||
        cursor === undefined ||
        installation.accessSuspendedAt !== generation
      ) {
        return [];
      }
      return [
        { installationId: installation.installationId, generation, cursor },
      ];
    });
  },
});

const FAILED_WEBHOOK_ATTESTATION_RECOVERY_LIMIT = 25;

/** Read a bounded batch of stale in-flight and terminal webhook attestations. */
export const listStaleInstallationWebhookAccessStateAttestations =
  internalQuery({
    args: { now: v.number() },
    handler: async (ctx, args) => {
      return (
        await ctx.db
          .query("githubInstallations")
          .withIndex("by_webhook_attestation_next_attempt", (q) =>
            q
              .gt("webhookAccessStateAttestationNextAttemptAt", 0)
              .lte("webhookAccessStateAttestationNextAttemptAt", args.now),
          )
          .take(FAILED_WEBHOOK_ATTESTATION_RECOVERY_LIMIT)
      ).flatMap((installation) => {
        const generation = installation.webhookAccessStateAttestationGeneration;
        const retryCount = installation.webhookAccessStateAttestationRetryCount;
        if (
          generation === undefined ||
          retryCount === undefined ||
          installation.accessSuspendedAt !== generation ||
          installation.webhookAccessStateAttestationNextAttemptAt === undefined
        ) {
          return [];
        }
        return [
          {
            installationId: installation.installationId,
            generation,
            expectedRetryCount: retryCount,
            expectedFailure:
              installation.webhookAccessStateAttestationFailure ?? null,
          },
        ];
      });
    },
  });

export const listStaleRepositoryAccessReconciliations = internalQuery({
  args: { now: v.number(), staleBefore: v.number() },
  returns: v.array(
    v.union(
      v.object({
        installationId: v.number(),
        epoch: v.number(),
        phase: v.literal("fetching"),
        expectedRetryCount: v.number(),
        expectedNextAttemptAt: v.number(),
      }),
      v.object({
        installationId: v.number(),
        epoch: v.number(),
        phase: v.literal("finalizing"),
      }),
    ),
  ),
  handler: async (
    ctx,
    args,
  ): Promise<StaleRepositoryAccessReconciliation[]> => {
    const [fetching, finalizing] = await Promise.all([
      ctx.db
        .query("githubInstallations")
        .withIndex("by_reconciliation_phase_and_next_attempt", (q) =>
          q
            .eq("repositoryAccessReconciliationPhase", "fetching")
            .gt("repositoryAccessReconciliationNextAttemptAt", 0)
            .lte("repositoryAccessReconciliationNextAttemptAt", args.now),
        )
        .take(25),
      ctx.db
        .query("githubInstallations")
        .withIndex("by_reconciliation_phase_and_updated_at", (q) =>
          q
            .eq("repositoryAccessReconciliationPhase", "finalizing")
            .lte("updatedAt", args.staleBefore),
        )
        .take(25),
    ]);
    const reconciliations: StaleRepositoryAccessReconciliation[] = [];
    for (const installation of fetching) {
      const epoch = installation.repositoryAccessReconciliationEpoch;
      const expectedRetryCount =
        installation.repositoryAccessReconciliationRetryCount;
      const expectedNextAttemptAt =
        installation.repositoryAccessReconciliationNextAttemptAt;
      if (
        epoch === undefined ||
        installation.repositoryAccessReconciliationPhase !== "fetching" ||
        expectedRetryCount === undefined ||
        expectedNextAttemptAt === undefined
      ) {
        continue;
      }
      reconciliations.push({
        installationId: installation.installationId,
        epoch,
        phase: "fetching",
        expectedRetryCount,
        expectedNextAttemptAt,
      });
    }
    for (const installation of finalizing) {
      const epoch = installation.repositoryAccessReconciliationEpoch;
      if (
        epoch === undefined ||
        installation.repositoryAccessReconciliationPhase !== "finalizing"
      ) {
        continue;
      }
      reconciliations.push({
        installationId: installation.installationId,
        epoch,
        phase: "finalizing",
      });
    }
    return reconciliations;
  },
});

export const getConnectedGitHubRepositoryIdsForUser = internalQuery({
  args: {
    userId: v.id("users"),
    githubRepositoryIds: v.array(v.number()),
  },
  handler: async (ctx, args) => {
    if (args.githubRepositoryIds.length > 100) {
      throw new Error("Too many GitHub repository IDs");
    }
    const connectedIds: number[] = [];
    for (const githubRepositoryId of new Set(args.githubRepositoryIds)) {
      if (
        !Number.isSafeInteger(githubRepositoryId) ||
        githubRepositoryId <= 0
      ) {
        continue;
      }
      const repositories = await readRepositoriesByUserAndGitHubRepositoryId(
        ctx,
        args.userId,
        githubRepositoryId,
      );
      if (repositories.length > 0) connectedIds.push(githubRepositoryId);
    }
    return connectedIds;
  },
});
