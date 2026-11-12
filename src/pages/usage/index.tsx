import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Helmet } from "react-helmet-async";
import { Layout } from "../../components/Layout";
import { LoadingIndicator } from "../../components/uis/LoadingIndicator";
import { useNavigate } from "react-router";
import {
  TrendingUp,
  Calendar,
  AlertCircle,
  FileText,
  Zap,
  DollarSign,
  KeyRound,
} from "lucide-react";
import { SiGithub } from "@icons-pack/react-simple-icons";
import { useTranslation } from "react-i18next";
import { cn } from "../../utils/cn";
import {
  calculateEstimatedAdditionalUsageCharge,
  calculateTokenAvailability,
  getUtcMonthlyPeriod,
} from "../../utils/pricingConfig";

export function UsagePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const currentUser = useQuery(api.users.query.getCurrentUser);
  const repositories = useQuery(api.repositories.query.list);
  const subscription = useQuery(api.subscriptions.query.getCurrent);
  const [fallbackPeriod] = useState(() => getUtcMonthlyPeriod(Date.now()));
  const billingEstimate = useQuery(
    api.subscriptions.query.calculateOverage,
    currentUser ? {} : "skip",
  );
  const tokenUsage = useQuery(api.tokenUsage.query.getCurrentMonthUsage);
  const usageByRepository = useQuery(api.tokenUsage.query.getUsageByRepository);

  // Redirect to home if not logged in (null means not logged in, undefined means loading)
  useEffect(() => {
    if (currentUser === null) {
      navigate("/");
    }
  }, [currentUser, navigate]);

  // Show loading while checking auth
  if (
    currentUser === undefined ||
    subscription === undefined ||
    (currentUser !== null &&
      (billingEstimate === undefined ||
        tokenUsage === undefined ||
        usageByRepository === undefined ||
        repositories === undefined))
  ) {
    return (
      <Layout>
        <div className={cn("flex items-center justify-center min-h-[60vh]")}>
          <LoadingIndicator />
        </div>
      </Layout>
    );
  }

  // Token usage calculations
  // Note: Embedding tokens are already stored as "equivalent chat tokens" (divided by 50)
  const totalTokens = tokenUsage?.totalTokens || 0;
  const includedTokens = subscription?.includedTokens ?? 0;
  const purchasedTokens =
    (subscription && "purchasedTokens" in subscription
      ? subscription.purchasedTokens
      : 0) || 0;
  const purchasedTokensDebited =
    (subscription && "purchasedTokensDebited" in subscription
      ? subscription.purchasedTokensDebited
      : 0) || 0;
  const isPro = subscription?.plan === "pro";
  const usedFromPurchased = isPro
    ? (billingEstimate?.usedFromPurchased ?? 0)
    : purchasedTokensDebited;
  const remainingPurchasedTokens = isPro
    ? Math.max(0, purchasedTokens - usedFromPurchased)
    : purchasedTokens;

  // Reconstruct the period limit from the durable remaining wallet and tokens
  // already debited during the same period.
  const availability = calculateTokenAvailability({
    includedTokens,
    remainingPurchasedTokens,
    purchasedTokensDebited: usedFromPurchased,
  });
  const remainingPurchased = availability.remainingPurchasedTokens;
  const totalAvailable = availability.totalAvailableTokens;
  const tokenLimit = totalAvailable;

  // A free account with no trial or prepaid tokens left has nothing available.
  const usagePercentage =
    totalAvailable > 0
      ? Math.min((totalTokens / totalAvailable) * 100, 100)
      : 100;

  // Both plans stop at their included and prepaid token limit.
  const estimatedCost = calculateEstimatedAdditionalUsageCharge();

  // Format currency
  const formatCurrency = (cents: number) => {
    return `$${(cents / 100).toFixed(2)}`;
  };

  // Format token count
  const formatTokens = (tokens: number) => {
    if (tokens >= 1000000) {
      return `${(tokens / 1000000).toFixed(2)}M`;
    }
    if (tokens >= 1000) {
      return `${(tokens / 1000).toFixed(1)}k`;
    }
    return tokens.toString();
  };

  // Get current period dates
  const periodStart =
    subscription && "periodStart" in subscription && subscription.periodStart
      ? new Date(subscription.periodStart)
      : new Date(fallbackPeriod.periodStart);
  const periodEnd =
    subscription && "periodEnd" in subscription && subscription.periodEnd
      ? new Date(subscription.periodEnd)
      : new Date(fallbackPeriod.periodEnd);

  const formatDate = (date: Date) => {
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  return (
    <>
      <Helmet>
        <title>{t("usage.title") || "Usage - Gitdog"}</title>
        <meta name="description" content={t("usage.description") || ""} />
      </Helmet>
      <Layout>
        <div className={cn("max-w-7xl mx-auto px-6 py-12")}>
          {/* Header */}
          <div className={cn("mb-8")}>
            <h1
              className={cn(
                "text-3xl font-brand font-bold text-black mb-2",
                "dark:text-white",
              )}
            >
              {t("usage.heading")}
            </h1>
            <p className={cn("text-gray-600", "dark:text-gray-400")}>
              {t("usage.subtitle")}
            </p>
          </div>

          {/* Stats Overview */}
          <div className={cn("grid grid-cols-1 gap-6 mb-8", "md:grid-cols-4")}>
            {/* Total Tokens */}
            <div
              className={cn(
                "p-6",
                "border border-gray-200",
                "dark:border-gray-800",
              )}
            >
              <div className={cn("flex items-center gap-3 mb-2")}>
                <Zap
                  size={20}
                  className={cn(
                    "shrink-0",
                    "text-gray-600",
                    "dark:text-gray-400",
                  )}
                />
                <span
                  className={cn("text-sm text-gray-600", "dark:text-gray-400")}
                >
                  {t("usage.stats.totalTokens")}
                </span>
              </div>
              <div
                className={cn(
                  "text-3xl font-brand font-bold text-black",
                  "dark:text-white",
                )}
              >
                {formatTokens(totalTokens)}
              </div>
              <div className={cn("text-sm text-gray-500 mt-1")}>
                {purchasedTokens + purchasedTokensDebited > 0
                  ? t("usage.stats.allowanceWithPurchased", {
                      included: formatTokens(includedTokens),
                      remaining: formatTokens(remainingPurchased),
                    })
                  : t("usage.stats.includedAllowance", {
                      included: formatTokens(includedTokens),
                    })}
              </div>
            </div>

            {/* Automatic overage charges */}
            <div
              className={cn(
                "p-6",
                "border border-gray-200",
                "dark:border-gray-800",
              )}
            >
              <div className={cn("flex items-center gap-3 mb-2")}>
                <DollarSign
                  size={20}
                  className={cn("text-gray-600", "dark:text-gray-400")}
                />
                <span
                  className={cn("text-sm text-gray-600", "dark:text-gray-400")}
                >
                  {t("usage.stats.estimatedCost")}
                </span>
              </div>
              <div
                className={cn(
                  "text-3xl font-brand font-bold text-black",
                  "dark:text-white",
                )}
              >
                {formatCurrency(estimatedCost)}
              </div>
              <div className={cn("text-sm text-gray-500 mt-1")}>
                {t("usage.stats.prepaidOnly")}
              </div>
            </div>

            {/* Current Plan */}
            <div
              className={cn(
                "p-6",
                "border border-gray-200",
                "dark:border-gray-800",
              )}
            >
              <div className={cn("flex items-center gap-3 mb-2")}>
                <TrendingUp
                  size={20}
                  className={cn("text-gray-600", "dark:text-gray-400")}
                />
                <span
                  className={cn("text-sm text-gray-600", "dark:text-gray-400")}
                >
                  {t("usage.stats.currentPlan")}
                </span>
              </div>
              <div
                className={cn(
                  "text-3xl font-brand font-bold text-black capitalize",
                  "dark:text-white",
                )}
              >
                {subscription?.plan || "free"}
              </div>
              <div className={cn("text-sm text-gray-500 mt-1")}>
                {subscription?.status || t("usage.stats.active")}
              </div>
            </div>

            {/* Billing Period */}
            <div
              className={cn(
                "p-6",
                "border border-gray-200",
                "dark:border-gray-800",
              )}
            >
              <div className={cn("flex items-center gap-3 mb-2")}>
                <Calendar
                  size={20}
                  className={cn("text-gray-600", "dark:text-gray-400")}
                />
                <span
                  className={cn("text-sm text-gray-600", "dark:text-gray-400")}
                >
                  {t("usage.stats.billingPeriod")}
                </span>
              </div>
              <div
                className={cn(
                  "text-lg font-bold text-black",
                  "dark:text-white",
                )}
              >
                {formatDate(periodStart)}
              </div>
              <div className={cn("text-sm text-gray-500 mt-1")}>
                {t("usage.stats.to", { date: formatDate(periodEnd) })}
              </div>
            </div>
          </div>

          {/* Usage on the user's own provider keys (not counted in quota) */}
          {tokenUsage?.userKey && tokenUsage.userKey.totalActions > 0 && (
            <div
              className={cn(
                "p-6 mb-8",
                "border border-gray-200",
                "dark:border-gray-800",
              )}
            >
              <div className={cn("flex items-center gap-3 mb-2")}>
                <KeyRound
                  size={20}
                  className={cn("text-gray-600", "dark:text-gray-400")}
                />
                <span
                  className={cn("text-sm text-gray-600", "dark:text-gray-400")}
                >
                  {t("usage.userKey.title")}
                </span>
              </div>
              <div
                className={cn(
                  "text-3xl font-brand font-bold text-black",
                  "dark:text-white",
                )}
              >
                {formatTokens(tokenUsage.userKey.totalTokens)}
                {tokenUsage.userKey.isPartial ? "+" : ""}
              </div>
              <div className={cn("text-sm text-gray-500 mt-1")}>
                {t("usage.userKey.description", {
                  count: tokenUsage.userKey.totalActions,
                  cost: formatCurrency(
                    tokenUsage.userKey.estimatedProviderCostCents,
                  ),
                })}
              </div>
            </div>
          )}

          {/* Token Usage Progress */}
          <div
            className={cn(
              "p-6 mb-8",
              "border border-gray-200",
              "dark:border-gray-800",
            )}
          >
            <div className={cn("flex items-center justify-between mb-4")}>
              <h2
                className={cn(
                  "text-xl font-brand font-bold text-black",
                  "dark:text-white",
                )}
              >
                {t("usage.tokenUsageThisMonth")}
              </h2>
              <span
                className={cn("text-sm text-gray-600", "dark:text-gray-400")}
              >
                {t("usage.tokensCount", {
                  used: formatTokens(totalTokens),
                  limit: formatTokens(tokenLimit),
                })}
              </span>
            </div>
            <div
              className={cn("w-full h-3", "bg-gray-200", "dark:bg-gray-800")}
            >
              <div
                className={cn(
                  "h-full transition-[width]",
                  totalTokens >= tokenLimit
                    ? "bg-red-500 dark:bg-red-500"
                    : usagePercentage >= 80
                      ? "bg-yellow-500 dark:bg-yellow-500"
                      : "bg-gray-900 dark:bg-gray-100",
                )}
                style={{
                  width: `${usagePercentage}%`,
                }}
              />
            </div>
            {usagePercentage >= 80 && usagePercentage < 100 && (
              <div
                className={cn(
                  "mt-4 flex items-start gap-2 text-sm text-gray-600",
                  "dark:text-gray-400",
                )}
              >
                <AlertCircle size={16} className={cn("mt-0.5 shrink-0")} />
                <span>
                  {t("usage.approachingFreeLimit", {
                    limit: formatTokens(tokenLimit),
                  })}
                </span>
              </div>
            )}
            {usagePercentage >= 100 && (
              <div
                className={cn("mt-4 p-4", "bg-gray-100", "dark:bg-gray-900")}
              >
                <p
                  className={cn("text-sm text-gray-700", "dark:text-gray-300")}
                >
                  {t("usage.freeLimitReached")}
                </p>
              </div>
            )}
          </div>

          {/* Upgrade suggestion for free users */}
          {!isPro && (
            <div
              className={cn(
                "p-6 mb-8",
                "border border-gray-200",
                "dark:border-gray-800",
              )}
            >
              <div className={cn("flex items-center justify-between gap-6")}>
                <div>
                  <p
                    className={cn("font-medium text-black", "dark:text-white")}
                  >
                    {t("usage.upgrade.inlineTitle")}
                  </p>
                  <p
                    className={cn(
                      "text-sm text-gray-500",
                      "dark:text-gray-400",
                    )}
                  >
                    {t("usage.upgrade.inlineDescription")}
                  </p>
                </div>
                <button
                  onClick={() => navigate("/pricing")}
                  className={cn(
                    "shrink-0 px-4 py-2 text-sm text-white",
                    "bg-black",
                    "hover:bg-gray-800",
                    "dark:bg-white dark:text-black dark:hover:bg-gray-200",
                  )}
                >
                  {t("usage.upgrade.button")}
                </button>
              </div>
            </div>
          )}

          {/* Repository Usage Breakdown */}
          <div className={cn("mb-8")}>
            <h2
              className={cn(
                "text-2xl font-brand font-bold text-black mb-6",
                "dark:text-white",
              )}
            >
              {t("usage.usageByRepository")}
            </h2>
            {repositories === undefined ? (
              <div className={cn("flex items-center justify-center py-8")}>
                <LoadingIndicator />
              </div>
            ) : repositories.length === 0 ? (
              <div
                className={cn(
                  "p-8 text-center",
                  "border border-gray-200",
                  "dark:border-gray-800",
                )}
              >
                <SiGithub
                  size={48}
                  className={cn(
                    "mx-auto mb-4 text-gray-400",
                    "dark:text-gray-600",
                  )}
                />
                <p className={cn("text-gray-600 mb-4", "dark:text-gray-400")}>
                  {t("usage.noRepositories.description")}
                </p>
                <button
                  onClick={() => navigate("/repositories/connect")}
                  className={cn(
                    "px-6 py-2 bg-black text-white",
                    "hover:bg-gray-800",
                    "dark:bg-white dark:text-black dark:hover:bg-gray-200",
                  )}
                >
                  {t("usage.noRepositories.button")}
                </button>
              </div>
            ) : (
              <div className={cn("space-y-4")}>
                {repositories.map((repo) => {
                  const [owner, repoName] = repo.githubRepo.split("/");
                  const repoUsage = usageByRepository?.find(
                    (u) => u.repositoryId === repo._id,
                  );
                  const repoTokens = repoUsage?.totalTokens ?? 0;
                  const repoUserKeyTokens = repoUsage?.userKeyTokens ?? 0;

                  return (
                    <div
                      key={repo._id}
                      className={cn(
                        "p-6",
                        "border border-gray-200",
                        "dark:border-gray-800",
                      )}
                    >
                      <div
                        className={cn("flex items-start justify-between mb-4")}
                      >
                        <div className={cn("flex items-center gap-3")}>
                          <SiGithub
                            size={24}
                            className={cn(
                              "shrink-0",
                              "text-gray-700",
                              "dark:text-gray-300",
                            )}
                          />
                          <div>
                            <h3
                              className={cn(
                                "text-lg font-bold text-black",
                                "dark:text-white",
                              )}
                            >
                              {repo.githubRepo}
                            </h3>
                            <p
                              className={cn(
                                "text-sm text-gray-600",
                                "dark:text-gray-400",
                              )}
                            >
                              {t("usage.actionsThisMonth", {
                                count: repo.monthlyActions,
                              })}
                            </p>
                          </div>
                        </div>
                        <div className={cn("flex items-center gap-4")}>
                          <div className={cn("text-right")}>
                            <div
                              className={cn(
                                "text-lg font-bold text-black",
                                "dark:text-white",
                              )}
                            >
                              {formatTokens(repoTokens)}
                            </div>
                            <div
                              className={cn(
                                "text-xs text-gray-500",
                                "dark:text-gray-400",
                              )}
                            >
                              {t("usage.tokens")}
                            </div>
                            {repoUserKeyTokens > 0 && (
                              <div
                                className={cn(
                                  "text-xs text-gray-500",
                                  "dark:text-gray-400",
                                )}
                              >
                                {t("usage.userKey.repositoryTokens", {
                                  tokens: formatTokens(repoUserKeyTokens),
                                })}
                              </div>
                            )}
                          </div>
                          <button
                            onClick={() =>
                              navigate(`/repositories/${owner}/${repoName}`)
                            }
                            className={cn(
                              "text-sm text-gray-600",
                              "hover:text-black",
                              "dark:text-gray-400 dark:hover:text-white",
                            )}
                          >
                            {t("home.workspace.repoCard.settings")}
                          </button>
                        </div>
                      </div>

                      {/* Feature status - simplified to just show Issue/Discussion Assistant */}
                      <div className={cn("flex items-center gap-4 text-sm")}>
                        {repo.settings.issueAssistantEnabled && (
                          <div
                            className={cn(
                              "flex items-center gap-2 text-gray-600",
                              "dark:text-gray-400",
                            )}
                          >
                            <FileText size={16} className="shrink-0" />
                            <span>
                              {t("usage.featureLabels.issueAssistant")}
                            </span>
                          </div>
                        )}
                        {repo.settings.discussionAssistantEnabled && (
                          <div
                            className={cn(
                              "flex items-center gap-2 text-gray-600",
                              "dark:text-gray-400",
                            )}
                          >
                            <FileText size={16} className="shrink-0" />
                            <span>
                              {t("usage.featureLabels.discussionAssistant")}
                            </span>
                          </div>
                        )}
                        {!repo.settings.issueAssistantEnabled &&
                          !repo.settings.discussionAssistantEnabled && (
                            <div
                              className={cn(
                                "text-gray-400",
                                "dark:text-gray-600",
                              )}
                            >
                              {t("usage.noFeaturesEnabled")}
                            </div>
                          )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </Layout>
    </>
  );
}
