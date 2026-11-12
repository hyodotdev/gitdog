import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../../../convex/schema";
import { internal } from "../../../convex/_generated/api";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/admin/internalMutation.ts": () =>
    import("../../../convex/admin/internalMutation"),
};
const tokens = 50_016_672_224;

async function fixture(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "hyochan" });
    const profileId = await ctx.db.insert("userProfiles", {
      userId,
      githubUsername: "hyochan",
      isAdmin: false,
      createdAt: 1,
      updatedAt: 1,
    });
    return { userId, profileId };
  });
}

describe("one-time owner test credit", () => {
  it("restores only the approved owner and records non-cash credit without a payment", async () => {
    const t = convexTest(schema, modules);
    const { userId, profileId } = await fixture(t);
    expect(
      await t.mutation(
        internal.admin.internalMutation.provisionOwnerTestCredit,
        { expectedUserId: userId },
      ),
    ).toEqual({
      applied: true,
      tokensGranted: tokens,
      balance: tokens,
      isAdmin: true,
    });
    const state = await t.run(async (ctx) => ({
      profile: await ctx.db.get(profileId),
      wallets: await ctx.db.query("subscriptions").take(10),
      logs: await ctx.db.query("paymentLogs").take(10),
    }));
    expect(state.profile?.isAdmin).toBe(true);
    expect(state.wallets).toHaveLength(1);
    expect(state.wallets[0]).toMatchObject({
      userId,
      plan: "free",
      status: "active",
      purchasedTokens: tokens,
    });
    expect(state.logs).toHaveLength(1);
    expect(state.logs[0]).toMatchObject({
      userId,
      eventType: "admin_credit",
      tokensAdded: tokens,
    });
    expect(state.logs[0].amountCents).toBeUndefined();
    expect(state.logs[0].lemonSqueezyOrderId).toBeUndefined();
  });

  it("does not refill spent credit or restore subsequently revoked privileges on replay", async () => {
    const t = convexTest(schema, modules);
    const { userId, profileId } = await fixture(t);
    const args = { expectedUserId: userId };
    await t.mutation(
      internal.admin.internalMutation.provisionOwnerTestCredit,
      args,
    );
    await t.run(async (ctx) => {
      const wallet = await ctx.db
        .query("subscriptions")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .unique();
      await ctx.db.patch(wallet!._id, { purchasedTokens: tokens - 100 });
      await ctx.db.patch(profileId, { isAdmin: false });
    });
    expect(
      await t.mutation(
        internal.admin.internalMutation.provisionOwnerTestCredit,
        args,
      ),
    ).toEqual({
      applied: false,
      tokensGranted: tokens,
      balance: tokens - 100,
      isAdmin: false,
    });
    expect(
      await t.run(
        async (ctx) => (await ctx.db.query("paymentLogs").take(10)).length,
      ),
    ).toBe(1);
  });

  it("rejects a different user without granting anything", async () => {
    const t = convexTest(schema, modules);
    await fixture(t);
    const other = await t.run(
      async (ctx) => await ctx.db.insert("users", { name: "other" }),
    );
    await expect(
      t.mutation(internal.admin.internalMutation.provisionOwnerTestCredit, {
        expectedUserId: other,
      }),
    ).rejects.toThrow("Owner identity");
    expect(
      await t.run(
        async (ctx) => (await ctx.db.query("subscriptions").take(10)).length,
      ),
    ).toBe(0);
  });

  it("preserves an existing wallet balance", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await fixture(t);
    await t.run(
      async (ctx) =>
        await ctx.db.insert("subscriptions", {
          userId,
          plan: "free",
          status: "active",
          includedTokens: 100_000,
          purchasedTokens: 123,
          serviceFeeRate: 0.25,
          periodStart: 1,
          periodEnd: 2,
          createdAt: 1,
          updatedAt: 1,
        }),
    );
    expect(
      await t.mutation(
        internal.admin.internalMutation.provisionOwnerTestCredit,
        { expectedUserId: userId },
      ),
    ).toMatchObject({ balance: tokens + 123 });
  });
});
