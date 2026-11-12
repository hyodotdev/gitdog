import { SignJWT, importPKCS8 } from "jose";
import { getConfiguredGitHubAppSlug, isGitdogBot } from "./botIdentity";

const GITHUB_APP_REQUEST_TIMEOUT_MS = 15_000;
const GITHUB_API_REQUEST_TIMEOUT_MS = 30_000;
const GITHUB_APP_REQUEST_MAX_ATTEMPTS = 2;
const GITHUB_APP_REQUEST_RETRY_DELAY_MS = 500;
const GITHUB_APP_REQUEST_MAX_RETRY_DELAY_MS = 5_000;
export const GITHUB_API_VERSION = "2026-03-10";

async function fetchGitHubApi(
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  return await fetch(input, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(GITHUB_API_REQUEST_TIMEOUT_MS),
  });
}

class NonRetryableGitHubAppRequestError extends Error {}

export class GitHubAppRateLimitError extends Error {
  constructor(
    operation: string,
    readonly retryAt: number,
    readonly status: number,
  ) {
    super(`${operation} was rate limited by GitHub (HTTP ${status})`);
    this.name = "GitHubAppRateLimitError";
  }
}

type GitHubAppJsonRequestBody = {
  repository_ids: ReadonlyArray<number>;
};

type GitHubAppRequestControls = {
  maxAttempts?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
};

type GitHubAppRequestOptions = GitHubAppRequestControls &
  (
    | { method?: "GET"; jsonBody?: never }
    | { method: "POST"; jsonBody?: GitHubAppJsonRequestBody }
  );

function sanitizeRequestErrorName(error: unknown): string {
  if (!(error instanceof Error)) {
    return "unknown";
  }
  return error.name.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 80) || "Error";
}

function isRetryableGitHubAppResponse(response: Response): boolean {
  return (
    response.status === 408 ||
    response.status === 429 ||
    response.status >= 500 ||
    (response.status === 403 &&
      (response.headers.has("retry-after") ||
        response.headers.get("x-ratelimit-remaining") === "0"))
  );
}

function getGitHubAppRateLimitRetryAt(
  response: Response,
  now = Date.now(),
): number | null {
  const isRateLimited =
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.has("retry-after") ||
        response.headers.get("x-ratelimit-remaining") === "0"));
  if (!isRateLimited) {
    return null;
  }

  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const retryAt = Date.parse(retryAfter);
    const requestedRetryAt = Number.isFinite(seconds)
      ? now + seconds * 1_000
      : retryAt;
    if (Number.isFinite(requestedRetryAt) && requestedRetryAt > now) {
      return Math.max(now + 1_000, requestedRetryAt);
    }
  }

  const resetSeconds = Number(response.headers.get("x-ratelimit-reset"));
  const resetAt = resetSeconds * 1_000;
  if (Number.isFinite(resetAt) && resetAt > now) {
    return Math.max(now + 1_000, resetAt);
  }

  return now + 60_000;
}

function getGitHubAppRetryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const retryAt = Date.parse(retryAfter);
    const requestedDelay = Number.isFinite(seconds)
      ? seconds * 1_000
      : Number.isNaN(retryAt)
        ? 0
        : retryAt - Date.now();
    return Math.min(
      GITHUB_APP_REQUEST_MAX_RETRY_DELAY_MS,
      Math.max(0, requestedDelay),
    );
  }

  return Math.min(
    GITHUB_APP_REQUEST_MAX_RETRY_DELAY_MS,
    GITHUB_APP_REQUEST_RETRY_DELAY_MS * 2 ** attempt,
  );
}

