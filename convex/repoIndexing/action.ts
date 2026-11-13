import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { GenericActionCtx } from "convex/server";
import {
  GitHubAppRateLimitError,
  getRepositoryInstallationToken,
  type GitHubTreeItem as BaseGitHubTreeItem,
} from "../github/helpers";
import { isGitHubInstallationReady } from "../github/installationAccess";
import {
  normalizeGitHubRepositoryEmbeddingMetadata,
  type RepositoryEmbeddingMetadata,
} from "../repositories/embeddingPolicy";
import {
  fetchOsiLicenseApproval,
  OSI_LICENSE_CACHE_MS,
} from "../repositories/osiLicense";
import {
  buildRepositoryTreeSnapshotPages,
  getIndexableRepositoryFiles,
  getRepositoryTreeSnapshotAppendBatch,
  REPOSITORY_TREE_SNAPSHOT_PAGE_SIZE,
  REPOSITORY_TREE_TRAVERSAL_ITEMS_PER_ACTION,
  type RepositoryTreeSnapshotFile,
} from "./treeSnapshot";

/**
 * Helper to create AI log for indexing operations
 */
async function createIndexingAiLog(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: GenericActionCtx<any>,
  args: {
    repositoryId: Id<"repositories">;
    userId?: Id<"users">;
    githubRepo: string;
    status: "success" | "failed";
    errorMessage?: string;
    durationMs?: number;
  },
) {
  await ctx.runMutation(internal.admin.internalMutation.createAiLog, {
    repositoryId: args.repositoryId,
    userId: args.userId,
    workflowType: "indexing",
    actionType: "index_repository",
    githubRepo: args.githubRepo,
    status: args.status,
    errorMessage: args.errorMessage,
    durationMs: args.durationMs,
  });
}

/**
 * Extended GitHubTreeItem with additional fields from GitHub API
 */
export type GitHubTreeItem = BaseGitHubTreeItem & {
  size?: number;
  url: string;
};

const FILE_INDEX_BATCH_SIZE = REPOSITORY_TREE_SNAPSHOT_PAGE_SIZE;
const FILE_INDEX_CONCURRENCY = 8;
const GITHUB_REQUEST_TIMEOUT_MS = 15_000;
const GITHUB_MAX_RETRIES = 2;
const GITHUB_MAX_RETRY_DELAY_MS = 5_000;
const GITHUB_MAX_RATE_LIMIT_DELAY_MS = 24 * 60 * 60 * 1_000;
const GITHUB_RATE_LIMIT_FALLBACK_DELAY_MS = 60_000;
const GITHUB_ERROR_BODY_LIMIT_BYTES = 16 * 1_024;
const TREE_RESPONSE_RETRY_BASE_DELAY_MS = 15_000;
const TREE_RESPONSE_RETRY_MAX_DELAY_MS = 5 * 60_000;
const TREE_RESPONSE_RETRY_MAX_ATTEMPT = 6;
type GitHubTokenProvider = () => Promise<string>;
type AuthoritativeRepositoryMetadata = RepositoryEmbeddingMetadata & {
  githubRepositoryId: number;
  githubRepo: string;
  defaultBranch: string;
};

type FileBlobPublicationIdentity = {
  expectedUserId: Id<"users">;
  expectedInstallationId: number;
  expectedGithubRepositoryId: number;
  expectedGithubRepo: string;
};

type IndexRetryContinuation = {
  continuation?: boolean;
  treeTraversal?: boolean;
  pageIndex?: number;
  treeSnapshotId?: Id<"repoTreeSnapshots">;
  fileOffset?: number;
};

type IndexTreeTraversalClaim = {
  snapshotId: Id<"repoTreeSnapshots">;
  claimToken: string;
};

class IndexTreeTraversalClaimedError extends Error {
  constructor(
    readonly originalError: unknown,
    readonly claim: IndexTreeTraversalClaim,
  ) {
    super(
      originalError instanceof Error
        ? originalError.message
        : "Repository tree traversal failed",
    );
    this.name = "IndexTreeTraversalClaimedError";
  }
}

class RetryableTreeTraversalResponseError extends Error {
  constructor(
    message: string,
    readonly requestedRetryAt?: number,
  ) {
    super(message);
    this.name = "RetryableTreeTraversalResponseError";
  }
}

class GitHubRateLimitError extends Error {
  constructor(
    operation: string,
    readonly retryAt: number,
    readonly fileOffset?: number,
  ) {
    super(`${operation} was rate limited by GitHub`);
    this.name = "GitHubRateLimitError";
  }
}

export class GitHubInstallationDeferredError extends Error {
  readonly retryAt: number;

  constructor(message: string) {
    super(message);
    this.name = "GitHubInstallationDeferredError";
    this.retryAt = Date.now() + 5 * 60 * 1_000;
  }
}

function getNextTreeResponseRetry(
  error: RetryableTreeTraversalResponseError,
  attempt?: number,
): { attempt: number; retryAt: number } | null {
  const currentAttempt =
    attempt !== undefined && Number.isSafeInteger(attempt) && attempt >= 0
      ? Math.min(attempt, TREE_RESPONSE_RETRY_MAX_ATTEMPT)
      : 0;
  if (currentAttempt >= TREE_RESPONSE_RETRY_MAX_ATTEMPT) {
    return null;
  }

  const nextAttempt = currentAttempt + 1;
  const now = Date.now();
  const retryDelayMs = Math.min(
    TREE_RESPONSE_RETRY_MAX_DELAY_MS,
    TREE_RESPONSE_RETRY_BASE_DELAY_MS * 2 ** Math.min(nextAttempt - 1, 5),
  );
  return {
    attempt: nextAttempt,
    retryAt: Math.min(
      now + TREE_RESPONSE_RETRY_MAX_DELAY_MS,
      Math.max(now + retryDelayMs, error.requestedRetryAt ?? 0),
    ),
  };
}

export function assertMapFilePublished(result: {
  status: "mapped" | "deferred";
}): void {
  if (result.status === "deferred") {
    throw new GitHubInstallationDeferredError(
      "GitHub installation access changed while mapping repository files",
    );
  }
}

async function isInstallationAccessDeferred(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: GenericActionCtx<any>,
  installationId: number,
  expectedUserId: Id<"users">,
): Promise<boolean> {
  const installation = await ctx.runQuery(
    internal.github.internalQuery.getInstallationByInstallationId,
    { installationId },
  );
  return (
    installation?.userId === expectedUserId &&
    !isGitHubInstallationReady(installation)
  );
}

function getGitHubRetryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const retryAt = Date.parse(retryAfter);
    const requestedDelay = Number.isFinite(seconds)
      ? seconds * 1000
      : Number.isNaN(retryAt)
        ? 0
        : retryAt - Date.now();
    return Math.min(GITHUB_MAX_RETRY_DELAY_MS, Math.max(0, requestedDelay));
  }

  return Math.min(GITHUB_MAX_RETRY_DELAY_MS, 1000 * 2 ** attempt);
}

async function readBoundedGitHubErrorBody(response: Response): Promise<string> {
  let clonedResponse: Response;
  try {
    clonedResponse = response.clone();
  } catch {
    return "";
  }

  const reader = clonedResponse.body?.getReader();
  if (!reader) {
    return "";
  }

  const decoder = new TextDecoder();
  let remaining = GITHUB_ERROR_BODY_LIMIT_BYTES;
  let body = "";
  try {
    while (remaining > 0) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      const bytes = chunk.value.subarray(
        0,
        Math.min(chunk.value.byteLength, remaining),
      );
      body += decoder.decode(bytes, { stream: true });
      remaining -= bytes.byteLength;
      if (bytes.byteLength < chunk.value.byteLength) {
        break;
      }
    }
    body += decoder.decode();
    return body;
  } catch {
    return "";
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The cloned response may already be closed.
    }
  }
}

