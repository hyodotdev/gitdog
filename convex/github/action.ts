import { action, internalAction, type ActionCtx } from "../_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { api, internal } from "../_generated/api";
import { v } from "convex/values";
import {
  fetchGitHubAppJsonWithRetry,
  generateGitHubAppJWT,
  getGitHubInstallationAccessState,
  getInstallationToken,
  getDiscussion,
  getIssue,
} from "./helpers";
import { normalizeGitHubRepositoryEmbeddingMetadata } from "../repositories/embeddingPolicy";
import type { Doc, Id } from "../_generated/dataModel";
import {
  getCanonicalGitHubRepositoryFullNameKey,
  resolveVerifiedRepositoryAccess,
} from "./repositoryIdentity";
import { INSTALLATION_WEBHOOK_STATE_MAX_RETRY_COUNT } from "./webhookAccessStateAttestation";
import { REPOSITORY_ACCESS_RECONCILIATION_MAX_RETRY_COUNT } from "./repositoryAccessReconciliation";

const RECONCILIATION_PAGE_SIZE = 50;
const RECONCILIATION_STALE_AFTER_MS = 10 * 60 * 1_000;
const ACCESS_REMOVAL_STALE_AFTER_MS = 5 * 60 * 1_000;
const REPOSITORY_REMOVAL_BATCH_SIZE = 50;
const TICKET_STATE_RECONCILIATION_MAX_RETRY_COUNT = 6;
const TICKET_STATE_RECONCILIATION_MAX_RETRY_DELAY_MS = 60 * 1_000;
const GITHUB_REPOSITORY_REQUEST_TIMEOUT_MS = 30_000;
class PermanentRepositoryRemovalPayloadError extends Error {
  constructor(
    readonly code: string,
    readonly shouldDeletePayload: boolean,
  ) {
    super(code);
    this.name = "PermanentRepositoryRemovalPayloadError";
  }
}

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  stargazers_count: number;
  language: string | null;
  updated_at: string;
  fork: boolean;
  private: boolean;
}

async function revokeUnavailableInstallationAccess(
  ctx: ActionCtx,
  installationId: number,
  status: 403 | 404,
  appId: string,
  privateKey: string,
): Promise<boolean> {
  const accessState =
    status === 404
      ? "deleted"
      : await getGitHubInstallationAccessState(
          installationId,
          appId,
          privateKey,
        );
  if (accessState === "active" || accessState === "unknown") {
    return false;
  }
  if (accessState === "deleted") {
    await ctx.runMutation(
      internal.github.internalMutation.beginInstallationAccessRemoval,
      { installationId, deleteInstallationAfterPause: true },
    );
    return true;
  }

  return (
    (await ctx.runMutation(
      internal.github.internalMutation.beginInstallationAccessRemoval,
      { installationId, deleteInstallationAfterPause: false },
    )) !== null
  );
}

function getGitHubErrorStatus(error: unknown): number | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const match = error.message.match(/(?:HTTP |\b)(403|404)\b/);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

/** Apply installation access changes only after checking GitHub's live state. */
export const reconcileInstallationWebhookAccessState = internalAction({
  args: {
    installationId: v.number(),
    expectedGeneration: v.number(),
    retryCount: v.number(),
  },
  handler: async (ctx, args): Promise<void> => {
    const claimed = await ctx.runMutation(
      internal.github.internalMutation
        .claimInstallationWebhookAccessStateAttestationAttempt,
      args,
    );
    if (!claimed) {
      return;
    }

    const appId = process.env.GITHUB_APP_ID;
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
    let accessState: Awaited<
      ReturnType<typeof getGitHubInstallationAccessState>
    > = "unknown";
    if (appId && privateKey) {
      try {
        accessState = await getGitHubInstallationAccessState(
          args.installationId,
          appId,
          privateKey,
        );
      } catch {
        accessState = "unknown";
      }
    }

    if (accessState === "unknown") {
      if (args.retryCount >= INSTALLATION_WEBHOOK_STATE_MAX_RETRY_COUNT) {
        await ctx.runMutation(
          internal.github.internalMutation
            .failInstallationWebhookAccessStateAttestation,
          {
            installationId: args.installationId,
            expectedGeneration: args.expectedGeneration,
            expectedRetryCount: args.retryCount,
            failure: appId && privateKey ? "github_request" : "configuration",
          },
        );
        return;
      }
      await ctx.runMutation(
        internal.github.internalMutation
          .scheduleInstallationWebhookAccessStateAttestationRetry,
        {
          installationId: args.installationId,
          expectedGeneration: args.expectedGeneration,
          expectedRetryCount: args.retryCount,
        },
      );
      return;
    }
    await ctx.runMutation(
      internal.github.internalMutation
        .applyInstallationWebhookAccessStateAttestation,
      {
        installationId: args.installationId,
        expectedGeneration: args.expectedGeneration,
        expectedRetryCount: args.retryCount,
        accessState,
      },
    );
  },
});

