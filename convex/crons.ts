import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Clean up old cached files every hour
crons.interval(
  "cleanup-old-file-cache",
  { hours: 1 },
  internal.repoIndexing.internalAction.cleanupOldFileCache,
);

// Recover active generations whose indexing heartbeat became stale.
crons.interval(
  "recover-stale-repository-indexes",
  { minutes: 5 },
  internal.repoIndexing.internalAction.recoverStaleRepositoryIndexes,
  {},
);

crons.interval(
  "recover-restored-repository-indexes",
  { minutes: 5 },
  internal.github.action.recoverPendingAccessRestoreIndexes,
  {},
);

crons.interval(
  "recover-repository-removal-jobs",
  { minutes: 5 },
  internal.github.action.recoverRepositoryRemovalJobs,
  {},
);

crons.interval(
  "recover-installation-access-removals",
  { minutes: 5 },
  internal.github.action.recoverInstallationAccessRemovals,
  {},
);

crons.interval(
  "recover-installation-webhook-attestations",
  { minutes: 5 },
  internal.github.action.recoverInstallationWebhookAccessStateAttestations,
  {},
);

crons.interval(
  "recover-repository-access-reconciliations",
  { minutes: 5 },
  internal.github.action.recoverRepositoryAccessReconciliations,
  {},
);

crons.interval(
  "recover-stalled-disconnect-cleanups",
  { minutes: 5 },
  internal.repositories.mutation.recoverStalledDisconnectCleanups,
  {},
);

crons.interval(
  "recover-tree-snapshot-cleanup",
  { minutes: 15 },
  internal.repoIndexing.internalAction.recoverTreeSnapshotCleanup,
  {},
);

crons.interval(
  "cleanup-embedding-usage-reservations",
  { hours: 1 },
  internal._ai.embeddingBilling.cleanupEmbeddingUsageReservations,
  {},
);

crons.interval(
  "recover-staged-embedding-usage",
  { minutes: 5 },
  internal._ai.embeddingBilling.recoverStagedEmbeddingOutcomes,
  {},
);

crons.interval(
  "cleanup-chat-usage-reservations",
  { hours: 1 },
  internal._ai.chatBilling.cleanupChatReservations,
  {},
);

crons.interval(
  "recover-staged-chat-usage",
  { minutes: 5 },
  internal._ai.chatBilling.recoverStagedChatOutcomes,
  {},
);

crons.interval(
  "recover-checkpointed-chat-actions",
  { minutes: 5 },
  internal._ai.chatBilling.recoverCheckpointedChatActions,
  {},
);

crons.interval(
  "recover-pending-chat-generations",
  { minutes: 5 },
  internal._ai.chatBilling.recoverPendingChatGenerations,
  {},
);

crons.interval(
  "recover-auto-approved-executions",
  { minutes: 5 },
  internal.ticketActions.internalMutation.recoverAutoApprovedExecutions,
  {},
);

crons.interval(
  "recover-claimed-github-executions",
  { minutes: 5 },
  internal.ticketActions.internalMutation.recoverClaimedExecutions,
  {},
);

crons.interval(
  "recover-initial-ticket-processing",
  { minutes: 5 },
  internal.tickets.internalMutation.recoverInitialTicketProcessing,
  {},
);

crons.interval(
  "recover-ticket-state-attestations",
  { minutes: 5 },
  internal.tickets.internalMutation.recoverTicketStateAttestations,
  {},
);

crons.interval(
  "recover-subscription-invoice-inbox",
  { minutes: 5 },
  internal.subscriptions.internalMutation.recoverSubscriptionInvoiceInbox,
  {},
);

crons.daily(
  "delete-expired-payment-logs",
  { hourUTC: 3, minuteUTC: 20 },
  internal.paymentLogs.privacy.deleteExpiredPaymentLogs,
  {},
);

// Push webhooks update immediately; daily synchronization also catches missed events.
crons.daily(
  "daily-repository-sync",
  { hourUTC: 19, minuteUTC: 0 },
  internal.repoIndexing.internalAction.dailySyncAllRepositories,
  {},
);

export default crons;
