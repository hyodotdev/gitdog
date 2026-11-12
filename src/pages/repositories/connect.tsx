import { ArrowLeft, Building2, Search, Star, User, Plus } from "lucide-react";
import { SiGithub } from "@icons-pack/react-simple-icons";
import { useNavigate } from "react-router";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useEffect, useRef, useState } from "react";
import { Helmet } from "react-helmet-async";
import { LoadingIndicator } from "../../components/uis/LoadingIndicator";
import { showToast } from "../../utils/signals/toast";
import { useTranslation } from "react-i18next";
import { cn } from "../../utils/cn";
import { createGitHubReauthorizationConsentUrl } from "../../utils/legalConsent";
import {
  clearPendingReconnectMapping,
  consumePendingReconnectMapping,
  createOpaqueReconnectState,
  createPendingReconnectMapping,
  finalizeBoundInstallationCallback,
  getBrowserSessionStorage,
  getConnectPathAfterInstallationCallback,
  getGitHubAppInstallationUrl,
  getInstallationReadinessSignature,
  getSharedOAuthInstallationRecovery,
  groupRepositoriesByInstallation,
  needsGitHubAppInstallation,
  type OAuthInstallationRecoveryOutcome,
  recoverOAuthInstallations,
  resolveGitHubAppSlug,
  resolveInstallationReconnect,
  storePendingReconnectMapping,
  waitForInstallationBinding,
} from "./connectFlow";

const GITHUB_APP_SLUG = resolveGitHubAppSlug(
  import.meta.env.VITE_GITHUB_APP_SLUG,
  import.meta.env.MODE,
);

interface Repository {
  id: number;
  name: string;
  fullName: string;
  description: string | null;
  url: string;
  stars: number;
  language: string | null;
  updatedAt: string;
  installationId: number;
  accountLogin: string;
  accountType: string;
  isPrivate: boolean;
  reconciliationPending: boolean;
}

type OAuthInstallationRecoveryState =
  { status: "pending"; recoveredCount: 0 } | OAuthInstallationRecoveryOutcome;

const getCurrentTimestamp = () => Date.now();

