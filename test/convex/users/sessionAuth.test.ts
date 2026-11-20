import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerGithubOauth } from "@convex-dev/auth/components/github/test";
import { api, components } from "../../../convex/_generated/api";
import schema from "../../../convex/schema";
import { asUser } from "../../helpers/auth";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/auth.ts": () => import("../../../convex/auth"),
  "../../../convex/users/query.ts": () => import("../../../convex/users/query"),
};

const createUser = (t: ReturnType<typeof convexTest>) =>
  t.run((ctx) =>
    ctx.db.insert("users", { name: "octocat", githubAccountId: "654" }),
  );

describe("session authentication", () => {
  it("resolves the user only through a live session", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    const signedIn = await asUser(t, userId);

    expect(await signedIn.query(api.users.query.getCurrentUser)).toMatchObject({
      _id: userId,
    });
    // A token whose subject is a user id rather than a session is not a sign-in.
    expect(
      await t
        .withIdentity({ subject: userId })
        .query(api.users.query.getCurrentUser),
    ).toBeNull();
  });

  it("rejects a session after it is revoked", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    const signedIn = await asUser(t, userId);
    expect(await signedIn.query(api.users.query.getCurrentUser)).not.toBeNull();
    const sessionIds = await t.run((ctx) =>
      ctx.runQuery(components.auth.public.listSessions, { userId }),
    );

    await t.run((ctx) =>
      ctx.runMutation(components.auth.public.revokeSessions, {
        sessionIds: sessionIds.map((session) => session.sessionId),
      }),
    );

    expect(await signedIn.query(api.users.query.getCurrentUser)).toBeNull();
  });
});

describe("GitHub sign-in redirects", () => {
  beforeEach(() => {
    vi.stubEnv("SITE_URL", "https://gitdog.dev");
    vi.stubEnv("CONVEX_SITE_URL", "https://gitdog-test.convex.site");
    vi.stubEnv("CLIENT_ID", "test-client-id");
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    "https://gitdog.dev/repositories",
    "http://127.0.0.1:41721/callback",
  ])("accepts a sign-in that returns to %s", async (redirectTo) => {
    const t = convexTest(schema, modules);
    registerGithubOauth(t);

    // convex-test mounts components without an httpPrefix, so an accepted
    // redirect stops later, when the callback URL is built.
    await expect(
      t.mutation(api.auth.startSignInWithGithub, { redirectTo }),
    ).rejects.toThrow(/httpPrefix/);
  });

  it.each([
    "https://evil.example/repositories",
    "https://gitdog.dev.evil.example/",
    "http://127.0.0.1:41726/callback",
    "http://localhost:41721/callback",
    "/repositories",
  ])("refuses to return to %s", async (redirectTo) => {
    const t = convexTest(schema, modules);

    await expect(
      t.mutation(api.auth.startSignInWithGithub, { redirectTo }),
    ).rejects.toThrow(/redirectTo/);
  });
});
