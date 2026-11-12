import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Helmet } from "react-helmet-async";
import { Layout } from "../../components/Layout";
import { LoadingIndicator } from "../../components/uis/LoadingIndicator";
import { useNavigate } from "react-router";
import { useEffect, useState } from "react";
import { CreditCard, Calendar, Activity, Settings } from "lucide-react";
import { SiGithub } from "@icons-pack/react-simple-icons";
import { useTranslation } from "react-i18next";
import { cn } from "../../utils/cn";
import { ProviderKeysSection } from "./ProviderKeysSection";
import { TrialNextStep } from "../../components/TrialNextStep";
import {
  calculateTokenAvailability,
  getUtcMonthlyPeriod,
} from "../../utils/pricingConfig";

export function ProfilePage() {
  const { t } = useTranslation();
  const currentUser = useQuery(api.users.query.getCurrentUser);
  const subscription = useQuery(api.subscriptions.query.getCurrent);
  const repositories = useQuery(api.repositories.query.list);
  const billingEstimate = useQuery(
    api.subscriptions.query.calculateOverage,
    currentUser ? {} : "skip",
  );
  const tokenUsage = useQuery(
    api.tokenUsage.query.getCurrentMonthUsage,
    currentUser ? {} : "skip",
  );
  const navigate = useNavigate();
  const [fallbackPeriod] = useState(() => getUtcMonthlyPeriod(Date.now()));

  useEffect(() => {
    if (currentUser === null) {
      navigate("/");
    }
  }, [currentUser, navigate]);

  if (
    currentUser === undefined ||
    subscription === undefined ||
    repositories === undefined ||
    (currentUser !== null &&
      (billingEstimate === undefined || tokenUsage === undefined))
  ) {
    return (
      <Layout>
        <div
          className={cn(
            // Display & Container
            "flex items-center justify-center",
            // Sizing
            "min-h-screen",
            // Backgrounds
            "bg-[#F5F5F5]",
            // Dark Mode
            "dark:bg-[#1a1a1a]",
          )}
        >
          <LoadingIndicator />
        </div>
      </Layout>
    );
  }

  if (!currentUser) {
    return null;
  }

  const includedTokens = subscription?.includedTokens ?? 0;
  const purchasedTokens = subscription?.purchasedTokens ?? 0;
  const purchasedTokensDebited = subscription?.purchasedTokensDebited ?? 0;
  const isPro = subscription?.plan === "pro";
  const usedFromPurchased = isPro
    ? (billingEstimate?.usedFromPurchased ?? 0)
    : purchasedTokensDebited;
  const availability = calculateTokenAvailability({
    includedTokens,
    remainingPurchasedTokens: isPro
      ? Math.max(0, purchasedTokens - usedFromPurchased)
      : purchasedTokens,
    purchasedTokensDebited: usedFromPurchased,
  });

  // Free accounts only have trial and prepaid tokens, which never reset.
  const tokensLeft = Math.max(
    0,
    availability.totalAvailableTokens - (tokenUsage?.totalTokens ?? 0),
  );

  const formatTokens = (tokens: number) => {
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
    return tokens.toString();
  };

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
    <Layout>
      <Helmet>
        <title>{t("profile.title") || "Profile - Gitdog"}</title>
        <meta name="description" content={t("profile.description") || ""} />
      </Helmet>
      <div className={cn("max-w-7xl mx-auto px-6 py-12")}>
        {/* Profile Header */}
        <div
          className={cn(
            // Spacing
            "p-8 mb-8",
            // Borders
            "border border-gray-200",
            // Dark Mode
            "dark:border-gray-800",
          )}
        >
          <div className={cn("flex flex-wrap items-center gap-6")}>
            {currentUser.profile?.avatarUrl ? (
              <img
                src={currentUser.profile.avatarUrl}
                alt={
                  currentUser.profile.displayName ||
                  currentUser.profile.githubUsername ||
                  ""
                }
                className={cn("w-24 h-24 object-cover")}
              />
            ) : (
              <div
                className={cn(
                  // Display & Container
                  "flex items-center justify-center",
                  // Sizing
                  "w-24 h-24",
                  // Backgrounds
                  "bg-gray-200",
                  // Dark Mode
                  "dark:bg-gray-700",
                )}
              >
                <span
                  className={cn("text-4xl text-gray-500", "dark:text-gray-400")}
                >
                  {(
                    currentUser.profile?.displayName?.[0] ||
                    currentUser.profile?.githubUsername?.[0] ||
                    "?"
                  ).toUpperCase()}
                </span>
              </div>
            )}
            <div className={cn("flex-1 min-w-48")}>
              <h1
                className={cn(
                  "text-3xl font-brand font-bold text-black mb-2 break-words",
                  "dark:text-white",
                )}
              >
                {currentUser.profile?.displayName ||
                  currentUser.profile?.githubUsername ||
                  "user"}
              </h1>
              {currentUser.profile?.githubUsername && (
                <p
                  className={cn(
                    "text-gray-600 flex items-center gap-2",
                    "dark:text-gray-400",
                  )}
                >
                  <SiGithub size={16} className="shrink-0" />@
                  {currentUser.profile.githubUsername}
                </p>
              )}
              {currentUser.email && (
                <p className={cn("text-gray-600", "dark:text-gray-400")}>
                  {currentUser.email}
                </p>
              )}
            </div>
            <button
              onClick={() => navigate("/usage")}
              className={cn(
                // Display & Container
                "flex items-center gap-2",
                // Spacing
                "px-4 py-2",
                // Typography
                "text-gray-700",
                // Borders
                "border border-gray-300",
                // State Modifiers
                "hover:bg-gray-100",
                // Dark Mode
                "dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800",
              )}
            >
              <Settings size={20} />
              {t("nav.settings")}
            </button>
          </div>
        </div>

        {/* Subscription Info */}
        <section className={cn("mb-8")}>
          <h2
            className={cn(
              "text-2xl font-brand font-bold text-black mb-6",
              "dark:text-white",
            )}
          >
            {t("profile.subscription.title")}
          </h2>
          <div className={cn("grid grid-cols-1 gap-6", "md:grid-cols-3")}>
            {/* Current Plan */}
            <div
              className={cn(
                "p-6",
                "border border-gray-200",
                "dark:border-gray-800",
              )}
            >
              <div className={cn("flex items-center gap-2 mb-2")}>
                <CreditCard
                  size={20}
                  className={cn("text-gray-600", "dark:text-gray-400")}
                />
                <span
                  className={cn("text-sm text-gray-600", "dark:text-gray-400")}
                >
                  {t("profile.subscription.currentPlan")}
                </span>
              </div>
              <div
                className={cn(
                  "text-2xl font-brand font-bold text-black capitalize",
                  "dark:text-white",
                )}
              >
                {subscription?.plan || "free"}
              </div>
              <p className={cn("text-sm text-gray-500 mt-1")}>
                {subscription?.status || t("profile.subscription.active")}
              </p>
            </div>

            {/* Usage */}
            <div
              className={cn(
                "p-6",
                "border border-gray-200",
                "dark:border-gray-800",
              )}
            >
              <div className={cn("flex items-center gap-2 mb-2")}>
                <Activity
                  size={20}
                  className={cn("text-gray-600", "dark:text-gray-400")}
                />
                <span
                  className={cn("text-sm text-gray-600", "dark:text-gray-400")}
                >
                  {isPro
                    ? t("profile.subscription.currentBillingPeriod")
                    : t("trial.tokensLeftLabel")}
                </span>
              </div>
              <div
                className={cn(
                  "text-2xl font-brand font-bold text-black",
                  "dark:text-white",
                )}
              >
                {isPro
                  ? `${formatTokens(tokenUsage?.totalTokens ?? 0)} ${t("usage.tokens")}`
                  : `${formatTokens(tokensLeft)} ${t("usage.tokens")}`}
              </div>
              <p className={cn("text-sm text-gray-500 mt-1")}>
                {!isPro
                  ? t("trial.tokensLeftNote")
                  : purchasedTokens + purchasedTokensDebited > 0
                    ? t("usage.stats.allowanceWithPurchased", {
                        included: formatTokens(includedTokens),
                        remaining: formatTokens(
                          availability.remainingPurchasedTokens,
                        ),
                      })
                    : t("usage.stats.includedAllowance", {
                        included: formatTokens(includedTokens),
                      })}
              </p>
            </div>

            {/* Billing Period */}
            <div
              className={cn(
                "p-6",
                "border border-gray-200",
                "dark:border-gray-800",
              )}
            >
              <div className={cn("flex items-center gap-2 mb-2")}>
                <Calendar
                  size={20}
                  className={cn("text-gray-600", "dark:text-gray-400")}
                />
                <span
                  className={cn("text-sm text-gray-600", "dark:text-gray-400")}
                >
                  {t("profile.subscription.billingPeriod")}
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
              <p className={cn("text-sm text-gray-500 mt-1")}>
                {t("profile.subscription.to", { date: formatDate(periodEnd) })}
              </p>
            </div>
          </div>

          {!isPro && (
            <div className={cn("mt-6")}>
              <TrialNextStep tokensLeft={tokensLeft} />
            </div>
          )}
        </section>

        <ProviderKeysSection />

        {/* Connected Repositories */}
        <section>
          <div className={cn("flex items-center justify-between mb-6")}>
            <h2
              className={cn(
                "text-2xl font-brand font-bold text-black",
                "dark:text-white",
              )}
            >
              {t("profile.repositories.title")}
            </h2>
            <button
              onClick={() => navigate("/")}
              className={cn(
                "text-gray-600",
                "hover:text-black",
                "dark:text-gray-400 dark:hover:text-white",
              )}
            >
              {t("common.viewAll")} →
            </button>
          </div>
          <div
            className={cn(
              "p-6",
              "border border-gray-200",
              "dark:border-gray-800",
            )}
          >
            <div className={cn("flex items-center gap-2 mb-2")}>
              <SiGithub
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
                {t("profile.repositories.totalRepositories")}
              </span>
            </div>
            <div
              className={cn(
                "text-2xl font-brand font-bold text-black",
                "dark:text-white",
              )}
            >
              {repositories.length}
            </div>
            <p className={cn("text-sm text-gray-500 mt-1")}>
              {t("profile.repositories.active", {
                count: repositories.filter((r) => r.isActive).length,
              })}
            </p>
          </div>
        </section>
      </div>
    </Layout>
  );
}
