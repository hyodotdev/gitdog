import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchAccessibleGitHubInstallationIds,
  GITHUB_INSTALLATION_ATTESTATION_REQUEST_TIMEOUT_MS,
  GITHUB_INSTALLATION_ATTESTATION_TTL_MS,
  persistGitHubInstallationAttestation,
} from "../../../convex/github/oauthInstallationAttestation";
import schema from "../../../convex/schema";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
};

afterEach(() => {
  if (vi.isFakeTimers()) {
    vi.clearAllTimers();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GitHub OAuth installation access attestation", () => {
  it("reads every bounded installation page without returning the token", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: 200 - index,
    }));
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ total_count: 101, installations: firstPage }),
      )
      .mockResolvedValueOnce(
        Response.json({ total_count: 101, installations: [{ id: 100 }] }),
      );

    const installationIds = await fetchAccessibleGitHubInstallationIds(
      "raw-oauth-token",
      request,
    );

    expect(installationIds).toEqual(
      Array.from({ length: 101 }, (_, index) => index + 100),
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(String(request.mock.calls[0][0])).toBe(
      "https://api.github.com/user/installations?per_page=100&page=1",
    );
    expect(String(request.mock.calls[1][0])).toBe(
      "https://api.github.com/user/installations?per_page=100&page=2",
    );
    const headers = new Headers(request.mock.calls[0][1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer raw-oauth-token");
    expect(request.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(installationIds)).not.toContain("raw-oauth-token");
  });

  it("aborts a stalled GitHub request at the bounded deadline", async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });

    const result = fetchAccessibleGitHubInstallationIds(
      "raw-oauth-token",
      request,
    );
    vi.advanceTimersByTime(GITHUB_INSTALLATION_ATTESTATION_REQUEST_TIMEOUT_MS);

    await expect(result).rejects.toThrow(
      "Unable to verify GitHub App installations",
    );
    expect(request).toHaveBeenCalledOnce();
  });

  it("keeps the deadline active while reading the response body", async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      return {
        ok: true,
        json: async () =>
          await new Promise<never>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          }),
      } as Response;
    });

    const result = fetchAccessibleGitHubInstallationIds("token", request);
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(GITHUB_INSTALLATION_ATTESTATION_REQUEST_TIMEOUT_MS);

    await expect(result).rejects.toThrow(
      "Unable to verify GitHub App installations",
    );
  });

  it("fails closed for oversized, duplicate, or incomplete snapshots", async () => {
    await expect(
      fetchAccessibleGitHubInstallationIds(
        "token",
        vi.fn(async () =>
          Response.json({ total_count: 501, installations: [] }),
        ) as typeof fetch,
      ),
    ).rejects.toThrow("supported limit");

    await expect(
      fetchAccessibleGitHubInstallationIds(
        "token",
        vi.fn(async () =>
          Response.json({
            total_count: 2,
            installations: [{ id: 123 }, { id: 123 }],
          }),
        ) as typeof fetch,
      ),
    ).rejects.toThrow("invalid installation access data");

    await expect(
      fetchAccessibleGitHubInstallationIds(
        "token",
        vi.fn(async () =>
          Response.json({ total_count: 2, installations: [{ id: 123 }] }),
        ) as typeof fetch,
      ),
    ).rejects.toThrow("incomplete installation access data");
  });

  it("stores one current snapshot and strips untrusted profile fields", async () => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const t = convexTest(schema, modules);

    const userId = await t.run(async (ctx) =>
      persistGitHubInstallationAttestation(ctx, {
        existingUserId: null,
        type: "oauth",
        provider: { id: "github", type: "oauth" },
        profile: {
          githubAccountId: "654",
          githubInstallationIds: [321, 123],
          name: "octocat",
          email: "octocat@example.com",
          image: "https://avatars.example/octocat",
          accessToken: "must-not-be-stored",
        },
      }),
    );
    const state = await t.run(async (ctx) => ({
      user: await ctx.db.get(userId),
      attestations: await ctx.db
        .query("githubOAuthInstallationAttestations")
        .collect(),
    }));

    expect(state.user).toMatchObject({
      name: "octocat",
      email: "octocat@example.com",
      image: "https://avatars.example/octocat",
      emailVerificationTime: now,
    });
    expect(state.user).not.toHaveProperty("githubAccountId");
    expect(state.user).not.toHaveProperty("githubInstallationIds");
    expect(state.user).not.toHaveProperty("accessToken");
    expect(state.attestations).toHaveLength(1);
    expect(state.attestations[0]).toMatchObject({
      userId,
      githubAccountId: "654",
      installationIds: [123, 321],
      attestedAt: now,
      expiresAt: now + GITHUB_INSTALLATION_ATTESTATION_TTL_MS,
      updatedAt: now,
    });
    expect(state.attestations[0]).not.toHaveProperty("accessToken");
  });

  it("replaces the current snapshot only for the exact linked account", async () => {
    const now = 1_800_000_000_000;
    const mockedNow = vi.spyOn(Date, "now").mockReturnValue(now);
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { name: "before" });
      await ctx.db.insert("authAccounts", {
        userId,
        provider: "github",
        providerAccountId: "654",
      });
      return userId;
    });

    await t.run(async (ctx) =>
      persistGitHubInstallationAttestation(ctx, {
        existingUserId: userId,
        type: "oauth",
        provider: { id: "github", type: "oauth" },
        profile: {
          githubAccountId: "654",
          githubInstallationIds: [123],
          name: "first",
        },
      }),
    );
    mockedNow.mockReturnValue(now + 1_000);
    await t.run(async (ctx) =>
      persistGitHubInstallationAttestation(ctx, {
        existingUserId: userId,
        type: "oauth",
        provider: { id: "github", type: "oauth" },
        profile: {
          githubAccountId: "654",
          githubInstallationIds: [456],
          name: "second",
        },
      }),
    );
    const state = await t.run(async (ctx) => ({
      user: await ctx.db.get(userId),
      attestations: await ctx.db
        .query("githubOAuthInstallationAttestations")
        .collect(),
    }));

    expect(state.user?.name).toBe("second");
    expect(state.attestations).toHaveLength(1);
    expect(state.attestations[0]).toMatchObject({
      userId,
      githubAccountId: "654",
      installationIds: [456],
      attestedAt: now + 1_000,
    });
  });

  it("rolls back when the OAuth identity does not match the linked account", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { name: "before" });
      await ctx.db.insert("authAccounts", {
        userId,
        provider: "github",
        providerAccountId: "654",
      });
      return userId;
    });

    await expect(
      t.run(async (ctx) =>
        persistGitHubInstallationAttestation(ctx, {
          existingUserId: userId,
          type: "oauth",
          provider: { id: "github", type: "oauth" },
          profile: {
            githubAccountId: "999",
            githubInstallationIds: [123],
            name: "attacker",
          },
        }),
      ),
    ).rejects.toThrow("GitHub account identity changed during sign-in");
    const state = await t.run(async (ctx) => ({
      user: await ctx.db.get(userId),
      attestations: await ctx.db
        .query("githubOAuthInstallationAttestations")
        .collect(),
    }));

    expect(state.user?.name).toBe("before");
    expect(state.attestations).toHaveLength(0);
  });
});
