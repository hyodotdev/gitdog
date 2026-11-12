import { action } from "../_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { api, internal } from "../_generated/api";

export const ensureProfile = action({
  args: {},
  handler: async (ctx): Promise<void> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return;
    }

    // Check if profile exists
    const currentUser = await ctx.runQuery(api.users.query.getCurrentUser);

    if (currentUser?.profile) {
      return;
    }

    if (!currentUser) {
      return;
    }

    // Extract GitHub username from user data
    const githubUsername =
      (currentUser as { githubUsername?: string }).githubUsername ||
      currentUser.name;

    if (!githubUsername) {
      console.warn("Cannot create profile: GitHub username not available");
      return;
    }

    // Create profile
    await ctx.runMutation(internal.users.mutation.createOrUpdateProfile, {
      githubUsername,
      displayName: currentUser.name,
      avatarUrl: currentUser.image,
    });
  },
});
