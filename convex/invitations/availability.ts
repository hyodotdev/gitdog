import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  getExactGitHubInstallation,
  isGitHubInstallationReady,
} from "../github/installationAccess";

type InvitationRepositoryState = Pick<
  Doc<"repositories">,
  | "installationId"
  | "userId"
  | "disconnectCleanupPending"
  | "githubAccessRevokedAt"
  | "githubInstallationReconnectRequired"
>;

export type InvitationUnavailableReason =
  "disconnecting" | "reconnect" | "revoked" | "syncing";

type InvitationAvailabilityCtx = Pick<QueryCtx, "db">;

export function getInvitationRepositoryUnavailableReason(
  repository: InvitationRepositoryState | null | undefined,
): Exclude<InvitationUnavailableReason, "syncing"> | undefined {
  if (!repository || repository.disconnectCleanupPending === true) {
    return "disconnecting";
  }
  if (repository.githubInstallationReconnectRequired === true) {
    return "reconnect";
  }
  if (repository.githubAccessRevokedAt !== undefined) {
    return "revoked";
  }
  return undefined;
}

/** Manual automation pauses do not disable repository collaboration. */
export function isInvitationRepositoryAvailable(
  repository: InvitationRepositoryState | null | undefined,
): repository is InvitationRepositoryState {
  return getInvitationRepositoryUnavailableReason(repository) === undefined;
}

/** Match invitation UI/list availability to the final mutation attestation. */
export async function getInvitationUnavailableReason(
  ctx: InvitationAvailabilityCtx,
  repository: InvitationRepositoryState | null | undefined,
): Promise<InvitationUnavailableReason | undefined> {
  const repositoryReason = getInvitationRepositoryUnavailableReason(repository);
  if (repositoryReason !== undefined || !repository) {
    return repositoryReason;
  }

  const installation = await getExactGitHubInstallation(
    ctx,
    repository.installationId,
  );
  if (
    !installation ||
    installation.userId !== repository.userId ||
    installation.installationId !== repository.installationId
  ) {
    return "reconnect";
  }
  if (
    installation.accessSuspendedAt !== undefined ||
    installation.repositoryAccessRemovalPhase !== undefined ||
    installation.repositoryRemovalPendingAt !== undefined
  ) {
    return "revoked";
  }
  if (installation.repositoryAccessReconciliationPhase !== undefined) {
    return "syncing";
  }
  return isGitHubInstallationReady(installation) ? undefined : "reconnect";
}