function parseGitHubStateUpdatedAt(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Reconcile one durable, generation-guarded GitHub ticket state job. */
export const reconcileTicketWebhookState = internalAction({
  args: {
    jobId: v.id("ticketStateAttestationJobs"),
    expectedGeneration: v.number(),
  },
  handler: async (ctx, args): Promise<void> => {
    let job: Doc<"ticketStateAttestationJobs"> | null = null;
    try {
      job = await ctx.runMutation(
        internal.tickets.internalMutation.claimTicketStateAttestation,
        args,
      );
      if (!job) return;
      const repository = await ctx.runQuery(
        internal.repositories.internalQuery
          .getByInstallationAndGitHubRepositoryId,
        {
          installationId: job.installationId,
          githubRepositoryId: job.githubRepositoryId,
        },
      );
      if (!repository) throw new Error("Repository not found");
      const access = await resolveVerifiedRepositoryAccess(ctx, repository._id);
      if (
        access.installation.installationId !== job.installationId ||
        access.githubRepositoryId !== job.githubRepositoryId
      ) {
        throw new Error("Repository identity changed during attestation");
      }
      const ticket =
        job.ticketType === "issue"
          ? await getIssue(
              access.owner,
              access.repo,
              job.githubNumber,
              access.token,
            )
          : await getDiscussion(
              access.owner,
              access.repo,
              job.githubNumber,
              access.token,
            );
      const githubStateUpdatedAt = parseGitHubStateUpdatedAt(ticket.updatedAt);
      if (
        githubStateUpdatedAt === null ||
        (ticket.state !== "open" && ticket.state !== "closed")
      ) {
        throw new Error("GitHub ticket state response was invalid");
      }
      const applied = await ctx.runMutation(
        internal.tickets.internalMutation.applyTicketStateAttestation,
        {
          jobId: job._id,
          expectedGeneration: args.expectedGeneration,
          githubState: ticket.state,
          githubStateUpdatedAt,
          githubStateAttestedAt: Date.now(),
          githubTitle: ticket.title,
          githubBody: ticket.body ?? undefined,
          githubAuthor: ticket.author,
        },
      );
      if (!applied) {
        throw new Error("Ticket attestation generation was superseded");
      }
    } catch (error) {
      if (!job) return;
      const retryCount = Math.min(
        Math.max(0, job.retryCount),
        TICKET_STATE_RECONCILIATION_MAX_RETRY_COUNT,
      );
      const delayMs = Math.min(
        TICKET_STATE_RECONCILIATION_MAX_RETRY_DELAY_MS,
        1_000 * 2 ** Math.min(retryCount, 8),
      );
      await ctx.runMutation(
        internal.tickets.internalMutation.scheduleTicketStateAttestationRetry,
        {
          jobId: job._id,
          expectedGeneration: args.expectedGeneration,
          retryCount: Math.min(
            retryCount + 1,
            TICKET_STATE_RECONCILIATION_MAX_RETRY_COUNT,
          ),
          delayMs,
          errorMessage:
            error instanceof Error
              ? error.message
              : "GitHub state attestation failed",
        },
      );
    }
  },
});

type RepositoryAccessReconciliationFailure =
  | "configuration"
  | "authorization"
  | "network"
  | "github_request"
  | "invalid_response"
  | "internal";

async function scheduleRepositoryAccessReconciliationRetry(
  ctx: ActionCtx,
  args: { installationId: number; epoch: number; retryCount: number },
  failure: RepositoryAccessReconciliationFailure,
): Promise<void> {
  const retryCount =
    Number.isSafeInteger(args.retryCount) && args.retryCount >= 0
      ? Math.min(
          args.retryCount,
          REPOSITORY_ACCESS_RECONCILIATION_MAX_RETRY_COUNT,
        )
      : 0;
  if (retryCount >= REPOSITORY_ACCESS_RECONCILIATION_MAX_RETRY_COUNT) {
    await ctx.runMutation(
      internal.github.internalMutation.failRepositoryAccessReconciliation,
      {
        installationId: args.installationId,
        epoch: args.epoch,
        expectedRetryCount: retryCount,
        failure,
      },
    );
    return;
  }

  await ctx.runMutation(
    internal.github.internalMutation
      .scheduleRepositoryAccessReconciliationRetry,
    {
      installationId: args.installationId,
      epoch: args.epoch,
      expectedRetryCount: retryCount,
    },
  );
}

async function attemptRestoredRepositoryIndex(
  ctx: ActionCtx,
  repositoryId: Id<"repositories">,
): Promise<void> {
  const repository = await ctx.runQuery(
    internal.repositories.internalQuery.getById,
    { repositoryId },
  );
  const now = Date.now();
  if (
    !repository ||
    repository.githubAccessRestoreIndexPending !== true ||
    (repository.githubAccessRestoreIndexNextAttemptAt ?? 0) > now
  ) {
    return;
  }

  try {
    const prepared = await ctx.runMutation(
      internal.repoIndexing.mutation.prepareIncrementalIndex,
      {
        repositoryId,
        allowFailedIndexRecovery: true,
        allowStaleIndexRecovery: true,
        queueIfBusy: false,
        clearAccessRestorePending: true,
      },
    );
    if (prepared.success) {
      return;
    }
  } catch {
    console.warn("Unable to prepare restored repository indexing");
  }

  await ctx.runMutation(
    internal.repositories.internalMutation.deferAccessRestoreIndexRetry,
    { repositoryId },
  );
}

export const prepareRestoredRepositoryIndex = internalAction({
  args: { repositoryId: v.id("repositories") },
  handler: async (ctx, args): Promise<void> => {
    await attemptRestoredRepositoryIndex(ctx, args.repositoryId);
  },
});

/** Recover a restore-index action that failed before it could reschedule itself. */
export const recoverPendingAccessRestoreIndexes = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    const repositories = await ctx.runQuery(
      internal.repositories.internalQuery.listDueAccessRestoreIndexRetries,
      { now: Date.now() },
    );
    for (const repository of repositories) {
      await attemptRestoredRepositoryIndex(ctx, repository._id);
    }
  },
});

