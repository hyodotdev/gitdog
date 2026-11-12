import { describe, expect, it, vi } from "vitest";

import {
  clearPendingReconnectMapping,
  consumePendingReconnectMapping,
  createOpaqueReconnectState,
  createPendingReconnectMapping,
  finalizeBoundInstallationCallback,
  getBrowserSessionStorage,
  getConnectPathAfterInstallationCallback,
  getGitHubAppInstallationUrl,
  getInstallationIdSignature,
  getInstallationReadinessSignature,
  getSharedOAuthInstallationRecovery,
  getReconnectRepositoryIdFromSearch,
  groupRepositoriesByInstallation,
  type InstallationBindingRefreshResult,
  needsGitHubAppInstallation,
  OAUTH_INSTALLATION_RECOVERY_MAX_INSTALLATIONS,
  type OAuthInstallationRecoveryOutcome,
  PENDING_RECONNECT_STORAGE_KEY,
  PENDING_RECONNECT_TTL_MS,
  parseInstallationCallbackId,
  recoverOAuthInstallations,
  resolveGitHubAppSlug,
  resolveInstallationReconnect,
  storePendingReconnectMapping,
  waitForInstallationBinding,
} from "../../src/pages/repositories/connectFlow";

function createSessionStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

function createTestReconnectState(seed = 0): string {
  return createOpaqueReconnectState(
    Uint8Array.from({ length: 16 }, (_, index) => (seed + index) % 256),
  );
}

