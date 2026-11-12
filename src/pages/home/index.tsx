import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { SEO } from "../../components/SEO";
import { Layout } from "../../components/Layout";
import { Link, useNavigate } from "react-router";
import { Activity, Clock, Zap } from "lucide-react";
import { SiGithub } from "@icons-pack/react-simple-icons";
import { LoadingIndicator } from "../../components/uis/LoadingIndicator";
import { useTranslation } from "react-i18next";
import { LandingPage } from "./LandingPage";
import { RepositoryIndexingProgress } from "./RepositoryIndexingProgress";
import {
  FAQPageJsonLd,
  SoftwareApplicationJsonLd,
} from "../../components/JsonLd";

export function HomePage() {
  const { t } = useTranslation();
  const repositories = useQuery(api.repositories.query.list);
  const currentUser = useQuery(api.users.query.getCurrentUser);
  const subscription = useQuery(api.subscriptions.query.getCurrent);
  const navigate = useNavigate();

  // Show loading while checking auth
  if (currentUser === undefined) {
    return (
      <>
        <SEO path="/" />
        <Layout>
          <div className="min-h-[calc(100vh-200px)] flex items-center justify-center">
            <LoadingIndicator />
          </div>
        </Layout>
      </>
    );
  }

  const homeFaqs = [
    {
      question: "What is Gitdog?",
      answer:
        "Gitdog is an AI-powered GitHub assistant that automatically responds to issues and discussions by understanding your codebase context.",
    },
    {
      question: "How does Gitdog work?",
      answer:
        "Connect your GitHub repository, and when users mention @gitdogbot in issues or discussions, the AI analyzes your codebase and provides intelligent, context-aware responses.",
    },
    {
      question: "Is Gitdog free to use?",
      answer:
        "Yes. Free includes 100,000 tokens per month, and Pro is $9.99/month with 2.4M tokens. Prepaid token packs are available when you need more, with no automatic overage charges.",
    },
    {
      question: "What languages does Gitdog support?",
      answer:
        "Gitdog supports all programming languages including JavaScript, TypeScript, Python, Go, Rust, Java, C++, and many more.",
    },
  ];

  // Show landing page if not authenticated
  if (currentUser === null) {
    return (
      <>
        <SEO
          title={t("home.title") || undefined}
          description={t("home.description") || undefined}
          path="/"
        />
        <SoftwareApplicationJsonLd />
        <FAQPageJsonLd faqs={homeFaqs} />
        <Layout>
          <LandingPage />
        </Layout>
      </>
    );
  }

  return (
    <>
      <SEO
        title={t("home.workspace.title") || "Workspace"}
        description={t("home.workspace.description")}
        path="/"
        noIndex
      />
      <Layout>
        <div className="max-w-7xl mx-auto px-6 py-12">
          {/* Header */}
          <div className="mb-12">
            <h1 className="text-4xl font-brand font-bold text-black dark:text-white mb-4">
              {t("home.workspace.title")}
            </h1>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <div className="flex items-center gap-2">
                <span className="text-gray-600 dark:text-gray-400">
                  {t("home.workspace.plan")}
                </span>
                <span className="px-3 py-1 bg-black dark:bg-white text-white dark:text-black text-sm font-medium capitalize">
                  {subscription?.plan || "free"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Activity
                  size={16}
                  className="text-gray-600 dark:text-gray-400"
                  aria-hidden="true"
                />
                <span className="text-gray-600 dark:text-gray-400">
                  {subscription?.plan === "pro"
                    ? t("home.workspace.tokensPerMonth", {
                        count: subscription.includedTokens / 1000,
                      })
                    : t("home.workspace.prepaidTokens", {
                        count: Math.floor(
                          (subscription?.purchasedTokens ?? 0) / 1000,
                        ),
                      })}
                </span>
              </div>
            </div>
          </div>

          {/* Repositories Section */}
          <section>
            <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
              <h2 className="text-2xl font-brand font-bold text-black dark:text-white">
                {t("home.workspace.connectedRepositories")}
              </h2>
              <button
                onClick={() => navigate("/repositories/connect")}
                className="px-6 py-2 bg-black dark:bg-white text-white dark:text-black hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors flex items-center gap-2"
              >
                <SiGithub size={20} className="shrink-0" />
                {t("home.workspace.connectRepository")}
              </button>
            </div>

            {repositories === undefined ? (
              <div className="flex items-center justify-center py-8">
                <LoadingIndicator />
              </div>
            ) : repositories.length === 0 ? (
              <div className="border border-gray-200 dark:border-gray-800 p-12 text-center">
                <SiGithub
                  size={48}
                  className="mx-auto mb-4 text-gray-400 dark:text-gray-600"
                />
                <h3 className="text-xl font-bold text-black dark:text-white mb-2">
                  {t("home.workspace.noRepositories.title")}
                </h3>
                <p className="text-gray-600 dark:text-gray-400 mb-6">
                  {t("home.workspace.noRepositories.description")}
                </p>
                <button
                  onClick={() => navigate("/repositories/connect")}
                  className="px-6 py-3 bg-black dark:bg-white text-white dark:text-black hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors"
                >
                  {t("home.workspace.connectRepository")}
                </button>
              </div>
            ) : (
              <div className="grid gap-4">
                {repositories.map((repo) => {
                  const [owner, repoName] = repo.githubRepo.split("/");
                  const activeFeatures = Object.entries(repo.settings).filter(
                    ([key, value]) =>
                      typeof value === "boolean" &&
                      value &&
                      key.startsWith("auto"),
                  ).length;
                  const indexStatus = repo.indexStatus;
                  const ragStatus = repo.ragStatus;
                  const requiresReconnect =
                    repo.githubInstallationReconnectRequired === true;
                  const canReconnect = repo.userRole === "owner";

                  const hasActiveIndexing =
                    !requiresReconnect &&
                    repo.githubAccessRevokedAt === undefined &&
                    repo.isActive &&
                    indexStatus !== "failed" &&
                    ragStatus !== "failed" &&
                    (indexStatus === "pending" ||
                      indexStatus === "indexing" ||
                      ragStatus === "indexing" ||
                      (indexStatus === "completed" && ragStatus === "pending"));
                  const hasIndexingFailure =
                    !requiresReconnect &&
                    repo.isActive &&
                    repo.githubAccessRevokedAt === undefined &&
                    (indexStatus === "failed" || ragStatus === "failed");

                  return (
                    <div
                      key={repo._id}
                      className="relative border border-gray-200 dark:border-gray-800 p-6 hover:border-black dark:hover:border-white focus-within:border-black dark:focus-within:border-white transition-colors"
                    >
                      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 mb-2">
                            <SiGithub
                              size={24}
                              className="shrink-0 text-gray-700 dark:text-gray-300"
                            />
                            <h3 className="min-w-0 text-xl font-bold text-black dark:text-white break-words">
                              <Link
                                to={
                                  repo.githubAccessRevokedAt !== undefined ||
                                  requiresReconnect ||
                                  hasActiveIndexing ||
                                  hasIndexingFailure
                                    ? `/repositories/${owner}/${repoName}`
                                    : `/tickets?repo=${repo.githubRepo}`
                                }
                                className="after:absolute after:inset-0"
                              >
                                {repo.githubRepo}
                              </Link>
                            </h3>
                            {requiresReconnect ? (
                              <span className="px-2 py-1 bg-amber-100 dark:bg-amber-950/30 text-xs text-amber-800 dark:text-amber-200 border border-amber-300 dark:border-amber-800">
                                {t("home.workspace.repoCard.reconnectRequired")}
                              </span>
                            ) : repo.githubAccessRevokedAt !== undefined ? (
                              <span className="px-2 py-1 bg-red-100 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300 border border-red-300 dark:border-red-800">
                                {t(
                                  "home.workspace.repoCard.githubAccessRemoved",
                                )}
                              </span>
                            ) : !repo.isActive ? (
                              <span className="px-2 py-1 bg-gray-200 dark:bg-gray-800 text-xs text-gray-600 dark:text-gray-400">
                                {t("home.workspace.repoCard.paused")}
                              </span>
                            ) : null}
                            {hasIndexingFailure && (
                              <span className="px-2 py-1 bg-red-100 dark:bg-red-900/30 text-xs text-red-800 dark:text-red-200 border border-red-300 dark:border-red-700">
                                {t("home.workspace.repoCard.failed")}
                              </span>
                            )}
                          </div>
                          {hasActiveIndexing && (
                            <RepositoryIndexingProgress repository={repo} />
                          )}
                          {repo.description && (
                            <p className="text-gray-600 dark:text-gray-400 mb-3">
                              {repo.description}
                            </p>
                          )}
                          {requiresReconnect && (
                            <p className="text-sm text-amber-800 dark:text-amber-200 mb-3">
                              {t(
                                "home.workspace.repoCard.reconnectDescription",
                              )}
                            </p>
                          )}
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-500 dark:text-gray-400">
                            {repo.language && (
                              <span className="flex items-center gap-1">
                                <Zap size={14} className="shrink-0" />
                                {repo.language}
                              </span>
                            )}
                            <span className="flex items-center gap-1">
                              <Activity size={14} />
                              {t("home.workspace.repoCard.featuresEnabled", {
                                count: activeFeatures,
                              })}
                            </span>
                            <span className="flex items-center gap-1">
                              <Clock size={14} className="shrink-0" />
                              {t("home.workspace.repoCard.actionsThisMonth", {
                                count: repo.monthlyActions,
                              })}
                            </span>
                          </div>
                        </div>
                        <div className="relative z-10 flex items-center gap-3 self-start sm:flex-col sm:items-end">
                          {requiresReconnect && canReconnect && (
                            <button
                              onClick={() => {
                                navigate(
                                  `/repositories/connect?reconnectRepositoryId=${encodeURIComponent(repo._id)}`,
                                );
                              }}
                              className="px-4 py-2 text-sm text-amber-900 dark:text-amber-100 border border-amber-500 hover:bg-amber-50 dark:hover:bg-amber-950/30 transition-colors"
                            >
                              {t("home.workspace.repoCard.reconnectButton")}
                            </button>
                          )}
                          <Link
                            to={`/repositories/${owner}/${repoName}`}
                            className="text-sm text-gray-600 dark:text-gray-400 hover:text-black dark:hover:text-white hover:underline transition-colors"
                          >
                            {t("home.workspace.repoCard.settings")}
                          </Link>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </Layout>
    </>
  );
}
