import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export const GITHUB_INSTALLATION_ATTESTATION_TTL_MS = 15 * 60 * 1_000;
export const GITHUB_INSTALLATION_ATTESTATION_PAGE_SIZE = 100;
export const GITHUB_INSTALLATION_ATTESTATION_MAX_INSTALLATIONS = 500;
export const GITHUB_INSTALLATION_ATTESTATION_REQUEST_TIMEOUT_MS = 10_000;

type GitHubOAuthProfile = Record<string, unknown> & {
  githubAccountId?: unknown;
  githubInstallationIds?: unknown;
};

type GitHubOAuthUserArgs = {
  existingUserId: Id<"users"> | null;
  type: "oauth" | "credentials" | "email" | "phone" | "verification";
  provider: { id: string; type: string };
  profile: GitHubOAuthProfile;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readPositiveSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function readGitHubAccountId(value: unknown): string | null {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
  const numericId = Number(value);
  return Number.isSafeInteger(numericId) ? value : null;
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

function readOptionalProfileString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
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
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": "Gitdog",
          "X-GitHub-Api-Version": "2022-11-28",
        },
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

/** Persist only a short-lived installation snapshot, never the OAuth token. */
export async function persistGitHubInstallationAttestation(
  ctx: MutationCtx,
  args: GitHubOAuthUserArgs,
): Promise<Id<"users">> {
  if (
    args.type !== "oauth" ||
    args.provider.id !== "github" ||
    args.provider.type !== "oauth"
  ) {
    throw new Error("Unsupported authentication provider");
  }

  const githubAccountId = readGitHubAccountId(args.profile.githubAccountId);
  const installationIds = normalizeInstallationIds(
    args.profile.githubInstallationIds,
  );
  if (githubAccountId === null || installationIds === null) {
    throw new Error("GitHub installation attestation is invalid");
  }

  const now = Date.now();
  const email = readOptionalProfileString(args.profile.email);
  const userFields = {
    name: readOptionalProfileString(args.profile.name),
    image: readOptionalProfileString(args.profile.image),
    email,
    emailVerificationTime: email === undefined ? undefined : now,
  };

  let userId = args.existingUserId;
  if (userId === null) {
    userId = await ctx.db.insert("users", userFields);
  } else {
    const [user, accounts] = await Promise.all([
      ctx.db.get(userId),
      ctx.db
        .query("authAccounts")
        .withIndex("userIdAndProvider", (q) =>
          q.eq("userId", userId!).eq("provider", "github"),
        )
        .take(2),
    ]);
    if (
      !user ||
      accounts.length !== 1 ||
      accounts[0].providerAccountId !== githubAccountId
    ) {
      throw new Error("GitHub account identity changed during sign-in");
    }
    await ctx.db.patch(userId, userFields);
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
  return userId;
}
