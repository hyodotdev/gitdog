import { useQuery, useAction } from "convex/react";
import { useState } from "react";
import { api } from "../../../convex/_generated/api";
import { SEO } from "../../components/SEO";
import { Layout } from "../../components/Layout";
import { LoadingIndicator } from "../../components/uis/LoadingIndicator";
import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { cn } from "../../utils/cn";
import {
  PricingPageJsonLd,
  FAQPageJsonLd,
  BreadcrumbJsonLd,
} from "../../components/JsonLd";

export function PricingPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const currentUser = useQuery(api.users.query.getCurrentUser);
  const subscription = useQuery(api.subscriptions.query.getCurrent);
  const pricingInfo = useQuery(api.subscriptions.query.getPricingInfo);
  const usageStats = useQuery(
    api.tokenUsage.query.getCurrentMonthUsage,
    currentUser ? {} : "skip",
  );
  const createCheckoutUrl = useAction(
    api.subscriptions.action.createCheckoutUrl,
  );
  const createTokenPackCheckoutUrl = useAction(
    api.subscriptions.action.createTokenPackCheckoutUrl,
  );
  const [isUpgrading, setIsUpgrading] = useState(false);
  const [isPurchasingSmall, setIsPurchasingSmall] = useState(false);
  const [isPurchasingLarge, setIsPurchasingLarge] = useState(false);

  const isLoggedIn = currentUser !== null;

  const handleSignIn = () => {
    navigate("/legal/consent");
  };

  // Show loading only when user is logged in and data is still loading
  if (
    currentUser === undefined ||
    (currentUser !== null &&
      (pricingInfo === undefined ||
        subscription === undefined ||
        usageStats === undefined))
  ) {
    return (
      <Layout>
        <div className={cn("flex items-center justify-center min-h-[60vh]")}>
          <LoadingIndicator />
        </div>
      </Layout>
    );
  }

  const currentPlan = subscription?.plan || "free";

  const handleUpgrade = async () => {
    if (!isLoggedIn) {
      window.location.href = "/";
      return;
    }
    try {
      setIsUpgrading(true);
      const result = await createCheckoutUrl({ plan: "pro" });
      window.location.href = result.checkoutUrl;
    } catch (error) {
      console.error("Failed to create checkout URL:", error);
      alert("Failed to start checkout. Please try again.");
      setIsUpgrading(false);
    }
  };

  const handlePurchaseTokenPack = async (packSize: "small" | "large") => {
    if (!isLoggedIn) {
      window.location.href = "/";
      return;
    }
    const setIsPurchasing =
      packSize === "small" ? setIsPurchasingSmall : setIsPurchasingLarge;
    try {
      setIsPurchasing(true);
      const result = await createTokenPackCheckoutUrl({ packSize });
      window.location.href = result.checkoutUrl;
    } catch (error) {
      console.error("Failed to create token pack checkout URL:", error);
      alert("Failed to start checkout. Please try again.");
      setIsPurchasing(false);
    }
  };

  const formatCurrency = (cents: number) => {
    return `$${(cents / 100).toFixed(2)}`;
  };

  const formatTokens = (tokens: number) => {
    if (tokens >= 1000000) {
      return `${(tokens / 1000000).toFixed(2)}M`;
    }
    if (tokens >= 1000) {
      return `${(tokens / 1000).toFixed(1)}k`;
    }
    return tokens.toString();
  };

  const pricingFaqs = [
    {
      question: "What is Gitdog?",
      answer:
        "Gitdog is an AI-powered GitHub assistant that automatically responds to issues and discussions by understanding your codebase context.",
    },
    {
      question: "How do I get started with Gitdog?",
      answer:
        "Sign in with your GitHub account at gitdog.dev, connect your repository, and start mentioning @gitdogbot in your issues or discussions.",
    },
    {
      question: "What is the difference between Free and Pro plans?",
      answer:
        "Free starts with 100,000 one-time trial tokens; after that, use your own Anthropic or OpenAI API key. Pro ($9.99/month) includes 2.4M tokens each month. Gitdog-paid usage stops at the token limit, and prepaid token packs are available without automatic overage charges.",
    },
    {
      question: "Do token packs expire?",
      answer:
        "No, token packs never expire. You can use them anytime after purchase.",
    },
    {
      question: "What programming languages does Gitdog support?",
      answer:
        "Gitdog supports all programming languages including JavaScript, TypeScript, Python, Go, Rust, Java, C++, and many more.",
    },
  ];

  return (
    <>
      <SEO
        title={t("pricing.title") || "Pricing"}
        description={t("pricing.description") || undefined}
        path="/pricing"
      />
      <PricingPageJsonLd />
      <FAQPageJsonLd faqs={pricingFaqs} />
      <BreadcrumbJsonLd
        items={[
          { name: "Home", url: "/" },
          { name: "Pricing", url: "/pricing" },
        ]}
      />
      <Layout>
        <div className={cn("max-w-7xl mx-auto px-6 py-12")}>
          {/* Header */}
          <div className={cn("mb-12 text-center")}>
            <h1
              className={cn(
                "text-4xl font-brand font-bold text-black mb-4",
                "dark:text-white",
              )}
            >
              {isLoggedIn
                ? t("pricing.loggedIn.heading")
                : t("pricing.heading")}
            </h1>
            <p
              className={cn(
                "text-lg text-gray-600 max-w-2xl mx-auto",
                "dark:text-gray-400",
              )}
            >
              {isLoggedIn
                ? t("pricing.loggedIn.subtitle")
                : t("pricing.subtitle")}
            </p>
          </div>

          {/* Current Usage Summary - Only for logged in users */}
          {isLoggedIn && usageStats && (
            <div
              className={cn(
                "p-8 mb-8",
                "border border-gray-200",
                "dark:border-gray-800",
              )}
            >
              <h2
                className={cn(
                  "text-xl font-brand font-bold text-black mb-6",
                  "dark:text-white",
                )}
              >
                {t("pricing.loggedIn.currentUsage")}
              </h2>
              <div className={cn("grid grid-cols-1 gap-8", "md:grid-cols-4")}>
                <div>
                  <p
                    className={cn(
                      "text-sm text-gray-500 mb-2",
                      "dark:text-gray-500",
                    )}
                  >
                    {t("pricing.loggedIn.plan")}
                  </p>
                  <p
                    className={cn(
                      "text-2xl font-bold text-black capitalize",
                      "dark:text-white",
                    )}
                  >
                    {currentPlan}
                  </p>
                </div>
                <div>
                  <p
                    className={cn(
                      "text-sm text-gray-500 mb-2",
                      "dark:text-gray-500",
                    )}
                  >
                    {t("pricing.loggedIn.tokensThisMonth")}
                  </p>
                  <p
                    className={cn(
                      "text-2xl font-bold text-black",
                      "dark:text-white",
                    )}
                  >
                    {formatTokens(usageStats.totalTokens)}
                  </p>
                </div>
                <div>
                  <p
                    className={cn(
                      "text-sm text-gray-500 mb-2",
                      "dark:text-gray-500",
                    )}
                  >
                    {t("pricing.loggedIn.actionsThisMonth")}
                  </p>
                  <p
                    className={cn(
                      "text-2xl font-bold text-black",
                      "dark:text-white",
                    )}
                  >
                    {usageStats.totalActions}
                  </p>
                </div>
                <div>
                  <p
                    className={cn(
                      "text-sm text-gray-500 mb-2",
                      "dark:text-gray-500",
                    )}
                  >
                    {t("pricing.loggedIn.estimatedCost")}
                  </p>
                  <p
                    className={cn(
                      "text-2xl font-bold text-black",
                      "dark:text-white",
                    )}
                  >
                    {formatCurrency(0)}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Pricing Plans */}
          <div className={cn("grid grid-cols-1 gap-6 mb-12", "lg:grid-cols-2")}>
            {/* Free Plan */}
            <div
              className={cn(
                "p-8 flex flex-col",
                "border border-gray-200",
                isLoggedIn &&
                  currentPlan === "free" &&
                  "border-2 border-black dark:border-white",
                "dark:border-gray-800",
              )}
            >
              <div className={cn("mb-6")}>
                <h3
                  className={cn(
                    "text-2xl font-brand font-bold text-black mb-2",
                    "dark:text-white",
                  )}
                >
                  Free
                </h3>
                <div className={cn("flex items-baseline gap-1 mb-3")}>
                  <span
                    className={cn(
                      "text-4xl font-brand font-bold text-black",
                      "dark:text-white",
                    )}
                  >
                    $0
                  </span>
                  <span className={cn("text-gray-500", "dark:text-gray-500")}>
                    /{t("pricing.month")}
                  </span>
                </div>
                <p
                  className={cn("text-sm text-gray-500", "dark:text-gray-500")}
                >
                  {t("pricing.freeDescription")}
                </p>
              </div>

              <ul className={cn("space-y-3 mb-8 flex-1")}>
                <li
                  className={cn(
                    "flex items-start gap-2 text-gray-600",
                    "dark:text-gray-400",
                  )}
                >
                  <Check size={20} className={cn("shrink-0 mt-0.5")} />
                  <span>{t("pricing.features.freeTokens")}</span>
                </li>
                <li
                  className={cn(
                    "flex items-start gap-2 text-gray-600",
                    "dark:text-gray-400",
                  )}
                >
                  <Check size={20} className={cn("shrink-0 mt-0.5")} />
                  <span>{t("pricing.features.ownKey")}</span>
                </li>
                <li
                  className={cn(
                    "flex items-start gap-2 text-gray-600",
                    "dark:text-gray-400",
                  )}
                >
                  <Check size={20} className={cn("shrink-0 mt-0.5")} />
                  <span>{t("pricing.features.allFeatures")}</span>
                </li>
                <li
                  className={cn(
                    "flex items-start gap-2 text-gray-600",
                    "dark:text-gray-400",
                  )}
                >
                  <Check size={20} className={cn("shrink-0 mt-0.5")} />
                  <span>{t("pricing.features.issueAssistant")}</span>
                </li>
              </ul>

              {isLoggedIn ? (
                <button
                  disabled={currentPlan === "free"}
                  className={cn(
                    "w-full py-3",
                    "border border-gray-300",
                    currentPlan === "free"
                      ? "bg-gray-100 text-gray-500 cursor-not-allowed dark:bg-gray-900 dark:text-gray-600"
                      : "hover:bg-gray-100 dark:hover:bg-gray-900",
                    "dark:border-gray-700",
                  )}
                >
                  {currentPlan === "free"
                    ? t("pricing.currentPlan")
                    : t("pricing.downgrade")}
                </button>
              ) : (
                <button
                  onClick={handleSignIn}
                  className={cn(
                    "w-full py-3 text-center",
                    "border border-gray-300",
                    "hover:bg-gray-100 dark:hover:bg-gray-900",
                    "dark:border-gray-700",
                  )}
                >
                  {t("pricing.getStarted")}
                </button>
              )}
            </div>

            {/* Pro Plan */}
            <div
              className={cn(
                "p-8 relative flex flex-col",
                "border-2 border-black",
                "dark:border-white",
              )}
            >
              {/* Recommended badge */}
              <div
                className={cn(
                  "absolute -top-3 left-1/2 -translate-x-1/2",
                  "px-4 py-1",
                  "bg-black text-white text-sm",
                  "dark:bg-white dark:text-black",
                )}
              >
                {t("pricing.recommended")}
              </div>

              <div className={cn("mb-6")}>
                <h3
                  className={cn(
                    "text-2xl font-brand font-bold text-black mb-2",
                    "dark:text-white",
                  )}
                >
                  Pro
                </h3>
                <div className={cn("flex items-baseline gap-1 mb-3")}>
                  <span
                    className={cn(
                      "text-4xl font-brand font-bold text-black",
                      "dark:text-white",
                    )}
                  >
                    $9.99
                  </span>
                  <span className={cn("text-gray-500", "dark:text-gray-500")}>
                    /{t("pricing.month")}
                  </span>
                </div>
                <p
                  className={cn("text-sm text-gray-500", "dark:text-gray-500")}
                >
                  {t("pricing.proDescription")}
                </p>
              </div>

              <ul className={cn("space-y-3 mb-8 flex-1")}>
                <li
                  className={cn(
                    "flex items-start gap-2 text-gray-600",
                    "dark:text-gray-400",
                  )}
                >
                  <Check size={20} className={cn("shrink-0 mt-0.5")} />
                  <span>{t("pricing.features.includedTokens")}</span>
                </li>
                <li
                  className={cn(
                    "flex items-start gap-2 text-gray-600",
                    "dark:text-gray-400",
                  )}
                >
                  <Check size={20} className={cn("shrink-0 mt-0.5")} />
                  <span>{t("pricing.features.prepaidTokens")}</span>
                </li>
                <li
                  className={cn(
                    "flex items-start gap-2 text-gray-600",
                    "dark:text-gray-400",
                  )}
                >
                  <Check size={20} className={cn("shrink-0 mt-0.5")} />
                  <span>{t("pricing.features.noAutomaticOverage")}</span>
                </li>
                <li
                  className={cn(
                    "flex items-start gap-2 text-gray-600",
                    "dark:text-gray-400",
                  )}
                >
                  <Check size={20} className={cn("shrink-0 mt-0.5")} />
                  <span>{t("pricing.features.allFeatures")}</span>
                </li>
                <li
                  className={cn(
                    "flex items-start gap-2 text-gray-600",
                    "dark:text-gray-400",
                  )}
                >
                  <Check size={20} className={cn("shrink-0 mt-0.5")} />
                  <span>{t("pricing.features.teamCollaboration")}</span>
                </li>
              </ul>

              {isLoggedIn ? (
                <button
                  onClick={() => handleUpgrade()}
                  disabled={currentPlan === "pro" || isUpgrading}
                  className={cn(
                    "w-full py-3",
                    "bg-black text-white",
                    currentPlan === "pro" || isUpgrading
                      ? "opacity-50 cursor-not-allowed"
                      : "hover:bg-gray-800",
                    "dark:bg-white dark:text-black dark:hover:bg-gray-200",
                  )}
                >
                  {isUpgrading
                    ? t("pricing.processing")
                    : currentPlan === "pro"
                      ? t("pricing.currentPlan")
                      : t("pricing.upgradeToPro")}
                </button>
              ) : (
                <button
                  onClick={handleSignIn}
                  className={cn(
                    "w-full py-3 text-center",
                    "border border-gray-300",
                    "hover:bg-gray-100 dark:hover:bg-gray-900",
                    "dark:border-gray-700",
                  )}
                >
                  {t("pricing.getStarted")}
                </button>
              )}
            </div>
          </div>

          {/* Token Pack Section */}
          <div
            className={cn(
              "p-8 mb-12",
              "border border-gray-200",
              "dark:border-gray-800",
            )}
          >
            <h2
              className={cn(
                "text-2xl font-brand font-bold text-black mb-2",
                "dark:text-white",
              )}
            >
              {t("pricing.tokenPack.title")}
            </h2>
            <p className={cn("text-gray-600 mb-6", "dark:text-gray-400")}>
              {t("pricing.tokenPack.description")}
            </p>

            <div className={cn("grid grid-cols-1 gap-6", "md:grid-cols-2")}>
              {/* 3M Token Pack */}
              <div
                className={cn(
                  "p-6",
                  "border border-gray-200",
                  "dark:border-gray-700",
                )}
              >
                <div className={cn("flex items-baseline gap-2 mb-4")}>
                  <span
                    className={cn(
                      "text-3xl font-brand font-bold text-black",
                      "dark:text-white",
                    )}
                  >
                    $9.99
                  </span>
                  <span className={cn("text-gray-500", "dark:text-gray-500")}>
                    / 2.2M tokens
                  </span>
                </div>
                <ul className={cn("space-y-2 mb-6")}>
                  <li
                    className={cn(
                      "flex items-center gap-2 text-sm text-gray-600",
                      "dark:text-gray-400",
                    )}
                  >
                    <Check size={14} className={cn("shrink-0")} />
                    <span>{t("pricing.tokenPack.neverExpire")}</span>
                  </li>
                  <li
                    className={cn(
                      "flex items-center gap-2 text-sm text-gray-600",
                      "dark:text-gray-400",
                    )}
                  >
                    <Check size={14} className={cn("shrink-0")} />
                    <span>{t("pricing.tokenPack.prepaidPurchase")}</span>
                  </li>
                </ul>
                {isLoggedIn ? (
                  <button
                    onClick={() => handlePurchaseTokenPack("small")}
                    disabled={isPurchasingSmall}
                    className={cn(
                      "w-full py-3",
                      "border border-black text-black",
                      isPurchasingSmall
                        ? "opacity-50 cursor-not-allowed"
                        : "hover:bg-gray-100",
                      "dark:border-white dark:text-white dark:hover:bg-gray-900",
                    )}
                  >
                    {isPurchasingSmall
                      ? t("pricing.processing")
                      : t("pricing.tokenPack.purchase")}
                  </button>
                ) : (
                  <button
                    onClick={handleSignIn}
                    className={cn(
                      "w-full py-3",
                      "border border-gray-300",
                      "hover:bg-gray-100 dark:hover:bg-gray-900",
                      "dark:border-gray-700",
                    )}
                  >
                    {t("pricing.getStarted")}
                  </button>
                )}
              </div>

              {/* 10M Token Pack */}
              <div
                className={cn(
                  "p-6",
                  "border-2 border-black",
                  "dark:border-white",
                )}
              >
                <div className={cn("flex items-baseline gap-2 mb-4")}>
                  <span
                    className={cn(
                      "text-3xl font-brand font-bold text-black",
                      "dark:text-white",
                    )}
                  >
                    $29.99
                  </span>
                  <span className={cn("text-gray-500", "dark:text-gray-500")}>
                    / 7.5M tokens
                  </span>
                  <span
                    className={cn(
                      "ml-2 px-2 py-0.5 text-xs",
                      "bg-black text-white",
                      "dark:bg-white dark:text-black",
                    )}
                  >
                    {t("pricing.tokenPack.bestValue")}
                  </span>
                </div>
                <ul className={cn("space-y-2 mb-6")}>
                  <li
                    className={cn(
                      "flex items-center gap-2 text-sm text-gray-600",
                      "dark:text-gray-400",
                    )}
                  >
                    <Check size={14} className={cn("shrink-0")} />
                    <span>{t("pricing.tokenPack.neverExpire")}</span>
                  </li>
                  <li
                    className={cn(
                      "flex items-center gap-2 text-sm text-gray-600",
                      "dark:text-gray-400",
                    )}
                  >
                    <Check size={14} className={cn("shrink-0")} />
                    <span>{t("pricing.tokenPack.prepaidPurchase")}</span>
                  </li>
                </ul>
                {isLoggedIn ? (
                  <button
                    onClick={() => handlePurchaseTokenPack("large")}
                    disabled={isPurchasingLarge}
                    className={cn(
                      "w-full py-3",
                      "bg-black text-white",
                      isPurchasingLarge
                        ? "opacity-50 cursor-not-allowed"
                        : "hover:bg-gray-800",
                      "dark:bg-white dark:text-black dark:hover:bg-gray-200",
                    )}
                  >
                    {isPurchasingLarge
                      ? t("pricing.processing")
                      : t("pricing.tokenPack.purchase")}
                  </button>
                ) : (
                  <button
                    onClick={handleSignIn}
                    className={cn(
                      "w-full py-3",
                      "border border-gray-300",
                      "hover:bg-gray-100 dark:hover:bg-gray-900",
                      "dark:border-gray-700",
                    )}
                  >
                    {t("pricing.getStarted")}
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Help */}
          <div className={cn("mt-12 text-center")}>
            <p className={cn("text-gray-600", "dark:text-gray-400")}>
              {t("pricing.needHelp")}{" "}
              <a
                href="/contact"
                className={cn(
                  "text-black underline",
                  "hover:no-underline",
                  "dark:text-white",
                )}
              >
                {t("pricing.contactUs")}
              </a>
            </p>
          </div>
        </div>
      </Layout>
    </>
  );
}