/** Make one authenticated GitHub App request without exposing response bodies or credentials. */
export async function fetchGitHubAppJsonWithRetry<T>(
  url: string,
  jwt: string,
  operation: string,
  options: GitHubAppRequestOptions = {},
): Promise<T> {
  const maxAttempts = Math.min(
    Math.max(
      Math.trunc(options.maxAttempts ?? GITHUB_APP_REQUEST_MAX_ATTEMPTS),
      1,
    ),
    5,
  );
  const timeoutMs = Math.max(
    Math.trunc(options.timeoutMs ?? GITHUB_APP_REQUEST_TIMEOUT_MS),
    1,
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep =
    options.sleep ??
    ((delayMs: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const requestBody =
    options.jsonBody === undefined
      ? undefined
      : JSON.stringify(options.jsonBody);
  let lastFailure = "unknown";
  let lastRateLimit: { retryAt: number; status: number } | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let retryDelayMs = Math.min(
      GITHUB_APP_REQUEST_MAX_RETRY_DELAY_MS,
      GITHUB_APP_REQUEST_RETRY_DELAY_MS * 2 ** attempt,
    );
    try {
      const response = await fetchImpl(url, {
        method: options.method ?? "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${jwt}`,
          ...(requestBody === undefined
            ? {}
            : { "Content-Type": "application/json" }),
          "User-Agent": "Gitdog",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
        body: requestBody,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.ok) {
        return (await response.json()) as T;
      }

      const retryable = isRetryableGitHubAppResponse(response);
      const rateLimitRetryAt = getGitHubAppRateLimitRetryAt(response);
      lastRateLimit =
        rateLimitRetryAt === null
          ? undefined
          : { retryAt: rateLimitRetryAt, status: response.status };
      retryDelayMs = getGitHubAppRetryDelayMs(response, attempt);
      lastFailure = `HTTP ${response.status}`;
      try {
        await response.body?.cancel();
      } catch {
        // The response status is sufficient; never surface an error body.
      }
      if (!retryable) {
        throw new NonRetryableGitHubAppRequestError(
          `${operation} failed (${lastFailure})`,
        );
      }
    } catch (error) {
      if (error instanceof NonRetryableGitHubAppRequestError) {
        throw error;
      }
      lastRateLimit = undefined;
      lastFailure = sanitizeRequestErrorName(error);
    }

    if (attempt + 1 < maxAttempts && retryDelayMs > 0) {
      await sleep(retryDelayMs);
    }
  }

  if (lastRateLimit) {
    throw new GitHubAppRateLimitError(
      operation,
      lastRateLimit.retryAt,
      lastRateLimit.status,
    );
  }

  throw new Error(
    `${operation} failed after ${maxAttempts} attempts (${lastFailure})`,
  );
}

function getGitdogMentionPattern(configuredSlug?: string): RegExp | null {
  const slug = getConfiguredGitHubAppSlug(configuredSlug);
  return slug ? new RegExp(`@${slug}(?=\\s|[:,]|$)`, "i") : null;
}

export function normalizeGitdogMentionBody(
  body: string,
  configuredSlug?: string,
): string {
  const pattern = getGitdogMentionPattern(configuredSlug);
  if (!pattern) return body.trim();
  return body
    .replace(new RegExp(`^\\s*${pattern.source}[:,]?\\s*`, "i"), "")
    .trim();
}

export function hasGitdogMentionBody(
  body: string,
  configuredSlug?: string,
): boolean {
  return getGitdogMentionPattern(configuredSlug)?.test(body) ?? false;
}

/** Any edit to the exact triggering comment invalidates pending publication. */
export function isGitdogInvocationUnchanged(
  currentBody: string,
  storedRawBody: string,
  configuredSlug?: string,
): boolean {
  return (
    hasGitdogMentionBody(currentBody, configuredSlug) &&
    currentBody === storedRawBody
  );
}

// Normalize private key format
function normalizePrivateKey(privateKey: string): string {
  // Remove any extra whitespace and ensure proper newlines
  let normalized = privateKey.trim();

  // If the key has literal \n instead of actual newlines, replace them
  if (normalized.includes("\\n")) {
    normalized = normalized.replace(/\\n/g, "\n");
  }

  // Check if this is RSA PRIVATE KEY format (PKCS#1) instead of PRIVATE KEY (PKCS#8)
  if (normalized.includes("-----BEGIN RSA PRIVATE KEY-----")) {
    throw new Error(
      "Invalid private key format: RSA PRIVATE KEY (PKCS#1) detected. " +
        "Please convert to PKCS#8 format using: " +
        "openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in old-key.pem -out new-key.pem " +
        "or generate a new key from GitHub App settings.",
    );
  }

  // Ensure the key has proper PKCS#8 header and footer
  if (!normalized.includes("-----BEGIN PRIVATE KEY-----")) {
    throw new Error(
      "Invalid private key format: missing BEGIN PRIVATE KEY header. " +
        "Expected PKCS#8 format, not PKCS#1.",
    );
  }
  if (!normalized.includes("-----END PRIVATE KEY-----")) {
    throw new Error(
      "Invalid private key format: missing END PRIVATE KEY footer",
    );
  }

  return normalized;
}

// Generate JWT for GitHub App authentication
export async function generateGitHubAppJWT(
  appId: string,
  privateKey: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  let key: CryptoKey;
  try {
    const normalizedKey = normalizePrivateKey(privateKey);
    key = await importPKCS8(normalizedKey, "RS256");
  } catch {
    console.error("Failed to import GitHub App private key");
    throw new Error(
      "Failed to import GitHub App private key; verify the PKCS#8 configuration",
    );
  }

  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + 600) // 10 minutes
    .setIssuer(appId)
    .sign(key);

  return jwt;
}

// Get installation access token
export async function getInstallationToken(
  installationId: number,
  appId: string,
  privateKey: string,
): Promise<string> {
  const jwt = await generateGitHubAppJWT(appId, privateKey);
  const data = await fetchGitHubAppJsonWithRetry<{ token?: unknown }>(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    jwt,
    "GitHub installation token request",
    { method: "POST" },
  );
  if (typeof data.token !== "string" || data.token.length === 0) {
    throw new Error("GitHub installation token request returned invalid data");
  }
  return data.token;
}

function assertPositiveSafeGitHubId(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

/**
 * Mint a token whose repository scope proves that the installation still has
 * the immutable repository ID selected. Public metadata alone is insufficient
 * because GitHub Apps can read public repository metadata without selection.
 */
export async function getRepositoryInstallationToken(
  installationId: number,
  repositoryId: number,
  appId: string,
  privateKey: string,
): Promise<string> {
  assertPositiveSafeGitHubId(installationId, "GitHub installation ID");
  assertPositiveSafeGitHubId(repositoryId, "GitHub repository ID");

  const jwt = await generateGitHubAppJWT(appId, privateKey);
  const data = await fetchGitHubAppJsonWithRetry<{ token?: unknown }>(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    jwt,
    "GitHub repository-scoped installation token request",
    {
      method: "POST",
      jsonBody: { repository_ids: [repositoryId] },
    },
  );
  if (typeof data.token !== "string" || data.token.length === 0) {
    throw new Error(
      "GitHub repository-scoped installation token request returned invalid data",
    );
  }
  return data.token;
}

export type GitHubInstallationAccessState =
  "active" | "suspended" | "deleted" | "unknown";

/**
 * Verify whether GitHub considers an installation active. A repository-list
 * 403 is not authoritative: it may be a transient or rate-limit response.
 */
export async function getGitHubInstallationAccessState(
  installationId: number,
  appId: string,
  privateKey: string,
): Promise<GitHubInstallationAccessState> {
  try {
    const jwt = await generateGitHubAppJWT(appId, privateKey);
    const installation = await fetchGitHubAppJsonWithRetry<{
      suspended_at?: unknown;
    }>(
      `https://api.github.com/app/installations/${installationId}`,
      jwt,
      "GitHub installation state lookup",
    );
    if (installation.suspended_at === null) {
      return "active";
    }
    if (
      typeof installation.suspended_at === "string" &&
      installation.suspended_at.length > 0
    ) {
      return "suspended";
    }
    return "unknown";
  } catch (error) {
    return error instanceof Error && error.message.includes("HTTP 404")
      ? "deleted"
      : "unknown";
  }
}

/** Resolve the current app installation that GitHub says owns one repository. */
export async function getRepositoryInstallationId(
  githubRepo: string,
  appId: string,
  privateKey: string,
): Promise<number> {
  const parts = githubRepo.split("/");
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
    throw new Error("Invalid GitHub repository name");
  }

  const jwt = await generateGitHubAppJWT(appId, privateKey);
  const data = await fetchGitHubAppJsonWithRetry<{ id?: unknown }>(
    `https://api.github.com/repos/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}/installation`,
    jwt,
    "GitHub repository installation lookup",
  );
  if (
    typeof data.id !== "number" ||
    !Number.isSafeInteger(data.id) ||
    data.id <= 0
  ) {
    throw new Error(
      "GitHub repository installation lookup returned invalid data",
    );
  }
  return data.id;
}

export type GitHubTreeItem = {
  path: string;
  mode: string;
  type: "blob" | "tree";
  sha: string;
};

// Add comment to issue
export async function addIssueComment(
  owner: string,
  repo: string,
  relatedIssue: number,
  body: string,
  token: string,
): Promise<number> {
  const response = await fetchGitHubApi(
    `https://api.github.com/repos/${owner}/${repo}/issues/${relatedIssue}/comments`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github.v3+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "Gitdog",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body }),
    },
  );

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Failed to add issue comment (HTTP ${response.status})`);
  }

  const data = (await response.json()) as { id: number };
  return data.id;
}

// Update issue title and/or body
export async function updateIssue(
  owner: string,
  repo: string,
  issueNumber: number,
  updates: {
    title?: string;
    body?: string;
  },
  token: string,
): Promise<void> {
  const response = await fetchGitHubApi(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`,
    {
      method: "PATCH",
      headers: {
        Accept: "application/vnd.github.v3+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "Gitdog",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(updates),
    },
  );

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Failed to update GitHub issue (HTTP ${response.status})`);
  }
}

type GitHubIssueComment = {
  id: number;
  body: string;
  user: { login: string; type: string };
  author_association: string;
  created_at: string;
};

// Get the latest issue comments in chronological order (oldest first)
export async function getIssueComments(
  owner: string,
  repo: string,
  issueNumber: number,
  token: string,
  options?: {
    limit?: number; // Maximum number of comments to return (default 5)
  },
): Promise<GitHubIssueComment[]> {
  const limit = Math.min(Math.max(options?.limit ?? 5, 1), 100);
  const headers = {
    Accept: "application/vnd.github.v3+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "Gitdog",
  };
  const firstPageUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`;

  const fetchPage = async (
    url: string,
  ): Promise<
    { comments: GitHubIssueComment[]; linkHeader: string | null } | undefined
  > => {
    const response = await fetchGitHubApi(url, { headers });
    if (!response.ok) {
      await response.body?.cancel();
      console.error("Failed to get issue comments", {
        status: response.status,
      });
      return undefined;
    }

    return {
      comments: (await response.json()) as GitHubIssueComment[],
      linkHeader: response.headers.get("link"),
    };
  };

  const firstPage = await fetchPage(firstPageUrl);
  if (!firstPage) {
    return [];
  }

  // This endpoint is ordered by ascending comment ID and does not support
  // sort/direction. Follow rel="last" so long threads use their newest page.
  const lastPageUrl = firstPage.linkHeader
    ?.split(",")
    .find((part) => part.includes('rel="last"'))
    ?.match(/<([^>]+)>/)?.[1];
  const latestPage =
    lastPageUrl && lastPageUrl !== firstPageUrl
      ? await fetchPage(lastPageUrl)
      : firstPage;

  if (!latestPage) {
    return [];
  }

  let comments = latestPage.comments;

  // A partially filled last page does not contain enough history by itself.
  // Merge the preceding page so a thread with 101 comments can still return
  // comments 96-101 for limit=6, instead of returning only comment 101.
  if (lastPageUrl && comments.length < limit) {
    try {
      const parsedLastPageUrl = new URL(lastPageUrl);
      const lastPageNumber = Number(parsedLastPageUrl.searchParams.get("page"));

      if (Number.isInteger(lastPageNumber) && lastPageNumber > 1) {
        let previousPage: typeof firstPage | undefined;

        if (lastPageNumber === 2) {
          previousPage = firstPage;
        } else {
          parsedLastPageUrl.searchParams.set(
            "page",
            String(lastPageNumber - 1),
          );
          previousPage = await fetchPage(parsedLastPageUrl.toString());
        }

        if (previousPage) {
          const seen = new Set<number>();
          comments = [...previousPage.comments, ...comments].filter(
            (comment) => {
              if (seen.has(comment.id)) return false;
              seen.add(comment.id);
              return true;
            },
          );
        }
      }
    } catch {
      console.warn("Failed to fetch preceding issue comment page");
    }
  }

  // Preserve GitHub's ascending order for the conversation prompt.
  return comments.slice(-limit);
}

