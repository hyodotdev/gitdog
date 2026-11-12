import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Doc, Id } from "../../../convex/_generated/dataModel";
import type { ActionCtx } from "../../../convex/_generated/server";
import * as githubHelpers from "../../../convex/github/helpers";

import {
  isOsiApprovedLicenseApiMatch,
  normalizeGitHubRepositoryEmbeddingMetadata,
} from "../../../convex/repositories/embeddingPolicy";
import {
  assertRepositoryEmbeddingProviderRequest,
  resolveFreshRepositoryEmbeddingPolicy,
  resolveStoredRagEmbeddingPolicyWithRefresh,
} from "../../../convex/repositories/embeddingPolicyRuntime";

const POLICY_TEST_NOW = 1_000_000;

type EmbeddingPolicyMutationArgs = {
  expectedMetadataCheckedAt?: number;
  expectedInstallationId: number;
  expectedGithubRepositoryId: number;
  expectedGithubRepo: string;
  githubVisibility: "public" | "private" | "internal" | null;
  licenseKey: string | null;
  licenseSpdxId: string | null;
  licenseOsiApproved: boolean;
  licenseOsiCheckedAt: number | null;
};

function createRepository(
  overrides: Partial<Doc<"repositories">> = {},
): Doc<"repositories"> {
  return {
    _id: "repository" as Id<"repositories">,
    _creationTime: 0,
    userId: "user" as Id<"users">,
    installationId: 123,
    githubRepositoryId: 456,
    githubRepo: "owner/repo",
    name: "repo",
    githubUrl: "https://github.com/owner/repo",
    isActive: true,
    githubVisibility: "public",
    licenseKey: "mit",
    licenseSpdxId: "MIT",
    licenseOsiApproved: true,
    licenseOsiCheckedAt: POLICY_TEST_NOW - 1_000,
    repositoryMetadataCheckedAt: POLICY_TEST_NOW - 2_000,
    ...overrides,
  } as Doc<"repositories">;
}

function createPolicyContext(
  initialRepository: Doc<"repositories">,
  options: { hasCurrentLegalAttestation?: boolean } = {},
) {
  let repository = initialRepository;
  const runQuery = vi.fn(async (_query: unknown, args: object) => {
    if ("repositoryId" in args) {
      return repository;
    }
    if ("userId" in args) {
      return options.hasCurrentLegalAttestation ?? true;
    }
    return {
      userId: repository.userId,
      installationId: repository.installationId,
    };
  });
  const runMutation = vi.fn(
    async (_mutation: unknown, args: EmbeddingPolicyMutationArgs) => {
      if (
        repository.repositoryMetadataCheckedAt !==
        args.expectedMetadataCheckedAt
      ) {
        return null;
      }

      repository = {
        ...repository,
        githubVisibility: args.githubVisibility ?? undefined,
        licenseKey: args.licenseKey ?? undefined,
        licenseSpdxId: args.licenseSpdxId ?? undefined,
        licenseOsiApproved: args.licenseOsiApproved,
        licenseOsiCheckedAt: args.licenseOsiCheckedAt ?? undefined,
        repositoryMetadataCheckedAt: Math.max(
          Date.now(),
          (repository.repositoryMetadataCheckedAt ?? 0) + 1,
        ),
      };
      return repository.repositoryMetadataCheckedAt;
    },
  );

  return {
    ctx: { runQuery, runMutation } as unknown as ActionCtx,
    runMutation,
    runQuery,
    getRepository: () => repository,
    setRepository: (nextRepository: Doc<"repositories">) => {
      repository = nextRepository;
    },
  };
}