function isGitHubSecondaryRateLimitBody(body: string): boolean {
  let message = body;
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "message" in parsed &&
      typeof parsed.message === "string"
    ) {
      message = parsed.message;
    }
  } catch {
    // GitHub may return a plain-text error body.
  }

  const normalizedMessage = message.toLowerCase();
  return (
    normalizedMessage.includes("secondary rate limit") ||
    normalizedMessage.includes("abuse detection mechanism")
  );
}

function getGitHubHeaderRetryAt(
  response: Response,
  now: number,
): number | undefined {
  const retryAfter = response.headers.get("retry-after");
  const resetSeconds = Number(response.headers.get("x-ratelimit-reset"));
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      return now + seconds * 1_000;
    }
    if (!Number.isNaN(retryAt) && retryAt > now) {
      return retryAt;
    }
  }
  if (
    response.headers.get("x-ratelimit-remaining") === "0" &&
    Number.isFinite(resetSeconds) &&
    resetSeconds * 1_000 > now
  ) {
    return resetSeconds * 1_000;
  }
  return undefined;
}

export async function getGitHubRateLimitRetryAt(
  response: Response,
  now = Date.now(),
): Promise<number | null> {
  if (response.status !== 403 && response.status !== 429) {
    return null;
  }

  const hasRateLimitHeaders =
    response.headers.has("retry-after") ||
    response.headers.get("x-ratelimit-remaining") === "0";
  const isRateLimited =
    response.status === 429 ||
    hasRateLimitHeaders ||
    (response.status === 403 &&
      isGitHubSecondaryRateLimitBody(
        await readBoundedGitHubErrorBody(response),
      ));
  if (!isRateLimited) {
    return null;
  }

  const requestedRetryAt =
    getGitHubHeaderRetryAt(response, now) ??
    now + GITHUB_RATE_LIMIT_FALLBACK_DELAY_MS;
  return Math.min(
    now + GITHUB_MAX_RATE_LIMIT_DELAY_MS,
    Math.max(now + 1_000, requestedRetryAt),
  );
}

async function fetchGitHub(
  url: string,
  token: string,
  operation: string,
): Promise<Response> {
  for (let attempt = 0; attempt <= GITHUB_MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "Gitdog",
        },
        signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
      });

      const rateLimitRetryAt = await getGitHubRateLimitRetryAt(response);
      if (rateLimitRetryAt !== null) {
        await response.body?.cancel();
        throw new GitHubRateLimitError(operation, rateLimitRetryAt);
      }

      if (response.status < 500) {
        return response;
      }

      if (attempt === GITHUB_MAX_RETRIES) {
        return response;
      }

      await response.body?.cancel();
      await new Promise((resolve) =>
        setTimeout(resolve, getGitHubRetryDelayMs(response, attempt)),
      );
    } catch (error) {
      if (error instanceof GitHubRateLimitError) {
        throw error;
      }
      if (attempt === GITHUB_MAX_RETRIES) {
        throw new Error(
          `${operation} failed after ${GITHUB_MAX_RETRIES + 1} attempts: ${error instanceof Error ? error.message : "unknown error"}`,
          { cause: error },
        );
      }
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(GITHUB_MAX_RETRY_DELAY_MS, 1000 * 2 ** attempt),
        ),
      );
    }
  }

  throw new Error(`${operation} failed: retries exhausted`);
}

export function getRepositoryIndexBatch<T>(
  files: Array<T>,
  offset: number,
  batchSize = FILE_INDEX_BATCH_SIZE,
): { batch: Array<T>; nextOffset: number; totalFiles: number } {
  const safeOffset = Math.min(Math.max(0, offset), files.length);
  const safeBatchSize = Math.max(1, batchSize);
  const batch = files.slice(safeOffset, safeOffset + safeBatchSize);

  return {
    batch,
    nextOffset: safeOffset + batch.length,
    totalFiles: files.length,
  };
}

export function parseCompleteRepositoryTree(data: unknown): GitHubTreeItem[] {
  if (
    typeof data !== "object" ||
    data === null ||
    !("tree" in data) ||
    !Array.isArray(data.tree)
  ) {
    throw new Error("Invalid repository tree response from GitHub");
  }
  if ("truncated" in data && data.truncated === true) {
    throw new Error(
      "GitHub returned a truncated repository tree; refusing to replace a complete index with partial data",
    );
  }

  return data.tree as GitHubTreeItem[];
}

function isTruncatedRepositoryTree(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    "truncated" in data &&
    data.truncated === true
  );
}

export async function persistRepositoryTreeSnapshot(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: GenericActionCtx<any>,
  args: {
    repositoryId: Id<"repositories">;
    expectedIndexVersion: number;
    defaultBranch: string;
    commitSha: string;
    treeSha: string;
    pages: Array<Array<RepositoryTreeSnapshotFile>>;
  },
): Promise<Id<"repoTreeSnapshots"> | null> {
  const totalFiles = args.pages.reduce((total, page) => total + page.length, 0);
  const begun = await ctx.runMutation(
    internal.repoIndexing.mutation.beginIndexTreeSnapshot,
    {
      repositoryId: args.repositoryId,
      expectedIndexVersion: args.expectedIndexVersion,
      defaultBranch: args.defaultBranch,
      commitSha: args.commitSha,
      treeSha: args.treeSha,
      totalFiles,
      totalPages: args.pages.length,
    },
  );
  if (!begun) {
    return null;
  }

  let nextPageIndex = begun.nextPageIndex;
  while (!begun.ready && nextPageIndex < args.pages.length) {
    const pages = getRepositoryTreeSnapshotAppendBatch(
      args.pages,
      nextPageIndex,
    );
    if (pages.length === 0) {
      throw new Error("repository tree snapshot append made no progress");
    }
    const appended = await ctx.runMutation(
      internal.repoIndexing.mutation.appendIndexTreeSnapshotPages,
      {
        repositoryId: args.repositoryId,
        expectedIndexVersion: args.expectedIndexVersion,
        snapshotId: begun.snapshotId,
        startPageIndex: nextPageIndex,
        pages,
      },
    );
    if (!appended.accepted || appended.nextPageIndex <= nextPageIndex) {
      throw new Error("repository tree snapshot append lost ownership");
    }
    nextPageIndex = appended.nextPageIndex;
  }

  const finalized = await ctx.runMutation(
    internal.repoIndexing.mutation.finalizeIndexTreeSnapshot,
    {
      repositoryId: args.repositoryId,
      expectedIndexVersion: args.expectedIndexVersion,
      snapshotId: begun.snapshotId,
    },
  );
  return finalized ? begun.snapshotId : null;
}

async function loadTreeTraversalResponse(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: GenericActionCtx<any>,
  storageId: Id<"_storage">,
): Promise<Array<GitHubTreeItem>> {
  const url = await ctx.storage.getUrl(storageId);
  if (!url) {
    throw new Error("repository subtree response is missing from storage");
  }
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new RetryableTreeTraversalResponseError(
      "repository subtree response fetch timed out or failed",
    );
  }
  if (!response.ok) {
    const isRetryable =
      response.status === 408 ||
      response.status === 425 ||
      response.status === 429 ||
      (response.status >= 500 && response.status <= 599);
    const requestedRetryAt = isRetryable
      ? getGitHubHeaderRetryAt(response, Date.now())
      : undefined;
    await response.body?.cancel().catch(() => undefined);
    if (isRetryable) {
      throw new RetryableTreeTraversalResponseError(
        `repository subtree response returned HTTP ${response.status}`,
        requestedRetryAt,
      );
    }
    throw new Error(`Failed to load repository subtree: ${response.status}`);
  }

  let responseText: string;
  try {
    responseText = await response.text();
  } catch {
    throw new RetryableTreeTraversalResponseError(
      "repository subtree response ended before it could be read",
    );
  }
  let parsedResponse: unknown;
  try {
    parsedResponse = JSON.parse(responseText) as unknown;
  } catch {
    throw new Error(
      "persisted repository subtree response contains invalid JSON",
    );
  }
  return parseCompleteRepositoryTree(parsedResponse);
}

