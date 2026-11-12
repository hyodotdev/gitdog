import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { internalAction } from "../_generated/server";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EMBEDDING_PROVIDER,
  EmbeddingProviderError,
  type EmbeddingPolicy,
  type EmbeddingRoute,
} from "../_ai/legacyEmbeddings";
import { requireStrictCurrentAiLegalAttestation } from "../_ai/legalAttestation";
import { type RepositoryEmbeddingMetadata } from "../repositories/embeddingPolicy";
import { v } from "convex/values";
import {
  isLearningAllowedForSearch,
  type LearningEmbeddingDataProvenance,
} from "./trust";

export type { LearningEmbeddingDataProvenance } from "./trust";

const DEFAULT_LEARNING_SEARCH_LIMIT = 5;
const MAX_LEARNING_SEARCH_LIMIT = 20;
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
): LearningEmbeddingPolicyPublication {
  const policySnapshot = repository;
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
    // Learnings are stored for keyword search; no embedding is created.
    const publication = buildLearningEmbeddingPolicyPublication(
      repository,
      getLearningEmbeddingPolicy(repository).route,
    );
    await requireDirectRequesterLegalAttestation(ctx, requestedByUserId);
    const learningId = await ctx.runMutation(
      internal.repoLearnings.mutation.create,
      { ...learningWriteArgs, embeddingDataProvenance, publication },
    );
    if (!learningId) {
      throw new Error("Repository learning publication was rejected");
    }

    console.log("[RepoLearnings] Created learning");

    return learningId;
  },
});

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
      [],
      keywordResults,
      topK,
      embeddingDataProvenance,
    );
  },
});
