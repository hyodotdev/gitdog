import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockedFunction } from "vitest";

import { internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { ActionCtx } from "../../../convex/_generated/server";
import * as githubHelpers from "../../../convex/github/helpers";
import {
  handleInstallationRepositoriesEvent,
  handleRepositoryEvent,
} from "../../../convex/github/webhook";
import schema from "../../../convex/schema";

let mockedFetchGitHubAppJsonWithRetry: MockedFunction<
  typeof githubHelpers.fetchGitHubAppJsonWithRetry
>;
let mockedRepositoryToken: MockedFunction<
  typeof githubHelpers.getRepositoryInstallationToken
>;
const originalAppId = process.env.GITHUB_APP_ID;
const originalPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY;

beforeEach(() => {
  process.env.GITHUB_APP_ID = "test-app-id";
  process.env.GITHUB_APP_PRIVATE_KEY = "test-private-key";
  mockedRepositoryToken = vi
    .spyOn(githubHelpers, "getRepositoryInstallationToken")
    .mockResolvedValue("installation-token");
  mockedFetchGitHubAppJsonWithRetry = vi
    .spyOn(githubHelpers, "fetchGitHubAppJsonWithRetry")
    .mockResolvedValue({
      id: 654,
      full_name: "owner/new-name",
      visibility: "public",
      license: { key: "mit", spdx_id: "MIT" },
    });
  vi.spyOn(githubHelpers, "getIssueComments").mockResolvedValue([]);
  vi.spyOn(githubHelpers, "getDiscussionComments").mockResolvedValue([]);
  vi.spyOn(githubHelpers, "getRepositoryMaintainers").mockResolvedValue([]);
});

afterEach(() => {
  if (originalAppId === undefined) delete process.env.GITHUB_APP_ID;
  else process.env.GITHUB_APP_ID = originalAppId;
  if (originalPrivateKey === undefined)
    delete process.env.GITHUB_APP_PRIVATE_KEY;
  else process.env.GITHUB_APP_PRIVATE_KEY = originalPrivateKey;
  vi.restoreAllMocks();
});

type StoredRepository = {
  _id: Id<"repositories">;
  userId: Id<"users">;
  installationId: number;
  githubRepositoryId: number;
  githubRepo: string;
  githubVisibility?: "public" | "private" | "internal";
  licenseKey?: string;
  licenseSpdxId?: string;
  licenseOsiApproved?: boolean;
  licenseOsiCheckedAt?: number;
  repositoryMetadataCheckedAt?: number;
};

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/repositories/internalMutation.ts": () =>
    import("../../../convex/repositories/internalMutation"),
  "../../../convex/repositories/internalQuery.ts": () =>
    import("../../../convex/repositories/internalQuery"),
};

function createEligibleRepository(
  overrides: Partial<StoredRepository> = {},
): StoredRepository {
  return {
    _id: "repository-id" as Id<"repositories">,
    userId: "user-id" as Id<"users">,
    installationId: 321,
    githubRepositoryId: 654,
    githubRepo: "owner/repo",
    githubVisibility: "public",
    licenseKey: "mit",
    licenseSpdxId: "MIT",
    licenseOsiApproved: true,
    licenseOsiCheckedAt: 90,
    repositoryMetadataCheckedAt: 100,
    ...overrides,
  };
}

function createActionContext(repository: StoredRepository | null) {
  const runQuery = vi
    .fn()
    .mockResolvedValueOnce({ userId: repository?.userId })
    .mockResolvedValueOnce(repository);
  const runMutation = vi.fn(
    async (_functionReference: unknown, _args: Record<string, unknown>) => ({
      persisted: true,
      identityUpdated: true,
      paused: false,
    }),
  );

  return {
    ctx: { runQuery, runMutation } as unknown as ActionCtx,
    runQuery,
    runMutation,
  };
}

function createPayload(repository: Record<string, unknown>) {
  return {
    action: "edited",
    installation: { id: 321 },
    repository: {
      id: 654,
      full_name: "owner/repo",
      ...repository,
    },
  };
}

