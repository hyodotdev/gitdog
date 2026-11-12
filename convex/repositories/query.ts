import { query } from "../_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { paginatedCollect } from "../_utils/pagination";
import {
  checkRepositoryAccess,
  hasLiveOwnerTeamEntitlement,
  type RepositoryRole,
} from "../_utils/accessControl";
import type { Doc, Id } from "../_generated/dataModel";
import {
  getInvitationUnavailableReason,
  type InvitationUnavailableReason,
} from "../invitations/availability";
import { getCanonicalGitHubRepositoryFullNameKey } from "../github/repositoryIdentity";
import {
  getIncrementalIndexStaleAt,
  hasIncrementalIndexWorkInProgress,
} from "../repoIndexing/readiness";

export const REPOSITORY_ROUTE_DUPLICATE_LIMIT = 50;
export const SHARED_REPOSITORY_MEMBERSHIP_LIMIT = 500;

const PUBLIC_REPOSITORY_FIELDS = [
  "_id",
  "_creationTime",
  "userId",
  "installationId",
  "githubRepositoryId",
  "githubRepo",
  "githubRepoKey",
  "name",
  "description",
  "githubUrl",
  "language",
  "stars",
  "githubVisibility",
  "licenseKey",
  "licenseSpdxId",
  "licenseOsiApproved",
  "isActive",
  "githubAccessRevokedAt",
  "githubInstallationReconnectRequired",
  "defaultBranch",
  "indexVersion",
  "indexStatus",
  "indexError",
  "lastIndexedAt",
  "ragStatus",
  "ragError",
  "ragLastIndexedAt",
  "ragTotalChunks",
  "ragIndexedChunks",
  "ragFailedChunks",
  "ragEmbeddingMode",
  "ragEmbeddingBillingTier",
  "ragEmbeddingError",
  "settings",
  "monthlyActions",
  "lastResetAt",
  "createdAt",
  "updatedAt",
] as const satisfies ReadonlyArray<keyof Doc<"repositories">>;

export type PublicRepository = Pick<
  Doc<"repositories">,
  (typeof PUBLIC_REPOSITORY_FIELDS)[number]
> & {
  indexingProgress?: {
    phase: "files" | "search" | "cleanup";
    lastProgressAt: number;
    staleAt?: number;
    processedFiles: number;
    syncQueued: boolean;
  };
};

export function toPublicRepository(
  repository: Doc<"repositories">,
): PublicRepository {
  const publicRepository: Partial<PublicRepository> = {};
  for (const field of PUBLIC_REPOSITORY_FIELDS) {
    if (field in repository) {
      Object.assign(publicRepository, { [field]: repository[field] });
    }
  }
  if (
    hasIncrementalIndexWorkInProgress(repository) &&
    repository.indexStatus !== "failed" &&
    repository.ragStatus !== "failed" &&
    repository.githubAccessRevokedAt === undefined &&
    repository.githubInstallationReconnectRequired !== true
  ) {
    publicRepository.indexingProgress = {
      phase:
        repository.indexStatus !== "completed"
          ? "files"
          : repository.ragIndexPhase === "cleanup"
            ? "cleanup"
            : "search",
      lastProgressAt: repository.indexProgressAt,
      staleAt: getIncrementalIndexStaleAt(repository),
      processedFiles: repository.ragProcessedFiles ?? 0,
      syncQueued: repository.indexSyncPending,
    };
  }
  return publicRepository as PublicRepository;
}

async function toRepositoryQueryResult(
  ctx: Parameters<typeof getInvitationUnavailableReason>[0],
  repository: Doc<"repositories">,
  userRole: RepositoryRole,
): Promise<
  PublicRepository & {
    userRole: RepositoryRole;
    invitationUnavailableReason?: InvitationUnavailableReason;
  }