type StoredRepositoryRemoval = {
  githubRepositoryId: number;
};

function isStoredRepositoryRemoval(
  value: unknown,
): value is StoredRepositoryRemoval {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.githubRepositoryId === "number" &&
    Number.isSafeInteger(candidate.githubRepositoryId) &&
    candidate.githubRepositoryId > 0
  );
}

export const continueRepositoryRemovalJob = internalAction({
  args: { jobId: v.id("githubRepositoryRemovalJobs") },
  handler: async (ctx, args): Promise<void> => {
    const job = await ctx.runQuery(
      internal.github.internalQuery.getRepositoryRemovalJob,
      { jobId: args.jobId },
    );
    if (!job || job.status !== "pending") {
      return;
    }

    try {
      if (job.payloadStorageId === undefined) {
        throw new PermanentRepositoryRemovalPayloadError(
          "PayloadStorageIdMissing",
          false,
        );
      }
      const payloadBlob = await ctx.storage.get(job.payloadStorageId);
      if (!payloadBlob) {
        throw new PermanentRepositoryRemovalPayloadError(
          "PayloadBlobMissing",
          false,
        );
      }
      const serializedPayload = await payloadBlob.text();
      let payload: unknown;
      try {
        payload = JSON.parse(serializedPayload) as unknown;
      } catch {
        throw new PermanentRepositoryRemovalPayloadError(
          "PayloadInvalidJson",
          true,
        );
      }
      if (
        !Array.isArray(payload) ||
        payload.length !== job.totalRepositories ||
        !payload.every(isStoredRepositoryRemoval)
      ) {
        throw new PermanentRepositoryRemovalPayloadError(
          "PayloadInvalid",
          true,
        );
      }

      const batch = payload.slice(
        job.nextOffset,
        job.nextOffset + REPOSITORY_REMOVAL_BATCH_SIZE,
      );
      if (batch.length === 0) {
        throw new PermanentRepositoryRemovalPayloadError(
          "PayloadOffsetInvalid",
          true,
        );
      }
      for (const repository of batch) {
        await ctx.runMutation(
          internal.repositories.internalMutation
            .pauseRepositoryAfterAccessRemoval,
          {
            installationId: job.installationId,
            githubRepositoryId: repository.githubRepositoryId,
          },
        );
      }
      await ctx.runMutation(
        internal.github.internalMutation.advanceRepositoryRemovalJob,
        {
          jobId: job._id,
          expectedOffset: job.nextOffset,
          processedCount: batch.length,
        },
      );
    } catch (error) {
      const isPermanent =
        error instanceof PermanentRepositoryRemovalPayloadError;
      const errorMessage = isPermanent
        ? error.code
        : error instanceof Error
          ? error.name.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 100) || "Error"
          : "unknown";
      await ctx.runMutation(
        internal.github.internalMutation.deferRepositoryRemovalJob,
        {
          jobId: job._id,
          expectedOffset: job.nextOffset,
          expectedRetryCount: job.retryCount,
          failureKind: isPermanent ? "permanent" : "transient",
          deletePayload: isPermanent && error.shouldDeletePayload === true,
          errorMessage,
        },
      );
    }
  },
});

