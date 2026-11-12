import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockedFunction } from "vitest";
import { v } from "convex/values";

import { api, internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  internalAction,
  type ActionCtx,
} from "../../../convex/_generated/server";
import * as githubHelpers from "../../../convex/github/helpers";
import {
  handleInstallationEvent,
  handleInstallationRepositoriesEvent,
} from "../../../convex/github/webhook";
import { GITHUB_INSTALLATION_ATTESTATION_MAX_INSTALLATIONS } from "../../../convex/github/oauthInstallationAttestation";
import schema from "../../../convex/schema";

const noopIndexRepository = internalAction({
  args: {
    repositoryId: v.id("repositories"),
    expectedIndexVersion: v.number(),
  },
  handler: async (ctx, args) => {
    const started = await ctx.runMutation(
      internal.repoIndexing.mutation.updateIndexingStatus,
      {
        repositoryId: args.repositoryId,
        expectedIndexVersion: args.expectedIndexVersion,
        status: "indexing",
      },
    );
    if (started) {
      await ctx.runMutation(
        internal.repoIndexing.mutation.updateIndexingStatus,
        {
          repositoryId: args.repositoryId,
          expectedIndexVersion: args.expectedIndexVersion,
          status: "failed",
          error: "Test indexing stopped",
        },
      );
    }
    return { success: true };
  },
});

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/github/action.ts": () =>
    import("../../../convex/github/action"),
  "../../../convex/github/internalMutation.ts": () =>
    import("../../../convex/github/internalMutation"),
  "../../../convex/github/internalQuery.ts": () =>
    import("../../../convex/github/internalQuery"),
  "../../../convex/github/query.ts": () =>
    import("../../../convex/github/query"),
  "../../../convex/repositories/internalMutation.ts": () =>
    import("../../../convex/repositories/internalMutation"),
  "../../../convex/repositories/internalQuery.ts": () =>
    import("../../../convex/repositories/internalQuery"),
  "../../../convex/repositories/query.ts": () =>
    import("../../../convex/repositories/query"),
  "../../../convex/repoIndexing/mutation.ts": () =>
    import("../../../convex/repoIndexing/mutation"),
  "../../../convex/repoIndexing/watchdog.ts": () =>
    import("../../../convex/repoIndexing/watchdog"),
  "../../../convex/repoIndexing/action.ts": async () => ({
    indexRepository: noopIndexRepository,
  }),
  "../../../convex/repoIndexing/query.ts": () =>
    import("../../../convex/repoIndexing/query"),
};

const originalAppId = process.env.GITHUB_APP_ID;
const originalPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY;
const originalFetch = globalThis.fetch;
let mockedGenerateGitHubAppJWT: MockedFunction<
  typeof githubHelpers.generateGitHubAppJWT
>;
let mockedGetInstallationToken: MockedFunction<
  typeof githubHelpers.getInstallationToken
>;
let mockedGetGitHubInstallationAccessState: MockedFunction<
  typeof githubHelpers.getGitHubInstallationAccessState
>;

async function insertInstallation(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  installationId: number,
): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("githubInstallations", {
      userId,
      installationId,
      ownerGithubAccountId: "verified-github-account",
      ownershipVerifiedAt: now,
      accountLogin: "original-owner",
      accountType: "Organization",
      targetType: "Organization",
      permissions: { contents: "read" },
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function insertOAuthInstallationAttestation(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  installationIds: number[],
  options: {
    githubAccountId?: string;
    attestedAt?: number;
    expiresAt?: number;
  } = {},
): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    const githubAccountId = options.githubAccountId ?? "654";
    await ctx.db.insert("authAccounts", {
      userId,
      provider: "github",
      providerAccountId: "654",
    });
    await ctx.db.insert("githubOAuthInstallationAttestations", {
      userId,
      githubAccountId,
      installationIds,
      attestedAt: options.attestedAt ?? now,
      expiresAt: options.expiresAt ?? now + 15 * 60 * 1_000,
      updatedAt: options.attestedAt ?? now,
    });
  });
}

async function insertOAuthOwnedInstallation(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  installationId: number,
): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("githubInstallations", {
      userId,
      installationId,
      ownerGithubAccountId: "654",
      ownershipVerifiedAt: now,
      accountLogin: `organization-${installationId}`,
      accountType: "Organization",
      targetType: "Organization",
      permissions: { contents: "read" },
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function insertLinkedRepository(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  installationId: number,
): Promise<Id<"repositories">> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("repositories", {
      indexSyncPending: false,
      indexProgressAt: Date.now(),
      ragTotalChunks: 0,
      ragIndexedChunks: 0,
      ragFailedChunks: 0,
      userId,
      installationId,
      githubRepositoryId: installationId + 1,
      githubRepo: `owner/repo-${installationId}`,
      githubRepoKey: `owner/repo-${installationId}`,
      name: `repo-${installationId}`,
      githubUrl: `https://github.com/owner/repo-${installationId}`,
      isActive: true,
      indexVersion: 1,
      indexStatus: "completed",
      ragStatus: "completed",
      settings: {
        issueAssistantEnabled: true,
        autoFormatIssue: true,
        autoAnswerQuestions: true,
        tagMaintainersForCodeChanges: true,
        requireApproval: false,
        discussionAssistantEnabled: true,
        autoFormatDiscussion: true,
        autoAnswerDiscussionQuestions: true,
        tagMaintainersForDiscussionCodeChanges: true,
        requireApprovalForDiscussions: false,
      },
      monthlyActions: 0,
      lastResetAt: now,
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function beginWebhookAccessStateAttestation(
  t: ReturnType<typeof convexTest>,
  installationId: number,
  options: { keepScheduledAttempt?: boolean; retryCount?: number } = {},
): Promise<number> {
  const generation = await t.mutation(
    internal.github.internalMutation
      .beginInstallationWebhookAccessStateAttestation,
    { installationId },
  );
  if (generation === null) {
    throw new Error("Webhook access-state attestation did not start");
  }
  await t.run(async (ctx) => {
    const installation = await ctx.db
      .query("githubInstallations")
      .withIndex("by_installation_id", (q) =>
        q.eq("installationId", installationId),
      )
      .unique();
    if (!installation) {
      throw new Error("installation not found");
    }
    if (options.retryCount !== undefined) {
      await ctx.db.patch(installation._id, {
        webhookAccessStateAttestationRetryCount: options.retryCount,
      });
    }
    if (options.keepScheduledAttempt === true) {
      return;
    }
    const attempts = (
      await ctx.db.system.query("_scheduled_functions").collect()
    ).filter(
      (scheduled) =>
        scheduled.state.kind === "pending" &&
        scheduled.name ===
          "github/action:reconcileInstallationWebhookAccessState" &&
        (scheduled.args[0] as { expectedGeneration?: number })
          .expectedGeneration === generation,
    );
    for (const attempt of attempts) {
      await ctx.scheduler.cancel(attempt._id);
    }
  });
  return generation;
}

beforeEach(() => {
  process.env.GITHUB_APP_ID = "test-app-id";
  process.env.GITHUB_APP_PRIVATE_KEY = "test-private-key";
  mockedGenerateGitHubAppJWT = vi
    .spyOn(githubHelpers, "generateGitHubAppJWT")
    .mockResolvedValue("signed-app-jwt");
  mockedGetInstallationToken = vi
    .spyOn(githubHelpers, "getInstallationToken")
    .mockResolvedValue("installation-token");
  mockedGetGitHubInstallationAccessState = vi
    .spyOn(githubHelpers, "getGitHubInstallationAccessState")
    .mockResolvedValue("active");
  vi.spyOn(githubHelpers, "getIssueComments").mockResolvedValue([]);
  vi.spyOn(githubHelpers, "getDiscussionComments").mockResolvedValue([]);
  vi.spyOn(githubHelpers, "getRepositoryMaintainers").mockResolvedValue([]);
  globalThis.fetch = vi.fn(async () =>
    Response.json({ repositories: [] }),
  ) as typeof fetch;
});

afterEach(() => {
  if (originalAppId === undefined) {
    delete process.env.GITHUB_APP_ID;
  } else {
    process.env.GITHUB_APP_ID = originalAppId;
  }
  if (originalPrivateKey === undefined) {
    delete process.env.GITHUB_APP_PRIVATE_KEY;
  } else {
    process.env.GITHUB_APP_PRIVATE_KEY = originalPrivateKey;
  }
  globalThis.fetch = originalFetch;
  if (vi.isFakeTimers()) {
    vi.clearAllTimers();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function expectRejectedReconciliationPageToRecover(
  getRejectedPage: (validRepository: Record<string, unknown>) => unknown[],
): Promise<void> {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const installationId = 496;
  const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
  await insertInstallation(t, ownerId, installationId);
  const repositoryId = await insertLinkedRepository(t, ownerId, installationId);
  const validRepository: Record<string, unknown> = {
    id: installationId + 1,
    full_name: `owner/repo-${installationId}`,
    visibility: "public",
    license: { key: " mit ", spdx_id: " MIT " },
  };
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ repositories: getRejectedPage(validRepository) }),
    )
    .mockResolvedValueOnce(Response.json({ repositories: [validRepository] }));
  globalThis.fetch = fetchMock as typeof fetch;

  const epoch = await t.mutation(
    internal.github.internalMutation.startRepositoryAccessReconciliation,
    { installationId, expectedAccessSuspendedAt: null },
  );
  if (epoch === null) throw new Error("reconciliation did not start");
  const scheduledBefore = await t.run(async (ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );

  await t.action(
    internal.github.action.continueRepositoryAccessReconciliation,
    { installationId, epoch, retryCount: 0 },
  );

  const rejectedState = await t.run(async (ctx) => ({
    installation: await ctx.db
      .query("githubInstallations")
      .withIndex("by_installation_id", (q) =>
        q.eq("installationId", installationId),
      )
      .first(),
    repository: await ctx.db.get(repositoryId),
    scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
  }));
  expect(rejectedState.installation).toMatchObject({
    repositoryAccessReconciliationEpoch: epoch,
    repositoryAccessReconciliationNextPage: 1,
    repositoryAccessReconciliationPhase: "fetching",
  });
  expect(rejectedState.repository).toMatchObject({
    isActive: true,
    githubRepositoryId: installationId + 1,
  });
  expect(
    rejectedState.repository?.githubAccessReconciliationEpoch,
  ).toBeUndefined();
  expect(rejectedState.repository?.githubAccessRevokedAt).toBeUndefined();
  expect(rejectedState.repository?.githubVisibility).toBeUndefined();
  expect(
    rejectedState.scheduled.filter(
      (scheduled) =>
        scheduled.name ===
        "github/action:continueRepositoryAccessReconciliation",
    ),
  ).toHaveLength(
    scheduledBefore.filter(
      (scheduled) =>
        scheduled.name ===
        "github/action:continueRepositoryAccessReconciliation",
    ).length + 1,
  );
  expect(
    rejectedState.scheduled.filter(
      (scheduled) =>
        scheduled.name ===
        "repositories/internalMutation:finalizeRepositoryAccessReconciliation",
    ),
  ).toHaveLength(0);

  await t.action(
    internal.github.action.continueRepositoryAccessReconciliation,
    { installationId, epoch, retryCount: 1 },
  );
  await t.finishAllScheduledFunctions(() => vi.advanceTimersToNextTimer());

  const recoveredState = await t.run(async (ctx) => ({
    installation: await ctx.db
      .query("githubInstallations")
      .withIndex("by_installation_id", (q) =>
        q.eq("installationId", installationId),
      )
      .first(),
    repository: await ctx.db.get(repositoryId),
  }));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(
    recoveredState.installation?.repositoryAccessReconciliationPhase,
  ).toBeUndefined();
  expect(
    recoveredState.installation?.repositoryAccessReconciliationNextPage,
  ).toBeUndefined();
  expect(recoveredState.repository).toMatchObject({
    githubRepositoryId: installationId + 1,
    githubRepo: `owner/repo-${installationId}`,
    githubVisibility: "public",
    licenseKey: "mit",
    licenseSpdxId: "MIT",
    githubAccessReconciliationEpoch: epoch,
    isActive: true,
  });
  expect(recoveredState.repository?.githubAccessRevokedAt).toBeUndefined();
}

async function finishCurrentRepositoryAccessReconciliation(
  t: ReturnType<typeof convexTest>,
  installationId: number,
): Promise<void> {
  const fetching = await t.run(async (ctx) =>
    ctx.db
      .query("githubInstallations")
      .withIndex("by_installation_id", (q) =>
        q.eq("installationId", installationId),
      )
      .unique(),
  );
  if (
    fetching?.repositoryAccessReconciliationEpoch === undefined ||
    fetching.repositoryAccessReconciliationRetryCount === undefined
  ) {
    throw new Error("repository reconciliation did not start");
  }

  const epoch = fetching.repositoryAccessReconciliationEpoch;
  await t.action(
    internal.github.action.continueRepositoryAccessReconciliation,
    {
      installationId,
      epoch,
      retryCount: fetching.repositoryAccessReconciliationRetryCount,
    },
  );
  await t.mutation(
    internal.repositories.internalMutation
      .finalizeRepositoryAccessReconciliation,
    {
      installationId,
      epoch,
      paginationOpts: { numItems: 25, cursor: null },
    },
  );
}

describe("GitHub installation ownership persistence", () => {
  it("atomically gates a recovered signed installation for reconciliation", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));

    const result = await t.mutation(
      internal.github.internalMutation.saveInstallation,
      {
        userId,
        installationId: 110,
        accountLogin: "recovered-org",
        accountType: "Organization",
        targetType: "Organization",
        permissions: { contents: "read" },
        ownerGithubAccountId: "654",
        startRepositoryAccessReconciliation: true,
      },
    );
    const state = await t.run(async (ctx) => ({
      installation: await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) => q.eq("installationId", 110))
        .unique(),
      reconciliations: (
        await ctx.db.system.query("_scheduled_functions").collect()
      ).filter(
        (scheduled) =>
          scheduled.name ===
          "github/action:continueRepositoryAccessReconciliation",
      ),
    }));

    expect(result.status).toBe("created");
    expect(state.installation).toMatchObject({
      userId,
      ownerGithubAccountId: "654",
      repositoryAccessReconciliationNextPage: 1,
      repositoryAccessReconciliationExpectedSuspendedAt: null,
      repositoryAccessReconciliationPhase: "fetching",
      repositoryRemovalPendingAt: expect.any(Number),
    });
    expect(state.reconciliations).toHaveLength(1);
  });

  it("does not create a row through the existing-owner refresh path", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));

    const result = await t.mutation(
      internal.github.internalMutation.saveInstallation,
      {
        userId,
        installationId: 111,
        accountLogin: "unverified-owner",
        accountType: "User",
        targetType: "User",
        permissions: { contents: "read" },
        requireExisting: true,
      },
    );
    const stored = await t.run(async (ctx) =>
      ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) => q.eq("installationId", 111))
        .first(),
    );

    expect(result).toEqual({ status: "not_found", installationId: null });
    expect(stored).toBeNull();
  });

  it("never reassigns an existing installation to another user", async () => {
    const t = convexTest(schema, modules);
    const { ownerId, attackerId } = await t.run(async (ctx) => ({
      ownerId: await ctx.db.insert("users", {}),
      attackerId: await ctx.db.insert("users", {}),
    }));
    await insertInstallation(t, ownerId, 123);

    const result = await t.mutation(
      internal.github.internalMutation.saveInstallation,
      {
        userId: attackerId,
        installationId: 123,
        accountLogin: "attacker",
        accountType: "User",
        targetType: "User",
        permissions: { contents: "write" },
      },
    );
    const stored = await t.run(async (ctx) =>
      ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) => q.eq("installationId", 123))
        .first(),
    );

    expect(result).toEqual({
      status: "owner_mismatch",
      installationId: null,
    });
    expect(stored).toMatchObject({
      userId: ownerId,
      accountLogin: "original-owner",
      accountType: "Organization",
      permissions: { contents: "read" },
    });
  });

  it("does not clear a newer suspension after stale reconciliation", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, 345);
    await t.mutation(
      internal.github.internalMutation.markInstallationSuspended,
      { installationId: 345 },
    );
    const suspensionEpoch = await t.run(async (ctx) => {
      const installation = await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) => q.eq("installationId", 345))
        .first();
      if (installation?.accessSuspendedAt === undefined) {
        throw new Error("Suspension fixture missing");
      }
      return installation.accessSuspendedAt;
    });
    const newerEpoch = await t.mutation(
      internal.github.internalMutation.markInstallationSuspended,
      { installationId: 345 },
    );

    expect(newerEpoch).not.toBe(suspensionEpoch);
    expect(
      await t.mutation(
        internal.github.internalMutation
          .markInstallationActiveAfterReconciliation,
        {
          installationId: 345,
          expectedAccessSuspendedAt: suspensionEpoch,
        },
      ),
    ).toBe(false);
    const installation = await t.run(async (ctx) =>
      ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) => q.eq("installationId", 345))
        .first(),
    );
    expect(installation?.accessSuspendedAt).toBe(newerEpoch);
  });

  it("allows the verified owner to refresh metadata without changing ownership", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, 456);
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        id: 456,
        account: { id: 654, login: "verified-org", type: "Organization" },
        target_type: "Organization",
        permissions: { contents: "write" },
      }),
    ) as typeof fetch;

    const result = await t
      .withIdentity({ subject: `${ownerId}|test-session` })
      .action(api.github.action.saveInstallation, { installationId: 456 });
    const state = await t.run(async (ctx) => ({
      installation: await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) => q.eq("installationId", 456))
        .first(),
      reconciliations: (
        await ctx.db.system.query("_scheduled_functions").collect()
      ).filter(
        (scheduled) =>
          scheduled.name ===
          "github/action:continueRepositoryAccessReconciliation",
      ),
    }));

    expect(result).toEqual({ status: "bound", installationId: 456 });
    expect(mockedGenerateGitHubAppJWT).toHaveBeenCalledOnce();
    expect(state.installation).toMatchObject({
      userId: ownerId,
      accountLogin: "verified-org",
      accountType: "Organization",
      permissions: { contents: "write" },
      repositoryAccessReconciliationNextPage: 1,
      repositoryAccessReconciliationExpectedSuspendedAt: null,
      repositoryAccessReconciliationPhase: "fetching",
      repositoryRemovalPendingAt: expect.any(Number),
    });
    expect(state.reconciliations).toHaveLength(1);
  });
});

