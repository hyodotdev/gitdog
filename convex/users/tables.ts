import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Gitdog's users. @convex-dev/auth 2.0 stores only the ids the sign-in
 * callbacks return, so the GitHub account a user signs in with is kept here.
 */
export const usersTable = defineTable({
  name: v.optional(v.string()),
  image: v.optional(v.string()),
  email: v.optional(v.string()),
  emailVerificationTime: v.optional(v.number()),
  // The GitHub user id (numeric, as a string) the user signs in with.
  githubAccountId: v.optional(v.string()),
  // Written by @convex-dev/auth 0.0.x for methods Gitdog never enabled.
  phone: v.optional(v.string()),
  phoneVerificationTime: v.optional(v.number()),
  isAnonymous: v.optional(v.boolean()),
}).index("by_github_account_id", ["githubAccountId"]);