const EXECUTION_MARKER_LOOKUP_MAX_PAGES = 50;

export type GitHubCommentMarkerLookup<T extends string | number> = {
  commentId: T | null;
  exhaustive: boolean;
};

/**
 * Search issue comments newest-first for a Gitdog-owned execution marker.
 * `exhaustive: false` is deliberately distinct from "not found" so callers
 * never publish after an incomplete idempotency check.
 */
export async function findIssueCommentByExecutionMarker(
  owner: string,
  repo: string,
  issueNumber: number,
  marker: string,
  token: string,
): Promise<GitHubCommentMarkerLookup<number>> {
  if (!getConfiguredGitHubAppSlug()) {
    throw new Error("GitHub App identity is not configured");
  }
  const headers = {
    Accept: "application/vnd.github.v3+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "Gitdog",
  };
  const pageUrl = (page: number) =>
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`;
  const fetchPage = async (page: number) => {
    const response = await fetchGitHubApi(pageUrl(page), { headers });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(
        `Failed to reconcile issue comments (HTTP ${response.status})`,
      );
    }
    return {
      comments: (await response.json()) as GitHubIssueComment[],
      linkHeader: response.headers.get("link"),
    };
  };

  const firstPage = await fetchPage(1);
  const lastPageUrl = firstPage.linkHeader
    ?.split(",")
    .find((part) => part.includes('rel="last"'))
    ?.match(/<([^>]+)>/)?.[1];
  const parsedLastPage = lastPageUrl
    ? Number(new URL(lastPageUrl).searchParams.get("page"))
    : 1;
  const lastPage =
    Number.isSafeInteger(parsedLastPage) && parsedLastPage > 0
      ? parsedLastPage
      : 1;
  const firstPageToInspect = Math.max(
    1,
    lastPage - EXECUTION_MARKER_LOOKUP_MAX_PAGES + 1,
  );

  for (let page = lastPage; page >= firstPageToInspect; page -= 1) {
    const comments =
      page === 1 ? firstPage.comments : (await fetchPage(page)).comments;
    const match = [...comments]
      .reverse()
      .find(
        (comment) =>
          isGitdogBot(comment.user.login) && comment.body.includes(marker),
      );
    if (match) return { commentId: match.id, exhaustive: true };
  }

  return {
    commentId: null,
    exhaustive: firstPageToInspect === 1,
  };
}

// Get issue details
export async function getIssue(
  owner: string,
  repo: string,
  issueNumber: number,
  token: string,
): Promise<{
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  updatedAt?: string;
  author?: string;
}> {
  const response = await fetchGitHubApi(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`,
    {
      headers: {
        Accept: "application/vnd.github.v3+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "Gitdog",
      },
    },
  );

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Failed to get issue (HTTP ${response.status})`);
  }

  const data = (await response.json()) as {
    title: string;
    body: string | null;
    html_url: string;
    state: string;
    updated_at?: string;
    user?: { login?: string } | null;
  };
  return {
    ...data,
    updatedAt: data.updated_at,
    author: data.user?.login,
  };
}

/** Read one issue comment by its immutable REST ID. */
export async function getIssueComment(
  owner: string,
  repo: string,
  commentId: number,
  token: string,
): Promise<{ id: number; body: string } | null> {
  const response = await fetchGitHubApi(
    `https://api.github.com/repos/${owner}/${repo}/issues/comments/${commentId}`,
    {
      headers: {
        Accept: "application/vnd.github.v3+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "Gitdog",
      },
    },
  );
  if (!response.ok) {
    if (response.status === 404) return null;
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Failed to get issue comment (HTTP ${response.status})`);
  }

  return (await response.json()) as { id: number; body: string };
}

// Get repository maintainers as actual GitHub user logins.
// The `owner` field on a repo can be either a User or an Organization — only
// the User case is a mentionable person. For Organization-owned repos we rely
// solely on collaborators (and org admins, when accessible) so we never
// @-mention the org name as if it were a user.
export async function getRepositoryMaintainers(
  owner: string,
  repo: string,
  token: string,
): Promise<string[]> {
  const maintainers: string[] = [];
  const seen = new Set<string>();
  const add = (login: string) => {
    if (!seen.has(login)) {
      seen.add(login);
      maintainers.push(login);
    }
  };

  const headers = {
    Accept: "application/vnd.github.v3+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "Gitdog",
  };

  try {
    const ownerRes = await fetchGitHubApi(
      `https://api.github.com/users/${owner}`,
      { headers },
    );
    if (ownerRes.ok) {
      const ownerData = (await ownerRes.json()) as {
        login: string;
        type: "User" | "Organization" | "Bot";
      };
      if (ownerData.type === "User") {
        add(ownerData.login);
      } else if (ownerData.type === "Organization") {
        const adminsRes = await fetchGitHubApi(
          `https://api.github.com/orgs/${owner}/members?role=admin&per_page=100`,
          { headers },
        );
        if (adminsRes.ok) {
          const admins = (await adminsRes.json()) as Array<{ login: string }>;
          for (const admin of admins) add(admin.login);
        }
      }
    }
  } catch {
    // Owner type lookup failed — fall through to collaborators.
  }

  try {
    const response = await fetchGitHubApi(
      `https://api.github.com/repos/${owner}/${repo}/collaborators?permission=push&per_page=100`,
      { headers },
    );

    if (response.ok) {
      const collaborators = (await response.json()) as Array<{
        login: string;
        type?: "User" | "Bot";
        permissions?: { admin?: boolean; push?: boolean };
      }>;

      for (const collab of collaborators) {
        if (collab.type === "Bot") continue;
        add(collab.login);
      }
    }
  } catch {
    // If we can't get collaborators, return what we have so far.
  }

  return maintainers;
}