export const recoverRepositoryRemovalJobs = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    const jobs = await ctx.runQuery(
      internal.github.internalQuery.listDueRepositoryRemovalJobs,
      { now: Date.now() },
    );
    for (const job of jobs) {
      await ctx.scheduler.runAfter(
        0,
        internal.github.action.continueRepositoryRemovalJob,
        { jobId: job._id },
      );
    }
  },
});

/** Recover an installation access-removal continuation that disappeared. */
export const recoverInstallationAccessRemovals = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    const staleBefore = Date.now() - ACCESS_REMOVAL_STALE_AFTER_MS;
    const removals = await ctx.runQuery(
      internal.github.internalQuery.listStaleInstallationAccessRemovals,
      { staleBefore },
    );
    for (const removal of removals) {
      const claimed = await ctx.runMutation(
        internal.github.internalMutation.claimStaleInstallationAccessRemoval,
        { ...removal, staleBefore },
      );
      if (!claimed) continue;
      await ctx.scheduler.runAfter(
        0,
        internal.repositories.internalMutation
          .continueInstallationAccessRemoval,
        removal,
      );
    }
  },
});

/** Recover stale signed-webhook attestations without opening repository access. */
export const recoverInstallationWebhookAccessStateAttestations = internalAction(
  {
    args: {},
    handler: async (ctx): Promise<{ checked: number; scheduled: number }> => {
      if (!process.env.GITHUB_APP_ID || !process.env.GITHUB_APP_PRIVATE_KEY) {
        return { checked: 0, scheduled: 0 };
      }

      const now = Date.now();
      const attestations = await ctx.runQuery(
        internal.github.internalQuery
          .listStaleInstallationWebhookAccessStateAttestations,
        { now },
      );
      let scheduled = 0;
      for (const attestation of attestations) {
        const recovered = await ctx.runMutation(
          internal.github.internalMutation
            .recoverStaleInstallationWebhookAccessStateAttestation,
          { ...attestation, now },
        );
        if (recovered) scheduled++;
      }
      return { checked: attestations.length, scheduled };
    },
  },
);

/** Recover a reconciliation whose scheduled continuation was lost. */
export const recoverRepositoryAccessReconciliations = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    const now = Date.now();
    const staleBefore = now - RECONCILIATION_STALE_AFTER_MS;
    const reconciliations = await ctx.runQuery(
      internal.github.internalQuery.listStaleRepositoryAccessReconciliations,
      { now, staleBefore },
    );
    for (const reconciliation of reconciliations) {
      await ctx.runMutation(
        internal.github.internalMutation
          .recoverStaleRepositoryAccessReconciliation,
        {
          ...reconciliation,
          now,
          staleBefore,
        },
      );
    }
  },
});