function githubMetadataResponse(
  visibility: "public" | "private" | "internal" = "public",
  license: { key: string; spdxId: string } | null = {
    key: "mit",
    spdxId: "MIT",
  },
  identity: { id: number; fullName: string } = {
    id: 456,
    fullName: "owner/repo",
  },
): Response {
  return new Response(
    JSON.stringify({
      id: identity.id,
      full_name: identity.fullName,
      visibility,
      private: visibility === "private",
      license:
        license === null ? null : { key: license.key, spdx_id: license.spdxId },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function expectedVerifiedPolicy(route: "free" | "paid") {
  return {
    status: route === "free" ? "verified_free" : "verified_paid",
    policy: { route, allowPaidFallback: route === "free" },
  };
}

describe("normalizeGitHubRepositoryEmbeddingMetadata", () => {
  it("normalizes exact GitHub visibility and detected license fields", () => {
    expect(
      normalizeGitHubRepositoryEmbeddingMetadata({
        visibility: "public",
        private: false,
        license: {
          key: " mit ",
          spdx_id: " MIT ",
          name: "MIT License",
        },
      }),
    ).toEqual({
      githubVisibility: "public",
      licenseKey: "mit",
      licenseSpdxId: "MIT",
    });
  });

  it.each(["private", "internal"] as const)(
    "preserves the %s visibility",
    (visibility) => {
      expect(
        normalizeGitHubRepositoryEmbeddingMetadata({ visibility }),
      ).toEqual({ githubVisibility: visibility });
    },
  );

  it("does not infer public visibility from the private flag", () => {
    expect(
      normalizeGitHubRepositoryEmbeddingMetadata({
        private: false,
        license: { key: "mit", spdx_id: "MIT" },
      }),
    ).toEqual({ licenseKey: "mit", licenseSpdxId: "MIT" });
  });

  it.each([
    { value: null },
    { value: undefined },
    { value: [] },
    { value: "public" },
    { value: { visibility: "PUBLIC", license: null } },
    { value: { visibility: true, license: [] } },
  ])("conservatively ignores malformed metadata %#", ({ value }) => {
    expect(normalizeGitHubRepositoryEmbeddingMetadata(value)).toEqual({});
  });

  it("omits blank and non-string license fields", () => {
    expect(
      normalizeGitHubRepositoryEmbeddingMetadata({
        visibility: "public",
        license: { key: "  ", spdx_id: 123 },
      }),
    ).toEqual({ githubVisibility: "public" });
  });
});

describe("OSI approved-license API matching", () => {
  it.each([true, false])(
    "matches a singleton exact SPDX result when approved is %s",
    (approved) => {
      expect(
        isOsiApprovedLicenseApiMatch([{ spdx_id: " MIT ", approved }], "mit"),
      ).toBe(true);
    },
  );

  it("matches exact canonical membership without relying on approved", () => {
    expect(isOsiApprovedLicenseApiMatch([{ spdx_id: "MIT" }], "MIT")).toBe(
      true,
    );
  });

  it.each([
    { response: [], spdxId: "BUSL-1.1" },
    {
      response: [{ spdx_id: "MIT-CMU", approved: false }],
      spdxId: "MIT",
    },
    { response: { spdx_id: "MIT" }, spdxId: "MIT" },
    { response: [{ spdx_id: 123 }], spdxId: "MIT" },
    { response: [{ spdx_id: "   " }], spdxId: "MIT" },
    { response: [{ spdx_id: "MIT" }], spdxId: "   " },
    {
      response: [{ spdx_id: "MIT" }, { spdx_id: "Apache-2.0" }],
      spdxId: "MIT",
    },
    {
      response: [{ spdx_id: "MIT" }, { spdx_id: "MIT" }],
      spdxId: "MIT",
    },
  ])(
    "rejects non-matching, malformed, or ambiguous responses %#",
    ({ response, spdxId }) => {
      expect(isOsiApprovedLicenseApiMatch(response, spdxId)).toBe(false);
    },
  );
});

describe("fresh repository embedding policy", () => {
  const originalAppId = process.env.GITHUB_APP_ID;
  const originalPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.GITHUB_APP_ID = "test-app-id";
    process.env.GITHUB_APP_PRIVATE_KEY = "test-private-key";
    vi.spyOn(githubHelpers, "getRepositoryInstallationToken").mockResolvedValue(
      "installation-token",
    );
    vi.spyOn(Date, "now").mockReturnValue(POLICY_TEST_NOW);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
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
    vi.restoreAllMocks();
  });

  it("rechecks fresh free eligibility immediately before the provider call", async () => {
    const repository = createRepository({
      ragEmbeddingBillingTier: "free",
    });
    const { ctx } = createPolicyContext(repository);
    const resolution = await resolveStoredRagEmbeddingPolicyWithRefresh(
      ctx,
      repository,
    );
    const fetchMock = vi.fn(async () => githubMetadataResponse("private"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      assertRepositoryEmbeddingProviderRequest(ctx, {
        resolution,
        route: "free",
      }),
    ).rejects.toMatchObject({
      kind: "policy",
      route: "free",
      durableRetrySafe: true,
    });
    await expect(
      assertRepositoryEmbeddingProviderRequest(ctx, {
        resolution,
        route: "paid",
      }),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["free", "paid"] as const)(
    "blocks the %s provider before network access without current legal attestation",
    async (route) => {
      const repository = createRepository({
        ragEmbeddingBillingTier: route,
        githubVisibility: route === "free" ? "public" : "private",
        licenseOsiApproved: route === "free",
      });
      const { ctx } = createPolicyContext(repository, {
        hasCurrentLegalAttestation: false,
      });
      const resolution = await resolveStoredRagEmbeddingPolicyWithRefresh(
        ctx,
        repository,
      );
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        assertRepositoryEmbeddingProviderRequest(ctx, {
          resolution,
          route,
        }),
      ).rejects.toMatchObject({
        kind: "policy",
        route,
        durableRetrySafe: true,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(
        githubHelpers.getRepositoryInstallationToken as unknown as ReturnType<
          typeof vi.fn
        >,
      ).not.toHaveBeenCalled();
    },
  );

  it.each([429, 500, 503])(
    "fails a live free check closed on HTTP %s while preserving paid fallback",
    async (status) => {
      const repository = createRepository({
        ragEmbeddingBillingTier: "free",
      });
      const { ctx } = createPolicyContext(repository);
      const resolution = await resolveStoredRagEmbeddingPolicyWithRefresh(
        ctx,
        repository,
      );
      const fetchMock = vi.fn(async () => new Response(null, { status }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        assertRepositoryEmbeddingProviderRequest(ctx, {
          resolution,
          route: "free",
        }),
      ).rejects.toMatchObject({
        kind: "policy",
        route: "free",
        durableRetrySafe: true,
      });
      await expect(
        assertRepositoryEmbeddingProviderRequest(ctx, {
          resolution,
          route: "paid",
        }),
      ).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it.each([401, 403, 404])(
    "classifies live GitHub HTTP %s as repository access loss for both routes",
    async (status) => {
      const repository = createRepository({ ragEmbeddingBillingTier: "free" });
      const { ctx } = createPolicyContext(repository);
      const resolution = await resolveStoredRagEmbeddingPolicyWithRefresh(
        ctx,
        repository,
      );
      const fetchMock = vi.fn(async () => new Response(null, { status }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      for (const route of ["free", "paid"] as const) {
        await expect(
          assertRepositoryEmbeddingProviderRequest(ctx, {
            resolution,
            route,
          }),
        ).rejects.toMatchObject({
          kind: "repository_access",
          route,
          httpStatus: status,
          durableRetrySafe: true,
        });
      }
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("blocks free and paid fallback after a public repository is removed from the installation", async () => {
    const repository = createRepository({ ragEmbeddingBillingTier: "free" });
    const { ctx } = createPolicyContext(repository);
    const resolution = await resolveStoredRagEmbeddingPolicyWithRefresh(
      ctx,
      repository,
    );
    const tokenMock =
      githubHelpers.getRepositoryInstallationToken as unknown as ReturnType<
        typeof vi.fn
      >;
    tokenMock.mockRejectedValue(new Error("repository selection denied"));
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    for (const route of ["free", "paid"] as const) {
      await expect(
        assertRepositoryEmbeddingProviderRequest(ctx, { resolution, route }),
      ).rejects.toMatchObject({ kind: "repository_access", route });
    }
    expect(tokenMock).toHaveBeenNthCalledWith(
      1,
      repository.installationId,
      repository.githubRepositoryId,
      "test-app-id",
      "test-private-key",
    );
    expect(tokenMock).toHaveBeenNthCalledWith(
      2,
      repository.installationId,
      repository.githubRepositoryId,
      "test-app-id",
      "test-private-key",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks an initially paid public repository after installation selection removal", async () => {
    const repository = createRepository({
      ragEmbeddingBillingTier: "paid",
      licenseOsiApproved: false,
    });
    const { ctx } = createPolicyContext(repository);
    const resolution = await resolveStoredRagEmbeddingPolicyWithRefresh(
      ctx,
      repository,
    );
    expect(resolution).toMatchObject(expectedVerifiedPolicy("paid"));
    const tokenMock =
      githubHelpers.getRepositoryInstallationToken as unknown as ReturnType<
        typeof vi.fn
      >;
    tokenMock.mockRejectedValue(new Error("repository selection denied"));
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      assertRepositoryEmbeddingProviderRequest(ctx, {
        resolution,
        route: "paid",
      }),
    ).rejects.toMatchObject({
      kind: "repository_access",
      route: "paid",
      durableRetrySafe: true,
    });
    expect(tokenMock).toHaveBeenCalledWith(
      repository.installationId,
      repository.githubRepositoryId,
      "test-app-id",
      "test-private-key",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks both routes when live GitHub identity does not match", async () => {
    const repository = createRepository({ ragEmbeddingBillingTier: "free" });
    const { ctx } = createPolicyContext(repository);
    const resolution = await resolveStoredRagEmbeddingPolicyWithRefresh(
      ctx,
      repository,
    );
    const fetchMock = vi.fn(async () =>
      githubMetadataResponse(
        "public",
        { key: "mit", spdxId: "MIT" },
        { id: 999, fullName: "other/repo" },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    for (const route of ["free", "paid"] as const) {
      await expect(
        assertRepositoryEmbeddingProviderRequest(ctx, { resolution, route }),
      ).rejects.toMatchObject({ kind: "repository_access", route });
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("blocks both routes when live GitHub cannot be reached", async () => {
    const repository = createRepository({ ragEmbeddingBillingTier: "free" });
    const { ctx } = createPolicyContext(repository);
    const resolution = await resolveStoredRagEmbeddingPolicyWithRefresh(
      ctx,
      repository,
    );
    const fetchMock = vi.fn(async () => {
      throw new TypeError("network unavailable");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    for (const route of ["free", "paid"] as const) {
      await expect(
        assertRepositoryEmbeddingProviderRequest(ctx, { resolution, route }),
      ).rejects.toMatchObject({ kind: "repository_access", route });
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rechecks an initially paid private repository immediately before use", async () => {
    const repository = createRepository({
      ragEmbeddingBillingTier: "paid",
      githubVisibility: "private",
      licenseOsiApproved: false,
      licenseOsiCheckedAt: undefined,
    });
    const { ctx } = createPolicyContext(repository);
    const resolution = await resolveStoredRagEmbeddingPolicyWithRefresh(
      ctx,
      repository,
    );
    expect(resolution).toMatchObject(expectedVerifiedPolicy("paid"));
    const fetchMock = vi.fn(async () => githubMetadataResponse("private"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      assertRepositoryEmbeddingProviderRequest(ctx, {
        resolution,
        route: "paid",
      }),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-github-api-version")).toBe("2026-03-10");
  });

  it("blocks an initially paid private repository after live removal", async () => {
    const repository = createRepository({
      ragEmbeddingBillingTier: "paid",
      githubVisibility: "private",
      licenseOsiApproved: false,
      licenseOsiCheckedAt: undefined,
    });
    const { ctx } = createPolicyContext(repository);
    const resolution = await resolveStoredRagEmbeddingPolicyWithRefresh(
      ctx,
      repository,
    );
    globalThis.fetch = vi.fn(
      async () => new Response(null, { status: 404 }),
    ) as unknown as typeof fetch;

    await expect(
      assertRepositoryEmbeddingProviderRequest(ctx, {
        resolution,
        route: "paid",
      }),
    ).rejects.toMatchObject({
      kind: "repository_access",
      route: "paid",
      httpStatus: 404,
    });
  });

  it.each([
    {
      name: "a confirmed non-OSI license",
      fields: {
        ragEmbeddingBillingTier: "paid" as const,
        licenseOsiApproved: false,
      },
    },
    {
      name: "a private repository",
      fields: {
        ragEmbeddingBillingTier: "paid" as const,
        githubVisibility: "private" as const,
        licenseOsiApproved: false,
        licenseOsiCheckedAt: undefined,
      },
    },
    {
      name: "an internal repository",
      fields: {
        ragEmbeddingBillingTier: undefined,
        githubVisibility: "internal" as const,
        licenseOsiApproved: false,
        licenseOsiCheckedAt: undefined,
      },
    },
  ])("keeps $name paid without a refresh", async ({ fields }) => {
    const repository = createRepository(fields);
    const { ctx, runMutation } = createPolicyContext(repository);
    const fetchMock = vi.fn(async () => {
      throw new Error("confirmed paid metadata must not be refreshed");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      resolveStoredRagEmbeddingPolicyWithRefresh(ctx, repository),
    ).resolves.toMatchObject(expectedVerifiedPolicy("paid"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(runMutation).not.toHaveBeenCalled();
  });

  it("fails closed when another metadata refresh wins the persistence race", async () => {
    const repository = createRepository();
    const runQuery = vi.fn(async () => repository);
    const runMutation = vi.fn(async () => null);
    const ctx = { runQuery, runMutation } as unknown as ActionCtx;
    const fetchMock = vi.fn(
      async (_input: string | URL | Request): Promise<Response> =>
        githubMetadataResponse(),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      resolveFreshRepositoryEmbeddingPolicy(ctx, repository),
    ).resolves.toMatchObject({ status: "unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(runQuery).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: "numeric ID", identity: { id: 999, fullName: "owner/repo" } },
    { name: "full name", identity: { id: 456, fullName: "other/repo" } },
  ])(
    "rejects a GitHub response with a mismatched $name",
    async ({ identity }) => {
      const repository = createRepository();
      const { ctx, runMutation } = createPolicyContext(repository);
      globalThis.fetch = vi.fn(async () =>
        githubMetadataResponse(
          "public",
          { key: "mit", spdxId: "MIT" },
          identity,
        ),
      ) as unknown as typeof fetch;

      await expect(
        resolveFreshRepositoryEmbeddingPolicy(ctx, repository),
      ).resolves.toMatchObject({ status: "unavailable" });
      expect(runMutation).not.toHaveBeenCalled();
    },
  );

  it.each([
    { isActive: false },
    { githubAccessRevokedAt: POLICY_TEST_NOW },
    { githubRepositoryId: 999 },
    { installationId: 999 },
  ])("rereads and rejects stale stored access %#", async (currentFields) => {
    const snapshot = createRepository({ ragEmbeddingBillingTier: "free" });
    const current = createRepository({
      ragEmbeddingBillingTier: "free",
      ...currentFields,
    });
    const { ctx } = createPolicyContext(current);

    await expect(
      resolveStoredRagEmbeddingPolicyWithRefresh(ctx, snapshot),
    ).resolves.toMatchObject({ status: "unavailable" });
  });

  it("treats a missing verified installation as unavailable", async () => {
    const repository = createRepository({ ragEmbeddingBillingTier: "free" });
    const runQuery = vi.fn(async (_query: unknown, args: object) =>
      "repositoryId" in args ? repository : null,
    );
    const ctx = { runQuery } as unknown as ActionCtx;

    await expect(
      resolveStoredRagEmbeddingPolicyWithRefresh(ctx, repository),
    ).resolves.toMatchObject({ status: "unavailable" });
  });

  it("blocks both routes after access revocation at the provider boundary", async () => {
    const repository = createRepository({ ragEmbeddingBillingTier: "free" });
    const { ctx, getRepository, setRepository } =
      createPolicyContext(repository);
    const resolution = await resolveStoredRagEmbeddingPolicyWithRefresh(
      ctx,
      repository,
    );
    setRepository({
      ...getRepository(),
      isActive: false,
      githubAccessRevokedAt: POLICY_TEST_NOW + 1,
    });

    for (const route of ["free", "paid"] as const) {
      await expect(
        assertRepositoryEmbeddingProviderRequest(ctx, {
          resolution,
          route,
        }),
      ).rejects.toMatchObject({ kind: "repository_access", route });
    }
  });

  it.each([
    {
      name: "RAG indexing",
      repositoryOverrides: {
        indexVersion: 7,
        indexStatus: "completed" as const,
        ragStatus: "indexing" as const,
        ragEmbeddingMode: "openai" as const,
        ragEmbeddingBillingTier: "paid" as const,
        ragEmbeddingKey: "embedding-key",
        ragIndexPhase: "files" as const,
        ragIndexFileOffset: 2,
        ragIndexChunkOffset: 3,
      },
      expectedWork: {
        kind: "rag_index" as const,
        indexVersion: 7,
        phase: "files" as const,
        cursor: undefined,
        fileOffset: 2,
        chunkOffset: 3,
        embeddingKey: "embedding-key",
      },
    },
    {
      name: "learning creation",
      repositoryOverrides: {
        indexVersion: 7,
        indexStatus: "completed" as const,
        ragEmbeddingBillingTier: "paid" as const,
      },
      expectedWork: {
        kind: "learning_create" as const,
        indexVersion: 7,
      },
    },
  ])(
    "blocks paid $name before the provider when policy metadata changes",
    async ({ repositoryOverrides, expectedWork }) => {
      const repository = createRepository({
        githubVisibility: "private",
        licenseOsiApproved: false,
        ...repositoryOverrides,
      });
      const { ctx, getRepository, setRepository } =
        createPolicyContext(repository);
      const resolution = await resolveStoredRagEmbeddingPolicyWithRefresh(
        ctx,
        repository,
      );
      expect(resolution).toMatchObject(expectedVerifiedPolicy("paid"));

      setRepository({
        ...getRepository(),
        githubVisibility: "private",
        repositoryMetadataCheckedAt: POLICY_TEST_NOW + 1,
      });

      await expect(
        assertRepositoryEmbeddingProviderRequest(ctx, {
          resolution,
          route: "paid",
          expectedWork,
        }),
      ).rejects.toMatchObject({
        kind: "policy",
        route: "paid",
        durableRetrySafe: true,
      });
    },
  );

  it("keeps paid search available after metadata reclassification", async () => {
    const repository = createRepository({
      indexVersion: 7,
      indexStatus: "completed",
      ragStatus: "completed",
      ragEmbeddingMode: "openai",
      ragEmbeddingBillingTier: "paid",
      ragEmbeddingKey: "embedding-key",
    });
    const { ctx, getRepository, setRepository } =
      createPolicyContext(repository);
    const resolution = await resolveStoredRagEmbeddingPolicyWithRefresh(
      ctx,
      repository,
    );

    setRepository({
      ...getRepository(),
      githubVisibility: "private",
      repositoryMetadataCheckedAt: POLICY_TEST_NOW + 1,
    });
    globalThis.fetch = vi.fn(async () =>
      githubMetadataResponse("private"),
    ) as unknown as typeof fetch;

    await expect(
      assertRepositoryEmbeddingProviderRequest(ctx, {
        resolution,
        route: "paid",
        expectedWork: {
          kind: "rag_search",
          indexVersion: 7,
          embeddingKey: "embedding-key",
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("blocks a provider call after its exact RAG work position changes", async () => {
    const repository = createRepository({
      ragEmbeddingBillingTier: "paid",
      indexVersion: 7,
      indexStatus: "completed",
      ragStatus: "indexing",
      ragEmbeddingMode: "openai",
      ragEmbeddingKey: "embedding-key",
      ragIndexPhase: "files",
      ragIndexFileOffset: 2,
      ragIndexChunkOffset: 3,
    });
    const { ctx, getRepository, setRepository } =
      createPolicyContext(repository);
    const resolution = await resolveStoredRagEmbeddingPolicyWithRefresh(
      ctx,
      repository,
    );
    const expectedWork = {
      kind: "rag_index" as const,
      indexVersion: 7,
      phase: "files" as const,
      cursor: undefined,
      fileOffset: 2,
      chunkOffset: 3,
      embeddingKey: "embedding-key",
    };
    globalThis.fetch = vi.fn(async () =>
      githubMetadataResponse(),
    ) as unknown as typeof fetch;
    await expect(
      assertRepositoryEmbeddingProviderRequest(ctx, {
        resolution,
        route: "paid",
        expectedWork,
      }),
    ).resolves.toBeUndefined();

    setRepository({ ...getRepository(), ragIndexChunkOffset: 4 });
    await expect(
      assertRepositoryEmbeddingProviderRequest(ctx, {
        resolution,
        route: "paid",
        expectedWork,
      }),
    ).rejects.toMatchObject({ kind: "repository_access" });
  });
});