/**
 * Get Discussion comments (GraphQL API, sorted chronologically)
 */
export async function getDiscussionComments(
  owner: string,
  repo: string,
  discussionNumber: number,
  token: string,
  options?: {
    limit?: number; // Maximum number of comments to return (default 5)
    currentCommentNodeId?: string; // Focus an old thread when the webhook is for a reply
  },
): Promise<
  Array<{
    id: string;
    body: string;
    author: { __typename: string; login: string } | null;
    authorAssociation: string; // OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, etc.
    createdAt: string;
  }>
> {
  const limit = Math.min(Math.max(options?.limit ?? 5, 1), 100);
  const replyLimit = Math.max(limit, 10);

  type FlatComment = {
    id: string;
    body: string;
    author: { __typename: string; login: string } | null;
    authorAssociation: string;
    createdAt: string;
  };

  type CommentNode = FlatComment & {
    replies?: {
      nodes: FlatComment[];
    };
    replyTo?: CommentNode | null;
  };

  const commentFields = `
    fragment DiscussionCommentFields on DiscussionComment {
      id
      body
      author {
        __typename
        login
      }
      authorAssociation
      createdAt
    }
  `;

  const recentCommentsSelection = `
    repository(owner: $owner, name: $repo) {
      discussion(number: $discussionNumber) {
        comments(last: $limit) {
          nodes {
            ...DiscussionCommentFields
            replies(last: $replyLimit) {
              nodes {
                ...DiscussionCommentFields
              }
            }
          }
        }
      }
    }
  `;

  // Fetch both top-level comments AND their replies
  // Discussion structure: comments -> replies (nested)
  // authorAssociation: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, FIRST_TIMER, FIRST_TIME_CONTRIBUTOR, NONE
  // When the current comment is a reply, fetch its parent thread directly.
  // That thread may be older than comments(last: limit) and would otherwise be
  // absent from the follow-up prompt.
  const hasFocusedComment = Boolean(options?.currentCommentNodeId);
  const query = hasFocusedComment
    ? `
      query DiscussionCommentContext(
        $owner: String!
        $repo: String!
        $discussionNumber: Int!
        $limit: Int!
        $replyLimit: Int!
        $currentCommentNodeId: ID!
      ) {
        ${recentCommentsSelection}
        focusedComment: node(id: $currentCommentNodeId) {
          ... on DiscussionComment {
            ...DiscussionCommentFields
            replies(last: $replyLimit) {
              nodes {
                ...DiscussionCommentFields
              }
            }
            replyTo {
              ...DiscussionCommentFields
              replies(last: $replyLimit) {
                nodes {
                  ...DiscussionCommentFields
                }
              }
            }
          }
        }
      }
      ${commentFields}
    `
    : `
      query DiscussionCommentContext(
        $owner: String!
        $repo: String!
        $discussionNumber: Int!
        $limit: Int!
        $replyLimit: Int!
      ) {
        ${recentCommentsSelection}
      }
      ${commentFields}
    `;

  const variables: Record<string, string | number> = {
    owner,
    repo,
    discussionNumber,
    limit,
    replyLimit,
  };
  if (options?.currentCommentNodeId) {
    variables.currentCommentNodeId = options.currentCommentNodeId;
  }

  const response = await fetchGitHubApi("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "Gitdog",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    console.error("Failed to get discussion comments", {
      status: response.status,
    });
    return [];
  }

  const data = (await response.json()) as {
    data?: {
      repository?: {
        discussion?: {
          comments?: {
            nodes: Array<CommentNode>;
          };
        };
      };
      focusedComment?: CommentNode | null;
    };
    errors?: Array<{ message: string }>;
  };

  if (data.errors) {
    console.error("GitHub returned discussion comment GraphQL errors", {
      errorCount: data.errors.length,
    });
  }

  const topLevelComments =
    data.data?.repository?.discussion?.comments?.nodes || [];

  const flattenComments = (comments: CommentNode[]): FlatComment[] =>
    comments.flatMap((comment) => [comment, ...(comment.replies?.nodes ?? [])]);
  const dedupeAndSort = (comments: FlatComment[]): FlatComment[] => {
    const byId = new Map<string, FlatComment>();
    for (const comment of comments) byId.set(comment.id, comment);
    return [...byId.values()].sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  };

  const focusedComment = data.data?.focusedComment;
  if (focusedComment?.replyTo) {
    const rootComment = focusedComment.replyTo;
    const thread = dedupeAndSort([
      rootComment,
      ...(rootComment.replies?.nodes ?? []),
      focusedComment,
    ]);

    if (thread.length <= limit) return thread;
    if (limit === 1) return [focusedComment];

    // Always retain the parent comment, then use the newest replies so the
    // current reply and its immediate thread context survive webhook filtering.
    const replies = thread.filter((comment) => comment.id !== rootComment.id);
    return dedupeAndSort([rootComment, ...replies.slice(-(limit - 1))]);
  }

  const recentAndFocused = dedupeAndSort([
    ...flattenComments(topLevelComments),
    ...(focusedComment ? flattenComments([focusedComment]) : []),
  ]);

  return recentAndFocused.slice(-limit);
}

