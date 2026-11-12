import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import en from "../../src/i18n/locales/en.json";
import ja from "../../src/i18n/locales/ja.json";
import ko from "../../src/i18n/locales/ko.json";
import { CliLoginPage } from "../../src/pages/cli/login";
import {
  isLegalConsentExemptPath,
  shouldShowLegalConsentLoadingState,
} from "../../src/utils/legalConsent";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../src/components/SEO", () => ({
  SEO: () => null,
}));

function render(path: string): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(CliLoginPage),
    ),
  );
}

describe("CLI login result page", () => {
  it("confirms a completed sign-in and offers the next command", () => {
    const html = render("/cli/login?status=success");

    expect(html).toContain("auth.cliLogin.success.title");
    expect(html).toContain("npx gitdog@latest init");
  });

  it.each(["/cli/login?status=failed", "/cli/login?status=x", "/cli/login"])(
    "never claims success for %s",
    (path) => {
      const html = render(path);

      expect(html).toContain("auth.cliLogin.failed.title");
      expect(html).toContain("npx gitdog@latest login");
      expect(html).not.toContain("auth.cliLogin.success.title");
    },
  );

  it("stays reachable without browser account consent", () => {
    expect(isLegalConsentExemptPath("/cli/login")).toBe(true);
    expect(shouldShowLegalConsentLoadingState("/cli/login", undefined)).toBe(
      false,
    );
  });

  it.each([
    ["English", en],
    ["Korean", ko],
    ["Japanese", ja],
  ])("has the same copy keys in %s", (_name, locale) => {
    expect(Object.keys(locale.auth.cliLogin)).toEqual(
      Object.keys(en.auth.cliLogin),
    );
    expect(Object.keys(locale.auth.cliLogin.success)).toEqual(
      Object.keys(en.auth.cliLogin.success),
    );
    expect(Object.keys(locale.auth.cliLogin.failed)).toEqual(
      Object.keys(en.auth.cliLogin.failed),
    );
  });
});
