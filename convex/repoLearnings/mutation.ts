import { internalMutation } from "../_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseWriter } from "../_generated/server";
import { EMBEDDING_DIMENSIONS } from "../_ai/legacyEmbeddings";
import { recordEmbeddingUsageInTransaction } from "../tokenUsage/internalMutation";
import {
  getExactGitHubInstallation,
  isGitHubInstallationReady,
} from "../github/installationAccess";
import { getTrustedLearningRepositoryKey } from "./trust";

const learningEmbeddingPolicyPublicationValidator = v.object({
  expectedUserId: v.id("users"),
  expectedIndexVersion: v.optional(v.number()),
  expectedInstallationId: v.number(),
  expectedGithubRepositoryId: v.number(),
  expectedGithubRepo: v.string(),
  expectedPolicyRoute: v.union(v.literal("free"), v.literal("paid")),
  expectedRepositoryMetadataCheckedAt: v.optional(v.number()),
  expectedGithubVisibility: v.optional(
    v.union(v.literal("public"), v.literal("private"), v.literal("internal")),
  ),
  expectedLicenseKey: v.optional(v.string()),
  expectedLicenseSpdxId: v.optional(v.string()),
  expectedLicenseOsiApproved: v.optional(v.boolean()),
  expectedLicenseOsiCheckedAt: v.optional(v.number()),
  expectedRagEmbeddingBillingTier: v.optional(
    v.union(v.literal("free"), v.literal("paid")),
  ),
  expectedRagEmbeddingKey: v.optional(v.string()),
});

type LearningEmbeddingPolicyPublication = {
  expectedUserId: Id<"users">;
  expectedIndexVersion?: number;
  expectedInstallationId: number;
  expectedGithubRepositoryId: number;
  expectedGithubRepo: string;
  expectedPolicyRoute: "free" | "paid";
  expectedRepositoryMetadataCheckedAt?: number;
  expectedGithubVisibility?: "public" | "private" | "internal";
  expectedLicenseKey?: string;
  expectedLicenseSpdxId?: string;
  expectedLicenseOsiApproved?: boolean;
  expectedLicenseOsiCheckedAt?: number;
  expectedRagEmbeddingBillingTier?: "free" | "paid";
  expectedRagEmbeddingKey?: string;
};

function repositoryMatchesLearningEmbeddingPolicy(
  repository: Doc<"repositories">,
  publication: LearningEmbeddingPolicyPublication,
  _embeddingDataProvenance: "public_github" | "private_user_input" | undefined,
): boolean {
  const currentPolicyRoute = "paid";
  return (
    currentPolicyRoute === publication.expectedPolicyRoute &&
    repository.repositoryMetadataCheckedAt ===
      publication.expectedRepositoryMetadataCheckedAt &&
    repository.githubVisibility === publication.expectedGithubVisibility &&
    repository.licenseKey === publication.expectedLicenseKey &&
    repository.licenseSpdxId === publication.expectedLicenseSpdxId &&
    repository.licenseOsiApproved === publication.expectedLicenseOsiApproved &&
    repository.licenseOsiCheckedAt ===
      publication.expectedLicenseOsiCheckedAt &&
    repository.ragEmbeddingBillingTier ===
      publication.expectedRagEmbeddingBillingTier &&
    repository.ragEmbeddingKey === publication.expectedRagEmbeddingKey
  );
}