/** Search either top-level discussion comments or one reply thread. */
export async function findDiscussionCommentByExecutionMarker(
  owner: string,
  repo: string,
  discussionNumber: number,
  replyToCommentNodeId: string | undefined,
  marker: string,
  token: string,
): Promise<GitHubCommentMarkerLookup<string>> {
  if (!getConfiguredGitHubAppSlug()) {
    throw new Error("GitHub App identity is not configured");
  }
  const request = async <T>(
    query: string,
    variables: Record<string, unknown>,
  ) => {
    const response = await fetchGitHubApi("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "Gitdog",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(
        `Failed to reconcile discussion comments (HTTP ${response.status})`,
      );
    }
    const payload = (await response.json()) as {
      data?: T;
      errors?: Array<{ message: string }>;
    };
    if (payload.errors?.length || !payload.data) {
      throw new Error("Failed to reconcile discussion comments");
    }
    return payload.data;
  };

  type MarkerNode = {
    id: string;
    body: string;
    author: { login: string } | null;
  };
  type MarkerConnection = {
    nodes: MarkerNode[];
    pageInfo: { hasPreviousPage: boolean; startCursor: string | null };
  };
  const findMarker = (nodes: MarkerNode[]): MarkerNode | undefined =>
    [...nodes]
      .reverse()
      .find(
        (comment) =>
          isGitdogBot(comment.author?.login) && comment.body.includes(marker),
      );

  let rootCommentNodeId: string | undefined;
  if (replyToCommentNodeId) {
    const target = await request<{
      node?: { id: string; replyTo?: { id: string } | null } | null;
    }>(
      `query GitdogExecutionReplyTarget($id: ID!) {
        node(id: $id) {
          ... on DiscussionComment {
            id
            replyTo { id }
          }
        }
      }`,
      { id: replyToCommentNodeId },
    );
    if (!target.node) {
      throw new Error("Discussion reply target no longer exists");
    }
    rootCommentNodeId = target.node.replyTo?.id ?? target.node.id;
  }

  let before: string | null = null;
  for (let page = 0; page < EXECUTION_MARKER_LOOKUP_MAX_PAGES; page += 1) {
    let connection: MarkerConnection | undefined;
    if (rootCommentNodeId) {
      const data: {
        node?: { replies?: MarkerConnection } | null;
      } = await request(
        `query GitdogExecutionReplyMarker($id: ID!, $before: String) {
          node(id: $id) {
            ... on DiscussionComment {
              replies(last: 100, before: $before) {
                nodes { id body author { login } }
                pageInfo { hasPreviousPage startCursor }
              }
            }
          }
        }`,
        { id: rootCommentNodeId, before },
      );
      connection = data.node?.replies;
    } else {
      const data: {
        repository?: {
          discussion?: { comments?: MarkerConnection } | null;
        } | null;
      } = await request(
        `query GitdogExecutionCommentMarker(
          $owner: String!
          $repo: String!
          $number: Int!
          $before: String
        ) {
          repository(owner: $owner, name: $repo) {
            discussion(number: $number) {
              comments(last: 100, before: $before) {
                nodes { id body author { login } }
                pageInfo { hasPreviousPage startCursor }
              }
            }
          }
        }`,
        { owner, repo, number: discussionNumber, before },
      );
      connection = data.repository?.discussion?.comments;
    }
    if (!connection) {
      throw new Error("Discussion comments are unavailable");
    }

    const match = findMarker(connection.nodes);
    if (match) return { commentId: match.id, exhaustive: true };
    if (!connection.pageInfo.hasPreviousPage) {
      return { commentId: null, exhaustive: true };
    }
    if (!connection.pageInfo.startCursor) {
      throw new Error("Discussion comment pagination was incomplete");
    }
    before = connection.pageInfo.startCursor;
  }

  return { commentId: null, exhaustive: false };
}

