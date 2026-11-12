import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { internalAction } from "../_generated/server";
import {
  embedSearchDocuments,
  EMBEDDING_PROVIDER,
  embedSearchQuery,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EmbeddingProviderError,
  getEmbeddingInputTokenLimit,
  getEmbeddingKeys,
  type EmbeddingKeys,
  type EmbeddingPolicy,
  type EmbeddingRoute,
} from "../_ai/retrievalEmbeddings";
import {
  executeEmbeddingRequest,
  PAID_USAGE_LIMIT_MESSAGE,
  resolveEmbeddingBillingDecision,
} from "../_ai/embeddingBilling";
import { requireStrictCurrentAiLegalAttestation } from "../_ai/legalAttestation";
import { type RepositoryEmbeddingMetadata } from "../repositories/embeddingPolicy";
import {
  assertRepositoryEmbeddingProviderRequest,
  resolveFreshRepositoryEmbeddingPolicy,
  resolveStoredRagEmbeddingPolicyWithRefresh,
  type RepositoryEmbeddingPolicyAttestation,
  type RepositoryEmbeddingPolicyResolution,
} from "../repositories/embeddingPolicyRuntime";
import { v } from "convex/values";
import {
  getTrustedLearningRepositoryKey,
  isLearningAllowedForSearch,
  type LearningEmbeddingDataProvenance,
} from "./trust";

export type { LearningEmbeddingDataProvenance } from "./trust";

const DEFAULT_LEARNING_SEARCH_LIMIT = 5;
const MAX_LEARNING_SEARCH_LIMIT = 20;
const VECTOR_SEARCH_OVERFETCH_MULTIPLIER = 4;
const MAX_VECTOR_SEARCH_LIMIT = 256;
export const REPO_LEARNING_EMBEDDING_KEY =
  `${EMBEDDING_PROVIDER}:${EMBEDDING_MODEL}:${EMBEDDING_DIMENSIONS}:search_result` as const;

const DEFAULT_LEARNING_EMBEDDING_DATA_PROVENANCE =
  "private_user_input" as const;