/** Attach an upload, deleting it only when an ambiguous mutation did not publish it. */
export async function attachTreeTraversalResponseWithCleanup(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: GenericActionCtx<any>,
  args: {
    repositoryId: Id<"repositories">;
    expectedIndexVersion: number;
    snapshotId: Id<"repoTreeSnapshots">;
    queueId: Id<"repoTreeTraversalQueue">;
    claimToken: string;
    responseStorageId: Id<"_storage">;
    totalItems: number;
  },
): Promise<{ accepted: boolean; reason?: string }> {
  try {
    return await ctx.runMutation(
      internal.repoIndexing.mutation.attachIndexTreeTraversalResponse,
      args,
    );
  } catch (error) {
    try {
      await ctx.runMutation(
        internal.repoIndexing.mutation
          .deleteUnpublishedTreeTraversalResponseStorage,
        { storageId: args.responseStorageId },
      );
    } catch {
      console.warn(
        "[RepoIndexing] Unable to reconcile an ambiguous subtree response upload",
      );
    }
    throw error;
  }
}

async function continueRepositoryTreeTraversal(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: GenericActionCtx<any>,
  args: {
    repositoryId: Id<"repositories">;
    expectedIndexVersion: number;
    snapshotId: Id<"repoTreeSnapshots">;
    githubRepo: string;
    getGitHubToken: GitHubTokenProvider;
  },
): Promise<{ accepted: boolean; ready: boolean; totalFiles: number }> {
  const claim = await ctx.runMutation(
    internal.repoIndexing.mutation.claimIndexTreeTraversal,
    {
      repositoryId: args.repositoryId,
      expectedIndexVersion: args.expectedIndexVersion,
      snapshotId: args.snapshotId,
    },
  );
  if (!claim) {
    return { accepted: false, ready: false, totalFiles: 0 };
  }

  let items: Array<GitHubTreeItem>;
  try {
    if (claim.responseStorageId) {
      items = await loadTreeTraversalResponse(ctx, claim.responseStorageId);
    } else {
      const response = await fetchGitHub(
        `https://api.github.com/repos/${args.githubRepo}/git/trees/${encodeURIComponent(claim.sha)}`,
        await args.getGitHubToken(),
        "fetch repository subtree",
      );
      if (!response.ok) {
        throw new Error(
          `Failed to fetch repository subtree: ${response.status}`,
        );
      }
      // A non-recursive response cannot be paginated. Failing closed is safer
      // than persisting a silently partial repository index.
      items = parseCompleteRepositoryTree(await response.json());
      const responseStorageId = await ctx.storage.store(
        new Blob([
          JSON.stringify({
            tree: items,
            truncated: false,
          }),
        ]),
      );
      const attached = await attachTreeTraversalResponseWithCleanup(ctx, {
        repositoryId: args.repositoryId,
        expectedIndexVersion: args.expectedIndexVersion,
        snapshotId: args.snapshotId,
        queueId: claim.queueId,
        claimToken: claim.claimToken,
        responseStorageId,
        totalItems: items.length,
      });
      if (!attached.accepted) {
        if (attached.reason !== "stale traversal claim") {
          throw new Error(attached.reason);
        }
        return { accepted: false, ready: false, totalFiles: claim.totalFiles };
      }
    }
  } catch (error) {
    throw new IndexTreeTraversalClaimedError(error, {
      snapshotId: args.snapshotId,
      claimToken: claim.claimToken,
    });
  }

  if (claim.totalItems !== undefined && claim.totalItems !== items.length) {
    throw new Error("persisted repository subtree item count changed");
  }
  if (claim.itemOffset > items.length) {
    throw new Error("repository subtree cursor exceeds persisted response");
  }

  const itemSlice = items.slice(
    claim.itemOffset,
    claim.itemOffset + REPOSITORY_TREE_TRAVERSAL_ITEMS_PER_ACTION,
  );
  const children: Array<{ sha: string; prefix: string }> = [];
  const files: Array<RepositoryTreeSnapshotFile> = [];
  for (const item of itemSlice) {
    const path = claim.prefix ? `${claim.prefix}/${item.path}` : item.path;
    if (item.type === "tree") {
      children.push({ sha: item.sha, prefix: path });
    } else if (item.type === "blob") {
      files.push(
        ...getIndexableRepositoryFiles([
          { path, type: "blob", sha: item.sha, size: item.size },
        ]),
      );
    }
  }

  const nextItemOffset = claim.itemOffset + itemSlice.length;
  return await ctx.runMutation(
    internal.repoIndexing.mutation.commitIndexTreeTraversalSlice,
    {
      repositoryId: args.repositoryId,
      expectedIndexVersion: args.expectedIndexVersion,
      snapshotId: args.snapshotId,
      queueId: claim.queueId,
      claimToken: claim.claimToken,
      expectedItemOffset: claim.itemOffset,
      nextItemOffset,
      complete: nextItemOffset === items.length,
      children,
      files,
    },
  );
}

/**
 * Helper to log indexing progress
 */
async function logIndexing(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: GenericActionCtx<any>,
  repositoryId: Id<"repositories">,
  indexVersion: number,
  level: "info" | "success" | "warning" | "error",
  message: string,
  metadata?: unknown,
) {
  await ctx.runMutation(internal.repoIndexing.mutation.addIndexingLog, {
    repositoryId,
    indexVersion,
    level,
    message,
    metadata,
  });
  console.log(`[repo-indexing:${level}] event recorded`);
}

/**
 * Index repository structure
 * This is the main action that fetches repository data from GitHub
 * and builds the code structure graph
 */