async function getDiscussionNodeId(
  owner: string,
  repo: string,
  discussionNumber: number,
  token: string,
): Promise<string> {
  const query = `
    query {
      repository(owner: "${owner}", name: "${repo}") {
        discussion(number: ${discussionNumber}) {
          id
        }
      }
    }
  `;

  const response = await fetchGitHubApi("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "Gitdog",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Failed to find discussion (HTTP ${response.status})`);
  }

  const data = (await response.json()) as {
    data?: {
      repository?: {
        discussion?: {
          id: string;
        };
      };
    };
    errors?: Array<{ message: string }>;
  };

  if (data.errors) {
    throw new Error("Unable to access discussion");
  }

  if (!data.data?.repository?.discussion?.id) {
    throw new Error("Discussion was not found or is inaccessible");
  }

  return data.data.repository.discussion.id;
}

/**
 * Get the current discussion content before applying an AI-generated edit.
 * Callers use this to detect stale title/body snapshots immediately before an
 * external write.
 */
export async function getDiscussion(
  owner: string,
  repo: string,
  discussionNumber: number,
  token: string,
): Promise<{
  title: string;
  body: string;
  state: "open" | "closed";
  updatedAt?: string;
  htmlUrl?: string;
  author?: string;
}> {
  const query = `
    query GetDiscussion($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        discussion(number: $number) {
          title
          body
          closed
          updatedAt
          url
          author {
            login
          }
        }
      }
    }
  `;

  const response = await fetchGitHubApi("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "Gitdog",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      variables: {
        owner,
        repo,
        number: discussionNumber,
      },
    }),
  });

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Failed to get discussion (HTTP ${response.status})`);
  }

  const data = (await response.json()) as {
    data?: {
      repository?: {
        discussion?: {
          title: string;
          body: string;
          closed: boolean;
          updatedAt?: string;
          url?: string;
          author?: { login?: string } | null;
        } | null;
      } | null;
    };
    errors?: Array<{ message: string }>;
  };
  if (data.errors?.length) {
    throw new Error("Unable to read discussion");
  }

  const discussion = data.data?.repository?.discussion;
  if (!discussion) {
    throw new Error("Discussion was not found or is inaccessible");
  }

  return {
    title: discussion.title,
    body: discussion.body,
    state: discussion.closed ? "closed" : "open",
    updatedAt: discussion.updatedAt,
    htmlUrl: discussion.url,
    author: discussion.author?.login,
  };
}

/** Read one discussion comment by its GraphQL node ID. */
export async function getDiscussionComment(
  commentNodeId: string,
  token: string,
): Promise<{ id: string; body: string } | null> {
  const query = `
    query GetDiscussionComment($id: ID!) {
      node(id: $id) {
        ... on DiscussionComment {
          id
          body
        }
      }
    }
  `;
  const response = await fetchGitHubApi("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "Gitdog",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables: { id: commentNodeId } }),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Failed to get discussion comment");
  }

  const data = (await response.json()) as {
    data?: { node?: { id: string; body: string } | null };
    errors?: Array<{ message: string }>;
  };
  if (data.errors?.length) {
    throw new Error("Failed to get discussion comment");
  }
  return data.data?.node ?? null;
}

/**
 * Update GitHub Discussion (GraphQL API)
 */
export async function updateDiscussion(
  owner: string,
  repo: string,
  discussionNumber: number,
  updates: {
    title?: string;
    body?: string;
  },
  token: string,
): Promise<void> {
  // First, get the discussion node ID
  const nodeId = await getDiscussionNodeId(
    owner,
    repo,
    discussionNumber,
    token,
  );

  // Build the update mutation
  const titleArg = updates.title
    ? `title: ${JSON.stringify(updates.title)}`
    : "";
  const bodyArg = updates.body ? `body: ${JSON.stringify(updates.body)}` : "";
  const args = [titleArg, bodyArg].filter((a) => a).join(", ");

  const mutation = `
    mutation {
      updateDiscussion(input: {discussionId: "${nodeId}", ${args}}) {
        discussion {
          id
        }
      }
    }
  `;

  const response = await fetchGitHubApi("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "Gitdog",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: mutation }),
  });

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Failed to update discussion (HTTP ${response.status})`);
  }

  const data = (await response.json()) as {
    data?: unknown;
    errors?: Array<{ message: string }>;
  };

  if (data.errors) {
    throw new Error("Unable to update discussion");
  }
}

