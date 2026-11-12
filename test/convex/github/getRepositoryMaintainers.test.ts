import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getRepositoryMaintainers } from "../../../convex/github/helpers";

/**
 * Tests for getRepositoryMaintainers
 *
 * Verifies the org-vs-user distinction so the AI never @-mentions a GitHub
 * organization name (e.g. `@hyodotdev`) as if it were a person. For org-owned
 * repos we resolve real admins; for user-owned repos we include the owner.
 */

type FetchInput = string | URL | Request;

interface FetchScript {
  matcher: (url: string) => boolean;
  status?: number;
  json?: unknown;
  reject?: Error;
}

function buildFetchMock(scripts: FetchScript[]) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: FetchInput) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    const script = scripts.find((s) => s.matcher(url));
    if (!script) {
      throw new Error(`Unexpected fetch call: ${url}`);
    }
    if (script.reject) {
      throw script.reject;
    }
    const status = script.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => script.json,
      text: async () => JSON.stringify(script.json ?? ""),
    } as Response;
  });
  return { fn, calls };
}

const TOKEN = "fake-token";

describe("getRepositoryMaintainers", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("User-owned repositories", () => {
    it("includes the owner login when the owner is a User", async () => {
      const { fn } = buildFetchMock([
        {
          matcher: (url) => url === "https://api.github.com/users/hyochan",
          json: { login: "hyochan", type: "User" },
        },
        {
          matcher: (url) => url.includes("/collaborators"),
          json: [],
        },
      ]);
      globalThis.fetch = fn as unknown as typeof globalThis.fetch;

      const result = await getRepositoryMaintainers("hyochan", "repo", TOKEN);

      expect(result).toEqual(["hyochan"]);
    });

    it("appends collaborators after the user owner without duplicates", async () => {
      const { fn } = buildFetchMock([
        {
          matcher: (url) => url === "https://api.github.com/users/hyochan",
          json: { login: "hyochan", type: "User" },
        },
        {
          matcher: (url) => url.includes("/collaborators"),
          json: [
            { login: "hyochan", type: "User" }, // duplicate of owner
            { login: "alice", type: "User" },
            { login: "bob", type: "User" },
          ],
        },
      ]);
      globalThis.fetch = fn as unknown as typeof globalThis.fetch;

      const result = await getRepositoryMaintainers("hyochan", "repo", TOKEN);

      expect(result).toEqual(["hyochan", "alice", "bob"]);
    });
  });

  describe("Organization-owned repositories", () => {
    it("does NOT include the org login as a maintainer", async () => {
      const { fn } = buildFetchMock([
        {
          matcher: (url) => url === "https://api.github.com/users/hyodotdev",
          json: { login: "hyodotdev", type: "Organization" },
        },
        {
          matcher: (url) => url.includes("/orgs/hyodotdev/members"),
          json: [{ login: "hyochan" }],
        },
        {
          matcher: (url) => url.includes("/collaborators"),
          json: [],
        },
      ]);
      globalThis.fetch = fn as unknown as typeof globalThis.fetch;

      const result = await getRepositoryMaintainers(
        "hyodotdev",
        "openiap",
        TOKEN,
      );

      expect(result).not.toContain("hyodotdev");
      expect(result).toEqual(["hyochan"]);
    });

    it("merges org admins with repo collaborators, deduplicating", async () => {
      const { fn } = buildFetchMock([
        {
          matcher: (url) => url === "https://api.github.com/users/hyodotdev",
          json: { login: "hyodotdev", type: "Organization" },
        },
        {
          matcher: (url) => url.includes("/orgs/hyodotdev/members"),
          json: [{ login: "hyochan" }, { login: "alice" }],
        },
        {
          matcher: (url) => url.includes("/collaborators"),
          json: [
            { login: "alice", type: "User" }, // duplicate of admin
            { login: "carol", type: "User" },
          ],
        },
      ]);
      globalThis.fetch = fn as unknown as typeof globalThis.fetch;

      const result = await getRepositoryMaintainers(
        "hyodotdev",
        "openiap",
        TOKEN,
      );

      expect(result).toEqual(["hyochan", "alice", "carol"]);
    });

    it("handles empty org admin list (e.g. token lacks org permission)", async () => {
      const { fn } = buildFetchMock([
        {
          matcher: (url) => url === "https://api.github.com/users/hyodotdev",
          json: { login: "hyodotdev", type: "Organization" },
        },
        {
          matcher: (url) => url.includes("/orgs/hyodotdev/members"),
          status: 403,
        },
        {
          matcher: (url) => url.includes("/collaborators"),
          json: [{ login: "hyochan", type: "User" }],
        },
      ]);
      globalThis.fetch = fn as unknown as typeof globalThis.fetch;

      const result = await getRepositoryMaintainers(
        "hyodotdev",
        "openiap",
        TOKEN,
      );

      expect(result).toEqual(["hyochan"]);
    });
  });

  describe("Filtering and edge cases", () => {
    it("excludes Bot-type collaborators", async () => {
      const { fn } = buildFetchMock([
        {
          matcher: (url) => url === "https://api.github.com/users/hyochan",
          json: { login: "hyochan", type: "User" },
        },
        {
          matcher: (url) => url.includes("/collaborators"),
          json: [
            { login: "alice", type: "User" },
            { login: "gitdogbot[bot]", type: "Bot" },
            { login: "dependabot[bot]", type: "Bot" },
            { login: "bob", type: "User" },
          ],
        },
      ]);
      globalThis.fetch = fn as unknown as typeof globalThis.fetch;

      const result = await getRepositoryMaintainers("hyochan", "repo", TOKEN);

      expect(result).toEqual(["hyochan", "alice", "bob"]);
      expect(result).not.toContain("gitdogbot[bot]");
      expect(result).not.toContain("dependabot[bot]");
    });

    it("falls back gracefully when owner type lookup fails", async () => {
      const { fn } = buildFetchMock([
        {
          matcher: (url) => url.startsWith("https://api.github.com/users/"),
          status: 500,
        },
        {
          matcher: (url) => url.includes("/collaborators"),
          json: [{ login: "alice", type: "User" }],
        },
      ]);
      globalThis.fetch = fn as unknown as typeof globalThis.fetch;

      const result = await getRepositoryMaintainers("unknown", "repo", TOKEN);

      // Owner type unknown → don't include owner string, but still get collaborators
      expect(result).toEqual(["alice"]);
      expect(result).not.toContain("unknown");
    });

    it("returns empty array when both lookups fail", async () => {
      const { fn } = buildFetchMock([
        {
          matcher: (url) => url.startsWith("https://api.github.com/users/"),
          reject: new Error("network down"),
        },
        {
          matcher: (url) => url.includes("/collaborators"),
          reject: new Error("network down"),
        },
      ]);
      globalThis.fetch = fn as unknown as typeof globalThis.fetch;

      const result = await getRepositoryMaintainers("hyochan", "repo", TOKEN);

      expect(result).toEqual([]);
    });

    it("returns owner only when collaborators endpoint fails", async () => {
      const { fn } = buildFetchMock([
        {
          matcher: (url) => url === "https://api.github.com/users/hyochan",
          json: { login: "hyochan", type: "User" },
        },
        {
          matcher: (url) => url.includes("/collaborators"),
          status: 403,
        },
      ]);
      globalThis.fetch = fn as unknown as typeof globalThis.fetch;

      const result = await getRepositoryMaintainers("hyochan", "repo", TOKEN);

      expect(result).toEqual(["hyochan"]);
    });

    it("uses Bearer token and Gitdog User-Agent", async () => {
      const captured: Array<{ url: string; init?: RequestInit }> = [];
      const fn = vi.fn(async (input: FetchInput, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        captured.push({ url, init });
        if (url.includes("/users/")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ login: "hyochan", type: "User" }),
            text: async () => "",
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => [],
          text: async () => "",
        } as Response;
      });
      globalThis.fetch = fn as unknown as typeof globalThis.fetch;

      await getRepositoryMaintainers("hyochan", "repo", TOKEN);

      for (const call of captured) {
        const headers = call.init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
        expect(headers["User-Agent"]).toBe("Gitdog");
      }
    });
  });

  describe("Regression: openiap/issue-129 scenario", () => {
    it("for hyodotdev/openiap returns @hyochan and never @hyodotdev", async () => {
      const { fn } = buildFetchMock([
        {
          matcher: (url) => url === "https://api.github.com/users/hyodotdev",
          json: { login: "hyodotdev", type: "Organization" },
        },
        {
          matcher: (url) => url.includes("/orgs/hyodotdev/members"),
          json: [{ login: "hyochan" }],
        },
        {
          matcher: (url) => url.includes("/collaborators"),
          json: [{ login: "hyochan", type: "User" }],
        },
      ]);
      globalThis.fetch = fn as unknown as typeof globalThis.fetch;

      const result = await getRepositoryMaintainers(
        "hyodotdev",
        "openiap",
        TOKEN,
      );

      expect(result).toContain("hyochan");
      expect(result).not.toContain("hyodotdev");
      expect(result).toEqual(["hyochan"]);
    });
  });
});