export const indexRepository = internalAction({
  args: {
    repositoryId: v.id("repositories"),
    expectedIndexVersion: v.optional(v.number()),
    continuation: v.optional(v.boolean()),
    treeTraversal: v.optional(v.boolean()),
    pageIndex: v.optional(v.number()),
    treeSnapshotId: v.optional(v.id("repoTreeSnapshots")),
    fileOffset: v.optional(v.number()),
    rateLimitResume: v.optional(v.boolean()),
    rateLimitRetryToken: v.optional(v.string()),
    treeResponseRetryAttempt: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    success: boolean;
    filesIndexed: number;
    indexVersion: number;
  }> => {
    const isContinuation = args.continuation === true;
    const isRateLimitResume =
      args.rateLimitResume === true && args.rateLimitRetryToken !== undefined;
    const isFreshStart = !isContinuation && !isRateLimitResume;
    const pageIndex = Math.max(0, args.pageIndex ?? 0);
    console.log(
      `[indexRepository] ${isContinuation ? "Continuing" : "Starting"} for repositoryId: ${args.repositoryId} at tree page ${pageIndex}`,
    );

    let repo = await ctx.runQuery(internal.repositories.internalQuery.getById, {
      repositoryId: args.repositoryId,
    });

    if (!repo) {
      console.error(
        `[indexRepository] Repository not found: ${args.repositoryId}`,
      );
      throw new Error("repository not found");
    }

    let indexingGithubRepo = repo.githubRepo;
    console.log("[indexRepository] Repository record loaded");

    const currentVersion = args.expectedIndexVersion ?? repo.indexVersion;
    const expectedStatus = isFreshStart ? "pending" : "indexing";
    if (
      repo.indexVersion !== currentVersion ||
      repo.indexStatus !== expectedStatus
    ) {
      console.warn(
        `[indexRepository] Skipping stale generation ${currentVersion}; expected ${expectedStatus}, current version/status is ${repo.indexVersion}/${repo.indexStatus}`,
      );
      return {
        success: false,
        filesIndexed: 0,
        indexVersion: currentVersion,
      };
    }
    if (isRateLimitResume) {
      const claimed = await ctx.runMutation(
        internal.repoIndexing.mutation.claimRateLimitedIndexRetry,
        {
          repositoryId: args.repositoryId,
          expectedIndexVersion: currentVersion,
          retryToken: args.rateLimitRetryToken!,
        },
      );
      if (!claimed) {
        return {
          success: false,
          filesIndexed: 0,
          indexVersion: currentVersion,
        };
      }
      const claimedRepository = await ctx.runQuery(
        internal.repositories.internalQuery.getById,
        { repositoryId: args.repositoryId },
      );
      if (!claimedRepository) {
        return {
          success: false,
          filesIndexed: 0,
          indexVersion: currentVersion,
        };
      }
      repo = claimedRepository;
    }
    if (
      repo.isActive !== true ||
      repo.githubAccessRevokedAt !== undefined ||
      repo.disconnectCleanupPending === true
    ) {
      return {
        success: false,
        filesIndexed: 0,
        indexVersion: currentVersion,
      };
    }

    let filesIndexedBeforeRetry = Math.max(
      0,
      pageIndex * REPOSITORY_TREE_SNAPSHOT_PAGE_SIZE,
    );
    let rateLimitContinuation: IndexRetryContinuation = {
      ...(args.continuation === undefined
        ? {}
        : { continuation: args.continuation }),
      ...(args.treeTraversal === undefined
        ? {}
        : { treeTraversal: args.treeTraversal }),
      ...(args.pageIndex === undefined ? {} : { pageIndex: args.pageIndex }),
      ...(args.treeSnapshotId === undefined
        ? {}
        : { treeSnapshotId: args.treeSnapshotId }),
      ...(args.fileOffset === undefined ? {} : { fileOffset: args.fileOffset }),
    };
    const initialInstallationId = repo.installationId;
    const initialRepositoryUserId = repo.userId;
    try {
      if (isFreshStart) {
        const started = await ctx.runMutation(
          internal.repoIndexing.mutation.updateIndexingStatus,
          {
            repositoryId: args.repositoryId,
            status: "indexing",
            expectedIndexVersion: currentVersion,
          },
        );
        if (!started) {
          return {
            success: false,
            filesIndexed: 0,
            indexVersion: currentVersion,
          };
        }

        await logIndexing(
          ctx,
          args.repositoryId,
          currentVersion,
          "info",
          `Starting indexing for ${repo.githubRepo}`,
        );
        await logIndexing(
          ctx,
          args.repositoryId,
          currentVersion,
          "info",
          "Verifying GitHub App installation",
        );
      }

      const initialGithubRepositoryId = repo.githubRepositoryId;

      let tokenPromise: Promise<string> | undefined;
      const getGitHubToken = (): Promise<string> => {
        if (!tokenPromise) {
          tokenPromise = (async () => {
            const installation = await ctx.runQuery(
              internal.github.internalQuery.getInstallationByInstallationId,
              {
                installationId: initialInstallationId,
              },
            );
            if (!installation) {
              throw new Error(
                `GitHub installation not found for installationId: ${initialInstallationId}. ` +
                  "The GitHub App may have been uninstalled or the installation record is missing.",
              );
            }
            if (installation.userId !== initialRepositoryUserId) {
              throw new Error(
                "GitHub installation ownership changed while indexing",
              );
            }
            if (!isGitHubInstallationReady(installation)) {
              throw new GitHubInstallationDeferredError(
                "GitHub installation access is being reconciled",
              );
            }

            if (isFreshStart) {
              await logIndexing(
                ctx,
                args.repositoryId,
                currentVersion,
                "success",
                "GitHub App installation verified",
              );
              await logIndexing(
                ctx,
                args.repositoryId,
                currentVersion,
                "info",
                "Requesting GitHub access token",
              );
            }

            const appId = process.env.GITHUB_APP_ID;
            const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
            if (!appId || !privateKey) {
              throw new Error("GitHub App credentials not configured");
            }

            let token: string;
            try {
              token = await getRepositoryInstallationToken(
                initialInstallationId,
                initialGithubRepositoryId,
                appId,
                privateKey,
              );
            } catch (error) {
              if (error instanceof GitHubAppRateLimitError) {
                throw new GitHubRateLimitError(
                  "request GitHub repository access token",
                  error.retryAt,
                );
              }
              throw error;
            }
            if (isFreshStart) {
              await logIndexing(
                ctx,
                args.repositoryId,
                currentVersion,
                "success",
                "GitHub access token obtained",
              );
            }
            return token;
          })();
        }
        return tokenPromise;
      };

      const token = await getGitHubToken();
      let verifiedRepo: Doc<"repositories">;
      let authoritativeMetadata: AuthoritativeRepositoryMetadata | undefined;
      const canReuseGenerationIdentity =
        isContinuation &&
        repo.indexIdentityVerifiedVersion === currentVersion &&
        repo.indexIdentityVerifiedInstallationId === repo.installationId &&
        repo.indexIdentityVerifiedGithubRepositoryId ===
          repo.githubRepositoryId &&
        repo.indexIdentityVerifiedGithubRepo === repo.githubRepo;

      if (canReuseGenerationIdentity) {
        verifiedRepo = repo;
        indexingGithubRepo = repo.githubRepo;
      } else {
        authoritativeMetadata = await fetchAuthoritativeRepositoryMetadata(
          repo.githubRepositoryId,
          token,
        );
        const reconciledRepository =
          await reconcileAuthoritativeRepositoryIdentity(ctx, {
            repositoryId: args.repositoryId,
            expectedIndexVersion: currentVersion,
            installationId: repo.installationId,
            githubRepositoryId: repo.githubRepositoryId,
            expectedGithubRepo: repo.githubRepo,
            metadata: authoritativeMetadata,
          });
        if (!reconciledRepository) {
          if (
            await isInstallationAccessDeferred(
              ctx,
              initialInstallationId,
              initialRepositoryUserId,
            )
          ) {
            throw new GitHubInstallationDeferredError(
              "GitHub installation access changed while reconciling repository identity",
            );
          }
          return {
            success: false,
            filesIndexed: 0,
            indexVersion: currentVersion,
          };
        }
        const identityRecorded = await ctx.runMutation(
          internal.repoIndexing.mutation.recordIndexIdentityVerification,
          {
            repositoryId: args.repositoryId,
            expectedIndexVersion: currentVersion,
            installationId: reconciledRepository.installationId,
            githubRepositoryId: reconciledRepository.githubRepositoryId,
            githubRepo: authoritativeMetadata.githubRepo,
          },
        );
        if (!identityRecorded) {
          if (
            await isInstallationAccessDeferred(
              ctx,
              initialInstallationId,
              initialRepositoryUserId,
            )
          ) {
            throw new GitHubInstallationDeferredError(
              "GitHub installation access changed while recording repository identity",
            );
          }
          return {
            success: false,
            filesIndexed: 0,
            indexVersion: currentVersion,
          };
        }
        verifiedRepo = reconciledRepository;
        indexingGithubRepo = authoritativeMetadata.githubRepo;
      }

      if (args.treeTraversal === true) {
        if (!isContinuation || !args.treeSnapshotId) {
          return {
            success: false,
            filesIndexed: 0,
            indexVersion: currentVersion,
          };
        }
        const traversal = await continueRepositoryTreeTraversal(ctx, {
          repositoryId: args.repositoryId,
          expectedIndexVersion: currentVersion,
          snapshotId: args.treeSnapshotId,
          githubRepo: indexingGithubRepo,
          getGitHubToken,
        });
        return {
          success: traversal.accepted,
          filesIndexed: traversal.totalFiles,
          indexVersion: currentVersion,
        };
      }

      let treeSnapshotId: Id<"repoTreeSnapshots">;
      let currentPage: {
        defaultBranch: string;
        commitSha: string;
        treeSha: string;
        totalFiles: number;
        totalPages: number;
        pageIndex: number;
        files: Array<RepositoryTreeSnapshotFile>;
      };
      if (!isContinuation) {
        if (!authoritativeMetadata) {
          throw new Error(
            "repository identity metadata was not verified for the initial index",
          );
        }
        await logIndexing(
          ctx,
          args.repositoryId,
          currentVersion,
          "info",
          "Fetching repository metadata from GitHub",
        );
        const osiLicenseApproval = await resolveOsiLicenseApproval(
          verifiedRepo,
          authoritativeMetadata,
        );
        const defaultBranch = authoritativeMetadata.defaultBranch;
        const metadataUpdated = await ctx.runMutation(
          internal.repoIndexing.mutation.updateRepositoryMetadata,
          {
            repositoryId: args.repositoryId,
            expectedIndexVersion: currentVersion,
            expectedMetadataCheckedAt: verifiedRepo.repositoryMetadataCheckedAt,
            defaultBranch,
            githubVisibility: authoritativeMetadata.githubVisibility ?? null,
            licenseKey: authoritativeMetadata.licenseKey ?? null,
            licenseSpdxId: authoritativeMetadata.licenseSpdxId ?? null,
            licenseOsiApproved: osiLicenseApproval.approved,
            licenseOsiCheckedAt: osiLicenseApproval.checkedAt ?? null,
          },
        );
        if (!metadataUpdated) {
          throw new Error(
            "repository generation changed while metadata was being refreshed",
          );
        }
        const snapshot = await fetchRepositorySnapshot(
          indexingGithubRepo,
          defaultBranch,
          token,
        );
        const commitSha = snapshot.commitSha;
        const treeSha = snapshot.treeSha;
        await logIndexing(
          ctx,
          args.repositoryId,
          currentVersion,
          "success",
          `Default branch: ${defaultBranch}`,
        );
        await logIndexing(
          ctx,
          args.repositoryId,
          currentVersion,
          "info",
          "Fetching complete file tree from GitHub",
        );
        const treeAttempt = await fetchRepositoryTreeAttempt(
          indexingGithubRepo,
          treeSha,
          token,
        );
        if (treeAttempt.truncated) {
          console.warn(
            "[indexRepository] GitHub truncated the recursive tree; scheduling durable subtree traversal",
          );
          const traversal = await ctx.runMutation(
            internal.repoIndexing.mutation.beginIndexTreeTraversal,
            {
              repositoryId: args.repositoryId,
              expectedIndexVersion: currentVersion,
              defaultBranch,
              commitSha,
              treeSha,
            },
          );
          return {
            success: traversal !== null,
            filesIndexed: 0,
            indexVersion: currentVersion,
          };
        }
        const tree = treeAttempt.tree;
        await logIndexing(
          ctx,
          args.repositoryId,
          currentVersion,
          "success",
          `Found ${tree.length} items in repository`,
        );
        await logIndexing(
          ctx,
          args.repositoryId,
          currentVersion,
          "info",
          "Analyzing file structure and creating file index",
        );
        await logIndexing(
          ctx,
          args.repositoryId,
          currentVersion,
          "info",
          "This may take a moment for large repositories...",
        );

        const files = getIndexableRepositoryFiles(tree);
        const pages = buildRepositoryTreeSnapshotPages(files);
        const attachedSnapshotId = await persistRepositoryTreeSnapshot(ctx, {
          repositoryId: args.repositoryId,
          expectedIndexVersion: currentVersion,
          defaultBranch,
          commitSha,
          treeSha,
          pages,
        });
        if (!attachedSnapshotId) {
          return {
            success: false,
            filesIndexed: 0,
            indexVersion: currentVersion,
          };
        }
        treeSnapshotId = attachedSnapshotId;
        const page = await ctx.runQuery(
          internal.repoIndexing.internalQuery.getIndexTreeSnapshotPage,
          {
            repositoryId: args.repositoryId,
            expectedIndexVersion: currentVersion,
            snapshotId: treeSnapshotId,
            pageIndex: 0,
          },
        );
        if (!page) {
          throw new Error("repository tree snapshot was not published");
        }
        currentPage = page;
      } else if (args.treeSnapshotId) {
        if (repo.indexTreeSnapshotId !== args.treeSnapshotId) {
          return {
            success: false,
            filesIndexed: pageIndex * REPOSITORY_TREE_SNAPSHOT_PAGE_SIZE,
            indexVersion: currentVersion,
          };
        }
        const page = await ctx.runQuery(
          internal.repoIndexing.internalQuery.getIndexTreeSnapshotPage,
          {
            repositoryId: args.repositoryId,
            expectedIndexVersion: currentVersion,
            snapshotId: args.treeSnapshotId,
            pageIndex,
          },
        );
        if (!page) {
          return {
            success: false,
            filesIndexed: pageIndex * REPOSITORY_TREE_SNAPSHOT_PAGE_SIZE,
            indexVersion: currentVersion,
          };
        }
        treeSnapshotId = args.treeSnapshotId;
        currentPage = page;
      } else {
        return {
          success: false,
          filesIndexed: pageIndex * REPOSITORY_TREE_SNAPSHOT_PAGE_SIZE,
          indexVersion: currentVersion,
        };
      }

      rateLimitContinuation = {
        continuation: true,
        pageIndex: currentPage.pageIndex,
        treeSnapshotId,
        fileOffset: args.fileOffset ?? 0,
      };
      filesIndexedBeforeRetry = Math.min(
        currentPage.pageIndex * REPOSITORY_TREE_SNAPSHOT_PAGE_SIZE,
        currentPage.totalFiles,
      );
      await processRepositoryTreeBatch(
        ctx,
        args.repositoryId,
        indexingGithubRepo,
        {
          expectedUserId: verifiedRepo.userId,
          expectedInstallationId: verifiedRepo.installationId,
          expectedGithubRepositoryId: verifiedRepo.githubRepositoryId,
          expectedGithubRepo: indexingGithubRepo,
        },
        currentPage.files,
        getGitHubToken,
        currentVersion,
        args.fileOffset ?? 0,
      );

      const processedFiles = Math.min(
        (currentPage.pageIndex + 1) * REPOSITORY_TREE_SNAPSHOT_PAGE_SIZE,
        currentPage.totalFiles,
      );
      const progress =
        currentPage.totalFiles === 0
          ? 100
          : Math.round((processedFiles / currentPage.totalFiles) * 100);
      await logIndexing(
        ctx,
        args.repositoryId,
        currentVersion,
        "info",
        `Processing files... ${processedFiles}/${currentPage.totalFiles} (${progress}%)`,
      );

      const nextPageIndex = currentPage.pageIndex + 1;
      if (nextPageIndex < currentPage.totalPages) {
        const scheduled = await ctx.runMutation(
          internal.repoIndexing.mutation.scheduleIndexContinuation,
          {
            repositoryId: args.repositoryId,
            expectedIndexVersion: currentVersion,
            pageIndex: nextPageIndex,
            treeSnapshotId,
          },
        );
        if (!scheduled) {
          return {
            success: false,
            filesIndexed: processedFiles,
            indexVersion: currentVersion,
          };
        }

        return {
          success: true,
          filesIndexed: processedFiles,
          indexVersion: currentVersion,
        };
      }

      const heartbeatUpdated = await ctx.runMutation(
        internal.repoIndexing.mutation.touchIndexingProgress,
        {
          repositoryId: args.repositoryId,
          expectedIndexVersion: currentVersion,
        },
      );
      if (!heartbeatUpdated) {
        return {
          success: false,
          filesIndexed: processedFiles,
          indexVersion: currentVersion,
        };
      }

      await logIndexing(
        ctx,
        args.repositoryId,
        currentVersion,
        "success",
        `File indexing completed: ${currentPage.totalFiles} files processed`,
      );

      // Important configuration files were already captured by SHA from the
      // pinned tree while their file mappings were created.
      await logIndexing(
        ctx,
        args.repositoryId,
        currentVersion,
        "info",
        "Finalizing configuration files from the pinned snapshot",
      );
      await logIndexing(
        ctx,
        args.repositoryId,
        currentVersion,
        "success",
        "Configuration files captured from the pinned snapshot",
      );

      const snapshotReleased = await ctx.runMutation(
        internal.repoIndexing.mutation.releaseIndexTreeSnapshot,
        {
          repositoryId: args.repositoryId,
          expectedIndexVersion: currentVersion,
          snapshotId: treeSnapshotId,
        },
      );
      if (!snapshotReleased) {
        return {
          success: false,
          filesIndexed: currentPage.totalFiles,
          indexVersion: currentVersion,
        };
      }

      // Clean up old index data (batch processing to avoid memory issues)
      await logIndexing(
        ctx,
        args.repositoryId,
        currentVersion,
        "info",
        "Cleaning up previous index data",
      );

      const cleanup = await ctx.runMutation(
        internal.repoIndexing.mutation.continueFileMapCleanup,
        {
          repositoryId: args.repositoryId,
          expectedIndexVersion: currentVersion,
          totalFiles: currentPage.totalFiles,
        },
      );
      if (!cleanup.accepted) {
        return {
          success: false,
          filesIndexed: currentPage.totalFiles,
          indexVersion: currentVersion,
        };
      }

      return {
        success: true,
        filesIndexed: currentPage.totalFiles,
        indexVersion: currentVersion,
      };
    } catch (error) {
      const treeTraversalClaim =
        error instanceof IndexTreeTraversalClaimedError
          ? error.claim
          : undefined;
      let normalizedError =
        error instanceof IndexTreeTraversalClaimedError
          ? error.originalError
          : error;
      if (
        !(normalizedError instanceof GitHubRateLimitError) &&
        !(normalizedError instanceof GitHubInstallationDeferredError) &&
        !(normalizedError instanceof RetryableTreeTraversalResponseError)
      ) {
        try {
          const currentInstallation = await ctx.runQuery(
            internal.github.internalQuery.getInstallationByInstallationId,
            { installationId: initialInstallationId },
          );
          if (
            currentInstallation?.userId === initialRepositoryUserId &&
            !isGitHubInstallationReady(currentInstallation)
          ) {
            normalizedError = new GitHubInstallationDeferredError(
              "GitHub installation access changed while indexing",
            );
          }
        } catch {
          console.warn(
            "[indexRepository] Unable to recheck deferred installation access",
          );
        }
      }
      const treeResponseRetry =
        normalizedError instanceof RetryableTreeTraversalResponseError &&
        treeTraversalClaim !== undefined
          ? getNextTreeResponseRetry(
              normalizedError,
              args.treeResponseRetryAttempt,
            )
          : null;
      if (
        normalizedError instanceof RetryableTreeTraversalResponseError &&
        treeResponseRetry === null
      ) {
        normalizedError = new Error(
          `Repository subtree response retry limit reached after ${TREE_RESPONSE_RETRY_MAX_ATTEMPT} attempts: ${normalizedError.message}`,
        );
      }
      if (
        normalizedError instanceof GitHubRateLimitError ||
        normalizedError instanceof GitHubInstallationDeferredError ||
        treeResponseRetry !== null
      ) {
        const retryAt =
          treeResponseRetry?.retryAt ??
          (normalizedError instanceof GitHubRateLimitError ||
          normalizedError instanceof GitHubInstallationDeferredError
            ? normalizedError.retryAt
            : Date.now() + TREE_RESPONSE_RETRY_BASE_DELAY_MS);
        const scheduled = await ctx.runMutation(
          internal.repoIndexing.mutation.scheduleRateLimitedIndexRetry,
          {
            repositoryId: args.repositoryId,
            expectedIndexVersion: currentVersion,
            retryAt,
            ...rateLimitContinuation,
            ...(treeTraversalClaim === undefined
              ? {}
              : {
                  treeSnapshotId: treeTraversalClaim.snapshotId,
                  treeTraversal: true,
                  continuation: true,
                  treeTraversalClaimToken: treeTraversalClaim.claimToken,
                }),
            ...(treeResponseRetry === null
              ? {}
              : { treeResponseRetryAttempt: treeResponseRetry.attempt }),
            ...(!(normalizedError instanceof GitHubRateLimitError) ||
            normalizedError.fileOffset === undefined
              ? {}
              : { fileOffset: normalizedError.fileOffset }),
          },
        );
        if (scheduled) {
          try {
            await logIndexing(
              ctx,
              args.repositoryId,
              currentVersion,
              "warning",
              treeResponseRetry !== null
                ? "Stored repository subtree response is temporarily unavailable; indexing will resume automatically"
                : normalizedError instanceof GitHubRateLimitError
                  ? "GitHub API limit reached; indexing will resume automatically"
                  : "GitHub installation access is being reconciled; indexing will resume automatically",
              { retryAt },
            );
          } catch {
            console.warn("[indexRepository] Unable to log rate-limit retry");
          }
        }
        return {
          success: scheduled,
          filesIndexed:
            filesIndexedBeforeRetry +
            (normalizedError instanceof GitHubRateLimitError
              ? (normalizedError.fileOffset ?? args.fileOffset ?? 0)
              : (args.fileOffset ?? 0)),
          indexVersion: currentVersion,
        };
      }
      console.error("[indexRepository] Indexing failed");
      const errorMessage =
        normalizedError instanceof Error
          ? normalizedError.message
          : "unknown error";

      let markedFailed = false;
      try {
        markedFailed = await ctx.runMutation(
          internal.repoIndexing.mutation.updateIndexingStatus,
          {
            repositoryId: args.repositoryId,
            status: "failed",
            error: errorMessage,
            expectedIndexVersion: currentVersion,
          },
        );
      } catch {
        console.error("[indexRepository] Failed to mark index as failed");
      }
      if (markedFailed) {
        try {
          await ctx.runMutation(
            internal.ragV2.internalMutation.updateRagStatus,
            {
              repositoryId: args.repositoryId,
              status: "failed",
              error: `Repository indexing failed before RAG generation: ${errorMessage}`,
              expectedIndexVersion: currentVersion,
            },
          );
        } catch {
          console.error("[indexRepository] Failed to mark RAG as failed");
        }
      }

      try {
        await logIndexing(
          ctx,
          args.repositoryId,
          currentVersion,
          "error",
          `Indexing failed: ${errorMessage}`,
        );
      } catch {
        console.error("[indexRepository] Failed to create indexing log");
      }

      try {
        await createIndexingAiLog(ctx, {
          repositoryId: args.repositoryId,
          userId: repo.userId,
          githubRepo: indexingGithubRepo,
          status: "failed",
          errorMessage,
        });
      } catch {
        console.error("[indexRepository] Failed to create AI log");
      }

      throw normalizedError;
    }
  },
});

