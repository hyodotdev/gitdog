import { internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { readQuotaTokenUsage } from "./quota";
import { hasUsageTotals } from "./totals";

/** Compare a period's hourly totals with the sum of its usage rows. */
export const verifyUsageTotals = internalQuery({
  args: {
    userId: v.id("users"),
    periodStart: v.number(),
    periodEndExclusive: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const [rows, totals, ready] = await Promise.all([
      readQuotaTokenUsage(ctx, args, "rows"),
      readQuotaTokenUsage(ctx, args, "totals"),
      hasUsageTotals(ctx, args.userId),
    ]);
    return {
      ready,
      rows,
      totals,
      matches:
        rows.verified &&
        totals.verified &&
        rows.tokensUsed === totals.tokensUsed &&
        rows.purchasedTokensDebited === totals.purchasedTokensDebited,
    };
  },
});