export const create = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    content: v.string(),
    source: v.string(),
    idempotencyKey: v.optional(v.string()),
    sourceType: v.union(
      v.literal("comment"),
      v.literal("link"),
      v.literal("correction"),
    ),
    isTrusted: v.boolean(),
    embeddingDataProvenance: v.optional(
      v.union(v.literal("public_github"), v.literal("private_user_input")),
    ),
    embedding: v.optional(v.array(v.float64())),
    embeddingKey: v.optional(v.string()),
    usage: v.optional(
      v.object({
        tokens: v.number(),
        model: v.string(),
        provider: v.union(v.literal("google"), v.literal("openai")),
        billingTier: v.union(v.literal("free"), v.literal("paid")),
        reservationKey: v.optional(v.string()),
        reservationAttemptToken: v.optional(v.string()),
      }),
    ),
    publication: learningEmbeddingPolicyPublicationValidator,
    ticketId: v.optional(v.id("tickets")),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const expected = args.publication;
    const [repository, installation, ticket] = await Promise.all([
      ctx.db.get(args.repositoryId),
      getExactGitHubInstallation(ctx, expected.expectedInstallationId),
      args.ticketId !== undefined ? ctx.db.get(args.ticketId) : null,
    ]);
    const hasCurrentAccess =
      repository?.isActive === true &&
      repository.disconnectCleanupPending !== true &&
      repository.githubAccessRevokedAt === undefined &&
      repository.userId === expected.expectedUserId &&
      repository.installationId === expected.expectedInstallationId &&
      repository.githubRepositoryId === expected.expectedGithubRepositoryId &&
      repository.githubRepo === expected.expectedGithubRepo &&
      isGitHubInstallationReady(installation) &&
      installation.userId === expected.expectedUserId;
    const generationMatches =
      expected.expectedIndexVersion === undefined ||
      repository?.indexVersion === expected.expectedIndexVersion;
    const policyMatches =
      repository !== null &&
      repositoryMatchesLearningEmbeddingPolicy(
        repository,
        expected,
        args.embeddingDataProvenance,
      );
    const sourceMatches =
      args.ticketId === undefined ||
      (ticket !== null &&
        "repositoryId" in ticket &&
        ticket.repositoryId === args.repositoryId);
    const isEmbeddingPublication =
      args.embedding !== undefined ||
      args.embeddingKey !== undefined ||
      args.usage !== undefined;
    if (isEmbeddingPublication) {
      if (
        !args.embedding ||
        args.embedding.length !== EMBEDDING_DIMENSIONS ||
        args.embedding.some((component) => !Number.isFinite(component)) ||
        !args.embeddingKey ||
        !args.usage ||
        (args.usage.billingTier === "free" &&
          expected.expectedPolicyRoute !== "free") ||
        expected.expectedIndexVersion === undefined
      ) {
        throw new Error("embedding publication is invalid");
      }

      // A provider response has already occurred. Finalize paid usage even
      // when access or generation ownership changed while it was in flight,
      // then decline the stale learning publication atomically.
      await recordEmbeddingUsageInTransaction(ctx, {
        userId: expected.expectedUserId,
        repositoryId: args.repositoryId,
        ...args.usage,
      });

      if (
        !hasCurrentAccess ||
        !generationMatches ||
        !policyMatches ||
        repository.indexStatus !== "completed" ||
        !sourceMatches
      ) {
        return null;
      }
    } else if (
      !hasCurrentAccess ||
      !generationMatches ||
      !policyMatches ||
      !sourceMatches
    ) {
      return null;
    }
    const repositoryTrustKey = args.isTrusted
      ? getTrustedLearningRepositoryKey(args.repositoryId)
      : undefined;
    const existingLearning = args.idempotencyKey
      ? await ctx.db
          .query("repoLearnings")
          .withIndex("by_repository_and_idempotency", (q) =>
            q
              .eq("repositoryId", args.repositoryId)
              .eq("idempotencyKey", args.idempotencyKey),
          )
          .first()
      : null;
    if (existingLearning) {
      if (
        existingLearning.content !== args.content ||
        existingLearning.sourceType !== args.sourceType ||
        existingLearning.isTrusted !== args.isTrusted ||
        existingLearning.ticketId !== args.ticketId ||
        existingLearning.embeddingDataProvenance !==
          (args.embeddingDataProvenance ?? "private_user_input")
      ) {
        throw new Error("Repository learning source identity mismatch");
      }
      if (args.embedding && args.embeddingKey && !existingLearning.embedding) {
        await ctx.db.patch(existingLearning._id, {
          embedding: args.embedding,
          embeddingKey: args.embeddingKey,
          embeddingScopeKey: repositoryTrustKey
            ? `${repositoryTrustKey}:${args.embeddingKey}`
            : undefined,
          publicEmbeddingScopeKey:
            repositoryTrustKey &&
            args.embeddingDataProvenance === "public_github"
              ? `${repositoryTrustKey}:${args.embeddingKey}`
              : undefined,
        });
      }
      return existingLearning._id;
    }

    const learningId = await ctx.db.insert("repoLearnings", {
      repositoryId: args.repositoryId,
      content: args.content,
      source: args.source,
      idempotencyKey: args.idempotencyKey,
      sourceType: args.sourceType,
      isTrusted: args.isTrusted,
      repositoryTrustKey,
      embedding: args.embedding,
      embeddingKey: args.embeddingKey,
      embeddingScopeKey:
        repositoryTrustKey && args.embeddingKey
          ? `${repositoryTrustKey}:${args.embeddingKey}`
          : undefined,
      publicEmbeddingScopeKey:
        repositoryTrustKey &&
        args.embeddingKey &&
        args.embeddingDataProvenance === "public_github"
          ? `${repositoryTrustKey}:${args.embeddingKey}`
          : undefined,
      embeddingDataProvenance:
        args.embeddingDataProvenance ?? "private_user_input",
      ticketId: args.ticketId,
      createdAt: now,
    });

    return learningId;
  },
});

/** Delete every learning owned by one repository. */
export async function deleteLearningsByRepository(
  db: DatabaseWriter,
  repositoryId: Id<"repositories">,
): Promise<number> {
  let deletedCount = 0;

  while (true) {
    const learnings = await db
      .query("repoLearnings")
      .withIndex("by_repository", (q) => q.eq("repositoryId", repositoryId))
      .take(50);

    if (learnings.length === 0) break;

    for (const learning of learnings) {
      await db.delete(learning._id);
      deletedCount++;
    }
  }

  return deletedCount;
}

export const deleteByRepository = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
  },
  handler: async (ctx, args) => {
    return deleteLearningsByRepository(ctx.db, args.repositoryId);
  },
});