describe("repository connection flow", () => {
  it("keeps checking a callback installation until the signed webhook binding is visible", async () => {
    const refreshInstallation = vi
      .fn<
        (args: {
          installationId: number;
        }) => Promise<InstallationBindingRefreshResult>
      >()
      .mockResolvedValueOnce({ status: "not_bound_yet" as const })
      .mockResolvedValueOnce({ status: "not_bound_yet" as const })
      .mockResolvedValue({ status: "bound" as const, installationId: 123 });
    const sleep = vi.fn(async () => undefined);

    const result = await waitForInstallationBinding({
      installationId: 123,
      refreshInstallation,
      sleep,
      maxAttempts: 5,
    });

    expect(result).toBe("bound");
    expect(refreshInstallation).toHaveBeenCalledTimes(3);
    expect(refreshInstallation).toHaveBeenNthCalledWith(3, {
      installationId: 123,
    });
    expect(sleep.mock.calls).toEqual([[250], [500]]);
  });

  it("consumes a successful binding even when its caller is cancelled during refresh", async () => {
    let cancelled = false;
    const refreshInstallation = vi.fn(async () => {
      cancelled = true;
      return { status: "bound" as const, installationId: 123 };
    });

    await expect(
      waitForInstallationBinding({
        installationId: 123,
        refreshInstallation,
        isCancelled: () => cancelled,
      }),
    ).resolves.toBe("bound");
    expect(refreshInstallation).toHaveBeenCalledOnce();
  });

  it("lets the latest effect finalize a bound callback after a cancelled effect", () => {
    const pendingInstallation = { current: 123 as number | null };
    const completedInstallation = { current: 123 as number | null };
    const finalize = vi.fn();

    expect(
      finalizeBoundInstallationCallback({
        pendingInstallation,
        completedInstallation,
        isCancelled: () => true,
        finalize,
      }),
    ).toBe(false);
    expect(pendingInstallation.current).toBe(123);
    expect(completedInstallation.current).toBe(123);
    expect(finalize).not.toHaveBeenCalled();

    expect(
      finalizeBoundInstallationCallback({
        pendingInstallation,
        completedInstallation,
        isCancelled: () => false,
        finalize,
      }),
    ).toBe(true);
    expect(finalize).toHaveBeenCalledOnce();
    expect(pendingInstallation.current).toBeNull();
    expect(completedInstallation.current).toBeNull();
  });

  it("still stops a non-bound refresh when its caller is cancelled", async () => {
    let cancelled = false;
    const refreshInstallation = vi.fn(async () => {
      cancelled = true;
      return { status: "not_bound_yet" as const };
    });

    await expect(
      waitForInstallationBinding({
        installationId: 123,
        refreshInstallation,
        isCancelled: () => cancelled,
      }),
    ).resolves.toBe("cancelled");
    expect(refreshInstallation).toHaveBeenCalledOnce();
  });

  it("uses a stable installation signature to refetch only when the ID set changes", () => {
    const first = getInstallationIdSignature([
      { installationId: 20 },
      { installationId: 10 },
    ]);
    const sameIdsFromReactiveQuery = getInstallationIdSignature([
      { installationId: 10 },
      { installationId: 20 },
    ]);
    const changedIds = getInstallationIdSignature([
      { installationId: 10 },
      { installationId: 20 },
      { installationId: 30 },
    ]);

    expect(sameIdsFromReactiveQuery).toBe(first);
    expect(changedIds).not.toBe(first);
  });

  it("refetches when an installation finishes access reconciliation", () => {
    const pending = getInstallationReadinessSignature([
      { installationId: 20, reconciliationPending: false },
      { installationId: 10, reconciliationPending: true },
    ]);
    const sameStateFromReactiveQuery = getInstallationReadinessSignature([
      { installationId: 10, reconciliationPending: true },
      { installationId: 20, reconciliationPending: false },
    ]);
    const ready = getInstallationReadinessSignature([
      { installationId: 10, reconciliationPending: false },
      { installationId: 20, reconciliationPending: false },
    ]);

    expect(sameStateFromReactiveQuery).toBe(pending);
    expect(ready).not.toBe(pending);
  });

  it("distinguishes failed reconciliation from syncing and ready states", () => {
    const failedInstallations = [
      {
        installationId: 10,
        accountLogin: "owner",
        accountType: "Organization",
        reconciliationPending: false,
        reconciliationFailed: true,
      },
    ];

    expect(getInstallationReadinessSignature(failedInstallations)).toBe(
      "10:failed",
    );
    expect(groupRepositoriesByInstallation(failedInstallations, [])).toEqual([
      {
        ...failedInstallations[0],
        repos: [],
      },
    ]);
  });

  it("keeps installation configuration visible when every repository is already connected", () => {
    const groups = groupRepositoriesByInstallation(
      [
        {
          installationId: 123,
          accountLogin: "owner",
          accountType: "User",
          reconciliationPending: false,
        },
      ],
      [],
    );

    expect(groups).toEqual([
      {
        installationId: 123,
        accountLogin: "owner",
        accountType: "User",
        reconciliationPending: false,
        repos: [],
      },
    ]);
  });

  it("shows syncing configuration for the only removal-pending installation", () => {
    const installations = [
      {
        installationId: 123,
        accountLogin: "owner",
        accountType: "User",
        reconciliationPending: true,
      },
    ];
    const groups = groupRepositoriesByInstallation(installations, []);

    expect(needsGitHubAppInstallation(installations)).toBe(false);
    expect(groups).toEqual([
      {
        installationId: 123,
        accountLogin: "owner",
        accountType: "User",
        reconciliationPending: true,
        repos: [],
      },
    ]);
  });

  it("keeps the only unsuspending installation syncing until finalization", () => {
    const pendingInstallations = [
      {
        installationId: 456,
        accountLogin: "owner",
        accountType: "Organization",
        reconciliationPending: true,
      },
    ];
    const readyInstallations = [
      {
        ...pendingInstallations[0],
        reconciliationPending: false,
      },
    ];

    expect(needsGitHubAppInstallation(pendingInstallations)).toBe(false);
    expect(groupRepositoriesByInstallation(pendingInstallations, [])).toEqual([
      {
        installationId: 456,
        accountLogin: "owner",
        accountType: "Organization",
        reconciliationPending: true,
        repos: [],
      },
    ]);
    expect(getInstallationReadinessSignature(readyInstallations)).not.toBe(
      getInstallationReadinessSignature(pendingInstallations),
    );
    expect(groupRepositoriesByInstallation(readyInstallations, [])).toEqual([
      {
        installationId: 456,
        accountLogin: "owner",
        accountType: "Organization",
        reconciliationPending: false,
        repos: [],
      },
    ]);
  });

  it("preserves the reconnect target while cleaning callback parameters", () => {
    const search =
      "?installation_id=123&setup_action=install&reconnectRepositoryId=owner%2Frepository";

    expect(getReconnectRepositoryIdFromSearch(search)).toBe("owner/repository");
    expect(getConnectPathAfterInstallationCallback(search)).toBe(
      "/repositories/connect?reconnectRepositoryId=owner%2Frepository",
    );
    expect(
      getConnectPathAfterInstallationCallback("?installation_id=123"),
    ).toBe("/repositories/connect");
    expect(
      getConnectPathAfterInstallationCallback(
        "?installation_id=123&setup_action=install&state=opaque",
        "recovered-repository-id",
      ),
    ).toBe(
      "/repositories/connect?reconnectRepositoryId=recovered-repository-id",
    );
  });

  it("keeps an explicitly empty reconnect target for server validation", () => {
    expect(getReconnectRepositoryIdFromSearch("?reconnectRepositoryId=")).toBe(
      "",
    );
    expect(
      getConnectPathAfterInstallationCallback(
        "?installation_id=123&reconnectRepositoryId=",
      ),
    ).toBe("/repositories/connect?reconnectRepositoryId=");
  });

  it("stops callback polling at the configured bound", async () => {
    const refreshInstallation = vi.fn(async () => ({
      status: "not_bound_yet" as const,
    }));
    const sleep = vi.fn(async () => undefined);

    const result = await waitForInstallationBinding({
      installationId: 123,
      refreshInstallation,
      sleep,
      maxAttempts: 3,
    });

    expect(result).toBe("pending");
    expect(refreshInstallation).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[250], [500]]);
  });

  it("keeps polling for a signed webhook before requiring GitHub reauthorization", async () => {
    const refreshInstallation = vi
      .fn<
        (args: {
          installationId: number;
        }) => Promise<InstallationBindingRefreshResult>
      >()
      .mockResolvedValue({ status: "reauth_required" as const });
    const sleep = vi.fn(async () => undefined);

    const result = await waitForInstallationBinding({
      installationId: 123,
      refreshInstallation,
      sleep,
      maxAttempts: 3,
    });

    expect(result).toBe("reauth_required");
    expect(refreshInstallation).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[250], [500]]);
  });

  it("propagates operational refresh failures without polling", async () => {
    const refreshInstallation = vi.fn(async () => {
      throw new Error("GitHub App credentials not configured");
    });
    const sleep = vi.fn(async () => undefined);

    await expect(
      waitForInstallationBinding({
        installationId: 123,
        refreshInstallation,
        sleep,
        maxAttempts: 5,
      }),
    ).rejects.toThrow("GitHub App credentials not configured");
    expect(refreshInstallation).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rejects a mismatched successful binding without polling", async () => {
    const refreshInstallation = vi.fn(async () => ({
      status: "bound" as const,
      installationId: 456,
    }));
    const sleep = vi.fn(async () => undefined);

    await expect(
      waitForInstallationBinding({
        installationId: 123,
        refreshInstallation,
        sleep,
      }),
    ).rejects.toThrow("unexpected installation binding");
    expect(refreshInstallation).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("recovers OAuth-attested installations one at a time until complete", async () => {
    const recoverInstallation = vi
      .fn()
      .mockResolvedValueOnce({ status: "recovered", installationId: 123 })
      .mockResolvedValueOnce({ status: "recovered", installationId: 456 })
      .mockResolvedValueOnce({ status: "complete" });

    await expect(
      recoverOAuthInstallations({ recoverInstallation }),
    ).resolves.toEqual({ status: "complete", recoveredCount: 2 });
    expect(recoverInstallation).toHaveBeenCalledTimes(3);
    expect(recoverInstallation).toHaveBeenNthCalledWith(1, {});
    expect(recoverInstallation).toHaveBeenNthCalledWith(2, {});
    expect(recoverInstallation).toHaveBeenNthCalledWith(3, {});
  });

  it("shares only an in-flight OAuth recovery across effect replays", async () => {
    let resolveFirstRecovery:
      ((outcome: OAuthInstallationRecoveryOutcome) => void) | undefined;
    const firstRecovery = new Promise<OAuthInstallationRecoveryOutcome>(
      (resolve) => {
        resolveFirstRecovery = resolve;
      },
    );
    const start = vi
      .fn<() => Promise<OAuthInstallationRecoveryOutcome>>()
      .mockReturnValueOnce(firstRecovery)
      .mockResolvedValueOnce({ status: "complete", recoveredCount: 1 });
    const cache = {
      current: null as Promise<OAuthInstallationRecoveryOutcome> | null,
    };

    const initial = getSharedOAuthInstallationRecovery({ cache, start });
    const strictModeReplay = getSharedOAuthInstallationRecovery({
      cache,
      start,
    });

    expect(strictModeReplay).toBe(initial);
    expect(start).toHaveBeenCalledOnce();

    resolveFirstRecovery?.({
      status: "configure_required",
      installationId: 1,
      recoveredCount: 0,
    });
    await expect(initial).resolves.toEqual({
      status: "configure_required",
      installationId: 1,
      recoveredCount: 0,
    });
    await Promise.resolve();
    expect(cache.current).toBeNull();

    await expect(
      getSharedOAuthInstallationRecovery({ cache, start }),
    ).resolves.toEqual({ status: "complete", recoveredCount: 1 });
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("distinguishes a true empty OAuth snapshot from reauthorization and unavailability", async () => {
    for (const status of ["none", "reauth_required", "unavailable"] as const) {
      const recoverInstallation = vi.fn(async () => ({ status }));

      await expect(
        recoverOAuthInstallations({ recoverInstallation }),
      ).resolves.toEqual({ status, recoveredCount: 0 });
      expect(recoverInstallation).toHaveBeenCalledOnce();
    }
  });

  it("propagates the exact organization installation that needs configuration", async () => {
    const recoverInstallation = vi.fn(async () => ({
      status: "configure_required" as const,
      installationId: 789,
    }));

    await expect(
      recoverOAuthInstallations({ recoverInstallation }),
    ).resolves.toEqual({
      status: "configure_required",
      installationId: 789,
      recoveredCount: 0,
    });
    expect(recoverInstallation).toHaveBeenCalledOnce();

    await expect(
      recoverOAuthInstallations({
        recoverInstallation: vi.fn(async () => ({
          status: "configure_required" as const,
          installationId: 0,
        })),
      }),
    ).rejects.toThrow("unexpected installation recovery");
  });

  it("keeps recovered progress before a later installation needs configuration", async () => {
    const recoverInstallation = vi
      .fn()
      .mockResolvedValueOnce({ status: "recovered", installationId: 123 })
      .mockResolvedValueOnce({
        status: "configure_required",
        installationId: 456,
      });

    await expect(
      recoverOAuthInstallations({ recoverInstallation }),
    ).resolves.toEqual({
      status: "configure_required",
      installationId: 456,
      recoveredCount: 1,
    });
    expect(recoverInstallation).toHaveBeenCalledTimes(2);
  });

  it("stops OAuth installation recovery when cancelled before or after a request", async () => {
    const cancelledBeforeRequest = vi.fn(async () => ({
      status: "complete" as const,
    }));
    await expect(
      recoverOAuthInstallations({
        recoverInstallation: cancelledBeforeRequest,
        isCancelled: () => true,
      }),
    ).resolves.toEqual({ status: "cancelled", recoveredCount: 0 });
    expect(cancelledBeforeRequest).not.toHaveBeenCalled();

    let cancelled = false;
    const cancelledAfterRecovery = vi.fn(async () => {
      cancelled = true;
      return { status: "recovered" as const, installationId: 123 };
    });
    await expect(
      recoverOAuthInstallations({
        recoverInstallation: cancelledAfterRecovery,
        isCancelled: () => cancelled,
      }),
    ).resolves.toEqual({ status: "cancelled", recoveredCount: 1 });
    expect(cancelledAfterRecovery).toHaveBeenCalledOnce();
  });

  it("bounds OAuth installation recovery and requires unique valid IDs", async () => {
    const exactLimitRecovery = vi
      .fn()
      .mockResolvedValueOnce({ status: "recovered", installationId: 123 })
      .mockResolvedValueOnce({ status: "recovered", installationId: 456 })
      .mockResolvedValueOnce({ status: "complete" });
    await expect(
      recoverOAuthInstallations({
        recoverInstallation: exactLimitRecovery,
        maxInstallations: 2,
      }),
    ).resolves.toEqual({ status: "complete", recoveredCount: 2 });
    expect(exactLimitRecovery).toHaveBeenCalledTimes(3);

    let installationId = 0;
    const overLimitRecovery = vi.fn(async () => ({
      status: "recovered" as const,
      installationId: ++installationId,
    }));

    await expect(
      recoverOAuthInstallations({
        recoverInstallation: overLimitRecovery,
        maxInstallations: 2,
      }),
    ).resolves.toEqual({ status: "limit_exceeded", recoveredCount: 2 });
    expect(overLimitRecovery).toHaveBeenCalledTimes(3);

    const duplicateRecovery = vi
      .fn()
      .mockResolvedValueOnce({ status: "recovered", installationId: 123 })
      .mockResolvedValueOnce({ status: "recovered", installationId: 123 });
    await expect(
      recoverOAuthInstallations({ recoverInstallation: duplicateRecovery }),
    ).rejects.toThrow("unexpected installation recovery");

    await expect(
      recoverOAuthInstallations({
        recoverInstallation: vi.fn(),
        maxInstallations: 0,
      }),
    ).rejects.toThrow("recovery limit is invalid");
    expect(OAUTH_INSTALLATION_RECOVERY_MAX_INSTALLATIONS).toBe(500);
  });

  it("accepts only positive safe integer callback IDs", () => {
    expect(parseInstallationCallbackId("123")).toBe(123);
    expect(parseInstallationCallbackId(null)).toBeNull();
    expect(parseInstallationCallbackId("1.5")).toBeNull();
    expect(parseInstallationCallbackId("not-a-number")).toBeNull();
  });

  it("round-trips a validated reconnect target through opaque installation state", () => {
    const storage = createSessionStorage();
    const now = 1_000;
    const state = createTestReconnectState();
    const mapping = createPendingReconnectMapping({
      state,
      reconnectRepositoryId: "reconnectRepositoryId123",
      navigationKind: "install",
      now,
    });
    storePendingReconnectMapping(storage, mapping);

    const installUrl = new URL(getGitHubAppInstallationUrl("gitdogbot", state));
    expect(installUrl.pathname).toBe("/apps/gitdogbot/installations/new");
    expect(installUrl.searchParams.get("state")).toBe(state);
    expect(installUrl.toString()).not.toContain("reconnectRepositoryId123");
    expect(mapping.expiresAt - mapping.createdAt).toBe(
      PENDING_RECONNECT_TTL_MS,
    );

    const resolution = resolveInstallationReconnect(
      `?installation_id=123&setup_action=install&state=${encodeURIComponent(state)}`,
      storage,
      now + 1,
    );
    expect(resolution).toEqual({
      installationId: 123,
      reconnectRepositoryId: "reconnectRepositoryId123",
      pendingStateToConsume: state,
    });
    expect(
      consumePendingReconnectMapping(storage, resolution.pendingStateToConsume),
    ).toBe(true);
    expect(storage.getItem(PENDING_RECONNECT_STORAGE_KEY)).toBeNull();
  });

  it("uses a configured GitHub App slug with safe environment defaults", () => {
    expect(resolveGitHubAppSlug("custom-gitdog-app", "production")).toBe(
      "custom-gitdog-app",
    );
    expect(resolveGitHubAppSlug(undefined, "production")).toBe("gitdogbot");
    expect(resolveGitHubAppSlug("", "development")).toBe("gitdogbot-dev");
  });

  it("rejects unsafe GitHub App slugs before constructing a navigation URL", () => {
    const state = createTestReconnectState();

    expect(() => resolveGitHubAppSlug("Gitdog Dev", "production")).toThrow(
      "Invalid VITE_GITHUB_APP_SLUG",
    );
    expect(() =>
      getGitHubAppInstallationUrl("gitdogbot/../../settings", state),
    ).toThrow("Invalid GitHub App slug");
  });

  it("restores exact installation state when GitHub omits setup_action", () => {
    const storage = createSessionStorage();
    const state = createTestReconnectState();
    storePendingReconnectMapping(
      storage,
      createPendingReconnectMapping({
        state,
        reconnectRepositoryId: "reconnectRepositoryId123",
        navigationKind: "install",
        now: 1_000,
      }),
    );

    expect(
      resolveInstallationReconnect(
        `?installation_id=123&state=${encodeURIComponent(state)}`,
        storage,
        1_001,
      ),
    ).toEqual({
      installationId: 123,
      reconnectRepositoryId: "reconnectRepositoryId123",
      pendingStateToConsume: state,
    });
  });

  it("prefers a direct reconnect target over pending callback state", () => {
    const storage = createSessionStorage();
    const state = createTestReconnectState();
    storePendingReconnectMapping(
      storage,
      createPendingReconnectMapping({
        state,
        reconnectRepositoryId: "pendingTarget",
        navigationKind: "install",
        now: 1_000,
      }),
    );

    expect(
      resolveInstallationReconnect(
        `?installation_id=123&setup_action=install&state=unrelated&reconnectRepositoryId=directTarget`,
        storage,
        1_001,
      ),
    ).toEqual({
      installationId: 123,
      reconnectRepositoryId: "directTarget",
      pendingStateToConsume: state,
    });
  });

  it("uses a fresh configure fallback only for an actual callback without state", () => {
    const storage = createSessionStorage();
    const state = createTestReconnectState();
    storePendingReconnectMapping(
      storage,
      createPendingReconnectMapping({
        state,
        reconnectRepositoryId: "configuredTarget",
        navigationKind: "configure",
        now: 1_000,
      }),
    );

    expect(
      resolveInstallationReconnect(
        "?installation_id=123&setup_action=update",
        storage,
        1_001,
      ),
    ).toEqual({
      installationId: 123,
      reconnectRepositoryId: "configuredTarget",
      pendingStateToConsume: state,
    });
    expect(
      resolveInstallationReconnect("?installation_id=123", storage, 1_001),
    ).toEqual({
      installationId: 123,
      reconnectRepositoryId: null,
      pendingStateToConsume: null,
    });
    expect(resolveInstallationReconnect("", storage, 1_001)).toEqual({
      installationId: null,
      reconnectRepositoryId: null,
      pendingStateToConsume: null,
    });
  });

  it("clears an abandoned reconnect before generic configure navigation", () => {
    const storage = createSessionStorage();
    const state = createTestReconnectState();
    storePendingReconnectMapping(
      storage,
      createPendingReconnectMapping({
        state,
        reconnectRepositoryId: "abandonedReconnectTarget",
        navigationKind: "configure",
        now: 1_000,
      }),
    );

    expect(clearPendingReconnectMapping(storage)).toBe(true);
    expect(
      resolveInstallationReconnect(
        "?installation_id=456&setup_action=update",
        storage,
        1_001,
      ),
    ).toEqual({
      installationId: 456,
      reconnectRepositoryId: null,
      pendingStateToConsume: null,
    });
    expect(storage.getItem(PENDING_RECONNECT_STORAGE_KEY)).toBeNull();
  });

  it("does not use a state-less install mapping as a configure fallback", () => {
    const storage = createSessionStorage();
    const state = createTestReconnectState();
    storePendingReconnectMapping(
      storage,
      createPendingReconnectMapping({
        state,
        reconnectRepositoryId: "installTarget",
        navigationKind: "install",
        now: 1_000,
      }),
    );

    expect(
      resolveInstallationReconnect(
        "?installation_id=123&setup_action=install",
        storage,
        1_001,
      ),
    ).toEqual({
      installationId: 123,
      reconnectRepositoryId: null,
      pendingStateToConsume: null,
    });
  });

  it("ignores tampered or unrelated callback state without consuming the mapping", () => {
    const storage = createSessionStorage();
    const state = createTestReconnectState();
    storePendingReconnectMapping(
      storage,
      createPendingReconnectMapping({
        state,
        reconnectRepositoryId: "reconnectTarget",
        navigationKind: "install",
        now: 1_000,
      }),
    );

    expect(
      resolveInstallationReconnect(
        `?installation_id=123&setup_action=install&state=${encodeURIComponent(createTestReconnectState(50))}`,
        storage,
        1_001,
      ),
    ).toEqual({
      installationId: 123,
      reconnectRepositoryId: null,
      pendingStateToConsume: null,
    });
    expect(storage.getItem(PENDING_RECONNECT_STORAGE_KEY)).not.toBeNull();
    expect(
      consumePendingReconnectMapping(storage, createTestReconnectState(50)),
    ).toBe(false);
    expect(storage.getItem(PENDING_RECONNECT_STORAGE_KEY)).not.toBeNull();
  });

  it("removes expired and malformed pending mappings", () => {
    const expiredStorage = createSessionStorage();
    const state = createTestReconnectState();
    storePendingReconnectMapping(
      expiredStorage,
      createPendingReconnectMapping({
        state,
        reconnectRepositoryId: "reconnectTarget",
        navigationKind: "configure",
        now: 1_000,
      }),
    );

    expect(
      resolveInstallationReconnect(
        "?installation_id=123&setup_action=update",
        expiredStorage,
        1_000 + PENDING_RECONNECT_TTL_MS,
      ),
    ).toEqual({
      installationId: 123,
      reconnectRepositoryId: null,
      pendingStateToConsume: null,
    });
    expect(expiredStorage.getItem(PENDING_RECONNECT_STORAGE_KEY)).toBeNull();

    const malformedStorage = createSessionStorage();
    malformedStorage.setItem(PENDING_RECONNECT_STORAGE_KEY, "not-json");
    expect(
      resolveInstallationReconnect(
        `?installation_id=123&setup_action=install&state=${encodeURIComponent(state)}`,
        malformedStorage,
        1_001,
      ).reconnectRepositoryId,
    ).toBeNull();
    expect(malformedStorage.getItem(PENDING_RECONNECT_STORAGE_KEY)).toBeNull();
  });

  it("fails closed when session storage is unavailable", () => {
    const unavailableStorage = {
      getItem: () => {
        throw new Error("storage unavailable");
      },
      setItem: () => {
        throw new Error("storage unavailable");
      },
      removeItem: () => {
        throw new Error("storage unavailable");
      },
    };

    expect(
      resolveInstallationReconnect(
        "?installation_id=123&setup_action=install&state=unrelated",
        unavailableStorage,
        1_000,
      ),
    ).toEqual({
      installationId: 123,
      reconnectRepositoryId: null,
      pendingStateToConsume: null,
    });
    expect(
      resolveInstallationReconnect(
        "?installation_id=123&reconnectRepositoryId=directTarget",
        unavailableStorage,
        1_000,
      ),
    ).toEqual({
      installationId: 123,
      reconnectRepositoryId: "directTarget",
      pendingStateToConsume: null,
    });
    expect(
      consumePendingReconnectMapping(
        unavailableStorage,
        createTestReconnectState(),
      ),
    ).toBe(false);

    const state = createTestReconnectState();
    const removeUnavailableStorage = {
      getItem: () =>
        JSON.stringify(
          createPendingReconnectMapping({
            state,
            reconnectRepositoryId: "reconnectTarget",
            navigationKind: "install",
            now: 1_000,
          }),
        ),
      setItem: () => undefined,
      removeItem: () => {
        throw new Error("storage unavailable");
      },
    };
    expect(
      consumePendingReconnectMapping(removeUnavailableStorage, state),
    ).toBe(false);
    expect(() =>
      resolveInstallationReconnect(
        `?installation_id=123&setup_action=install&state=${encodeURIComponent(state)}`,
        {
          ...removeUnavailableStorage,
          getItem: () => "malformed",
        },
        1_000,
      ),
    ).not.toThrow();
  });

  it("fails closed when the browser blocks access to session storage", () => {
    const sessionStorage = getBrowserSessionStorage(() => {
      throw new DOMException("Access denied", "SecurityError");
    });

    expect(sessionStorage).toBeNull();
    expect(
      resolveInstallationReconnect(
        "?installation_id=123&setup_action=install&state=unrelated",
        sessionStorage,
        1_000,
      ),
    ).toEqual({
      installationId: 123,
      reconnectRepositoryId: null,
      pendingStateToConsume: null,
    });
    expect(
      consumePendingReconnectMapping(
        sessionStorage,
        createTestReconnectState(),
      ),
    ).toBe(false);
  });
});