async function resolveOsiLicenseApproval(
  repository: Pick<
    Doc<"repositories">,
    | "githubVisibility"
    | "licenseSpdxId"
    | "licenseOsiApproved"
    | "licenseOsiCheckedAt"
  >,
  metadata: RepositoryEmbeddingMetadata,
): Promise<{ approved: boolean; checkedAt?: number }> {
  const spdxId = metadata.licenseSpdxId?.trim();
  if (metadata.githubVisibility !== "public" || !spdxId) {
    return { approved: false };
  }

  const checkedAt = repository.licenseOsiCheckedAt ?? 0;
  const cacheAge = Date.now() - checkedAt;
  if (
    repository.githubVisibility === "public" &&
    repository.licenseSpdxId?.trim().toUpperCase() === spdxId.toUpperCase() &&
    typeof repository.licenseOsiApproved === "boolean" &&
    cacheAge >= 0 &&
    cacheAge < OSI_LICENSE_CACHE_MS
  ) {
    return { approved: repository.licenseOsiApproved, checkedAt };
  }

  const verificationTime = Date.now();
  try {
    return {
      approved: await fetchOsiLicenseApproval(spdxId),
      checkedAt: verificationTime,
    };
  } catch {
    console.warn(
      "[indexRepository] OSI license verification failed; using paid embedding policy",
    );
    return { approved: false };
  }
}

