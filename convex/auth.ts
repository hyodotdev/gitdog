import { convexAuth } from "@convex-dev/auth/server";
import GitHub from "@auth/core/providers/github";
import type { MutationCtx } from "./_generated/server";
import { resolveAuthRedirect } from "./_utils/authRedirect";
import {
  fetchAccessibleGitHubInstallationIds,
  persistGitHubInstallationAttestation,
} from "./github/oauthInstallationAttestation";

export const { auth, signIn, signOut, store } = convexAuth({
  providers: [
    GitHub({
      clientId: process.env.GITHUB_APP_CLIENT_ID,
      clientSecret: process.env.GITHUB_APP_CLIENT_SECRET,
      async profile(profile, tokens) {
        const githubAccountId = profile.id.toString();
        const accessToken = tokens.access_token;
        if (typeof accessToken !== "string" || accessToken.trim() === "") {
          throw new Error("GitHub user authorization is unavailable");
        }
        const githubInstallationIds =
          await fetchAccessibleGitHubInstallationIds(accessToken);
        return {
          id: githubAccountId,
          name: profile.login, // Use login (username) instead of display name
          email: typeof profile.email === "string" ? profile.email : undefined,
          image: profile.avatar_url,
          githubAccountId,
          githubInstallationIds,
        };
      },
    }),
  ],
  callbacks: {
    redirect: async ({ redirectTo }) => {
      const siteUrl = process.env.SITE_URL;
      if (!siteUrl) throw new Error("SITE_URL is not configured");
      return resolveAuthRedirect(redirectTo, siteUrl);
    },
    createOrUpdateUser: async (ctx, args) =>
      await persistGitHubInstallationAttestation(ctx as MutationCtx, args),
  },
});
