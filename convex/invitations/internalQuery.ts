import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { checkProSubscription } from "../_utils/accessControl";
import {
  getExactGitHubInstallation,
  isGitHubInstallationReady,
} from "../github/installationAccess";
import { isInvitationRepositoryAvailable } from "./availability";

/** Authorize the external lookup without trusting any client installation ID. */
export const getCreationContext = internalQuery({
  args: {
    inviterUserId: v.id("users"),
    repositoryId: v.id("repositories"),
  },
  handler: async (ctx, args) => {
    if (!(await checkProSubscription(ctx, args.inviterUserId))) {
      throw new Error("Pro subscription required to invite members");
    }

    const repository = await ctx.db.get(args.repositoryId);
    if (!repository || repository.userId !== args.inviterUserId) {
      throw new Error("Only repository owner can invite members");
    }
    if (!isInvitationRepositoryAvailable(repository)) {
      throw new Error("Repository is no longer available");
    }

    const installation = await getExactGitHubInstallation(
      ctx,
      repository.installationId,
    );
    if (
      !isGitHubInstallationReady(installation) ||
      installation.userId !== args.inviterUserId ||
      installation.installationId !== repository.installationId
    ) {
      throw new Error("GitHub App installation is not ready");
    }

    return { installationId: installation.installationId };
  },
});