describe("authenticated installation refresh", () => {
  it("waits for a signed webhook before binding an organization installation", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertOAuthInstallationAttestation(t, userId, [901]);
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        id: 901,
        account: { id: 987, login: "verified-org", type: "Organization" },
        target_type: "Organization",
        permissions: { contents: "read" },
      }),
    ) as typeof fetch;

    await expect(
      t
        .withIdentity({ subject: `${userId}|test-session` })
        .action(api.github.action.saveInstallation, { installationId: 901 }),
    ).resolves.toEqual({ status: "not_bound_yet" });

    const state = await t.run(async (ctx) => ({
      installation: await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) => q.eq("installationId", 901))
        .unique(),
      reconciliations: (
        await ctx.db.system.query("_scheduled_functions").collect()
      ).filter(
        (scheduled) =>
          scheduled.name ===
          "github/action:continueRepositoryAccessReconciliation",
      ),
    }));

    expect(state.installation).toBeNull();
    expect(state.reconciliations).toHaveLength(0);
    expect(mockedGenerateGitHubAppJWT).toHaveBeenCalledOnce();
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.github.com/app/installations/901",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("requires reauthorization when the OAuth snapshot is expired", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const now = Date.now();
    await insertOAuthInstallationAttestation(t, userId, [902], {
      attestedAt: now - 10_000,
      expiresAt: now - 1,
    });
    globalThis.fetch = vi.fn();

    await expect(
      t
        .withIdentity({ subject: `${userId}|test-session` })
        .action(api.github.action.saveInstallation, { installationId: 902 }),
    ).resolves.toEqual({ status: "reauth_required" });
    expect(mockedGenerateGitHubAppJWT).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("requires reauthorization when the snapshot omits the callback installation", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertOAuthInstallationAttestation(t, userId, [903]);
    globalThis.fetch = vi.fn();

    await expect(
      t
        .withIdentity({ subject: `${userId}|test-session` })
        .action(api.github.action.saveInstallation, { installationId: 904 }),
    ).resolves.toEqual({ status: "reauth_required" });
    expect(mockedGenerateGitHubAppJWT).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("fails closed when the OAuth snapshot identity differs from the account", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertOAuthInstallationAttestation(t, userId, [905], {
      githubAccountId: "999",
    });
    globalThis.fetch = vi.fn();

    await expect(
      t
        .withIdentity({ subject: `${userId}|test-session` })
        .action(api.github.action.saveInstallation, { installationId: 905 }),
    ).resolves.toEqual({ status: "reauth_required" });
    expect(mockedGenerateGitHubAppJWT).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("does not recover a personal installation owned by another account", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertOAuthInstallationAttestation(t, userId, [906]);
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        id: 906,
        account: { id: 999, login: "other-user", type: "User" },
        target_type: "User",
        permissions: { contents: "read" },
      }),
    ) as typeof fetch;

    await expect(
      t
        .withIdentity({ subject: `${userId}|test-session` })
        .action(api.github.action.saveInstallation, { installationId: 906 }),
    ).rejects.toThrow("GitHub installation owner does not match authorization");
    const stored = await t.run(async (ctx) =>
      ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) => q.eq("installationId", 906))
        .first(),
    );
    expect(stored).toBeNull();
  });

  it("requires fresh GitHub authorization for an arbitrary unbound installation", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    globalThis.fetch = vi.fn();

    await expect(
      t
        .withIdentity({ subject: `${userId}|test-session` })
        .action(api.github.action.saveInstallation, { installationId: 999 }),
    ).resolves.toEqual({ status: "reauth_required" });

    expect(mockedGenerateGitHubAppJWT).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("does not disclose an installation owned by another authenticated user", async () => {
    const t = convexTest(schema, modules);
    const { ownerId, attackerId } = await t.run(async (ctx) => ({
      ownerId: await ctx.db.insert("users", {}),
      attackerId: await ctx.db.insert("users", {}),
    }));
    await insertInstallation(t, ownerId, 777);
    globalThis.fetch = vi.fn();

    await expect(
      t
        .withIdentity({ subject: `${attackerId}|test-session` })
        .action(api.github.action.saveInstallation, { installationId: 777 }),
    ).resolves.toEqual({ status: "not_bound_yet" });

    expect(mockedGenerateGitHubAppJWT).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("fails immediately when GitHub App credentials are missing", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, 778);
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    globalThis.fetch = vi.fn();

    await expect(
      t
        .withIdentity({ subject: `${ownerId}|test-session` })
        .action(api.github.action.saveInstallation, { installationId: 778 }),
    ).rejects.toThrow("GitHub App credentials not configured");
    expect(mockedGenerateGitHubAppJWT).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each([404, 503])(
    "fails immediately when GitHub returns HTTP %i",
    async (status) => {
      const t = convexTest(schema, modules);
      const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
      await insertInstallation(t, ownerId, 779 + status);
      globalThis.fetch = vi.fn(async () =>
        Response.json({}, { status }),
      ) as typeof fetch;

      await expect(
        t
          .withIdentity({ subject: `${ownerId}|test-session` })
          .action(api.github.action.saveInstallation, {
            installationId: 779 + status,
          }),
      ).rejects.toThrow("Failed to refresh GitHub installation details");
      expect(globalThis.fetch).toHaveBeenCalledOnce();
    },
  );

  it("fails immediately when GitHub cannot be reached", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, 780);
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network unavailable");
    }) as typeof fetch;

    await expect(
      t
        .withIdentity({ subject: `${ownerId}|test-session` })
        .action(api.github.action.saveInstallation, { installationId: 780 }),
    ).rejects.toThrow("Failed to refresh GitHub installation details");
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });
});