/** Fetch and apply exactly one durable installation reconciliation page. */
export const continueRepositoryAccessReconciliation = internalAction({
  args: {
    installationId: v.number(),
    epoch: v.number(),
    retryCount: v.number(),
  },
  handler: async (ctx, args): Promise<void> => {
    const claimed = await ctx.runMutation(
      internal.github.internalMutation
        .claimRepositoryAccessReconciliationAttempt,
      args,
    );
    if (!claimed) {
      return;
    }

    const installation = await ctx.runQuery(
      internal.github.internalQuery.getInstallationByInstallationId,
      { installationId: args.installationId },
    );
    if (
      !installation ||
      installation.repositoryAccessReconciliationEpoch !== args.epoch ||
      installation.repositoryAccessReconciliationPhase !== "fetching" ||
      installation.repositoryAccessReconciliationNextPage === undefined
    ) {
      return;
    }

    const appId = process.env.GITHUB_APP_ID;
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
    if (!appId || !privateKey) {
      await scheduleRepositoryAccessReconciliationRetry(
        ctx,
        args,
        "configuration",
      );
      return;
    }

    let token: string;
    try {
      token = await getInstallationToken(
        args.installationId,
        appId,
        privateKey,
      );
    } catch (error) {
      const status = getGitHubErrorStatus(error);
      if (status === 403 || status === 404) {
        await revokeUnavailableInstallationAccess(
          ctx,
          args.installationId,
          status,
          appId,
          privateKey,
        );
      }
      await scheduleRepositoryAccessReconciliationRetry(
        ctx,
        args,
        status === 403 || status === 404 ? "authorization" : "github_request",
      );
      return;
    }

    const page = installation.repositoryAccessReconciliationNextPage;
    let response: Response;
    try {
      response = await fetch(
        `https://api.github.com/installation/repositories?per_page=${RECONCILIATION_PAGE_SIZE}&page=${page}`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "User-Agent": "Gitdog",
            "X-GitHub-Api-Version": "2026-03-10",
          },
          signal: AbortSignal.timeout(GITHUB_REPOSITORY_REQUEST_TIMEOUT_MS),
        },
      );
    } catch {
      await scheduleRepositoryAccessReconciliationRetry(ctx, args, "network");
      return;
    }
    if (!response.ok) {
      if (response.status === 403 || response.status === 404) {
        await revokeUnavailableInstallationAccess(
          ctx,
          args.installationId,
          response.status,
          appId,
          privateKey,
        );
      }
      await scheduleRepositoryAccessReconciliationRetry(
        ctx,
        args,
        response.status === 401 ||
          response.status === 403 ||
          response.status === 404
          ? "authorization"
          : "github_request",
      );
      return;
    }

    let body: unknown;
    try {
      body = (await response.json()) as unknown;
    } catch {
      await scheduleRepositoryAccessReconciliationRetry(
        ctx,
        args,
        "invalid_response",
      );
      return;
    }
    if (
      typeof body !== "object" ||
      body === null ||
      !Array.isArray((body as { repositories?: unknown }).repositories)
    ) {
      await scheduleRepositoryAccessReconciliationRetry(
        ctx,
        args,
        "invalid_response",
      );
      return;
    }
    const rawRepositories = (body as { repositories: unknown[] }).repositories;
    const repositories: Array<{
      githubRepositoryId: number;
      githubRepo: string;
      githubVisibility: "public" | "private" | "internal" | null;
      licenseKey: string | null;
      licenseSpdxId: string | null;
    }> = [];
    const repositoryIds = new Set<number>();
    const repositoryFullNames = new Set<string>();
    for (const rawRepository of rawRepositories) {
      if (
        typeof rawRepository !== "object" ||
        rawRepository === null ||
        Array.isArray(rawRepository)
      ) {
        await scheduleRepositoryAccessReconciliationRetry(
          ctx,
          args,
          "invalid_response",
        );
        return;
      }
      const repository = rawRepository as Record<string, unknown>;
      if (
        typeof repository.id !== "number" ||
        !Number.isSafeInteger(repository.id) ||
        repository.id <= 0 ||
        repositoryIds.has(repository.id) ||
        typeof repository.full_name !== "string"
      ) {
        await scheduleRepositoryAccessReconciliationRetry(
          ctx,
          args,
          "invalid_response",
        );
        return;
      }
      const githubRepo = repository.full_name;
      let githubRepoKey: string;
      try {
        githubRepoKey = getCanonicalGitHubRepositoryFullNameKey(githubRepo);
      } catch {
        await scheduleRepositoryAccessReconciliationRetry(
          ctx,
          args,
          "invalid_response",
        );
        return;
      }
      if (repositoryFullNames.has(githubRepoKey)) {
        await scheduleRepositoryAccessReconciliationRetry(
          ctx,
          args,
          "invalid_response",
        );
        return;
      }
      repositoryIds.add(repository.id);
      repositoryFullNames.add(githubRepoKey);
      const metadata = normalizeGitHubRepositoryEmbeddingMetadata(repository);
      repositories.push({
        githubRepositoryId: repository.id,
        githubRepo,
        githubVisibility: metadata.githubVisibility ?? null,
        licenseKey: metadata.licenseKey ?? null,
        licenseSpdxId: metadata.licenseSpdxId ?? null,
      });
    }

    try {
      await ctx.runMutation(
        internal.repositories.internalMutation
          .applyRepositoryAccessReconciliationPage,
        {
          installationId: args.installationId,
          epoch: args.epoch,
          page,
          hasMore: rawRepositories.length === RECONCILIATION_PAGE_SIZE,
          repositories,
        },
      );
    } catch {
      await scheduleRepositoryAccessReconciliationRetry(ctx, args, "internal");
    }
  },
});

type RetryRepositoryAccessReconciliationResult =
  | { status: "started"; epoch: number }
  | { status: "not_found" }
  | { status: "not_failed" };

export const retryRepositoryAccessReconciliation = action({
  args: { installationId: v.number() },
  handler: async (
    ctx,
    args,
  ): Promise<RetryRepositoryAccessReconciliationResult> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }
    return await ctx.runMutation(
      internal.github.internalMutation
        .retryFailedRepositoryAccessReconciliation,
      { userId, installationId: args.installationId },
    );
  },
});

