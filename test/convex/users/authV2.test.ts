import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "../../../convex/_generated/api";
import schema from "../../../convex/schema";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/users/internalMutation.ts": () =>
    import("../../../convex/users/internalMutation"),
  "../../../convex/users/migrations.ts": () =>
    import("../../../convex/users/migrations"),
};

const profile = (id: string, login = "octocat") => ({
  id,
  login,
  email: `${login}@example.com`,
  emailVerified: true,
  avatarUrl: `https://avatars.example/${login}`,
});

describe("GitHub sign-in user callbacks", () => {
  it("creates one user per GitHub account and reuses a user from before 2.0", async () => {
    const t = convexTest(schema, modules);
    const existing = await t.run((ctx) =>
      ctx.db.insert("users", { name: "old", githubAccountId: "654" }),
    );

    const returning = await t.mutation(
      internal.users.internalMutation.createUserFromGithub,
      { method: { name: "github", profile: profile("654") } },
    );
    const newcomer = await t.mutation(
      internal.users.internalMutation.createUserFromGithub,
      { method: { name: "github", profile: profile("777", "newcomer") } },
    );

    expect(returning).toBe(existing);
    const users = await t.run((ctx) => ctx.db.query("users").collect());
    expect(users).toHaveLength(2);
    expect(users.find((user) => user._id === newcomer)).toMatchObject({
      name: "newcomer",
      githubAccountId: "777",
      email: "newcomer@example.com",
      image: "https://avatars.example/newcomer",
    });
  });

  it("refreshes the profile and refuses a different GitHub account", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { name: "old", githubAccountId: "654" }),
    );

    await t.mutation(internal.users.internalMutation.updateUserFromGithub, {
      method: { name: "github", profile: profile("654", "renamed") },
      userId,
    });
    await expect(
      t.mutation(internal.users.internalMutation.updateUserFromGithub, {
        method: { name: "github", profile: profile("999", "attacker") },
        userId,
      }),
    ).rejects.toThrow("identity changed");

    expect(await t.run((ctx) => ctx.db.get(userId))).toMatchObject({
      name: "renamed",
      githubAccountId: "654",
    });
  });
});

describe("@convex-dev/auth 2.0 migration", () => {
  it("keeps the account of someone who signs in before the migration runs", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { name: "octocat" });
      await ctx.db.insert("authAccounts", {
        userId,
        provider: "github",
        providerAccountId: "654",
      });
      return userId;
    });

    const signedIn = await t.mutation(
      internal.users.internalMutation.createUserFromGithub,
      { method: { name: "github", profile: profile("654") } },
    );
    const migrated = await t.mutation(
      internal.users.migrations.migrateToAuthV2,
      {},
    );

    expect(signedIn).toBe(userId);
    expect(migrated).toMatchObject({ linkedUsers: 0, done: true });
    await expect(
      t.run((ctx) => ctx.db.query("users").collect()),
    ).resolves.toEqual([expect.objectContaining({ githubAccountId: "654" })]);
  });

  it("links each GitHub account to its user and deletes the old auth rows", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { name: "octocat" });
      await ctx.db.insert("authAccounts", {
        userId,
        provider: "github",
        providerAccountId: "654",
      });
      const sessionId = await ctx.db.insert("authSessions", {
        userId,
        expirationTime: Date.now() + 1_000,
      });
      await ctx.db.insert("authRefreshTokens", {
        sessionId,
        expirationTime: Date.now() + 1_000,
      });
      return userId;
    });

    const first = await t.mutation(
      internal.users.migrations.migrateToAuthV2,
      {},
    );
    const again = await t.mutation(
      internal.users.migrations.migrateToAuthV2,
      {},
    );

    expect(first).toEqual({ linkedUsers: 1, deletedRows: 3, done: true });
    expect(again).toEqual({ linkedUsers: 0, deletedRows: 0, done: true });
    expect((await t.run((ctx) => ctx.db.get(userId)))?.githubAccountId).toBe(
      "654",
    );
    for (const table of [
      "authAccounts",
      "authSessions",
      "authRefreshTokens",
    ] as const)
      await expect(
        t.run((ctx) => ctx.db.query(table).collect()),
      ).resolves.toEqual([]);
  });

  it("stops without deleting anything when a GitHub account is claimed twice", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("users", { githubAccountId: "654" });
      const other = await ctx.db.insert("users", {});
      await ctx.db.insert("authAccounts", {
        userId: other,
        provider: "github",
        providerAccountId: "654",
      });
    });

    await expect(
      t.mutation(internal.users.migrations.migrateToAuthV2, {}),
    ).rejects.toThrow("conflicts");
    await expect(
      t.run((ctx) => ctx.db.query("authAccounts").collect()),
    ).resolves.toHaveLength(1);
  });
});