async function insertRepository(
  t: ReturnType<typeof convexTest>,
  installationId: number,
  githubRepo: string,
): Promise<Id<"repositories">> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const now = Date.now();
    return await ctx.db.insert("repositories", {
      indexSyncPending: false,
      indexVersion: 1,
      indexStatus: "completed",
      indexProgressAt: Date.now(),
      ragStatus: "completed",
      ragTotalChunks: 0,
      ragIndexedChunks: 0,
      ragFailedChunks: 0,
      userId,
      installationId,
      githubRepositoryId: 654,
      githubRepo,
      githubRepoKey: githubRepo.toLowerCase(),
      name: githubRepo.split("/").pop() ?? githubRepo,
      githubUrl: `https://github.com/${githubRepo}`,
      githubVisibility: "public",
      licenseKey: "mit",
      licenseSpdxId: "MIT",
      licenseOsiApproved: true,
      licenseOsiCheckedAt: now,
      repositoryMetadataCheckedAt: now,
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
  });
}

async function insertVerifiedInstallationForRepository(
  t: ReturnType<typeof convexTest>,
  repositoryId: Id<"repositories">,
  installationId: number,
): Promise<void> {
  await t.run(async (ctx) => {
    const repository = await ctx.db.get(repositoryId);
    if (!repository) {
      throw new Error("Repository fixture missing");
    }
    const now = Date.now();
    await ctx.db.insert("githubInstallations", {
      userId: repository.userId,
      installationId,
      ownerGithubAccountId: "verified-owner",
      ownershipVerifiedAt: now,
      accountLogin: "owner",
      accountType: "Organization",
      targetType: "Organization",
      createdAt: now,
      updatedAt: now,
    });
  });
}

