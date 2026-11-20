import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { readGitHubAccountId } from "../users/githubAccount";

export const GITHUB_INSTALLATION_ATTESTATION_TTL_MS = 15 * 60 * 1_000;
export const GITHUB_INSTALLATION_ATTESTATION_PAGE_SIZE = 100;
export const GITHUB_INSTALLATION_ATTESTATION_MAX_INSTALLATIONS = 500;
export const GITHUB_INSTALLATION_ATTESTATION_REQUEST_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readPositiveSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function normalizeInstallationIds(value: unknown): number[] | null {
  if (
    !Array.isArray(value) ||
    value.length > GITHUB_INSTALLATION_ATTESTATION_MAX_INSTALLATIONS
  ) {
    return null;
  }
  const installationIds = new Set<number>();
  for (const candidate of value) {
    const installationId = readPositiveSafeInteger(candidate);
    if (installationId === null || installationIds.has(installationId)) {
      return null;
    }
    installationIds.add(installationId);
  }
  return Array.from(installationIds).sort((left, right) => left - right);
}

/** Headers for GitHub's REST API with the given Authorization value. */
export function githubApiHeaders(
  authorization: string,
): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: authorization,
    "User-Agent": "Gitdog",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * Resolve every GitHub App installation currently associated with one user
 * access token. The token remains local to this request and is never returned.
 */
export async function fetchAccessibleGitHubInstallationIds(
  accessToken: string,
  request: typeof fetch = fetch,
): Promise<number[]> {
  if (accessToken.trim() === "") {
    throw new Error("GitHub user authorization is unavailable");
  }

  let expectedTotal: number | null = null;
  const installationIds = new Set<number>();
  for (
    let page = 1;
    page <=
    Math.ceil(
      GITHUB_INSTALLATION_ATTESTATION_MAX_INSTALLATIONS /
        GITHUB_INSTALLATION_ATTESTATION_PAGE_SIZE,
    );
    page++
  ) {
    const url = new URL("https://api.github.com/user/installations");
    url.searchParams.set(
      "per_page",
      GITHUB_INSTALLATION_ATTESTATION_PAGE_SIZE.toString(),
    );
    url.searchParams.set("page", page.toString());

    let payload: unknown;
    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(),
      GITHUB_INSTALLATION_ATTESTATION_REQUEST_TIMEOUT_MS,
    );
    try {
      const response = await request(url, {
        headers: githubApiHeaders(`Bearer ${accessToken}`),
        signal: abortController.signal,
      });
      if (!response.ok) {
        throw new Error("GitHub request failed");
      }
      payload = (await response.json()) as unknown;
    } catch {
      throw new Error("Unable to verify GitHub App installations");
    } finally {
      clearTimeout(timeout);
    }
    if (!isRecord(payload)) {
      throw new Error("GitHub returned invalid installation access data");
    }
    const totalCount = payload.total_count;
    const installations = payload.installations;
    if (
      typeof totalCount !== "number" ||
      !Number.isSafeInteger(totalCount) ||
      totalCount < 0 ||
      totalCount > GITHUB_INSTALLATION_ATTESTATION_MAX_INSTALLATIONS ||
      !Array.isArray(installations) ||
      installations.length > GITHUB_INSTALLATION_ATTESTATION_PAGE_SIZE ||
      (expectedTotal !== null && totalCount !== expectedTotal)
    ) {
      throw new Error("GitHub installation access exceeds the supported limit");
    }
    expectedTotal = totalCount;

    for (const installation of installations) {
      const installationId = isRecord(installation)
        ? readPositiveSafeInteger(installation.id)
        : null;
      if (installationId === null || installationIds.has(installationId)) {
        throw new Error("GitHub returned invalid installation access data");
      }
      installationIds.add(installationId);
    }

    if (installationIds.size === expectedTotal) {
      return Array.from(installationIds).sort((left, right) => left - right);
    }
    if (
      installations.length !== GITHUB_INSTALLATION_ATTESTATION_PAGE_SIZE ||
      installationIds.size > expectedTotal
    ) {
      throw new Error("GitHub returned incomplete installation access data");
    }
  }

  throw new Error("GitHub installation access exceeds the supported limit");
}

/**
 * Replace the user's short-lived installation snapshot. One snapshot exists
 * per user and per GitHub account, and they must be the same row.
 */
export async function saveInstallationAttestation(
  ctx: MutationCtx,
  args: {
    userId: Id<"users">;
    githubAccountId: string;
    installationIds: unknown;
    now: number;
  },
): Promise<void> {
  const { userId, now } = args;
  const githubAccountId = readGitHubAccountId(args.githubAccountId);
  const installationIds = normalizeInstallationIds(args.installationIds);
  if (githubAccountId === null || installationIds === null) {
    throw new Error("GitHub installation attestation is invalid");
  }

  const [byUser, byAccount] = await Promise.all([
    ctx.db
      .query("githubOAuthInstallationAttestations")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(2),
    ctx.db
      .query("githubOAuthInstallationAttestations")
      .withIndex("by_github_account", (q) =>
        q.eq("githubAccountId", githubAccountId),
      )
      .take(2),
  ]);
  if (byUser.length > 1 || byAccount.length > 1) {
    throw new Error("Duplicate GitHub installation attestations");
  }
  const existing = byUser[0];
  if (
    (existing && existing.githubAccountId !== githubAccountId) ||
    (byAccount[0] && byAccount[0].userId !== userId) ||
    (existing && byAccount[0] && existing._id !== byAccount[0]._id)
  ) {
    throw new Error("GitHub installation attestation owner mismatch");
  }

  const snapshot = {
    userId,
    githubAccountId,
    installationIds,
    attestedAt: now,
    expiresAt: now + GITHUB_INSTALLATION_ATTESTATION_TTL_MS,
    updatedAt: now,
  };
  if (existing) {
    await ctx.db.patch(existing._id, snapshot);
  } else {
    await ctx.db.insert("githubOAuthInstallationAttestations", snapshot);
  }
}