describe("authenticated OAuth installation recovery", () => {
  it("selects the first candidate from a maximum-size OAuth snapshot", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const installationIds = Array.from(
      { length: GITHUB_INSTALLATION_ATTESTATION_MAX_INSTALLATIONS },
      (_, index) => 1_000 + index,
    );
    await insertOAuthInstallationAttestation(t, userId, installationIds);

    await expect(
      t.query(
        internal.github.internalQuery.getOAuthInstallationRecoveryTarget,
        { userId, now: Date.now() },
      ),
    ).resolves.toEqual({ status: "candidate", installationId: 1_000 });
  });

  it("recovers a personal fresh-DB installation without a setup callback", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertOAuthInstallationAttestation(t, userId, [104575964]);
    const fetchMock = vi.fn(async () =>
      Response.json({
        id: 104575964,
        account: { id: 654, login: "hyochan", type: "User" },
        target_type: "User",
        permissions: { contents: "read" },
      }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      t
        .withIdentity({ subject: `${userId}|test-session` })
        .action(api.github.action.recoverOAuthInstallation, {}),
    ).resolves.toEqual({
      status: "recovered",
      installationId: 104575964,
    });

    const installation = await t.run(async (ctx) =>
      ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) =>
          q.eq("installationId", 104575964),
        )
        .unique(),
    );
    expect(installation).toMatchObject({
      userId,
      installationId: 104575964,
      ownerGithubAccountId: "654",
      accountLogin: "hyochan",
      accountType: "User",
      repositoryAccessReconciliationPhase: "fetching",
      repositoryAccessReconciliationNextPage: 1,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/app/installations/104575964",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("recovers at most one installation per call and becomes idempotent", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertOAuthInstallationAttestation(t, userId, [910, 911]);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const installationId = Number(
        new URL(input.toString()).pathname.split("/").pop(),
      );
      return Response.json({
        id: installationId,
        account: {
          id: 654,
          login: `personal-${installationId}`,
          type: "User",
        },
        target_type: "User",
        permissions: { contents: "read" },
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const authenticated = t.withIdentity({
      subject: `${userId}|test-session`,
    });

    await expect(
      authenticated.action(api.github.action.recoverOAuthInstallation, {}),
    ).resolves.toEqual({ status: "recovered", installationId: 910 });
    await expect(
      authenticated.action(api.github.action.recoverOAuthInstallation, {}),
    ).resolves.toEqual({ status: "recovered", installationId: 911 });
    await expect(
      authenticated.action(api.github.action.recoverOAuthInstallation, {}),
    ).resolves.toEqual({ status: "complete" });

    const installations = await t.run(async (ctx) =>
      ctx.db.query("githubInstallations").take(3),
    );
    expect(
      installations
        .map((installation) => installation.installationId)
        .sort((left, right) => left - right),
    ).toEqual([910, 911]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockedGenerateGitHubAppJWT).toHaveBeenCalledTimes(2);
  });

  it("requires a signed configuration update for an organization installation", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertOAuthInstallationAttestation(t, userId, [912]);
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        id: 912,
        account: { id: 987, login: "verified-org", type: "Organization" },
        target_type: "Organization",
        permissions: { contents: "read" },
      }),
    ) as typeof fetch;

    await expect(
      t
        .withIdentity({ subject: `${userId}|test-session` })
        .action(api.github.action.recoverOAuthInstallation, {}),
    ).resolves.toEqual({
      status: "configure_required",
      installationId: 912,
    });

    const installation = await t.run(async (ctx) =>
      ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) => q.eq("installationId", 912))
        .first(),
    );
    expect(installation).toBeNull();
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it("reports a raced organization binding before the next suspended installation", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const attemptedInstallationId = 913;
    const suspendedInstallationId = 914;
    await insertOAuthInstallationAttestation(t, userId, [
      attemptedInstallationId,
      suspendedInstallationId,
    ]);
    await insertOAuthOwnedInstallation(t, userId, suspendedInstallationId);
    const fetchMock = vi.fn(async () => {
      await insertOAuthOwnedInstallation(t, userId, attemptedInstallationId);
      await t.run(async (ctx) => {
        const installation = await ctx.db
          .query("githubInstallations")
          .withIndex("by_installation_id", (q) =>
            q.eq("installationId", suspendedInstallationId),
          )
          .unique();
        if (!installation) {
          throw new Error("installation not found");
        }
        const now = Date.now();
        await ctx.db.patch(installation._id, {
          accessSuspendedAt: now,
          updatedAt: now,
        });
      });
      return Response.json({
        id: attemptedInstallationId,
        account: { id: 987, login: "verified-org", type: "Organization" },
        target_type: "Organization",
        permissions: { contents: "read" },
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const authenticated = t.withIdentity({
      subject: `${userId}|test-session`,
    });

    await expect(
      authenticated.action(api.github.action.recoverOAuthInstallation, {}),
    ).resolves.toEqual({
      status: "recovered",
      installationId: attemptedInstallationId,
    });
    await expect(
      authenticated.action(api.github.action.recoverOAuthInstallation, {}),
    ).resolves.toEqual({
      status: "configure_required",
      installationId: suspendedInstallationId,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not infer a raced binding when another installation becomes suspended", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const attemptedInstallationId = 915;
    const suspendedInstallationId = 916;
    await insertOAuthInstallationAttestation(t, userId, [
      attemptedInstallationId,
      suspendedInstallationId,
    ]);
    await insertOAuthOwnedInstallation(t, userId, suspendedInstallationId);
    const fetchMock = vi.fn(async () => {
      await t.run(async (ctx) => {
        const installation = await ctx.db
          .query("githubInstallations")
          .withIndex("by_installation_id", (q) =>
            q.eq("installationId", suspendedInstallationId),
          )
          .unique();
        if (!installation) {
          throw new Error("installation not found");
        }
        const now = Date.now();
        await ctx.db.patch(installation._id, {
          accessSuspendedAt: now,
          updatedAt: now,
        });
      });
      return Response.json({
        id: attemptedInstallationId,
        account: { id: 987, login: "verified-org", type: "Organization" },
        target_type: "Organization",
        permissions: { contents: "read" },
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const authenticated = t.withIdentity({
      subject: `${userId}|test-session`,
    });

    await expect(
      authenticated.action(api.github.action.recoverOAuthInstallation, {}),
    ).resolves.toEqual({
      status: "configure_required",
      installationId: suspendedInstallationId,
    });
    const attemptedInstallation = await t.run(async (ctx) =>
      ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) =>
          q.eq("installationId", attemptedInstallationId),
        )
        .unique(),
    );
    expect(attemptedInstallation).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("returns none for a fresh OAuth snapshot with no installations", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertOAuthInstallationAttestation(t, userId, []);
    globalThis.fetch = vi.fn();

    await expect(
      t
        .withIdentity({ subject: `${userId}|test-session` })
        .action(api.github.action.recoverOAuthInstallation, {}),
    ).resolves.toEqual({ status: "none" });
    expect(mockedGenerateGitHubAppJWT).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("requires reauthorization when the OAuth snapshot is missing", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    globalThis.fetch = vi.fn();

    await expect(
      t
        .withIdentity({ subject: `${userId}|test-session` })
        .action(api.github.action.recoverOAuthInstallation, {}),
    ).resolves.toEqual({ status: "reauth_required" });
    expect(mockedGenerateGitHubAppJWT).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("requires reauthorization when the OAuth snapshot is expired", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const expiresAt = Date.now() - 1;
    await insertOAuthInstallationAttestation(t, userId, [920], {
      attestedAt: expiresAt - 15 * 60 * 1_000,
      expiresAt,
    });
    globalThis.fetch = vi.fn();

    await expect(
      t
        .withIdentity({ subject: `${userId}|test-session` })
        .action(api.github.action.recoverOAuthInstallation, {}),
    ).resolves.toEqual({ status: "reauth_required" });
    expect(mockedGenerateGitHubAppJWT).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("requires reauthorization for corrupt OAuth identity provenance", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertOAuthInstallationAttestation(t, userId, [930], {
      githubAccountId: "999",
    });
    globalThis.fetch = vi.fn();

    await expect(
      t
        .withIdentity({ subject: `${userId}|test-session` })
        .action(api.github.action.recoverOAuthInstallation, {}),
    ).resolves.toEqual({ status: "reauth_required" });
    expect(mockedGenerateGitHubAppJWT).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns unavailable for an installation owned by another user", async () => {
    const t = convexTest(schema, modules);
    const { userId, ownerId } = await t.run(async (ctx) => ({
      userId: await ctx.db.insert("users", {}),
      ownerId: await ctx.db.insert("users", {}),
    }));
    await insertOAuthInstallationAttestation(t, userId, [940]);
    await insertInstallation(t, ownerId, 940);
    globalThis.fetch = vi.fn();

    await expect(
      t
        .withIdentity({ subject: `${userId}|test-session` })
        .action(api.github.action.recoverOAuthInstallation, {}),
    ).resolves.toEqual({ status: "unavailable" });
    expect(mockedGenerateGitHubAppJWT).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("requires configuration instead of completing a suspended installation", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertOAuthInstallationAttestation(t, userId, [945]);
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 945,
        ownerGithubAccountId: "654",
        ownershipVerifiedAt: now,
        accountLogin: "suspended-org",
        accountType: "Organization",
        targetType: "Organization",
        permissions: { contents: "read" },
        accessSuspendedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    });
    globalThis.fetch = vi.fn();

    await expect(
      t
        .withIdentity({ subject: `${userId}|test-session` })
        .action(api.github.action.recoverOAuthInstallation, {}),
    ).resolves.toEqual({
      status: "configure_required",
      installationId: 945,
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("fails closed when an attested installation has duplicate rows", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertOAuthInstallationAttestation(t, userId, [950]);
    await insertInstallation(t, userId, 950);
    await insertInstallation(t, userId, 950);
    globalThis.fetch = vi.fn();

    await expect(
      t
        .withIdentity({ subject: `${userId}|test-session` })
        .action(api.github.action.recoverOAuthInstallation, {}),
    ).resolves.toEqual({ status: "unavailable" });
    expect(mockedGenerateGitHubAppJWT).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("authenticated installation lookup", () => {
  it("returns an installation only to its authenticated owner", async () => {
    const t = convexTest(schema, modules);
    const { ownerId, otherUserId } = await t.run(async (ctx) => ({
      ownerId: await ctx.db.insert("users", {}),
      otherUserId: await ctx.db.insert("users", {}),
    }));
    await insertInstallation(t, ownerId, 888);

    expect(
      await t.query(api.github.query.getInstallation, {
        installationId: 888,
      }),
    ).toBeNull();
    expect(
      await t
        .withIdentity({ subject: `${otherUserId}|test-session` })
        .query(api.github.query.getInstallation, { installationId: 888 }),
    ).toBeNull();
    expect(
      await t
        .withIdentity({ subject: `${ownerId}|test-session` })
        .query(api.github.query.getInstallation, { installationId: 888 }),
    ).toMatchObject({ userId: ownerId, installationId: 888 });
    const publicInstallation = await t
      .withIdentity({ subject: `${ownerId}|test-session` })
      .query(api.github.query.getInstallation, { installationId: 888 });
    expect(publicInstallation).not.toHaveProperty("ownerGithubAccountId");
    expect(publicInstallation).not.toHaveProperty("ownershipVerifiedAt");
  });

  it("keeps a reconciling installation visible without exposing private state", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, 889);
    await t.run(async (ctx) => {
      const installation = await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) => q.eq("installationId", 889))
        .first();
      if (!installation) {
        throw new Error("Installation fixture missing");
      }
      await ctx.db.patch(installation._id, {
        repositoryAccessReconciliationEpoch: 5,
        repositoryAccessReconciliationRevision: 6,
        repositoryAccessReconciliationNextPage: 2,
        repositoryAccessReconciliationExpectedSuspendedAt: null,
        repositoryAccessReconciliationPhase: "fetching",
        webhookAccessStateAttestationRetryCount: 3,
        webhookAccessStateAttestationNextAttemptAt: Date.now() + 60_000,
      });
    });

    const installations = await t
      .withIdentity({ subject: `${ownerId}|test-session` })
      .query(api.github.query.getUserInstallations, {});

    expect(installations).toHaveLength(1);
    expect(installations[0]).toMatchObject({
      installationId: 889,
      reconciliationPending: true,
    });
    expect(installations[0]).not.toHaveProperty(
      "repositoryAccessReconciliationPhase",
    );
    expect(installations[0]).not.toHaveProperty(
      "repositoryAccessReconciliationEpoch",
    );
    expect(installations[0]).not.toHaveProperty(
      "repositoryAccessReconciliationRevision",
    );
    expect(installations[0]).not.toHaveProperty(
      "webhookAccessStateAttestationRetryCount",
    );
    expect(installations[0]).not.toHaveProperty(
      "webhookAccessStateAttestationNextAttemptAt",
    );
  });

  it("shows only an exact suspended reconciliation to the installation owner", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, 890);
    await insertInstallation(t, ownerId, 891);
    await insertInstallation(t, ownerId, 892);
    await t.run(async (ctx) => {
      const installations = await ctx.db
        .query("githubInstallations")
        .withIndex("by_user", (q) => q.eq("userId", ownerId))
        .take(3);
      const exact = installations.find(
        (installation) => installation.installationId === 890,
      );
      const ordinarySuspended = installations.find(
        (installation) => installation.installationId === 891,
      );
      const mismatched = installations.find(
        (installation) => installation.installationId === 892,
      );
      if (!exact || !ordinarySuspended || !mismatched) {
        throw new Error("Installation fixtures missing");
      }
      await ctx.db.patch(exact._id, {
        accessSuspendedAt: 77,
        repositoryAccessReconciliationEpoch: 78,
        repositoryAccessReconciliationNextPage: 1,
        repositoryAccessReconciliationExpectedSuspendedAt: 77,
        repositoryAccessReconciliationPhase: "fetching",
      });
      await ctx.db.patch(ordinarySuspended._id, { accessSuspendedAt: 88 });
      await ctx.db.patch(mismatched._id, {
        accessSuspendedAt: 99,
        repositoryAccessReconciliationEpoch: 100,
        repositoryAccessReconciliationNextPage: 1,
        repositoryAccessReconciliationExpectedSuspendedAt: 98,
        repositoryAccessReconciliationPhase: "fetching",
      });
    });
    const identity = t.withIdentity({ subject: `${ownerId}|test-session` });

    const installations = await identity.query(
      api.github.query.getUserInstallations,
      {},
    );

    expect(installations).toHaveLength(1);
    expect(installations[0]).toMatchObject({
      installationId: 890,
      reconciliationPending: true,
    });
    expect(installations[0]).not.toHaveProperty("accessSuspendedAt");
    expect(installations[0]).not.toHaveProperty(
      "repositoryAccessReconciliationExpectedSuspendedAt",
    );
    await expect(
      identity.query(api.github.query.getInstallation, { installationId: 890 }),
    ).resolves.toMatchObject({
      installationId: 890,
      reconciliationPending: true,
    });
    await expect(
      identity.query(api.github.query.getInstallation, { installationId: 891 }),
    ).resolves.toBeNull();
    await expect(
      identity.query(api.github.query.getInstallation, { installationId: 892 }),
    ).resolves.toBeNull();
  });
});

describe("invalid installation cleanup", () => {
  it("keeps a deleted installation sealed until all 101 repositories are revoked", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, 406);
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let index = 0; index < 101; index += 1) {
        await ctx.db.insert("repositories", {
          indexSyncPending: false,
          indexProgressAt: Date.now(),
          ragTotalChunks: 0,
          ragIndexedChunks: 0,
          ragFailedChunks: 0,
          userId: ownerId,
          installationId: 406,
          githubRepositoryId: 10_000 + index,
          githubRepo: `owner/repo-${index}`,
          githubRepoKey: `owner/repo-${index}`,
          name: `repo-${index}`,
          githubUrl: `https://github.com/owner/repo-${index}`,
          isActive: true,
          indexVersion: 1,
          indexStatus: "completed",
          ragStatus: "completed",
          settings: {
            issueAssistantEnabled: true,
            autoFormatIssue: true,
            autoAnswerQuestions: true,
            tagMaintainersForCodeChanges: true,
            requireApproval: false,
            discussionAssistantEnabled: true,
            autoFormatDiscussion: true,
            autoAnswerDiscussionQuestions: true,
            tagMaintainersForDiscussionCodeChanges: true,
            requireApprovalForDiscussions: false,
          },
          monthlyActions: 0,
          lastResetAt: now,
          createdAt: now,
          updatedAt: now,
        });
      }
    });

    const generation = await t.mutation(
      internal.github.internalMutation.beginInstallationAccessRemoval,
      { installationId: 406, deleteInstallationAfterPause: true },
    );
    if (generation === null) {
      throw new Error("Installation fixture missing");
    }
    await t.run(async (ctx) => {
      const scheduled = await ctx.db.system
        .query("_scheduled_functions")
        .collect();
      for (const continuation of scheduled.filter(
        (item) =>
          item.name ===
          "repositories/internalMutation:continueInstallationAccessRemoval",
      )) {
        await ctx.scheduler.cancel(continuation._id);
      }
    });
    const firstPage = await t.mutation(
      internal.repositories.internalMutation.continueInstallationAccessRemoval,
      {
        installationId: 406,
        generation,
        cursor: null,
      },
    );
    const sealedState = await t.run(async (ctx) => {
      const installation = await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) => q.eq("installationId", 406))
        .first();
      const repositories = await ctx.db
        .query("repositories")
        .withIndex("by_installation", (q) => q.eq("installationId", 406))
        .collect();
      return { installation, repositories };
    });
    const verifiedWhileLaterPagesRemain = await t.query(
      internal.github.internalQuery.getVerifiedInstallationByInstallationId,
      { installationId: 406 },
    );

    expect(firstPage).toEqual({ paused: 25, complete: false, stale: false });
    expect(verifiedWhileLaterPagesRemain).toBeNull();
    expect(sealedState.installation).toMatchObject({
      accessSuspendedAt: generation,
      repositoryAccessRemovalGeneration: generation,
      repositoryAccessRemovalCursor: expect.any(String),
      repositoryAccessRemovalDeleteInstallation: true,
      repositoryAccessRemovalPhase: "pausing",
    });
    expect(
      sealedState.repositories.filter(
        (repository) =>
          repository.githubAccessRevokedAt !== undefined &&
          repository.githubInstallationReconnectRequired === true,
      ),
    ).toHaveLength(25);
    expect(
      sealedState.repositories.filter((repository) => repository.isActive),
    ).toHaveLength(76);

    await t.run(async (ctx) => {
      const scheduled = await ctx.db.system
        .query("_scheduled_functions")
        .collect();
      for (const continuation of scheduled.filter(
        (item) =>
          item.name ===
            "repositories/internalMutation:continueInstallationAccessRemoval" &&
          item.state.kind === "pending",
      )) {
        await ctx.scheduler.cancel(continuation._id);
      }
    });
    vi.advanceTimersByTime(6 * 60 * 1_000);
    await t.action(
      internal.github.action.recoverInstallationAccessRemovals,
      {},
    );
    await t.finishAllScheduledFunctions(() => vi.advanceTimersToNextTimer());
    const completedState = await t.run(async (ctx) => ({
      installation: await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) => q.eq("installationId", 406))
        .first(),
      repositories: await ctx.db
        .query("repositories")
        .withIndex("by_installation", (q) => q.eq("installationId", 406))
        .collect(),
    }));

    expect(completedState.installation).toBeNull();
    expect(completedState.repositories).toHaveLength(101);
    expect(
      completedState.repositories.every(
        (repository) =>
          repository.isActive === false &&
          repository.githubAccessRevokedAt !== undefined &&
          repository.githubInstallationReconnectRequired === true,
      ),
    ).toBe(true);
  });

  it("keeps a suspended installation after durable repository revocation completes", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, 407);
    const repositoryId = await insertLinkedRepository(t, ownerId, 407);

    const generation = await t.mutation(
      internal.github.internalMutation.beginInstallationAccessRemoval,
      { installationId: 407, deleteInstallationAfterPause: false },
    );
    await t.finishAllScheduledFunctions(() => vi.advanceTimersToNextTimer());

    const state = await t.run(async (ctx) => ({
      installation: await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) => q.eq("installationId", 407))
        .first(),
      repository: await ctx.db.get(repositoryId),
    }));
    expect(state.installation).toMatchObject({
      accessSuspendedAt: generation,
    });
    expect(
      state.installation?.repositoryAccessRemovalGeneration,
    ).toBeUndefined();
    expect(state.installation?.repositoryAccessRemovalCursor).toBeUndefined();
    expect(state.installation?.repositoryAccessRemovalPhase).toBeUndefined();
    expect(state.repository).toMatchObject({
      isActive: false,
      githubAccessRevokedAt: expect.any(Number),
    });
    expect(
      state.repository?.githubInstallationReconnectRequired,
    ).toBeUndefined();
  });

  it("upgrades an already suspended repository to reconnect-required after deletion", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const installationId = 412;
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, installationId);
    const repositoryId = await insertLinkedRepository(
      t,
      ownerId,
      installationId,
    );

    await t.mutation(
      internal.github.internalMutation.beginInstallationAccessRemoval,
      { installationId, deleteInstallationAfterPause: false },
    );
    await t.finishAllScheduledFunctions(() => vi.advanceTimersToNextTimer());
    const suspendedRepository = await t.run(async (ctx) =>
      ctx.db.get(repositoryId),
    );
    expect(suspendedRepository).toMatchObject({
      githubAccessRevokedAt: expect.any(Number),
    });
    expect(
      suspendedRepository?.githubInstallationReconnectRequired,
    ).toBeUndefined();

    await t.mutation(
      internal.github.internalMutation.beginInstallationAccessRemoval,
      { installationId, deleteInstallationAfterPause: true },
    );
    await t.finishAllScheduledFunctions(() => vi.advanceTimersToNextTimer());

    const deletedState = await t.run(async (ctx) => ({
      installation: await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) =>
          q.eq("installationId", installationId),
        )
        .first(),
      repository: await ctx.db.get(repositoryId),
    }));
    expect(deletedState.installation).toBeNull();
    expect(deletedState.repository).toMatchObject({
      githubAccessRevokedAt: expect.any(Number),
      githubInstallationReconnectRequired: true,
    });
  });

  it("does not let a stale suspension downgrade durable installation deletion", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, 410);
    const repositoryId = await insertLinkedRepository(t, ownerId, 410);

    await t.mutation(
      internal.github.internalMutation.beginInstallationAccessRemoval,
      { installationId: 410, deleteInstallationAfterPause: true },
    );
    await t.mutation(
      internal.github.internalMutation.beginInstallationAccessRemoval,
      { installationId: 410, deleteInstallationAfterPause: false },
    );
    await t.finishAllScheduledFunctions(() => vi.advanceTimersToNextTimer());

    const state = await t.run(async (ctx) => ({
      installation: await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) => q.eq("installationId", 410))
        .first(),
      repository: await ctx.db.get(repositoryId),
    }));
    expect(state.installation).toBeNull();
    expect(state.repository).toMatchObject({
      isActive: false,
      githubAccessRevokedAt: expect.any(Number),
    });
  });

  it("does not let stale unsuspension cancel durable installation deletion", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, 411);
    const repositoryId = await insertLinkedRepository(t, ownerId, 411);

    const generation = await t.mutation(
      internal.github.internalMutation.beginInstallationAccessRemoval,
      { installationId: 411, deleteInstallationAfterPause: true },
    );
    if (generation === null) throw new Error("Installation fixture missing");
    const epoch = await t.mutation(
      internal.github.internalMutation.startRepositoryAccessReconciliation,
      { installationId: 411, expectedAccessSuspendedAt: generation },
    );

    expect(epoch).toBeNull();
    await t.finishAllScheduledFunctions(() => vi.advanceTimersToNextTimer());

    const state = await t.run(async (ctx) => ({
      installation: await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) => q.eq("installationId", 411))
        .first(),
      repository: await ctx.db.get(repositoryId),
    }));
    expect(state.installation).toBeNull();
    expect(state.repository).toMatchObject({
      isActive: false,
      githubAccessRevokedAt: expect.any(Number),
    });
  });

  it("rejects an old access-removal continuation after a newer suspension", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, 408);
    const repositoryId = await insertLinkedRepository(t, ownerId, 408);
    const oldGeneration = await t.mutation(
      internal.github.internalMutation.beginInstallationAccessRemoval,
      { installationId: 408, deleteInstallationAfterPause: false },
    );
    const currentGeneration = await t.mutation(
      internal.github.internalMutation.beginInstallationAccessRemoval,
      { installationId: 408, deleteInstallationAfterPause: false },
    );
    if (oldGeneration === null || currentGeneration === null) {
      throw new Error("Installation fixture missing");
    }

    await expect(
      t.mutation(
        internal.repositories.internalMutation
          .continueInstallationAccessRemoval,
        { installationId: 408, generation: oldGeneration, cursor: null },
      ),
    ).resolves.toEqual({ paused: 0, complete: true, stale: true });
    const state = await t.run(async (ctx) => ({
      installation: await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) => q.eq("installationId", 408))
        .first(),
      repository: await ctx.db.get(repositoryId),
    }));
    expect(currentGeneration).toBeGreaterThan(oldGeneration);
    expect(state.installation).toMatchObject({
      accessSuspendedAt: currentGeneration,
      repositoryAccessRemovalGeneration: currentGeneration,
      repositoryAccessRemovalCursor: null,
    });
    expect(state.repository?.githubAccessRevokedAt).toBeUndefined();
  });

  it("cancels stale access removal when unsuspension starts a new reconciliation", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, 409);
    const repositoryId = await insertLinkedRepository(t, ownerId, 409);
    const generation = await t.mutation(
      internal.github.internalMutation.beginInstallationAccessRemoval,
      { installationId: 409, deleteInstallationAfterPause: false },
    );
    if (generation === null) throw new Error("Installation fixture missing");
    const epoch = await t.mutation(
      internal.github.internalMutation.startRepositoryAccessReconciliation,
      { installationId: 409, expectedAccessSuspendedAt: generation },
    );

    await expect(
      t.mutation(
        internal.repositories.internalMutation
          .continueInstallationAccessRemoval,
        { installationId: 409, generation, cursor: null },
      ),
    ).resolves.toEqual({ paused: 0, complete: true, stale: true });
    const state = await t.run(async (ctx) => ({
      installation: await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) => q.eq("installationId", 409))
        .first(),
      repository: await ctx.db.get(repositoryId),
    }));
    expect(epoch).toEqual(expect.any(Number));
    expect(state.installation).toMatchObject({
      accessSuspendedAt: generation,
      repositoryAccessReconciliationEpoch: epoch,
      repositoryAccessReconciliationRevision: expect.any(Number),
      repositoryAccessReconciliationPhase: "fetching",
    });
    expect(
      state.installation?.repositoryAccessRemovalGeneration,
    ).toBeUndefined();
    expect(state.installation?.repositoryAccessRemovalCursor).toBeUndefined();
    expect(state.installation?.repositoryAccessRemovalPhase).toBeUndefined();
    expect(state.repository?.githubAccessRevokedAt).toBeUndefined();
  });

  it("pauses linked repositories before deleting a missing installation", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, 404);
    const repositoryId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("repositories", {
        indexSyncPending: false,
        indexProgressAt: Date.now(),
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        userId: ownerId,
        installationId: 404,
        githubRepositoryId: 505,
        githubRepo: "owner/repo",
        githubRepoKey: "owner/repo",
        name: "repo",
        githubUrl: "https://github.com/owner/repo",
        isActive: true,
        indexVersion: 1,
        indexStatus: "completed",
        ragStatus: "completed",
        settings: {
          issueAssistantEnabled: true,
          autoFormatIssue: true,
          autoAnswerQuestions: true,
          tagMaintainersForCodeChanges: true,
          requireApproval: false,
          discussionAssistantEnabled: true,
          autoFormatDiscussion: true,
          autoAnswerDiscussionQuestions: true,
          tagMaintainersForDiscussionCodeChanges: true,
          requireApprovalForDiscussions: false,
        },
        monthlyActions: 0,
        lastResetAt: now,
        createdAt: now,
        updatedAt: now,
      });
    });
    mockedGetInstallationToken.mockRejectedValue(new Error("404 Not Found"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const repositories = await t
      .withIdentity({ subject: `${ownerId}|test-session` })
      .action(api.github.action.listUserRepositories, {});
    await t.finishAllScheduledFunctions(() => vi.advanceTimersToNextTimer());
    const { installation, repository } = await t.run(async (ctx) => ({
      installation: await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) => q.eq("installationId", 404))
        .first(),
      repository: await ctx.db.get(repositoryId),
    }));

    expect(repositories).toEqual({
      repositories: [],
      continueCursor: null,
    });
    expect(installation).toBeNull();
    expect(repository).toMatchObject({
      isActive: false,
      isActiveBeforeAccessRevocation: true,
      githubInstallationReconnectRequired: true,
    });
    expect(repository?.githubAccessRevokedAt).toEqual(expect.any(Number));
  });

  it("handles an HTTP 404 repository-list response with the same fail-closed cleanup", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, 405);
    const repositoryId = await insertLinkedRepository(t, ownerId, 405);
    globalThis.fetch = vi.fn(
      async () => new Response("not found", { status: 404 }),
    ) as typeof fetch;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await t
      .withIdentity({ subject: `${ownerId}|test-session` })
      .action(api.github.action.listUserRepositories, {});
    await t.finishAllScheduledFunctions(() => vi.advanceTimersToNextTimer());
    const state = await t.run(async (ctx) => ({
      installation: await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) => q.eq("installationId", 405))
        .first(),
      repository: await ctx.db.get(repositoryId),
    }));

    expect(state.installation).toBeNull();
    expect(state.repository?.githubAccessRevokedAt).toEqual(expect.any(Number));
    expect(state.repository?.githubInstallationReconnectRequired).toBe(true);
  });

  it("suspends and pauses an installation on an authoritative HTTP 403", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, 403);
    const repositoryId = await insertLinkedRepository(t, ownerId, 403);
    globalThis.fetch = vi.fn(
      async () => new Response("forbidden", { status: 403 }),
    ) as typeof fetch;
    mockedGetGitHubInstallationAccessState.mockResolvedValue("suspended");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await t
      .withIdentity({ subject: `${ownerId}|test-session` })
      .action(api.github.action.listUserRepositories, {});
    await t.finishAllScheduledFunctions(() => vi.advanceTimersToNextTimer());
    const state = await t.run(async (ctx) => ({
      installation: await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) => q.eq("installationId", 403))
        .first(),
      repository: await ctx.db.get(repositoryId),
    }));
    const publicInstallations = await t
      .withIdentity({ subject: `${ownerId}|test-session` })
      .query(api.github.query.getUserInstallations, {});

    expect(state.installation?.accessSuspendedAt).toEqual(expect.any(Number));
    expect(state.repository?.githubAccessRevokedAt).toEqual(expect.any(Number));
    expect(publicInstallations).toEqual([]);
  });

  it("does not brick an active installation on a transient HTTP 403", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, 404);
    const repositoryId = await insertLinkedRepository(t, ownerId, 404);
    globalThis.fetch = vi.fn(
      async () => new Response("rate limited", { status: 403 }),
    ) as typeof fetch;
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      t
        .withIdentity({ subject: `${ownerId}|test-session` })
        .action(api.github.action.listUserRepositories, {}),
    ).rejects.toThrow("Unable to load repositories from GitHub");
    const state = await t.run(async (ctx) => ({
      installation: await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) => q.eq("installationId", 404))
        .first(),
      repository: await ctx.db.get(repositoryId),
    }));

    expect(mockedGetGitHubInstallationAccessState).toHaveBeenCalledOnce();
    expect(state.installation?.accessSuspendedAt).toBeUndefined();
    expect(state.repository?.githubAccessRevokedAt).toBeUndefined();
  });
});

