import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "../../../convex/_generated/api";
import {
  FREE_MONTHLY_ALLOWANCE_ENDS_AT,
  getFreeIncludedTokens,
  LEGACY_FREE_MONTHLY_TOKENS,
  PRICING,
} from "../../../convex/_ai/config";
import { getEffectiveSubscriptionEntitlement } from "../../../convex/subscriptions/entitlement";
import schema from "../../../convex/schema";

const modules = import.meta.glob("../../../convex/**/*.ts");
const AFTER_CUTOFF = Date.parse("2026-12-15T12:00:00Z");

afterEach(() => {
  vi.restoreAllMocks();
});

async function signedIn(t: ReturnType<typeof convexTest>) {
  const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
  return { userId, as: t.withIdentity({ subject: `${userId}|session` }) };
}

async function wallet(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query("subscriptions").collect();
    return rows.reduce((total, row) => total + row.purchasedTokens, 0);
  });
}

describe("free monthly allowance cutoff", () => {
  it("keeps the allowance only for free periods that started before the cutoff", () => {
    expect(getFreeIncludedTokens(Date.parse("2026-11-01T00:00:00Z"))).toBe(
      LEGACY_FREE_MONTHLY_TOKENS,
    );
    expect(getFreeIncludedTokens(FREE_MONTHLY_ALLOWANCE_ENDS_AT)).toBe(0);
    expect(
      getEffectiveSubscriptionEntitlement(null, AFTER_CUTOFF),
    ).toMatchObject({ plan: "free", includedTokens: 0 });
    expect(
      getEffectiveSubscriptionEntitlement(
        null,
        Date.parse("2026-11-20T00:00:00Z"),
      ),
    ).toMatchObject({
      plan: "free",
      includedTokens: LEGACY_FREE_MONTHLY_TOKENS,
    });
  });
});

describe("one-time trial credit", () => {
  it("grants the trial once, even after wallet rows are removed", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await signedIn(t);
    await expect(
      as.mutation(api.subscriptions.mutation.claimTrialCredit, {}),
    ).resolves.toEqual({ granted: true, tokens: PRICING.TRIAL_TOKENS });
    expect(await wallet(t)).toBe(PRICING.TRIAL_TOKENS);

    await expect(
      as.mutation(api.subscriptions.mutation.claimTrialCredit, {}),
    ).resolves.toEqual({ granted: false, tokens: PRICING.TRIAL_TOKENS });
    await t.mutation(internal.subscriptions.internalMutation.grantTrialCredit, {
      userId,
    });
    expect(await wallet(t)).toBe(PRICING.TRIAL_TOKENS);

    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("subscriptions").collect())
        await ctx.db.delete(row._id);
    });
    await as.mutation(api.subscriptions.mutation.claimTrialCredit, {});
    expect(await wallet(t)).toBe(0);
  });

  it("does nothing for signed-out callers", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.subscriptions.mutation.claimTrialCredit, {}),
    ).resolves.toEqual({ granted: false, tokens: 0 });
    expect(await wallet(t)).toBe(0);
  });

  it("is the only Gitdog allowance a free account has after the cutoff", async () => {
    vi.spyOn(Date, "now").mockReturnValue(AFTER_CUTOFF);
    const t = convexTest(schema, modules);
    const { userId, as } = await signedIn(t);
    await expect(
      t.query(internal.subscriptions.internalQuery.canPerformActionInternal, {
        userId,
      }),
    ).resolves.toMatchObject({ allowed: false });

    await as.mutation(api.subscriptions.mutation.claimTrialCredit, {});
    await expect(
      t.query(internal.subscriptions.internalQuery.canPerformActionInternal, {
        userId,
      }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      as.query(api.subscriptions.query.getCurrent, {}),
    ).resolves.toMatchObject({
      plan: "free",
      includedTokens: 0,
      purchasedTokens: PRICING.TRIAL_TOKENS,
    });
  });

  it("schedules the trial when the user accepts the terms", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "octocat" }),
    );
    const as = t.withIdentity({ subject: `${userId}|session` });
    const { CURRENT_PRIVACY_POLICY_VERSION, CURRENT_TERMS_VERSION } =
      await import("../../../convex/users/legal");
    vi.useFakeTimers();
    try {
      await as.mutation(api.users.mutation.attestLegalEligibility, {
        minimumAgeConfirmed: true,
        professionalUseConfirmed: true,
        termsAccepted: true,
        privacyPolicyAccepted: true,
        displayedTermsVersion: CURRENT_TERMS_VERSION,
        displayedPrivacyPolicyVersion: CURRENT_PRIVACY_POLICY_VERSION,
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }
    expect(await wallet(t)).toBe(PRICING.TRIAL_TOKENS);
  });
});