async function reconcileAuthoritativeRepositoryIdentity(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: GenericActionCtx<any>,
  args: {
    repositoryId: Id<"repositories">;
    expectedIndexVersion: number;
    installationId: number;
    githubRepositoryId: number;
    expectedGithubRepo: string;
    metadata: AuthoritativeRepositoryMetadata;
  },
): Promise<Doc<"repositories"> | null> {
  let repository = await ctx.runQuery(
    internal.repositories.internalQuery.getById,
    { repositoryId: args.repositoryId },
  );
  if (
    !repository ||
    repository.indexVersion !== args.expectedIndexVersion ||
    repository.indexStatus !== "indexing"
  ) {
    return null;
  }
  if (
    repository.installationId !== args.installationId ||
    repository.githubRepositoryId !== args.githubRepositoryId ||
    repository.githubAccessRevokedAt !== undefined
  ) {
    throw new Error(
      "repository identity changed while authoritative metadata was being verified",
    );
  }
  if (
    repository.githubRepo !== args.expectedGithubRepo &&
    repository.githubRepo !== args.metadata.githubRepo
  ) {
    return null;
  }

  if (repository.githubRepo !== args.metadata.githubRepo) {
    const reconciled = await ctx.runMutation(
      internal.repositories.internalMutation.applyRepositoryWebhookUpdate,
      {
        repositoryId: args.repositoryId,
        expectedGithubRepo: repository.githubRepo,
        githubRepositoryId: args.githubRepositoryId,
        installationId: args.installationId,
        githubRepo: args.metadata.githubRepo,
        liveIdentityVerified: true,
        githubVisibility: args.metadata.githubVisibility ?? null,
        licenseKey: args.metadata.licenseKey ?? null,
        licenseSpdxId: args.metadata.licenseSpdxId ?? null,
      },
    );
    if (reconciled.paused || !reconciled.identityUpdated) {
      return null;
    }
  }

  repository = await ctx.runQuery(internal.repositories.internalQuery.getById, {
    repositoryId: args.repositoryId,
  });
  if (
    !repository ||
    repository.indexVersion !== args.expectedIndexVersion ||
    repository.indexStatus !== "indexing"
  ) {
    return null;
  }
  if (
    repository.installationId !== args.installationId ||
    repository.githubRepositoryId !== args.githubRepositoryId ||
    repository.githubRepo !== args.metadata.githubRepo ||
    repository.githubAccessRevokedAt !== undefined
  ) {
    throw new Error(
      "repository identity changed while its authoritative name was being reconciled",
    );
  }
  return repository;
}

