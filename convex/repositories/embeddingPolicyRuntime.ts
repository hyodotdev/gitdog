import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import {
  getRepositoryInstallationToken,
  GITHUB_API_VERSION,
} from "../github/helpers";
import {
  EmbeddingProviderError,
  type EmbeddingPolicy,
  type EmbeddingRoute,
} from "../_ai/embeddings";
import {
  normalizeGitHubRepositoryEmbeddingMetadata,
  type RepositoryEmbeddingMetadata,
} from "./embeddingPolicy";
import type { LearningEmbeddingDataProvenance } from "../repoLearnings/trust";

const GITHUB_METADATA_TIMEOUT_MS = 10_000;

export type RepositoryEmbeddingPolicyAttestation =
  RepositoryEmbeddingMetadata & {
    repositoryId: Id<"repositories">;
    userId: Id<"users">;
    installationId: number;
    githubRepositoryId: number;
    githubRepo: string;
    indexVersion?: number;
    repositoryMetadataCheckedAt?: number;
    licenseOsiCheckedAt?: number;
    ragEmbeddingBillingTier?: "free" | "paid";
    ragEmbeddingKey?: string;
  };

export type RepositoryEmbeddingPolicyResolution =
  | {
      status: "verified_free" | "verified_paid";
      policy: EmbeddingPolicy;
      attestation: RepositoryEmbeddingPolicyAttestation;
    }
  | {
      status: "unavailable";
      reason: string;
    };

export class RepositoryOwnerLegalEligibilityError extends EmbeddingProviderError {
  constructor(route: EmbeddingRoute) {
    super(
      "policy",
      "Repository owner must confirm current legal eligibility before embeddings can be processed",
      { route, durableRetrySafe: true },
    );
    this.name = "RepositoryOwnerLegalEligibilityError";
  }
}

export type RepositoryEmbeddingWorkExpectation =
  | {
      kind: "rag_index";
      indexVersion: number;
      phase: "files" | "cleanup";
      cursor?: string;
      fileOffset: number;
      chunkOffset: number;
      embeddingKey: string;
    }
  | {
      kind: "rag_search";
      indexVersion: number;
      embeddingKey: string;
    }
  | {
      kind: "learning_create";
      indexVersion: number;
      ticketId?: Id<"tickets">;
    }
  | {
      kind: "learning_search";
      indexVersion: number;
      embeddingScopeKey: string;
      embeddingDataProvenance: LearningEmbeddingDataProvenance;
    };

type AuthoritativeRepositoryEmbeddingMetadata = RepositoryEmbeddingMetadata & {
  githubRepositoryId: number;
  githubRepo: string;
};

class GitHubRepositoryMetadataError extends Error {
  constructor(
    readonly kind: "repository_access" | "policy",
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "GitHubRepositoryMetadataError";
  }
}

function toEmbeddingPolicy(route: EmbeddingRoute): EmbeddingPolicy {
  return {
    route,
    allowPaidFallback: route === "free",
  };
}