describe("bounded authenticated repository listing", () => {
  const makeGitHubRepository = (id: number, fullName = `owner/repo-${id}`) => ({
    id,
    name: fullName.split("/").pop() ?? fullName,
    full_name: fullName,
    description: null,
    html_url: `https://github.com/${fullName}`,
    stargazers_count: 0,
    language: "TypeScript",
    updated_at: "2026-01-01T00:00:00Z",
    fork: false,
    private: false,
  });

  it("returns one GitHub page at a time across multiple installations", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, 10);
    await insertInstallation(t, ownerId, 20);
    mockedGetInstallationToken.mockImplementation(
      async (installationId) => `token-${installationId}`,
    );
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = new URL(input.toString());
      const authorization = new Headers(init?.headers).get("authorization");
      if (
        authorization === "Bearer token-10" &&
        url.searchParams.get("page") === "1"
      ) {
        return Response.json({
          repositories: Array.from({ length: 100 }, (_, index) =>
            makeGitHubRepository(index + 1),
          ),
        });
      }
      if (
        authorization === "Bearer token-10" &&
        url.searchParams.get("page") === "2"
      ) {
        return Response.json({ repositories: [makeGitHubRepository(101)] });
      }
      return Response.json({ repositories: [] });
    }) as typeof fetch;
    const identity = t.withIdentity({ subject: `${ownerId}|test-session` });

    const first = await identity.action(
      api.github.action.listUserRepositories,
      {},
    );
    const second = await identity.action(
      api.github.action.listUserRepositories,
      { cursor: first.continueCursor ?? undefined },
    );
    const third = await identity.action(
      api.github.action.listUserRepositories,
      { cursor: second.continueCursor ?? undefined },
    );

    expect(first.repositories).toHaveLength(100);
    expect(JSON.parse(first.continueCursor ?? "{}")).toEqual({
      installationId: 10,
      page: 2,
    });
    expect(second.repositories.map((repository) => repository.id)).toEqual([
      101,
    ]);
    expect(JSON.parse(second.continueCursor ?? "{}")).toEqual({
      installationId: 20,
      page: 1,
    });
    expect(third).toEqual({ repositories: [], continueCursor: null });
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it("skips GitHub calls for a pending installation and continues to ready ones", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, 10);
    await insertInstallation(t, ownerId, 20);
    await t.run(async (ctx) => {
      const pendingInstallation = await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) => q.eq("installationId", 10))
        .first();
      if (!pendingInstallation) {
        throw new Error("Installation fixture missing");
      }
      await ctx.db.patch(pendingInstallation._id, {
        repositoryAccessReconciliationEpoch: 5,
        repositoryAccessReconciliationNextPage: 1,
        repositoryAccessReconciliationExpectedSuspendedAt: null,
        repositoryAccessReconciliationPhase: "fetching",
      });
    });
    mockedGetInstallationToken.mockImplementation(
      async (installationId) => `token-${installationId}`,
    );
    globalThis.fetch = vi.fn(async () =>
      Response.json({ repositories: [makeGitHubRepository(201)] }),
    ) as typeof fetch;
    const identity = t.withIdentity({ subject: `${ownerId}|test-session` });

    const pendingPage = await identity.action(
      api.github.action.listUserRepositories,
      {},
    );
    const readyPage = await identity.action(
      api.github.action.listUserRepositories,
      { cursor: pendingPage.continueCursor ?? undefined },
    );

    expect(pendingPage.repositories).toEqual([]);
    expect(JSON.parse(pendingPage.continueCursor ?? "{}")).toEqual({
      installationId: 20,
      page: 1,
    });
    expect(readyPage.repositories).toMatchObject([
      {
        id: 201,
        installationId: 20,
        reconciliationPending: false,
      },
    ]);
    expect(mockedGetInstallationToken).toHaveBeenCalledOnce();
    expect(mockedGetInstallationToken).toHaveBeenCalledWith(
      20,
      expect.any(String),
      expect.any(String),
    );
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it("keeps a removal-pending installation visible while blocking repository listing", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, 10);
    await t.run(async (ctx) => {
      const installation = await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) => q.eq("installationId", 10))
        .first();
      if (!installation) {
        throw new Error("Installation fixture missing");
      }
      await ctx.db.patch(installation._id, {
        repositoryRemovalPendingAt: Date.now(),
      });
    });
    const identity = t.withIdentity({ subject: `${ownerId}|test-session` });

    const installations = await identity.query(
      api.github.query.getUserInstallations,
      {},
    );
    const repositories = await identity.action(
      api.github.action.listUserRepositories,
      {},
    );

    expect(installations).toHaveLength(1);
    expect(installations[0]).toMatchObject({
      installationId: 10,
      reconciliationPending: true,
    });
    expect(installations[0]).not.toHaveProperty("repositoryRemovalPendingAt");
    expect(repositories).toEqual({
      repositories: [],
      continueCursor: null,
    });
    expect(mockedGetInstallationToken).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("keeps the only unsuspending installation visible without listing until finalization", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, 10);
    await t.run(async (ctx) => {
      const installation = await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) => q.eq("installationId", 10))
        .first();
      if (!installation) {
        throw new Error("Installation fixture missing");
      }
      await ctx.db.patch(installation._id, {
        accessSuspendedAt: 77,
        repositoryAccessReconciliationEpoch: 78,
        repositoryAccessReconciliationRevision: 78,
        repositoryAccessReconciliationNextPage: 1,
        repositoryAccessReconciliationExpectedSuspendedAt: 77,
        repositoryAccessReconciliationPhase: "fetching",
      });
    });
    globalThis.fetch = vi.fn(async () =>
      Response.json({ repositories: [makeGitHubRepository(201)] }),
    ) as typeof fetch;
    const identity = t.withIdentity({ subject: `${ownerId}|test-session` });

    const pendingInstallations = await identity.query(
      api.github.query.getUserInstallations,
      {},
    );
    const verifiedWhilePending = await t.query(
      internal.github.internalQuery.getVerifiedInstallationByInstallationId,
      { installationId: 10 },
    );
    const pendingRepositories = await identity.action(
      api.github.action.listUserRepositories,
      {},
    );

    expect(pendingInstallations).toHaveLength(1);
    expect(pendingInstallations[0]).toMatchObject({
      installationId: 10,
      reconciliationPending: true,
    });
    expect(verifiedWhilePending).toBeNull();
    expect(pendingRepositories).toEqual({
      repositories: [],
      continueCursor: null,
    });
    expect(mockedGetInstallationToken).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();

    await expect(
      t.mutation(
        internal.repositories.internalMutation
          .applyRepositoryAccessReconciliationPage,
        {
          installationId: 10,
          epoch: 78,
          page: 1,
          hasMore: false,
          repositories: [],
        },
      ),
    ).resolves.toEqual({ applied: 0, stale: false });
    await t.finishAllScheduledFunctions(() => vi.advanceTimersToNextTimer());

    const readyInstallations = await identity.query(
      api.github.query.getUserInstallations,
      {},
    );
    const readyRepositories = await identity.action(
      api.github.action.listUserRepositories,
      {},
    );

    expect(readyInstallations).toHaveLength(1);
    expect(readyInstallations[0]).toMatchObject({
      installationId: 10,
      reconciliationPending: false,
    });
    expect(readyRepositories.repositories).toMatchObject([
      {
        id: 201,
        installationId: 10,
        reconciliationPending: false,
      },
    ]);
    expect(mockedGetInstallationToken).toHaveBeenCalledOnce();
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it("filters only immutable connected IDs without loading the connected set", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, 30);
    for (let batch = 0; batch < 6; batch++) {
      await t.run(async (ctx) => {
        const now = Date.now();
        for (let index = 0; index < 50; index++) {
          const githubRepositoryId = batch * 50 + index + 1;
          await ctx.db.insert("repositories", {
            indexSyncPending: false,
            indexVersion: 1,
            indexStatus: "completed",
            indexProgressAt: Date.now(),
            ragStatus: "completed",
            ragTotalChunks: 0,
            ragIndexedChunks: 0,
            ragFailedChunks: 0,
            userId: ownerId,
            installationId: 30,
            githubRepositoryId,
            githubRepo:
              githubRepositoryId === 299
                ? "owner/reused-name"
                : `owner/connected-${githubRepositoryId}`,
            githubRepoKey:
              githubRepositoryId === 299
                ? "owner/reused-name"
                : `owner/connected-${githubRepositoryId}`,
            name: `connected-${githubRepositoryId}`,
            githubUrl: `https://github.com/owner/connected-${githubRepositoryId}`,
            isActive: true,
            settings: {
              issueAssistantEnabled: true,
              autoFormatIssue: true,
              autoAnswerQuestions: true,
              tagMaintainersForCodeChanges: true,
              requireApproval: false,
              discussionAssistantEnabled: true,
              autoFormatDiscussion: true,
              autoAnswerDiscussionQuestions: true,
              tagMaintainersForDiscussionCodeChanges: true,
              requireApprovalForDiscussions: false,
            },
            monthlyActions: 0,
            lastResetAt: now,
            createdAt: now,
            updatedAt: now,
          });
        }
      });
    }
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        repositories: [
          makeGitHubRepository(299, "owner/current-name"),
          makeGitHubRepository(999, "owner/reused-name"),
        ],
      }),
    ) as typeof fetch;

    const result = await t
      .withIdentity({ subject: `${ownerId}|test-session` })
      .action(api.github.action.listUserRepositories, {});

    expect(result.repositories.map((repository) => repository.id)).toEqual([
      999,
    ]);
  });

  it("lists only the exact immutable repository for an installation reconnect", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, 30);
    const reconnectRepositoryId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("repositories", {
        indexSyncPending: false,
        indexVersion: 1,
        indexProgressAt: Date.now(),
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        userId: ownerId,
        installationId: 999,
        githubRepositoryId: 301,
        githubRepo: "owner/orphaned",
        githubRepoKey: "owner/orphaned",
        name: "orphaned",
        githubUrl: "https://github.com/owner/orphaned",
        isActive: false,
        githubAccessRevokedAt: now,
        isActiveBeforeAccessRevocation: true,
        githubInstallationReconnectRequired: true,
        indexStatus: "failed",
        ragStatus: "failed",
        settings: {
          issueAssistantEnabled: true,
          autoFormatIssue: true,
          autoAnswerQuestions: true,
          tagMaintainersForCodeChanges: true,
          requireApproval: false,
          discussionAssistantEnabled: true,
          autoFormatDiscussion: true,
          autoAnswerDiscussionQuestions: true,
          tagMaintainersForDiscussionCodeChanges: true,
          requireApprovalForDiscussions: false,
        },
        monthlyActions: 0,
        lastResetAt: now,
        createdAt: now,
        updatedAt: now,
      });
    });
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        repositories: [
          makeGitHubRepository(301, "owner/renamed"),
          makeGitHubRepository(302, "owner/unrelated"),
        ],
      }),
    ) as typeof fetch;

    const result = await t
      .withIdentity({ subject: `${ownerId}|test-session` })
      .action(api.github.action.listUserRepositories, {
        reconnectRepositoryId: reconnectRepositoryId,
      });

    expect(result.repositories.map((repository) => repository.id)).toEqual([
      301,
    ]);
  });

  it("never follows a cursor into another user's installation", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const otherId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, 100);
    await insertInstallation(t, otherId, 200);
    await insertInstallation(t, ownerId, 300);
    mockedGetInstallationToken.mockImplementation(
      async (installationId) => `token-${installationId}`,
    );
    globalThis.fetch = vi.fn(async () =>
      Response.json({ repositories: [makeGitHubRepository(300)] }),
    ) as typeof fetch;

    const result = await t
      .withIdentity({ subject: `${ownerId}|test-session` })
      .action(api.github.action.listUserRepositories, {
        cursor: JSON.stringify({ installationId: 200, page: 1 }),
      });

    expect(mockedGetInstallationToken).toHaveBeenCalledWith(
      300,
      expect.any(String),
      expect.any(String),
    );
    expect(result.repositories[0]?.installationId).toBe(300);
  });
});