/**
 * Add a comment to GitHub Discussion (GraphQL API)
 */
export async function addDiscussionComment(
  owner: string,
  repo: string,
  discussionNumber: number,
  body: string,
  token: string,
): Promise<string> {
  // First, get the discussion node ID
  const nodeId = await getDiscussionNodeId(
    owner,
    repo,
    discussionNumber,
    token,
  );

  const mutation = `
    mutation {
      addDiscussionComment(input: {discussionId: "${nodeId}", body: ${JSON.stringify(body)}}) {
        comment {
          id
        }
      }
    }
  `;

  const response = await fetchGitHubApi("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "Gitdog",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: mutation }),
  });

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(
      `Failed to add discussion comment (HTTP ${response.status})`,
    );
  }

  const data = (await response.json()) as {
    data?: {
      addDiscussionComment?: {
        comment?: {
          id: string;
        };
      };
    };
    errors?: Array<{ message: string }>;
  };

  if (data.errors) {
    throw new Error("Unable to add discussion comment");
  }

  if (!data.data?.addDiscussionComment?.comment?.id) {
    throw new Error("Failed to add discussion comment");
  }

  return data.data.addDiscussionComment.comment.id;
}

/**
 * Get the root comment node ID for a discussion comment
 * If the comment is already a root comment, returns null
 * If the comment is a reply, returns the root comment's node ID
 */
