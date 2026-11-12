import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import en from "../../src/i18n/locales/en.json";
import ja from "../../src/i18n/locales/ja.json";
import ko from "../../src/i18n/locales/ko.json";
import { PrivacyPolicyPage } from "../../src/pages/legal/privacy-policy";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { returnObjects?: boolean }) =>
      options?.returnObjects ? [] : key,
  }),
}));

vi.mock("../../src/components/Layout", () => ({
  Layout: ({ children }: { children: ReactNode }) =>
    createElement(Fragment, null, children),
}));

vi.mock("../../src/components/SEO", () => ({
  SEO: () => null,
}));

describe("active AI provider disclosure", () => {
  it("renders active providers without the retired Google section", () => {
    const html = renderToStaticMarkup(createElement(PrivacyPolicyPage));

    expect(html).toContain("legal.privacy.section4.aiGeneration.title");
    expect(html).not.toContain("legal.privacy.section4.googleGemini");
  });

  it.each([
    [
      "English",
      en,
      "Webhook",
      "card",
      "5 years",
      "non-reversible settlement fingerprint",
      "indefinitely",
      "contact data",
    ],
    [
      "Korean",
      ko,
      "웹훅",
      "카드",
      "5년",
      "비가역적 결제 정산 지문",
      "무기한",
      "연락처 정보",
    ],
    [
      "Japanese",
      ja,
      "Webhook",
      "カード",
      "5年間",
      "不可逆の決済照合フィンガープリント",
      "無期限",
      "連絡先情報",
    ],
  ])(
    "keeps the %s policy and terms disclosures complete",
    (
      _name,
      locale,
      webhookText,
      cardText,
      retentionText,
      fingerprintText,
      indefiniteText,
      contactText,
    ) => {
      const generation = locale.legal.privacy.section4.aiGeneration;
      const lemonSqueezy = locale.legal.privacy.section4.lemonSqueezy;
      const retention = locale.legal.privacy.section6.items.join(" ");

      expect(locale.legal.privacy.lastUpdated).toContain("2026");
      expect(locale.legal.terms.lastUpdated).toContain("2026");
      expect(generation.items).toHaveLength(3);
      expect(generation.description).toContain("OpenAI");
      expect(JSON.stringify(locale.legal)).not.toContain("Gemini");
      expect(lemonSqueezy.note).toContain(webhookText);
      expect(lemonSqueezy.note).toContain(cardText);
      expect(retention).toContain(retentionText);
      expect(retention).toContain(fingerprintText);
      expect(retention).toContain(indefiniteText);
      expect(retention).toContain(contactText);
      expect(locale.legal.terms.section6.yourContent.description).not.toContain(
        "Google",
      );
    },
  );
});