describe("durable installation repository reconciliation", () => {
  it("stops retrying at the cap and lets only the owner restart a new epoch", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const installationId = 495;
    const { ownerId, otherUserId } = await t.run(async (ctx) => ({
      ownerId: await ctx.db.insert("users", {}),
      otherUserId: await ctx.db.insert("users", {}),
    }));
    await insertInstallation(t, ownerId, installationId);
    const epoch = await t.mutation(
      internal.github.internalMutation.startRepositoryAccessReconciliation,
      { installationId, expectedAccessSuspendedAt: null },
    );
    if (epoch === null) throw new Error("reconciliation did not start");
    await t.run(async (ctx) => {
      const installation = await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) =>
          q.eq("installationId", installationId),
        )
        .unique();
      if (!installation) throw new Error("installation not found");
      await ctx.db.patch(installation._id, {
        repositoryAccessReconciliationRetryCount: 11,
      });
    });
    const scheduledBefore = await t.run(
      async (ctx) =>
        (await ctx.db.system.query("_scheduled_functions").collect()).filter(
          (scheduled) =>
            scheduled.name ===
            "github/action:continueRepositoryAccessReconciliation",
        ).length,
    );
    const owner = t.withIdentity({ subject: `${ownerId}|test-session` });
    const publicWhileRetrying = await owner.query(
      api.github.query.getUserInstallations,
      {},
    );
    expect(publicWhileRetrying[0]).toMatchObject({
      installationId,
      reconciliationPending: true,
      reconciliationFailed: false,
    });
    expect(publicWhileRetrying[0]).not.toHaveProperty(
      "repositoryAccessReconciliationRetryCount",
    );
    expect(publicWhileRetrying[0]).not.toHaveProperty(
      "repositoryAccessReconciliationNextAttemptAt",
    );
    delete process.env.GITHUB_APP_PRIVATE_KEY;

    await t.action(
      internal.github.action.continueRepositoryAccessReconciliation,
      { installationId, epoch, retryCount: 11 },
    );
    const retryAtCap = await t.run(async (ctx) =>
      ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) =>
          q.eq("installationId", installationId),
        )
        .unique(),
    );
    expect(retryAtCap).toMatchObject({
      repositoryAccessReconciliationRetryCount: 12,
      repositoryAccessReconciliationNextAttemptAt: expect.any(Number),
    });

    await t.action(
      internal.github.action.continueRepositoryAccessReconciliation,
      { installationId, epoch, retryCount: 12 },
    );

    const terminalState = await t.run(async (ctx) => ({
      installation: await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) =>
          q.eq("installationId", installationId),
        )
        .first(),
      scheduled: (
        await ctx.db.system.query("_scheduled_functions").collect()
      ).filter(
        (scheduled) =>
          scheduled.name ===
          "github/action:continueRepositoryAccessReconciliation",
      ).length,
    }));
    expect(terminalState.installation).toMatchObject({
      repositoryRemovalPendingAt: expect.any(Number),
      repositoryAccessReconciliationEpoch: epoch,
      repositoryAccessReconciliationFailure: "configuration",
      repositoryAccessReconciliationFailedAt: expect.any(Number),
    });
    expect(
      terminalState.installation?.repositoryAccessReconciliationPhase,
    ).toBeUndefined();
    expect(
      terminalState.installation?.repositoryAccessReconciliationNextPage,
    ).toBeUndefined();
    expect(
      terminalState.installation?.repositoryAccessReconciliationRetryCount,
    ).toBeUndefined();
    expect(
      terminalState.installation?.repositoryAccessReconciliationNextAttemptAt,
    ).toBeUndefined();
    expect(terminalState.scheduled).toBe(scheduledBefore + 1);

    const otherUser = t.withIdentity({
      subject: `${otherUserId}|test-session`,
    });
    const publicInstallations = await owner.query(
      api.github.query.getUserInstallations,
      {},
    );
    expect(publicInstallations).toMatchObject([
      {
        installationId,
        reconciliationPending: false,
        reconciliationFailed: true,
      },
    ]);
    expect(publicInstallations[0]).not.toHaveProperty(
      "repositoryAccessReconciliationFailure",
    );
    await expect(
      otherUser.action(api.github.action.retryRepositoryAccessReconciliation, {
        installationId,
      }),
    ).resolves.toEqual({ status: "not_found" });

    const restarted = await owner.action(
      api.github.action.retryRepositoryAccessReconciliation,
      { installationId },
    );
    expect(restarted.status).toBe("started");
    if (restarted.status !== "started") {
      throw new Error("reconciliation did not restart");
    }
    expect(restarted.epoch).not.toBe(epoch);
    const restartedState = await t.run(async (ctx) =>
      ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) =>
          q.eq("installationId", installationId),
        )
        .first(),
    );
    expect(restartedState).toMatchObject({
      repositoryAccessReconciliationEpoch: restarted.epoch,
      repositoryAccessReconciliationNextPage: 1,
      repositoryAccessReconciliationPhase: "fetching",
    });
    expect(
      restartedState?.repositoryAccessReconciliationFailure,
    ).toBeUndefined();
    expect(
      restartedState?.repositoryAccessReconciliationFailedAt,
    ).toBeUndefined();

    process.env.GITHUB_APP_PRIVATE_KEY = "test-private-key";
    globalThis.fetch = vi.fn(async () =>
      Response.json({ repositories: [] }),
    ) as typeof fetch;
    await t.finishAllScheduledFunctions(() => vi.advanceTimersToNextTimer());

    const recovered = await t.run(async (ctx) =>
      ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) =>
          q.eq("installationId", installationId),
        )
        .first(),
    );
    expect(recovered?.repositoryRemovalPendingAt).toBeUndefined();
    expect(recovered?.repositoryAccessReconciliationPhase).toBeUndefined();
    expect(recovered?.repositoryAccessReconciliationFailure).toBeUndefined();
    expect(recovered?.repositoryAccessReconciliationFailedAt).toBeUndefined();
  });

  it("retries when a successful GitHub response cannot be parsed as JSON", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, 499);
    globalThis.fetch = vi.fn(
      async () =>
        new Response("{", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as typeof fetch;
    const epoch = await t.mutation(
      internal.github.internalMutation.startRepositoryAccessReconciliation,
      { installationId: 499, expectedAccessSuspendedAt: null },
    );
    if (epoch === null) throw new Error("reconciliation did not start");
    const scheduledBefore = await t.run(
      async (ctx) =>
        (await ctx.db.system.query("_scheduled_functions").collect()).filter(
          (scheduled) =>
            scheduled.name ===
            "github/action:continueRepositoryAccessReconciliation",
        ).length,
    );

    await expect(
      t.action(internal.github.action.continueRepositoryAccessReconciliation, {
        installationId: 499,
        epoch,
        retryCount: 0,
      }),
    ).resolves.toBeNull();

    const state = await t.run(async (ctx) => ({
      installation: await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) => q.eq("installationId", 499))
        .first(),
      scheduled: (
        await ctx.db.system.query("_scheduled_functions").collect()
      ).filter(
        (scheduled) =>
          scheduled.name ===
          "github/action:continueRepositoryAccessReconciliation",
      ).length,
    }));
    expect(state.installation).toMatchObject({
      repositoryAccessReconciliationEpoch: epoch,
      repositoryAccessReconciliationNextPage: 1,
      repositoryAccessReconciliationPhase: "fetching",
    });
    expect(state.scheduled).toBe(scheduledBefore + 1);
  });

  it.each([
    ["a non-object element", null],
    ["a non-positive repository ID", { id: 0, full_name: "owner/invalid" }],
    [
      "an unsafe repository ID",
      { id: Number.MAX_SAFE_INTEGER + 1, full_name: "owner/invalid" },
    ],
    ["a blank full name", { id: 998, full_name: "   " }],
    ["an overlong full name", { id: 998, full_name: "x".repeat(501) }],
    ["a leading-space full name", { id: 998, full_name: " owner/repo" }],
    ["a trailing-space full name", { id: 998, full_name: "owner/repo " }],
    ["a missing owner", { id: 998, full_name: "/repo" }],
    ["a missing repository", { id: 998, full_name: "owner/" }],
    ["an extra path component", { id: 998, full_name: "owner/repo/extra" }],
    ["a control character", { id: 998, full_name: "owner/repo\u0000" }],
  ])(
    "rejects the whole page containing %s and recovers on a valid retry",
    async (_label, invalidRepository) => {
      await expectRejectedReconciliationPageToRecover((validRepository) => [
        validRepository,
        invalidRepository,
      ]);
    },
  );

  it("rejects duplicate repository IDs without applying the page and recovers on retry", async () => {
    await expectRejectedReconciliationPageToRecover((validRepository) => [
      validRepository,
      { ...validRepository, full_name: "owner/duplicate-name" },
    ]);
  });

  it("rejects case-insensitive duplicate full names with different IDs", async () => {
    await expectRejectedReconciliationPageToRecover((validRepository) => [
      validRepository,
      {
        ...validRepository,
        id: 998,
        full_name: "OWNER/REPO-496",
      },
    ]);
  });

  it("preserves durable retry progress when recovering stale fetching or finalizing work", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const staleUpdatedAt = now - 11 * 60 * 1_000;
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, 497);
    await insertInstallation(t, ownerId, 498);
    await insertInstallation(t, ownerId, 500);
    await t.run(async (ctx) => {
      const installations = await ctx.db
        .query("githubInstallations")
        .withIndex("by_user", (q) => q.eq("userId", ownerId))
        .take(10);
      for (const installation of installations) {
        switch (installation.installationId) {
          case 497:
            await ctx.db.patch(installation._id, {
              repositoryAccessReconciliationEpoch: 101,
              repositoryAccessReconciliationNextPage: 3,
              repositoryAccessReconciliationRetryCount: 9,
              repositoryAccessReconciliationNextAttemptAt: now - 1,
              repositoryAccessReconciliationExpectedSuspendedAt: null,
              repositoryAccessReconciliationPhase: "fetching",
              updatedAt: staleUpdatedAt,
            });
            break;
          case 498:
            await ctx.db.patch(installation._id, {
              repositoryAccessReconciliationEpoch: 102,
              repositoryAccessReconciliationExpectedSuspendedAt: null,
              repositoryAccessReconciliationPhase: "finalizing",
              updatedAt: staleUpdatedAt,
            });
            break;
          case 500:
            await ctx.db.patch(installation._id, {
              repositoryAccessReconciliationEpoch: 103,
              repositoryAccessReconciliationNextPage: 1,
              repositoryAccessReconciliationRetryCount: 10,
              repositoryAccessReconciliationNextAttemptAt: now + 1,
              repositoryAccessReconciliationExpectedSuspendedAt: null,
              repositoryAccessReconciliationPhase: "fetching",
              updatedAt: now,
            });
            break;
        }
      }
    });

    await t.action(
      internal.github.action.recoverRepositoryAccessReconciliations,
      {},
    );
    await t.action(
      internal.github.action.recoverRepositoryAccessReconciliations,
      {},
    );

    const state = await t.run(async (ctx) => {
      const scheduled = await ctx.db.system
        .query("_scheduled_functions")
        .collect();
      const installations = await ctx.db
        .query("githubInstallations")
        .withIndex("by_user", (q) => q.eq("userId", ownerId))
        .take(10);
      return {
        fetchingContinuations: scheduled.filter(
          (item) =>
            item.name ===
            "github/action:continueRepositoryAccessReconciliation",
        ),
        finalizers: scheduled.filter(
          (item) =>
            item.name ===
            "repositories/internalMutation:finalizeRepositoryAccessReconciliation",
        ).length,
        installations,
      };
    });
    expect(state.fetchingContinuations).toHaveLength(1);
    expect(state.fetchingContinuations[0]?.args).toEqual([
      { installationId: 497, epoch: 101, retryCount: 9 },
    ]);
    expect(state.finalizers).toBe(1);
    expect(
      state.installations.find(
        (installation) => installation.installationId === 497,
      ),
    ).toMatchObject({
      repositoryAccessReconciliationRetryCount: 9,
      repositoryAccessReconciliationNextAttemptAt: expect.any(Number),
      updatedAt: expect.any(Number),
    });
    expect(
      state.installations.find(
        (installation) => installation.installationId === 497,
      )?.updatedAt,
    ).toBeGreaterThan(staleUpdatedAt);
    expect(
      state.installations.find(
        (installation) => installation.installationId === 498,
      )?.updatedAt,
    ).toBeGreaterThan(staleUpdatedAt);
    expect(
      state.installations.find(
        (installation) => installation.installationId === 500,
      ),
    ).toMatchObject({
      repositoryAccessReconciliationRetryCount: 10,
      repositoryAccessReconciliationNextAttemptAt: now + 1,
      updatedAt: now,
    });
  });

  it("advances large installations page-by-page without restarting page one", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, 500);
    const pages = [
      Array.from({ length: 50 }, (_, index) => ({
        id: index + 1,
        full_name: `owner/repo-${index + 1}`,
      })),
      Array.from({ length: 50 }, (_, index) => ({
        id: index + 51,
        full_name: `owner/repo-${index + 51}`,
      })),
      [{ id: 101, full_name: "owner/repo-101" }],
    ];
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      const page = Number(new URL(url).searchParams.get("page"));
      return Response.json({ repositories: pages[page - 1] ?? [] });
    }) as typeof fetch;

    const epoch = await t.mutation(
      internal.github.internalMutation.startRepositoryAccessReconciliation,
      { installationId: 500, expectedAccessSuspendedAt: null },
    );
    await t.finishAllScheduledFunctions(() => vi.advanceTimersToNextTimer());
    const installation = await t.run(async (ctx) =>
      ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) => q.eq("installationId", 500))
        .first(),
    );

    expect(epoch).toEqual(expect.any(Number));
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(
      (globalThis.fetch as MockedFunction<typeof fetch>).mock.calls.map(
        ([input]) => new URL(String(input)).searchParams.get("page"),
      ),
    ).toEqual(["1", "2", "3"]);
    expect(installation?.repositoryAccessReconciliationPhase).toBeUndefined();
    expect(
      installation?.repositoryAccessReconciliationNextPage,
    ).toBeUndefined();
  });

  it("lets the newest live epoch win added-before-removed delivery", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, 600);
    const repositoryId = await insertLinkedRepository(t, ownerId, 600);
    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, {
        githubRepo: "owner/old-name",
        name: "old-name",
        githubUrl: "https://github.com/owner/old-name",
        isActive: false,
        githubAccessRevokedAt: 1,
        isActiveBeforeAccessRevocation: false,
      });
    });
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        repositories: [
          {
            id: 601,
            full_name: "owner/current-name",
            visibility: "public",
          },
        ],
      }),
    ) as typeof fetch;

    const firstEpoch = await t.mutation(
      internal.github.internalMutation.startRepositoryAccessReconciliation,
      { installationId: 600, expectedAccessSuspendedAt: null },
    );
    const secondEpoch = await t.mutation(
      internal.github.internalMutation.startRepositoryAccessReconciliation,
      { installationId: 600, expectedAccessSuspendedAt: null },
    );
    await t.finishAllScheduledFunctions(() => vi.advanceTimersToNextTimer());
    const repository = await t.run(async (ctx) => ctx.db.get(repositoryId));

    expect(secondEpoch).not.toBe(firstEpoch);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(repository).toMatchObject({
      githubRepo: "owner/current-name",
      githubRepositoryId: 601,
      isActive: false,
    });
    expect(repository?.githubAccessRevokedAt).toBeUndefined();
    expect(repository?.githubAccessReconciliationEpoch).toBe(secondEpoch);
  });
});

