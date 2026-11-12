import { describe, expect, it } from "vitest";

import en from "../../src/i18n/locales/en.json";
import ja from "../../src/i18n/locales/ja.json";
import ko from "../../src/i18n/locales/ko.json";
import {
  calculateEstimatedAdditionalUsageCharge,
  calculateTokenAvailability,
  getUtcMonthlyPeriod,
} from "../../src/utils/pricingConfig";

describe("usage token availability", () => {
  it("treats purchasedTokens as the durable remaining wallet", () => {
    expect(
      calculateTokenAvailability({
        includedTokens: 100_000,
        remainingPurchasedTokens: 40,
        purchasedTokensDebited: 60,
      }),
    ).toEqual({
      remainingPurchasedTokens: 40,
      totalAvailableTokens: 100_100,
    });
  });

  it("does not estimate postpaid usage charges for either prepaid plan", () => {
    expect(calculateEstimatedAdditionalUsageCharge()).toBe(0);
  });

  it("uses exact UTC calendar-month bounds as the defensive UI fallback", () => {
    expect(getUtcMonthlyPeriod(Date.UTC(2026, 11, 31, 23, 59))).toEqual({
      periodStart: Date.UTC(2026, 11, 1),
      periodEnd: Date.UTC(2027, 0, 1),
    });
  });

  it.each([
    ["English", en, /billed|beyond the free tier|10 actions/i],
    ["Korean", ko, /과금|무료 티어 이후|10개 액션/],
    ["Japanese", ja, /課金|無料枠を超え|10アクション/],
  ])(
    "describes the free-plan hard limit consistently in %s",
    (_name, locale, forbiddenPattern) => {
      const copy = [
        locale.home.landing.ctaBottomSubtitle,
        locale.usage.approachingFreeLimit,
        locale.usage.freeLimitReached,
        locale.billing.subtitle,
        locale.billing.freeDescription,
        locale.upgrade.limitReached.message,
        locale.upgrade.currentlyOnFree,
      ].join(" ");

      expect(locale.usage.approachingFreeLimit).toContain("{{limit}}");
      expect(locale.usage.freeLimitReached).not.toContain("{{cost}}");
      expect(copy).toContain("100k");
      expect(copy).not.toMatch(forbiddenPattern);
    },
  );
});