type UserRepositoryListItem = {
  id: number;
  name: string;
  fullName: string;
  description: string | null;
  url: string;
  stars: number;
  language: string | null;
  updatedAt: string;
  isPrivate: boolean;
  installationId: number;
  accountLogin: string;
  accountType: string;
  reconciliationPending: boolean;
};

type UserRepositoryListCursor = {
  installationId: number;
  page: number;
};

const USER_REPOSITORY_PAGE_SIZE = 100;
const USER_REPOSITORY_MAX_PAGE = 10_000;

function parseUserRepositoryListCursor(
  cursor: string | undefined,
): UserRepositoryListCursor | null {
  if (cursor === undefined) return null;
  try {
    const parsed = JSON.parse(cursor) as Record<string, unknown>;
    if (
      typeof parsed.installationId !== "number" ||
      !Number.isSafeInteger(parsed.installationId) ||
      parsed.installationId <= 0 ||
      typeof parsed.page !== "number" ||
      !Number.isSafeInteger(parsed.page) ||
      parsed.page <= 0 ||
      parsed.page > USER_REPOSITORY_MAX_PAGE
    ) {
      throw new Error("invalid cursor fields");
    }
    return {
      installationId: parsed.installationId,
      page: parsed.page,
    };
  } catch {
    throw new Error("Invalid repository list cursor");
  }
}

function encodeUserRepositoryListCursor(
  cursor: UserRepositoryListCursor,
): string {
  return JSON.stringify(cursor);
}

