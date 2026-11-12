import { cn } from "../../../utils/cn";
import { User, Plus, Ban, Play } from "lucide-react";
import { useTranslation } from "react-i18next";

interface SubscriptionRowProps {
  sub: {
    _id: string;
    plan: string;
    status: string;
    includedTokens: number;
    purchasedTokens: number;
    tokensUsed?: number;
    userName?: string;
    userAvatar?: string;
    githubUsername?: string;
    lemonSqueezySubscriptionId?: string;
    proEntitlementProvenance?: { source: string };
  };
  isSelected: boolean;
  actionType: "add" | "cancel" | "reactivate" | null;
  tokenAmount: string;
  adminNote: string;
  onSelect: (id: string) => void;
  onActionType: (type: "add" | "cancel" | "reactivate") => void;
  onTokenAmount: (val: string) => void;
  onAdminNote: (val: string) => void;
  onAction: () => void;
  onCancel: () => void;
  isSubmitting: boolean;
  formatTokens: (tokens: number) => string;
}

export function SubscriptionRow({
  sub,
  isSelected,
  actionType,
  tokenAmount,
  adminNote,
  onSelect,
  onActionType,
  onTokenAmount,
  onAdminNote,
  onAction,
  onCancel,
  isSubmitting,
  formatTokens,
}: SubscriptionRowProps) {
  const { t } = useTranslation();
  const isProviderManaged =
    sub.proEntitlementProvenance?.source === "lemon_squeezy_webhook";

  return (
    <div
      className={cn(
        "p-4 border border-gray-200 dark:border-gray-700",
        isSelected && "ring-2 ring-black dark:ring-white",
      )}
    >
      <div className={cn("flex items-center justify-between")}>
        <div className={cn("flex items-center gap-3")}>
          {sub.userAvatar ? (
            <img src={sub.userAvatar} alt="" className="w-8 h-8" />
          ) : (
            <User size={20} className="shrink-0 text-gray-400" />
          )}
          <div>
            <div
              className={cn(
                "font-medium dark:text-white flex items-center gap-2",
              )}
            >
              {sub.userName || sub.githubUsername || "Unknown User"}
              {sub.plan === "pro" && (
                <span
                  className={cn(
                    "text-xs px-1.5 py-0.5 bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
                  )}
                >
                  {t("admin.payments.subscription.pro")}
                </span>
              )}
            </div>
            <div className={cn("text-xs text-gray-500")}>
              {t("admin.payments.subscription.status")} {sub.status}
            </div>
          </div>
        </div>
        <div className={cn("flex items-center gap-4")}>
          <div className={cn("text-right text-sm")}>
            <div className={cn("dark:text-gray-300")}>
              {t("admin.payments.subscription.included")}{" "}
              {formatTokens(sub.includedTokens)}
            </div>
            <div className={cn("dark:text-gray-300")}>
              {t("admin.payments.subscription.purchased")}{" "}
              {formatTokens(sub.purchasedTokens)}
            </div>
            <div className={cn("text-xs text-gray-500")}>
              {t("admin.payments.subscription.used")}{" "}
              {formatTokens(sub.tokensUsed || 0)}
            </div>
          </div>
          <div className={cn("flex gap-2")}>
            <button
              onClick={() => {
                onSelect(sub._id);
                onActionType("add");
              }}
              className={cn(
                "p-2 text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20",
              )}
              title={t("admin.payments.actions.addTokens")}
            >
              <Plus size={16} />
            </button>
            {!isProviderManaged && sub.status === "active" ? (
              <button
                onClick={() => {
                  onSelect(sub._id);
                  onActionType("cancel");
                }}
                className={cn(
                  "p-2 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20",
                )}
                title={t("admin.payments.actions.cancelSubscription")}
              >
                <Ban size={16} />
              </button>
            ) : !isProviderManaged ? (
              <button
                onClick={() => {
                  onSelect(sub._id);
                  onActionType("reactivate");
                }}
                className={cn(
                  "p-2 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20",
                )}
                title={t("admin.payments.actions.reactivateSubscription")}
              >
                <Play size={16} />
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {/* Action Form */}
      {isSelected && actionType && (
        <div
          className={cn(
            "mt-4 pt-4 border-t border-gray-200 dark:border-gray-700",
          )}
        >
          <div className={cn("flex items-center gap-4")}>
            {actionType === "add" && (
              <input
                type="number"
                placeholder={t("admin.payments.form.tokenAmount")}
                value={tokenAmount}
                onChange={(e) => onTokenAmount(e.target.value)}
                className={cn(
                  "px-3 py-2 border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white",
                  "w-40",
                )}
              />
            )}
            <input
              type="text"
              placeholder={t("admin.payments.form.adminNote")}
              value={adminNote}
              onChange={(e) => onAdminNote(e.target.value)}
              className={cn(
                "px-3 py-2 border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white flex-1",
              )}
            />
            <button
              onClick={onAction}
              disabled={isSubmitting}
              className={cn(
                "px-4 py-2 bg-black text-white hover:bg-gray-800",
                "dark:bg-white dark:text-black dark:hover:bg-gray-200",
              )}
            >
              {actionType === "add" && t("admin.payments.actions.add")}
              {actionType === "cancel" && t("admin.payments.actions.cancel")}
              {actionType === "reactivate" &&
                t("admin.payments.actions.reactivate")}
            </button>
            <button
              onClick={onCancel}
              className={cn(
                "px-4 py-2 border border-gray-300 hover:bg-gray-100",
                "dark:border-gray-600 dark:hover:bg-gray-800 dark:text-gray-300",
              )}
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
