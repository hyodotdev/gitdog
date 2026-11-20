import { v } from "convex/values";
import { vGithubProfile } from "@convex-dev/auth/methods/github/server";
import type { GithubProfile } from "@convex-dev/auth/methods/github/server";
import { internalMutation } from "../_generated/server";

const githubSignIn = v.object({
  name: v.literal("github"),
  profile: vGithubProfile,
});

function profileFields(profile: GithubProfile, now: number) {
  return {
    name: profile.login,
    image: profile.avatarUrl,
    email: profile.email,
    emailVerificationTime: profile.emailVerified ? now : undefined,
  };
}

/**
 * Create the Gitdog user for a GitHub account the GitHub auth component has
 * not seen. A user who already has that GitHub account is returned instead:
 * every user from before @convex-dev/auth 2.0 reaches this on their first
 * 2.0 sign-in, so this is how they keep their account.
 */
export const createUserFromGithub = internalMutation({
  args: { method: githubSignIn },
  returns: v.id("users"),
  handler: async (ctx, { method }) => {
    const githubAccountId = method.profile.id;
    const existing = await ctx.db
      .query("users")
      .withIndex("by_github_account_id", (q) =>
        q.eq("githubAccountId", githubAccountId),
      )
      .unique();
    if (existing) return existing._id;
    return await ctx.db.insert("users", {
      ...profileFields(method.profile, Date.now()),
      githubAccountId: method.profile.id,
    });
  },
});

/** Refresh the user's GitHub profile on every sign-in. */
export const updateUserFromGithub = internalMutation({
  args: { method: githubSignIn, userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, { method, userId }) => {
    const user = await ctx.db.get(userId);
    if (!user) throw new Error("User not found");
    if (user.githubAccountId !== method.profile.id)
      throw new Error("GitHub account identity changed during sign-in");
    await ctx.db.patch(userId, profileFields(method.profile, Date.now()));
    return null;
  },
});