function unavailable(reason: string): RepositoryEmbeddingPolicyResolution {
  return { status: "unavailable", reason };
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function hasUsableRepositoryIdentity(
  repository: Doc<"repositories">,
): repository is Doc<"repositories"> & { githubRepositoryId: number } {
  return (
    repository.isActive === true &&
    repository.disconnectCleanupPending !== true &&
    repository.githubAccessRevokedAt === undefined &&
    isPositiveSafeInteger(repository.installationId) &&
    isPositiveSafeInteger(repository.githubRepositoryId)
  );
}

function repositoryMatchesSnapshotIdentity(
  repository: Doc<"repositories">,
  snapshot: Doc<"repositories">,
): boolean {
  return (
    repository._id === snapshot._id &&
    repository.userId === snapshot.userId &&
    repository.installationId === snapshot.installationId &&
    repository.githubRepositoryId === snapshot.githubRepositoryId
  );
}

async function readVerifiedRepositoryAccess(
  ctx: ActionCtx,
  repositorySnapshot: Doc<"repositories">,
): Promise<(Doc<"repositories"> & { githubRepositoryId: number }) | null> {
  const repository: Doc<"repositories"> | null = await ctx.runQuery(
    internal.repositories.internalQuery.getById,
    { repositoryId: repositorySnapshot._id },
  );
  if (
    !repository ||
    !hasUsableRepositoryIdentity(repository) ||
    !repositoryMatchesSnapshotIdentity(repository, repositorySnapshot)
  ) {
    return null;
  }

  const installation = await ctx.runQuery(
    internal.github.internalQuery.getVerifiedInstallationByInstallationId,
    { installationId: repository.installationId },
  );
  if (!installation || installation.userId !== repository.userId) {
    return null;
  }

  return repository;
}

function verifiedResolution(
  repository: Doc<"repositories"> & { githubRepositoryId: number },
  route: EmbeddingRoute,
): RepositoryEmbeddingPolicyResolution {
  return {
    status: route === "free" ? "verified_free" : "verified_paid",
    policy: toEmbeddingPolicy(route),
    attestation: {
      repositoryId: repository._id,
      userId: repository.userId,
      installationId: repository.installationId,
      githubRepositoryId: repository.githubRepositoryId,
      githubRepo: repository.githubRepo,
      indexVersion: repository.indexVersion,
      githubVisibility: repository.githubVisibility,
      licenseKey: repository.licenseKey,
      licenseSpdxId: repository.licenseSpdxId,
      licenseOsiApproved: repository.licenseOsiApproved,
      repositoryMetadataCheckedAt: repository.repositoryMetadataCheckedAt,
      licenseOsiCheckedAt: repository.licenseOsiCheckedAt,
      ragEmbeddingBillingTier: repository.ragEmbeddingBillingTier,
      ragEmbeddingKey: repository.ragEmbeddingKey,
    },
  };
}

/**
 * Resolve a stored generation without external access checks. Production
 * provider calls use the async resolver and provider-boundary attestation.
 */
export function resolveStoredRagEmbeddingPolicy(
  _repository: Doc<"repositories">,
): EmbeddingPolicy {
  return toEmbeddingPolicy("paid");
}

/** Reread access state before reusing or refreshing a stored RAG policy. */
export async function resolveStoredRagEmbeddingPolicyWithRefresh(
  ctx: ActionCtx,
  repositorySnapshot: Doc<"repositories">,
): Promise<RepositoryEmbeddingPolicyResolution> {
  const repository = await readVerifiedRepositoryAccess(
    ctx,
    repositorySnapshot,
  );
  if (!repository) {
    return unavailable(
      "repository access or immutable identity is unavailable",
    );
  }

  return verifiedResolution(repository, "paid");
}

function isSameOptionalString(
  left: string | undefined,
  right: string | undefined,
): boolean {
  return (left?.trim() || undefined) === (right?.trim() || undefined);
}

async function fetchGitHubRepositoryMetadata(
  githubRepositoryId: number,
  expectedGithubRepo: string,
  token: string,
): Promise<AuthoritativeRepositoryEmbeddingMetadata> {
  const response = await fetch(
    `https://api.github.com/repositories/${githubRepositoryId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "Gitdog",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      signal: AbortSignal.timeout(GITHUB_METADATA_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    const kind =
      response.status === 429 || response.status >= 500
        ? "policy"
        : "repository_access";
    throw new GitHubRepositoryMetadataError(
      kind,
      `GitHub metadata refresh returned HTTP ${response.status}`,
      response.status,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new GitHubRepositoryMetadataError(
      "repository_access",
      "GitHub repository metadata response was invalid",
      response.status,
    );
  }
  if (
    typeof body !== "object" ||
    body === null ||
    (body as { id?: unknown }).id !== githubRepositoryId ||
    typeof (body as { full_name?: unknown }).full_name !== "string" ||
    (body as { full_name: string }).full_name.trim() !== expectedGithubRepo
  ) {
    throw new GitHubRepositoryMetadataError(
      "repository_access",
      "GitHub repository identity did not match the connected repository",
      response.status,
    );
  }

  return {
    githubRepositoryId,
    githubRepo: expectedGithubRepo,
    ...normalizeGitHubRepositoryEmbeddingMetadata(body),
  };
}

async function readLiveRepositoryMetadataForProviderRequest(
  repository: Doc<"repositories"> & { githubRepositoryId: number },
  route: EmbeddingRoute,
): Promise<AuthoritativeRepositoryEmbeddingMetadata> {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) {
    throw new EmbeddingProviderError(
      "repository_access",
      "Repository installation access could not be verified live",
      { route, durableRetrySafe: true },
    );
  }

  let token: string;
  try {
    token = await getRepositoryInstallationToken(
      repository.installationId,
      repository.githubRepositoryId,
      appId,
      privateKey,
    );
  } catch {
    throw new EmbeddingProviderError(
      "repository_access",
      "Repository installation access could not be verified live",
      { route, durableRetrySafe: true },
    );
  }

  try {
    return await fetchGitHubRepositoryMetadata(
      repository.githubRepositoryId,
      repository.githubRepo,
      token,
    );
  } catch (error) {
    if (error instanceof EmbeddingProviderError) {
      throw error;
    }
    if (error instanceof GitHubRepositoryMetadataError) {
      throw new EmbeddingProviderError(
        error.kind,
        error.kind === "repository_access"
          ? "Repository access or identity could not be verified live"
          : "Repository metadata service is temporarily unavailable",
        {
          route,
          durableRetrySafe: true,
          httpStatus: error.httpStatus,
        },
      );
    }
    throw new EmbeddingProviderError(
      "repository_access",
      "Repository access or identity could not be verified live",
      { route, durableRetrySafe: true },
    );
  }
}

function repositoryMatchesPersistedMetadata(
  repository: Doc<"repositories">,
  metadata: RepositoryEmbeddingMetadata,
  licenseOsiApproved: boolean,
  licenseOsiCheckedAt: number | undefined,
): boolean {
  return (
    repository.githubVisibility === metadata.githubVisibility &&
    isSameOptionalString(repository.licenseKey, metadata.licenseKey) &&
    isSameOptionalString(repository.licenseSpdxId, metadata.licenseSpdxId) &&
    repository.licenseOsiApproved === licenseOsiApproved &&
    repository.licenseOsiCheckedAt === licenseOsiCheckedAt
  );
}

async function persistVerifiedPolicyMetadata(
  ctx: ActionCtx,
  repository: Doc<"repositories"> & { githubRepositoryId: number },
  liveMetadata: AuthoritativeRepositoryEmbeddingMetadata,
  licenseOsiApproved: boolean,
  licenseOsiCheckedAt: number | undefined,
): Promise<RepositoryEmbeddingPolicyResolution> {
  const persistedRevision: number | null = await ctx.runMutation(
    internal.repositories.internalMutation.updateEmbeddingPolicyMetadata,
    {
      repositoryId: repository._id,
      expectedMetadataCheckedAt: repository.repositoryMetadataCheckedAt,
      expectedInstallationId: repository.installationId,
      expectedGithubRepositoryId: repository.githubRepositoryId,
      expectedGithubRepo: repository.githubRepo,
      githubVisibility: liveMetadata.githubVisibility ?? null,
      licenseKey: liveMetadata.licenseKey ?? null,
      licenseSpdxId: liveMetadata.licenseSpdxId ?? null,
      licenseOsiApproved,
      licenseOsiCheckedAt: licenseOsiCheckedAt ?? null,
    },
  );
  if (persistedRevision === null) {
    return unavailable("repository metadata changed during verification");
  }

  const latestRepository = await readVerifiedRepositoryAccess(ctx, repository);
  if (
    !latestRepository ||
    latestRepository.repositoryMetadataCheckedAt !== persistedRevision ||
    !repositoryMatchesPersistedMetadata(
      latestRepository,
      liveMetadata,
      licenseOsiApproved,
      licenseOsiCheckedAt,
    )
  ) {
    return unavailable(
      "repository access or metadata changed after verification",
    );
  }

  return verifiedResolution(latestRepository, "paid");
}

/**
 * Reconfirm repository identity and policy against GitHub. Access or identity
 * failures are unavailable, not paid: no provider may receive data
 * that Gitdog is no longer authorized to process.
 */
export async function resolveFreshRepositoryEmbeddingPolicy(
  ctx: ActionCtx,
  repositorySnapshot: Doc<"repositories">,
): Promise<RepositoryEmbeddingPolicyResolution> {
  const repository = await readVerifiedRepositoryAccess(
    ctx,
    repositorySnapshot,
  );
  if (!repository) {
    return unavailable(
      "repository access or immutable identity is unavailable",
    );
  }

  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) {
    console.warn(
      "[EmbeddingPolicy] GitHub credentials unavailable; embeddings are unavailable",
    );
    return unavailable("GitHub App credentials are unavailable");
  }

  try {
    const token = await getRepositoryInstallationToken(
      repository.installationId,
      repository.githubRepositoryId,
      appId,
      privateKey,
    );
    const liveMetadata = await fetchGitHubRepositoryMetadata(
      repository.githubRepositoryId,
      repository.githubRepo,
      token,
    );
    return await persistVerifiedPolicyMetadata(
      ctx,
      repository,
      liveMetadata,
      false,
      undefined,
    );
  } catch (error) {
    if (
      error instanceof GitHubRepositoryMetadataError &&
      error.kind === "policy"
    ) {
      console.warn(
        "[EmbeddingPolicy] GitHub metadata is temporarily unavailable; using paid policy",
      );
      return verifiedResolution(repository, "paid");
    }
    console.warn(
      "[EmbeddingPolicy] GitHub access or identity refresh failed; embeddings are unavailable",
    );
    return unavailable(
      "GitHub repository access or identity could not be verified",
    );
  }
}

function matchesExpectedWork(
  repository: Doc<"repositories">,
  expectedWork: RepositoryEmbeddingWorkExpectation | undefined,
): boolean {
  if (!expectedWork) {
    return true;
  }

  switch (expectedWork.kind) {
    case "rag_index":
      return (
        repository.indexVersion === expectedWork.indexVersion &&
        repository.indexStatus === "completed" &&
        repository.ragStatus === "indexing" &&
        repository.ragEmbeddingMode === "openai" &&
        repository.ragEmbeddingKey === expectedWork.embeddingKey &&
        repository.ragIndexPhase === expectedWork.phase &&
        repository.ragIndexCursor === expectedWork.cursor &&
        (repository.ragIndexFileOffset ?? 0) === expectedWork.fileOffset &&
        (repository.ragIndexChunkOffset ?? 0) === expectedWork.chunkOffset &&
        repository.ragContinuationToken === undefined
      );
    case "rag_search":
      return (
        repository.indexVersion === expectedWork.indexVersion &&
        repository.indexStatus === "completed" &&
        repository.ragStatus === "completed" &&
        repository.ragEmbeddingMode === "openai" &&
        repository.ragEmbeddingKey === expectedWork.embeddingKey
      );
    case "learning_create":
    case "learning_search":
      return (
        repository.indexVersion === expectedWork.indexVersion &&
        repository.indexStatus === "completed"
      );
  }
}

function isEmbeddingWriteWork(
  expectedWork: RepositoryEmbeddingWorkExpectation | undefined,
): boolean {
  return (
    expectedWork?.kind === "rag_index" ||
    expectedWork?.kind === "learning_create"
  );
}

function repositoryMatchesAttestedPolicyMetadata(
  repository: Doc<"repositories">,
  attestation: RepositoryEmbeddingPolicyAttestation,
): boolean {
  return (
    repository.githubVisibility === attestation.githubVisibility &&
    isSameOptionalString(repository.licenseKey, attestation.licenseKey) &&
    isSameOptionalString(repository.licenseSpdxId, attestation.licenseSpdxId) &&
    repository.licenseOsiApproved === attestation.licenseOsiApproved &&
    repository.repositoryMetadataCheckedAt ===
      attestation.repositoryMetadataCheckedAt &&
    repository.licenseOsiCheckedAt === attestation.licenseOsiCheckedAt
  );
}

/** Re-attest repository access, free policy, and durable work before each fetch. */
export async function assertRepositoryEmbeddingProviderRequest(
  ctx: ActionCtx,
  args: {
    resolution: RepositoryEmbeddingPolicyResolution;
    route: EmbeddingRoute;
    expectedWork?: RepositoryEmbeddingWorkExpectation;
  },
): Promise<void> {
  if (args.resolution.status === "unavailable") {
    throw new EmbeddingProviderError(
      "repository_access",
      "Repository embedding access is unavailable",
      { route: args.route, durableRetrySafe: true },
    );
  }

  const { attestation } = args.resolution;
  const repositorySnapshot = {
    _id: attestation.repositoryId,
    userId: attestation.userId,
    installationId: attestation.installationId,
    githubRepositoryId: attestation.githubRepositoryId,
  } as Doc<"repositories">;
  const repository = await readVerifiedRepositoryAccess(
    ctx,
    repositorySnapshot,
  );
  if (
    !repository ||
    repository.githubRepo !== attestation.githubRepo ||
    !matchesExpectedWork(repository, args.expectedWork)
  ) {
    throw new EmbeddingProviderError(
      "repository_access",
      "Repository access, identity, or durable work changed before the provider request",
      { route: args.route, durableRetrySafe: true },
    );
  }

  const hasLegalAttestation = await ctx.runQuery(
    internal.users.internalQuery.hasCurrentLegalAttestation,
    { userId: repository.userId },
  );
  if (!hasLegalAttestation) {
    throw new RepositoryOwnerLegalEligibilityError(args.route);
  }

  if (args.expectedWork?.kind === "learning_create") {
    const ticket = args.expectedWork.ticketId
      ? await ctx.runQuery(internal.tickets.internalQuery.getById, {
          ticketId: args.expectedWork.ticketId,
        })
      : null;
    if (
      args.expectedWork.ticketId &&
      (!ticket || ticket.repositoryId !== repository._id)
    ) {
      throw new EmbeddingProviderError(
        "repository_access",
        "Repository learning source changed before the provider request",
        { route: args.route, durableRetrySafe: true },
      );
    }
  }
  if (args.expectedWork?.kind === "learning_search") {
    const hasTrustedEmbedding = await ctx.runQuery(
      internal.repoLearnings.internalQuery.hasTrustedEmbeddingInScope,
      {
        repositoryId: repository._id,
        expectedIndexVersion: args.expectedWork.indexVersion,
        embeddingScopeKey: args.expectedWork.embeddingScopeKey,
        embeddingDataProvenance: args.expectedWork.embeddingDataProvenance,
      },
    );
    if (!hasTrustedEmbedding) {
      throw new EmbeddingProviderError(
        "repository_access",
        "Repository learning embedding scope changed before the provider request",
        { route: args.route, durableRetrySafe: true },
      );
    }
  }

  if (
    isEmbeddingWriteWork(args.expectedWork) &&
    !repositoryMatchesAttestedPolicyMetadata(repository, attestation)
  ) {
    throw new EmbeddingProviderError(
      "policy",
      "Repository embedding policy changed before the provider write request",
      { route: args.route, durableRetrySafe: true },
    );
  }

  try {
    await readLiveRepositoryMetadataForProviderRequest(repository, args.route);
  } catch (error) {
    const temporarilyUnavailable =
      error instanceof EmbeddingProviderError &&
      error.kind === "policy" &&
      error.httpStatus !== undefined &&
      (error.httpStatus === 429 || error.httpStatus >= 500);
    if (args.route === "paid" && temporarilyUnavailable) {
      // The durable installation and immutable repository identity still
      // match. Preserve paid availability for transient GitHub service
      // failures, but never for an access- or identity-classified response.
      console.warn(
        `[EmbeddingPolicy] GitHub metadata returned HTTP ${error.httpStatus}; proceeding with the verified paid route`,
      );
      return;
    }
    throw error;
  }

  if (args.route === "free")
    throw new EmbeddingProviderError(
      "policy",
      "Free-tier embeddings are no longer supported",
      { route: "free", durableRetrySafe: true },
    );
}