export function RepositoryConnect() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const listRepos = useAction(api.github.action.listUserRepositories);
  const retryReconciliation = useAction(
    api.github.action.retryRepositoryAccessReconciliation,
  );
  const ensureProfile = useMutation(api.users.mutation.ensureProfileFromAuth);
  const refreshInstallation = useAction(api.github.action.saveInstallation);
  const recoverOAuthInstallation = useAction(
    api.github.action.recoverOAuthInstallation,
  );
  const installations = useQuery(api.github.query.getUserInstallations);
  const [initialConnectState] = useState(() => {
    const sessionStorage = getBrowserSessionStorage();
    return {
      sessionStorage,
      installationReconnect: resolveInstallationReconnect(
        window.location.search,
        sessionStorage,
        Date.now(),
      ),
    };
  });
  const { installationReconnect, sessionStorage } = initialConnectState;
  const pendingInstallationCallbackIdRef = useRef(
    installationReconnect.installationId,
  );
  const completedInstallationCallbackIdRef = useRef<number | null>(null);
  const reconnectRepositoryId = installationReconnect.reconnectRepositoryId;
  const reconnectTarget = useQuery(
    api.repositories.query.getReconnectTarget,
    reconnectRepositoryId === null ? "skip" : { reconnectRepositoryId },
  );
  const createAndIndexRepository = useAction(
    api.repositories.action.createAndIndex,
  );
  const [repos, setRepos] = useState<Repository[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [connectingRepo, setConnectingRepo] = useState<number | null>(null);
  const [
    verificationPendingInstallationId,
    setVerificationPendingInstallationId,
  ] = useState<number | null>(null);
  const [verificationReauthRequired, setVerificationReauthRequired] =
    useState(false);
  const [isRetryingVerification, setIsRetryingVerification] = useState(false);
  const [retryingReconciliationId, setRetryingReconciliationId] = useState<
    number | null
  >(null);
  const [verificationRetryVersion, setVerificationRetryVersion] = useState(0);
  const [oauthInstallationRecovery, setOAuthInstallationRecovery] =
    useState<OAuthInstallationRecoveryState>({
      status: "pending",
      recoveredCount: 0,
    });
  const oauthInstallationRecoveryPromiseRef =
    useRef<Promise<OAuthInstallationRecoveryOutcome> | null>(null);
  const installationReadinessSignature =
    getInstallationReadinessSignature(installations);
  const reconnectTargetStatus =
    reconnectRepositoryId === null
      ? "none"
      : reconnectTarget === undefined
        ? "loading"
        : reconnectTarget === null
          ? "invalid"
          : "ready";

  const hasNoDurableInstallations =
    installations !== undefined && installations.length === 0;
  const needsOAuthReauthorization =
    hasNoDurableInstallations &&
    oauthInstallationRecovery.status === "reauth_required";
  const needsInstallation =
    oauthInstallationRecovery.status === "none" &&
    oauthInstallationRecovery.recoveredCount === 0 &&
    needsGitHubAppInstallation(installations);
  const waitingForRecoveredInstallations =
    hasNoDurableInstallations &&
    oauthInstallationRecovery.recoveredCount > 0 &&
    error === null;
  const oauthRecoveryLoading =
    oauthInstallationRecovery.status === "pending" &&
    verificationPendingInstallationId === null &&
    error === null;
  const showInstallationVerification =
    verificationPendingInstallationId !== null || needsOAuthReauthorization;
  const installationVerificationRequiresReauth =
    verificationPendingInstallationId === null
      ? needsOAuthReauthorization
      : verificationReauthRequired;
  const installationVerificationRequiresConfiguration =
    hasNoDurableInstallations &&
    oauthInstallationRecovery.status === "configure_required";

  useEffect(() => {
    let cancelled = false;

    if (reconnectTargetStatus === "loading") {
      return () => {
        cancelled = true;
      };
    }

    const fetchRepos = async () => {
      setLoading(true);
      setError(null);

      if (reconnectTargetStatus === "invalid") {
        consumePendingReconnectMapping(
          sessionStorage,
          installationReconnect.pendingStateToConsume,
        );
        setError(t("repositories.connect.errors.reconnectTargetUnavailable"));
        setLoading(false);
        return;
      }

      try {
        // Ensure profile exists
        try {
          await ensureProfile();
        } catch (err) {
          console.warn("Profile creation failed, may already exist:", err);
        }

        // Check if we just completed installation and have installation_id in URL
        const installationIdFromUrl = pendingInstallationCallbackIdRef.current;

        if (installationIdFromUrl !== null) {
          // A configure callback refreshes an already verified installation.
          // Unknown organization installs remain pending until a signed
          // GitHub webhook creates the durable ownership binding.
          if (
            completedInstallationCallbackIdRef.current !== installationIdFromUrl
          ) {
            const binding = await waitForInstallationBinding({
              installationId: installationIdFromUrl,
              refreshInstallation,
              isCancelled: () => cancelled,
            });
            if (binding === "cancelled") {
              return;
            }
            if (binding === "bound") {
              completedInstallationCallbackIdRef.current =
                installationIdFromUrl;
            } else {
              if (!cancelled) {
                setVerificationPendingInstallationId(installationIdFromUrl);
                setVerificationReauthRequired(binding === "reauth_required");
              }
              return;
            }
          }

          const finalized = finalizeBoundInstallationCallback({
            pendingInstallation: pendingInstallationCallbackIdRef,
            completedInstallation: completedInstallationCallbackIdRef,
            isCancelled: () => cancelled,
            finalize: () => {
              setVerificationPendingInstallationId(null);
              setVerificationReauthRequired(false);
              consumePendingReconnectMapping(
                sessionStorage,
                installationReconnect.pendingStateToConsume,
              );
              window.history.replaceState(
                {},
                "",
                getConnectPathAfterInstallationCallback(
                  window.location.search,
                  reconnectRepositoryId,
                ),
              );
            },
          });
          if (!finalized) {
            return;
          }
        } else {
          setVerificationPendingInstallationId(null);
          setVerificationReauthRequired(false);
        }

        const recovery = await getSharedOAuthInstallationRecovery({
          cache: oauthInstallationRecoveryPromiseRef,
          // Share only the in-flight operation across reactive and StrictMode
          // replays. A later retry must use fresh OAuth and durable state.
          start: () =>
            recoverOAuthInstallations({
              recoverInstallation: recoverOAuthInstallation,
            }),
        });
        if (cancelled || recovery.status === "cancelled") {
          return;
        }
        setOAuthInstallationRecovery(recovery);
        if (recovery.status === "reauth_required") {
          if ((installations?.length ?? 0) === 0) {
            return;
          }
        } else if (recovery.status === "configure_required") {
          if ((installations?.length ?? 0) === 0) {
            setVerificationPendingInstallationId(recovery.installationId);
            setVerificationReauthRequired(false);
            return;
          }
          setVerificationPendingInstallationId(null);
        } else if (recovery.status === "unavailable") {
          setError(t("repositories.connect.errors.recoveryUnavailable"));
          return;
        } else if (recovery.status === "limit_exceeded") {
          setError(t("repositories.connect.errors.recoveryLimitExceeded"));
          return;
        }

        const repositories: Repository[] = [];
        const seenRepositoryIds = new Set<number>();
        let cursor: string | undefined;
        for (let page = 0; page < 10_000; page++) {
          const result = await listRepos({
            cursor,
            ...(reconnectTarget
              ? { reconnectRepositoryId: reconnectTarget.repositoryId }
              : {}),
          });
          if (cancelled) return;
          for (const repository of result.repositories) {
            if (!seenRepositoryIds.has(repository.id)) {
              seenRepositoryIds.add(repository.id);
              repositories.push(repository);
            }
          }
          if (result.continueCursor === null) break;
          cursor = result.continueCursor;
          if (page === 9_999) {
            throw new Error("Repository list pagination exceeded its limit");
          }
        }
        const sortedRepos = repositories.sort(
          (a: Repository, b: Repository) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        );
        setRepos(sortedRepos);
      } catch (err) {
        const errorMessage =
          err instanceof Error
            ? err.message
            : t("repositories.connect.errors.loadFailed");

        if (!cancelled) {
          setError(errorMessage);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void fetchRepos();

    return () => {
      cancelled = true;
    };
  }, [
    listRepos,
    ensureProfile,
    refreshInstallation,
    recoverOAuthInstallation,
    installations?.length,
    installationReadinessSignature,
    installationReconnect,
    sessionStorage,
    reconnectRepositoryId,
    reconnectTargetStatus,
    reconnectTarget,
    t,
    verificationRetryVersion,
  ]);

  const prepareGitHubNavigation = (
    navigationKind: "install" | "configure",
  ): string | null => {
    const randomBytes = new Uint8Array(16);
    window.crypto.getRandomValues(randomBytes);
    const state = createOpaqueReconnectState(randomBytes);
    if (reconnectTarget) {
      try {
        if (sessionStorage === null) {
          throw new Error("Session storage is unavailable");
        }
        storePendingReconnectMapping(
          sessionStorage,
          createPendingReconnectMapping({
            state,
            reconnectRepositoryId: reconnectTarget.repositoryId,
            navigationKind,
            now: getCurrentTimestamp(),
          }),
        );
      } catch {
        showToast(t("repositories.connect.errors.connectFailed"), "error");
        return null;
      }
    } else if (!clearPendingReconnectMapping(sessionStorage)) {
      showToast(t("repositories.connect.errors.connectFailed"), "error");
      return null;
    }
    return state;
  };

  const handleInstallGitHubApp = () => {
    const state = prepareGitHubNavigation("install");
    if (!state) return;
    window.location.assign(getGitHubAppInstallationUrl(GITHUB_APP_SLUG, state));
  };

  const handleConfigureRepositories = (installationIdToUse?: number) => {
    const state = prepareGitHubNavigation("configure");
    if (!state) return;

    // If specific installation ID provided, use it
    if (installationIdToUse) {
      const url = new URL(
        `https://github.com/settings/installations/${installationIdToUse}`,
      );
      url.searchParams.set("state", state);
      window.location.assign(url.toString());
      return;
    }

    // Fallback to general installations page
    const url = new URL("https://github.com/settings/installations");
    url.searchParams.set("state", state);
    window.location.assign(url.toString());
  };

  const handleRetryInstallationVerification = async () => {
    if (verificationPendingInstallationId === null || isRetryingVerification) {
      return;
    }

    setIsRetryingVerification(true);
    try {
      const binding = await waitForInstallationBinding({
        installationId: verificationPendingInstallationId,
        refreshInstallation,
      });
      if (binding !== "bound") {
        setVerificationReauthRequired(binding === "reauth_required");
        showToast(
          t(
            binding === "reauth_required"
              ? "repositories.connect.verificationPending.reauthDescription"
              : "repositories.connect.verificationPending.stillPending",
          ),
          "error",
        );
        return;
      }

      consumePendingReconnectMapping(
        sessionStorage,
        installationReconnect.pendingStateToConsume,
      );
      pendingInstallationCallbackIdRef.current = null;
      window.history.replaceState(
        {},
        "",
        getConnectPathAfterInstallationCallback(
          window.location.search,
          reconnectRepositoryId,
        ),
      );
      setVerificationPendingInstallationId(null);
      setVerificationReauthRequired(false);
      setVerificationRetryVersion((version) => version + 1);
    } catch (err) {
      showToast(
        err instanceof Error
          ? err.message
          : t("repositories.connect.errors.connectFailed"),
        "error",
      );
    } finally {
      setIsRetryingVerification(false);
    }
  };

  const handleRefreshGitHubAuthorization = () => {
    navigate(
      createGitHubReauthorizationConsentUrl(
        `${window.location.pathname}${window.location.search}`,
      ),
    );
  };

  const handleRetryReconciliation = async (installationId: number) => {
    if (retryingReconciliationId !== null) return;

    setRetryingReconciliationId(installationId);
    try {
      const result = await retryReconciliation({ installationId });
      if (result.status !== "started") {
        showToast(
          t("repositories.connect.reconciliation.retryFailed"),
          "error",
        );
      }
    } catch {
      showToast(t("repositories.connect.reconciliation.retryFailed"), "error");
    } finally {
      setRetryingReconciliationId(null);
    }
  };

  const filteredRepos = repos.filter(
    (repo) =>
      repo.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      repo.description?.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const accountGroups = groupRepositoriesByInstallation(
    installations,
    filteredRepos,
  );

  return (
    <>
      <Helmet>
        <title>
          {t("repositories.connect.title") || "Connect Repository - Gitdog"}
        </title>
        <meta
          name="description"
          content={t("repositories.connect.description") || ""}
        />
      </Helmet>
      <div className={cn("min-h-[calc(100vh-200px)] py-12 px-6")}>
        <div className={cn("max-w-4xl mx-auto")}>
          <div className={cn("mb-8")}>
            <button
              onClick={() => navigate("/")}
              className={cn(
                "flex items-center gap-1 mb-4",
                "text-gray-600 hover:text-black",
                "transition-colors",
                "dark:text-gray-400 dark:hover:text-white",
              )}
            >
              <ArrowLeft size={16} className="shrink-0" />
              <span>{t("common.back")}</span>
            </button>
            <h1
              className={cn(
                "text-3xl font-brand font-bold mb-2 text-black",
                "dark:text-white",
              )}
            >
              {t("repositories.connect.heading")}
            </h1>
            <p className={cn("text-gray-600", "dark:text-gray-400")}>
              {t("repositories.connect.subtitle")}
            </p>
          </div>

          {loading ||
          installations === undefined ||
          oauthRecoveryLoading ||
          waitingForRecoveredInstallations ? (
            <div
              className={cn(
                "p-12 text-center",
                "bg-white",
                "border border-gray-200",
                "dark:bg-[#0a0a0a] dark:border-gray-800",
              )}
            >
              <LoadingIndicator />
              <p className={cn("mt-4 text-gray-600", "dark:text-gray-400")}>
                {t("repositories.connect.loadingRepos")}
              </p>
            </div>
          ) : showInstallationVerification ? (
            <div
              className={cn(
                "p-12 text-center",
                "bg-white border border-gray-200",
                "dark:bg-[#0a0a0a] dark:border-gray-800",
              )}
            >
              <SiGithub
                size={48}
                className={cn("mx-auto mb-4 text-gray-400")}
              />
              <h3
                className={cn(
                  "text-xl font-bold text-black mb-2",
                  "dark:text-white",
                )}
              >
                {t("repositories.connect.verificationPending.title")}
              </h3>
              <p
                className={cn(
                  "max-w-md mx-auto mb-6",
                  "text-gray-600 dark:text-gray-400",
                )}
              >
                {t(
                  installationVerificationRequiresConfiguration
                    ? "repositories.connect.verificationPending.organizationDescription"
                    : installationVerificationRequiresReauth
                      ? "repositories.connect.verificationPending.reauthDescription"
                      : "repositories.connect.verificationPending.description",
                )}
              </p>
              {installationVerificationRequiresReauth ||
              installationVerificationRequiresConfiguration ? (
                <p
                  className={cn(
                    "max-w-xl mx-auto mb-6 text-sm",
                    "text-gray-500 dark:text-gray-500",
                  )}
                >
                  {t(
                    "repositories.connect.verificationPending.recoveryInstructions",
                  )}
                </p>
              ) : null}
              <div className={cn("flex flex-wrap justify-center gap-3")}>
                {installationVerificationRequiresReauth ? (
                  <button
                    onClick={handleRefreshGitHubAuthorization}
                    className={cn(
                      "px-6 py-2",
                      "text-white bg-black",
                      "hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed",
                      "dark:text-black dark:bg-white dark:hover:bg-gray-200",
                    )}
                  >
                    {t("repositories.connect.verificationPending.reauthorize")}
                  </button>
                ) : null}
                <button
                  onClick={() =>
                    handleConfigureRepositories(
                      verificationPendingInstallationId ?? undefined,
                    )
                  }
                  className={cn(
                    "px-6 py-2",
                    "text-gray-700 border border-gray-300",
                    "hover:bg-gray-100",
                    "dark:text-gray-300 dark:border-gray-700 dark:hover:bg-gray-900",
                  )}
                >
                  {t("repositories.connect.verificationPending.manageAccess")}
                </button>
                {verificationPendingInstallationId !== null ? (
                  <button
                    onClick={() => void handleRetryInstallationVerification()}
                    disabled={isRetryingVerification}
                    className={cn(
                      "px-6 py-2",
                      "text-gray-700 border border-gray-300",
                      "hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed",
                      "dark:text-gray-300 dark:border-gray-700 dark:hover:bg-gray-900",
                    )}
                  >
                    {isRetryingVerification
                      ? t("repositories.connect.verificationPending.retrying")
                      : t("repositories.connect.verificationPending.retry")}
                  </button>
                ) : null}
              </div>
            </div>
          ) : error ? (
            <div
              className={cn(
                "p-12 text-center",
                "bg-white",
                "border border-gray-200",
                "dark:bg-[#0a0a0a] dark:border-gray-800",
              )}
            >
              <p className={cn("text-red-500 mb-4")}>{error}</p>
              <button
                onClick={() => navigate("/")}
                className={cn(
                  "px-6 py-2",
                  "bg-gray-200 text-black",
                  "hover:bg-gray-300",
                  "dark:bg-gray-800 dark:text-white dark:hover:bg-gray-700",
                )}
              >
                {t("common.goBack")}
              </button>
            </div>
          ) : needsInstallation ? (
            <div
              className={cn(
                "p-12 text-center",
                "bg-white",
                "border border-gray-200",
                "dark:bg-[#0a0a0a] dark:border-gray-800",
              )}
            >
              <>
                <SiGithub
                  size={48}
                  className={cn("mx-auto mb-4 text-gray-400")}
                />
                <h3
                  className={cn(
                    "text-xl font-bold text-black mb-2",
                    "dark:text-white",
                  )}
                >
                  {t("repositories.connect.install.title")}
                </h3>
                <p
                  className={cn(
                    "text-gray-600 mb-6 max-w-md mx-auto",
                    "dark:text-gray-400",
                  )}
                >
                  {t("repositories.connect.install.description")}
                </p>
                <div className={cn("flex gap-4 justify-center mb-6")}>
                  <button
                    onClick={() => navigate("/")}
                    className={cn(
                      "px-6 py-2 text-gray-700",
                      "border border-gray-300",
                      "hover:bg-gray-100",
                      "dark:border-gray-700 dark:text-gray-300 dark:hover:bg-[#1a1a1a]",
                    )}
                  >
                    {t("repositories.connect.install.maybeLater")}
                  </button>
                  <button
                    onClick={handleInstallGitHubApp}
                    className={cn(
                      "flex items-center gap-2",
                      "px-6 py-2",
                      "bg-black text-white",
                      "hover:bg-gray-800",
                      "dark:bg-white dark:text-black dark:hover:bg-gray-200",
                    )}
                  >
                    <SiGithub size={20} />
                    {t("repositories.connect.install.installButton")}
                  </button>
                </div>
              </>
            </div>
          ) : (
            <div>
              {reconnectTarget && (
                <div
                  className={cn(
                    "mb-6 p-4",
                    "bg-white border border-gray-300",
                    "dark:bg-[#0a0a0a] dark:border-gray-700",
                  )}
                >
                  <h2
                    className={cn(
                      "font-bold text-black mb-1",
                      "dark:text-white",
                    )}
                  >
                    {t("repositories.connect.reconnect.title", {
                      repository: reconnectTarget.githubRepo,
                    })}
                  </h2>
                  <p
                    className={cn(
                      "text-sm text-gray-600",
                      "dark:text-gray-400",
                    )}
                  >
                    {t("repositories.connect.reconnect.description")}
                  </p>
                </div>
              )}

              {/* Search bar */}
              <div className={cn("mb-6 relative")}>
                <Search
                  size={20}
                  className={cn(
                    "absolute left-3 top-1/2 -translate-y-1/2 text-gray-400",
                  )}
                />
                <input
                  type="text"
                  placeholder={t("repositories.connect.searchPlaceholder")}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className={cn(
                    "w-full pl-10 pr-4 py-3",
                    "bg-white text-black placeholder-gray-400",
                    "border border-gray-200",
                    "dark:bg-[#0a0a0a] dark:border-gray-800 dark:text-white",
                  )}
                />
              </div>

              {/* Add another account button */}
              <button
                onClick={handleInstallGitHubApp}
                className={cn(
                  "w-full mb-6 p-4",
                  "flex items-center justify-center gap-2",
                  "border border-dashed border-gray-300",
                  "text-gray-600 hover:text-black hover:border-black",
                  "transition-colors",
                  "dark:border-gray-700 dark:text-gray-400 dark:hover:text-white dark:hover:border-white",
                )}
              >
                <Plus size={20} />
                <span>{t("repositories.connect.addAccount")}</span>
              </button>

              {/* Grouped repositories by account */}
              <div className={cn("space-y-8")}>
                {accountGroups.length === 0 ? (
                  <div
                    className={cn(
                      "p-8 text-center",
                      "bg-white",
                      "border border-gray-200",
                      "dark:bg-[#0a0a0a] dark:border-gray-800",
                    )}
                  >
                    <p className={cn("text-gray-600", "dark:text-gray-400")}>
                      {t("repositories.connect.noReposFound")}
                    </p>
                  </div>
                ) : (
                  accountGroups.map((group) => (
                    <div key={group.installationId}>
                      {/* Account header */}
                      <div
                        className={cn(
                          "flex items-center justify-between gap-4 mb-3",
                          "pb-2 border-b border-gray-200",
                          "dark:border-gray-800",
                        )}
                      >
                        <div className={cn("flex items-center gap-2")}>
                          {group.accountType === "Organization" ? (
                            <Building2
                              size={20}
                              className={cn(
                                "text-gray-600",
                                "dark:text-gray-400",
                              )}
                            />
                          ) : (
                            <User
                              size={20}
                              className={cn(
                                "text-gray-600",
                                "dark:text-gray-400",
                              )}
                            />
                          )}
                          <span
                            className={cn(
                              "font-medium text-black",
                              "dark:text-white",
                            )}
                          >
                            {group.accountLogin}
                          </span>
                          {group.reconciliationFailed ? (
                            <span
                              className={cn(
                                "text-xs px-2 py-0.5",
                                "text-red-700 bg-red-50",
                                "dark:text-red-300 dark:bg-red-950/40",
                              )}
                            >
                              {t("repositories.connect.reconciliation.failed")}
                            </span>
                          ) : group.reconciliationPending ? (
                            <div
                              className={cn(
                                "inline-flex items-center gap-2",
                                "text-xs px-2 py-0.5",
                                "bg-gray-100 text-gray-600",
                                "dark:bg-gray-800 dark:text-gray-400",
                              )}
                            >
                              <LoadingIndicator />
                              {t("repositories.connect.reconciliation.syncing")}
                            </div>
                          ) : (
                            <span
                              className={cn(
                                "text-xs px-2 py-0.5",
                                "bg-gray-100 text-gray-600",
                                "dark:bg-gray-800 dark:text-gray-400",
                              )}
                            >
                              {t("repositories.connect.reposCount", {
                                count: group.repos.length,
                              })}
                            </span>
                          )}
                        </div>
                        <button
                          onClick={() =>
                            handleConfigureRepositories(group.installationId)
                          }
                          className={cn(
                            "text-xs px-3 py-1",
                            "text-gray-600 hover:text-black",
                            "border border-gray-300 hover:border-black",
                            "transition-colors",
                            "dark:text-gray-400 dark:border-gray-700 dark:hover:text-white dark:hover:border-white",
                          )}
                        >
                          {t("repositories.connect.configure")}
                        </button>
                      </div>

                      {/* Repos in this account */}
                      {group.reconciliationFailed ? (
                        <div
                          aria-live="assertive"
                          className={cn(
                            "p-6 text-center",
                            "bg-white",
                            "border border-red-200",
                            "dark:bg-[#0a0a0a] dark:border-red-900",
                          )}
                        >
                          <p
                            className={cn(
                              "font-medium text-black mb-1",
                              "dark:text-white",
                            )}
                          >
                            {t(
                              "repositories.connect.reconciliation.failureTitle",
                            )}
                          </p>
                          <p
                            className={cn(
                              "text-sm text-gray-600 mb-4",
                              "dark:text-gray-400",
                            )}
                          >
                            {t(
                              "repositories.connect.reconciliation.failureDescription",
                            )}
                          </p>
                          <button
                            onClick={() =>
                              void handleRetryReconciliation(
                                group.installationId,
                              )
                            }
                            disabled={retryingReconciliationId !== null}
                            className={cn(
                              "inline-flex items-center justify-center gap-2",
                              "px-5 py-2",
                              "text-white bg-black",
                              "hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed",
                              "dark:text-black dark:bg-white dark:hover:bg-gray-200",
                            )}
                          >
                            {retryingReconciliationId ===
                            group.installationId ? (
                              <>
                                <LoadingIndicator />
                                {t(
                                  "repositories.connect.reconciliation.retrying",
                                )}
                              </>
                            ) : (
                              t("repositories.connect.reconciliation.retry")
                            )}
                          </button>
                        </div>
                      ) : group.reconciliationPending ? (
                        <div
                          aria-live="polite"
                          className={cn(
                            "p-6 text-center",
                            "bg-white",
                            "border border-gray-200",
                            "dark:bg-[#0a0a0a] dark:border-gray-800",
                          )}
                        >
                          <p
                            className={cn(
                              "font-medium text-black mb-1",
                              "dark:text-white",
                            )}
                          >
                            {t("repositories.connect.reconciliation.title")}
                          </p>
                          <p
                            className={cn(
                              "text-sm text-gray-600",
                              "dark:text-gray-400",
                            )}
                          >
                            {t(
                              "repositories.connect.reconciliation.description",
                            )}
                          </p>
                        </div>
                      ) : group.repos.length === 0 ? (
                        <div
                          className={cn(
                            "p-6 text-center",
                            "bg-white",
                            "border border-gray-200",
                            "dark:bg-[#0a0a0a] dark:border-gray-800",
                          )}
                        >
                          <p
                            className={cn(
                              "text-gray-600",
                              "dark:text-gray-400",
                            )}
                          >
                            {t("repositories.connect.noReposFound")}
                          </p>
                        </div>
                      ) : (
                        <div className={cn("space-y-2")}>
                          {group.repos.map((repo) => (
                            <button
                              key={repo.id}
                              onClick={async () => {
                                setConnectingRepo(repo.id);
                                try {
                                  await createAndIndexRepository({
                                    installationId: repo.installationId,
                                    githubRepositoryId: repo.id,
                                    ...(reconnectTarget
                                      ? {
                                          reconnectRepositoryId:
                                            reconnectTarget.repositoryId,
                                        }
                                      : {}),
                                  });
                                  showToast(
                                    t("repositories.connect.connectSuccess"),
                                    "success",
                                  );
                                  navigate("/");
                                } catch (err) {
                                  const errorMessage =
                                    err instanceof Error
                                      ? err.message
                                      : t(
                                          "repositories.connect.errors.connectFailed",
                                        );
                                  showToast(errorMessage, "error");
                                  setConnectingRepo(null);
                                }
                              }}
                              disabled={connectingRepo === repo.id}
                              className={cn(
                                "w-full p-4 text-left group",
                                "bg-white",
                                "border border-gray-200",
                                "transition-colors",
                                "hover:border-black",
                                "disabled:opacity-50 disabled:cursor-not-allowed",
                                "dark:bg-[#0a0a0a] dark:border-gray-800 dark:hover:border-white",
                              )}
                            >
                              <div
                                className={cn(
                                  "flex items-start justify-between gap-4",
                                )}
                              >
                                <div className={cn("flex-1 min-w-0")}>
                                  <div
                                    className={cn(
                                      "flex items-center gap-2 mb-1",
                                    )}
                                  >
                                    <h3
                                      className={cn(
                                        "font-medium text-black truncate",
                                        "dark:text-white",
                                      )}
                                    >
                                      {repo.name}
                                    </h3>
                                    {repo.isPrivate && (
                                      <span
                                        className={cn(
                                          "text-xs px-1.5 py-0.5",
                                          "bg-gray-100 text-gray-500",
                                          "dark:bg-gray-800 dark:text-gray-400",
                                        )}
                                      >
                                        {t("repositories.connect.private")}
                                      </span>
                                    )}
                                  </div>
                                  {repo.description && (
                                    <p
                                      className={cn(
                                        "text-sm text-gray-600 line-clamp-1 mb-1",
                                        "dark:text-gray-400",
                                      )}
                                    >
                                      {repo.description}
                                    </p>
                                  )}
                                  <div
                                    className={cn(
                                      "flex items-center gap-3 text-xs text-gray-500",
                                      "dark:text-gray-500",
                                    )}
                                  >
                                    {repo.language && (
                                      <span>{repo.language}</span>
                                    )}
                                    <span
                                      className={cn("flex items-center gap-1")}
                                    >
                                      <Star size={12} className="shrink-0" />
                                      {repo.stars}
                                    </span>
                                  </div>
                                </div>
                                <div
                                  className={cn(
                                    "text-sm",
                                    connectingRepo === repo.id
                                      ? "text-blue-600 dark:text-blue-400"
                                      : "text-gray-400 group-hover:text-black dark:group-hover:text-white",
                                  )}
                                >
                                  {connectingRepo === repo.id ? (
                                    <span className="flex items-center gap-2">
                                      <LoadingIndicator />
                                    </span>
                                  ) : (
                                    t("repositories.connect.connect")
                                  )}
                                </div>
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
