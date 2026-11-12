import { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  fetchGitHubAppJsonWithRetry,
  hasGitdogMentionBody,
  getRepositoryInstallationToken,
  getIssueComments,
  getDiscussionComments,
  getRepositoryMaintainers,
} from "./helpers";
import { isGitdogBot } from "./botIdentity";
import { normalizeGitHubRepositoryEmbeddingMetadata } from "../repositories/embeddingPolicy";
import {
  resolveVerifiedRepositoryAccess,
  type VerifiedRepositoryAccess,
} from "./repositoryIdentity";
import { extractExecutionMarkerKey } from "../ticketActions/executionRecovery";

const REMOVAL_JOB_MAX_REPOSITORIES = 5_000;
const REMOVAL_JOB_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

/**
 * Verify GitHub webhook signature using HMAC-SHA256
 */
export async function verifyWebhookSignature(
  signature: string | null,
  body: string,
  secret: string,
): Promise<boolean> {
  if (!signature) {
    return false;
  }

  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const bodyData = encoder.encode(body);
  const expectedSignature = await crypto.subtle.sign("HMAC", key, bodyData);
  const expectedHex = Array.from(new Uint8Array(expectedSignature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const expectedSignatureHeader = `sha256=${expectedHex}`;

  // Use constant-time comparison to prevent timing attacks
  if (signature.length !== expectedSignatureHeader.length) {
    return false;
  }

  const encoder2 = new TextEncoder();
  const signatureBuffer = encoder2.encode(signature);
  const expectedBuffer = encoder2.encode(expectedSignatureHeader);

  let mismatch = 0;
  for (let i = 0; i < signatureBuffer.length; i++) {
    mismatch |= signatureBuffer[i] ^ expectedBuffer[i];
  }

  return mismatch === 0;
}

/**
 * Handle GitHub installation event (app installed/uninstalled)
 */
export async function handleInstallationEvent(
  ctx: ActionCtx,
  payload: Record<string, unknown>,
): Promise<void> {
  console.log("Installation event:", payload.action);

  if (payload.action === "created") {
    const installation = payload.installation;
    const sender = payload.sender;
    if (!isRecord(installation) || !isRecord(sender)) {
      console.warn("Ignoring installation event with missing ownership data");
      return;
    }

    const account = installation.account;
    const installationId = installation.id;
    const senderId = sender.id;
    if (
      !isRecord(account) ||
      typeof account.login !== "string" ||
      account.login.trim() === "" ||
      typeof account.type !== "string" ||
      typeof installation.target_type !== "string" ||
      !isRecord(installation.permissions) ||
      typeof installationId !== "number" ||
      !Number.isSafeInteger(installationId) ||
      installationId <= 0 ||
      typeof senderId !== "number" ||
      !Number.isSafeInteger(senderId) ||
      senderId <= 0
    ) {
      console.warn("Ignoring installation event with invalid ownership data");
      return;
    }

    // The signed webhook sender ID is the same immutable GitHub account ID used
    // by the OAuth login. Organization names and client-supplied IDs are not
    // trusted for ownership binding.
    const userIdResult = await ctx.runQuery(
      internal.github.internalQuery.getUserIdByGithubAccountId,
      { githubAccountId: senderId.toString() },
    );

    if (userIdResult) {
      const result = await ctx.runMutation(
        internal.github.internalMutation.saveInstallation,
        {
          userId: userIdResult,
          installationId,
          accountLogin: account.login,
          accountType: account.type,
          targetType: installation.target_type,
          permissions: installation.permissions,
          ownerGithubAccountId: senderId.toString(),
          startRepositoryAccessReconciliation: true,
        },
      );
      if (result.status === "owner_mismatch" || result.status === "not_found") {
        console.warn(
          `Ignoring ownership change for installation ${installationId}`,
        );
        return;
      }
      console.log("Installation ownership verified by signed webhook");
    } else {
      console.warn("No authenticated GitHub account matches webhook sender");
    }
  } else if (payload.action === "suspend" || payload.action === "suspended") {
    const installationId = isRecord(payload.installation)
      ? readPositiveSafeInteger(payload.installation.id)
      : undefined;
    if (installationId === undefined) {
      return;
    }
    await gateInstallationAccessStateForAttestation(ctx, installationId);
  } else if (
    payload.action === "unsuspend" ||
    payload.action === "unsuspended"
  ) {
    const installationId = isRecord(payload.installation)
      ? readPositiveSafeInteger(payload.installation.id)
      : undefined;
    if (installationId === undefined) {
      return;
    }
    const existing = await ctx.runQuery(
      internal.github.internalQuery.getInstallationByInstallationId,
      { installationId },
    );
    if (!existing) {
      return;
    }
    await ctx.runMutation(
      internal.github.internalMutation.startRepositoryAccessReconciliation,
      {
        installationId,
        expectedAccessSuspendedAt: existing.accessSuspendedAt ?? null,
      },
    );
  } else if (payload.action === "deleted") {
    const installation = payload.installation;
    const installationId = isRecord(installation)
      ? readPositiveSafeInteger(installation.id)
      : undefined;
    if (installationId === undefined) {
      console.warn("Ignoring installation deletion with invalid identifier");
      return;
    }
    await gateInstallationAccessStateForAttestation(ctx, installationId);
  }
}

/**
 * Handle GitHub installation_repositories event
 */
export async function handleInstallationRepositoriesEvent(
  ctx: ActionCtx,
  payload: Record<string, unknown>,
  deliveryId?: string | null,
): Promise<void> {
  console.log("Installation repositories event:", payload.action);
  if (payload.action !== "added" && payload.action !== "removed") {
    return;
  }
  const authorization = await authorizeInstallationRepositoriesEvent(
    ctx,
    payload,
  );
  if (authorization === undefined) {
    return;
  }
  const { installationId, reconciliationStarted } = authorization;
  if (payload.action === "removed") {
    const removedRepositories = Array.isArray(payload.repositories_removed)
      ? payload.repositories_removed
      : [];
    const removedRepositoryIds = new Set<number>();
    const removals: Array<{ githubRepositoryId: number }> = [];
    for (const removedRepository of removedRepositories) {
      if (!isRecord(removedRepository)) {
        continue;
      }
      const githubRepositoryId = readPositiveSafeInteger(removedRepository.id);
      if (
        githubRepositoryId === undefined ||
        removedRepositoryIds.has(githubRepositoryId)
      ) {
        continue;
      }
      removedRepositoryIds.add(githubRepositoryId);
      removals.push({ githubRepositoryId });
    }

    if (removals.length === 0) {
      if (!reconciliationStarted) {
        await ctx.runMutation(
          internal.github.internalMutation.startRepositoryRemovalReconciliation,
          { installationId },
        );
      }
      return;
    }

    const normalizedDeliveryId =
      typeof deliveryId === "string" &&
      deliveryId.trim().length > 0 &&
      deliveryId.trim().length <= 200
        ? deliveryId.trim()
        : undefined;
    if (normalizedDeliveryId === undefined) {
      console.warn(
        "Repository removal delivery identifier is unavailable; using authoritative reconciliation",
      );
      if (!reconciliationStarted) {
        await ctx.runMutation(
          internal.github.internalMutation.startRepositoryRemovalReconciliation,
          { installationId },
        );
      }
      return;
    }

    const serializedPayload = JSON.stringify(removals);
    const payloadBytes = new TextEncoder().encode(serializedPayload).byteLength;
    if (
      removals.length > REMOVAL_JOB_MAX_REPOSITORIES ||
      payloadBytes > REMOVAL_JOB_MAX_PAYLOAD_BYTES
    ) {
      console.warn(
        "Repository removal payload exceeded the durable immediate-removal ceiling; using authoritative reconciliation",
      );
      if (!reconciliationStarted) {
        await ctx.runMutation(
          internal.github.internalMutation.startRepositoryRemovalReconciliation,
          { installationId },
        );
      }
      return;
    }
    const payloadStorageId = await ctx.storage.store(
      new Blob([serializedPayload], { type: "application/json" }),
    );
    try {
      await ctx.runMutation(
        internal.github.internalMutation.createRepositoryRemovalJob,
        {
          deliveryId: normalizedDeliveryId,
          installationId,
          payloadStorageId,
          totalRepositories: removals.length,
        },
      );
    } catch (error) {
      await ctx.storage.delete(payloadStorageId);
      throw error;
    }
    return;
  }
  if (!reconciliationStarted) {
    await ctx.runMutation(
      internal.github.internalMutation.startRepositoryAccessReconciliation,
      { installationId, expectedAccessSuspendedAt: null },
    );
  }
}

type InstallationRepositoriesAuthorization = {
  installationId: number;
  reconciliationStarted: boolean;
};

async function authorizeInstallationRepositoriesEvent(
  ctx: ActionCtx,
  payload: Record<string, unknown>,
): Promise<InstallationRepositoriesAuthorization | undefined> {
  const installation = payload.installation;
  const sender = payload.sender;
  if (!isRecord(installation) || !isRecord(sender)) {
    console.warn(
      "Ignoring installation repositories event without signed metadata",
    );
    return undefined;
  }

  const account = installation.account;
  const installationId = readPositiveSafeInteger(installation.id);
  const senderId = readPositiveSafeInteger(sender.id);
  const accountId = isRecord(account)
    ? readPositiveSafeInteger(account.id)
    : undefined;
  const accountLogin = isRecord(account)
    ? readNonEmptyString(account.login)
    : undefined;
  const senderLogin = readNonEmptyString(sender.login);
  if (
    installationId === undefined ||
    !isRecord(account) ||
    accountId === undefined ||
    accountLogin === undefined ||
    accountLogin.length > 100 ||
    (account.type !== "User" && account.type !== "Organization") ||
    (installation.target_type !== "User" &&
      installation.target_type !== "Organization") ||
    !isRecord(installation.permissions) ||
    senderId === undefined ||
    senderLogin === undefined ||
    senderLogin.length > 100 ||
    sender.type !== "User"
  ) {
    console.warn(
      "Ignoring installation repositories event with invalid metadata",
    );
    return undefined;
  }

  const existing = await ctx.runQuery(
    internal.github.internalQuery.getInstallationByInstallationId,
    { installationId },
  );
  if (existing) {
    return { installationId, reconciliationStarted: false };
  }

  if (
    (payload.repository_selection !== "all" &&
      payload.repository_selection !== "selected") ||
    installation.target_type !== account.type ||
    (account.type === "User" && accountId !== senderId) ||
    !hasValidChangedRepositoryMetadata(
      payload,
      accountId,
      accountLogin,
      account.type,
    )
  ) {
    console.warn(
      "Ignoring unknown installation repositories event with mismatched repository metadata",
    );
    return undefined;
  }

  const userId = await ctx.runQuery(
    internal.github.internalQuery.getUserIdByGithubAccountId,
    { githubAccountId: senderId.toString() },
  );
  if (!userId) {
    console.warn(
      "Ignoring unknown installation repositories event without a matching GitHub account",
    );
    return undefined;
  }

  const result = await ctx.runMutation(
    internal.github.internalMutation.saveInstallation,
    {
      userId,
      installationId,
      accountLogin,
      accountType: account.type,
      targetType: installation.target_type,
      permissions: installation.permissions,
      ownerGithubAccountId: senderId.toString(),
      startRepositoryAccessReconciliation: true,
    },
  );
  if (result.status !== "created" && result.status !== "updated") {
    console.warn(
      "Ignoring installation repositories recovery after ownership changed",
    );
    return undefined;
  }

  console.log(
    "Installation ownership recovered from signed repository access event",
  );
  return { installationId, reconciliationStarted: true };
}

function hasValidChangedRepositoryMetadata(
  payload: Record<string, unknown>,
  accountId: number,
  accountLogin: string,
  accountType: "User" | "Organization",
): boolean {
  const changedRepositories =
    payload.action === "added"
      ? payload.repositories_added
      : payload.repositories_removed;
  if (!Array.isArray(changedRepositories) || changedRepositories.length === 0) {
    return false;
  }

  const normalizedAccountLogin = accountLogin.toLowerCase();
  return changedRepositories.every((repository) => {
    if (!isRecord(repository)) return false;
    const repositoryId = readPositiveSafeInteger(repository.id);
    const repositoryName = readNonEmptyString(repository.name);
    const fullName = readNonEmptyString(repository.full_name);
    const owner = repository.owner;
    if (
      repositoryId === undefined ||
      repositoryName === undefined ||
      repositoryName.length > 100 ||
      fullName === undefined ||
      fullName.length > 201 ||
      !isRecord(owner) ||
      readPositiveSafeInteger(owner.id) !== accountId ||
      readNonEmptyString(owner.login)?.toLowerCase() !==
        normalizedAccountLogin ||
      owner.type !== accountType
    ) {
      return false;
    }
    const parts = fullName.split("/");
    return (
      parts.length === 2 &&
      parts[0].toLowerCase() === normalizedAccountLogin &&
      parts[1] === repositoryName
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readPositiveSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

type DirectGitHubUser = {
  id: number;
  login: string;
};

function readDirectGitHubUser(value: unknown): DirectGitHubUser | undefined {
  if (!isRecord(value) || value.type !== "User") return undefined;
  const id = readPositiveSafeInteger(value.id);
  const login = readNonEmptyString(value.login);
  return id !== undefined && login !== undefined ? { id, login } : undefined;
}

async function getLegallyEligibleDirectRequester(
  ctx: ActionCtx,
  sender: DirectGitHubUser,
): Promise<Id<"users"> | null> {
  return await ctx.runQuery(
    internal.github.internalQuery.getLegallyEligibleUserIdByGithubAccountId,
    { githubAccountId: sender.id.toString() },
  );
}

function readGitHubStateUpdatedAt(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function readGitHubTicketState(value: unknown): "open" | "closed" | undefined {
  return value === "open" || value === "closed" ? value : undefined;
}

async function resolveCommentHistoryRepositoryAccess(
  ctx: ActionCtx,
  repositoryId: Id<"repositories"> | undefined,
  expectedInstallationId: number,
  expectedGithubRepositoryId: number,
): Promise<VerifiedRepositoryAccess> {
  if (
    repositoryId === undefined ||
    readPositiveSafeInteger(expectedInstallationId) === undefined ||
    readPositiveSafeInteger(expectedGithubRepositoryId) === undefined
  ) {
    throw new Error("Webhook repository identity is invalid");
  }

  const access = await resolveVerifiedRepositoryAccess(ctx, repositoryId);
  if (
    access.installation.installationId !== expectedInstallationId ||
    access.githubRepositoryId !== expectedGithubRepositoryId
  ) {
    throw new Error("Webhook repository identity no longer matches");
  }
  return access;
}

function readChangedString(value: unknown): string | undefined {
  return isRecord(value) ? readNonEmptyString(value.from) : undefined;
}

function readChangedOwner(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const from = value.from;
  if (typeof from === "string") {
    return readNonEmptyString(from);
  }
  if (!isRecord(from)) {
    return undefined;
  }
  const directLogin = readNonEmptyString(from.login);
  if (directLogin) {
    return directLogin;
  }
  const user = isRecord(from.user) ? from.user : undefined;
  const organization = isRecord(from.organization)
    ? from.organization
    : undefined;
  return (
    readNonEmptyString(user?.login) ?? readNonEmptyString(organization?.login)
  );
}

function getPreviousGitHubRepo(
  payload: Record<string, unknown>,
  githubRepo: string,
): string | undefined {
  const changes = isRecord(payload.changes) ? payload.changes : undefined;
  if (!changes) {
    return undefined;
  }
  const repositoryChanges = isRecord(changes.repository)
    ? changes.repository
    : undefined;
  const [currentOwner, currentName] = githubRepo.split("/");
  if (!currentOwner || !currentName) {
    return undefined;
  }
  const previousOwner =
    readChangedOwner(changes.owner) ??
    readChangedOwner(repositoryChanges?.owner) ??
    currentOwner;
  const previousName =
    readChangedString(repositoryChanges?.name) ??
    readChangedString(changes.name) ??
    currentName;
  const previousGitHubRepo = `${previousOwner}/${previousName}`;
  return previousGitHubRepo === githubRepo ? undefined : previousGitHubRepo;
}

async function gateInstallationAccessStateForAttestation(
  ctx: ActionCtx,
  installationId: number,
): Promise<void> {
  await ctx.runMutation(
    internal.github.internalMutation
      .beginInstallationWebhookAccessStateAttestation,
    { installationId },
  );
}

async function fetchLiveRepositoryMetadataById(
  installationId: number,
  githubRepositoryId: number,
): Promise<Record<string, unknown>> {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) {
    throw new Error("GitHub App credentials not configured");
  }

  const token = await getRepositoryInstallationToken(
    installationId,
    githubRepositoryId,
    appId,
    privateKey,
  );
  const repository = await fetchGitHubAppJsonWithRetry<unknown>(
    `https://api.github.com/repositories/${githubRepositoryId}`,
    token,
    "GitHub repository identity reconciliation",
  );
  if (
    !isRecord(repository) ||
    readPositiveSafeInteger(repository.id) !== githubRepositoryId ||
    !readNonEmptyString(repository.full_name)
  ) {
    throw new Error("GitHub repository identity response was invalid");
  }
  return repository;
}

/** Revoke cached free policy for repositories already pinned by numeric ID. */
export async function handleRepositoryEvent(
  ctx: ActionCtx,
  payload: Record<string, unknown>,
): Promise<void> {
  console.log("Repository event:", payload.action);

  const repositoryPayload = payload.repository;
  const installationPayload = payload.installation;
  if (!isRecord(repositoryPayload) || !isRecord(installationPayload)) {
    console.warn("Ignoring repository event with missing repository metadata");
    return;
  }

  const eventGithubRepo = readNonEmptyString(repositoryPayload.full_name);
  const githubRepositoryId = readPositiveSafeInteger(repositoryPayload.id);
  const installationId = readPositiveSafeInteger(installationPayload.id);
  if (
    !eventGithubRepo ||
    githubRepositoryId === undefined ||
    installationId === undefined
  ) {
    console.warn("Ignoring repository event with invalid identifiers");
    return;
  }

  const verifiedInstallation = await ctx.runQuery(
    internal.github.internalQuery.getRepositoryMetadataWebhookInstallation,
    { installationId },
  );
  if (!verifiedInstallation) {
    console.warn("Ignoring repository event for an unverified installation");
    return;
  }

  let authoritativeRepositoryPayload = repositoryPayload;
  let githubRepo = eventGithubRepo;
  let liveIdentityVerified = false;
  if (payload.action === "renamed" || payload.action === "transferred") {
    try {
      authoritativeRepositoryPayload = await fetchLiveRepositoryMetadataById(
        installationId,
        githubRepositoryId,
      );
      githubRepo = readNonEmptyString(
        authoritativeRepositoryPayload.full_name,
      )!;
      liveIdentityVerified = true;
    } catch (error) {
      console.warn("Unable to reconcile live repository identity", {
        githubRepositoryId,
      });
      await ctx.runMutation(
        internal.github.internalMutation.startRepositoryAccessReconciliation,
        { installationId, expectedAccessSuspendedAt: null },
      );
      throw error;
    }
  }

  const identityMatch = await ctx.runQuery(
    internal.repositories.internalQuery.getByInstallationAndGitHubRepositoryId,
    { installationId, githubRepositoryId },
  );
  if (payload.action === "deleted") {
    if (
      !identityMatch ||
      identityMatch.userId !== verifiedInstallation.userId
    ) {
      return;
    }
    try {
      await fetchLiveRepositoryMetadataById(installationId, githubRepositoryId);
      console.log("Ignoring stale deletion for a live repository", {
        githubRepositoryId,
      });
      return;
    } catch {
      console.warn(
        "Unable to confirm repository deletion; starting authoritative reconciliation",
        { githubRepositoryId },
      );
      await ctx.runMutation(
        internal.github.internalMutation.startRepositoryRemovalReconciliation,
        { installationId },
      );
      return;
    }
  }
  const repositories =
    identityMatch?.userId === verifiedInstallation.userId
      ? [identityMatch]
      : [];
  if (repositories.length === 0) {
    return;
  }

  const currentMetadata = normalizeGitHubRepositoryEmbeddingMetadata(
    authoritativeRepositoryPayload,
  );
  const previousGithubRepo = getPreviousGitHubRepo(payload, eventGithubRepo);
  for (const repository of repositories) {
    const result = await ctx.runMutation(
      internal.repositories.internalMutation.applyRepositoryWebhookUpdate,
      {
        repositoryId: repository._id,
        expectedGithubRepo: repository.githubRepo,
        githubRepositoryId,
        installationId,
        githubRepo,
        ...(liveIdentityVerified ? { liveIdentityVerified: true } : {}),
        ...(previousGithubRepo ? { previousGithubRepo } : {}),
        githubVisibility: currentMetadata.githubVisibility ?? null,
        licenseKey: currentMetadata.licenseKey ?? null,
        licenseSpdxId: currentMetadata.licenseSpdxId ?? null,
      },
    );
    if (!result.persisted) {
      const latestRepository = await ctx.runQuery(
        internal.repositories.internalQuery
          .getByInstallationAndGitHubRepositoryId,
        { installationId, githubRepositoryId },
      );
      if (latestRepository?._id === repository._id) {
        const retry = await ctx.runMutation(
          internal.repositories.internalMutation.applyRepositoryWebhookUpdate,
          {
            repositoryId: latestRepository._id,
            expectedGithubRepo: latestRepository.githubRepo,
            githubRepositoryId,
            installationId,
            githubRepo: latestRepository.githubRepo,
            ...(liveIdentityVerified ? { liveIdentityVerified: true } : {}),
            githubVisibility: currentMetadata.githubVisibility ?? null,
            licenseKey: currentMetadata.licenseKey ?? null,
            licenseSpdxId: currentMetadata.licenseSpdxId ?? null,
          },
        );
        if (retry.persisted) {
          continue;
        }
      }
      console.warn("Repository changed while applying signed metadata update");
    }
  }
}

/**
 * Handle GitHub issues event (issue opened/edited/closed)
 * Creates tickets and processes with Issue Assistant
 */
export async function handleIssuesEvent(
  ctx: ActionCtx,
  payload: Record<string, unknown>,
): Promise<void> {
  console.log("Issues event:", payload.action);

  const issue = payload.issue as {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    user: { login: string };
    state?: unknown;
    updated_at?: unknown;
  };
  const repository = payload.repository as {
    id: number;
    full_name: string;
  };
  const installation = payload.installation as {
    id: number;
  };
  const githubStateUpdatedAt = readGitHubStateUpdatedAt(issue.updated_at);
  const githubState = readGitHubTicketState(issue.state);
  const sender = payload.sender as
    { login?: unknown; type?: unknown } | undefined;
  const trustedExecutionKey =
    payload.action === "edited" &&
    typeof sender?.login === "string" &&
    sender.type === "Bot" &&
    isGitdogBot(sender.login)
      ? extractExecutionMarkerKey(issue.body ?? "")
      : null;

  if (payload.action === "opened" || payload.action === "edited") {
    // Handle issue with ticket system in background
    console.log("Scheduling ticket creation for:", {
      githubRepositoryId: repository.id,
      relatedIssue: issue.number,
    });

    await ctx.scheduler.runAfter(
      0,
      internal.tickets.internalMutation.createFromGithubIssue,
      {
        installationId: installation.id,
        githubRepositoryId: repository.id,
        repositoryFullName: repository.full_name,
        issueNumber: issue.number,
        issueTitle: issue.title,
        issueBody: issue.body || undefined,
        issueUrl: issue.html_url,
        issueAuthor: issue.user.login,
        action: payload.action as string,
        ...(trustedExecutionKey ? { trustedExecutionKey } : {}),
        ...(githubState !== undefined ? { githubState } : {}),
        ...(githubStateUpdatedAt !== undefined ? { githubStateUpdatedAt } : {}),
      },
    );

    console.log("Ticket creation scheduled successfully");
  } else if (payload.action === "closed") {
    // Handle issue closed - close the ticket
    console.log("Issue closed:", {
      githubRepositoryId: repository.id,
      issueNumber: issue.number,
    });

    await ctx.scheduler.runAfter(
      0,
      internal.tickets.internalMutation.closeByGithubNumber,
      {
        installationId: installation.id,
        githubRepositoryId: repository.id,
        repositoryFullName: repository.full_name,
        githubNumber: issue.number,
        ticketType: "issue",
        ...(githubStateUpdatedAt !== undefined ? { githubStateUpdatedAt } : {}),
      },
    );

    console.log("Ticket close scheduled successfully");
  } else if (payload.action === "reopened") {
    await ctx.scheduler.runAfter(
      0,
      internal.tickets.internalMutation.reopenByGithubNumber,
      {
        installationId: installation.id,
        githubRepositoryId: repository.id,
        repositoryFullName: repository.full_name,
        githubNumber: issue.number,
        ticketType: "issue",
        ...(githubStateUpdatedAt !== undefined ? { githubStateUpdatedAt } : {}),
      },
    );

    console.log("Ticket reopen scheduled successfully");
  }
}

/**
 * Handle GitHub issue_comment event
 * Creates follow-up actions for existing tickets with previous comment history
 */
export async function handleIssueCommentEvent(
  ctx: ActionCtx,
  payload: Record<string, unknown>,
): Promise<void> {
  console.log("Issue comment event:", payload.action);
  if (isRecord(payload.issue) && payload.issue.pull_request !== undefined)
    return;

  // Handle deleted bot comments (feedback loop for learning)
  if (payload.action === "deleted") {
    await handleDeletedBotComment(ctx, payload);
    return;
  }

  // Only handle new comments (not edited)
  if (payload.action !== "created") {
    return;
  }

  const comment = payload.comment as {
    id: number;
    body: string;
    user: { id: number; login: string; type: string };
    author_association: string; // OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, etc.
  };
  const issue = payload.issue as {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
  };
  const repository = payload.repository as {
    id: number;
    full_name: string;
  };
  const installation = payload.installation as { id: number };

  // Ignore comments from bots (including our own)
  if (comment.user.type === "Bot") {
    console.log("Ignoring bot comment");
    return;
  }

  if (!hasGitdogMentionBody(comment.body)) {
    console.log("Comment does not mention an active Gitdog bot, skipping");
    return;
  }

  console.log("Comment mentions an active Gitdog bot, processing...");

  const sender = readDirectGitHubUser(payload.sender);
  if (!sender || readPositiveSafeInteger(comment.user.id) !== sender.id) {
    console.warn("Ignoring issue comment with an invalid direct requester");
    return;
  }
  const requestedByUserId = await getLegallyEligibleDirectRequester(
    ctx,
    sender,
  );
  if (!requestedByUserId) {
    console.warn("Ignoring issue comment from an ineligible Gitdog account");
    return;
  }

  // Check if we have an existing ticket for this issue
  const existingTicket = await ctx.runMutation(
    internal.tickets.internalMutation.getByGithubNumberFromWebhook,
    {
      installationId: installation.id,
      githubRepositoryId: repository.id,
      repositoryFullName: repository.full_name,
      githubNumber: issue.number,
      ticketType: "issue",
    },
  );

  if (!existingTicket) {
    console.log(
      `No existing ticket for issue #${issue.number}, skipping comment`,
    );
    return;
  }

  const verifiedAccess = await resolveCommentHistoryRepositoryAccess(
    ctx,
    existingTicket.repositoryId,
    installation.id,
    repository.id,
  );

  console.log(
    `Found existing ticket for issue #${issue.number}, processing follow-up comment`,
  );

  // Fetch previous comments from GitHub (up to 5)
  let previousComments: Array<{
    id: number | string;
    body: string;
    author: string;
    authorRole: string; // OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE
    isGitdogBot: boolean;
    createdAt: string;
  }> = [];

  try {
    const comments = await getIssueComments(
      verifiedAccess.owner,
      verifiedAccess.repo,
      issue.number,
      verifiedAccess.token,
      {
        limit: 6, // Get 6 to account for current comment
      },
    );

    previousComments = comments
      .filter((c) => c.id !== comment.id) // Exclude current comment
      .slice(-5) // Take last 5
      .map((c) => ({
        id: c.id,
        body: c.body,
        author: c.user.login,
        authorRole: c.author_association || "NONE",
        isGitdogBot: isGitdogBot(c.user.login),
        createdAt: c.created_at,
      }));

    console.log(
      `Fetched ${previousComments.length} previous comments for issue #${issue.number}`,
    );
  } catch {
    console.error("Failed to fetch previous issue comments");
    // Continue without previous comments
  }

  // Create the follow-up action with previous comments
  // Note: Issue comments don't have node_id for reply, only discussion comments do
  const actionId = await ctx.runMutation(
    internal.ticketActions.internalMutation.createFollowUp,
    {
      ticketId: existingTicket._id,
      commentId: comment.id,
      requestedByUserId,
      commentBody: comment.body,
      commentAuthor: comment.user.login,
      commentAuthorRole: comment.author_association,
      previousComments,
    },
  );

  if (!actionId) {
    console.log("Duplicate issue comment delivery, skipping AI processing");
    return;
  }

  console.log("Follow-up action created and processing scheduled:", actionId);
}

/**
 * Handle GitHub discussion event (discussion opened/edited/closed)
 * Creates tickets and processes with Discussion Assistant
 */
export async function handleDiscussionEvent(
  ctx: ActionCtx,
  payload: Record<string, unknown>,
): Promise<void> {
  console.log("Discussion event:", payload.action);

  const discussion = payload.discussion as {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    user: { login: string };
    state?: unknown;
    updated_at?: unknown;
  };
  const repository = payload.repository as {
    id: number;
    full_name: string;
  };
  const installation = payload.installation as {
    id: number;
  };
  const githubStateUpdatedAt = readGitHubStateUpdatedAt(discussion.updated_at);
  const githubState = readGitHubTicketState(discussion.state);
  const sender = payload.sender as
    { login?: unknown; type?: unknown } | undefined;
  const trustedExecutionKey =
    payload.action === "edited" &&
    typeof sender?.login === "string" &&
    sender.type === "Bot" &&
    isGitdogBot(sender.login)
      ? extractExecutionMarkerKey(discussion.body ?? "")
      : null;

  if (payload.action === "created" || payload.action === "edited") {
    // Handle discussion with ticket system in background
    console.log("Scheduling ticket creation for:", {
      githubRepositoryId: repository.id,
      relatedDiscussion: discussion.number,
    });

    await ctx.scheduler.runAfter(
      0,
      internal.tickets.internalMutation.createFromGithubDiscussion,
      {
        installationId: installation.id,
        githubRepositoryId: repository.id,
        repositoryFullName: repository.full_name,
        discussionNumber: discussion.number,
        discussionTitle: discussion.title,
        discussionBody: discussion.body || undefined,
        discussionUrl: discussion.html_url,
        discussionAuthor: discussion.user.login,
        action: payload.action as string,
        ...(trustedExecutionKey ? { trustedExecutionKey } : {}),
        ...(githubState !== undefined ? { githubState } : {}),
        ...(githubStateUpdatedAt !== undefined ? { githubStateUpdatedAt } : {}),
      },
    );

    console.log("Ticket creation scheduled successfully");
  } else if (payload.action === "closed" || payload.action === "deleted") {
    // Handle discussion closed - close the ticket
    console.log("Discussion closed:", {
      githubRepositoryId: repository.id,
      discussionNumber: discussion.number,
    });

    await ctx.scheduler.runAfter(
      0,
      internal.tickets.internalMutation.closeByGithubNumber,
      {
        installationId: installation.id,
        githubRepositoryId: repository.id,
        repositoryFullName: repository.full_name,
        githubNumber: discussion.number,
        ticketType: "discussion",
        ...(githubStateUpdatedAt !== undefined ? { githubStateUpdatedAt } : {}),
      },
    );

    console.log("Ticket close scheduled successfully");
  } else if (payload.action === "reopened") {
    await ctx.scheduler.runAfter(
      0,
      internal.tickets.internalMutation.reopenByGithubNumber,
      {
        installationId: installation.id,
        githubRepositoryId: repository.id,
        repositoryFullName: repository.full_name,
        githubNumber: discussion.number,
        ticketType: "discussion",
        ...(githubStateUpdatedAt !== undefined ? { githubStateUpdatedAt } : {}),
      },
    );

    console.log("Ticket reopen scheduled successfully");
  }
}

/**
 * Handle GitHub push event (commits pushed to repository)
 * Triggers re-indexing for the repository
 */
export async function handlePushEvent(
  ctx: ActionCtx,
  payload: Record<string, unknown>,
): Promise<void> {
  console.log("Push event received");

  const repository = payload.repository;
  const installation = payload.installation;
  const ref = readNonEmptyString(payload.ref);
  const after = readNonEmptyString(payload.after);
  const commits = payload.commits;
  if (
    !isRecord(repository) ||
    !isRecord(installation) ||
    !ref ||
    !Array.isArray(commits)
  ) {
    console.warn("Ignoring push event with invalid metadata");
    return;
  }
  const githubRepositoryId = readPositiveSafeInteger(repository.id);
  const installationId = readPositiveSafeInteger(installation.id);
  const githubRepo = readNonEmptyString(repository.full_name);
  const defaultBranch = readNonEmptyString(repository.default_branch);
  if (
    githubRepositoryId === undefined ||
    installationId === undefined ||
    !githubRepo ||
    !defaultBranch
  ) {
    console.warn("Ignoring push event with invalid repository identity");
    return;
  }

  console.log("Push event details:", {
    githubRepositoryId,
    commitCount: commits?.length || 0,
  });

  // Only trigger re-indexing for pushes to default branch
  const defaultBranchRef = `refs/heads/${defaultBranch}`;
  if (ref !== defaultBranchRef) {
    console.log(
      "Push does not target the default branch; skipping re-indexing",
      {
        githubRepositoryId,
      },
    );
    return;
  }

  // A force-reset can legitimately contain no newly introduced commits while
  // still changing the branch head. Only an actual ref deletion is a no-op.
  if (payload.deleted === true || (after !== undefined && /^0+$/.test(after))) {
    console.log("Default branch ref was deleted, skipping re-indexing");
    return;
  }

  console.log("Default-branch push is triggering re-indexing", {
    githubRepositoryId,
    commitCount: commits.length,
  });

  // Trigger incremental indexing
  await ctx.scheduler.runAfter(
    0,
    internal.repoIndexing.internalAction.triggerIncrementalIndex,
    {
      repositoryFullName: githubRepo,
      installationId,
      githubRepositoryId,
      reason: "push",
      ...(/^[a-f0-9]{40}$/i.test(after ?? "")
        ? { source: { commitSha: after!.toLowerCase(), defaultBranch } }
        : {}),
    },
  );

  console.log("Re-indexing scheduled for push event");
}

/**
 * Handle GitHub discussion_comment event
 * Creates follow-up actions for existing tickets with previous comment history
 */
export async function handleDiscussionCommentEvent(
  ctx: ActionCtx,
  payload: Record<string, unknown>,
): Promise<void> {
  console.log("Discussion comment event:", payload.action);

  // Only handle new comments (not edited or deleted)
  if (payload.action !== "created") {
    return;
  }

  const comment = payload.comment as {
    id: number;
    body: string;
    user: { id: number; login: string; type: string };
    node_id?: string;
    author_association: string; // OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, etc.
  };
  const discussion = payload.discussion as {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
  };
  const repository = payload.repository as {
    id: number;
    full_name: string;
  };
  const installation = payload.installation as {
    id: number;
  };

  // Ignore comments from bots (including our own)
  if (comment.user.type === "Bot") {
    console.log("Ignoring bot comment");
    return;
  }

  if (!hasGitdogMentionBody(comment.body)) {
    console.log("Comment does not mention an active Gitdog bot, skipping");
    return;
  }

  console.log("Comment mentions an active Gitdog bot, processing...");

  const sender = readDirectGitHubUser(payload.sender);
  if (!sender || readPositiveSafeInteger(comment.user.id) !== sender.id) {
    console.warn(
      "Ignoring discussion comment with an invalid direct requester",
    );
    return;
  }
  const requestedByUserId = await getLegallyEligibleDirectRequester(
    ctx,
    sender,
  );
  if (!requestedByUserId) {
    console.warn(
      "Ignoring discussion comment from an ineligible Gitdog account",
    );
    return;
  }

  // Check if we have an existing ticket for this discussion
  const existingTicket = await ctx.runMutation(
    internal.tickets.internalMutation.getByGithubNumberFromWebhook,
    {
      installationId: installation.id,
      githubRepositoryId: repository.id,
      repositoryFullName: repository.full_name,
      githubNumber: discussion.number,
      ticketType: "discussion",
    },
  );

  if (!existingTicket) {
    console.log(
      `No existing ticket for discussion #${discussion.number}, skipping comment`,
    );
    return;
  }

  const verifiedAccess = await resolveCommentHistoryRepositoryAccess(
    ctx,
    existingTicket.repositoryId,
    installation.id,
    repository.id,
  );

  console.log(
    `Found existing ticket for discussion #${discussion.number}, processing follow-up comment`,
  );

  // Fetch previous comments from GitHub (up to 5)
  let previousComments: Array<{
    id: number | string;
    body: string;
    author: string;
    authorRole: string; // OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE
    isGitdogBot: boolean;
    createdAt: string;
  }> = [];

  try {
    const comments = await getDiscussionComments(
      verifiedAccess.owner,
      verifiedAccess.repo,
      discussion.number,
      verifiedAccess.token,
      {
        limit: 6, // Get 6 to account for current comment
        currentCommentNodeId: comment.node_id,
      },
    );

    // Use node_id for comparison if available, otherwise use id
    const currentCommentId = comment.node_id || String(comment.id);

    previousComments = comments
      .filter((c) => c.id !== currentCommentId) // Exclude current comment
      .slice(-5) // Take last 5
      .map((c) => ({
        id: c.id,
        body: c.body,
        author: c.author?.login || "unknown",
        authorRole: c.authorAssociation || "NONE",
        isGitdogBot: isGitdogBot(c.author?.login),
        createdAt: c.createdAt,
      }));

    console.log(
      `Fetched ${previousComments.length} previous comments for discussion #${discussion.number}`,
    );
  } catch {
    console.error("Failed to fetch previous discussion comments");
    // Continue without previous comments
  }

  // Create the follow-up action with previous comments
  // Pass node_id for discussion comments to enable threaded replies
  const actionId = await ctx.runMutation(
    internal.ticketActions.internalMutation.createFollowUp,
    {
      ticketId: existingTicket._id,
      commentId: comment.id,
      requestedByUserId,
      commentNodeId: comment.node_id, // GraphQL node ID for replying to this comment
      commentBody: comment.body,
      commentAuthor: comment.user.login,
      commentAuthorRole: comment.author_association,
      previousComments,
    },
  );

  if (!actionId) {
    console.log(
      "Duplicate discussion comment delivery, skipping AI processing",
    );
    return;
  }

  console.log("Follow-up action created and processing scheduled:", actionId);
}

/**
 * Handle deleted bot comment events.
 * When a maintainer deletes a gitdog bot comment, this creates a negative learning
 * signal so the AI can improve future responses.
 */
export const DELETED_BOT_COMMENT_EMBEDDING_DATA_PROVENANCE =
  "private_user_input" as const;

async function handleDeletedBotComment(
  ctx: ActionCtx,
  payload: Record<string, unknown>,
): Promise<void> {
  const comment = payload.comment as {
    id: number;
    body?: string | null;
    user: { login: string; type: string };
  };
  const issue = payload.issue as {
    number: number;
    title: string;
  };
  const repository = payload.repository as {
    id: number;
    full_name: string;
  };
  const sender = readDirectGitHubUser(payload.sender);
  const installation = payload.installation as {
    id: number;
  };

  // Only care about our own bot comments being deleted
  if (comment.user.type !== "Bot") {
    return;
  }

  // Check if the deleted comment belongs to our bot
  const isBotComment = isGitdogBot(comment.user.login);

  if (!isBotComment) {
    return;
  }

  if (!sender) {
    console.warn(
      "[handleDeletedBotComment] Invalid direct requester, skipping learning",
    );
    return;
  }
  const requestedByUserId = await getLegallyEligibleDirectRequester(
    ctx,
    sender,
  );
  if (!requestedByUserId) {
    console.warn(
      "[handleDeletedBotComment] Deleter lacks current Gitdog eligibility, skipping learning",
    );
    return;
  }

  // A GitHub author association is not an authorization check. Resolve the
  // repository's push-capable maintainers and fail closed before allowing a
  // deletion event to create persistent learning data.
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  const [owner, repo] = repository.full_name.split("/");
  if (!appId || !privateKey || !installation?.id || !owner || !repo) {
    console.warn(
      "[handleDeletedBotComment] Unable to verify maintainer, skipping learning",
    );
    return;
  }

  try {
    const token = await getRepositoryInstallationToken(
      installation.id,
      repository.id,
      appId,
      privateKey,
    );
    const maintainers = await getRepositoryMaintainers(owner, repo, token);
    const normalizedSender = sender.login.toLowerCase();
    const isVerifiedMaintainer = maintainers.some(
      (login) => login.toLowerCase() === normalizedSender,
    );

    if (!isVerifiedMaintainer) {
      console.warn(
        "[handleDeletedBotComment] Requester is not a verified maintainer, skipping learning",
      );
      return;
    }
  } catch {
    console.error(
      "[handleDeletedBotComment] Maintainer verification failed, skipping learning",
    );
    return;
  }

  console.log("[handleDeletedBotComment] Bot comment was deleted", {
    githubRepositoryId: repository.id,
    issueNumber: issue.number,
    commentId: comment.id,
  });

  // Find the ticket for this issue
  const existingTicket = await ctx.runMutation(
    internal.tickets.internalMutation.getByGithubNumberFromWebhook,
    {
      installationId: installation.id,
      githubRepositoryId: repository.id,
      repositoryFullName: repository.full_name,
      githubNumber: issue.number,
      ticketType: "issue",
    },
  );

  if (!existingTicket || !existingTicket.repositoryId) {
    console.log("[handleDeletedBotComment] No ticket found, skipping");
    return;
  }

  // Find the action that posted this comment
  const deletedAction = await ctx.runQuery(
    internal.ticketActions.internalQuery.findByGithubCommentId,
    {
      ticketId: existingTicket._id,
      commentId: comment.id,
    },
  );

  if (!deletedAction) {
    console.log(
      "[handleDeletedBotComment] No matching action found for comment ID",
      comment.id,
    );
    return;
  }

  const deletedResponse =
    (deletedAction.proposedChanges as { suggestedResponse?: string })
      ?.suggestedResponse || "";
  const truncatedResponse =
    deletedResponse.length > 300
      ? deletedResponse.substring(0, 300) + "..."
      : deletedResponse;

  console.log(
    `[handleDeletedBotComment] Found deleted action ${deletedAction._id}, creating negative learning`,
  );

  // Create a learning entry that records the deletion as negative feedback
  const learningContent = `NEGATIVE FEEDBACK: A bot response was deleted by maintainer @${sender.login} on issue "${issue.title}" (#${issue.number}). The deleted response started with: "${truncatedResponse}". This indicates the response was unhelpful, incorrect, or inappropriate. Avoid generating similar responses for similar issues in this repository.`;

  try {
    await ctx.runAction(internal.repoLearnings.action.createLearning, {
      repositoryId: existingTicket.repositoryId,
      content: learningContent,
      source: `github.com/${repository.full_name}/issues/${issue.number}#deleted-comment-${comment.id}`,
      idempotencyKey: `deleted-bot-comment:${comment.id}`,
      sourceType: "correction",
      isTrusted: true,
      ticketId: existingTicket._id,
      requestedByUserId,
      embeddingDataProvenance: DELETED_BOT_COMMENT_EMBEDDING_DATA_PROVENANCE,
    });

    console.log(
      "[handleDeletedBotComment] Negative learning recorded successfully",
    );
  } catch {
    console.error("[handleDeletedBotComment] Failed to record learning");
  }
}
