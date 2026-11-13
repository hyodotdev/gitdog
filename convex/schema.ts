import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";
import { chatRecoveryTargetValidator } from "./_ai/chatRecovery";
import { reviewBatchResultValidator } from "./pullRequests/review";

const applicationTables = {
  projectApiKeys: defineTable({
    repositoryId: v.id("repositories"),
    userId: v.id("users"),
    name: v.string(),
    tokenHash: v.string(),
    prefix: v.string(),
    scopes: v.array(v.union(v.literal("read"), v.literal("write"))),
    createdAt: v.number(),
    expiresAt: v.number(),
    revokedAt: v.optional(v.number()),
    lastUsedAt: v.optional(v.number()),
  })
    .index("by_hash", ["tokenHash"])
    .index("by_repository", ["repositoryId"])
    .index("by_repository_and_revoked", ["repositoryId", "revokedAt"]),
  // A user's own AI provider key, encrypted at rest. Generation for the
  // repositories the user owns runs on these keys instead of Gitdog's.
  providerApiKeys: defineTable({
    userId: v.id("users"),
    provider: v.union(v.literal("anthropic"), v.literal("openai")),
    ciphertext: v.string(),
    iv: v.string(),
    encryptionKeyId: v.string(),
    last4: v.string(),
    status: v.union(
      v.literal("active"),
      v.literal("invalid"),
      v.literal("out_of_credit"),
    ),
    lastValidatedAt: v.number(),
    // Set when this key failed to decrypt (the owner is told once); cleared
    // when the key is saved or checked again.
    unreadableAt: v.optional(v.number()),
    lastError: v.optional(
      v.object({
        code: v.union(
          v.literal("invalid"),
          v.literal("out_of_credit"),
          v.literal("rate_limited"),
          v.literal("provider_error"),
        ),
        httpStatus: v.optional(v.number()),
        at: v.number(),
      }),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_user_and_provider", ["userId", "provider"]),
  // The id of the encryption key provider keys were first saved with. An
  // environment key with another id is a server misconfiguration, not a
  // problem with users' keys.
  providerKeyEncryptionState: defineTable({
    expectedKeyId: v.string(),
    createdAt: v.number(),
  }),
  // One row per user that ever received the sign-in trial credit. It is
  // never deleted, so the trial cannot be granted twice.
  trialCreditGrants: defineTable({
    userId: v.id("users"),
    tokens: v.number(),
    grantedAt: v.number(),
  }).index("by_user", ["userId"]),
  // Provider key validation requests per user, kept apart from the key rows
  // so the limit also applies before a key is saved.
  providerKeyValidationAttempts: defineTable({
    userId: v.id("users"),
    attemptedAt: v.number(),
  }).index("by_user_and_attempted_at", ["userId", "attemptedAt"]),
  // ============================================
  // USER PROFILE
  // ============================================
  userProfiles: defineTable({
    userId: v.id("users"),
    displayName: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),
    bio: v.optional(v.string()),
    githubUsername: v.string(),
    website: v.optional(v.string()),
    twitter: v.optional(v.string()),
    locale: v.optional(
      v.union(v.literal("en"), v.literal("ko"), v.literal("ja")),
    ),
    theme: v.optional(v.union(v.literal("light"), v.literal("dark"))),
    isAdmin: v.optional(v.boolean()),
    minimumAgeAttestedAt: v.optional(v.number()),
    professionalUseAttestedAt: v.optional(v.number()),
    termsAcceptedVersion: v.optional(v.string()),
    privacyPolicyAcceptedVersion: v.optional(v.string()),
    lastLoginAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_github", ["githubUsername"]),

  // ============================================
  // SUBSCRIPTIONS
  // ============================================
  subscriptions: defineTable({
    userId: v.id("users"),

    // Lemon Squeezy integration
    lemonSqueezySubscriptionId: v.optional(v.string()),
    lemonSqueezyCustomerId: v.optional(v.string()),
    lemonSqueezyVariantId: v.optional(v.string()),
    providerCreatedAt: v.optional(v.number()),
    providerUpdatedAt: v.optional(v.number()),
    billingBoundaryReconciliationRequired: v.optional(v.boolean()),
    billingBoundaryManualReviewReason: v.optional(v.string()),
    proEntitlementProvenance: v.optional(
      v.object({
        source: v.union(
          v.literal("lemon_squeezy_webhook"),
          v.literal("admin_override"),
        ),
        verifiedAt: v.number(),
      }),
    ),

    plan: v.union(v.literal("free"), v.literal("pro")),
    status: v.union(
      v.literal("active"),
      v.literal("canceled"),
      v.literal("expired"),
    ),

    // Token limits per plan
    // Free: none from December 2026 (100k/month before); Pro: 2.4M per
    // billing period. Both may use prepaid packs and the one-time trial.
    includedTokens: v.number(),

    // Purchased token balance (for token pack purchases)
    purchasedTokens: v.number(),
    // Part of purchasedTokens that is the unspent one-time trial. Spent
    // before paid tokens and never taken back by a token-pack refund.
    trialTokens: v.optional(v.number()),

    // Internal service-cost allocation rate (25% free, 18% Pro)
    serviceFeeRate: v.number(), // 0.25 or 0.18

    periodStart: v.number(),
    periodEnd: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_provenance_status_and_period_end", [
      "userId",
      "proEntitlementProvenance.source",
      "status",
      "periodEnd",
    ])
    .index("by_lemon_squeezy_subscription_and_provenance_source", [
      "lemonSqueezySubscriptionId",
      "proEntitlementProvenance.source",
    ]),

  // Exact provider billing periods are queued separately from the latest
  // subscription snapshot so invoices can settle in chronological order.
  subscriptionBillingBoundaries: defineTable({
    subscriptionId: v.id("subscriptions"),
    periodStart: v.number(),
    periodEnd: v.number(),
    providerUpdatedAt: v.number(),
    status: v.union(
      v.literal("pending"),
      v.literal("settled"),
      v.literal("manual_review"),
    ),
    settledInvoiceCreatedAt: v.optional(v.number()),
    settlementReason: v.optional(
      v.union(v.literal("renewal_invoice"), v.literal("terminal_entitlement")),
    ),
    purchasedTokensDebited: v.optional(v.number()),
    manualReviewReason: v.optional(v.string()),
    manualReviewInvoiceId: v.optional(v.string()),
    manualReviewSettlementKeyFingerprint: v.optional(v.string()),
    manualReviewIdentityFingerprint: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_subscription_and_period_end", ["subscriptionId", "periodEnd"])
    .index("by_subscription_status_and_period_end", [
      "subscriptionId",
      "status",
      "periodEnd",
    ]),

  // Paid invoice events are acknowledged only after this normalized work item
  // and its initial scheduled worker are committed atomically.
  lemonSqueezyInvoiceInbox: defineTable({
    settlementKeyFingerprint: v.string(),
    identityFingerprint: v.string(),
    fingerprintVersion: v.literal(1),
    eventName: v.union(
      v.literal("subscription_payment_success"),
      v.literal("subscription_payment_recovered"),
    ),
    invoiceId: v.string(),
    subscriptionId: v.string(),
    customerId: v.string(),
    billingReason: v.union(
      v.literal("initial"),
      v.literal("renewal"),
      v.literal("updated"),
    ),
    invoiceCreatedAt: v.number(),
    invoiceUpdatedAt: v.number(),
    amountCents: v.number(),
    currency: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("processing"),
      v.literal("manual_review"),
    ),
    attemptCount: v.number(),
    nextAttemptAt: v.number(),
    leaseToken: v.optional(v.string()),
    lastError: v.optional(v.string()),
    expiresAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_settlement_key_fingerprint", ["settlementKeyFingerprint"])
    .index("by_status_and_next_attempt", ["status", "nextAttemptAt"])
    .index("by_status_and_expiration", ["status", "expiresAt"]),

  // ============================================
  // TOKEN USAGE TRACKING
  // ============================================
  tokenUsage: defineTable({
    userId: v.id("users"),
    ticketActionId: v.optional(v.id("ticketActions")), // Reference to the action that used tokens
    repositoryId: v.optional(v.id("repositories")),

    // Usage type: "chat" for AI generation, "embedding" for AI embeddings
    usageType: v.union(v.literal("chat"), v.literal("embedding")),

    // Token counts
    inputTokens: v.number(),
    outputTokens: v.number(),
    totalTokens: v.number(),
    embeddingTokens: v.optional(v.number()),
    embeddingBillingTier: v.optional(
      v.union(v.literal("free"), v.literal("paid")),
    ),
    embeddingReservationKey: v.optional(v.string()),
    embeddingReservationAttemptToken: v.optional(v.string()),
    chatReservationKey: v.optional(v.string()),
    chatReservationAttemptToken: v.optional(v.string()),
    providerRequestId: v.optional(v.string()),
    // Set when the call ran on the user's own provider key. Such rows never
    // count toward Gitdog quota or hourly totals.
    keySource: v.optional(v.literal("user")),
    // Amount atomically removed from the durable purchased-token wallet by
    // this write. Current-period quota checks add it back to reconstruct the
    // period's original capacity without refilling the lifetime balance.
    purchasedTokensDebited: v.number(),

    // Cost calculation (in USD cents for precision)
    inputCostCents: v.number(), // Input tokens cost
    outputCostCents: v.number(), // Output tokens cost
    baseCostCents: v.number(), // Total base cost (input + output)
    serviceFeeCents: v.number(), // Service fee amount
    totalCostCents: v.number(), // Total cost including service fee

    // Metadata
    model: v.string(), // Chat or embedding model identifier
    provider: v.union(
      v.literal("google"),
      v.literal("anthropic"),
      v.literal("openai"),
    ),
    serviceFeeRate: v.number(), // 0.25 or 0.18

    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_and_month", ["userId", "createdAt"])
    .index("by_user_key_source_and_created_at", [
      "userId",
      "keySource",
      "createdAt",
    ])
    .index("by_ticket_action", ["ticketActionId"])
    .index("by_repository", ["repositoryId"])
    .index("by_embedding_reservation", ["embeddingReservationKey"])
    .index("by_chat_reservation", ["chatReservationKey"]),

  // Per-user sums of tokenUsage rows grouped by the UTC hour of createdAt.
  // Written in the same transaction as each usage row so quota checks read a
  // bounded number of small documents instead of every row in the period.
  tokenUsageHourlyTotals: defineTable({
    userId: v.id("users"),
    hourStart: v.number(),
    rowCount: v.number(),
    totalTokens: v.number(),
    purchasedTokensDebited: v.number(),
    totalCostCents: v.number(),
    serviceFeeCents: v.number(),
    updatedAt: v.number(),
  }).index("by_user_and_hour", ["userId", "hourStart"]),

  // Present once every usage row of the user is covered by hourly totals.
  // Users without this row keep reading the raw usage rows.
  tokenUsageTotalsStates: defineTable({
    userId: v.id("users"),
    readyAt: v.number(),
  }).index("by_user", ["userId"]),

  // Durable quota reservations held before a paid AI provider request.
  embeddingUsageReservations: defineTable({
    reservationKey: v.string(),
    attemptToken: v.string(),
    userId: v.id("users"),
    repositoryId: v.id("repositories"),
    operation: v.string(),
    provider: v.optional(v.union(v.literal("google"), v.literal("openai"))),
    model: v.optional(v.string()),
    inputCount: v.number(),
    providerTokenLimit: v.number(),
    reservedTokens: v.number(),
    subscriptionId: v.optional(v.id("subscriptions")),
    entitlementPlan: v.union(v.literal("free"), v.literal("pro")),
    includedTokens: v.number(),
    serviceFeeRate: v.number(),
    quotaPeriodStart: v.number(),
    quotaPeriodEnd: v.number(),
    status: v.union(
      v.literal("pending"),
      v.literal("finalized"),
      v.literal("released"),
      v.literal("ambiguous"),
    ),
    usageId: v.optional(v.id("tokenUsage")),
    releaseReason: v.optional(v.string()),
    providerStartedAt: v.optional(v.number()),
    settlementState: v.optional(v.literal("staged")),
    settlementTokens: v.optional(v.number()),
    settlementStagedAt: v.optional(v.number()),
    settlementNextRecoveryAt: v.optional(v.number()),
    settlementScheduleId: v.optional(v.id("_scheduled_functions")),
    reconciliation: v.optional(
      v.object({
        outcome: v.union(
          v.literal("known_billed"),
          v.literal("known_not_billed"),
        ),
        evidenceSource: v.union(
          v.literal("google_api_response"),
          v.literal("google_cloud_billing_export"),
          v.literal("google_support_confirmation"),
          v.literal("openai_api_response"),
          v.literal("openai_billing_export"),
          v.literal("openai_support_confirmation"),
        ),
        evidenceReference: v.string(),
        actualProviderTokens: v.optional(v.number()),
        reconciledBy: v.id("users"),
        reconciledAt: v.number(),
      }),
    ),
    expiresAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_reservation_key", ["reservationKey"])
    .index("by_user_and_status", ["userId", "status"])
    .index("by_user_status_and_created_at", ["userId", "status", "createdAt"])
    .index("by_user_status_and_release_reason", [
      "userId",
      "status",
      "releaseReason",
    ])
    .index("by_user_status_release_reason_and_provider_started_at", [
      "userId",
      "status",
      "releaseReason",
      "providerStartedAt",
    ])
    .index("by_user_status_and_expiration", ["userId", "status", "expiresAt"])
    .index("by_user_status_settlement_and_expiration", [
      "userId",
      "status",
      "settlementState",
      "expiresAt",
    ])
    .index("by_user_status_and_provider_started_at", [
      "userId",
      "status",
      "providerStartedAt",
    ])
    .index("by_subscription_status_and_period_start", [
      "subscriptionId",
      "status",
      "quotaPeriodStart",
    ])
    .index("by_status_and_expiration", ["status", "expiresAt"])
    .index("by_status_settlement_and_expiration", [
      "status",
      "settlementState",
      "expiresAt",
    ])
    .index("by_settlement_state_and_recovery", [
      "settlementState",
      "settlementNextRecoveryAt",
    ]),

  // One durable hold per AI provider call. Every successful response is
  // finalized into exactly one tokenUsage row before downstream publication.
  chatUsageReservations: defineTable({
    reservationKey: v.string(),
    attemptToken: v.string(),
    userId: v.id("users"),
    repositoryId: v.id("repositories"),
    ticketActionId: v.id("ticketActions"),
    requirePendingTicketAction: v.boolean(),
    ticketActionProposalVersion: v.number(),
    generationKey: v.string(),
    operation: v.string(),
    model: v.string(),
    provider: v.optional(
      v.union(v.literal("google"), v.literal("anthropic"), v.literal("openai")),
    ),
    requestFingerprint: v.string(),
    keySource: v.optional(v.literal("user")),
    inputTokenLimit: v.number(),
    outputTokenLimit: v.number(),
    reservedTokens: v.number(),
    subscriptionId: v.optional(v.id("subscriptions")),
    entitlementPlan: v.union(v.literal("free"), v.literal("pro")),
    includedTokens: v.number(),
    serviceFeeRate: v.number(),
    quotaPeriodStart: v.number(),
    quotaPeriodEnd: v.number(),
    status: v.union(
      v.literal("pending"),
      v.literal("finalized"),
      v.literal("released"),
      v.literal("ambiguous"),
    ),
    usageId: v.optional(v.id("tokenUsage")),
    releaseReason: v.optional(v.string()),
    providerStartedAt: v.optional(v.number()),
    providerRequestId: v.optional(v.string()),
    settlementState: v.optional(v.literal("staged")),
    settlementOutcome: v.optional(
      v.union(
        v.object({
          kind: v.literal("known_billed"),
          inputTokens: v.number(),
          outputTokens: v.number(),
          providerRequestId: v.optional(v.string()),
        }),
        v.object({
          kind: v.literal("known_not_billed"),
          providerRequestId: v.optional(v.string()),
        }),
      ),
    ),
    settlementStagedAt: v.optional(v.number()),
    settlementNextRecoveryAt: v.optional(v.number()),
    settlementScheduleId: v.optional(v.id("_scheduled_functions")),
    resultCheckpointJson: v.optional(v.string()),
    resultCheckpointedAt: v.optional(v.number()),
    recoveryTarget: v.optional(chatRecoveryTargetValidator),
    reconciliation: v.optional(
      v.object({
        outcome: v.union(
          v.literal("known_billed"),
          v.literal("known_not_billed"),
        ),
        evidenceSource: v.union(
          v.literal("google_api_response"),
          v.literal("google_cloud_billing_export"),
          v.literal("google_support_confirmation"),
          v.literal("anthropic_api_response"),
          v.literal("anthropic_usage_report"),
          v.literal("anthropic_support_confirmation"),
          v.literal("openai_api_response"),
          v.literal("openai_usage_report"),
          v.literal("openai_support_confirmation"),
        ),
        evidenceReference: v.string(),
        actualInputTokens: v.optional(v.number()),
        actualOutputTokens: v.optional(v.number()),
        reconciledBy: v.id("users"),
        reconciledAt: v.number(),
      }),
    ),
    expiresAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_reservation_key", ["reservationKey"])
    .index("by_user_and_status", ["userId", "status"])
    .index("by_user_status_and_created_at", ["userId", "status", "createdAt"])
    .index("by_user_status_and_expiration", ["userId", "status", "expiresAt"])
    .index("by_user_status_settlement_and_expiration", [
      "userId",
      "status",
      "settlementState",
      "expiresAt",
    ])
    .index("by_user_status_and_provider_started_at", [
      "userId",
      "status",
      "providerStartedAt",
    ])
    .index("by_user_key_source_and_status", ["userId", "keySource", "status"])
    .index("by_user_key_source_status_and_expiration", [
      "userId",
      "keySource",
      "status",
      "expiresAt",
    ])
    .index("by_user_key_source_status_settlement_and_expiration", [
      "userId",
      "keySource",
      "status",
      "settlementState",
      "expiresAt",
    ])
    .index("by_user_key_source_status_and_provider_started_at", [
      "userId",
      "keySource",
      "status",
      "providerStartedAt",
    ])
    .index("by_key_source_status_and_expiration", [
      "keySource",
      "status",
      "expiresAt",
    ])
    .index("by_subscription_status_and_period_start", [
      "subscriptionId",
      "status",
      "quotaPeriodStart",
    ])
    .index("by_subscription_status_and_period_end", [
      "subscriptionId",
      "status",
      "quotaPeriodEnd",
    ])
    .index("by_status_and_expiration", ["status", "expiresAt"])
    .index("by_status_settlement_and_expiration", [
      "status",
      "settlementState",
      "expiresAt",
    ])
    .index("by_settlement_state_and_recovery", [
      "settlementState",
      "settlementNextRecoveryAt",
    ]),

  // ============================================
  // REPOSITORIES
  // ============================================
  repositories: defineTable({
    userId: v.id("users"),
    installationId: v.number(),
    // Immutable GitHub repository database ID.
    githubRepositoryId: v.number(),
    githubRepo: v.string(), // owner/repo format
    // Case-insensitive GitHub full-name key.
    githubRepoKey: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    githubUrl: v.string(),
    language: v.optional(v.string()),
    stars: v.optional(v.number()),
    githubVisibility: v.optional(
      v.union(v.literal("public"), v.literal("private"), v.literal("internal")),
    ),
    licenseKey: v.optional(v.string()),
    licenseSpdxId: v.optional(v.string()),
    licenseOsiApproved: v.optional(v.boolean()),
    licenseOsiCheckedAt: v.optional(v.number()),
    repositoryMetadataCheckedAt: v.optional(v.number()),
    githubMetadataRevision: v.optional(v.number()),
    isActive: v.boolean(),
    // Access revocation is separate from the user's desired active state so a
    // reinstall never turns a manually paused repository back on.
    githubAccessRevokedAt: v.optional(v.number()),
    isActiveBeforeAccessRevocation: v.optional(v.boolean()),
    // A missing installation row can only be repaired by an owner selecting
    // this exact immutable GitHub repository through a newly verified app
    // installation.
    githubInstallationReconnectRequired: v.optional(v.boolean()),
    githubAccessRestoreIndexPending: v.optional(v.boolean()),
    githubAccessRestoreIndexNextAttemptAt: v.optional(v.number()),
    githubAccessRestoreIndexRetryCount: v.optional(v.number()),
    // Marks repositories observed by one authoritative, paginated GitHub
    // installation reconciliation. Older epochs are safe to retain.
    githubAccessReconciliationEpoch: v.optional(v.number()),
    githubAccessReconciliationRevision: v.optional(v.number()),

    // Repository indexing (for code structure analysis)
    defaultBranch: v.optional(v.string()),
    indexVersion: v.number(), // Incremental version for tracking changes
    indexSource: v.optional(
      v.object({
        indexVersion: v.number(),
        commitSha: v.string(),
        defaultBranch: v.string(),
      }),
    ),
    indexSyncPendingSource: v.optional(
      v.object({ commitSha: v.string(), defaultBranch: v.string() }),
    ),
    indexStatus: v.union(
      v.literal("pending"),
      v.literal("indexing"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    indexError: v.optional(v.string()),
    lastIndexedAt: v.optional(v.number()),
    indexProgressAt: v.number(),
    indexWatchdogToken: v.optional(v.string()),
    indexWatchdogScheduleId: v.optional(v.id("_scheduled_functions")),
    indexWatchdogSequence: v.optional(v.number()),
    indexWatchdogRetryCount: v.optional(v.number()),
    // One immutable identity attestation is reused by the exact indexing
    // generation. A rename/transfer clears it before another page can run.
    indexIdentityVerifiedVersion: v.optional(v.number()),
    indexIdentityVerifiedInstallationId: v.optional(v.number()),
    indexIdentityVerifiedGithubRepositoryId: v.optional(v.number()),
    indexIdentityVerifiedGithubRepo: v.optional(v.string()),
    // GitHub primary-rate-limit retries are durable scheduled continuations.
    indexRateLimitRetryToken: v.optional(v.string()),
    indexRateLimitRetryAt: v.optional(v.number()),
    indexTreeSnapshotId: v.optional(v.id("repoTreeSnapshots")),
    ragStatus: v.union(
      v.literal("pending"),
      v.literal("indexing"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    ragError: v.optional(v.string()),
    ragLegalEligibilityBlockedAt: v.optional(v.number()),
    ragLegalEligibilityBlockedIndexVersion: v.optional(v.number()),
    ragLastIndexedAt: v.optional(v.number()),
    ragTotalChunks: v.number(),
    ragIndexedChunks: v.number(),
    ragFailedChunks: v.number(),
    ragEmbeddingMode: v.optional(
      v.union(v.literal("openai"), v.literal("keyword_only")),
    ),
    ragEmbeddingBillingTier: v.optional(
      v.union(v.literal("free"), v.literal("paid")),
    ),
    ragEmbeddingKey: v.optional(v.string()),
    ragEmbeddingError: v.optional(v.string()),
    ragIndexPhase: v.optional(
      v.union(v.literal("files"), v.literal("cleanup")),
    ),
    ragIndexCursor: v.optional(v.string()),
    ragIndexFileOffset: v.optional(v.number()),
    ragIndexChunkOffset: v.optional(v.number()),
    ragContinuationToken: v.optional(v.string()),
    ragProcessedFiles: v.optional(v.number()),
    indexSyncPending: v.boolean(), // Coalesce pushes received during file/RAG indexing

    // Repository disconnect is a durable bounded cleanup workflow. The row is
    // retained until every phase has completed so a lost scheduled mutation can
    // be recovered safely by cron.
    disconnectCleanupPending: v.optional(v.boolean()),
    disconnectCleanupPhase: v.optional(
      v.union(
        v.literal("tree"),
        v.literal("chunks"),
        v.literal("file_maps"),
        v.literal("logs"),
        v.literal("learnings"),
        v.literal("embedding_batches"),
        v.literal("members"),
        v.literal("invitations"),
        v.literal("api_keys"),
        v.literal("tickets"),
        v.literal("history"),
        v.literal("notifications"),
        v.literal("finalize"),
      ),
    ),

    // Issue Assistant settings (simplified)
    settings: v.object({
      // Issue Assistant features
      issueAssistantEnabled: v.boolean(), // Master toggle
      autoFormatIssue: v.boolean(), // Auto-format poorly written issues
      autoAnswerQuestions: v.boolean(), // Answer questions based on codebase
      tagMaintainersForCodeChanges: v.boolean(), // Tag maintainers when code changes needed

      // Discussion Assistant features
      discussionAssistantEnabled: v.boolean(), // Master toggle for discussions
      autoFormatDiscussion: v.boolean(), // Auto-format poorly written discussions
      autoAnswerDiscussionQuestions: v.boolean(), // Answer questions in discussions
      tagMaintainersForDiscussionCodeChanges: v.boolean(), // Tag maintainers in discussions

      // Safety options
      requireApproval: v.boolean(), // Require approval before posting to GitHub (for issues)
      requireApprovalForDiscussions: v.boolean(), // Require approval for discussions

      // Pull request reviews are opt-in for existing repositories.
      pullRequestReviewsEnabled: v.optional(v.boolean()),
      pullRequestSuggestionsEnabled: v.optional(v.boolean()),
      requireApprovalForPullRequests: v.optional(v.boolean()),

      // Response style customization
      issueResponseStyle: v.optional(v.string()), // Custom system prompt for issue responses
      discussionResponseStyle: v.optional(v.string()), // Custom system prompt for discussion responses
    }),

    // Usage tracking
    monthlyActions: v.number(),
    lastResetAt: v.number(),

    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_github_repo_key", ["githubRepoKey"])
    .index("by_user_and_repo_key", ["userId", "githubRepoKey"])
    .index("by_github_repository_id", ["githubRepositoryId"])
    .index("by_user_and_github_repository_id", ["userId", "githubRepositoryId"])
    .index("by_installation", ["installationId"])
    .index("by_installation_and_github_repository_id", [
      "installationId",
      "githubRepositoryId",
    ])
    .index("by_active", ["isActive"])
    .index("by_user_and_rag_legal_eligibility_blocked", [
      "userId",
      "ragLegalEligibilityBlockedAt",
    ])
    .index("by_access_restore_index_retry", [
      "githubAccessRestoreIndexPending",
      "githubAccessRestoreIndexNextAttemptAt",
    ])
    .index("by_disconnect_cleanup_pending_and_updated_at", [
      "disconnectCleanupPending",
      "updatedAt",
    ])
    .index("by_index_status", ["indexStatus"]),

  // ============================================
  // TICKETS (one per issue or discussion lifecycle)
  // ============================================
  tickets: defineTable({
    repositoryId: v.optional(v.id("repositories")), // Optional to preserve history after disconnect
    userId: v.id("users"),
    githubRepo: v.string(), // owner/repo format - preserved after disconnect

    // Ticket type
    ticketType: v.union(
      v.literal("pull_request"),
      v.literal("issue"), // GitHub issue
      v.literal("discussion"), // GitHub discussion
    ),

    pullRequestHeadSha: v.optional(v.string()),
    pullRequestBaseSha: v.optional(v.string()),
    pullRequestObservedAt: v.optional(v.number()),

    // GitHub reference
    githubNumber: v.number(), // Issue or discussion number
    githubTitle: v.string(), // Issue or discussion title at creation
    githubBody: v.optional(v.string()), // Issue or discussion body at creation
    githubAuthor: v.optional(v.string()), // GitHub username of the author
    aiInputVersion: v.number(), // Monotonic title/body epoch for AI generations

    // Ticket status
    status: v.union(
      v.literal("open"), // Ticket is open, actions can be added
      v.literal("closed"), // Ticket is closed
    ),
    // GitHub's resource revision makes signed lifecycle webhooks monotonic.
    // The attestation timestamp breaks same-revision ties after a live read.
    githubStateUpdatedAt: v.optional(v.number()),
    githubStateAttestedAt: v.optional(v.number()),
    // A signed lifecycle webhook can arrive before the corresponding create
    // job. Keep that state hidden until title/body metadata arrives.
    githubLifecycleOnly: v.optional(v.boolean()),
    // Full metadata can arrive while the resource is closed or while a live
    // state tie-break is pending. Preserve the unscheduled initial AI job until
    // the first authoritative open state claims it.
    githubInitialProcessingPending: v.optional(v.boolean()),
    githubInitialProcessingGeneration: v.optional(v.number()),
    githubInitialProcessingAiInputVersion: v.optional(v.number()),
    githubInitialProcessingExpiresAt: v.optional(v.number()),
    githubInitialProcessingLeaseUntil: v.optional(v.number()),
    githubInitialProcessingScheduleId: v.optional(v.id("_scheduled_functions")),
    githubStateAttestationPending: v.optional(v.boolean()),
    // Timestamps
    createdAt: v.number(),
    closedAt: v.optional(v.number()),
    deletedAt: v.optional(v.number()), // Soft delete timestamp
  })
    .index("by_repository", ["repositoryId"])
    .index("by_user", ["userId"])
    .index("by_github_repo", ["githubRepo"])
    .index("by_user_and_repo", ["userId", "githubRepo"])
    .index("by_status", ["status"])
    .index("by_created", ["createdAt"])
    .index("by_github_number", ["repositoryId", "githubNumber"])
    .index("by_initial_processing_expiration", [
      "githubInitialProcessingPending",
      "githubInitialProcessingExpiresAt",
    ])
    .index("by_initial_processing_lease", [
      "githubInitialProcessingPending",
      "githubInitialProcessingLeaseUntil",
    ])
    .index("by_github_repo_and_number", ["githubRepo", "githubNumber"]),

  // Live GitHub state tie-breaks are durable even when the corresponding
  // ticket row has not been created yet.
  ticketStateAttestationJobs: defineTable({
    installationId: v.number(),
    githubRepositoryId: v.number(),
    repositoryFullName: v.string(),
    githubNumber: v.number(),
    ticketType: v.union(v.literal("issue"), v.literal("discussion")),
    generation: v.number(),
    status: v.union(
      v.literal("pending"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    retryCount: v.number(),
    resumeInitialProcessing: v.boolean(),
    nextAttemptAt: v.number(),
    expiresAt: v.number(),
    scheduleId: v.optional(v.id("_scheduled_functions")),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_target", [
      "installationId",
      "githubRepositoryId",
      "ticketType",
      "githubNumber",
    ])
    .index("by_status_and_next_attempt", ["status", "nextAttemptAt"])
    .index("by_status_and_expiration", ["status", "expiresAt"]),

  // ============================================
  // TICKET ACTIONS (individual AI actions within a ticket)
  // ============================================
  ticketActions: defineTable({
    ticketId: v.id("tickets"), // Parent ticket
    reviewGenerationToken: v.optional(v.string()),
    // Tokens a batched review still expects to spend, held against the
    // account so concurrent batched reviews cannot overcommit the quota.
    reviewQuotaUserId: v.optional(v.id("users")),
    reviewQuotaHold: v.optional(v.number()),
    // Set once the action has run on the owner's own provider key, so
    // retries never finish it on Gitdog's key.
    aiKeySource: v.optional(v.literal("user")),
    reviewBatch: v.optional(
      v.object({
        page: v.number(),
        group: v.optional(v.number()),
        claimed: v.boolean(),
        result: reviewBatchResultValidator,
      }),
    ),
    reviewVerificationOnly: v.optional(v.boolean()),
    reviewRecheckOfActionId: v.optional(v.id("ticketActions")),
    sourceCommentId: v.optional(v.number()), // GitHub comment delivery id for follow-up idempotency
    requestedByUserId: v.optional(v.id("users")), // Direct GitHub requester when the action was user-initiated

    // Action type
    actionType: v.union(
      v.literal("review"),
      v.literal("format"), // Format/improve an issue title and body
      v.literal("answer"), // Answer questions
      v.literal("tag_maintainers"), // Tag maintainers for code changes
      v.literal("follow_up"), // Follow-up conversation
    ),

    // Chat history for this action
    chatHistory: v.array(
      v.object({
        role: v.union(v.literal("user"), v.literal("assistant")),
        content: v.string(),
        timestamp: v.number(),
      }),
    ),

    // Proposed changes (what AI wants to do)
    proposedChanges: v.optional(v.any()),
    proposalVersion: v.number(), // CAS token for execution vs. regeneration
    // For format: { originalTitle, suggestedTitle, originalBody, suggestedBody, changesSummary }
    // For answer: { comment, reasoning }
    // For tag_maintainers: { comment, maintainers }

    // Action status
    status: v.union(
      v.literal("pending"), // AI is processing
      v.literal("pending_approval"), // Waiting for user to approve/reject
      v.literal("approved"), // User approved, executing
      v.literal("rejected"), // User rejected
      v.literal("completed"), // Successfully executed
      v.literal("failed"), // Execution failed
    ),

    // User feedback (for request changes)
    userFeedback: v.optional(v.string()),

    // Execution result
    executionResult: v.optional(v.any()), // { githubCommentId, etc. }
    executionClaimedAt: v.optional(v.number()), // Prevent duplicate external GitHub writes
    publicationRefreshCount: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
    reviewFailureDetails: v.optional(v.string()),
    resultCheckpointKey: v.optional(v.string()),
    resultCheckpointExpiresAt: v.optional(v.number()),
    resultRecoveryLeaseUntil: v.optional(v.number()),
    resultRecoveryScheduleId: v.optional(v.id("_scheduled_functions")),
    pendingGenerationTarget: v.optional(chatRecoveryTargetValidator),
    pendingGenerationExpiresAt: v.optional(v.number()),
    pendingGenerationScheduleId: v.optional(v.id("_scheduled_functions")),
    pendingGenerationLeaseUntil: v.optional(v.number()),
    providerRetryStartedAt: v.optional(v.number()),
    autoExecutionRecoveryExpiresAt: v.optional(v.number()),
    autoExecutionRecoveryLeaseUntil: v.optional(v.number()),
    autoExecutionRecoveryScheduleId: v.optional(v.id("_scheduled_functions")),
    executionIdempotencyKey: v.optional(v.string()),
    executionRecoveryMode: v.optional(
      v.union(v.literal("manual_approval"), v.literal("auto_approved")),
    ),
    executionRecoveryReconcileOnly: v.optional(v.boolean()),
    executionRecoveryReconcileDeadlineAt: v.optional(v.number()),
    executionRecoveryExpiresAt: v.optional(v.number()),
    executionRecoveryLeaseUntil: v.optional(v.number()),
    executionRecoveryScheduleId: v.optional(v.id("_scheduled_functions")),

    // Timestamps
    createdAt: v.number(),
    approvedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
  })
    .index("by_ticket", ["ticketId"])
    .index("by_ticket_and_source_comment", ["ticketId", "sourceCommentId"])
    .index("by_review_quota_user", ["reviewQuotaUserId"])
    .index("by_ticket_and_status", ["ticketId", "status"])
    .index("by_execution_idempotency_key", ["executionIdempotencyKey"])
    .index("by_status_and_checkpoint_expiration", [
      "status",
      "resultCheckpointExpiresAt",
    ])
    .index("by_status_and_pending_expiration", [
      "status",
      "pendingGenerationExpiresAt",
    ])
    .index("by_status_and_pending_lease", [
      "status",
      "pendingGenerationLeaseUntil",
    ])
    .index("by_status_and_auto_execution_expiration", [
      "status",
      "autoExecutionRecoveryExpiresAt",
    ])
    .index("by_status_and_auto_execution_lease", [
      "status",
      "autoExecutionRecoveryLeaseUntil",
    ])
    .index("by_status_and_execution_recovery_expiration", [
      "status",
      "executionRecoveryExpiresAt",
    ])
    .index("by_status_and_execution_recovery_lease", [
      "status",
      "executionRecoveryLeaseUntil",
    ])
    .index("by_created", ["createdAt"]),

  // ============================================
  // GITHUB APP INSTALLATIONS
  // ============================================
  githubOAuthInstallationAttestations: defineTable({
    userId: v.id("users"),
    githubAccountId: v.string(),
    installationIds: v.array(v.number()),
    attestedAt: v.number(),
    expiresAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_github_account", ["githubAccountId"]),

  githubInstallations: defineTable({
    userId: v.id("users"),
    installationId: v.number(),
    // GitHub establishes ownership through a signed webhook or a fresh OAuth
    // user-installation association attestation.
    ownerGithubAccountId: v.string(),
    ownershipVerifiedAt: v.number(),
    accessSuspendedAt: v.optional(v.number()),
    webhookAccessStateAttestationGeneration: v.optional(v.number()),
    webhookAccessStateAttestationFailure: v.optional(
      v.union(v.literal("configuration"), v.literal("github_request")),
    ),
    webhookAccessStateAttestationFailedAt: v.optional(v.number()),
    webhookAccessStateAttestationRetryCount: v.optional(v.number()),
    webhookAccessStateAttestationNextAttemptAt: v.optional(v.number()),
    repositoryAccessRemovalGeneration: v.optional(v.number()),
    repositoryAccessRemovalCursor: v.optional(v.union(v.string(), v.null())),
    repositoryAccessRemovalDeleteInstallation: v.optional(v.boolean()),
    repositoryAccessRemovalPhase: v.optional(v.literal("pausing")),
    repositoryRemovalPendingAt: v.optional(v.number()),
    repositoryAccessReconciliationEpoch: v.optional(v.number()),
    repositoryAccessReconciliationRevision: v.optional(v.number()),
    repositoryAccessReconciliationNextPage: v.optional(v.number()),
    repositoryAccessReconciliationRetryCount: v.optional(v.number()),
    repositoryAccessReconciliationNextAttemptAt: v.optional(v.number()),
    repositoryAccessReconciliationExpectedSuspendedAt: v.optional(
      v.union(v.number(), v.null()),
    ),
    repositoryAccessReconciliationPhase: v.optional(
      v.union(v.literal("fetching"), v.literal("finalizing")),
    ),
    repositoryAccessReconciliationFailure: v.optional(
      v.union(
        v.literal("configuration"),
        v.literal("authorization"),
        v.literal("network"),
        v.literal("github_request"),
        v.literal("invalid_response"),
        v.literal("internal"),
      ),
    ),
    repositoryAccessReconciliationFailedAt: v.optional(v.number()),
    accountLogin: v.string(),
    accountType: v.string(),
    targetType: v.string(),
    permissions: v.optional(v.any()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_installation_id", ["installationId"])
    .index("by_user_and_installation", ["userId", "installationId"])
    .index("by_reconciliation_phase_and_updated_at", [
      "repositoryAccessReconciliationPhase",
      "updatedAt",
    ])
    .index("by_reconciliation_phase_and_next_attempt", [
      "repositoryAccessReconciliationPhase",
      "repositoryAccessReconciliationNextAttemptAt",
    ])
    .index("by_access_removal_phase_and_updated_at", [
      "repositoryAccessRemovalPhase",
      "updatedAt",
    ])
    .index("by_webhook_attestation_next_attempt", [
      "webhookAccessStateAttestationNextAttemptAt",
    ]),

  // One serialized logical clock gives cross-installation reconciliations a
  // total order even when multiple mutations share the same millisecond.
  githubRepositoryAccessReconciliationClock: defineTable({
    key: v.literal("global"),
    revision: v.number(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  // Durable, idempotent processing for large repositories_removed payloads.
  githubRepositoryRemovalJobs: defineTable({
    deliveryId: v.string(),
    installationId: v.number(),
    payloadStorageId: v.optional(v.id("_storage")),
    totalRepositories: v.number(),
    nextOffset: v.number(),
    status: v.union(v.literal("pending"), v.literal("completed")),
    retryCount: v.number(),
    nextAttemptAt: v.number(),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_delivery_id", ["deliveryId"])
    .index("by_installation_and_status", ["installationId", "status"])
    .index("by_status_and_next_attempt", ["status", "nextAttemptAt"]),

  // ============================================
  // REPOSITORY INDEXING (RAG)
  // ============================================
  // Code chunks: function/class-level chunks for RAG
  repoChunks: defineTable({
    repositoryId: v.id("repositories"),
    repositoryIndexKey: v.string(), // `${repositoryId}:${indexVersion}` for exact current-index search
    chunkId: v.string(), // hash(path#startLine#endLine)
    path: v.string(), // File path
    language: v.string(), // Language (ts, js, py, etc)

    // Code content
    code: v.string(), // Actual code snippet
    retrievalText: v.optional(v.string()), // Boundary-overlapped BM25/vector window
    startLine: v.number(),
    endLine: v.number(),

    // Metadata for search
    symbols: v.array(v.string()), // Function/class names in this chunk
    imports: v.optional(v.array(v.string())), // Imported modules
    exports: v.optional(v.array(v.string())), // Exported symbols
    signature: v.optional(v.string()), // Function/class signature
    docstring: v.optional(v.string()), // Doc comment

    // Search indexes. The embedding fields are retired: nothing writes them,
    // and they stay optional until purgeRetiredEmbeddings clears old rows.
    embedding: v.optional(v.array(v.number())),
    embeddingKey: v.optional(v.string()), // Provider/model/dimension/task identity
    embeddingInputMode: v.optional(
      v.union(v.literal("raw_v1"), v.literal("deidentified_v1")),
    ),
    embeddingScopeKey: v.optional(v.string()), // Repository generation + embedding identity
    embeddingLanguageScopeKey: v.optional(v.string()), // Repository generation + embedding identity + language
    searchableText: v.string(), // For BM25/keyword search: symbols + code
    contentHash: v.string(), // Hash of code content for incremental indexing

    indexVersion: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_repository", ["repositoryId"])
    .index("by_repository_content_hash_embedding_key", [
      "repositoryId",
      "contentHash",
      "embeddingKey",
      "chunkId",
    ])
    .index("by_index_version", ["repositoryId", "indexVersion"])
    .index("by_index_version_and_chunk", [
      "repositoryId",
      "indexVersion",
      "chunkId",
    ])
    .searchIndex("search_text", {
      searchField: "searchableText",
      filterFields: ["repositoryId", "repositoryIndexKey", "language"],
    }),

  // Retired embedding batch cache. Nothing writes it; existing rows are
  // removed by purgeRetiredEmbeddings and repository cleanup.
  ragEmbeddingBatches: defineTable({
    reservationKey: v.string(),
    repositoryId: v.id("repositories"),
    embeddingKey: v.string(),
    embeddings: v.array(v.array(v.float64())),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_reservation_key", ["reservationKey"])
    .index("by_repository", ["repositoryId"]),

  // File content cache (stores actual file contents for chunking)
  repoFileBlobs: defineTable({
    sha256: v.string(), // Hash of file content for deduplication
    storageId: v.id("_storage"), // Convex Files storage ID
    size: v.number(),
    createdAt: v.number(),
    lastAccessedAt: v.number(),
    accessCount: v.number(), // For LRU eviction
  })
    .index("by_sha256", ["sha256"])
    .index("by_storage_id", ["storageId"])
    .index("by_last_accessed", ["lastAccessedAt"])
    .index("by_access_count", ["accessCount"]),

  // File path to content mapping
  repoFileMap: defineTable({
    repositoryId: v.id("repositories"),
    filePath: v.string(),
    sha256: v.string(), // Reference to repoFileBlobs
    language: v.optional(v.string()),
    size: v.number(),
    isText: v.boolean(), // Whether file is text or binary
    indexVersion: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_repository", ["repositoryId"])
    .index("by_repository_and_path", ["repositoryId", "filePath"])
    .index("by_repository_version_and_path", [
      "repositoryId",
      "indexVersion",
      "filePath",
    ])
    .index("by_sha256", ["sha256"])
    .index("by_index_version", ["repositoryId", "indexVersion"]),

  // Durable, generation-scoped repository tree snapshots. A building manifest
  // is attached before bounded page writes so interrupted construction remains
  // discoverable by watchdog and cleanup jobs.
  repoTreeSnapshots: defineTable({
    repositoryId: v.id("repositories"),
    indexVersion: v.number(),
    defaultBranch: v.string(),
    commitSha: v.string(),
    treeSha: v.string(),
    totalFiles: v.number(),
    totalPages: v.number(),
    nextPageIndex: v.optional(v.number()),
    traversalState: v.optional(v.literal("traversing")),
    traversalRequestCount: v.optional(v.number()),
    traversalItemCount: v.optional(v.number()),
    // Mutation invariant: partial page only, always fewer than 40 entries.
    traversalPendingFiles: v.optional(
      v.array(
        v.object({
          path: v.string(),
          sha: v.string(),
          size: v.optional(v.number()),
        }),
      ),
    ),
    traversalClaimToken: v.optional(v.string()),
    traversalClaimedAt: v.optional(v.number()),
    status: v.union(
      v.literal("building"),
      v.literal("ready"),
      v.literal("deleting"),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_repository_and_version", ["repositoryId", "indexVersion"])
    .index("by_status_and_updated_at", ["status", "updatedAt"]),

  repoTreeSnapshotPages: defineTable({
    snapshotId: v.id("repoTreeSnapshots"),
    pageIndex: v.number(),
    files: v.array(
      v.object({
        path: v.string(),
        sha: v.string(),
        size: v.optional(v.number()),
      }),
    ),
    createdAt: v.number(),
  })
    .index("by_snapshot", ["snapshotId"])
    .index("by_snapshot_and_page", ["snapshotId", "pageIndex"]),

  repoTreeTraversalQueue: defineTable({
    snapshotId: v.id("repoTreeSnapshots"),
    identityKey: v.string(),
    sha: v.string(),
    prefix: v.string(),
    responseStorageId: v.optional(v.id("_storage")),
    itemOffset: v.number(),
    totalItems: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_snapshot", ["snapshotId"])
    .index("by_snapshot_and_identity", ["snapshotId", "identityKey"])
    .index("by_response_storage_id", ["responseStorageId"]),

  // Repository indexing logs (real-time progress updates)
  repoIndexingLogs: defineTable({
    repositoryId: v.id("repositories"),
    indexVersion: v.number(),
    level: v.union(
      v.literal("info"),
      v.literal("success"),
      v.literal("warning"),
      v.literal("error"),
    ),
    message: v.string(),
    metadata: v.optional(v.any()), // Additional context
    createdAt: v.number(),
  })
    .index("by_repository", ["repositoryId"])
    .index("by_repository_and_version", ["repositoryId", "indexVersion"])
    .index("by_created_at", ["repositoryId", "createdAt"]),

  // ============================================
  // REPOSITORY LEARNINGS (AI knowledge from user interactions)
  // ============================================
  repoLearnings: defineTable({
    repositoryId: v.id("repositories"),
    content: v.string(), // Extracted learning (summarized guideline)
    source: v.string(), // Source URL or context identifier
    idempotencyKey: v.optional(v.string()), // Stable identity for one learning-producing event
    sourceType: v.union(
      v.literal("comment"), // From GitHub comment interaction
      v.literal("link"), // From linked content (GitHub issue, discussion, etc.)
      v.literal("correction"), // From user feedback/correction
    ),
    isTrusted: v.boolean(), // Only verified repository authorities may influence responses
    repositoryTrustKey: v.optional(v.string()), // Denormalized vector-search trust scope
    embedding: v.optional(v.array(v.float64())), // Retired; cleared by purgeRetiredEmbeddings
    embeddingKey: v.optional(v.string()),
    embeddingScopeKey: v.optional(v.string()), // Trusted repository + embedding identity
    publicEmbeddingScopeKey: v.optional(v.string()), // Explicitly public GitHub learning vectors only
    embeddingDataProvenance: v.union(
      v.literal("public_github"),
      v.literal("private_user_input"),
    ),
    ticketId: v.optional(v.id("tickets")), // Related ticket if any
    createdAt: v.number(),
  })
    .index("by_repository", ["repositoryId"])
    .index("by_repository_and_idempotency", ["repositoryId", "idempotencyKey"])
    .index("by_repository_trust_key", ["repositoryTrustKey"])
    .index("by_repository_trust_and_embedding_scope", [
      "repositoryId",
      "repositoryTrustKey",
      "embeddingScopeKey",
    ])
    .index("by_repository_trust_and_public_embedding_scope", [
      "repositoryId",
      "repositoryTrustKey",
      "publicEmbeddingScopeKey",
    ])
    .index("by_source_type", ["repositoryId", "sourceType"])
    .searchIndex("search_text", {
      searchField: "content",
      filterFields: [
        "repositoryId",
        "repositoryTrustKey",
        "embeddingDataProvenance",
      ],
    }),

  // ============================================
  // PAYMENT STATS SUMMARY (All-time aggregates, updated incrementally)
  // ============================================
  paymentStatsSummary: defineTable({
    // Singleton pattern - only one row with key "global"
    key: v.literal("global"),

    // All-time totals
    totalRevenueCents: v.number(),
    totalTokensSold: v.number(),
    totalOrders: v.number(), // Successful orders count

    // Breakdown by product type
    proSubscriptionCount: v.number(),
    tokenPackSmallCount: v.number(),
    tokenPackLargeCount: v.number(),

    // Refunds
    totalRefundedCents: v.number(),
    totalRefundedTokens: v.number(),

    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  // ============================================
  // PAYMENT LOGS (Admin dashboard for payment tracking)
  // ============================================
  paymentLogs: defineTable({
    // User reference
    userId: v.optional(v.id("users")),

    // Lemon Squeezy references
    lemonSqueezyEventId: v.optional(v.string()), // Delivery ID or unique identifier
    lemonSqueezyOrderId: v.optional(v.string()),
    lemonSqueezyOrderCreatedAt: v.optional(v.number()),
    lemonSqueezyInvoiceId: v.optional(v.string()),
    lemonSqueezySubscriptionId: v.optional(v.string()),
    lemonSqueezyCustomerId: v.optional(v.string()),
    lemonSqueezyVariantId: v.optional(v.string()),
    lemonSqueezyBillingReason: v.optional(v.string()),
    lemonSqueezyInvoiceCreatedAt: v.optional(v.number()),

    // Event info
    eventType: v.string(), // "subscription_created", "order_created", "subscription_cancelled", etc.
    productType: v.optional(v.string()), // "pro", "token_pack_small", "token_pack_large"

    // Payment details
    amountCents: v.optional(v.number()),
    currency: v.optional(v.string()),
    tokensAdded: v.optional(v.number()), // For token pack purchases

    // Status
    status: v.union(
      v.literal("success"),
      v.literal("failed"),
      v.literal("pending"),
      v.literal("refunded"),
      v.literal("canceled"),
    ),
    errorMessage: v.optional(v.string()),

    proBindingEvidenceVersion: v.optional(v.literal(1)),
    proBindingEvidenceState: v.optional(
      v.union(
        v.literal("verified"),
        v.literal("not_applicable"),
        v.literal("manual_review"),
      ),
    ),
    proBindingEvidenceFingerprint: v.optional(v.string()),
    proBindingEvidenceUserId: v.optional(v.id("users")),
    proBindingEvidenceStoreId: v.optional(v.string()),
    proBindingEvidenceTestMode: v.optional(v.boolean()),
    // Admin actions
    adminOperationId: v.optional(v.string()),
    adminNote: v.optional(v.string()),
    refundedAt: v.optional(v.number()),
    refundedBy: v.optional(v.id("users")),

    createdAt: v.number(),
  })
    .index("by_created", ["createdAt"])
    .index("by_user", ["userId"])
    .index("by_status", ["status"])
    .index("by_event_type", ["eventType"])
    .index("by_status_and_created", ["status", "createdAt"])
    .index("by_event_type_and_created", ["eventType", "createdAt"])
    .index("by_status_event_type_and_created", [
      "status",
      "eventType",
      "createdAt",
    ])
    .index("by_admin_operation", ["adminOperationId"])
    .index("by_lemon_squeezy_order", ["lemonSqueezyOrderId"])
    .index("by_order_event_status", [
      "lemonSqueezyOrderId",
      "eventType",
      "status",
    ])
    .index("by_invoice_status", ["lemonSqueezyInvoiceId", "status"])
    .index("by_event_id_status", ["lemonSqueezyEventId", "status"])
    .index("by_subscription_event_status", [
      "lemonSqueezySubscriptionId",
      "eventType",
      "status",
    ])
    .index("by_lemon_squeezy_subscription", ["lemonSqueezySubscriptionId"]),

  // Compact, non-PII idempotency tombstones are retained independently of
  // human-readable payment logs so an ancient provider replay cannot settle
  // again after the bounded log-retention window.
  paymentSettlementReceipts: defineTable({
    settlementKeyFingerprint: v.string(),
    settlementType: v.union(
      v.literal("order"),
      v.literal("invoice"),
      v.literal("order_refund"),
      v.literal("invoice_refund"),
    ),
    identityFingerprint: v.string(),
    fingerprintVersion: v.literal(1),
    createdAt: v.number(),
  }).index("by_settlement_key_fingerprint", ["settlementKeyFingerprint"]),

  paymentSettlementConfiguration: defineTable({
    key: v.literal("global"),
    fingerprintKeyAttestation: v.string(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  // Refund and invoice-processing exceptions are retained for an operator
  // decision without storing webhook raw payloads.
  paymentSettlementManualReviews: defineTable({
    settlementKeyFingerprint: v.string(),
    identityFingerprint: v.string(),
    fingerprintVersion: v.literal(1),
    reviewType: v.union(
      v.literal("invoice_processing"),
      v.literal("order_refund"),
      v.literal("invoice_refund"),
    ),
    providerResourceId: v.string(),
    invoiceInboxId: v.optional(v.id("lemonSqueezyInvoiceInbox")),
    userId: v.optional(v.id("users")),
    lemonSqueezySubscriptionId: v.optional(v.string()),
    amountCents: v.optional(v.number()),
    refundedAmountCents: v.optional(v.number()),
    currency: v.optional(v.string()),
    reason: v.string(),
    status: v.union(v.literal("open"), v.literal("resolved")),
    resolutionAction: v.optional(v.literal("requeue")),
    resolutionEvidenceReference: v.optional(v.string()),
    resolvedAt: v.optional(v.number()),
    resolvedBy: v.optional(v.id("users")),
    expiresAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_settlement_key_fingerprint", ["settlementKeyFingerprint"])
    .index("by_status_and_expiration", ["status", "expiresAt"]),

  // ============================================
  // AI LOGS (Admin dashboard for AI response analysis)
  // ============================================
  aiLogs: defineTable({
    // References
    ticketId: v.optional(v.id("tickets")),
    ticketActionId: v.optional(v.id("ticketActions")),
    repositoryId: v.optional(v.id("repositories")),
    userId: v.optional(v.id("users")),

    // Request info
    workflowType: v.string(), // "indexing", "issue_analysis", "issue_formatting", "follow_up", "learning_extraction"
    actionType: v.optional(v.string()), // "format", "answer", "tag_maintainers", "follow_up"

    // Input/Output for debugging
    systemPrompt: v.optional(v.string()),
    userPrompt: v.optional(v.string()),
    aiResponse: v.optional(v.string()),

    // GitHub context
    githubRepo: v.optional(v.string()),
    githubNumber: v.optional(v.number()),
    ticketTitle: v.optional(v.string()),
    ticketBody: v.optional(v.string()),

    // Result tracking
    status: v.union(
      v.literal("success"),
      v.literal("failed"),
      v.literal("pending_approval"),
      v.literal("approved"),
      v.literal("rejected"),
      v.literal("request_changes"),
    ),
    errorMessage: v.optional(v.string()),

    // User feedback
    userFeedback: v.optional(v.string()),
    requestChangesCount: v.optional(v.number()),

    // Token usage
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    totalCostCents: v.optional(v.number()),

    // Metadata
    model: v.optional(v.string()),
    durationMs: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_created", ["createdAt"])
    .index("by_status", ["status"])
    .index("by_workflow_type", ["workflowType"])
    .index("by_status_and_created", ["status", "createdAt"])
    .index("by_workflow_type_and_created", ["workflowType", "createdAt"])
    .index("by_status_workflow_type_and_created", [
      "status",
      "workflowType",
      "createdAt",
    ])
    .index("by_repository", ["repositoryId"])
    .index("by_ticket", ["ticketId"])
    .index("by_ticket_action", ["ticketActionId"]),

  // ============================================
  // REPOSITORY MEMBERS (Team collaboration)
  // ============================================
  repositoryMembers: defineTable({
    repositoryId: v.id("repositories"),
    userId: v.id("users"),
    githubUsername: v.string(),
    role: v.literal("viewer"),
    joinedVia: v.literal("invitation"),
    invitationId: v.id("invitations"),
    joinedAt: v.number(),
  })
    .index("by_repository", ["repositoryId"])
    .index("by_user", ["userId"])
    .index("by_repository_and_user", ["repositoryId", "userId"]),

  // ============================================
  // INVITATIONS (Team invitations)
  // ============================================
  invitations: defineTable({
    repositoryId: v.id("repositories"),
    invitedByUserId: v.id("users"),
    invitedByUsername: v.string(),
    inviteeGithubUsername: v.string(),
    inviteeUserId: v.id("users"),
    role: v.literal("viewer"),
    status: v.union(
      v.literal("pending"),
      v.literal("accepted"),
      v.literal("rejected"),
      v.literal("cancelled"),
    ),
    createdAt: v.number(),
    respondedAt: v.optional(v.number()),
  })
    .index("by_repository", ["repositoryId"])
    .index("by_invitee_user_and_status", ["inviteeUserId", "status"])
    .index("by_repository_and_status", ["repositoryId", "status"])
    .index("by_repository_and_invitee_user_and_status", [
      "repositoryId",
      "inviteeUserId",
      "status",
    ]),

  // ============================================
  // NOTIFICATIONS (In-app notifications)
  // ============================================
  notifications: defineTable({
    userId: v.id("users"),
    type: v.union(
      v.literal("invitation_received"),
      v.literal("invitation_accepted"),
      v.literal("invitation_rejected"),
      v.literal("provider_key_failed"),
    ),
    // Structured details so the UI can translate the notice.
    providerKey: v.optional(
      v.object({
        provider: v.union(v.literal("anthropic"), v.literal("openai")),
        reason: v.union(
          v.literal("invalid"),
          v.literal("out_of_credit"),
          v.literal("unreadable"),
        ),
      }),
    ),
    invitationId: v.optional(v.id("invitations")),
    repositoryId: v.optional(v.id("repositories")),
    title: v.string(),
    message: v.string(),
    isRead: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_and_read", ["userId", "isRead"])
    .index("by_repository", ["repositoryId"]),
};

export default defineSchema({
  ...authTables,
  ...applicationTables,
});