describe("repository webhook embedding policy", () => {
  it.each([
    {
      label: "private visibility",
      metadata: {
        visibility: "private",
        license: { key: "mit", spdx_id: "MIT" },
      },
      expected: {
        githubVisibility: "private",
        licenseKey: "mit",
        licenseSpdxId: "MIT",
      },
    },
    {
      label: "internal visibility",
      metadata: {
        visibility: "internal",
        license: { key: "mit", spdx_id: "MIT" },
      },
      expected: {
        githubVisibility: "internal",
        licenseKey: "mit",
        licenseSpdxId: "MIT",
      },
    },
    {
      label: "missing license metadata",
      metadata: { visibility: "public" },
      expected: {
        githubVisibility: "public",
        licenseKey: null,
        licenseSpdxId: null,
      },
    },
    {
      label: "missing visibility metadata",
      metadata: { license: { key: "mit", spdx_id: "MIT" } },
      expected: {
        githubVisibility: null,
        licenseKey: "mit",
        licenseSpdxId: "MIT",
      },
    },
    {
      label: "non-concrete license metadata",
      metadata: {
        visibility: "public",
        license: { key: "other", spdx_id: "NOASSERTION" },
      },
      expected: {
        githubVisibility: "public",
        licenseKey: "other",
        licenseSpdxId: "NOASSERTION",
      },
    },
    {
      label: "changed SPDX license",
      metadata: {
        visibility: "public",
        license: { key: "apache-2.0", spdx_id: "Apache-2.0" },
      },
      expected: {
        githubVisibility: "public",
        licenseKey: "apache-2.0",
        licenseSpdxId: "Apache-2.0",
      },
    },
  ])("revises cached free eligibility for $label", async (testCase) => {
    const { ctx, runQuery, runMutation } = createActionContext(
      createEligibleRepository(),
    );

    await handleRepositoryEvent(ctx, createPayload(testCase.metadata));

    expect(runQuery).toHaveBeenCalledTimes(2);
    expect(runQuery.mock.calls[1][1]).toEqual({
      installationId: 321,
      githubRepositoryId: 654,
    });
    expect(runMutation).toHaveBeenCalledOnce();
    expect(runMutation.mock.calls[0][1]).toEqual({
      repositoryId: "repository-id",
      expectedGithubRepo: "owner/repo",
      githubRepositoryId: 654,
      installationId: 321,
      githubRepo: "owner/repo",
      ...testCase.expected,
    });
  });

  it("fail-closes matching public metadata until live policy is reverified", async () => {
    const { ctx, runMutation } = createActionContext(
      createEligibleRepository(),
    );

    await handleRepositoryEvent(
      ctx,
      createPayload({
        visibility: "public",
        license: { key: "mit", spdx_id: "MIT" },
      }),
    );

    expect(runMutation).toHaveBeenCalledOnce();
  });

  it("revises metadata even when the cached row is already unverified", async () => {
    const { ctx, runMutation } = createActionContext(
      createEligibleRepository({ licenseOsiApproved: false }),
    );

    await handleRepositoryEvent(
      ctx,
      createPayload({
        visibility: "public",
        license: { key: "mit", spdx_id: "MIT" },
      }),
    );

    expect(runMutation).toHaveBeenCalledOnce();
  });

  it("locates a renamed repository by immutable GitHub identity", async () => {
    const { ctx, runQuery, runMutation } = createActionContext(
      createEligibleRepository({ githubRepo: "owner/old-name" }),
    );

    await handleRepositoryEvent(ctx, {
      ...createPayload({
        full_name: "owner/new-name",
        visibility: "public",
        license: { key: "mit", spdx_id: "MIT" },
      }),
      action: "renamed",
      changes: { repository: { name: { from: "old-name" } } },
    });

    expect(runQuery).toHaveBeenCalledTimes(2);
    expect(runMutation.mock.calls[0][1]).toMatchObject({
      expectedGithubRepo: "owner/old-name",
      githubRepositoryId: 654,
      githubRepo: "owner/new-name",
      previousGithubRepo: "owner/old-name",
      liveIdentityVerified: true,
    });
    expect(mockedFetchGitHubAppJsonWithRetry).toHaveBeenCalledOnce();
    expect(mockedRepositoryToken).toHaveBeenCalledWith(
      321,
      654,
      "test-app-id",
      "test-private-key",
    );
  });

  it("fails closed when a renamed public repository is no longer selected for the installation", async () => {
    const repository = createEligibleRepository({
      githubRepo: "owner/old-name",
    });
    const runQuery = vi.fn(async () => ({ userId: repository.userId }));
    const runMutation = vi.fn(async () => 123);
    const ctx = { runQuery, runMutation } as unknown as ActionCtx;
    mockedRepositoryToken.mockRejectedValueOnce(
      new Error("Repository is not selected for this installation"),
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      handleRepositoryEvent(ctx, {
        ...createPayload({
          full_name: "owner/new-name",
          visibility: "public",
          license: { key: "mit", spdx_id: "MIT" },
        }),
        action: "renamed",
        changes: { repository: { name: { from: "old-name" } } },
      }),
    ).rejects.toThrow("Repository is not selected for this installation");

    expect(mockedRepositoryToken).toHaveBeenCalledWith(
      321,
      654,
      "test-app-id",
      "test-private-key",
    );
    expect(mockedFetchGitHubAppJsonWithRetry).not.toHaveBeenCalled();
    expect(runMutation).toHaveBeenCalledWith(expect.anything(), {
      installationId: 321,
      expectedAccessSuspendedAt: null,
    });
  });

  it("durably reconciles and rejects when live rename identity fetch is transiently unavailable", async () => {
    const repository = createEligibleRepository({
      githubRepo: "owner/old-name",
    });
    const runQuery = vi.fn(async () => ({ userId: repository.userId }));
    const runMutation = vi.fn(async () => 123);
    const ctx = { runQuery, runMutation } as unknown as ActionCtx;
    mockedFetchGitHubAppJsonWithRetry.mockRejectedValueOnce(
      new Error("GitHub temporarily unavailable"),
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      handleRepositoryEvent(ctx, {
        ...createPayload({
          full_name: "owner/new-name",
          visibility: "public",
          license: { key: "mit", spdx_id: "MIT" },
        }),
        action: "renamed",
        changes: { repository: { name: { from: "old-name" } } },
      }),
    ).rejects.toThrow("GitHub temporarily unavailable");

    expect(runQuery).toHaveBeenCalledOnce();
    expect(runMutation).toHaveBeenCalledOnce();
    expect(runMutation.mock.calls[0][1]).toEqual({
      installationId: 321,
      expectedAccessSuspendedAt: null,
    });
  });
});

