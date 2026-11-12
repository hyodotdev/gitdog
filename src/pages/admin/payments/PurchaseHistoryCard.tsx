import { cn } from "../../../utils/cn";
import {
  CheckCircle,
  XCircle,
  Clock,
  RefreshCw,
  Ban,
  ChevronDown,
  ChevronUp,
  User,
} from "lucide-react";
import { useTranslation } from "react-i18next";

interface PaymentLog {
  _id: string;
  status: string;
  eventType: string;
  productType?: string;
  tokensAdded?: number;
  amountCents?: number;
  errorMessage?: string;
  adminNote?: string;
  createdAt: number;
}

interface UserPaymentData {
  userId: string;
  userName: string;
  userAvatar?: string;
  githubUsername?: string;
  totalRevenueCents: number;
  totalTokens: number;
  successCount: number;
  failedCount: number;
  totalLogs: number;
  logs: PaymentLog[];
  hasMoreLogs: boolean;
}

interface PurchaseHistoryCardProps {
  user: UserPaymentData;
  isExpanded: boolean;
  onToggle: () => void;
  formatDate: (timestamp: number) => string;
  formatTokens: (tokens: number) => string;
  formatCurrency: (cents: number) => string;
}

export function PurchaseHistoryCard({
  user,
  isExpanded,
  onToggle,
  formatDate,
  formatTokens,
  formatCurrency,
}: PurchaseHistoryCardProps) {
  const { t } = useTranslation();

  const getPaymentStatusColor = (status: string) => {
    switch (status) {
      case "success":
        return "text-green-600 dark:text-green-400";
      case "failed":
        return "text-red-600 dark:text-red-400";
      case "pending":
        return "text-yellow-600 dark:text-yellow-400";
      case "refunded":
        return "text-purple-600 dark:text-purple-400";
      case "canceled":
        return "text-gray-600 dark:text-gray-400";
      default:
        return "text-gray-600";
    }
  };

  const getPaymentStatusIcon = (status: string) => {
    switch (status) {
      case "success":
        return <CheckCircle size={14} className="text-green-500" />;
      case "failed":
        return <XCircle size={14} className="text-red-500" />;
      case "pending":
        return <Clock size={14} className="text-yellow-500" />;
      case "refunded":
        return <RefreshCw size={14} className="text-purple-500" />;
      case "canceled":
        return <Ban size={14} className="text-gray-500" />;
      default:
        return <Clock size={14} className="text-gray-500" />;
    }
  };

  return (
    <div className={cn("border border-gray-200", "dark:border-gray-700")}>
      {/* User Header */}
      <div
        className={cn(
          "p-4 flex items-center justify-between cursor-pointer hover:bg-gray-50",
          "dark:hover:bg-gray-900",
        )}
        onClick={onToggle}
      >
        <div className={cn("flex items-center gap-3")}>
          {user.userAvatar ? (
            <img src={user.userAvatar} alt="" className={cn("w-10 h-10")} />
          ) : (
            <div
              className={cn(
                "w-10 h-10 bg-gray-200 dark:bg-gray-700 flex items-center justify-center",
              )}
            >
              <User size={20} className="shrink-0 text-gray-400" />
            </div>
          )}
          <div>
            <div className={cn("font-medium dark:text-white")}>
              {user.userName}
            </div>
            <div className={cn("text-xs text-gray-500")}>
              {user.githubUsername ? `@${user.githubUsername}` : user.userId}
            </div>
          </div>
        </div>
        <div className={cn("flex items-center gap-6")}>
          <div className={cn("text-right")}>
            <div
              className={cn("font-medium text-green-600 dark:text-green-400")}
            >
              {formatCurrency(user.totalRevenueCents)}
            </div>
            <div className={cn("text-xs text-gray-500")}>
              {formatTokens(user.totalTokens)} {t("admin.payments.tokens")}
            </div>
          </div>
          <div className={cn("flex items-center gap-3")}>
            <div className={cn("flex items-center gap-1 text-sm")}>
              <CheckCircle size={14} className="shrink-0 text-green-500" />
              <span className={cn("dark:text-gray-300")}>
                {user.successCount}
              </span>
            </div>
            {user.failedCount > 0 && (
              <div className={cn("flex items-center gap-1 text-sm")}>
                <XCircle size={14} className="shrink-0 text-red-500" />
                <span className={cn("dark:text-gray-300")}>
                  {user.failedCount}
                </span>
              </div>
            )}
          </div>
          <div className={cn("text-sm text-gray-500 w-20 text-right")}>
            {user.totalLogs} {t("admin.payments.logs")}
          </div>
          {isExpanded ? (
            <ChevronUp size={20} className="text-gray-400" />
          ) : (
            <ChevronDown size={20} className="text-gray-400" />
          )}
        </div>
      </div>

      {/* Expanded Logs */}
      {isExpanded && (
        <div className={cn("border-t border-gray-200", "dark:border-gray-700")}>
          {user.logs.map((log) => (
            <div
              key={log._id}
              className={cn(
                "px-4 py-3 border-b border-gray-100 last:border-b-0",
                "dark:border-gray-800",
                log.status === "failed" && "border-l-4 border-l-red-500",
              )}
            >
              <div className={cn("flex items-center justify-between")}>
                <div className={cn("flex items-center gap-3")}>
                  {getPaymentStatusIcon(log.status)}
                  <div>
                    <div className={cn("font-medium dark:text-white text-sm")}>
                      {log.eventType}
                      {log.productType && (
                        <span
                          className={cn(
                            "ml-2 text-xs px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800",
                          )}
                        >
                          {log.productType}
                        </span>
                      )}
                    </div>
                    <div className={cn("text-xs text-gray-500")}>
                      {formatDate(log.createdAt)}
                    </div>
                  </div>
                </div>
                <div className={cn("text-right")}>
                  <div
                    className={cn(
                      "font-medium text-sm",
                      getPaymentStatusColor(log.status),
                    )}
                  >
                    {log.status}
                  </div>
                  {log.tokensAdded !== undefined && log.tokensAdded !== 0 && (
                    <div className={cn("text-xs text-gray-500")}>
                      {log.tokensAdded > 0 ? "+" : ""}
                      {formatTokens(log.tokensAdded)}{" "}
                      {t("admin.payments.tokens")}
                    </div>
                  )}
                  {log.amountCents && (
                    <div className={cn("text-xs text-gray-500")}>
                      {formatCurrency(log.amountCents)}
                    </div>
                  )}
                </div>
              </div>
              {log.errorMessage && (
                <div
                  className={cn(
                    "mt-2 p-2 bg-red-50 dark:bg-red-900/20 text-xs text-red-600 dark:text-red-400",
                  )}
                >
                  {log.errorMessage}
                </div>
              )}
              {log.adminNote && (
                <div
                  className={cn(
                    "mt-2 p-2 bg-gray-50 dark:bg-gray-800 text-xs text-gray-600 dark:text-gray-400",
                  )}
                >
                  {t("admin.payments.adminNote")} {log.adminNote}
                </div>
              )}
            </div>
          ))}
          {user.hasMoreLogs && (
            <div className={cn("p-3 text-center text-sm text-gray-500")}>
              {t("admin.payments.moreLogs", { count: user.totalLogs - 10 })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
