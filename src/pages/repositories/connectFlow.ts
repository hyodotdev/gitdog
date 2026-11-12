export const INSTALLATION_BINDING_MAX_ATTEMPTS = 20;
export const OAUTH_INSTALLATION_RECOVERY_MAX_INSTALLATIONS = 500;
export const PENDING_RECONNECT_TTL_MS = 15 * 60 * 1_000;

export const PENDING_RECONNECT_STORAGE_KEY =
  "gitdog.repositoryReconnect.pending.v1";

const INSTALLATION_BINDING_RETRY_BASE_MS = 250;
const INSTALLATION_BINDING_RETRY_MAX_MS = 2_000;
const RECONNECT_STATE_PREFIX = "gitdog.reconnect.v1.";
const RECONNECT_STATE_PATTERN = /^gitdog\.reconnect\.v1\.[a-f0-9]{32}$/;
const GITHUB_APP_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,99}$/;
const MAX_RECONNECT_REPOSITORY_ID_LENGTH = 256;

type ReconnectNavigationKind = "install" | "configure";

export type PendingReconnectMapping = {
  version: 1;
  state: string;
  reconnectRepositoryId: string;
  navigationKind: ReconnectNavigationKind;
  createdAt: number;
  expiresAt: number;
};

export type SessionStorageLike = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

export function getBrowserSessionStorage(
  resolveStorage: () => SessionStorageLike = () => window.sessionStorage,
): SessionStorageLike | null {
  try {
    return resolveStorage();
  } catch {
    return null;
  }
}

export type InstallationReconnectResolution = {
  installationId: number | null;
  reconnectRepositoryId: string | null;
  pendingStateToConsume: string | null;
};

type InstallationRecord = {
  installationId: number;
  reconciliationPending?: boolean;
  reconciliationFailed?: boolean;
};

export type InstallationAccountRecord = InstallationRecord & {
  accountLogin: string;
  accountType: string;
};

export type InstallationRepositoryRecord = InstallationAccountRecord;

export type InstallationRepositoryGroup<
  Repository extends InstallationRepositoryRecord,
> = InstallationAccountRecord & {
  reconciliationPending: boolean;
  reconciliationFailed?: true;
  repos: Repository[];
};

type WaitForInstallationBindingOptions = {
  installationId: number;
  refreshInstallation: (args: {
    installationId: number;
  }) => Promise<InstallationBindingRefreshResult>;
  sleep?: (delayMs: number) => Promise<void>;
  isCancelled?: () => boolean;
  maxAttempts?: number;
};

export type InstallationBindingRefreshResult =
  | { status: "not_bound_yet" }
  | { status: "reauth_required" }
  | { status: "bound"; installationId: number };

export type OAuthInstallationRecoveryResult =
  | { status: "recovered"; installationId: number }
  | { status: "configure_required"; installationId: number }
  | { status: "complete" }
  | { status: "none" }
  | { status: "reauth_required" }
  | { status: "unavailable" };

export type OAuthInstallationRecoveryOutcome =
  | {
      status: "configure_required";
      installationId: number;
      recoveredCount: number;
    }
  | {
      status:
        | "complete"
        | "none"
        | "reauth_required"
        | "unavailable"
        | "cancelled"
        | "limit_exceeded";
      recoveredCount: number;
    };

type OAuthInstallationRecoveryPromiseRef = {
  current: Promise<OAuthInstallationRecoveryOutcome> | null;
};

export function getSharedOAuthInstallationRecovery({
  cache,
  start,
}: {
  cache: OAuthInstallationRecoveryPromiseRef;
  start: () => Promise<OAuthInstallationRecoveryOutcome>;
}): Promise<OAuthInstallationRecoveryOutcome> {
  if (cache.current !== null) {
    return cache.current;
  }

  const recovery = start();
  cache.current = recovery;
  const release = () => {
    if (cache.current === recovery) {
      cache.current = null;
    }
  };
  void recovery.then(release, release);
  return recovery;
}

type MutableInstallationCallbackRef = { current: number | null };

export function finalizeBoundInstallationCallback({
  pendingInstallation,
  completedInstallation,
  isCancelled,
  finalize,
}: {
  pendingInstallation: MutableInstallationCallbackRef;
  completedInstallation: MutableInstallationCallbackRef;
  isCancelled: () => boolean;
  finalize: () => void;
}): boolean {
  if (
    pendingInstallation.current === null ||
    completedInstallation.current !== pendingInstallation.current ||
    isCancelled()
  ) {
    return false;
  }

  finalize();
  pendingInstallation.current = null;
  completedInstallation.current = null;
  return true;
}