/** Fetch repository metadata through its immutable GitHub repository ID. */
async function fetchAuthoritativeRepositoryMetadata(
  githubRepositoryId: number,
  token: string,
): Promise<AuthoritativeRepositoryMetadata> {
  const response = await fetchGitHub(
    `https://api.github.com/repositories/${githubRepositoryId}`,
    token,
    "fetch authoritative repository metadata",
  );

  if (!response.ok) {
    throw new Error(
      `Failed to fetch authoritative repository metadata: ${response.status}`,
    );
  }

  const data = (await response.json()) as Record<string, unknown>;
  if (
    !data ||
    data.id !== githubRepositoryId ||
    typeof data.full_name !== "string" ||
    data.full_name.trim().length === 0 ||
    typeof data.default_branch !== "string" ||
    data.default_branch.trim().length === 0
  ) {
    throw new Error(
      "GitHub authoritative repository identity did not match the connected repository",
    );
  }
  const embeddingMetadata = normalizeGitHubRepositoryEmbeddingMetadata(data);
  return {
    githubRepositoryId,
    githubRepo: data.full_name,
    defaultBranch: data.default_branch,
    ...embeddingMetadata,
  };
}

async function fetchBranchHeadSha(
  githubRepo: string,
  branch: string,
  token: string,
): Promise<string | null> {
  const response = await fetchGitHub(
    `https://api.github.com/repos/${githubRepo}/commits/${encodeURIComponent(branch)}`,
    token,
    "fetch default branch head",
  );
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  const data = (await response.json()) as { sha?: unknown };
  return typeof data.sha === "string" && /^[a-f0-9]{40}$/i.test(data.sha)
    ? data.sha.toLowerCase()
    : null;
}

/**
 * Read the default branch head with one installation token, so a periodic
 * sync can compare it with the indexed commit before touching the database.
 * Returns null when GitHub cannot answer; callers then leave the index as is.
 */
export async function fetchDefaultBranchHead(args: {
  installationId: number;
  githubRepositoryId: number;
  githubRepo: string;
  defaultBranch?: string;
}): Promise<{ commitSha: string; defaultBranch: string } | null> {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) return null;
  try {
    const token = await getRepositoryInstallationToken(
      args.installationId,
      args.githubRepositoryId,
      appId,
      privateKey,
    );
    if (args.defaultBranch) {
      const sha = await fetchBranchHeadSha(
        args.githubRepo,
        args.defaultBranch,
        token,
      );
      if (sha) return { commitSha: sha, defaultBranch: args.defaultBranch };
    }
    // The stored branch is unknown or no longer resolves (renamed default
    // branch or transferred repository): ask GitHub for the current one.
    const metadata = await fetchAuthoritativeRepositoryMetadata(
      args.githubRepositoryId,
      token,
    );
    const sha = await fetchBranchHeadSha(
      metadata.githubRepo,
      metadata.defaultBranch,
      token,
    );
    return sha
      ? { commitSha: sha, defaultBranch: metadata.defaultBranch }
      : null;
  } catch {
    return null;
  }
}

