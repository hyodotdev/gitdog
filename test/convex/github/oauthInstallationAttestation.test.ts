import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchAccessibleGitHubInstallationIds,
  GITHUB_INSTALLATION_ATTESTATION_REQUEST_TIMEOUT_MS,
  GITHUB_INSTALLATION_ATTESTATION_TTL_MS,
  saveInstallationAttestation,
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

  it("stores one sorted snapshot per user for the linked account", async () => {
    const now = 1_800_000_000_000;
    const mockedNow = vi.spyOn(Date, "now").mockReturnValue(now);
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { githubAccountId: "654" }),
    );

    await t.run((ctx) =>
      saveInstallationAttestation(ctx, {
        userId,
        githubAccountId: "654",
        installationIds: [321, 123],
        now,
      }),
    );
    mockedNow.mockReturnValue(now + 1_000);
    await t.run((ctx) =>
      saveInstallationAttestation(ctx, {
        userId,
        githubAccountId: "654",
        installationIds: [456],
        now: now + 1_000,
      }),
    );
    const attestations = await t.run((ctx) =>
      ctx.db.query("githubOAuthInstallationAttestations").collect(),
    );

    expect(attestations).toHaveLength(1);
    expect(attestations[0]).toMatchObject({
      userId,
      githubAccountId: "654",
      installationIds: [456],
      attestedAt: now + 1_000,
      expiresAt: now + 1_000 + GITHUB_INSTALLATION_ATTESTATION_TTL_MS,
    });
  });

  it("refuses invalid ids and a snapshot owned by another account", async () => {
    const t = convexTest(schema, modules);
    const [first, second] = await t.run(async (ctx) => [
      await ctx.db.insert("users", { githubAccountId: "654" }),
      await ctx.db.insert("users", { githubAccountId: "777" }),
    ]);
    const save = (
      userId: typeof first,
      githubAccountId: string,
      installationIds: unknown,
    ) =>
      t.run((ctx) =>
        saveInstallationAttestation(ctx, {
          userId,
          githubAccountId,
          installationIds,
          now: Date.now(),
        }),
      );

    await expect(save(first, "not-a-number", [1])).rejects.toThrow(
      "attestation is invalid",
    );
    await expect(save(first, "654", [1, 1])).rejects.toThrow(
      "attestation is invalid",
    );
    await save(first, "654", [1]);
    await expect(save(second, "654", [2])).rejects.toThrow("owner mismatch");
  });
});
