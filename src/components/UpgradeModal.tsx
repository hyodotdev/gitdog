import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useNavigate } from "react-router";
import { X, Zap, Check, AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../utils/cn";

type UpgradeModalProps = {
  isOpen: boolean;
  onClose: () => void;
  reason?: "limit_reached" | "feature_locked" | "approaching_limit";
};

export function UpgradeModal({
  isOpen,
  onClose,
  reason = "limit_reached",
}: UpgradeModalProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const pricingInfo = useQuery(api.subscriptions.query.getPricingInfo);
  const subscription = useQuery(api.subscriptions.query.getCurrent);

  if (!isOpen) return null;

  const currentPlan = subscription?.plan || "free";

  const getTitle = () => {
    switch (reason) {
      case "limit_reached":
        return t("upgrade.limitReached.title");
      case "approaching_limit":
        return t("upgrade.approachingLimit.title");
      case "feature_locked":
        return t("upgrade.featureLocked.title");
      default:
        return t("upgrade.title");
    }
  };

  const getMessage = () => {
    switch (reason) {
      case "limit_reached":
        return t("upgrade.limitReached.message");
      case "approaching_limit":
        return t("upgrade.approachingLimit.message");
      case "feature_locked":
        return t("upgrade.featureLocked.message");
      default:
        return t("upgrade.message");
    }
  };

  const handleUpgrade = () => {
    navigate("/pricing");
    onClose();
  };

  return (
    <div
      className={cn(
        "fixed inset-0 z-50",
        "flex items-center justify-center",
        "bg-black/50",
      )}
      onClick={onClose}
    >
      <div
        className={cn(
          "relative w-full max-w-lg mx-4",
          "bg-white",
          "dark:bg-black",
          "border border-gray-200",
          "dark:border-gray-800",
          "p-8",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          className={cn(
            "absolute top-4 right-4",
            "text-gray-500 hover:text-black",
            "dark:text-gray-400 dark:hover:text-white",
          )}
        >
          <X size={24} />
        </button>

        {/* Icon */}
        <div
          className={cn(
            "w-16 h-16 mx-auto mb-6",
            "flex items-center justify-center",
            reason === "limit_reached"
              ? "bg-red-100 dark:bg-red-900/30"
              : "bg-yellow-100 dark:bg-yellow-900/30",
          )}
        >
          {reason === "limit_reached" ? (
            <AlertTriangle
              size={32}
              className={cn("text-red-600", "dark:text-red-400")}
            />
          ) : (
            <Zap
              size={32}
              className={cn("text-yellow-600", "dark:text-yellow-400")}
            />
          )}
        </div>

        {/* Title */}
        <h2
          className={cn(
            "text-2xl font-brand font-bold text-center text-black mb-2",
            "dark:text-white",
          )}
        >
          {getTitle()}
        </h2>

        {/* Message */}
        <p
          className={cn("text-center text-gray-600 mb-8", "dark:text-gray-400")}
        >
          {getMessage()}
        </p>

        {/* Plan comparison */}
        {pricingInfo && (
          <div className={cn("space-y-4 mb-8")}>
            {/* Pro plan highlight */}
            <div
              className={cn(
                "p-4",
                "border-2 border-black",
                "dark:border-white",
              )}
            >
              <div className={cn("flex items-center justify-between mb-3")}>
                <div>
                  <h3
                    className={cn(
                      "text-lg font-bold text-black",
                      "dark:text-white",
                    )}
                  >
                    Pro
                  </h3>
                  <p
                    className={cn(
                      "text-sm text-gray-600",
                      "dark:text-gray-400",
                    )}
                  >
                    ${pricingInfo.plans.pro.price}/{t("billing.month")}
                  </p>
                </div>
                <div
                  className={cn(
                    "px-3 py-1",
                    "bg-black text-white text-sm",
                    "dark:bg-white dark:text-black",
                  )}
                >
                  {t("upgrade.recommended")}
                </div>
              </div>
              <ul className={cn("space-y-2")}>
                {[
                  t("pricing.features.includedTokens"),
                  t("pricing.features.prepaidTokens"),
                  t("pricing.features.noAutomaticOverage"),
                  t("pricing.features.allFeatures"),
                ].map((feature) => (
                  <li
                    key={feature}
                    className={cn(
                      "flex items-center gap-2 text-sm text-gray-600",
                      "dark:text-gray-400",
                    )}
                  >
                    <Check size={16} className={cn("shrink-0")} />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Prepaid token packs */}
            <div
              className={cn(
                "p-4",
                "border border-gray-200",
                "dark:border-gray-800",
              )}
            >
              <div className={cn("flex items-center justify-between")}>
                <div>
                  <h3
                    className={cn(
                      "text-lg font-bold text-black",
                      "dark:text-white",
                    )}
                  >
                    {t("upgrade.prepaidTokenPack")}
                  </h3>
                  <p
                    className={cn(
                      "text-sm text-gray-600",
                      "dark:text-gray-400",
                    )}
                  >
                    {t("upgrade.prepaidTokenPackDescription")}
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className={cn("flex gap-4")}>
          <button
            onClick={onClose}
            className={cn(
              "flex-1 py-3",
              "border border-gray-300",
              "hover:bg-gray-100",
              "dark:border-gray-700 dark:hover:bg-gray-900",
            )}
          >
            {t("upgrade.maybeLater")}
          </button>
          <button
            onClick={handleUpgrade}
            className={cn(
              "flex-1 py-3",
              "bg-black text-white",
              "hover:bg-gray-800",
              "dark:bg-white dark:text-black dark:hover:bg-gray-200",
            )}
          >
            {t("upgrade.viewPlans")}
          </button>
        </div>

        {/* Current plan info */}
        {currentPlan === "free" && (
          <p
            className={cn(
              "mt-4 text-center text-sm text-gray-500",
              "dark:text-gray-500",
            )}
          >
            {t("upgrade.currentlyOnFree")}
          </p>
        )}
      </div>
    </div>
  );
}