type RecoverOAuthInstallationsOptions = {
  recoverInstallation: (
    args: Record<string, never>,
  ) => Promise<OAuthInstallationRecoveryResult>;
  isCancelled?: () => boolean;
  maxInstallations?: number;
};

export function getInstallationIdSignature(
  installations: ReadonlyArray<InstallationRecord> | undefined,
): string | undefined {
  if (installations === undefined) {
    return undefined;
  }

  return installations
    .map((installation) => installation.installationId)
    .sort((left, right) => left - right)
    .join(",");
}

export function getInstallationReadinessSignature(
  installations: ReadonlyArray<InstallationRecord> | undefined,
): string | undefined {
  if (installations === undefined) {
    return undefined;
  }

  return installations
    .map(
      (installation) =>
        `${installation.installationId}:${
          installation.reconciliationFailed === true
            ? "failed"
            : installation.reconciliationPending === true
              ? "pending"
              : "ready"
        }`,
    )
    .sort()
    .join(",");
}

export function needsGitHubAppInstallation(
  installations: ReadonlyArray<InstallationRecord> | undefined,
): boolean {
  return installations !== undefined && installations.length === 0;
}

export function getReconnectRepositoryIdFromSearch(
  search: string,
): string | null {
  return new URLSearchParams(search).get("reconnectRepositoryId");
}

export function getConnectPathAfterInstallationCallback(
  search: string,
  recoveredReconnectRepositoryId?: string | null,
): string {
  const incomingParams = new URLSearchParams(search);
  const outgoingParams = new URLSearchParams();
  if (incomingParams.has("reconnectRepositoryId")) {
    outgoingParams.set(
      "reconnectRepositoryId",
      incomingParams.get("reconnectRepositoryId") ?? "",
    );
  } else if (recoveredReconnectRepositoryId !== undefined) {
    if (recoveredReconnectRepositoryId !== null) {
      outgoingParams.set(
        "reconnectRepositoryId",
        recoveredReconnectRepositoryId,
      );
    }
  }
  const query = outgoingParams.toString();
  return `/repositories/connect${query === "" ? "" : `?${query}`}`;
}

function isValidReconnectRepositoryId(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_RECONNECT_REPOSITORY_ID_LENGTH ||
    value !== value.trim()
  ) {
    return false;
  }
  return !Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x20 || codePoint === 0x7f);
  });
}

function isValidReconnectState(value: unknown): value is string {
  return typeof value === "string" && RECONNECT_STATE_PATTERN.test(value);
}