describe("signed installation webhook ownership binding", () => {
  function installationRepositoriesPayload(
    sender: Record<string, unknown> = {
      id: 654,
      login: "installer",
      type: "User",
    },
  ) {
    return {
      action: "added",
      repository_selection: "selected",
      installation: {
        id: 321,
        account: {
          id: 987,
          login: "example-org",
          type: "Organization",
        },
        target_type: "Organization",
        permissions: { contents: "read" },
      },
      sender,
      repositories_added: [{ id: 999, full_name: "example-org/repo" }],
    };
  }

  it("delegates suspension gating and scheduling to one mutation", async () => {
    const runMutation = vi.fn(async () => 77);
    const runAfter = vi.fn(async () => undefined);
    const ctx = {
      runMutation,
      scheduler: { runAfter },
    } as unknown as ActionCtx;

    await handleInstallationEvent(ctx, {
      action: "suspend",
      installation: { id: 321 },
    });

    expect(runMutation).toHaveBeenCalledWith(
      internal.github.internalMutation
        .beginInstallationWebhookAccessStateAttestation,
      { installationId: 321 },
    );
    expect(runAfter).not.toHaveBeenCalled();
  });

  it("stores the gate and initial attestation schedule atomically", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const installationId = 332;
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, installationId);

    const generation = await beginWebhookAccessStateAttestation(
      t,
      installationId,
      { keepScheduledAttempt: true },
    );
    const state = await t.run(async (ctx) => ({
      installation: await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) =>
          q.eq("installationId", installationId),
        )
        .unique(),
      attempts: (
        await ctx.db.system.query("_scheduled_functions").collect()
      ).filter(
        (scheduled) =>
          scheduled.state.kind === "pending" &&
          scheduled.name ===
            "github/action:reconcileInstallationWebhookAccessState" &&
          (scheduled.args[0] as { retryCount?: number }).retryCount === 0,
      ),
    }));

    expect(state.installation).toMatchObject({
      accessSuspendedAt: generation,
      webhookAccessStateAttestationGeneration: generation,
      webhookAccessStateAttestationRetryCount: 0,
      webhookAccessStateAttestationNextAttemptAt: expect.any(Number),
    });
    expect(state.attempts).toHaveLength(1);
    expect(state.attempts[0]?.args).toEqual([
      { installationId, expectedGeneration: generation, retryCount: 0 },
    ]);
  });

  it("does not let ordinary installations starve a due attestation", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let index = 0; index < 30; index++) {
        const userId = await ctx.db.insert("users", {});
        const now = Date.now();
        await ctx.db.insert("githubInstallations", {
          userId,
          installationId: 10_000 + index,
          ownerGithubAccountId: `ordinary-${index}`,
          ownershipVerifiedAt: now,
          accountLogin: `ordinary-${index}`,
          accountType: "Organization",
          targetType: "Organization",
          permissions: { contents: "read" },
          createdAt: now,
          updatedAt: now,
        });
      }
    });
    const installationId = 335;
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, installationId);
    const generation = await beginWebhookAccessStateAttestation(
      t,
      installationId,
    );
    const now = Date.now();
    await t.run(async (ctx) => {
      const installation = await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) =>
          q.eq("installationId", installationId),
        )
        .unique();
      if (!installation) throw new Error("installation not found");
      await ctx.db.patch(installation._id, {
        webhookAccessStateAttestationNextAttemptAt: now - 1,
      });
    });

    await expect(
      t.query(
        internal.github.internalQuery
          .listStaleInstallationWebhookAccessStateAttestations,
        { now },
      ),
    ).resolves.toEqual([
      {
        installationId,
        generation,
        expectedRetryCount: 0,
        expectedFailure: null,
      },
    ]);
  });

  it("contains a rejected live-state lookup inside the unknown retry boundary", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const installationId = 333;
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, installationId);
    const generation = await beginWebhookAccessStateAttestation(
      t,
      installationId,
    );
    mockedGetGitHubInstallationAccessState.mockRejectedValueOnce(
      new Error("transient lookup failure"),
    );

    await expect(
      t.action(internal.github.action.reconcileInstallationWebhookAccessState, {
        installationId,
        expectedGeneration: generation,
        retryCount: 0,
      }),
    ).resolves.toBeNull();
    const state = await t.run(async (ctx) => ({
      installation: await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) =>
          q.eq("installationId", installationId),
        )
        .unique(),
      attempts: (
        await ctx.db.system.query("_scheduled_functions").collect()
      ).filter(
        (scheduled) =>
          scheduled.state.kind === "pending" &&
          scheduled.name ===
            "github/action:reconcileInstallationWebhookAccessState" &&
          ((scheduled.args[0] as { retryCount?: number }).retryCount ?? 0) > 0,
      ),
    }));

    expect(state.installation).toMatchObject({
      accessSuspendedAt: generation,
      webhookAccessStateAttestationGeneration: generation,
      webhookAccessStateAttestationRetryCount: 1,
      webhookAccessStateAttestationNextAttemptAt: expect.any(Number),
    });
    expect(
      state.installation?.webhookAccessStateAttestationFailure,
    ).toBeUndefined();
    expect(state.attempts).toHaveLength(1);
    expect(state.attempts[0]?.args).toEqual([
      { installationId, expectedGeneration: generation, retryCount: 1 },
    ]);
  });

  it("recovers an in-flight attestation after its retry lease expires", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const installationId = 334;
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, installationId);
    const repositoryId = await insertLinkedRepository(
      t,
      ownerId,
      installationId,
    );
    const generation = await beginWebhookAccessStateAttestation(
      t,
      installationId,
      { keepScheduledAttempt: true },
    );
    mockedGetGitHubInstallationAccessState.mockResolvedValueOnce("unknown");
    await t.action(
      internal.github.action.reconcileInstallationWebhookAccessState,
      { installationId, expectedGeneration: generation, retryCount: 0 },
    );

    await t.run(async (ctx) => {
      const installation = await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) =>
          q.eq("installationId", installationId),
        )
        .unique();
      if (!installation) throw new Error("installation not found");
      await ctx.db.patch(installation._id, {
        webhookAccessStateAttestationNextAttemptAt: Date.now() - 1,
      });
    });
    mockedGetGitHubInstallationAccessState.mockResolvedValue("active");
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        repositories: [
          {
            id: installationId + 1,
            full_name: `owner/repo-${installationId}`,
            visibility: "public",
          },
        ],
      }),
    ) as typeof fetch;

    expect(
      await t.action(
        internal.github.action
          .recoverInstallationWebhookAccessStateAttestations,
        {},
      ),
    ).toEqual({ checked: 1, scheduled: 1 });
    const gated = await t.run(async (ctx) => ({
      installation: await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) =>
          q.eq("installationId", installationId),
        )
        .unique(),
      repository: await ctx.db.get(repositoryId),
    }));
    expect(gated.installation).toMatchObject({
      accessSuspendedAt: generation,
      webhookAccessStateAttestationRetryCount: 1,
    });
    expect(
      gated.installation?.webhookAccessStateAttestationFailure,
    ).toBeUndefined();
    expect(gated.repository?.isActive).toBe(true);

    await t.action(
      internal.github.action.reconcileInstallationWebhookAccessState,
      { installationId, expectedGeneration: generation, retryCount: 1 },
    );
    await finishCurrentRepositoryAccessReconciliation(t, installationId);
    const recovered = await t.run(async (ctx) => ({
      installation: await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) =>
          q.eq("installationId", installationId),
        )
        .unique(),
      repository: await ctx.db.get(repositoryId),
    }));
    expect(recovered.installation?.accessSuspendedAt).toBeUndefined();
    expect(
      recovered.installation?.webhookAccessStateAttestationGeneration,
    ).toBeUndefined();
    expect(recovered.repository?.isActive).toBe(true);
    expect(recovered.repository?.githubAccessRevokedAt).toBeUndefined();
  });

  it("gates installation access and fences repository work before live attestation", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const installationId = 327;
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, installationId);
    const repositoryId = await insertLinkedRepository(
      t,
      ownerId,
      installationId,
    );

    const generation = await beginWebhookAccessStateAttestation(
      t,
      installationId,
    );
    const gated = await t.run(async (ctx) => ({
      installation: await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) =>
          q.eq("installationId", installationId),
        )
        .unique(),
      repository: await ctx.db.get(repositoryId),
    }));
    expect(gated.installation).toMatchObject({
      accessSuspendedAt: generation,
      webhookAccessStateAttestationGeneration: generation,
      repositoryAccessRemovalGeneration: generation,
      repositoryAccessRemovalPhase: "pausing",
    });
    expect(gated.repository).toMatchObject({
      isActive: true,
      indexVersion: 1,
    });

    await t.mutation(
      internal.repositories.internalMutation.continueInstallationAccessRemoval,
      {
        installationId,
        generation,
        cursor: null,
        deleteInstallationAfterPause: false,
      },
    );
    const fenced = await t.run(async (ctx) => ctx.db.get(repositoryId));
    expect(fenced).toMatchObject({
      isActive: false,
      githubAccessRevokedAt: expect.any(Number),
      indexVersion: 2,
      indexStatus: "failed",
      ragStatus: "failed",
    });
  });

  it("keeps a recovered installation active when an old suspend is replayed", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const installationId = 324;
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, installationId);
    const repositoryId = await insertLinkedRepository(
      t,
      ownerId,
      installationId,
    );

    const firstGeneration = await beginWebhookAccessStateAttestation(
      t,
      installationId,
    );
    mockedGetGitHubInstallationAccessState.mockResolvedValueOnce("suspended");
    await t.action(
      internal.github.action.reconcileInstallationWebhookAccessState,
      {
        installationId,
        expectedGeneration: firstGeneration,
        retryCount: 0,
      },
    );
    const suspended = await t.run(async (ctx) =>
      ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) =>
          q.eq("installationId", installationId),
        )
        .unique(),
    );
    if (suspended?.accessSuspendedAt === undefined) {
      throw new Error("suspension did not start");
    }

    globalThis.fetch = vi.fn(async () =>
      Response.json({
        repositories: [
          {
            id: installationId + 1,
            full_name: `owner/repo-${installationId}`,
            visibility: "public",
          },
        ],
      }),
    ) as typeof fetch;
    const epoch = await t.mutation(
      internal.github.internalMutation.startRepositoryAccessReconciliation,
      {
        installationId,
        expectedAccessSuspendedAt: suspended.accessSuspendedAt,
      },
    );
    if (epoch === null) throw new Error("reconciliation did not start");
    await t.action(
      internal.github.action.continueRepositoryAccessReconciliation,
      { installationId, epoch, retryCount: 0 },
    );
    await t.mutation(
      internal.repositories.internalMutation
        .finalizeRepositoryAccessReconciliation,
      {
        installationId,
        epoch,
        paginationOpts: { numItems: 25, cursor: null },
      },
    );

    const replayGeneration = await beginWebhookAccessStateAttestation(
      t,
      installationId,
    );
    mockedGetGitHubInstallationAccessState.mockResolvedValue("active");
    await t.action(
      internal.github.action.reconcileInstallationWebhookAccessState,
      {
        installationId,
        expectedGeneration: replayGeneration,
        retryCount: 0,
      },
    );
    await finishCurrentRepositoryAccessReconciliation(t, installationId);

    const recovered = await t.run(async (ctx) => ({
      installation: await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) =>
          q.eq("installationId", installationId),
        )
        .unique(),
      repository: await ctx.db.get(repositoryId),
    }));
    expect(recovered.installation?.accessSuspendedAt).toBeUndefined();
    expect(
      recovered.installation?.repositoryAccessRemovalPhase,
    ).toBeUndefined();
    expect(
      recovered.installation?.repositoryAccessReconciliationPhase,
    ).toBeUndefined();
    expect(recovered.repository).toMatchObject({
      isActive: true,
      githubRepositoryId: installationId + 1,
    });
    expect(mockedGetGitHubInstallationAccessState).toHaveBeenLastCalledWith(
      installationId,
      "test-app-id",
      "test-private-key",
    );
  });

  it("keeps retrying after six unknown states and recovers when active", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const installationId = 325;
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, installationId);
    const repositoryId = await insertLinkedRepository(
      t,
      ownerId,
      installationId,
    );
    for (let attempt = 0; attempt < 7; attempt++) {
      mockedGetGitHubInstallationAccessState.mockResolvedValueOnce("unknown");
    }
    mockedGetGitHubInstallationAccessState.mockResolvedValue("active");

    const generation = await beginWebhookAccessStateAttestation(
      t,
      installationId,
      { keepScheduledAttempt: true },
    );
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        repositories: [
          {
            id: installationId + 1,
            full_name: `owner/repo-${installationId}`,
            visibility: "public",
          },
        ],
      }),
    ) as typeof fetch;
    await t.action(
      internal.github.action.reconcileInstallationWebhookAccessState,
      { installationId, expectedGeneration: generation, retryCount: 0 },
    );
    const afterUnknown = await t.run(async (ctx) => ({
      installation: await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) =>
          q.eq("installationId", installationId),
        )
        .unique(),
      repository: await ctx.db.get(repositoryId),
      retries: (
        await ctx.db.system.query("_scheduled_functions").collect()
      ).filter(
        (scheduled) =>
          scheduled.state.kind === "pending" &&
          scheduled.name ===
            "github/action:reconcileInstallationWebhookAccessState" &&
          (scheduled.args[0] as { retryCount?: number }).retryCount === 1,
      ),
    }));
    expect(afterUnknown.installation?.accessSuspendedAt).toBe(generation);
    expect(afterUnknown.repository?.isActive).toBe(true);
    expect(afterUnknown.retries).toHaveLength(1);
    expect(afterUnknown.retries[0]?.args).toEqual([
      { installationId, expectedGeneration: generation, retryCount: 1 },
    ]);

    for (let retryCount = 1; retryCount <= 7; retryCount++) {
      await t.action(
        internal.github.action.reconcileInstallationWebhookAccessState,
        { installationId, expectedGeneration: generation, retryCount },
      );
    }
    await finishCurrentRepositoryAccessReconciliation(t, installationId);
    const recovered = await t.run(async (ctx) => ({
      installation: await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) =>
          q.eq("installationId", installationId),
        )
        .unique(),
      repository: await ctx.db.get(repositoryId),
    }));
    expect(mockedGetGitHubInstallationAccessState).toHaveBeenCalledTimes(8);
    expect(recovered.installation?.accessSuspendedAt).toBeUndefined();
    expect(recovered.repository).toMatchObject({ isActive: true });
    expect(recovered.repository?.githubAccessRevokedAt).toBeUndefined();
  });

  it("terminates unknown live-state retries while keeping access gated", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const installationId = 328;
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, installationId);
    const repositoryId = await insertLinkedRepository(
      t,
      ownerId,
      installationId,
    );
    const generation = await beginWebhookAccessStateAttestation(
      t,
      installationId,
      { retryCount: 12 },
    );
    mockedGetGitHubInstallationAccessState.mockResolvedValue("unknown");

    await t.action(
      internal.github.action.reconcileInstallationWebhookAccessState,
      { installationId, expectedGeneration: generation, retryCount: 12 },
    );

    const terminal = await t.run(async (ctx) => ({
      installation: await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) =>
          q.eq("installationId", installationId),
        )
        .unique(),
      attestationRetries: (
        await ctx.db.system.query("_scheduled_functions").collect()
      ).filter(
        (scheduled) =>
          scheduled.state.kind === "pending" &&
          scheduled.name ===
            "github/action:reconcileInstallationWebhookAccessState" &&
          ((scheduled.args[0] as { retryCount?: number }).retryCount ?? 0) > 0,
      ),
    }));
    expect(terminal.installation).toMatchObject({
      accessSuspendedAt: generation,
      webhookAccessStateAttestationGeneration: generation,
      webhookAccessStateAttestationFailure: "github_request",
      webhookAccessStateAttestationFailedAt: expect.any(Number),
    });
    expect(terminal.attestationRetries).toHaveLength(0);

    await t.mutation(
      internal.repositories.internalMutation.continueInstallationAccessRemoval,
      {
        installationId,
        generation,
        cursor: null,
        deleteInstallationAfterPause: false,
      },
    );
    expect(await t.run(async (ctx) => ctx.db.get(repositoryId))).toMatchObject({
      isActive: false,
      indexStatus: "failed",
      ragStatus: "failed",
    });
  });

  it("recovers a terminal attestation after GitHub configuration resumes", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const installationId = 329;
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, installationId);
    const repositoryId = await insertLinkedRepository(
      t,
      ownerId,
      installationId,
    );
    const generation = await beginWebhookAccessStateAttestation(
      t,
      installationId,
      { retryCount: 12 },
    );

    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    await t.action(
      internal.github.action.reconcileInstallationWebhookAccessState,
      { installationId, expectedGeneration: generation, retryCount: 12 },
    );
    await t.mutation(
      internal.repositories.internalMutation.continueInstallationAccessRemoval,
      {
        installationId,
        generation,
        cursor: null,
        deleteInstallationAfterPause: false,
      },
    );

    const staleAt = Date.now() - 16 * 60 * 1_000;
    await t.run(async (ctx) => {
      const installation = await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) =>
          q.eq("installationId", installationId),
        )
        .unique();
      if (!installation) throw new Error("installation not found");
      await ctx.db.patch(installation._id, {
        webhookAccessStateAttestationFailedAt: staleAt,
        webhookAccessStateAttestationNextAttemptAt: staleAt,
        updatedAt: staleAt,
      });
    });

    expect(
      await t.action(
        internal.github.action
          .recoverInstallationWebhookAccessStateAttestations,
        {},
      ),
    ).toEqual({ checked: 0, scheduled: 0 });

    process.env.GITHUB_APP_ID = "test-app-id";
    process.env.GITHUB_APP_PRIVATE_KEY = "test-private-key";
    mockedGetGitHubInstallationAccessState.mockResolvedValue("active");
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        repositories: [
          {
            id: installationId + 1,
            full_name: `owner/repo-${installationId}`,
            visibility: "public",
          },
        ],
      }),
    ) as typeof fetch;

    expect(
      await t.action(
        internal.github.action
          .recoverInstallationWebhookAccessStateAttestations,
        {},
      ),
    ).toEqual({ checked: 1, scheduled: 1 });
    await t.action(
      internal.github.action.reconcileInstallationWebhookAccessState,
      { installationId, expectedGeneration: generation, retryCount: 0 },
    );
    await finishCurrentRepositoryAccessReconciliation(t, installationId);

    const recovered = await t.run(async (ctx) => ({
      installation: await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) =>
          q.eq("installationId", installationId),
        )
        .unique(),
      repository: await ctx.db.get(repositoryId),
    }));
    expect(recovered.installation?.accessSuspendedAt).toBeUndefined();
    expect(
      recovered.installation?.webhookAccessStateAttestationGeneration,
    ).toBeUndefined();
    expect(
      recovered.installation?.webhookAccessStateAttestationFailure,
    ).toBeUndefined();
    expect(recovered.repository).toMatchObject({ isActive: true });
    expect(recovered.repository?.githubAccessRevokedAt).toBeUndefined();
  });

  it("rejects a stale attestation recovery claim after generation changes", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const installationId = 330;
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, installationId);
    const staleGeneration = await beginWebhookAccessStateAttestation(
      t,
      installationId,
      { retryCount: 12 },
    );
    mockedGetGitHubInstallationAccessState.mockResolvedValue("unknown");
    await t.action(
      internal.github.action.reconcileInstallationWebhookAccessState,
      {
        installationId,
        expectedGeneration: staleGeneration,
        retryCount: 12,
      },
    );

    const currentGeneration = await beginWebhookAccessStateAttestation(
      t,
      installationId,
    );
    expect(currentGeneration).not.toBe(staleGeneration);
    expect(
      await t.mutation(
        internal.github.internalMutation
          .recoverStaleInstallationWebhookAccessStateAttestation,
        {
          installationId,
          generation: staleGeneration,
          expectedRetryCount: 12,
          expectedFailure: "github_request",
          now: Date.now() + 1_000,
        },
      ),
    ).toBe(false);

    const installation = await t.run(async (ctx) =>
      ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) =>
          q.eq("installationId", installationId),
        )
        .unique(),
    );
    expect(installation?.accessSuspendedAt).toBe(currentGeneration);
    expect(installation?.webhookAccessStateAttestationGeneration).toBe(
      currentGeneration,
    );
  });

  it("leases a terminal attestation so recovery is scheduled only once", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const installationId = 331;
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, installationId);
    const generation = await beginWebhookAccessStateAttestation(
      t,
      installationId,
      { retryCount: 12 },
    );
    mockedGetGitHubInstallationAccessState.mockResolvedValue("unknown");
    await t.action(
      internal.github.action.reconcileInstallationWebhookAccessState,
      { installationId, expectedGeneration: generation, retryCount: 12 },
    );

    const staleAt = Date.now() - 16 * 60 * 1_000;
    await t.run(async (ctx) => {
      const installation = await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) =>
          q.eq("installationId", installationId),
        )
        .unique();
      if (!installation) throw new Error("installation not found");
      await ctx.db.patch(installation._id, {
        webhookAccessStateAttestationFailedAt: staleAt,
        webhookAccessStateAttestationNextAttemptAt: staleAt,
        updatedAt: staleAt,
      });
    });

    const scheduledBefore = await t.run(
      async (ctx) =>
        (await ctx.db.system.query("_scheduled_functions").collect()).filter(
          (job) =>
            job.state.kind === "pending" &&
            job.name ===
              "github/action:reconcileInstallationWebhookAccessState",
        ).length,
    );

    const first = await t.action(
      internal.github.action.recoverInstallationWebhookAccessStateAttestations,
      {},
    );
    const second = await t.action(
      internal.github.action.recoverInstallationWebhookAccessStateAttestations,
      {},
    );
    const scheduled = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (job) =>
          job.state.kind === "pending" &&
          job.name === "github/action:reconcileInstallationWebhookAccessState",
      ),
    );

    expect(first).toEqual({ checked: 1, scheduled: 1 });
    expect(second).toEqual({ checked: 0, scheduled: 0 });
    expect(scheduled).toHaveLength(scheduledBefore + 1);
    expect(
      scheduled.filter(
        (job) => (job.args[0] as { retryCount?: number }).retryCount === 0,
      ),
    ).toHaveLength(scheduledBefore + 1);
  });

  it("deletes local access only after GitHub confirms deletion", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const installationId = 326;
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, installationId);
    const repositoryId = await insertLinkedRepository(
      t,
      ownerId,
      installationId,
    );
    mockedGetGitHubInstallationAccessState.mockResolvedValue("deleted");

    const generation = await beginWebhookAccessStateAttestation(
      t,
      installationId,
    );
    await t.action(
      internal.github.action.reconcileInstallationWebhookAccessState,
      { installationId, expectedGeneration: generation, retryCount: 0 },
    );
    const deletionGeneration = await t.run(async (ctx) => {
      const installation = await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) =>
          q.eq("installationId", installationId),
        )
        .unique();
      return installation?.repositoryAccessRemovalGeneration;
    });
    if (deletionGeneration === undefined) {
      throw new Error("installation deletion did not start");
    }
    await t.mutation(
      internal.repositories.internalMutation.continueInstallationAccessRemoval,
      {
        installationId,
        generation: deletionGeneration,
        cursor: null,
        deleteInstallationAfterPause: true,
      },
    );

    const deleted = await t.run(async (ctx) => ({
      installation: await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) =>
          q.eq("installationId", installationId),
        )
        .first(),
      repository: await ctx.db.get(repositoryId),
    }));
    expect(deleted.installation).toBeNull();
    expect(deleted.repository).toMatchObject({
      isActive: false,
      githubAccessRevokedAt: expect.any(Number),
      githubInstallationReconnectRequired: true,
    });

    const owner = t.withIdentity({ subject: `${ownerId}|owner-session` });
    await expect(
      owner.query(api.repoIndexing.query.getIndexingStatus, { repositoryId }),
    ).resolves.toMatchObject({
      githubAccessRevoked: true,
      canRestoreGithubAccess: false,
      requiresReconnect: true,
      canReconnect: true,
      canRetry: false,
    });
    await expect(
      owner.query(api.repositories.query.getReconnectTarget, {
        reconnectRepositoryId: repositoryId,
      }),
    ).resolves.toMatchObject({
      repositoryId,
      githubRepositoryId: installationId + 1,
    });
  });

  it("starts unsuspension reconciliation with the exact suspension epoch", async () => {
    const runQuery = vi.fn(async () => ({
      ownerGithubAccountId: "654",
      ownershipVerifiedAt: 1,
      accessSuspendedAt: 77,
    }));
    const runMutation = vi.fn(async () => 88);
    const ctx = { runQuery, runMutation } as unknown as ActionCtx;

    await handleInstallationEvent(ctx, {
      action: "unsuspend",
      installation: { id: 321 },
    });

    expect(mockedGetInstallationToken).not.toHaveBeenCalled();
    expect(runMutation).toHaveBeenCalledOnce();
    expect(runMutation.mock.calls[0][1]).toEqual({
      installationId: 321,
      expectedAccessSuspendedAt: 77,
    });
  });

  it("does not clear suspension directly when reconciliation cannot start", async () => {
    const runQuery = vi.fn(async () => ({
      ownerGithubAccountId: "654",
      ownershipVerifiedAt: 1,
      accessSuspendedAt: 123,
    }));
    const runMutation = vi.fn(async () => null);
    const ctx = { runQuery, runMutation } as unknown as ActionCtx;

    await handleInstallationEvent(ctx, {
      action: "unsuspend",
      installation: { id: 321 },
    });

    expect(runMutation).toHaveBeenCalledOnce();
    expect(runMutation.mock.calls[0][1]).toEqual({
      installationId: 321,
      expectedAccessSuspendedAt: 123,
    });
  });

  it("binds the installation through the immutable OAuth account ID", async () => {
    const userId = "verified-user" as Id<"users">;
    const runQuery = vi.fn(async () => userId);
    const runMutation = vi.fn().mockResolvedValueOnce({
      status: "created" as const,
      installationId: "installation-document",
      accessSuspendedAt: null,
    });
    const ctx = { runQuery, runMutation } as unknown as ActionCtx;

    await handleInstallationEvent(ctx, {
      action: "created",
      installation: {
        id: 321,
        account: { login: "example-org", type: "Organization" },
        target_type: "Organization",
        permissions: { contents: "read" },
      },
      sender: { id: 654, login: "installer", type: "User" },
    });

    expect(runQuery).toHaveBeenCalledOnce();
    expect(runQuery.mock.calls[0][1]).toEqual({ githubAccountId: "654" });
    expect(runMutation).toHaveBeenCalledOnce();
    expect(runMutation.mock.calls[0][1]).toEqual({
      userId,
      installationId: 321,
      accountLogin: "example-org",
      accountType: "Organization",
      targetType: "Organization",
      permissions: { contents: "read" },
      ownerGithubAccountId: "654",
      startRepositoryAccessReconciliation: true,
    });
    expect(mockedGetInstallationToken).not.toHaveBeenCalled();
  });

  it("defers optional webhook repositories to one durable reconciliation", async () => {
    const userId = "verified-user" as Id<"users">;
    const runQuery = vi.fn(async () => userId);
    const runMutation = vi.fn().mockResolvedValueOnce({
      status: "created" as const,
      installationId: "installation-document",
      accessSuspendedAt: null,
    });
    const ctx = { runQuery, runMutation } as unknown as ActionCtx;

    await handleInstallationEvent(ctx, {
      action: "created",
      installation: {
        id: 321,
        account: { login: "example-org", type: "Organization" },
        target_type: "Organization",
        permissions: { contents: "read" },
      },
      sender: { id: 654, login: "installer", type: "User" },
      repositories: [{ id: 9999, full_name: "untrusted/payload-repo" }],
    });

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(runMutation).toHaveBeenCalledOnce();
    expect(runMutation.mock.calls[0][1]).toMatchObject({
      installationId: 321,
      startRepositoryAccessReconciliation: true,
    });
  });

  it("fails closed when the signed sender identity is missing", async () => {
    const runQuery = vi.fn();
    const runMutation = vi.fn();
    const ctx = { runQuery, runMutation } as unknown as ActionCtx;

    await handleInstallationEvent(ctx, {
      action: "created",
      installation: {
        id: 321,
        account: { login: "example-org", type: "Organization" },
        target_type: "Organization",
        permissions: { contents: "read" },
      },
    });

    expect(runQuery).not.toHaveBeenCalled();
    expect(runMutation).not.toHaveBeenCalled();
  });

  it("recovers an unknown installation from a signed repository access change", async () => {
    const userId = "verified-user" as Id<"users">;
    const runQuery = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(userId);
    const runMutation = vi.fn(async () => ({
      status: "created" as const,
      installationId: "installation-document",
      accessSuspendedAt: null,
    }));
    const ctx = { runQuery, runMutation } as unknown as ActionCtx;

    await handleInstallationRepositoriesEvent(ctx, {
      ...installationRepositoriesPayload(),
      repositories_added: [
        {
          id: 999,
          name: "repo",
          full_name: "example-org/repo",
          owner: {
            id: 987,
            login: "example-org",
            type: "Organization",
          },
        },
      ],
    });

    expect(runQuery).toHaveBeenCalledTimes(2);
    expect(runQuery.mock.calls[0][1]).toEqual({ installationId: 321 });
    expect(runQuery.mock.calls[1][1]).toEqual({ githubAccountId: "654" });
    expect(runMutation).toHaveBeenCalledOnce();
    expect(runMutation.mock.calls[0][1]).toEqual({
      userId,
      installationId: 321,
      accountLogin: "example-org",
      accountType: "Organization",
      targetType: "Organization",
      permissions: { contents: "read" },
      ownerGithubAccountId: "654",
      startRepositoryAccessReconciliation: true,
    });
  });

  it("recovers an unknown installation from a signed repository removal", async () => {
    const userId = "verified-user" as Id<"users">;
    const runQuery = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(userId);
    const runMutation = vi.fn(async () => ({
      status: "created" as const,
      installationId: "installation-document",
      accessSuspendedAt: null,
    }));
    const ctx = { runQuery, runMutation } as unknown as ActionCtx;

    await handleInstallationRepositoriesEvent(ctx, {
      ...installationRepositoriesPayload(),
      action: "removed",
      repositories_added: [],
      repositories_removed: [
        {
          id: 999,
          name: "repo",
          full_name: "example-org/repo",
          owner: {
            id: 987,
            login: "example-org",
            type: "Organization",
          },
        },
      ],
    });

    expect(runQuery).toHaveBeenCalledTimes(2);
    expect(runMutation).toHaveBeenCalledOnce();
    expect(runMutation.mock.calls[0][1]).toMatchObject({
      userId,
      installationId: 321,
      ownerGithubAccountId: "654",
      startRepositoryAccessReconciliation: true,
    });
  });

  it("does not recover an unknown installation without a matching OAuth account", async () => {
    const runQuery = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    const runMutation = vi.fn();
    const ctx = { runQuery, runMutation } as unknown as ActionCtx;

    await handleInstallationRepositoriesEvent(ctx, {
      ...installationRepositoriesPayload(),
      repositories_added: [
        {
          id: 999,
          name: "repo",
          full_name: "example-org/repo",
          owner: {
            id: 987,
            login: "example-org",
            type: "Organization",
          },
        },
      ],
    });

    expect(runQuery).toHaveBeenCalledTimes(2);
    expect(runMutation).not.toHaveBeenCalled();
  });

  it("does not recover from repository metadata owned by another account", async () => {
    const runQuery = vi.fn(async () => null);
    const runMutation = vi.fn();
    const ctx = { runQuery, runMutation } as unknown as ActionCtx;

    await handleInstallationRepositoriesEvent(ctx, {
      ...installationRepositoriesPayload(),
      repositories_added: [
        {
          id: 999,
          name: "repo",
          full_name: "other-org/repo",
          owner: {
            id: 123,
            login: "other-org",
            type: "Organization",
          },
        },
      ],
    });

    expect(runQuery).toHaveBeenCalledOnce();
    expect(runMutation).not.toHaveBeenCalled();
  });

  it("does not recover without GitHub repository selection metadata", async () => {
    const runQuery = vi.fn(async () => null);
    const runMutation = vi.fn();
    const ctx = { runQuery, runMutation } as unknown as ActionCtx;
    const payload = installationRepositoriesPayload();
    delete (payload as { repository_selection?: string }).repository_selection;

    await handleInstallationRepositoriesEvent(ctx, payload);

    expect(runQuery).toHaveBeenCalledOnce();
    expect(runMutation).not.toHaveBeenCalled();
  });

  it("rejects invalid installation repository sender metadata", async () => {
    const runQuery = vi.fn();
    const runMutation = vi.fn();
    const ctx = { runQuery, runMutation } as unknown as ActionCtx;

    await handleInstallationRepositoriesEvent(
      ctx,
      installationRepositoriesPayload({
        id: 654,
        login: "installer",
        type: "Organization",
      }),
    );

    expect(runQuery).not.toHaveBeenCalled();
    expect(runMutation).not.toHaveBeenCalled();
  });

  it("delegates deletion gating and scheduling to one mutation", async () => {
    const runMutation = vi.fn(async () => 91);
    const runAfter = vi.fn(async () => undefined);
    const ctx = {
      runMutation,
      scheduler: { runAfter },
    } as unknown as ActionCtx;

    await handleInstallationEvent(ctx, {
      action: "deleted",
      installation: { id: 321 },
    });

    expect(runMutation).toHaveBeenCalledWith(
      internal.github.internalMutation
        .beginInstallationWebhookAccessStateAttestation,
      { installationId: 321 },
    );
    expect(runAfter).not.toHaveBeenCalled();
  });

  it("fails closed when an installation deletion has no valid numeric ID", async () => {
    const runQuery = vi.fn();
    const runMutation = vi.fn();
    const ctx = { runQuery, runMutation } as unknown as ActionCtx;

    await handleInstallationEvent(ctx, {
      action: "deleted",
      installation: { id: "not-a-number" },
    });

    expect(runQuery).not.toHaveBeenCalled();
    expect(runMutation).not.toHaveBeenCalled();
  });

  it("resolves users only from verified GitHub auth accounts", async () => {
    const t = convexTest(schema, modules);
    const { verifiedUserId, profileOnlyUserId } = await t.run(async (ctx) => {
      const verifiedUserId = await ctx.db.insert("users", {});
      const profileOnlyUserId = await ctx.db.insert("users", {});
      await ctx.db.insert("authAccounts", {
        userId: verifiedUserId,
        provider: "github",
        providerAccountId: "654",
      });
      await ctx.db.insert("userProfiles", {
        userId: profileOnlyUserId,
        githubUsername: "example-org",
        createdAt: 1,
        updatedAt: 1,
      });
      return { verifiedUserId, profileOnlyUserId };
    });

    const verified = await t.query(
      internal.github.internalQuery.getUserIdByGithubAccountId,
      { githubAccountId: "654" },
    );
    const profileOnly = await t.query(
      internal.github.internalQuery.getUserIdByGithubAccountId,
      { githubAccountId: "999" },
    );

    expect(verified).toBe(verifiedUserId);
    expect(profileOnly).toBeNull();
    expect(profileOnly).not.toBe(profileOnlyUserId);
  });

  it("fails closed for duplicate or dangling GitHub auth accounts", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const firstUserId = await ctx.db.insert("users", {});
      const secondUserId = await ctx.db.insert("users", {});
      const deletedUserId = await ctx.db.insert("users", {});
      await ctx.db.insert("authAccounts", {
        userId: firstUserId,
        provider: "github",
        providerAccountId: "duplicate-account",
      });
      await ctx.db.insert("authAccounts", {
        userId: secondUserId,
        provider: "github",
        providerAccountId: "duplicate-account",
      });
      await ctx.db.insert("authAccounts", {
        userId: deletedUserId,
        provider: "github",
        providerAccountId: "dangling-account",
      });
      await ctx.db.delete(deletedUserId);
    });

    await expect(
      t.query(internal.github.internalQuery.getUserIdByGithubAccountId, {
        githubAccountId: "duplicate-account",
      }),
    ).resolves.toBeNull();
    await expect(
      t.query(internal.github.internalQuery.getUserIdByGithubAccountId, {
        githubAccountId: "dangling-account",
      }),
    ).resolves.toBeNull();
  });

  it("fails explicitly when a user installation read exceeds its bound", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      for (let index = 0; index <= 500; index++) {
        await ctx.db.insert("githubInstallations", {
          userId,
          installationId: index + 1,
          ownerGithubAccountId: `github-account-${index}`,
          ownershipVerifiedAt: 1,
          accountLogin: `account-${index}`,
          accountType: "Organization",
          targetType: "Organization",
          createdAt: 1,
          updatedAt: 1,
        });
      }
      return userId;
    });

    await expect(
      t
        .withIdentity({ subject: `${userId}|test-session` })
        .query(api.github.query.getUserInstallations, {}),
    ).rejects.toThrow("GitHub App installation limit exceeded");
  });
});
