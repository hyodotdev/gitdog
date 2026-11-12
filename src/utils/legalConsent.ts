export const LEGAL_CONSENT_PATH = "/legal/consent";
export const CURRENT_LEGAL_CONSENT_VERSION = "2026-11-03";
export const DISPLAYED_TERMS_VERSION = CURRENT_LEGAL_CONSENT_VERSION;
export const DISPLAYED_PRIVACY_POLICY_VERSION = CURRENT_LEGAL_CONSENT_VERSION;
export const LEGAL_POLICY_VERSION_MISMATCH_CODE =
  "LEGAL_POLICY_VERSION_MISMATCH";

const PENDING_LEGAL_CONSENT_KEY = "gitdog:pending-legal-consent";
const GITHUB_REAUTHORIZATION_PARAM = "reauthorize";
const GITHUB_REAUTHORIZATION_VALUE = "github";

type LegalConsentStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function isLegalPolicyVersionMismatch(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes(LEGAL_POLICY_VERSION_MISMATCH_CODE)
  );
}

function getSessionStorage(): LegalConsentStorage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function markPendingLegalConsent(
  storage: LegalConsentStorage | null = getSessionStorage(),
): void {
  try {
    storage?.setItem(PENDING_LEGAL_CONSENT_KEY, CURRENT_LEGAL_CONSENT_VERSION);
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}

export function hasPendingLegalConsent(
  storage: LegalConsentStorage | null = getSessionStorage(),
): boolean {
  try {
    return (
      storage?.getItem(PENDING_LEGAL_CONSENT_KEY) ===
      CURRENT_LEGAL_CONSENT_VERSION
    );
  } catch {
    return false;
  }
}

export function clearPendingLegalConsent(
  storage: LegalConsentStorage | null = getSessionStorage(),
): void {
  try {
    storage?.removeItem(PENDING_LEGAL_CONSENT_KEY);
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}

export function isLegalConsentExemptPath(pathname: string): boolean {
  return (
    pathname === LEGAL_CONSENT_PATH ||
    pathname === "/legal/terms-of-service" ||
    pathname === "/legal/privacy-policy" ||
    pathname === "/cli/login"
  );
}

export function shouldShowLegalConsentLoadingState(
  pathname: string,
  currentUser: unknown,
): boolean {
  return currentUser === undefined && !isLegalConsentExemptPath(pathname);
}

export function createLegalConsentUrl(returnPath: string): string {
  if (
    !returnPath.startsWith("/") ||
    returnPath.startsWith("//") ||
    returnPath.includes("\\") ||
    returnPath.startsWith(LEGAL_CONSENT_PATH)
  ) {
    return LEGAL_CONSENT_PATH;
  }

  return `${LEGAL_CONSENT_PATH}?redirectTo=${encodeURIComponent(returnPath)}`;
}

export function createGitHubReauthorizationConsentUrl(
  returnPath: string,
): string {
  const consentUrl = new URL(
    createLegalConsentUrl(returnPath),
    "https://gitdog.invalid",
  );
  consentUrl.searchParams.set(
    GITHUB_REAUTHORIZATION_PARAM,
    GITHUB_REAUTHORIZATION_VALUE,
  );
  return `${consentUrl.pathname}?${consentUrl.searchParams.toString()}`;
}

export function isGitHubReauthorizationRequested(search: string): boolean {
  return (
    new URLSearchParams(search).get(GITHUB_REAUTHORIZATION_PARAM) ===
    GITHUB_REAUTHORIZATION_VALUE
  );
}

/**
 * What the consent page renders. `completingSignIn` is the state that keeps a
 * visitor who already confirmed eligibility from being asked a second time
 * while the GitHub token handshake is still in flight.
 */
export type LegalConsentView =
  | "loading"
  | "reauthorize"
  | "redirectToReturnPath"
  | "completingSignIn"
  | "form";

export type LegalConsentViewInput = {
  /** False while the `getCurrentUser` query is still resolving. */
  currentUserLoaded: boolean;
  hasCurrentLegalAttestation: boolean;
  refreshGitHubAuthorizationRequested: boolean;
  /** The visitor confirmed eligibility on this tab before the GitHub redirect. */
  returningFromConsentedSignIn: boolean;
  /** The redirect came back without a session, or the attestation failed. */
  signInCompletionFailed: boolean;
};

export function resolveLegalConsentView({
  currentUserLoaded,
  hasCurrentLegalAttestation,
  refreshGitHubAuthorizationRequested,
  returningFromConsentedSignIn,
  signInCompletionFailed,
}: LegalConsentViewInput): LegalConsentView {
  if (!currentUserLoaded) {
    return "loading";
  }

  if (hasCurrentLegalAttestation) {
    return refreshGitHubAuthorizationRequested
      ? "reauthorize"
      : "redirectToReturnPath";
  }

  if (returningFromConsentedSignIn && !signInCompletionFailed) {
    return "completingSignIn";
  }

  return "form";
}

/**
 * The consent collected before the redirect is attested automatically, so a
 * returning visitor never confirms twice. Guarded by the caller's ref so it
 * fires at most once per mount.
 */
export function shouldAutoAttestAfterSignIn({
  currentUserLoaded,
  isAuthenticatedUser,
  hasCurrentLegalAttestation,
  returningFromConsentedSignIn,
  alreadyAttempted,
}: {
  currentUserLoaded: boolean;
  isAuthenticatedUser: boolean;
  hasCurrentLegalAttestation: boolean;
  returningFromConsentedSignIn: boolean;
  alreadyAttempted: boolean;
}): boolean {
  return (
    currentUserLoaded &&
    isAuthenticatedUser &&
    !hasCurrentLegalAttestation &&
    returningFromConsentedSignIn &&
    !alreadyAttempted
  );
}

/** Sign-in resolved without a session, so stop waiting on the hand-off. */
export function shouldReleasePendingConsent({
  returningFromConsentedSignIn,
  isAuthResolving,
  isAuthenticated,
}: {
  returningFromConsentedSignIn: boolean;
  isAuthResolving: boolean;
  isAuthenticated: boolean;
}): boolean {
  return returningFromConsentedSignIn && !isAuthResolving && !isAuthenticated;
}

export function getLegalConsentReturnPath(search: string): string {
  const returnPath = new URLSearchParams(search).get("redirectTo");
  if (
    !returnPath ||
    !returnPath.startsWith("/") ||
    returnPath.startsWith("//") ||
    returnPath.includes("\\") ||
    returnPath.startsWith(LEGAL_CONSENT_PATH)
  ) {
    return "/";
  }

  return returnPath;
}