> {
  const invitationUnavailableReason = await getInvitationUnavailableReason(
    ctx,
    repository,
  );
  return invitationUnavailableReason === undefined
    ? { ...toPublicRepository(repository), userRole }
    : {
        ...toPublicRepository(repository),
        userRole,
        invitationUnavailableReason,
      };
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return [];
    }

    // Get repositories owned by user
    const ownedRepos = await paginatedCollect(
      ctx.db
        .query("repositories")
        .withIndex("by_user", (q) => q.eq("userId", userId)),
    );

    // Keep repository hydration bounded so one heavily shared account cannot
    // exceed Convex read or response limits.
    const memberships = await ctx.db
      .query("repositoryMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(SHARED_REPOSITORY_MEMBERSHIP_LIMIT + 1);
    if (memberships.length > SHARED_REPOSITORY_MEMBERSHIP_LIMIT) {
      throw new Error("shared repository list exceeded the safety limit");
    }

    // Get unique repository IDs and fetch in parallel to avoid N+1
    const repoIds = [...new Set(memberships.map((m) => m.repositoryId))];
    const repos = await Promise.all(repoIds.map((id) => ctx.db.get(id)));

    // Create a map for O(1) lookup
    const repoMap = new Map(
      repos
        .filter(
          (r): r is NonNullable<typeof r> =>
            r !== null && r.disconnectCleanupPending !== true,
        )
        .map((r) => [r._id, r]),
    );

    const sharedOwnerIds = [
      ...new Set(
        [...repoMap.values()]
          .filter((repository) => repository.userId !== userId)
          .map((repository) => repository.userId),
      ),
    ];
    const teamEntitlementCheckedAt = Date.now();
    const sharedOwnerTeamAccess = new Map<Id<"users">, boolean>(
      await Promise.all(
        sharedOwnerIds.map(
          async (ownerUserId) =>
            [
              ownerUserId,
              await hasLiveOwnerTeamEntitlement(
                ctx,
                ownerUserId,
                teamEntitlementCheckedAt,
              ),
            ] as const,
        ),
      ),
    );

    // Build shared repos list with role information
    const sharedRepos = memberships
      .map((m) => {
        const repo = repoMap.get(m.repositoryId);
        if (!repo) return null;
        // Skip if it's already in ownedRepos (user is both owner and in members table)
        if (repo.userId === userId) return null;
        if (sharedOwnerTeamAccess.get(repo.userId) !== true) return null;
        return {
          ...toPublicRepository(repo),
          userRole: "viewer" as RepositoryRole,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    // Combine results with role information
    const ownedWithRole = ownedRepos
      .filter((repository) => repository.disconnectCleanupPending !== true)
      .map((r) => ({
        ...toPublicRepository(r),
        userRole: "owner" as RepositoryRole,
      }));

    return [...ownedWithRole, ...sharedRepos];
  },
});

export const get = query({
  args: {
    owner: v.string(),
    repo: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return null;
    }

    const githubRepo = `${args.owner}/${args.repo}`;
    let githubRepoKey: string;
    try {
      githubRepoKey = getCanonicalGitHubRepositoryFullNameKey(githubRepo);
    } catch {
      return null;
    }

    const ownedRepository = await ctx.db
      .query("repositories")
      .withIndex("by_user_and_repo_key", (q) =>
        q.eq("userId", userId).eq("githubRepoKey", githubRepoKey),
      )
      .first();
    if (ownedRepository && ownedRepository.disconnectCleanupPending !== true) {
      return await toRepositoryQueryResult(ctx, ownedRepository, "owner");
    }

    const repositories = await ctx.db
      .query("repositories")
      .withIndex("by_github_repo_key", (q) =>
        q.eq("githubRepoKey", githubRepoKey),
      )
      .take(REPOSITORY_ROUTE_DUPLICATE_LIMIT + 1);

    if (repositories.length > REPOSITORY_ROUTE_DUPLICATE_LIMIT) {
      throw new Error(
        `repository lookup exceeded the duplicate safety limit for ${githubRepo}`,
      );
    }

    for (const repository of repositories) {
      if (repository.disconnectCleanupPending === true) {
        continue;
      }
      const access = await checkRepositoryAccess(ctx, repository._id, userId);
      if (access.hasAccess && access.role) {
        return await toRepositoryQueryResult(ctx, repository, access.role);
      }
    }

    return null;
  },
});

export const getConnectedRepos = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return [];
    }

    const repos = await paginatedCollect(
      ctx.db
        .query("repositories")
        .withIndex("by_user", (q) => q.eq("userId", userId)),
    );

    return repos
      .filter((repository) => repository.disconnectCleanupPending !== true)
      .map((repository) => repository.githubRepo);
  },
});

export const getReconnectTarget = query({
  args: {
    reconnectRepositoryId: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return null;
    }
    const repositoryId = ctx.db.normalizeId(
      "repositories",
      args.reconnectRepositoryId,
    );
    if (!repositoryId) {
      return null;
    }
    const repository = await ctx.db.get(repositoryId);
    const isInstallationReconnect =
      repository?.githubInstallationReconnectRequired === true;
    if (
      !repository ||
      repository.userId !== userId ||
      !isInstallationReconnect ||
      repository.disconnectCleanupPending === true
    ) {
      return null;
    }
    return {
      repositoryId: repository._id,
      githubRepo: repository.githubRepo,
      name: repository.name,
      githubRepositoryId: repository.githubRepositoryId,
    };
  },
});

export const getById = query({
  args: {
    repositoryId: v.id("repositories"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("not authenticated");
    }

    const repo = await ctx.db.get(args.repositoryId);
    if (!repo || repo.disconnectCleanupPending === true) {
      throw new Error("repository not found");
    }

    // Check if user has access (owner or member)
    const access = await checkRepositoryAccess(ctx, args.repositoryId, userId);
    if (!access.hasAccess) {
      throw new Error("unauthorized");
    }

    return { ...toPublicRepository(repo), userRole: access.role };
  },
});
