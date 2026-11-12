import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

export const REPOSITORY_IDENTITY_MATCH_LIMIT = 20;

type RepositoryIdentityReadCtx = Pick<QueryCtx, "db">;

function enforceRepositoryIdentityMatchLimit(
  repositories: Array<Doc<"repositories">>,
): Array<Doc<"repositories">> {
  if (repositories.length > REPOSITORY_IDENTITY_MATCH_LIMIT) {
    throw new Error("repository identity lookup exceeded its safety limit");
  }
  return repositories;
}

/** Read every bounded row for one installation-scoped immutable identity. */
export async function readRepositoriesByInstallationAndGitHubRepositoryId(
  ctx: RepositoryIdentityReadCtx,
  installationId: number,
  githubRepositoryId: number,
): Promise<Array<Doc<"repositories">>> {
  return enforceRepositoryIdentityMatchLimit(
    await ctx.db
      .query("repositories")
      .withIndex("by_installation_and_github_repository_id", (q) =>
        q
          .eq("installationId", installationId)
          .eq("githubRepositoryId", githubRepositoryId),
      )
      .take(REPOSITORY_IDENTITY_MATCH_LIMIT + 1),
  );
}

/** Read every bounded row for one user-scoped immutable identity. */
export async function readRepositoriesByUserAndGitHubRepositoryId(
  ctx: RepositoryIdentityReadCtx,
  userId: Id<"users">,
  githubRepositoryId: number,
): Promise<Array<Doc<"repositories">>> {
  return enforceRepositoryIdentityMatchLimit(
    await ctx.db
      .query("repositories")
      .withIndex("by_user_and_github_repository_id", (q) =>
        q.eq("userId", userId).eq("githubRepositoryId", githubRepositoryId),
      )
      .take(REPOSITORY_IDENTITY_MATCH_LIMIT + 1),
  );
}

function getRepositoryIdentityPriority(
  repository: Doc<"repositories">,
): number {
  if (
    repository.githubAccessRevokedAt !== undefined ||
    repository.githubInstallationReconnectRequired === true
  ) {
    return 0;
  }
  return repository.isActive === true ? 2 : 1;
}

export type RepositoryIdentityResolution = {
  repository: Doc<"repositories"> | null;
  ambiguous: boolean;
  preferredMatches: Array<Doc<"repositories">>;
};

/**
 * Prefer the unique live active row over inactive or revoked historical rows.
 * Equal-priority duplicates are never resolved by database insertion order.
 */
export function resolveUniquePreferredRepositoryIdentity(
  repositories: Array<Doc<"repositories">>,
  accepts: (repository: Doc<"repositories">) => boolean = (repository) =>
    repository.disconnectCleanupPending !== true,
): RepositoryIdentityResolution {
  const candidates = repositories.filter(accepts);
  if (candidates.length === 0) {
    return { repository: null, ambiguous: false, preferredMatches: [] };
  }

  const priority = Math.max(...candidates.map(getRepositoryIdentityPriority));
  const preferredMatches = candidates.filter(
    (repository) => getRepositoryIdentityPriority(repository) === priority,
  );
  return {
    repository: preferredMatches.length === 1 ? preferredMatches[0] : null,
    ambiguous: preferredMatches.length > 1,
    preferredMatches,
  };
}
