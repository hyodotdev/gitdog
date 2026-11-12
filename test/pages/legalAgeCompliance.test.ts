import { readFile } from "node:fs/promises";
import { glob } from "glob";
import { describe, expect, it } from "vitest";

import {
  CURRENT_LEGAL_CONSENT_VERSION,
  DISPLAYED_PRIVACY_POLICY_VERSION,
  DISPLAYED_TERMS_VERSION,
  clearPendingLegalConsent,
  createLegalConsentUrl,
  createGitHubReauthorizationConsentUrl,
  getLegalConsentReturnPath,
  hasPendingLegalConsent,
  isLegalConsentExemptPath,
  isGitHubReauthorizationRequested,
  markPendingLegalConsent,
  shouldShowLegalConsentLoadingState,
} from "../../src/utils/legalConsent";
import en from "../../src/i18n/locales/en.json";
import ja from "../../src/i18n/locales/ja.json";
import ko from "../../src/i18n/locales/ko.json";
import {
  CURRENT_PRIVACY_POLICY_VERSION,
  CURRENT_TERMS_VERSION,
} from "../../convex/users/legal";

function createMemoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe("legal age compliance", () => {
  it("keeps the client and server policy versions aligned", () => {
    expect(CURRENT_LEGAL_CONSENT_VERSION).toBe(CURRENT_TERMS_VERSION);
    expect(CURRENT_LEGAL_CONSENT_VERSION).toBe(CURRENT_PRIVACY_POLICY_VERSION);
    expect(DISPLAYED_TERMS_VERSION).toBe(CURRENT_TERMS_VERSION);
    expect(DISPLAYED_PRIVACY_POLICY_VERSION).toBe(
      CURRENT_PRIVACY_POLICY_VERSION,
    );
  });

  it("stores pending pre-auth confirmation only for the current version", () => {
    const storage = createMemoryStorage();

    expect(hasPendingLegalConsent(storage)).toBe(false);
    markPendingLegalConsent(storage);
    expect(hasPendingLegalConsent(storage)).toBe(true);
    clearPendingLegalConsent(storage);
    expect(hasPendingLegalConsent(storage)).toBe(false);
  });

  it("fails closed when browser storage methods are unavailable", () => {
    const unavailableStorage = {
      getItem: () => {
        throw new DOMException("Access denied", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("Access denied", "SecurityError");
      },
      removeItem: () => {
        throw new DOMException("Access denied", "SecurityError");
      },
    };

    expect(() => markPendingLegalConsent(unavailableStorage)).not.toThrow();
    expect(hasPendingLegalConsent(unavailableStorage)).toBe(false);
    expect(() => clearPendingLegalConsent(unavailableStorage)).not.toThrow();
  });

  it("keeps policy pages available while authentication is resolving", () => {
    expect(
      shouldShowLegalConsentLoadingState("/legal/terms-of-service", undefined),
    ).toBe(false);
    expect(
      shouldShowLegalConsentLoadingState("/legal/privacy-policy", undefined),
    ).toBe(false);
    expect(
      shouldShowLegalConsentLoadingState("/legal/consent", undefined),
    ).toBe(false);
    expect(
      shouldShowLegalConsentLoadingState("/repositories/connect", undefined),
    ).toBe(true);
    expect(
      shouldShowLegalConsentLoadingState("/repositories/connect", null),
    ).toBe(false);
  });

  it("allows policy review while preventing unsafe return redirects", () => {
    expect(isLegalConsentExemptPath("/legal/consent")).toBe(true);
    expect(isLegalConsentExemptPath("/legal/terms-of-service")).toBe(true);
    expect(isLegalConsentExemptPath("/legal/privacy-policy")).toBe(true);
    expect(isLegalConsentExemptPath("/repositories/connect")).toBe(false);

    const consentUrl = createLegalConsentUrl("/tickets/123?tab=details");
    expect(consentUrl).toContain("/legal/consent?redirectTo=");
    expect(
      getLegalConsentReturnPath(
        new URL(consentUrl, "https://gitdog.dev").search,
      ),
    ).toBe("/tickets/123?tab=details");
    expect(getLegalConsentReturnPath("?redirectTo=https://evil.example")).toBe(
      "/",
    );
    expect(getLegalConsentReturnPath("?redirectTo=//evil.example")).toBe("/");

    const reauthorizationUrl = createGitHubReauthorizationConsentUrl(
      "/repositories/connect?installation_id=123",
    );
    const reauthorizationSearch = new URL(
      reauthorizationUrl,
      "https://gitdog.dev",
    ).search;
    expect(isGitHubReauthorizationRequested(reauthorizationSearch)).toBe(true);
    expect(getLegalConsentReturnPath(reauthorizationSearch)).toBe(
      "/repositories/connect?installation_id=123",
    );
    expect(isGitHubReauthorizationRequested("?reauthorize=other")).toBe(false);
  });

  it.each([
    ["English", en, /professional|business/i],
    ["Korean", ko, /전문|사업/],
    ["Japanese", ja, /専門|ビジネス/],
  ])(
    "requires age, professional use, and policy acceptance in %s",
    (_name, locale, professionalUsePattern) => {
      expect(locale.auth.legalConsent.ageConfirmation).toMatch(/18/);
      expect(locale.auth.legalConsent.professionalUseConfirmation).toMatch(
        professionalUsePattern,
      );
      expect(
        locale.auth.legalConsent.policyConfirmation.length,
      ).toBeGreaterThan(10);
      expect(locale.legal.privacy.section1.account.items.at(-1)).toMatch(/18/);
      expect(locale.legal.privacy.section1.account.items.at(-1)).toMatch(
        professionalUsePattern,
      );
      expect(locale.legal.privacy.section8.description).toMatch(/18/);
      expect(locale.legal.terms.section3.requirements.description).toMatch(
        /18/,
      );
      expect(locale.legal.terms.section3.requirements.description).toMatch(
        professionalUsePattern,
      );
    },
  );

  it("keeps every GitHub OAuth entry point behind the consent page", async () => {
    const files = (await glob("src/**/*.{ts,tsx}")).sort();
    const directSignInFiles: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (source.includes('signIn("github"')) {
        directSignInFiles.push(file);
      }
    }

    expect(directSignInFiles).toEqual(["src/pages/legal/consent.tsx"]);
  });
});