async function fetchRepositorySnapshot(
  githubRepo: string,
  branch: string,
  token: string,
): Promise<{ commitSha: string; treeSha: string }> {
  const response = await fetchGitHub(
    `https://api.github.com/repos/${githubRepo}/commits/${encodeURIComponent(branch)}`,
    token,
    "fetch repository snapshot",
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch repository snapshot: ${response.status}`);
  }

  const data = (await response.json()) as {
    sha?: string;
    commit?: { tree?: { sha?: string } };
  };
  const commitSha = data.sha;
  const treeSha = data.commit?.tree?.sha;
  if (!commitSha || !treeSha) {
    throw new Error("Invalid repository snapshot response from GitHub");
  }

  return { commitSha, treeSha };
}

/**
 * Fetch repository tree from GitHub
 */
type RepositoryTreeFetchResult =
  { truncated: false; tree: Array<GitHubTreeItem> } | { truncated: true };

async function fetchRepositoryTreeAttempt(
  githubRepo: string,
  treeSha: string,
  token: string,
): Promise<RepositoryTreeFetchResult> {
  const response = await fetchGitHub(
    `https://api.github.com/repos/${githubRepo}/git/trees/${treeSha}?recursive=1`,
    token,
    "fetch repository tree",
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch repository tree: ${response.status}`);
  }

  const responseBody: unknown = await response.json();
  return isTruncatedRepositoryTree(responseBody)
    ? { truncated: true }
    : { truncated: false, tree: parseCompleteRepositoryTree(responseBody) };
}

export async function fetchRepositoryTree(
  githubRepo: string,
  treeSha: string,
  token: string,
): Promise<GitHubTreeItem[]> {
  const result = await fetchRepositoryTreeAttempt(githubRepo, treeSha, token);
  if (result.truncated) {
    throw new Error(
      "GitHub returned a truncated repository tree; durable traversal is required",
    );
  }
  return result.tree;
}

/**
 * Process repository tree and create file mappings
 * Stores blobs for recognized text files and metadata-only mappings otherwise.
 */
async function processRepositoryTreeBatch(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: GenericActionCtx<any>,
  repositoryId: Id<"repositories">,
  githubRepo: string,
  publicationIdentity: FileBlobPublicationIdentity,
  files: Array<RepositoryTreeSnapshotFile>,
  getToken: GitHubTokenProvider,
  indexVersion: number,
  offset: number,
): Promise<{ nextOffset: number; totalFiles: number }> {
  const {
    batch: pageBatch,
    nextOffset,
    totalFiles,
  } = getRepositoryIndexBatch(files, offset);

  // Unchanged files only move to the new generation; they need no blob
  // lookups, uploads, or re-chunking.
  const reuse =
    pageBatch.length === 0
      ? { changedPaths: [] }
      : await ctx.runMutation(
          internal.repoIndexing.mutation.reuseUnchangedFileMaps,
          {
            repositoryId,
            ...publicationIdentity,
            expectedIndexVersion: indexVersion,
            files: pageBatch.map((file) => ({
              filePath: file.path,
              sha256: file.sha,
              language: getLanguageFromPath(file.path),
              size: file.size ?? 0,
              isText: isTextFile(file.path),
            })),
          },
        );
  if (reuse === "stale") {
    throw new Error("stale repository indexing generation");
  }
  const changedPaths = new Set(reuse.changedPaths);
  const batch = pageBatch.filter((file) => changedPaths.has(file.path));

  for (let i = 0; i < batch.length; i += FILE_INDEX_CONCURRENCY) {
    const concurrentFiles = batch.slice(i, i + FILE_INDEX_CONCURRENCY);
    const results = await Promise.allSettled(
      concurrentFiles.map(async (file) => {
        const language = getLanguageFromPath(file.path);
        const isText = isTextFile(file.path);
        const publication = {
          repositoryId,
          ...publicationIdentity,
          expectedIndexVersion: indexVersion,
          filePath: file.path,
          sha256: file.sha,
          language,
          size: file.size ?? 0,
          isText,
        };
        let mappedWithBlob = false;

        if (isText) {
          const reusedBlob = await ctx.runMutation(
            internal.repoIndexing.mutation.reuseFileBlob,
            publication,
          );

          if (reusedBlob === "stale") {
            throw new Error("stale repository indexing generation");
          }

          if (!reusedBlob) {
            const content = await fetchBlobContent(
              githubRepo,
              file.sha,
              await getToken(),
            );
            if (content === null) {
              throw new Error(
                `GitHub blob ${file.sha} for ${file.path} was not found in the pinned repository snapshot`,
              );
            }

            const blob = new Blob([content], { type: "text/plain" });
            const storageId = await ctx.storage.store(blob);
            let storedBlob: Id<"repoFileBlobs"> | null;
            try {
              storedBlob = await ctx.runMutation(
                internal.repoIndexing.mutation.storeFileBlob,
                { ...publication, storageId },
              );
            } catch (error) {
              try {
                await ctx.runMutation(
                  internal.repoIndexing.mutation
                    .deleteUnpublishedFileBlobStorage,
                  { storageId },
                );
              } catch {
                console.error(
                  "[indexRepository] Failed to clean unpublished file blob",
                );
              }
              throw error;
            }
            if (storedBlob === null) {
              throw new Error("stale repository indexing generation");
            }
          }
          mappedWithBlob = true;
        }

        if (!mappedWithBlob) {
          const mapResult = await ctx.runMutation(
            internal.repoIndexing.mutation.mapFile,
            {
              repositoryId,
              filePath: file.path,
              sha256: file.sha,
              language,
              size: file.size ?? 0,
              isText,
              indexVersion,
            },
          );
          assertMapFilePublished(mapResult);
        }
      }),
    );
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed) {
      if (failed.reason instanceof GitHubRateLimitError) {
        throw new GitHubRateLimitError(
          "fetch repository file page",
          failed.reason.retryAt,
          offset + pageBatch.indexOf(batch[i]),
        );
      }
      throw failed.reason;
    }
  }

  return { nextOffset, totalFiles };
}

export async function decodeGitHubContentResponse(
  response: Response,
): Promise<string | null> {
  const data = (await response.json()) as {
    content?: string;
    encoding?: string;
  };
  if (typeof data !== "object" || data === null) {
    throw new Error("Invalid file content response from GitHub");
  }

  if (typeof data.content !== "string") {
    return null;
  }

  if (data.encoding === "base64") {
    const base64 = data.content.replace(/\n/g, "");
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return new TextDecoder("utf-8").decode(bytes);
  }

  return data.content;
}

async function fetchBlobContent(
  githubRepo: string,
  blobSha: string,
  token: string,
): Promise<string | null> {
  const response = await fetchGitHub(
    `https://api.github.com/repos/${githubRepo}/git/blobs/${encodeURIComponent(blobSha)}`,
    token,
    `fetch blob ${blobSha}`,
  );

  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    throw new Error(`Failed to fetch repository blob: ${response.status}`);
  }

  return await decodeGitHubContentResponse(response);
}

/**
 * Get programming language from file path
 */
export function getLanguageFromPath(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase();

  const languageMap: Record<string, string> = {
    ts: "TypeScript",
    tsx: "TypeScript",
    js: "JavaScript",
    jsx: "JavaScript",
    py: "Python",
    java: "Java",
    go: "Go",
    rs: "Rust",
    c: "C",
    h: "C",
    cc: "C++",
    cpp: "C++",
    cxx: "C++",
    hpp: "C++",
    hxx: "C++",
    cs: "C#",
    fs: "F#",
    fsx: "F#",
    dart: "Dart",
    m: "Objective-C",
    mm: "Objective-C++",
    rb: "Ruby",
    php: "PHP",
    swift: "Swift",
    kt: "Kotlin",
    kts: "Kotlin",
    gradle: "Gradle",
    groovy: "Groovy",
    scala: "Scala",
    md: "Markdown",
    mdc: "Markdown",
    json: "JSON",
    yaml: "YAML",
    yml: "YAML",
    toml: "TOML",
    sql: "SQL",
    sh: "Shell",
    bash: "Shell",
  };

  return ext ? languageMap[ext] : undefined;
}

/**
 * Check if a file is likely to be text-based
 */
export function isTextFile(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase();
  const basename = path.split("/").pop() ?? "";

  // Treat common extensionless text files as text
  const extensionlessText = new Set([
    "README",
    "LICENSE",
    "CHANGELOG",
    "CONTRIBUTING",
    "AUTHORS",
    "CONTRIBUTORS",
    "Dockerfile",
    "Makefile",
    ".gitignore",
    ".gitattributes",
    ".dockerignore",
    ".editorconfig",
  ]);

  if (!ext) {
    return extensionlessText.has(basename);
  }

  const textExtensions = [
    "ts",
    "tsx",
    "js",
    "jsx",
    "py",
    "java",
    "go",
    "rs",
    "c",
    "cc",
    "cpp",
    "cxx",
    "h",
    "hpp",
    "hxx",
    "cs",
    "fs",
    "fsx",
    "dart",
    "m",
    "mm",
    "rb",
    "php",
    "swift",
    "kt",
    "kts",
    "gradle",
    "groovy",
    "scala",
    "md",
    "mdc",
    "json",
    "yaml",
    "yml",
    "toml",
    "xml",
    "html",
    "css",
    "scss",
    "sql",
    "sh",
    "bash",
    "txt",
    "config",
    "env",
  ];

  return textExtensions.includes(ext);
}
