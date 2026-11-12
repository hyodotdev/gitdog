import { query } from "../_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { getExactGitHubInstallation } from "./installationAccess";

const MAX_USER_INSTALLATIONS = 500;

function hasExactSuspendedReconciliation(
  installation: Doc<"githubInstallations">,
): boolean {
  return (
    installation.accessSuspendedAt !== undefined &&
    installation.repositoryAccessReconciliationEpoch !== undefined &&
    installation.repositoryAccessReconciliationNextPage !== undefined &&
    installation.repositoryAccessReconciliationPhase === "fetching" &&
    installation.repositoryAccessReconciliationExpectedSuspendedAt ===
      installation.accessSuspendedAt
  );
}

function isVisibleInstallation(
  installation: Doc<"githubInstallations">,
): boolean {
  return (
    installation.accessSuspendedAt === undefined ||
    hasExactSuspendedReconciliation(installation) ||
    installation.repositoryAccessReconciliationFailure !== undefined
  );
}

function toPublicInstallation(installation: Doc<"githubInstallations">) {
  const reconciliationFailed =
    installation.repositoryAccessReconciliationFailure !== undefined;
  const reconciliationPending =
    !reconciliationFailed &&
    (installation.repositoryRemovalPendingAt !== undefined ||
      installation.repositoryAccessReconciliationPhase !== undefined);
  const {
    ownerGithubAccountId: _ownerGithubAccountId,
    ownershipVerifiedAt: _ownershipVerifiedAt,
    accessSuspendedAt: _accessSuspendedAt,
    webhookAccessStateAttestationGeneration:
      _webhookAccessStateAttestationGeneration,
    webhookAccessStateAttestationFailure: _webhookAccessStateAttestationFailure,
    webhookAccessStateAttestationFailedAt:
      _webhookAccessStateAttestationFailedAt,
    webhookAccessStateAttestationRetryCount:
      _webhookAccessStateAttestationRetryCount,
    webhookAccessStateAttestationNextAttemptAt:
      _webhookAccessStateAttestationNextAttemptAt,
    repositoryAccessRemovalGeneration: _repositoryAccessRemovalGeneration,
    repositoryAccessRemovalCursor: _repositoryAccessRemovalCursor,
    repositoryAccessRemovalDeleteInstallation:
      _repositoryAccessRemovalDeleteInstallation,
    repositoryAccessRemovalPhase: _repositoryAccessRemovalPhase,
    repositoryRemovalPendingAt: _repositoryRemovalPendingAt,
    repositoryAccessReconciliationEpoch: _repositoryAccessReconciliationEpoch,
    repositoryAccessReconciliationRevision:
      _repositoryAccessReconciliationRevision,
    repositoryAccessReconciliationNextPage:
      _repositoryAccessReconciliationNextPage,
    repositoryAccessReconciliationRetryCount:
      _repositoryAccessReconciliationRetryCount,
    repositoryAccessReconciliationNextAttemptAt:
      _repositoryAccessReconciliationNextAttemptAt,
    repositoryAccessReconciliationExpectedSuspendedAt:
      _repositoryAccessReconciliationExpectedSuspendedAt,
    repositoryAccessReconciliationPhase: _repositoryAccessReconciliationPhase,
    repositoryAccessReconciliationFailure:
      _repositoryAccessReconciliationFailure,
    repositoryAccessReconciliationFailedAt:
      _repositoryAccessReconciliationFailedAt,
    ...publicInstallation
  } = installation;
  return {
    ...publicInstallation,
    reconciliationPending,
    reconciliationFailed,
  };
}

function toOwnerVisibleInstallation(installation: Doc<"githubInstallations">) {
  return isVisibleInstallation(installation)
    ? toPublicInstallation(installation)
    : null;
}

async function getOwnerVisibleExactInstallations(
  ctx: Parameters<typeof getExactGitHubInstallation>[0],
  installations: Array<Doc<"githubInstallations">>,
): Promise<Array<NonNullable<ReturnType<typeof toOwnerVisibleInstallation>>>> {
  const visibleInstallations: Array<
    NonNullable<ReturnType<typeof toOwnerVisibleInstallation>>
  > = [];
  for (const installation of installations) {
    const exactInstallation = await getExactGitHubInstallation(
      ctx,
      installation.installationId,
    );
    if (exactInstallation?._id !== installation._id) {
      continue;
    }
    const visibleInstallation = toOwnerVisibleInstallation(installation);
    if (visibleInstallation) {
      visibleInstallations.push(visibleInstallation);
    }
  }
  return visibleInstallations;
}

export const getUserInstallation = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return null;
    }

    const installations = await ctx.db
      .query("githubInstallations")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(MAX_USER_INSTALLATIONS + 1);
    if (installations.length > MAX_USER_INSTALLATIONS) {
      return null;
    }

    return (
      (await getOwnerVisibleExactInstallations(ctx, installations))[0] ?? null
    );
  },
});

export const getUserInstallations = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return [];
    }

    const installations = await ctx.db
      .query("githubInstallations")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(MAX_USER_INSTALLATIONS + 1);
    if (installations.length > MAX_USER_INSTALLATIONS) {
      throw new Error(
        "GitHub App installation limit exceeded. Contact support to continue.",
      );
    }

    return await getOwnerVisibleExactInstallations(ctx, installations);
  },
});

export const getInstallation = query({
  args: {
    installationId: v.number(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return null;
    }
    const installation = await getExactGitHubInstallation(
      ctx,
      args.installationId,
    );

    return installation?.userId === userId
      ? toOwnerVisibleInstallation(installation)
      : null;
  },
});
