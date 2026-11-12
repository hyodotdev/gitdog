import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import {
  fetchGitHubAppJsonWithRetry,
  getRepositoryInstallationToken,
} from "./helpers";
import { isGitHubInstallationReady } from "./installationAccess";

type GitHubRepositoryIdentity = {
  id?: unknown;
  full_name?: unknown;
};

const GITHUB_REPOSITORY_FULL_NAME_MAX_LENGTH = 500;
const GITHUB_REPOSITORY_WHITESPACE_PATTERN = /\s/u;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

export type VerifiedRepositoryAccess = {
  repository: Doc<"repositories">;
  installation: Doc<"githubInstallations">;
  githubRepositoryId: number;
  githubRepo: string;
  owner: string;
  repo: string;
  token: string;
};

export function parseCanonicalGitHubRepositoryFullName(fullName: string): {
  owner: string;
  repo: string;
} {
  if (
    fullName.length === 0 ||
    fullName.length > GITHUB_REPOSITORY_FULL_NAME_MAX_LENGTH ||
    fullName !== fullName.trim() ||
    hasControlCharacter(fullName) ||
    GITHUB_REPOSITORY_WHITESPACE_PATTERN.test(fullName)
  ) {
    throw new Error("GitHub returned an invalid repository identity");
  }
  const parts = fullName.split("/");
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
    throw new Error("GitHub returned an invalid repository identity");
  }
  const [owner, repo] = parts;
  return { owner, repo };
}

export function getCanonicalGitHubRepositoryFullNameKey(
  fullName: string,
): string {
  parseCanonicalGitHubRepositoryFullName(fullName);
  return fullName.toLowerCase();
}

export function isVerifiedActiveInstallationForRepository(
  repository: Doc<"repositories">,
  installation: Doc<"githubInstallations"> | null,
): installation is Doc<"githubInstallations"> {
  return (
    installation !== null &&
    installation.installationId === repository.installationId &&
    installation.userId === repository.userId &&
    isGitHubInstallationReady(installation) &&
    repository.githubAccessRevokedAt === undefined &&
    repository.disconnectCleanupPending !== true &&
    repository.isActive === true &&
    Number.isSafeInteger(repository.githubRepositoryId) &&
    repository.githubRepositoryId > 0
  );
}

export async function hasVerifiedActiveRepositoryInstallation(
  ctx: ActionCtx,
  repository: Doc<"repositories">,
): Promise<boolean> {
  const currentRepository = await ctx.runQuery(
    internal.repositories.internalQuery.getById,
    { repositoryId: repository._id },
  );
  if (
    !currentRepository ||
    currentRepository.userId !== repository.userId ||
    currentRepository.installationId !== repository.installationId ||
    currentRepository.githubRepositoryId !== repository.githubRepositoryId ||
    currentRepository.githubRepo !== repository.githubRepo ||
    currentRepository.indexVersion !== repository.indexVersion ||
    currentRepository.isActive !== true ||
    currentRepository.disconnectCleanupPending === true ||
    currentRepository.githubAccessRevokedAt !== undefined
  ) {
    return false;
  }
  const installation = await ctx.runQuery(
    internal.github.internalQuery.getVerifiedInstallationByInstallationId,
    { installationId: currentRepository.installationId },
  );
  return isVerifiedActiveInstallationForRepository(
    currentRepository,
    installation,
  );
}

/**
 * Resolve a repository through its immutable GitHub ID using the installation
 * token that is about to perform the external request. Never trust a stored
 * mutable owner/name for ticket reads or writes.
 */