async function listUserRepositoriesPage(
  ctx: ActionCtx,
  args: { cursor?: string; reconnectRepositoryId?: string },
): Promise<{
  repositories: UserRepositoryListItem[];
  continueCursor: string | null;
}> {
  const userId = await getAuthUserId(ctx);
  if (!userId) {
    throw new Error("Not authenticated");
  }

  const reconnectTarget = args.reconnectRepositoryId
    ? await ctx.runQuery(api.repositories.query.getReconnectTarget, {
        reconnectRepositoryId: args.reconnectRepositoryId,
      })
    : undefined;
  if (args.reconnectRepositoryId !== undefined && !reconnectTarget) {
    throw new Error("Reconnect target is unavailable");
  }

  // Check if user has GitHub App installed (get ALL installations)
  const installations = await ctx.runQuery(
    api.github.query.getUserInstallations,
  );

  if (installations.length === 0) {
    return { repositories: [], continueCursor: null };
  }

  const sortedInstallations = [...installations].sort(
    (left, right) => left.installationId - right.installationId,
  );
  const requestedCursor = parseUserRepositoryListCursor(args.cursor);
  const installationIndex = requestedCursor
    ? sortedInstallations.findIndex(
        (installation) =>
          installation.installationId >= requestedCursor.installationId,
      )
    : 0;
  if (installationIndex < 0) {
    return { repositories: [], continueCursor: null };
  }
  const installation = sortedInstallations[installationIndex];
  const page =
    requestedCursor?.installationId === installation.installationId
      ? requestedCursor.page
      : 1;

  const getNextInstallationCursor = (): string | null => {
    const nextInstallation = sortedInstallations[installationIndex + 1];
    return nextInstallation
      ? encodeUserRepositoryListCursor({
          installationId: nextInstallation.installationId,
          page: 1,
        })
      : null;
  };

  if (
    installation.reconciliationPending ||
    installation.reconciliationFailed === true
  ) {
    return {
      repositories: [],
      continueCursor: getNextInstallationCursor(),
    };
  }

  // Get environment variables
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;

  if (!appId || !privateKey) {
    throw new Error("GitHub App credentials not configured");
  }

  let accessToken: string;
  try {
    accessToken = await getInstallationToken(
      installation.installationId,
      appId,
      privateKey,
    );
  } catch (error) {
    const status = getGitHubErrorStatus(error);
    if (
      (status === 403 || status === 404) &&
      (await revokeUnavailableInstallationAccess(
        ctx,
        installation.installationId,
        status,
        appId,
        privateKey,
      ))
    ) {
      return {
        repositories: [],
        continueCursor: getNextInstallationCursor(),
      };
    }
    throw new Error("Unable to load repositories from GitHub", {
      cause: error,
    });
  }

  const response = await fetch(
    `https://api.github.com/installation/repositories?per_page=${USER_REPOSITORY_PAGE_SIZE}&page=${page}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "Gitdog",
        "X-GitHub-Api-Version": "2026-03-10",
      },
      signal: AbortSignal.timeout(GITHUB_REPOSITORY_REQUEST_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    if (
      (response.status === 403 || response.status === 404) &&
      (await revokeUnavailableInstallationAccess(
        ctx,
        installation.installationId,
        response.status,
        appId,
        privateKey,
      ))
    ) {
      return {
        repositories: [],
        continueCursor: getNextInstallationCursor(),
      };
    }
    throw new Error(
      `Unable to load repositories from GitHub (${response.status})`,
    );
  }

  const data = (await response.json()) as { repositories?: unknown };
  if (!Array.isArray(data.repositories)) {
    throw new Error("GitHub repository list returned invalid data");
  }
  const rawRepositories = data.repositories as GitHubRepo[];
  if (rawRepositories.length > USER_REPOSITORY_PAGE_SIZE) {
    throw new Error("GitHub repository list exceeded the page size");
  }
  const connectedRepoSet = reconnectTarget
    ? new Set<number>()
    : new Set(
        await ctx.runQuery(
          internal.github.internalQuery.getConnectedGitHubRepositoryIdsForUser,
          {
            userId,
            githubRepositoryIds: rawRepositories.map((repo) => repo.id),
          },
        ),
      );
  const continueCursor =
    rawRepositories.length === USER_REPOSITORY_PAGE_SIZE
      ? encodeUserRepositoryListCursor({
          installationId: installation.installationId,
          page: page + 1,
        })
      : getNextInstallationCursor();

  const repositories = rawRepositories
    .filter(
      (repo) =>
        !repo.fork &&
        !connectedRepoSet.has(repo.id) &&
        repo.id === (reconnectTarget?.githubRepositoryId ?? repo.id) &&
        Number.isSafeInteger(repo.id) &&
        repo.id > 0,
    )
    .map((repo) => ({
      id: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      description: repo.description,
      url: repo.html_url,
      stars: repo.stargazers_count,
      language: repo.language,
      updatedAt: repo.updated_at,
      isPrivate: repo.private,
      installationId: installation.installationId,
      accountLogin: installation.accountLogin,
      accountType: installation.accountType,
      reconciliationPending: false,
    }));

  return { repositories, continueCursor };
}

export const listUserRepositories = action({
  args: {
    cursor: v.optional(v.string()),
    reconnectRepositoryId: v.optional(v.string()),
  },
  handler: listUserRepositoriesPage,
});

type InstallationRefreshResult =
  | { status: "not_bound_yet" }
  | { status: "reauth_required" }
  | { status: "bound"; installationId: number };

const installationRefreshResultValidator = v.union(
  v.object({ status: v.literal("not_bound_yet") }),
  v.object({ status: v.literal("reauth_required") }),
  v.object({
    status: v.literal("bound"),
    installationId: v.number(),
  }),
);

async function refreshInstallationBinding(
  ctx: ActionCtx,
  args: { installationId: number },
): Promise<InstallationRefreshResult> {
  const userId = await getAuthUserId(ctx);
  if (!userId) {
    throw new Error("Not authenticated");
  }

  if (!Number.isSafeInteger(args.installationId) || args.installationId <= 0) {
    throw new Error("Installation not available");
  }

  const existing = await ctx.runQuery(
    internal.github.internalQuery.getInstallationByInstallationId,
    { installationId: args.installationId },
  );
  if (existing && existing.userId !== userId) {
    return { status: "not_bound_yet" as const };
  }
  if (existing?.accessSuspendedAt !== undefined) {
    throw new Error("GitHub installation access is unavailable");
  }

  const oauthAttestation = existing
    ? null
    : await ctx.runQuery(
        internal.github.internalQuery.getFreshOAuthInstallationAttestation,
        {
          userId,
          installationId: args.installationId,
          now: Date.now(),
        },
      );
  if (!existing && !oauthAttestation) {
    // Keep polling briefly for the signed installation webhook. If it never
    // arrives, the caller must refresh its GitHub user authorization so the
    // official /user/installations association can be attested.
    return { status: "reauth_required" as const };
  }

  // Get environment variables
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;

  if (!appId || !privateKey) {
    throw new Error("GitHub App credentials not configured");
  }

  // Generate JWT and fetch installation details
  let jwt: string;
  try {
    jwt = await generateGitHubAppJWT(appId, privateKey);
  } catch {
    throw new Error("GitHub App credentials are invalid");
  }

  let installation: unknown;
  try {
    installation = await fetchGitHubAppJsonWithRetry<unknown>(
      `https://api.github.com/app/installations/${args.installationId}`,
      jwt,
      "GitHub installation metadata refresh",
      { maxAttempts: 1 },
    );
  } catch {
    throw new Error("Failed to refresh GitHub installation details");
  }
  if (
    typeof installation !== "object" ||
    installation === null ||
    Array.isArray(installation)
  ) {
    throw new Error("GitHub returned invalid installation details");
  }
  const installationRecord = installation as Record<string, unknown>;
  const account = installationRecord.account;
  const permissions = installationRecord.permissions;
  if (
    typeof account !== "object" ||
    account === null ||
    Array.isArray(account) ||
    typeof (account as Record<string, unknown>).id !== "number" ||
    !Number.isSafeInteger((account as Record<string, unknown>).id) ||
    ((account as Record<string, unknown>).id as number) <= 0 ||
    typeof (account as Record<string, unknown>).login !== "string" ||
    (account as Record<string, unknown>).login === "" ||
    ((account as Record<string, unknown>).type !== "User" &&
      (account as Record<string, unknown>).type !== "Organization") ||
    (installationRecord.target_type !== "User" &&
      installationRecord.target_type !== "Organization") ||
    installationRecord.target_type !==
      (account as Record<string, unknown>).type ||
    installationRecord.id !== args.installationId ||
    typeof permissions !== "object" ||
    permissions === null ||
    Array.isArray(permissions)
  ) {
    throw new Error("GitHub returned invalid installation details");
  }
  const accountRecord = account as Record<string, unknown>;
  if (!existing && accountRecord.type === "Organization") {
    // /user/installations proves that the OAuth user can access at least part
    // of an organization installation, not that they administer its complete
    // repository selection. Only a signed GitHub webhook may create that
    // durable organization binding.
    return { status: "not_bound_yet" as const };
  }
  if (
    !existing &&
    accountRecord.type === "User" &&
    (accountRecord.id as number).toString() !==
      oauthAttestation!.githubAccountId
  ) {
    throw new Error("GitHub installation owner does not match authorization");
  }

  const result = await ctx.runMutation(
    internal.github.internalMutation.saveInstallation,
    {
      userId,
      installationId: args.installationId,
      accountLogin: accountRecord.login as string,
      accountType: accountRecord.type as "User" | "Organization",
      targetType: installationRecord.target_type as "User" | "Organization",
      permissions,
      ...(existing
        ? {
            requireExisting: true,
            startRepositoryAccessReconciliation: true,
          }
        : {
            ownerGithubAccountId: oauthAttestation!.githubAccountId,
            startRepositoryAccessReconciliation: true,
          }),
    },
  );
  if (
    (existing && result.status !== "updated") ||
    (!existing && result.status !== "created" && result.status !== "updated")
  ) {
    throw new Error("Installation not available");
  }

  return { status: "bound" as const, installationId: args.installationId };
}

