import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../../../convex/_generated/api";
import {
  ACCESS_VERIFICATION_CALLBACK_PATH,
  ACCESS_VERIFICATION_TTL_MS,
  hashState,
  readReturnPath,
} from "../../../convex/github/accessVerification";
import { GITHUB_INSTALLATION_ATTESTATION_TTL_MS } from "../../../convex/github/oauthInstallationAttestation";
import schema from "../../../convex/schema";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/github/action.ts": () =>
    import("../../../convex/github/action"),
  "../../../convex/github/internalMutation.ts": () =>
    import("../../../convex/github/internalMutation"),
  "../../../convex/http.ts": () => import("../../../convex/http"),
};

const ENV = {
  SITE_URL: "https://gitdog.dev",
  CONVEX_SITE_URL: "https://example.convex.site",
  CUSTOM_AUTH_SITE_URL: "https://auth.gitdog.dev",
  GITHUB_APP_CLIENT_ID: "Iv1.client",
  GITHUB_APP_CLIENT_SECRET: "client-secret",
};
const original: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const [name, value] of Object.entries(ENV)) {
    original[name] = process.env[name];
    process.env[name] = value;
  }
});

afterEach(() => {
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function setup(linkedAccountId = "654") {
  const t = convexTest(schema, modules);
  const userId = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "octocat" });
    await ctx.db.insert("authAccounts", {
      userId,
      provider: "github",
      providerAccountId: linkedAccountId,
    });
    return userId;
  });
  const as = t.withIdentity({ subject: `${userId}|session` });
  return { t, as, userId };
}

/** GitHub as seen from the callback: token exchange, user, installations. */
function stubGitHub(githubUserId = 654) {
  const requests: string[] = [];
  const exchanges: Record<string, string>[] = [];
  const github = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "https://github.com/login/oauth/access_token") {
      exchanges.push(JSON.parse(String(init?.body)));
      return Response.json({ access_token: "user-token" });
    }
    if (url === "https://api.github.com/user")
      return Response.json({ id: githubUserId, login: "octocat" });
    if (url.startsWith("https://api.github.com/user/installations"))
      return Response.json({
        total_count: 2,
        installations: [{ id: 9 }, { id: 3 }],
      });
    if (url.startsWith("https://api.github.com/applications/"))
      return new Response(null, { status: 204 });
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", github);
  return Object.assign(requests, { exchanges });
}

async function start(as: Awaited<ReturnType<typeof setup>>["as"]) {
  const { url } = await as.action(api.github.action.startAccessVerification, {
    returnPath: "/repositories/connect?reconnect=1",
  });
  const authorize = new URL(url);
  return { authorize, state: authorize.searchParams.get("state")! };
}

async function callback(
  t: Awaited<ReturnType<typeof setup>>["t"],
  params: Record<string, string>,
) {
  const response = await t.fetch(
    `${ACCESS_VERIFICATION_CALLBACK_PATH}?${new URLSearchParams(params)}`,
    { method: "GET" },
  );
  expect(response.status).toBe(302);
  return new URL(response.headers.get("Location")!);
}

describe("Verify GitHub access", () => {
  it("authorizes on GitHub and stores only a hash of the state", async () => {
    const { t, as, userId } = await setup();
    const { authorize, state } = await start(as);

    expect(authorize.origin + authorize.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(authorize.searchParams.get("client_id")).toBe("Iv1.client");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("code_challenge")).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      `https://auth.gitdog.dev${ACCESS_VERIFICATION_CALLBACK_PATH}`,
    );
    const rows = await t.run((ctx) =>
      ctx.db.query("githubAccessVerifications").collect(),
    );
    expect(rows).toEqual([
      expect.objectContaining({
        userId,
        stateHash: await hashState(state),
        returnPath: "/repositories/connect?reconnect=1",
      }),
    ]);
    expect(JSON.stringify(rows)).not.toContain(state);
  });

  it("records the installations of the linked account and revokes the token", async () => {
    const { t, as, userId } = await setup();
    const { state } = await start(as);
    const requests = stubGitHub();

    const location = await callback(t, { code: "abc", state });

    expect(location.toString()).toBe(
      "https://gitdog.dev/repositories/connect?reconnect=1&githubAccess=verified",
    );
    const attestations = await t.run((ctx) =>
      ctx.db.query("githubOAuthInstallationAttestations").collect(),
    );
    expect(attestations).toEqual([
      expect.objectContaining({
        userId,
        githubAccountId: "654",
        installationIds: [3, 9],
      }),
    ]);
    const [verification] = requests.exchanges;
    expect(verification.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(attestations[0].expiresAt - attestations[0].attestedAt).toBe(
      GITHUB_INSTALLATION_ATTESTATION_TTL_MS,
    );
    expect(requests).toContain(
      "DELETE https://api.github.com/applications/Iv1.client/token",
    );
    expect(JSON.stringify(attestations)).not.toContain("user-token");
  });

  it("refuses another GitHub account than the one signed in", async () => {
    const { t, as } = await setup("654");
    const { state } = await start(as);
    const requests = stubGitHub(999);

    const location = await callback(t, { code: "abc", state });

    expect(location.searchParams.get("githubAccess")).toBe("account_mismatch");
    expect(requests).toContain(
      "DELETE https://api.github.com/applications/Iv1.client/token",
    );
    await expect(
      t.run((ctx) =>
        ctx.db.query("githubOAuthInstallationAttestations").collect(),
      ),
    ).resolves.toEqual([]);
  });

  it("accepts each state once and only before it expires", async () => {
    const now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const { t, as } = await setup();
    stubGitHub();

    const first = await start(as);
    await callback(t, { code: "abc", state: first.state });
    const reused = await callback(t, { code: "abc", state: first.state });
    expect(reused.searchParams.get("githubAccess")).toBe("failed");
    expect(reused.pathname).toBe("/repositories/connect");

    const late = await start(as);
    clock.mockReturnValue(now + ACCESS_VERIFICATION_TTL_MS);
    const expired = await callback(t, { code: "abc", state: late.state });
    expect(expired.searchParams.get("githubAccess")).toBe("failed");
  });

  it("reports a cancelled authorization without calling GitHub", async () => {
    const { t, as } = await setup();
    const { state } = await start(as);
    const requests = stubGitHub();

    const location = await callback(t, { error: "access_denied", state });

    expect(location.searchParams.get("githubAccess")).toBe("cancelled");
    expect([...requests]).toEqual([]);
  });

  it("reports other GitHub errors as failures, not cancellations", async () => {
    const { t, as } = await setup();
    const { state } = await start(as);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const location = await callback(t, {
      error: "redirect_uri_mismatch",
      state,
    });

    expect(location.searchParams.get("githubAccess")).toBe("failed");
  });

  it("keeps the return path on Gitdog's site", async () => {
    const { as } = await setup();
    for (const path of [
      "https://evil.example",
      "//evil.example",
      "/\\evil",
      "/..//evil.example",
      "/.//evil.example",
      "/%2e%2e//evil.example",
      "/a/..//evil.example/x",
    ])
      await expect(
        as.action(api.github.action.startAccessVerification, {
          returnPath: path,
        }),
      ).rejects.toThrow("Invalid return path");
    expect(readReturnPath("/repositories/connect?x=1#frag")).toBe(
      "/repositories/connect?x=1",
    );
  });
});
