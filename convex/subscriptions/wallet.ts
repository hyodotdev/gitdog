import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

const MAX_USER_WALLET_ROWS = 100;
type WalletReadCtx = Pick<MutationCtx | QueryCtx, "db">;

export async function getUserWalletRows(
  ctx: WalletReadCtx,
  userId: Id<"users">,
): Promise<Doc<"subscriptions">[]> {
  const rows = await ctx.db
    .query("subscriptions")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(MAX_USER_WALLET_ROWS + 1);
  if (rows.length > MAX_USER_WALLET_ROWS) {
    throw new Error("User has too many subscription wallet rows");
  }
  return rows;
}

function sumPurchasedTokenWallet(rows: Doc<"subscriptions">[]): number {
  let total = 0;
  for (const row of rows) {
    const balance = row.purchasedTokens;
    if (!Number.isSafeInteger(balance) || balance < 0) {
      throw new Error("Invalid existing purchased token balance");
    }
    total += balance;
    if (!Number.isSafeInteger(total)) {
      throw new Error("Purchased token balance exceeds the supported range");
    }
  }
  return total;
}

export async function readPurchasedTokenWalletBalance(
  ctx: WalletReadCtx,
  userId: Id<"users">,
): Promise<number> {
  return sumPurchasedTokenWallet(await getUserWalletRows(ctx, userId));
}

export async function consolidatePurchasedTokenWallet(
  ctx: MutationCtx,
  args: {
    userId: Id<"users">;
    targetSubscriptionId: Id<"subscriptions">;
    tokensToAdd?: number;
    // Credited tokens that are trial rather than paid.
    trialTokensToAdd?: number;
    now: number;
  },
): Promise<number> {
  const rows = await getUserWalletRows(ctx, args.userId);
  if (!rows.some((row) => row._id === args.targetSubscriptionId)) {
    throw new Error("Wallet target does not belong to the user");
  }
  const currentTotal = sumPurchasedTokenWallet(rows);
  const tokensToAdd = args.tokensToAdd ?? 0;
  const trialTokensToAdd = args.trialTokensToAdd ?? 0;
  if (
    !Number.isSafeInteger(tokensToAdd) ||
    tokensToAdd < 0 ||
    !Number.isSafeInteger(trialTokensToAdd) ||
    trialTokensToAdd < 0 ||
    trialTokensToAdd > tokensToAdd
  ) {
    throw new Error("Invalid purchased token amount");
  }
  const nextTotal = currentTotal + tokensToAdd;
  if (!Number.isSafeInteger(nextTotal)) {
    throw new Error("Purchased token balance exceeds the supported range");
  }
  const nextTrial = Math.min(
    nextTotal,
    rows.reduce((total, row) => total + (row.trialTokens ?? 0), 0) +
      trialTokensToAdd,
  );
  for (const row of rows) {
    const target = row._id === args.targetSubscriptionId;
    const nextBalance = target ? nextTotal : 0;
    const nextRowTrial = target && nextTrial > 0 ? nextTrial : undefined;
    if (
      row.purchasedTokens !== nextBalance ||
      row.trialTokens !== nextRowTrial
    ) {
      await ctx.db.patch(row._id, {
        purchasedTokens: nextBalance,
        trialTokens: nextRowTrial,
        updatedAt: args.now,
      });
    }
  }
  return nextTotal;
}

/** The unspent trial inside a consolidated wallet row. */
export async function readTrialTokens(
  ctx: WalletReadCtx,
  subscriptionId: Id<"subscriptions">,
): Promise<number> {
  return (await ctx.db.get(subscriptionId))?.trialTokens ?? 0;
}

export async function debitPurchasedTokenWallet(
  ctx: MutationCtx,
  args: {
    userId: Id<"users">;
    targetSubscriptionId: Id<"subscriptions">;
    tokensToDebit: number;
    now: number;
  },
): Promise<{ debited: number; remaining: number }> {
  if (!Number.isSafeInteger(args.tokensToDebit) || args.tokensToDebit < 0) {
    throw new Error("Invalid purchased token debit");
  }
  const balance = await consolidatePurchasedTokenWallet(ctx, {
    userId: args.userId,
    targetSubscriptionId: args.targetSubscriptionId,
    now: args.now,
  });
  const debited = Math.min(balance, args.tokensToDebit);
  const remaining = balance - debited;
  if (debited > 0) {
    // Spend the trial first so paid tokens stay refundable.
    const trial = await readTrialTokens(ctx, args.targetSubscriptionId);
    const remainingTrial = Math.max(0, trial - debited);
    await ctx.db.patch(args.targetSubscriptionId, {
      purchasedTokens: remaining,
      trialTokens: remainingTrial > 0 ? remainingTrial : undefined,
      updatedAt: args.now,
    });
  }
  return { debited, remaining };
}