export const saveInstallation = action({
  args: {
    installationId: v.number(),
  },
  returns: installationRefreshResultValidator,
  handler: async (ctx, args): Promise<InstallationRefreshResult> => {
    return await refreshInstallationBinding(ctx, args);
  },
});

type OAuthInstallationRecoveryResult =
  | { status: "recovered"; installationId: number }
  | { status: "configure_required"; installationId: number }
  | { status: "complete" }
  | { status: "none" }
  | { status: "reauth_required" }
  | { status: "unavailable" };

const oauthInstallationRecoveryResultValidator = v.union(
  v.object({
    status: v.literal("recovered"),
    installationId: v.number(),
  }),
  v.object({
    status: v.literal("configure_required"),
    installationId: v.number(),
  }),
  v.object({ status: v.literal("complete") }),
  v.object({ status: v.literal("none") }),
  v.object({ status: v.literal("reauth_required") }),
  v.object({ status: v.literal("unavailable") }),
);

/** Recover one installation proven by the current OAuth authorization. */
export const recoverOAuthInstallation = action({
  args: {},
  returns: oauthInstallationRecoveryResultValidator,
  handler: async (ctx): Promise<OAuthInstallationRecoveryResult> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const target = await ctx.runQuery(
      internal.github.internalQuery.getOAuthInstallationRecoveryTarget,
      { userId, now: Date.now() },
    );
    if (target.status !== "candidate") {
      return target;
    }

    const result = await refreshInstallationBinding(ctx, {
      installationId: target.installationId,
    });
    switch (result.status) {
      case "bound":
        return {
          status: "recovered",
          installationId: result.installationId,
        };
      case "reauth_required":
        return { status: "reauth_required" };
      case "not_bound_yet": {
        // A signed webhook can race the metadata request. Re-read the attempted
        // installation and the global recovery state in one query snapshot.
        const refreshedTarget = await ctx.runQuery(
          internal.github.internalQuery
            .getOAuthInstallationRecoveryResultAfterRefresh,
          {
            userId,
            attemptedInstallationId: target.installationId,
            now: Date.now(),
          },
        );
        return refreshedTarget;
      }
    }
  },
});