async function getLearningIdempotencyKey(args: {
  repositoryId: Id<"repositories">;
  content: string;
  source: string;
  sourceType: "comment" | "link" | "correction";
  isTrusted: boolean;
  ticketId?: Id<"tickets">;
  embeddingDataProvenance?: LearningEmbeddingDataProvenance;
  idempotencyKey?: string;
}): Promise<string> {
  if (args.idempotencyKey) {
    return args.idempotencyKey;
  }
  const input = JSON.stringify([
    args.repositoryId,
    args.content,
    args.source,
    args.sourceType,
    args.isTrusted,
    args.ticketId ?? null,
    args.embeddingDataProvenance ?? DEFAULT_LEARNING_EMBEDDING_DATA_PROVENANCE,
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return `content:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

async function requireDirectRequesterLegalAttestation(
  ctx: ActionCtx,
  requestedByUserId: Id<"users"> | undefined,
): Promise<void> {
  if (requestedByUserId) {
    await requireStrictCurrentAiLegalAttestation(ctx, requestedByUserId);
  }
}

function applyLearningEmbeddingDataPolicy(
  _policy: EmbeddingPolicy,
  _provenance: LearningEmbeddingDataProvenance,
): EmbeddingPolicy {
  return { route: "paid", allowPaidFallback: false };
}

type LearningEmbeddingPolicyPublication = {
  expectedUserId: Id<"users">;
  expectedIndexVersion?: number;
  expectedInstallationId: number;
  expectedGithubRepositoryId: number;
  expectedGithubRepo: string;
  expectedPolicyRoute: EmbeddingRoute;
  expectedRepositoryMetadataCheckedAt?: number;
  expectedGithubVisibility?: "public" | "private" | "internal";
  expectedLicenseKey?: string;
  expectedLicenseSpdxId?: string;
  expectedLicenseOsiApproved?: boolean;
  expectedLicenseOsiCheckedAt?: number;
  expectedRagEmbeddingBillingTier?: "free" | "paid";
  expectedRagEmbeddingKey?: string;
};

function buildLearningEmbeddingPolicyPublication(
  repository: Doc<"repositories">,
  expectedPolicyRoute: EmbeddingRoute,
  attestation?: RepositoryEmbeddingPolicyAttestation,
): LearningEmbeddingPolicyPublication {
  const policySnapshot = attestation ?? repository;
  const githubRepositoryId = policySnapshot.githubRepositoryId;
  if (
    typeof githubRepositoryId !== "number" ||
    !Number.isSafeInteger(githubRepositoryId) ||
    githubRepositoryId <= 0
  ) {
    throw new Error("Repository learning policy snapshot has no identity");
  }
  return {
    expectedUserId: policySnapshot.userId,
    expectedIndexVersion: policySnapshot.indexVersion,
    expectedInstallationId: policySnapshot.installationId,
    expectedGithubRepositoryId: githubRepositoryId,
    expectedGithubRepo: policySnapshot.githubRepo,
    expectedPolicyRoute,
    expectedRepositoryMetadataCheckedAt:
      policySnapshot.repositoryMetadataCheckedAt,
    expectedGithubVisibility: policySnapshot.githubVisibility,
    expectedLicenseKey: policySnapshot.licenseKey,
    expectedLicenseSpdxId: policySnapshot.licenseSpdxId,
    expectedLicenseOsiApproved: policySnapshot.licenseOsiApproved,
    expectedLicenseOsiCheckedAt: policySnapshot.licenseOsiCheckedAt,
    expectedRagEmbeddingBillingTier: policySnapshot.ragEmbeddingBillingTier,
    expectedRagEmbeddingKey: policySnapshot.ragEmbeddingKey,
  };
}

export type LearningWithScore = Doc<"repoLearnings"> & {
  score: number;
};

export const MIN_LEARNING_RELEVANCE_SCORE = 0.7;

export function isRelevantLearningScore(score: number): boolean {
  return Number.isFinite(score) && score >= MIN_LEARNING_RELEVANCE_SCORE;
}

export function getLearningSearchLimit(topK: number | undefined): number {
  if (topK === undefined || !Number.isFinite(topK)) {
    return DEFAULT_LEARNING_SEARCH_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(topK), 1), MAX_LEARNING_SEARCH_LIMIT);
}

export function getLearningEmbeddingPolicy(
  _repository: RepositoryEmbeddingMetadata | null,
): EmbeddingPolicy {
  return { route: "paid", allowPaidFallback: false };
}

function resolveEmbeddingKeysForFallback(): {
  keys: EmbeddingKeys;
  configurationError?: EmbeddingProviderError;
} {
  try {
    return { keys: getEmbeddingKeys() };
  } catch (error) {
    if (!(error instanceof EmbeddingProviderError)) {
      throw error;
    }
    return { keys: {}, configurationError: error };
  }
}

export function mergeLearningResults(
  vectorResults: Array<LearningWithScore>,
  keywordResults: Array<Doc<"repoLearnings">>,
  limit: number,
  requestProvenance: LearningEmbeddingDataProvenance,
): Array<LearningWithScore> {
  const merged: Array<LearningWithScore> = [];
  const seenIds = new Set<string>();

  for (const learning of vectorResults) {
    if (
      seenIds.has(learning._id) ||
      !isLearningAllowedForSearch(learning, requestProvenance)
    ) {
      continue;
    }
    seenIds.add(learning._id);
    merged.push(learning);
    if (merged.length === limit) {
      return merged;
    }
  }

  for (const learning of keywordResults) {
    if (
      seenIds.has(learning._id) ||
      !isLearningAllowedForSearch(learning, requestProvenance)
    ) {
      continue;
    }
    seenIds.add(learning._id);
    merged.push({
      ...learning,
      score: MIN_LEARNING_RELEVANCE_SCORE,
    });
    if (merged.length === limit) {
      break;
    }
  }

  return merged;
}

function logEmbeddingFallback(
  operation: "create" | "search",
  error: EmbeddingProviderError,
): void {
  console.warn(
    `[RepoLearnings] AI ${operation} embedding unavailable; using keyword-only fallback (${error.kind}, ${error.route ?? "unresolved"})`,
  );
}

/**
 * Create a new learning, retaining keyword search when the embedding provider is unavailable.
 */
export const createLearning = internalAction({
  args: {
    repositoryId: v.id("repositories"),
    content: v.string(),
    source: v.string(),
    sourceType: v.union(
      v.literal("comment"),
      v.literal("link"),
      v.literal("correction"),
    ),
    isTrusted: v.boolean(),
    ticketId: v.optional(v.id("tickets")),
    idempotencyKey: v.optional(v.string()),
    requestedByUserId: v.optional(v.id("users")),
    embeddingDataProvenance: v.optional(
      v.union(v.literal("public_github"), v.literal("private_user_input")),
    ),
  },
  handler: async (ctx, args): Promise<Id<"repoLearnings">> => {
    const { requestedByUserId, ...providedLearningWriteArgs } = args;
    await requireDirectRequesterLegalAttestation(ctx, requestedByUserId);
    const embeddingDataProvenance =
      args.embeddingDataProvenance ??
      DEFAULT_LEARNING_EMBEDDING_DATA_PROVENANCE;
    const learningWriteArgs = {
      ...providedLearningWriteArgs,
      idempotencyKey: await getLearningIdempotencyKey(args),
    };
    const repository: Doc<"repositories"> | null = await ctx.runQuery(
      internal.repositories.internalQuery.getById,
      { repositoryId: args.repositoryId },
    );
    if (!repository) {
      throw new EmbeddingProviderError(
        "repository_access",
        "Repository learning publication has no current repository identity",
        { durableRetrySafe: true },
      );
    }
    const githubRepositoryId = repository.githubRepositoryId;
    if (
      !Number.isSafeInteger(repository.installationId) ||
      repository.installationId <= 0 ||
      typeof githubRepositoryId !== "number" ||
      !Number.isSafeInteger(githubRepositoryId) ||
      githubRepositoryId <= 0
    ) {
      throw new EmbeddingProviderError(
        "repository_access",
        "Repository learning publication has no current repository identity",
        { durableRetrySafe: true },
      );
    }
    const { keys, configurationError } = resolveEmbeddingKeysForFallback();
    if (configurationError) {
      logEmbeddingFallback("create", configurationError);
    }
    const policyResolution: RepositoryEmbeddingPolicyResolution | undefined =
      keys.freeApiKey || keys.paidApiKey
        ? await resolveFreshRepositoryEmbeddingPolicy(ctx, repository)
        : undefined;
    const repositoryPolicy =
      policyResolution?.status === "verified_free" ||
      policyResolution?.status === "verified_paid"
        ? policyResolution.policy
        : getLearningEmbeddingPolicy(repository);
    const requestedPolicy = applyLearningEmbeddingDataPolicy(
      repositoryPolicy,
      embeddingDataProvenance,
    );
    const embeddingBilling = configurationError
      ? undefined
      : policyResolution?.status !== "unavailable"
        ? await resolveEmbeddingBillingDecision(ctx, {
            provider: EMBEDDING_PROVIDER,
            userId: repository.userId,
            policy: requestedPolicy,
            keys,
          })
        : undefined;
    const verifiedAttestation =
      policyResolution?.status === "verified_free" ||
      policyResolution?.status === "verified_paid"
        ? policyResolution.attestation
        : undefined;
    const publication = buildLearningEmbeddingPolicyPublication(
      repository,
      requestedPolicy.route,
      verifiedAttestation,
    );
    let learningId: Id<"repoLearnings"> | undefined;
    let embeddingPublicationRejected = false;

    if (
      embeddingBilling?.canEmbed &&
      policyResolution &&
      policyResolution.status !== "unavailable"
    ) {
      try {
        const documents = [
          { title: "repository learning", content: args.content },
        ];
        await requireDirectRequesterLegalAttestation(ctx, requestedByUserId);
        await executeEmbeddingRequest(ctx, {
          provider: EMBEDDING_PROVIDER,
          model: EMBEDDING_MODEL,
          userId: repository.userId,
          repositoryId: repository._id,
          // Deliberately no reservationKey: a content-derived one is burned for
          // good on a failed attempt, and unlike the RAG path this has neither a
          // generation discriminator nor an embedding cache to recover from.
          policy: embeddingBilling.policy,
          keys,
          inputCount: documents.length,
          inputTokenLimit: getEmbeddingInputTokenLimit(documents),
          operation: "repository learning create",
          validateProviderRequest: async (route) => {
            await requireDirectRequesterLegalAttestation(
              ctx,
              requestedByUserId,
            );
            return await assertRepositoryEmbeddingProviderRequest(ctx, {
              resolution: policyResolution,
              route,
              expectedWork: {
                kind: "learning_create",
                indexVersion: repository.indexVersion,
                ticketId: args.ticketId,
              },
            });
          },
          request: async (policy, client) =>
            await embedSearchDocuments(documents, { policy, keys, client }),
          finalize: async ({
            result,
            reservationKey,
            reservationAttemptToken,
          }) => {
            await requireDirectRequesterLegalAttestation(
              ctx,
              requestedByUserId,
            );
            const publishedLearningId = await ctx.runMutation(
              internal.repoLearnings.mutation.create,
              {
                ...learningWriteArgs,
                embeddingDataProvenance,
                embedding: result.embeddings[0],
                embeddingKey: REPO_LEARNING_EMBEDDING_KEY,
                publication,
                usage: {
                  tokens: result.tokens,
                  model: result.model,
                  provider: result.provider,
                  billingTier: result.route,
                  reservationKey,
                  reservationAttemptToken,
                },
              },
            );
            if (!publishedLearningId) {
              embeddingPublicationRejected = true;
              throw new EmbeddingProviderError(
                "repository_access",
                "Repository learning publication lost access or generation ownership",
                { route: result.route },
              );
            }
            learningId = publishedLearningId;
          },
        });
      } catch (error) {
        if (embeddingPublicationRejected) {
          throw error;
        }
        if (!(error instanceof EmbeddingProviderError)) {
          throw error;
        }
        logEmbeddingFallback("create", error);
      }
    } else if (embeddingBilling) {
      const reason = embeddingBilling.paidUsageAllowed
        ? "Embedding credentials do not match the repository policy"
        : PAID_USAGE_LIMIT_MESSAGE;
      console.warn(`[RepoLearnings] ${reason}; using keyword-only create`);
    }

    if (!learningId) {
      await requireDirectRequesterLegalAttestation(ctx, requestedByUserId);
      const keywordLearningId = await ctx.runMutation(
        internal.repoLearnings.mutation.create,
        { ...learningWriteArgs, embeddingDataProvenance, publication },
      );
      if (!keywordLearningId) {
        throw new Error("Repository learning publication was rejected");
      }
      learningId = keywordLearningId;
    }

    console.log("[RepoLearnings] Created learning");

    return learningId;
  },
});

async function getRelevantVectorLearnings(
  ctx: ActionCtx,
  args: {
    repositoryId: Id<"repositories">;
    query: string;
    topK: number;
    repository: Doc<"repositories"> | null;
    expectedIndexVersion: number;
    embeddingDataProvenance: LearningEmbeddingDataProvenance;
    requestedByUserId?: Id<"users">;
  },
): Promise<Array<LearningWithScore>> {
  await requireDirectRequesterLegalAttestation(ctx, args.requestedByUserId);
  const repository = args.repository;
  if (!repository || repository.indexVersion !== args.expectedIndexVersion) {
    return [];
  }
  const initialAccess = await ctx.runQuery(
    internal.repositories.internalQuery.getAiAccessSnapshot,
    {
      repositoryId: args.repositoryId,
      expectedIndexVersion: args.expectedIndexVersion,
    },
  );
  if (!initialAccess) {
    return [];
  }

  const repositoryTrustKey = getTrustedLearningRepositoryKey(args.repositoryId);
  const embeddingScopeKey = `${repositoryTrustKey}:${REPO_LEARNING_EMBEDDING_KEY}`;
  const vectorScopeField =
    args.embeddingDataProvenance === "public_github"
      ? ("publicEmbeddingScopeKey" as const)
      : ("embeddingScopeKey" as const);
  const hasTrustedEmbedding = await ctx.runQuery(
    internal.repoLearnings.internalQuery.hasTrustedEmbeddingInScope,
    {
      repositoryId: args.repositoryId,
      expectedIndexVersion: args.expectedIndexVersion,
      embeddingScopeKey,
      embeddingDataProvenance: args.embeddingDataProvenance,
    },
  );
  if (!hasTrustedEmbedding) {
    return [];
  }

  const keys = getEmbeddingKeys();
  const requestedPolicy =
    repository.ragEmbeddingBillingTier === undefined
      ? await resolveFreshRepositoryEmbeddingPolicy(ctx, repository)
      : await resolveStoredRagEmbeddingPolicyWithRefresh(ctx, repository);
  if (requestedPolicy.status === "unavailable") {
    console.warn(
      `[RepoLearnings] ${requestedPolicy.reason}; using keyword-only search`,
    );
    return [];
  }
  const embeddingBilling = await resolveEmbeddingBillingDecision(ctx, {
    provider: EMBEDDING_PROVIDER,
    userId: repository.userId,
    policy: applyLearningEmbeddingDataPolicy(
      requestedPolicy.policy,
      args.embeddingDataProvenance,
    ),
    keys,
  });
  if (!embeddingBilling.canEmbed) {
    const reason = embeddingBilling.paidUsageAllowed
      ? "Embedding credentials do not match the repository policy"
      : PAID_USAGE_LIMIT_MESSAGE;
    console.warn(`[RepoLearnings] ${reason}; using keyword-only search`);
    return [];
  }

  await requireDirectRequesterLegalAttestation(ctx, args.requestedByUserId);
  const result = await executeEmbeddingRequest(ctx, {
    provider: EMBEDDING_PROVIDER,
    model: EMBEDDING_MODEL,
    userId: repository.userId,
    repositoryId: repository._id,
    policy: embeddingBilling.policy,
    keys,
    inputCount: 1,
    inputTokenLimit: getEmbeddingInputTokenLimit([args.query]),
    operation: "repository learning search",
    validateProviderRequest: async (route) => {
      await requireDirectRequesterLegalAttestation(ctx, args.requestedByUserId);
      return await assertRepositoryEmbeddingProviderRequest(ctx, {
        resolution: requestedPolicy,
        route,
        expectedWork: {
          kind: "learning_search",
          indexVersion: args.expectedIndexVersion,
          embeddingScopeKey,
          embeddingDataProvenance: args.embeddingDataProvenance,
        },
      });
    },
    request: async (policy, client) =>
      await embedSearchQuery(args.query, { policy, keys, client }),
  });

  const queryEmbedding = result.embeddings[0];
  if (!queryEmbedding) {
    return [];
  }

  await requireDirectRequesterLegalAttestation(ctx, args.requestedByUserId);
  const results = await ctx.vectorSearch("repoLearnings", "by_embedding", {
    vector: queryEmbedding,
    limit: Math.min(
      args.topK * VECTOR_SEARCH_OVERFETCH_MULTIPLIER,
      MAX_VECTOR_SEARCH_LIMIT,
    ),
    filter: (q) => q.eq(vectorScopeField, embeddingScopeKey),
  });

  await assertRepositoryEmbeddingProviderRequest(ctx, {
    resolution: requestedPolicy,
    route: result.route,
    expectedWork: {
      kind: "learning_search",
      indexVersion: args.expectedIndexVersion,
      embeddingScopeKey,
      embeddingDataProvenance: args.embeddingDataProvenance,
    },
  });

  const relevantResults = results.filter((vectorResult) =>
    isRelevantLearningScore(vectorResult._score),
  );
  const learnings: Array<LearningWithScore | null> = await Promise.all(
    relevantResults.map(
      async (vectorResult): Promise<LearningWithScore | null> => {
        const doc: Doc<"repoLearnings"> | null = await ctx.runQuery(
          internal.repoLearnings.internalQuery.getById,
          {
            id: vectorResult._id,
            repositoryId: args.repositoryId,
            expectedIndexVersion: args.expectedIndexVersion,
          },
        );

        if (
          !doc ||
          doc.repositoryId !== args.repositoryId ||
          doc.repositoryTrustKey !== repositoryTrustKey ||
          doc.embeddingKey !== REPO_LEARNING_EMBEDDING_KEY ||
          doc.embeddingScopeKey !== embeddingScopeKey ||
          (args.embeddingDataProvenance === "public_github" &&
            doc.publicEmbeddingScopeKey !== embeddingScopeKey) ||
          !isLearningAllowedForSearch(doc, args.embeddingDataProvenance)
        ) {
          return null;
        }

        return {
          ...doc,
          score: vectorResult._score,
        };
      },
    ),
  );

  const finalAccess = await ctx.runQuery(
    internal.repositories.internalQuery.getAiAccessSnapshot,
    {
      repositoryId: args.repositoryId,
      expectedIndexVersion: args.expectedIndexVersion,
    },
  );
  if (!finalAccess) {
    return [];
  }

  return learnings
    .filter((learning): learning is LearningWithScore => learning !== null)
    .slice(0, args.topK);
}

export const searchLearnings = internalAction({
  args: {
    repositoryId: v.id("repositories"),
    query: v.string(),
    topK: v.optional(v.number()),
    requestedByUserId: v.optional(v.id("users")),
    embeddingDataProvenance: v.optional(
      v.union(v.literal("public_github"), v.literal("private_user_input")),
    ),
  },
  handler: async (ctx, args): Promise<LearningWithScore[]> => {
    await requireDirectRequesterLegalAttestation(ctx, args.requestedByUserId);
    const topK = getLearningSearchLimit(args.topK);
    const embeddingDataProvenance =
      args.embeddingDataProvenance ??
      DEFAULT_LEARNING_EMBEDDING_DATA_PROVENANCE;
    const access = await ctx.runQuery(
      internal.repositories.internalQuery.getAiAccessSnapshot,
      { repositoryId: args.repositoryId },
    );
    if (!access) {
      return [];
    }
    const expectedIndexVersion = access.indexVersion;
    const repository: Doc<"repositories"> | null = await ctx.runQuery(
      internal.repositories.internalQuery.getById,
      { repositoryId: args.repositoryId },
    );
    const preSearchAccess = await ctx.runQuery(
      internal.repositories.internalQuery.getAiAccessSnapshot,
      {
        repositoryId: args.repositoryId,
        expectedIndexVersion,
      },
    );
    if (!repository || !preSearchAccess) {
      return [];
    }

    const keywordResults: Array<Doc<"repoLearnings">> = await ctx.runQuery(
      internal.repoLearnings.internalQuery.keywordSearch,
      {
        repositoryId: args.repositoryId,
        expectedIndexVersion,
        query: args.query,
        limit: topK,
        embeddingDataProvenance,
      },
    );

    let vectorResults: Array<LearningWithScore> = [];
    const { keys, configurationError } = resolveEmbeddingKeysForFallback();
    if (configurationError) {
      logEmbeddingFallback("search", configurationError);
    }
    if (keys.freeApiKey || keys.paidApiKey) {
      try {
        vectorResults = await getRelevantVectorLearnings(ctx, {
          repositoryId: args.repositoryId,
          query: args.query,
          topK,
          repository,
          expectedIndexVersion,
          embeddingDataProvenance,
          requestedByUserId: args.requestedByUserId,
        });
      } catch (error) {
        if (!(error instanceof EmbeddingProviderError)) {
          throw error;
        }
        logEmbeddingFallback("search", error);
      }
    }

    const finalAccess = await ctx.runQuery(
      internal.repositories.internalQuery.getAiAccessSnapshot,
      {
        repositoryId: args.repositoryId,
        expectedIndexVersion,
      },
    );
    if (!finalAccess) {
      return [];
    }

    await requireDirectRequesterLegalAttestation(ctx, args.requestedByUserId);

    return mergeLearningResults(
      vectorResults,
      keywordResults,
      topK,
      embeddingDataProvenance,
    );
  },
});
