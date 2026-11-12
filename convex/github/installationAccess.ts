import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

type InstallationAccessState = {
  ownerGithubAccountId: string;
  ownershipVerifiedAt: number;
  accessSuspendedAt?: number;
  repositoryAccessRemovalPhase?: "pausing";
  repositoryRemovalPendingAt?: number;
  repositoryAccessReconciliationPhase?: "fetching" | "finalizing";
  repositoryAccessReconciliationFailure?: string;
};

type InstallationLookupCtx = Pick<QueryCtx, "db">;

/**
 * Return an installation only when the indexed identity resolves to exactly
 * one row. Duplicate rows are corrupt provenance and must never authorize
 * repository work.
 */
export async function getExactGitHubInstallation(
  ctx: InstallationLookupCtx,
  installationId: number,
): Promise<Doc<"githubInstallations"> | null> {
  const installations = await ctx.db
    .query("githubInstallations")
    .withIndex("by_installation_id", (q) =>
      q.eq("installationId", installationId),
    )
    .take(2);
  return installations.length === 1 ? installations[0] : null;
}

/** Repository work may run only after every installation access sweep ends. */
export function isGitHubInstallationReady(
  installation: InstallationAccessState | null | undefined,
): installation is InstallationAccessState {
  return (
    installation !== null &&
    installation !== undefined &&
    installation.accessSuspendedAt === undefined &&
    installation.repositoryAccessRemovalPhase === undefined &&
    installation.repositoryRemovalPendingAt === undefined &&
    installation.repositoryAccessReconciliationPhase === undefined &&
    installation.repositoryAccessReconciliationFailure === undefined
  );
}

/** Signed repository metadata may advance during an access reconciliation. */
export function canApplyGitHubRepositoryMetadataWebhook(
  installation: InstallationAccessState | null | undefined,
): installation is InstallationAccessState {
  return (
    installation !== null &&
    installation !== undefined &&
    installation.accessSuspendedAt === undefined &&
    installation.repositoryAccessRemovalPhase === undefined &&
    (installation.repositoryRemovalPendingAt === undefined ||
      installation.repositoryAccessReconciliationPhase !== undefined)
  );
}

/** A signed push may be deferred only for an exact transient reconciliation. */
export function isGitHubInstallationReconciliationPending(
  installation: InstallationAccessState | null | undefined,
): installation is InstallationAccessState {
  return (
    canApplyGitHubRepositoryMetadataWebhook(installation) &&
    installation.repositoryAccessReconciliationPhase !== undefined
  );
}