export async function resolveVerifiedRepositoryAccess(
  ctx: ActionCtx,
  repositoryId: Id<"repositories">,
): Promise<VerifiedRepositoryAccess> {
  const repository = await ctx.runQuery(
    internal.repositories.internalQuery.getById,
    { repositoryId },
  );
  if (!repository) {
    throw new Error("Repository is not connected");
  }

  const installation = await ctx.runQuery(
    internal.github.internalQuery.getVerifiedInstallationByInstallationId,
    { installationId: repository.installationId },
  );
  if (!isVerifiedActiveInstallationForRepository(repository, installation)) {
    throw new Error("Repository installation access is not active");
  }

  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) {
    throw new Error("GitHub App credentials not configured");
  }

  const githubRepositoryId = repository.githubRepositoryId;
  const token = await getRepositoryInstallationToken(
    installation.installationId,
    githubRepositoryId,
    appId,
    privateKey,
  );
  const liveRepository =
    await fetchGitHubAppJsonWithRetry<GitHubRepositoryIdentity>(
      `https://api.github.com/repositories/${githubRepositoryId}`,
      token,
      "GitHub repository identity lookup",
    );
  if (
    liveRepository.id !== githubRepositoryId ||
    typeof liveRepository.full_name !== "string" ||
    liveRepository.full_name.trim().length === 0
  ) {
    throw new Error("GitHub repository identity no longer matches");
  }

  const [currentRepository, currentInstallation] = await Promise.all([
    ctx.runQuery(internal.repositories.internalQuery.getById, {
      repositoryId,
    }),
    ctx.runQuery(
      internal.github.internalQuery.getVerifiedInstallationByInstallationId,
      { installationId: installation.installationId },
    ),
  ]);
  if (
    !currentRepository ||
    !isVerifiedActiveInstallationForRepository(
      currentRepository,
      currentInstallation,
    ) ||
    currentRepository.installationId !== installation.installationId ||
    currentRepository.userId !== repository.userId ||
    currentRepository.githubRepositoryId !== githubRepositoryId
  ) {
    throw new Error("Repository installation access changed during request");
  }

  const githubRepo = liveRepository.full_name;
  const { owner, repo } = parseCanonicalGitHubRepositoryFullName(githubRepo);
  return {
    repository: currentRepository,
    installation: currentInstallation,
    githubRepositoryId,
    githubRepo,
    owner,
    repo,
    token,
  };
}

/**
 * Resolve immutable identity for a read-only claimed-write reconciliation.
 * This intentionally permits an owner-requested disconnect already in
 * progress, but it never authorizes a new GitHub write.
 */
export async function resolveDisconnectingRepositoryReadAccess(
  ctx: ActionCtx,
  repositoryId: Id<"repositories">,
): Promise<VerifiedRepositoryAccess> {
  const repository = await ctx.runQuery(
    internal.repositories.internalQuery.getByIdIncludingDisconnecting,
    { repositoryId },
  );
  if (
    !repository ||
    repository.disconnectCleanupPending !== true ||
    repository.githubAccessRevokedAt !== undefined ||
    !Number.isSafeInteger(repository.githubRepositoryId) ||
    repository.githubRepositoryId <= 0
  ) {
    throw new Error("Disconnecting repository is unavailable");
  }
  const installation = await ctx.runQuery(
    internal.github.internalQuery.getVerifiedInstallationByInstallationId,
    { installationId: repository.installationId },
  );
  if (
    !installation ||
    !isGitHubInstallationReady(installation) ||
    installation.userId !== repository.userId ||
    installation.installationId !== repository.installationId
  ) {
    throw new Error("Repository installation access is not active");
  }
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) {
    throw new Error("GitHub App credentials not configured");
  }

  const githubRepositoryId = repository.githubRepositoryId;
  const token = await getRepositoryInstallationToken(
    installation.installationId,
    githubRepositoryId,
    appId,
    privateKey,
  );
  const liveRepository =
    await fetchGitHubAppJsonWithRetry<GitHubRepositoryIdentity>(
      `https://api.github.com/repositories/${githubRepositoryId}`,
      token,
      "GitHub disconnect reconciliation identity lookup",
    );
  if (
    liveRepository.id !== githubRepositoryId ||
    typeof liveRepository.full_name !== "string" ||
    liveRepository.full_name.trim().length === 0
  ) {
    throw new Error("GitHub repository identity no longer matches");
  }

  const currentRepository = await ctx.runQuery(
    internal.repositories.internalQuery.getByIdIncludingDisconnecting,
    { repositoryId },
  );
  if (
    !currentRepository ||
    currentRepository.disconnectCleanupPending !== true ||
    currentRepository.userId !== repository.userId ||
    currentRepository.installationId !== installation.installationId ||
    currentRepository.githubRepositoryId !== githubRepositoryId ||
    currentRepository.githubAccessRevokedAt !== undefined
  ) {
    throw new Error("Repository identity changed during reconciliation");
  }
  const githubRepo = liveRepository.full_name;
  const { owner, repo } = parseCanonicalGitHubRepositoryFullName(githubRepo);
  return {
    repository: currentRepository,
    installation,
    githubRepositoryId,
    githubRepo,
    owner,
    repo,
    token,
  };
}
