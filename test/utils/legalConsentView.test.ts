import { describe, expect, it } from "vitest";
import {
  LegalConsentViewInput,
  resolveLegalConsentView,
  shouldAutoAttestAfterSignIn,
  shouldReleasePendingConsent,
} from "../../src/utils/legalConsent";

const BOOLS = [false, true] as const;

function everyViewInput(): LegalConsentViewInput[] {
  const inputs: LegalConsentViewInput[] = [];
  for (const currentUserLoaded of BOOLS) {
    for (const hasCurrentLegalAttestation of BOOLS) {
      for (const refreshGitHubAuthorizationRequested of BOOLS) {
        for (const returningFromConsentedSignIn of BOOLS) {
          for (const signInCompletionFailed of BOOLS) {
            inputs.push({
              currentUserLoaded,
              hasCurrentLegalAttestation,
              refreshGitHubAuthorizationRequested,
              returningFromConsentedSignIn,
              signInCompletionFailed,
            });
          }
        }
      }
    }
  }
  return inputs;
}

describe("legal consent view resolution", () => {
  it("covers every input combination without falling through", () => {
    const inputs = everyViewInput();
    expect(inputs).toHaveLength(32);
    for (const input of inputs) {
      expect(resolveLegalConsentView(input)).toBeTypeOf("string");
    }
  });

  // The regression this guards: after the GitHub redirect the auth handshake is
  // still in flight, so the user query resolves to "no user". Rendering the form
  // there made visitors confirm again and start a second OAuth round trip.
  it("never shows the form to a visitor who already consented before signing in", () => {
    const offenders = everyViewInput()
      .filter(
        (input) =>
          input.returningFromConsentedSignIn && !input.signInCompletionFailed,
      )
      .filter((input) => resolveLegalConsentView(input) === "form");

    expect(offenders).toEqual([]);
  });

  it("holds the completion state while the handshake is unresolved", () => {
    expect(
      resolveLegalConsentView({
        currentUserLoaded: true,
        hasCurrentLegalAttestation: false,
        refreshGitHubAuthorizationRequested: false,
        returningFromConsentedSignIn: true,
        signInCompletionFailed: false,
      }),
    ).toBe("completingSignIn");
  });

  it("returns to the form once sign-in is known to have failed", () => {
    expect(
      resolveLegalConsentView({
        currentUserLoaded: true,
        hasCurrentLegalAttestation: false,
        refreshGitHubAuthorizationRequested: false,
        returningFromConsentedSignIn: true,
        signInCompletionFailed: true,
      }),
    ).toBe("form");
  });

  it("waits for the user query before deciding anything", () => {
    const undecided = everyViewInput().filter(
      (input) => !input.currentUserLoaded,
    );
    expect(undecided).toHaveLength(16);
    for (const input of undecided) {
      expect(resolveLegalConsentView(input)).toBe("loading");
    }
  });

  it("keeps an attested visitor out of the consent form entirely", () => {
    const attested = everyViewInput().filter(
      (input) => input.currentUserLoaded && input.hasCurrentLegalAttestation,
    );
    expect(attested).toHaveLength(8);
    for (const input of attested) {
      expect(resolveLegalConsentView(input)).toBe(
        input.refreshGitHubAuthorizationRequested
          ? "reauthorize"
          : "redirectToReturnPath",
      );
    }
  });

  it("shows the form to a first-time visitor", () => {
    expect(
      resolveLegalConsentView({
        currentUserLoaded: true,
        hasCurrentLegalAttestation: false,
        refreshGitHubAuthorizationRequested: false,
        returningFromConsentedSignIn: false,
        signInCompletionFailed: false,
      }),
    ).toBe("form");
  });
});

describe("automatic attestation after sign-in", () => {
  const base = {
    currentUserLoaded: true,
    isAuthenticatedUser: true,
    hasCurrentLegalAttestation: false,
    returningFromConsentedSignIn: true,
    alreadyAttempted: false,
  };

  it("attests the consent captured before the redirect", () => {
    expect(shouldAutoAttestAfterSignIn(base)).toBe(true);
  });

  it("fires at most once per mount", () => {
    expect(
      shouldAutoAttestAfterSignIn({ ...base, alreadyAttempted: true }),
    ).toBe(false);
  });

  it("waits for the user query rather than acting on a loading state", () => {
    expect(
      shouldAutoAttestAfterSignIn({ ...base, currentUserLoaded: false }),
    ).toBe(false);
  });

  it("does nothing while the visitor is still unauthenticated", () => {
    expect(
      shouldAutoAttestAfterSignIn({ ...base, isAuthenticatedUser: false }),
    ).toBe(false);
  });

  it("never attests without a consent captured before the redirect", () => {
    expect(
      shouldAutoAttestAfterSignIn({
        ...base,
        returningFromConsentedSignIn: false,
      }),
    ).toBe(false);
  });

  it("skips a visitor who is already attested", () => {
    expect(
      shouldAutoAttestAfterSignIn({
        ...base,
        hasCurrentLegalAttestation: true,
      }),
    ).toBe(false);
  });
});

describe("releasing a pending consent hand-off", () => {
  it("releases when sign-in resolves without a session", () => {
    expect(
      shouldReleasePendingConsent({
        returningFromConsentedSignIn: true,
        isAuthResolving: false,
        isAuthenticated: false,
      }),
    ).toBe(true);
  });

  it("keeps waiting while auth is still resolving", () => {
    expect(
      shouldReleasePendingConsent({
        returningFromConsentedSignIn: true,
        isAuthResolving: true,
        isAuthenticated: false,
      }),
    ).toBe(false);
  });

  it("does not release a successful sign-in", () => {
    expect(
      shouldReleasePendingConsent({
        returningFromConsentedSignIn: true,
        isAuthResolving: false,
        isAuthenticated: true,
      }),
    ).toBe(false);
  });

  it("ignores visitors who never started the hand-off", () => {
    expect(
      shouldReleasePendingConsent({
        returningFromConsentedSignIn: false,
        isAuthResolving: false,
        isAuthenticated: false,
      }),
    ).toBe(false);
  });
});
