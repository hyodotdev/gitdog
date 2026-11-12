import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { getCanonicalGitHubRepositoryFullNameKey } from "../github/repositoryIdentity";

export const REPOSITORY_NAME_MATCH_LIMIT = 20;
export const REPOSITORY_NAME_QUARANTINE_OWNER = "__gitdog_quarantine__";

export function getRepositoryNameQuarantineFullName(
  repository: Doc<"repositories">,
): string {
  return `${REPOSITORY_NAME_QUARANTINE_OWNER}/${repository.githubRepositoryId}`;
}

/** Resolve exact GitHub full-name equality using its case-insensitive key. */
export async function readCanonicalRepositoryNameMatches(
  ctx: MutationCtx,
  args: {
    userId: Id<"users">;
    githubRepo: string;
  },
): Promise<{
  githubRepoKey: string;
  repositories: Array<Doc<"repositories">>;
}> {
  const githubRepoKey = getCanonicalGitHubRepositoryFullNameKey(
    args.githubRepo,
  );
  const keyedRepositories = await ctx.db
    .query("repositories")
    .withIndex("by_user_and_repo_key", (q) =>
      q.eq("userId", args.userId).eq("githubRepoKey", githubRepoKey),
    )
    .take(REPOSITORY_NAME_MATCH_LIMIT + 1);
  if (keyedRepositories.length > REPOSITORY_NAME_MATCH_LIMIT) {
    throw new Error("too many repository name conflicts");
  }

  return { githubRepoKey, repositories: keyedRepositories };
}
