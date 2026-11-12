import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const convexMocks = {
  currentUser: null as unknown,
  attestLegalEligibility: vi.fn(),
  authState: { isAuthenticated: false, isLoading: false },
};

const legalConsentMocks = {
  hasPendingLegalConsent: false,
};

vi.mock("convex/react", () => ({
  useMutation: () => convexMocks.attestLegalEligibility,
  useQuery: () => convexMocks.currentUser,
  useConvexAuth: () => convexMocks.authState,
}));

vi.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({
    signIn: vi.fn(),
    signOut: vi.fn(),
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("../../src/components/SEO", () => ({
  SEO: () => null,
}));

vi.mock("../../src/utils/legalConsent", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/utils/legalConsent")
  >("../../src/utils/legalConsent");
  return {
    ...actual,
    hasPendingLegalConsent: () => legalConsentMocks.hasPendingLegalConsent,
    markPendingLegalConsent: vi.fn(),
    clearPendingLegalConsent: vi.fn(),
  };
});

let LegalConsentPage: typeof import("../../src/pages/legal/consent").LegalConsentPage;

beforeAll(async () => {
  ({ LegalConsentPage } = await import("../../src/pages/legal/consent"));
});

describe("legal consent page", () => {
  beforeEach(() => {
    convexMocks.currentUser = null;
    convexMocks.authState = { isAuthenticated: false, isLoading: false };
    legalConsentMocks.hasPendingLegalConsent = false;
  });

  function renderConsentPage(
    initialEntry = "/legal/consent?redirectTo=%2Ftickets",
  ): string {
    return renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: [initialEntry] },
        createElement(LegalConsentPage),
      ),
    );
  }

  it("requires every eligibility confirmation before GitHub sign-in", () => {
    convexMocks.currentUser = null;
    const html = renderConsentPage();

    expect(html.match(/type="checkbox"/g)).toHaveLength(3);
    expect(html).toContain("auth.legalConsent.ageConfirmation");
    expect(html).toContain("auth.legalConsent.professionalUseConfirmation");
    expect(html).toContain("auth.legalConsent.policyConfirmation");
    expect(html).toContain('href="/legal/terms-of-service"');
    expect(html).toContain('href="/legal/privacy-policy"');
    expect(html).toContain("disabled");
    expect(html).toContain("auth.legalConsent.continueWithGitHub");
  });

  it("keeps the confirmation form for a current backend requiring consent", () => {
    convexMocks.currentUser = {
      name: "current-user",
      hasCurrentLegalAttestation: false,
      requiresCurrentLegalAttestation: true,
    };

    const html = renderConsentPage();

    expect(html.match(/type="checkbox"/g)).toHaveLength(3);
    expect(html).toContain("auth.legalConsent.confirmAndContinue");
  });

  it("keeps GitHub reauthorization on the consent-gated route", () => {
    convexMocks.currentUser = {
      name: "current-user",
      hasCurrentLegalAttestation: true,
      requiresCurrentLegalAttestation: false,
    };

    const html = renderConsentPage(
      "/legal/consent?redirectTo=%2Frepositories%2Fconnect%3Finstallation_id%3D123&reauthorize=github",
    );

    expect(html).toContain(
      "repositories.connect.verificationPending.reauthorize",
    );
    expect(html).toContain(
      "repositories.connect.verificationPending.reauthDescription",
    );
  });

  it("sizes every eligibility checkbox identically regardless of label length", () => {
    const html = renderConsentPage();
    const checkboxClasses = [
      ...html.matchAll(/<input[^>]*type="checkbox"[^>]*>/g),
    ].map((match) => /class="([^"]*)"/.exec(match[0])?.[1] ?? "");

    expect(checkboxClasses).toHaveLength(3);
    expect(new Set(checkboxClasses).size).toBe(1);
    // A wrapping label must not be able to squeeze the control.
    expect(html).toContain("shrink-0");
  });

  it("waits for sign-in to resolve instead of re-asking after the GitHub redirect", () => {
    legalConsentMocks.hasPendingLegalConsent = true;
    convexMocks.authState = { isAuthenticated: false, isLoading: true };
    convexMocks.currentUser = null;

    const html = renderConsentPage();

    expect(html).toContain("auth.legalConsent.completingSignIn");
    expect(html).not.toContain("auth.legalConsent.continueWithGitHub");
    expect(html.match(/type="checkbox"/g)).toBeNull();
  });

  it("attests the returning visitor without asking for a second confirmation", () => {
    legalConsentMocks.hasPendingLegalConsent = true;
    convexMocks.authState = { isAuthenticated: true, isLoading: false };
    convexMocks.currentUser = {
      name: "current-user",
      hasCurrentLegalAttestation: false,
      requiresCurrentLegalAttestation: true,
    };

    const html = renderConsentPage();

    expect(html).toContain("auth.legalConsent.completingSignIn");
    expect(html).not.toContain("auth.legalConsent.confirmAndContinue");
    expect(html.match(/type="checkbox"/g)).toBeNull();
  });
});
