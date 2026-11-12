import { useAuthActions } from "@convex-dev/auth/react";
import { SiGithub } from "@icons-pack/react-simple-icons";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate, useLocation, useNavigate } from "react-router";
import { api } from "../../../convex/_generated/api";
import { SEO } from "../../components/SEO";
import { Button } from "../../components/uis/Button";
import { Checkbox } from "../../components/uis/Checkbox";
import { LoadingIndicator } from "../../components/uis/LoadingIndicator";
import { cn } from "../../utils/cn";
import {
  clearPendingLegalConsent,
  DISPLAYED_PRIVACY_POLICY_VERSION,
  DISPLAYED_TERMS_VERSION,
  getLegalConsentReturnPath,
  hasPendingLegalConsent,
  isLegalPolicyVersionMismatch,
  isGitHubReauthorizationRequested,
  markPendingLegalConsent,
  resolveLegalConsentView,
  shouldAutoAttestAfterSignIn,
  shouldReleasePendingConsent,
} from "../../utils/legalConsent";

export function LegalConsentPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const currentUser = useQuery(api.users.query.getCurrentUser);
  const attestLegalEligibility = useMutation(
    api.users.mutation.attestLegalEligibility,
  );
  const { signIn, signOut } = useAuthActions();
  const { isAuthenticated, isLoading: isAuthResolving } = useConvexAuth();
  // Captured once: the visitor already confirmed eligibility on this tab and is
  // coming back from the GitHub redirect, so the form must not restart empty.
  const [returningFromConsentedSignIn] = useState(() =>
    hasPendingLegalConsent(),
  );
  const [attestationFailed, setAttestationFailed] = useState(false);
  // Derived, not mirrored: "the redirect came back without a session" is a pure
  // function of the current auth state, so only the attestation failure needs
  // to be remembered.
  const signInCompletionFailed =
    attestationFailed ||
    shouldReleasePendingConsent({
      returningFromConsentedSignIn,
      isAuthResolving,
      isAuthenticated,
    });
  const [minimumAgeConfirmed, setMinimumAgeConfirmed] = useState(
    returningFromConsentedSignIn,
  );
  const [professionalUseConfirmed, setProfessionalUseConfirmed] = useState(
    returningFromConsentedSignIn,
  );
  const [policiesAccepted, setPoliciesAccepted] = useState(
    returningFromConsentedSignIn,
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const automaticAttestationAttempted = useRef(false);
  const authorizationRefreshAttempted = useRef(false);
  const returnPath = getLegalConsentReturnPath(location.search);
  const refreshGitHubAuthorizationRequested = isGitHubReauthorizationRequested(
    location.search,
  );

  const completeAuthenticatedAttestation = useCallback(async () => {
    setIsSubmitting(true);
    setError(null);
    try {
      await attestLegalEligibility({
        minimumAgeConfirmed: true,
        professionalUseConfirmed: true,
        termsAccepted: true,
        privacyPolicyAccepted: true,
        displayedTermsVersion: DISPLAYED_TERMS_VERSION,
        displayedPrivacyPolicyVersion: DISPLAYED_PRIVACY_POLICY_VERSION,
      });
      clearPendingLegalConsent();
      navigate(returnPath, { replace: true });
    } catch (attestationError) {
      clearPendingLegalConsent();
      setAttestationFailed(true);
      setMinimumAgeConfirmed(true);
      setProfessionalUseConfirmed(true);
      setPoliciesAccepted(true);
      const policyVersionChanged =
        isLegalPolicyVersionMismatch(attestationError);
      setError(
        t(
          policyVersionChanged
            ? "auth.legalConsent.policyChangedError"
            : "auth.legalConsent.saveError",
        ),
      );
      setIsSubmitting(false);
      if (policyVersionChanged) {
        window.setTimeout(() => window.location.reload(), 0);
      }
    }
  }, [attestLegalEligibility, navigate, returnPath, t]);

  // Reuse the value captured at mount so the completion state and the automatic
  // attestation can never disagree about the hand-off being in progress.
  useEffect(() => {
    if (
      shouldAutoAttestAfterSignIn({
        currentUserLoaded: currentUser !== undefined,
        isAuthenticatedUser: currentUser !== null,
        hasCurrentLegalAttestation:
          currentUser?.hasCurrentLegalAttestation ?? false,
        returningFromConsentedSignIn,
        alreadyAttempted: automaticAttestationAttempted.current,
      })
    ) {
      automaticAttestationAttempted.current = true;
      void completeAuthenticatedAttestation();
    }
  }, [
    completeAuthenticatedAttestation,
    currentUser,
    returningFromConsentedSignIn,
  ]);

  // The GitHub redirect came back without a session (declined or expired).
  // signInCompletionFailed already reflects that; this only releases the stored
  // hand-off so a later reload starts clean.
  useEffect(() => {
    if (
      shouldReleasePendingConsent({
        returningFromConsentedSignIn,
        isAuthResolving,
        isAuthenticated,
      })
    ) {
      clearPendingLegalConsent();
    }
  }, [isAuthResolving, isAuthenticated, returningFromConsentedSignIn]);

  const refreshGitHubAuthorization = useCallback(async () => {
    authorizationRefreshAttempted.current = true;
    setIsSubmitting(true);
    setError(null);
    try {
      await signIn("github", { redirectTo: returnPath });
    } catch {
      setError(t("auth.legalConsent.signInError"));
      setIsSubmitting(false);
    }
  }, [returnPath, signIn, t]);

  useEffect(() => {
    if (
      currentUser?.hasCurrentLegalAttestation &&
      refreshGitHubAuthorizationRequested &&
      !authorizationRefreshAttempted.current
    ) {
      void refreshGitHubAuthorization();
    }
  }, [
    currentUser,
    refreshGitHubAuthorization,
    refreshGitHubAuthorizationRequested,
  ]);

  const view = resolveLegalConsentView({
    currentUserLoaded: currentUser !== undefined,
    hasCurrentLegalAttestation:
      currentUser?.hasCurrentLegalAttestation ?? false,
    refreshGitHubAuthorizationRequested,
    returningFromConsentedSignIn,
    signInCompletionFailed,
  });

  if (view === "loading") {
    return (
      <div
        className={cn(
          "flex items-center justify-center min-h-screen",
          "bg-[#F5F5F5]",
          "dark:bg-[#1a1a1a]",
        )}
      >
        <LoadingIndicator />
      </div>
    );
  }

  if (view === "reauthorize" || view === "redirectToReturnPath") {
    if (view === "reauthorize") {
      return (
        <main
          className={cn(
            "flex items-center justify-center min-h-screen px-6",
            "bg-[#F5F5F5] dark:bg-[#1a1a1a]",
          )}
        >
          <div
            className={cn(
              "w-full max-w-xl p-8 text-center",
              "bg-white border border-gray-200 shadow-xl",
              "dark:bg-[#0a0a0a] dark:border-gray-800",
            )}
          >
            <SiGithub size={40} className="mx-auto mb-4" />
            <h1
              className={cn(
                "font-brand font-bold text-2xl text-black mb-3",
                "dark:text-white",
              )}
            >
              {t("repositories.connect.verificationPending.reauthorize")}
            </h1>
            <p
              className={cn(
                "text-gray-600 mb-6",
                "dark:text-gray-400",
                error ? "text-red-600 dark:text-red-400" : undefined,
              )}
              role={error ? "alert" : undefined}
            >
              {error ??
                t("repositories.connect.verificationPending.reauthDescription")}
            </p>
            <Button
              variant="auth"
              size="lg"
              loading={isSubmitting}
              icon={<SiGithub size={20} />}
              className="w-full"
              onClick={() => void refreshGitHubAuthorization()}
            >
              {isSubmitting
                ? t("repositories.connect.verificationPending.reauthorizing")
                : t("repositories.connect.verificationPending.reauthorize")}
            </Button>
          </div>
        </main>
      );
    }
    return <Navigate to={returnPath} replace />;
  }

  // Between the GitHub redirect and the finished token handshake the query is
  // still unauthenticated. Showing the form here made visitors confirm and sign
  // in a second time, so hold the completion state until sign-in resolves.
  if (view === "completingSignIn") {
    return (
      <main
        className={cn(
          "flex items-center justify-center min-h-screen px-6",
          "bg-[#F5F5F5] dark:bg-[#1a1a1a]",
        )}
      >
        <div
          className={cn(
            "w-full max-w-xl p-8 text-center",
            "bg-white border border-gray-200 shadow-xl",
            "dark:bg-[#0a0a0a] dark:border-gray-800",
          )}
        >
          <LoadingIndicator />
          <p className={cn("mt-4 text-gray-600", "dark:text-gray-400")}>
            {t("auth.legalConsent.completingSignIn")}
          </p>
        </div>
      </main>
    );
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      !minimumAgeConfirmed ||
      !professionalUseConfirmed ||
      !policiesAccepted
    ) {
      return;
    }

    if (currentUser) {
      await completeAuthenticatedAttestation();
      return;
    }

    setIsSubmitting(true);
    setError(null);
    markPendingLegalConsent();
    try {
      await signIn("github", {
        redirectTo: `${location.pathname}${location.search}`,
      });
    } catch {
      clearPendingLegalConsent();
      setError(t("auth.legalConsent.signInError"));
      setIsSubmitting(false);
    }
  };

  const handleSignOut = async () => {
    clearPendingLegalConsent();
    await signOut();
    navigate("/", { replace: true });
  };

  return (
    <>
      <SEO
        title={t("auth.legalConsent.seoTitle") || "Account Eligibility"}
        description={t("auth.legalConsent.description") || undefined}
        path="/legal/consent"
        noIndex
      />
      <main
        className={cn(
          "flex items-center justify-center min-h-screen",
          "px-6 py-12",
          "bg-[#F5F5F5]",
          "dark:bg-[#1a1a1a]",
        )}
      >
        <div
          className={cn(
            "w-full max-w-xl",
            "p-8",
            "bg-white border border-gray-200 shadow-xl",
            "dark:bg-[#0a0a0a] dark:border-gray-800",
          )}
        >
          <Link to="/" className={cn("inline-flex items-center gap-3 mb-8")}>
            <img
              src="/icon-bg.jpg"
              alt="Gitdog"
              className="w-10 h-10 dark:hidden"
            />
            <img
              src="/icon.png"
              alt="Gitdog"
              className="w-10 h-10 hidden dark:block"
            />
            <span
              className={cn(
                "font-brand font-bold text-2xl text-black",
                "dark:text-white",
              )}
            >
              Gitdog
            </span>
          </Link>

          <h1
            className={cn(
              "font-brand font-bold text-3xl text-black mb-3",
              "dark:text-white",
            )}
          >
            {t("auth.legalConsent.title")}
          </h1>
          <p className={cn("text-gray-600 mb-8", "dark:text-gray-400")}>
            {t("auth.legalConsent.description")}
          </p>

          <form onSubmit={(event) => void handleSubmit(event)}>
            <div className={cn("flex flex-col gap-5 mb-6")}>
              <Checkbox
                checked={minimumAgeConfirmed}
                onChange={setMinimumAgeConfirmed}
                disabled={isSubmitting}
                label={t("auth.legalConsent.ageConfirmation")}
              />
              <Checkbox
                checked={professionalUseConfirmed}
                onChange={setProfessionalUseConfirmed}
                disabled={isSubmitting}
                label={t("auth.legalConsent.professionalUseConfirmation")}
              />
              <Checkbox
                checked={policiesAccepted}
                onChange={setPoliciesAccepted}
                disabled={isSubmitting}
                label={t("auth.legalConsent.policyConfirmation")}
              />
            </div>

            <div className={cn("flex flex-wrap gap-4 mb-6 text-sm")}>
              <Link
                to="/legal/terms-of-service"
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  "font-medium text-black underline hover:no-underline",
                  "dark:text-white",
                )}
              >
                {t("auth.legalConsent.termsLink")}
              </Link>
              <Link
                to="/legal/privacy-policy"
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  "font-medium text-black underline hover:no-underline",
                  "dark:text-white",
                )}
              >
                {t("auth.legalConsent.privacyLink")}
              </Link>
            </div>

            {error && (
              <p
                role="alert"
                className={cn("text-sm text-red-600 mb-4", "dark:text-red-400")}
              >
                {error}
              </p>
            )}

            <Button
              type="submit"
              variant="auth"
              size="lg"
              loading={isSubmitting}
              disabled={
                isSubmitting ||
                !minimumAgeConfirmed ||
                !professionalUseConfirmed ||
                !policiesAccepted
              }
              icon={!currentUser ? <SiGithub size={20} /> : undefined}
              className="w-full"
            >
              {currentUser
                ? t("auth.legalConsent.confirmAndContinue")
                : t("auth.legalConsent.continueWithGitHub")}
            </Button>
          </form>

          {currentUser && (
            <button
              type="button"
              onClick={() => void handleSignOut()}
              disabled={isSubmitting}
              className={cn(
                "w-full mt-4",
                "text-sm text-gray-500 underline hover:no-underline",
                "disabled:opacity-50 disabled:cursor-not-allowed",
                "dark:text-gray-400",
              )}
            >
              {t("auth.legalConsent.signOut")}
            </button>
          )}
        </div>
      </main>
    </>
  );
}