describe("repository webhook embedding persistence", () => {
  it("locates repositories by immutable GitHub identity", async () => {
    const t = convexTest(schema, modules);
    const firstId = await insertRepository(t, 111, "owner/old-name");
    const secondId = await insertRepository(t, 222, "new-owner/new-name");

    const repositories = await t.query(
      internal.repositories.internalQuery.listByGitHubRepositoryId,
      { githubRepositoryId: 654 },
    );

    expect(repositories.map((repository) => repository._id)).toEqual([
      firstId,
      secondId,
    ]);
  });

  it("rejects a stale downgrade after a newer metadata refresh", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, 321, "owner/repo");
    await insertVerifiedInstallationForRepository(t, repositoryId, 321);
    const originalRepository = await t.run(async (ctx) =>
      ctx.db.get(repositoryId),
    );
    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, {
        licenseOsiApproved: true,
        repositoryMetadataCheckedAt: Date.now() + 10_000,
      });
    });

    const persisted = await t.mutation(
      internal.repositories.internalMutation.downgradeEmbeddingPolicyMetadata,
      {
        repositoryId,
        expectedMetadataCheckedAt:
          originalRepository?.repositoryMetadataCheckedAt,
        expectedInstallationId: 321,
        expectedGithubRepositoryId: 654,
        expectedGithubRepo: "owner/repo",
        githubVisibility: "private",
        licenseKey: "mit",
        licenseSpdxId: "MIT",
      },
    );
    const repository = await t.run(async (ctx) => {
      return await ctx.db.get(repositoryId);
    });

    expect(persisted).toBeNull();
    expect(repository).toMatchObject({
      githubVisibility: "public",
      licenseKey: "mit",
      licenseSpdxId: "MIT",
      licenseOsiApproved: true,
    });
    expect(repository?.licenseOsiCheckedAt).toBeDefined();
  });

  it("clears omitted metadata while applying the fail-closed downgrade", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, 321, "owner/repo");
    await insertVerifiedInstallationForRepository(t, repositoryId, 321);
    const originalRepository = await t.run(async (ctx) =>
      ctx.db.get(repositoryId),
    );

    const persistedRevision = await t.mutation(
      internal.repositories.internalMutation.downgradeEmbeddingPolicyMetadata,
      {
        repositoryId,
        expectedMetadataCheckedAt:
          originalRepository?.repositoryMetadataCheckedAt,
        expectedInstallationId: 321,
        expectedGithubRepositoryId: 654,
        expectedGithubRepo: "owner/repo",
        githubVisibility: null,
        licenseKey: null,
        licenseSpdxId: null,
      },
    );
    const repository = await t.run(async (ctx) => {
      return await ctx.db.get(repositoryId);
    });

    expect(persistedRevision).toBe(repository?.repositoryMetadataCheckedAt);
    expect(repository?.githubVisibility).toBeUndefined();
    expect(repository?.licenseKey).toBeUndefined();
    expect(repository?.licenseSpdxId).toBeUndefined();
    expect(repository?.licenseOsiApproved).toBe(false);
    expect(repository?.licenseOsiCheckedAt).toBeUndefined();
  });

  it.each(["inactive", "revoked", "installation_mismatch", "id_mismatch"])(
    "does not mutate metadata for an ineligible repository: %s",
    async (scenario) => {
      const t = convexTest(schema, modules);
      const repositoryId = await insertRepository(t, 321, "owner/repo");
      await insertVerifiedInstallationForRepository(t, repositoryId, 321);
      await t.run(async (ctx) => {
        if (scenario === "inactive") {
          await ctx.db.patch(repositoryId, { isActive: false });
        } else if (scenario === "revoked") {
          await ctx.db.patch(repositoryId, {
            githubAccessRevokedAt: Date.now(),
          });
        }
      });
      const before = await t.run(async (ctx) => await ctx.db.get(repositoryId));

      const result = await t.mutation(
        internal.repositories.internalMutation.downgradeEmbeddingPolicyMetadata,
        {
          repositoryId,
          expectedMetadataCheckedAt: before?.repositoryMetadataCheckedAt,
          expectedInstallationId:
            scenario === "installation_mismatch" ? 999 : 321,
          expectedGithubRepositoryId: scenario === "id_mismatch" ? 999 : 654,
          expectedGithubRepo: "owner/repo",
          githubVisibility: "private",
          licenseKey: null,
          licenseSpdxId: null,
        },
      );
      const after = await t.run(async (ctx) => await ctx.db.get(repositoryId));

      expect(result).toBeNull();
      expect(after).toMatchObject({
        githubVisibility: before?.githubVisibility,
        licenseKey: before?.licenseKey,
        licenseSpdxId: before?.licenseSpdxId,
        licenseOsiApproved: before?.licenseOsiApproved,
        licenseOsiCheckedAt: before?.licenseOsiCheckedAt,
        repositoryMetadataCheckedAt: before?.repositoryMetadataCheckedAt,
      });
    },
  );

  it("pauses and invalidates active free-policy work after access removal", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, 321, "owner/repo");
    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, {
        indexVersion: 3,
        indexStatus: "indexing",
        ragStatus: "indexing",
        ragEmbeddingBillingTier: "free",
      });
    });

    expect(
      await t.mutation(
        internal.repositories.internalMutation
          .pauseRepositoryAfterAccessRemoval,
        {
          installationId: 321,
          githubRepositoryId: 654,
        },
      ),
    ).toBe(1);
    const repository = await t.run(async (ctx) => ctx.db.get(repositoryId));

    expect(repository).toMatchObject({
      isActive: false,
      indexVersion: 4,
      indexStatus: "failed",
      ragStatus: "failed",
      licenseOsiApproved: false,
    });
    expect(repository?.ragEmbeddingBillingTier).toBeUndefined();
    expect(repository?.licenseOsiCheckedAt).toBeUndefined();
  });

  it("pauses every duplicate row for one removed immutable identity", async () => {
    const t = convexTest(schema, modules);
    const firstRepositoryId = await insertRepository(t, 321, "owner/first");
    const secondRepositoryId = await insertRepository(t, 321, "owner/second");

    await expect(
      t.mutation(
        internal.repositories.internalMutation
          .pauseRepositoryAfterAccessRemoval,
        { installationId: 321, githubRepositoryId: 654 },
      ),
    ).resolves.toBe(2);
    const repositories = await t.run(async (ctx) =>
      Promise.all([
        ctx.db.get(firstRepositoryId),
        ctx.db.get(secondRepositoryId),
      ]),
    );

    expect(
      repositories.every(
        (repository) =>
          repository?.isActive === false &&
          repository.githubAccessRevokedAt !== undefined,
      ),
    ).toBe(true);
  });

  it("scopes immutable-ID access removal to one installation even with many matching rows", async () => {
    const t = convexTest(schema, modules);
    const targetId = await insertRepository(t, 321, "owner/repo");
    const unrelatedIds: Array<Id<"repositories">> = [];
    for (let index = 0; index < 25; index += 1) {
      unrelatedIds.push(
        await insertRepository(t, 1_000 + index, `other-${index}/repo`),
      );
    }

    expect(
      await t.mutation(
        internal.repositories.internalMutation
          .pauseRepositoryAfterAccessRemoval,
        { installationId: 321, githubRepositoryId: 654 },
      ),
    ).toBe(1);
    const state = await t.run(async (ctx) => ({
      target: await ctx.db.get(targetId),
      unrelated: await Promise.all(
        unrelatedIds.map(
          async (repositoryId) => await ctx.db.get(repositoryId),
        ),
      ),
    }));

    expect(state.target?.githubAccessRevokedAt).toEqual(expect.any(Number));
    expect(
      state.unrelated.every(
        (repository) => repository?.githubAccessRevokedAt === undefined,
      ),
    ).toBe(true);
  });

  it("stops a stale suspension page after the installation is reactivated", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, 321, "owner/repo");
    await t.run(async (ctx) => {
      const repository = await ctx.db.get(repositoryId);
      if (!repository) {
        throw new Error("Repository fixture missing");
      }
      await ctx.db.insert("githubInstallations", {
        userId: repository.userId,
        installationId: 321,
        ownerGithubAccountId: "654",
        ownershipVerifiedAt: 1,
        accountLogin: "owner",
        accountType: "Organization",
        targetType: "Organization",
        repositoryAccessRemovalGeneration: 10,
        repositoryAccessRemovalCursor: null,
        repositoryAccessRemovalDeleteInstallation: false,
        repositoryAccessRemovalPhase: "pausing",
        createdAt: 1,
        updatedAt: 20,
      });
    });

    const result = await t.mutation(
      internal.repositories.internalMutation.continueInstallationAccessRemoval,
      {
        installationId: 321,
        generation: 10,
        cursor: null,
      },
    );
    const repository = await t.run(async (ctx) => ctx.db.get(repositoryId));

    expect(result).toEqual({ paused: 0, complete: true, stale: true });
    expect(repository?.githubAccessRevokedAt).toBeUndefined();
  });

  it("never uses a mutable-name fallback for a conflicting pinned identity", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, 321, "owner/repo");

    expect(
      await t.mutation(
        internal.repositories.internalMutation
          .pauseRepositoryAfterAccessRemoval,
        {
          installationId: 321,
          githubRepositoryId: 999,
        },
      ),
    ).toBe(0);
    const repository = await t.run(async (ctx) => ctx.db.get(repositoryId));
    expect(repository?.githubAccessRevokedAt).toBeUndefined();
  });

  it("restores the active state that existed before repeated access removal", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, 321, "owner/repo");
    await t.run(async (ctx) => {
      const repository = await ctx.db.get(repositoryId);
      if (!repository) {
        throw new Error("repository missing");
      }
      await ctx.db.insert("githubInstallations", {
        userId: repository.userId,
        installationId: 321,
        ownerGithubAccountId: "verified-owner",
        ownershipVerifiedAt: 1,
        accountLogin: "owner",
        accountType: "Organization",
        targetType: "Organization",
        createdAt: 1,
        updatedAt: 1,
      });
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await t.mutation(
        internal.repositories.internalMutation
          .pauseRepositoryAfterAccessRemoval,
        {
          installationId: 321,
          githubRepositoryId: 654,
        },
      );
    }
    const restored = await t.mutation(
      internal.repositories.internalMutation.restoreRepositoryAfterAccessAdded,
      {
        installationId: 321,
        githubRepositoryId: 654,
        githubRepo: "owner/repo",
      },
    );
    const retried = await t.mutation(
      internal.repositories.internalMutation.restoreRepositoryAfterAccessAdded,
      {
        installationId: 321,
        githubRepositoryId: 654,
        githubRepo: "owner/repo",
      },
    );
    const repository = await t.run(async (ctx) => ctx.db.get(repositoryId));

    expect(restored).toEqual([repositoryId]);
    expect(retried).toEqual([repositoryId]);
    expect(repository).toMatchObject({ isActive: true });
    expect(repository?.githubAccessRevokedAt).toBeUndefined();
    expect(repository?.isActiveBeforeAccessRevocation).toBeUndefined();
  });

  it("keeps a manually paused repository paused after access returns", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, 321, "owner/repo");
    await t.run(async (ctx) => {
      const repository = await ctx.db.get(repositoryId);
      if (!repository) {
        throw new Error("repository missing");
      }
      await ctx.db.patch(repositoryId, { isActive: false });
      await ctx.db.insert("githubInstallations", {
        userId: repository.userId,
        installationId: 321,
        ownerGithubAccountId: "verified-owner",
        ownershipVerifiedAt: 1,
        accountLogin: "owner",
        accountType: "Organization",
        targetType: "Organization",
        createdAt: 1,
        updatedAt: 1,
      });
    });

    await t.mutation(
      internal.repositories.internalMutation.pauseRepositoryAfterAccessRemoval,
      {
        installationId: 321,
        githubRepositoryId: 654,
      },
    );
    const restored = await t.mutation(
      internal.repositories.internalMutation.restoreRepositoryAfterAccessAdded,
      {
        installationId: 321,
        githubRepositoryId: 654,
        githubRepo: "owner/repo",
      },
    );
    const repository = await t.run(async (ctx) => ctx.db.get(repositoryId));

    expect(restored).toEqual([]);
    expect(repository).toMatchObject({ isActive: false });
    expect(repository?.githubAccessRevokedAt).toBeUndefined();
    expect(repository?.isActiveBeforeAccessRevocation).toBeUndefined();
  });

  it("never restores a repository through another installation owner's identity", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, 321, "owner/repo");
    await t.mutation(
      internal.repositories.internalMutation.pauseRepositoryAfterAccessRemoval,
      {
        installationId: 321,
        githubRepositoryId: 654,
      },
    );
    await t.run(async (ctx) => {
      const otherUserId = await ctx.db.insert("users", {});
      await ctx.db.insert("githubInstallations", {
        userId: otherUserId,
        installationId: 999,
        ownerGithubAccountId: "other-owner",
        ownershipVerifiedAt: 1,
        accountLogin: "other-owner",
        accountType: "Organization",
        targetType: "Organization",
        createdAt: 1,
        updatedAt: 1,
      });
    });

    const restored = await t.mutation(
      internal.repositories.internalMutation.restoreRepositoryAfterAccessAdded,
      {
        installationId: 999,
        githubRepositoryId: 654,
        githubRepo: "owner/repo",
      },
    );
    const repository = await t.run(async (ctx) => ctx.db.get(repositoryId));

    expect(restored).toEqual([]);
    expect(repository?.githubAccessRevokedAt).toEqual(expect.any(Number));
  });

  it("keeps C after true out-of-order A-to-B and B-to-C rename delivery", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, 321, "owner/name-a");
    await insertVerifiedInstallationForRepository(t, repositoryId, 321);

    const newerResult = await t.mutation(
      internal.repositories.internalMutation.applyRepositoryWebhookUpdate,
      {
        repositoryId,
        expectedGithubRepo: "owner/name-a",
        githubRepositoryId: 654,
        installationId: 321,
        githubRepo: "owner/name-c",
        previousGithubRepo: "owner/name-b",
        liveIdentityVerified: true,
        githubVisibility: "private",
        licenseKey: null,
        licenseSpdxId: null,
      },
    );
    const olderResult = await t.mutation(
      internal.repositories.internalMutation.applyRepositoryWebhookUpdate,
      {
        repositoryId,
        expectedGithubRepo: "owner/name-c",
        githubRepositoryId: 654,
        installationId: 321,
        githubRepo: "owner/name-c",
        previousGithubRepo: "owner/name-a",
        liveIdentityVerified: true,
        githubVisibility: "private",
        licenseKey: null,
        licenseSpdxId: null,
      },
    );
    const repository = await t.run(async (ctx) => ctx.db.get(repositoryId));

    expect(newerResult).toEqual({
      persisted: true,
      identityUpdated: true,
      paused: false,
    });
    expect(olderResult.persisted).toBe(true);
    expect(repository).toMatchObject({
      installationId: 321,
      githubRepositoryId: 654,
      githubRepo: "owner/name-c",
      name: "name-c",
      githubUrl: "https://github.com/owner/name-c",
      githubVisibility: "private",
      licenseOsiApproved: false,
    });
  });
});