async function getDiscussionCommentRootNodeId(
  commentNodeId: string,
  token: string,
): Promise<string | null> {
  const query = `
    query {
      node(id: "${commentNodeId}") {
        ... on DiscussionComment {
          replyTo {
            id
          }
        }
      }
    }
  `;

  const response = await fetchGitHubApi("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "Gitdog",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as {
    data?: {
      node?: {
        replyTo?: {
          id: string;
        };
      };
    };
  };

  return data.data?.node?.replyTo?.id ?? null;
}

/**
 * Add a reply to a GitHub Discussion comment (GraphQL API)
 * This creates a threaded reply to a specific comment
 * If the target comment is already a reply (in a thread), it will reply to the root comment instead
 */
export async function addDiscussionReply(
  owner: string,
  repo: string,
  discussionNumber: number,
  replyToCommentNodeId: string,
  body: string,
  token: string,
): Promise<string> {
  // First, get the discussion node ID
  const discussionNodeId = await getDiscussionNodeId(
    owner,
    repo,
    discussionNumber,
    token,
  );

  // Check if the target comment is already a reply - if so, get the root comment
  const rootNodeId = await getDiscussionCommentRootNodeId(
    replyToCommentNodeId,
    token,
  );
  const targetNodeId = rootNodeId ?? replyToCommentNodeId;

  console.log("[addDiscussionReply] Resolved discussion reply target");

  const mutation = `
    mutation {
      addDiscussionComment(input: {discussionId: "${discussionNodeId}", body: ${JSON.stringify(body)}, replyToId: "${targetNodeId}"}) {
        comment {
          id
        }
      }
    }
  `;

  const response = await fetchGitHubApi("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "Gitdog",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: mutation }),
  });

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Failed to add discussion reply (HTTP ${response.status})`);
  }

  const data = (await response.json()) as {
    data?: {
      addDiscussionComment?: {
        comment?: {
          id: string;
        };
      };
    };
    errors?: Array<{ message: string }>;
  };

  if (data.errors) {
    throw new Error("Unable to add discussion reply");
  }

  if (!data.data?.addDiscussionComment?.comment?.id) {
    throw new Error("Failed to add discussion reply");
  }

  return data.data.addDiscussionComment.comment.id;
}
