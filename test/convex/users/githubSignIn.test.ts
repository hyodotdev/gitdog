import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "../../../convex/_generated/api";
import schema from "../../../convex/schema";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/users/internalMutation.ts": () =>
    import("../../../convex/users/internalMutation"),
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