describe("installation repository access webhooks", () => {
  const verifiedInstallation = {
    userId: "user-id" as Id<"users">,
    ownerGithubAccountId: "654",
    ownershipVerifiedAt: 1,
  };

  function installationRepositoriesPayload(
    action: "added" | "removed",
    repositories: Record<string, unknown>,
  ) {
    return {
      action,
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
      sender: { id: 654, login: "installer", type: "User" },
      ...repositories,
    };
  }

  it("ignores an old repository deletion after the repository is restored", async () => {
    const repository = createEligibleRepository();
    const runMutation = vi.fn(async () => 1);
    const runQuery = vi
      .fn()
      .mockResolvedValueOnce({ userId: repository.userId })
      .mockResolvedValueOnce(repository);
    const ctx = { runMutation, runQuery } as unknown as ActionCtx;

    await handleRepositoryEvent(ctx, {
      action: "deleted",
      installation: { id: 321 },
      repository: { id: 654, full_name: "owner/repo" },
    });

    expect(runQuery).toHaveBeenCalledTimes(2);
    expect(mockedRepositoryToken).toHaveBeenCalledWith(
      321,
      654,
      "test-app-id",
      "test-private-key",
    );
    expect(mockedFetchGitHubAppJsonWithRetry).toHaveBeenCalledOnce();
    expect(runMutation).not.toHaveBeenCalled();
  });

  it("reconciles authoritatively when repository deletion is not live-attestable", async () => {
    const repository = createEligibleRepository();
    const runMutation = vi.fn(async () => 1);
    const runQuery = vi
      .fn()
      .mockResolvedValueOnce({ userId: repository.userId })
      .mockResolvedValueOnce(repository);
    const ctx = { runMutation, runQuery } as unknown as ActionCtx;
    mockedRepositoryToken.mockRejectedValueOnce(
      new Error("Repository is no longer selected"),
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await handleRepositoryEvent(ctx, {
      action: "deleted",
      installation: { id: 321 },
      repository: { id: 654, full_name: "owner/repo" },
    });

    expect(runMutation).toHaveBeenCalledOnce();
    expect(runMutation.mock.calls[0][1]).toEqual({ installationId: 321 });
  });

  it("persists removed immutable IDs before bounded processing", async () => {
    const runMutation = vi.fn(async () => ({ created: true }));
    const runQuery = vi.fn(async () => verifiedInstallation);
    const storage = {
      store: vi.fn(async () => "storage-id" as Id<"_storage">),
      delete: vi.fn(async () => undefined),
    };
    const ctx = { runMutation, runQuery, storage } as unknown as ActionCtx;

    await handleInstallationRepositoriesEvent(
      ctx,
      installationRepositoriesPayload("removed", {
        repositories_removed: [{ id: 654, full_name: "owner/repo" }],
      }),
      "delivery-1",
    );

    expect(storage.store).toHaveBeenCalledOnce();
    expect(runMutation).toHaveBeenCalledOnce();
    expect(runMutation.mock.calls[0][1]).toEqual({
      deliveryId: "delivery-1",
      installationId: 321,
      payloadStorageId: "storage-id",
      totalRepositories: 1,
    });
    expect(
      JSON.parse(await (storage.store.mock.calls[0][0] as Blob).text()),
    ).toEqual([{ githubRepositoryId: 654 }]);
  });

  it("deletes an orphaned payload when durable job creation fails", async () => {
    const runMutation = vi.fn(async () => {
      throw new Error("job unavailable");
    });
    const runQuery = vi.fn(async () => verifiedInstallation);
    const storage = {
      store: vi.fn(async () => "storage-id" as Id<"_storage">),
      delete: vi.fn(async () => undefined),
    };
    const ctx = { runMutation, runQuery, storage } as unknown as ActionCtx;

    await expect(
      handleInstallationRepositoriesEvent(
        ctx,
        installationRepositoriesPayload("removed", {
          repositories_removed: [{ id: 654, full_name: "stale/name" }],
        }),
        "delivery-2",
      ),
    ).rejects.toThrow("job unavailable");

    expect(runMutation).toHaveBeenCalledOnce();
    expect(storage.delete).toHaveBeenCalledWith("storage-id");
  });

  it("routes added access through the same authoritative reconciliation", async () => {
    const runMutation = vi.fn(async () => 123);
    const runQuery = vi.fn(async () => verifiedInstallation);
    const ctx = { runMutation, runQuery } as unknown as ActionCtx;

    await handleInstallationRepositoriesEvent(
      ctx,
      installationRepositoriesPayload("added", {
        repositories_added: [{ id: 654, full_name: "owner/repo" }],
      }),
    );

    expect(runMutation.mock.calls[0][1]).toEqual({
      installationId: 321,
      expectedAccessSuspendedAt: null,
    });
  });

  it("queues removed access after an earlier added reconciliation", async () => {
    const runMutation = vi.fn(async () => 123);
    const runQuery = vi.fn(async () => verifiedInstallation);
    const storage = {
      store: vi.fn(async () => "storage-id" as Id<"_storage">),
      delete: vi.fn(async () => undefined),
    };
    const ctx = { runMutation, runQuery, storage } as unknown as ActionCtx;

    await handleInstallationRepositoriesEvent(
      ctx,
      installationRepositoriesPayload("added", {
        repositories_added: [{ id: 654, full_name: "owner/repo" }],
      }),
    );
    await handleInstallationRepositoriesEvent(
      ctx,
      installationRepositoriesPayload("removed", {
        repositories_removed: [{ id: 654, full_name: "owner/repo" }],
      }),
      "delivery-3",
    );

    expect(runMutation).toHaveBeenCalledTimes(2);
    expect(runMutation.mock.calls.map((call) => call[1])).toEqual([
      { installationId: 321, expectedAccessSuspendedAt: null },
      {
        deliveryId: "delivery-3",
        installationId: 321,
        payloadStorageId: "storage-id",
        totalRepositories: 1,
      },
    ]);
  });

  it.each([
    { label: "missing", deliveryId: undefined },
    { label: "null", deliveryId: null },
    { label: "blank", deliveryId: "   " },
    { label: "oversized", deliveryId: "x".repeat(201) },
  ])(
    "reconciles authoritatively without storing a blob for a $label delivery ID",
    async ({ deliveryId }) => {
      const runMutation = vi.fn(async () => 123);
      const runQuery = vi.fn(async () => verifiedInstallation);
      const storage = {
        store: vi.fn(async () => "storage-id" as Id<"_storage">),
        delete: vi.fn(async () => undefined),
      };
      const ctx = { runMutation, runQuery, storage } as unknown as ActionCtx;

      await handleInstallationRepositoriesEvent(
        ctx,
        installationRepositoriesPayload("removed", {
          repositories_removed: [{ id: 654, full_name: "owner/repo" }],
        }),
        deliveryId,
      );

      expect(runMutation).toHaveBeenCalledOnce();
      expect(runMutation.mock.calls[0][1]).toEqual({ installationId: 321 });
      expect(storage.store).not.toHaveBeenCalled();
      expect(storage.delete).not.toHaveBeenCalled();
    },
  );

  it("does not permanently dedupe repeated removal payloads without delivery IDs", async () => {
    const runMutation = vi.fn(async () => 123);
    const runQuery = vi.fn(async () => verifiedInstallation);
    const storage = {
      store: vi.fn(async () => "storage-id" as Id<"_storage">),
      delete: vi.fn(async () => undefined),
    };
    const ctx = { runMutation, runQuery, storage } as unknown as ActionCtx;
    const removedPayload = installationRepositoriesPayload("removed", {
      repositories_removed: [{ id: 654, full_name: "owner/repo" }],
    });

    await handleInstallationRepositoriesEvent(ctx, removedPayload);
    await handleInstallationRepositoriesEvent(
      ctx,
      installationRepositoriesPayload("added", {
        repositories_added: [{ id: 654, full_name: "owner/repo" }],
      }),
    );
    await handleInstallationRepositoriesEvent(ctx, removedPayload);

    expect(runMutation.mock.calls.map((call) => call[1])).toEqual([
      { installationId: 321 },
      { installationId: 321, expectedAccessSuspendedAt: null },
      { installationId: 321 },
    ]);
    expect(storage.store).not.toHaveBeenCalled();
  });
});
