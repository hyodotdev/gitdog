import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchGitHubAppJsonWithRetry,
  GitHubAppRateLimitError,
  getRepositoryInstallationToken,
} from "../../../convex/github/helpers";

vi.mock("jose", () => ({
  importPKCS8: vi.fn(async () => ({}) as CryptoKey),
  SignJWT: class {
    setProtectedHeader() {
      return this;
    }

    setIssuedAt() {
      return this;
    }

    setExpirationTime() {
      return this;
    }

    setIssuer() {
      return this;
    }

    async sign() {
      return "signed-test-jwt";
    }
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GitHub App request retries", () => {
  it("uses app authentication headers without exposing the JWT", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ id: 321 }, { status: 200 }),
    );

    const result = await fetchGitHubAppJsonWithRetry<{ id: number }>(
      "https://api.github.com/repos/owner/repo/installation",
      "sensitive-jwt",
      "Repository installation lookup",
      { fetchImpl: fetchImpl as typeof fetch },
    );

    expect(result).toEqual({ id: 321 });
    const headers = new Headers(fetchImpl.mock.calls[0][1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer sensitive-jwt");
    expect(headers.get("accept")).toBe("application/vnd.github+json");
    expect(headers.get("x-github-api-version")).toBe("2026-03-10");
    expect(fetchImpl.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("retries transient responses with a bounded delay", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("temporary secret body", {
          status: 503,
          headers: { "retry-after": "0" },
        }),
      )
      .mockResolvedValueOnce(Response.json({ id: 654 }, { status: 200 }));
    const sleep = vi.fn(async () => {});

    const result = await fetchGitHubAppJsonWithRetry<{ id: number }>(
      "https://api.github.com/repos/owner/repo/installation",
      "sensitive-jwt",
      "Repository installation lookup",
      { fetchImpl, sleep },
    );

    expect(result).toEqual({ id: 654 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("preserves an uncapped 429 retry time after bounded in-process retries", async () => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 429,
          headers: { "retry-after": "120" },
        }),
    );
    const sleep = vi.fn(async () => {});

    const error = await fetchGitHubAppJsonWithRetry(
      "https://api.github.com/app/installations/123/access_tokens",
      "sensitive-jwt",
      "GitHub repository-scoped installation token request",
      { fetchImpl: fetchImpl as typeof fetch, sleep },
    ).then(
      () => null,
      (failure: unknown) => failure,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(5_000);
    expect(error).toBeInstanceOf(GitHubAppRateLimitError);
    expect(error).toMatchObject({
      name: "GitHubAppRateLimitError",
      retryAt: now + 120_000,
      status: 429,
    });
  });

  it("preserves the primary-limit reset time from an exhausted 403", async () => {
    const now = 1_800_000_000_000;
    const resetAt = now + 90_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(resetAt / 1_000),
          },
        }),
    );

    const error = await fetchGitHubAppJsonWithRetry(
      "https://api.github.com/app/installations/123/access_tokens",
      "sensitive-jwt",
      "GitHub repository-scoped installation token request",
      { fetchImpl: fetchImpl as typeof fetch, maxAttempts: 1 },
    ).then(
      () => null,
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(GitHubAppRateLimitError);
    expect(error).toMatchObject({
      name: "GitHubAppRateLimitError",
      retryAt: resetAt,
      status: 403,
    });
  });

  it("sanitizes permanent response and network failures", async () => {
    const permanentFetch = vi.fn(
      async () => new Response("sensitive-response-body", { status: 404 }),
    );
    const networkFetch = vi.fn(async () => {
      throw new Error("request leaked sensitive-jwt");
    });

    const permanentError: unknown = await fetchGitHubAppJsonWithRetry(
      "https://api.github.com/repos/owner/repo/installation",
      "sensitive-jwt",
      "Repository installation lookup",
      { fetchImpl: permanentFetch as typeof fetch },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    const networkError: unknown = await fetchGitHubAppJsonWithRetry(
      "https://api.github.com/repos/owner/repo/installation",
      "sensitive-jwt",
      "Repository installation lookup",
      {
        fetchImpl: networkFetch as typeof fetch,
        maxAttempts: 1,
      },
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(permanentError).toBeInstanceOf(Error);
    expect(networkError).toBeInstanceOf(Error);
    expect((permanentError as Error).message).toBe(
      "Repository installation lookup failed (HTTP 404)",
    );
    expect((networkError as Error).message).toBe(
      "Repository installation lookup failed after 1 attempts (Error)",
    );
    expect((permanentError as Error).message).not.toMatch(/sensitive/i);
    expect((networkError as Error).message).not.toMatch(/sensitive/i);
  });
});

describe("repository-scoped installation tokens", () => {
  const testPrivateKey = [
    "-----BEGIN",
    "PRIVATE KEY-----",
    "test",
    "-----END",
    "PRIVATE KEY-----",
  ].join(" ");

  it("mints a token for exactly one immutable numeric repository ID", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ token: "repository-token" }, { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchImpl);

    await expect(
      getRepositoryInstallationToken(123, 456, "test-app-id", testPrivateKey),
    ).resolves.toBe("repository-token");

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      "https://api.github.com/app/installations/123/access_tokens",
    );
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ repository_ids: [456] });
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer signed-test-jwt");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-github-api-version")).toBe("2026-03-10");
  });

  it.each([
    { installationId: 0, repositoryId: 456 },
    { installationId: 1.5, repositoryId: 456 },
    { installationId: Number.MAX_SAFE_INTEGER + 1, repositoryId: 456 },
    { installationId: 123, repositoryId: 0 },
    { installationId: 123, repositoryId: -1 },
    { installationId: 123, repositoryId: Number.NaN },
  ])(
    "rejects invalid immutable IDs before token creation (%#)",
    async ({ installationId, repositoryId }) => {
      const fetchImpl = vi.fn();
      vi.stubGlobal("fetch", fetchImpl);

      await expect(
        getRepositoryInstallationToken(
          installationId,
          repositoryId,
          "test-app-id",
          testPrivateKey,
        ),
      ).rejects.toThrow("must be a positive safe integer");
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("does not expose token request bodies or credentials on failure", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("sensitive-token-response", { status: 422 }),
    );
    vi.stubGlobal("fetch", fetchImpl);

    const error = await getRepositoryInstallationToken(
      123,
      456,
      "sensitive-app-id",
      testPrivateKey,
    ).then(
      () => null,
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "GitHub repository-scoped installation token request failed (HTTP 422)",
    );
    expect((error as Error).message).not.toMatch(/sensitive|repository_ids/i);
  });
});
