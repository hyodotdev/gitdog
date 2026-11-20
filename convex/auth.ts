import { setupConvexAuth } from "@convex-dev/auth/server";
import { setupGithub } from "@convex-dev/auth/methods/github/server";
import { components, internal } from "./_generated/api";
import { allowedSignInOrigins } from "./_utils/authRedirect";

const siteUrl = process.env.SITE_URL;
if (!siteUrl) throw new Error("SITE_URL is not configured");

// One-hour access tokens, as before 2.0: GITDOG_TOKEN automation sends one
// without refreshing it.
const core = setupConvexAuth({
  component: components.auth,
  accessTokenTtlSeconds: 60 * 60,
});

export const { signOut, refreshSession, isAuthenticated } = core;

export const { startSignInWithGithub, completeSignInWithGithub } = setupGithub(
  core,
  {
    component: components.authGithub,
    allowedRedirectOrigins: allowedSignInOrigins(siteUrl),
  },
).attachUserCallbacks({
  createUser: internal.users.internalMutation.createUserFromGithub,
  onSignIn: internal.users.internalMutation.updateUserFromGithub,
});
