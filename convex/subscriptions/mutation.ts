import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation } from "../_generated/server";
import { grantTrialCreditOnce } from "./credit";

/** Claim the one-time trial credit; later calls change nothing. */
export const claimTrialCredit = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { granted: false, tokens: 0 };
    return await grantTrialCreditOnce(ctx, userId);
  },
});