export function createOpaqueReconnectState(randomBytes: Uint8Array): string {
  if (randomBytes.byteLength !== 16) {
    throw new Error("Reconnect state requires exactly 16 random bytes");
  }
  const nonce = Array.from(randomBytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${RECONNECT_STATE_PREFIX}${nonce}`;
}

export function createPendingReconnectMapping(args: {
  state: string;
  reconnectRepositoryId: string;
  navigationKind: ReconnectNavigationKind;
  now: number;
}): PendingReconnectMapping {
  if (
    !isValidReconnectState(args.state) ||
    !isValidReconnectRepositoryId(args.reconnectRepositoryId) ||
    !Number.isSafeInteger(args.now) ||
    args.now < 0
  ) {
    throw new Error("Invalid pending repository reconnect mapping");
  }
  return {
    version: 1,
    state: args.state,
    reconnectRepositoryId: args.reconnectRepositoryId,
    navigationKind: args.navigationKind,
    createdAt: args.now,
    expiresAt: args.now + PENDING_RECONNECT_TTL_MS,
  };
}

export function storePendingReconnectMapping(
  storage: SessionStorageLike,
  mapping: PendingReconnectMapping,
): void {
  storage.setItem(PENDING_RECONNECT_STORAGE_KEY, JSON.stringify(mapping));
}

export function clearPendingReconnectMapping(
  storage: SessionStorageLike | null,
): boolean {
  if (storage === null) {
    return true;
  }
  try {
    storage.removeItem(PENDING_RECONNECT_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

function readFreshPendingReconnectMapping(
  storage: SessionStorageLike | null,
  now: number,
): PendingReconnectMapping | null {
  if (storage === null) {
    return null;
  }
  let serialized: string | null;
  try {
    serialized = storage.getItem(PENDING_RECONNECT_STORAGE_KEY);
  } catch {
    return null;
  }
  if (serialized === null) {
    return null;
  }

  let candidate: Partial<PendingReconnectMapping> | null = null;
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      candidate = parsed as Partial<PendingReconnectMapping>;
    }
  } catch {
    candidate = null;
  }

  const isFresh =
    candidate?.version === 1 &&
    isValidReconnectState(candidate.state) &&
    isValidReconnectRepositoryId(candidate.reconnectRepositoryId) &&
    (candidate.navigationKind === "install" ||
      candidate.navigationKind === "configure") &&
    Number.isSafeInteger(candidate.createdAt) &&
    Number.isSafeInteger(candidate.expiresAt) &&
    candidate.createdAt! >= 0 &&
    candidate.expiresAt === candidate.createdAt! + PENDING_RECONNECT_TTL_MS &&
    candidate.createdAt! <= now &&
    now < candidate.expiresAt!;

  if (!isFresh) {
    try {
      storage.removeItem(PENDING_RECONNECT_STORAGE_KEY);
    } catch {
      // Storage can be unavailable in privacy-restricted browser contexts.
    }
    return null;
  }
  return candidate as PendingReconnectMapping;
}

function hasStateLessConfigureCallbackMarkers(
  params: URLSearchParams,
): boolean {
  return (
    parseInstallationCallbackId(params.get("installation_id")) !== null &&
    params.has("setup_action") &&
    (params.get("setup_action")?.trim().length ?? 0) > 0
  );
}

export function resolveInstallationReconnect(
  search: string,
  storage: SessionStorageLike | null,
  now: number,
): InstallationReconnectResolution {
  const params = new URLSearchParams(search);
  const installationId = parseInstallationCallbackId(
    params.get("installation_id"),
  );
  const directReconnectRepositoryId = params.get("reconnectRepositoryId");

  if (directReconnectRepositoryId !== null) {
    const pending =
      installationId === null
        ? null
        : readFreshPendingReconnectMapping(storage, now);
    return {
      installationId,
      reconnectRepositoryId: directReconnectRepositoryId,
      pendingStateToConsume: pending?.state ?? null,
    };
  }
  if (installationId === null) {
    return {
      installationId,
      reconnectRepositoryId: null,
      pendingStateToConsume: null,
    };
  }

  const pending = readFreshPendingReconnectMapping(storage, now);
  if (!pending) {
    return {
      installationId,
      reconnectRepositoryId: null,
      pendingStateToConsume: null,
    };
  }

  const callbackState = params.get("state");
  if (callbackState !== null) {
    return callbackState === pending.state
      ? {
          installationId,
          reconnectRepositoryId: pending.reconnectRepositoryId,
          pendingStateToConsume: pending.state,
        }
      : {
          installationId,
          reconnectRepositoryId: null,
          pendingStateToConsume: null,
        };
  }

  return pending.navigationKind === "configure" &&
    hasStateLessConfigureCallbackMarkers(params)
    ? {
        installationId,
        reconnectRepositoryId: pending.reconnectRepositoryId,
        pendingStateToConsume: pending.state,
      }
    : {
        installationId,
        reconnectRepositoryId: null,
        pendingStateToConsume: null,
      };
}

export function consumePendingReconnectMapping(
  storage: SessionStorageLike | null,
  expectedState: string | null,
): boolean {
  if (storage === null || !isValidReconnectState(expectedState)) {
    return false;
  }
  let serialized: string | null;
  try {
    serialized = storage.getItem(PENDING_RECONNECT_STORAGE_KEY);
  } catch {
    return false;
  }
  if (serialized === null) {
    return false;
  }
  try {
    const candidate = JSON.parse(serialized) as { state?: unknown };
    if (candidate.state !== expectedState) {
      return false;
    }
  } catch {
    return false;
  }
  try {
    storage.removeItem(PENDING_RECONNECT_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function getGitHubAppInstallationUrl(
  appSlug: string,
  state: string,
): string {
  if (!GITHUB_APP_SLUG_PATTERN.test(appSlug)) {
    throw new Error("Invalid GitHub App slug");
  }
  if (!isValidReconnectState(state)) {
    throw new Error("Invalid GitHub App installation state");
  }
  const url = new URL(`https://github.com/apps/${appSlug}/installations/new`);
  url.searchParams.set("state", state);
  return url.toString();
}

export function resolveGitHubAppSlug(
  configuredSlug: string | undefined,
  mode: string,
): string {
  const defaultSlug = mode === "production" ? "gitdogbot" : "gitdogbot-dev";
  if (configuredSlug === undefined || configuredSlug === "") {
    return defaultSlug;
  }
  if (!GITHUB_APP_SLUG_PATTERN.test(configuredSlug)) {
    throw new Error("Invalid VITE_GITHUB_APP_SLUG");
  }
  return configuredSlug;
}

export function parseInstallationCallbackId(
  value: string | null,
): number | null {
  if (value === null || value.trim() === "") {
    return null;
  }

  const installationId = Number(value);
  return Number.isSafeInteger(installationId) && installationId > 0
    ? installationId
    : null;
}

export function groupRepositoriesByInstallation<
  Repository extends InstallationRepositoryRecord,
>(
  installations: ReadonlyArray<InstallationAccountRecord> | undefined,
  repositories: ReadonlyArray<Repository>,
): Array<InstallationRepositoryGroup<Repository>> {
  const groups = new Map<number, InstallationRepositoryGroup<Repository>>();

  for (const installation of installations ?? []) {
    groups.set(installation.installationId, {
      installationId: installation.installationId,
      accountLogin: installation.accountLogin,
      accountType: installation.accountType,
      reconciliationPending: installation.reconciliationPending === true,
      ...(installation.reconciliationFailed === true
        ? { reconciliationFailed: true as const }
        : {}),
      repos: [],
    });
  }

  for (const repository of repositories) {
    const existing = groups.get(repository.installationId);
    if (existing) {
      existing.repos.push(repository);
      continue;
    }

    groups.set(repository.installationId, {
      installationId: repository.installationId,
      accountLogin: repository.accountLogin,
      accountType: repository.accountType,
      reconciliationPending: repository.reconciliationPending === true,
      ...(repository.reconciliationFailed === true
        ? { reconciliationFailed: true as const }
        : {}),
      repos: [repository],
    });
  }

  return Array.from(groups.values());
}

export async function waitForInstallationBinding({
  installationId,
  refreshInstallation,
  sleep = (delayMs) =>
    new Promise<void>((resolve) => window.setTimeout(resolve, delayMs)),
  isCancelled = () => false,
  maxAttempts = INSTALLATION_BINDING_MAX_ATTEMPTS,
}: WaitForInstallationBindingOptions): Promise<
  "bound" | "pending" | "reauth_required" | "cancelled"
> {
  const attemptLimit = Math.max(1, Math.floor(maxAttempts));
  let reauthRequired = false;

  for (let attempt = 0; attempt < attemptLimit; attempt++) {
    if (isCancelled()) {
      return "cancelled";
    }

    const result = await refreshInstallation({ installationId });
    if (result.status === "bound") {
      if (result.installationId !== installationId) {
        throw new Error("GitHub returned an unexpected installation binding");
      }
      return "bound";
    }
    if (isCancelled()) {
      return "cancelled";
    }
    if (result.status === "reauth_required") {
      reauthRequired = true;
    }
    if (attempt + 1 >= attemptLimit) {
      break;
    }

    const delayMs = Math.min(
      INSTALLATION_BINDING_RETRY_MAX_MS,
      INSTALLATION_BINDING_RETRY_BASE_MS * (attempt + 1),
    );
    await sleep(delayMs);
  }

  return isCancelled()
    ? "cancelled"
    : reauthRequired
      ? "reauth_required"
      : "pending";
}

export async function recoverOAuthInstallations({
  recoverInstallation,
  isCancelled = () => false,
  maxInstallations = OAUTH_INSTALLATION_RECOVERY_MAX_INSTALLATIONS,
}: RecoverOAuthInstallationsOptions): Promise<OAuthInstallationRecoveryOutcome> {
  if (!Number.isSafeInteger(maxInstallations) || maxInstallations < 1) {
    throw new Error("OAuth installation recovery limit is invalid");
  }

  const recoveredInstallationIds = new Set<number>();

  while (true) {
    if (isCancelled()) {
      return {
        status: "cancelled",
        recoveredCount: recoveredInstallationIds.size,
      };
    }

    const result = await recoverInstallation({});
    if (result.status === "recovered") {
      if (
        !Number.isSafeInteger(result.installationId) ||
        result.installationId <= 0 ||
        recoveredInstallationIds.has(result.installationId)
      ) {
        throw new Error("GitHub returned an unexpected installation recovery");
      }
      recoveredInstallationIds.add(result.installationId);
      if (recoveredInstallationIds.size > maxInstallations) {
        return {
          status: "limit_exceeded",
          recoveredCount: maxInstallations,
        };
      }
      if (isCancelled()) {
        return {
          status: "cancelled",
          recoveredCount: recoveredInstallationIds.size,
        };
      }
      continue;
    }

    if (result.status === "configure_required") {
      if (
        !Number.isSafeInteger(result.installationId) ||
        result.installationId <= 0
      ) {
        throw new Error("GitHub returned an unexpected installation recovery");
      }
      return {
        status: "configure_required",
        installationId: result.installationId,
        recoveredCount: recoveredInstallationIds.size,
      };
    }

    if (isCancelled()) {
      return {
        status: "cancelled",
        recoveredCount: recoveredInstallationIds.size,
      };
    }
    return {
      status: result.status,
      recoveredCount: recoveredInstallationIds.size,
    };
  }
}
