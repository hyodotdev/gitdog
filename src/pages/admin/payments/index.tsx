import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { useTranslation } from "react-i18next";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { Helmet } from "react-helmet-async";
import { AdminLayout } from "../../../components/AdminLayout";
import { LoadingIndicator } from "../../../components/uis/LoadingIndicator";
import { NotFoundPage } from "../../not-found";
import { cn } from "../../../utils/cn";
import { showToast } from "../../../utils/signals/toast";
import { StatCard } from "../components/StatCard";
import { SubscriptionRow } from "./SubscriptionRow";
import { PurchaseHistoryCard } from "./PurchaseHistoryCard";
import {
  Activity,
  CheckCircle,
  XCircle,
  RefreshCw,
  Zap,
  DollarSign,
  User,
  Crown,
  ChevronLeft,
  ChevronRight,
  Calendar,
} from "lucide-react";

type PaymentsTab = "subscribers" | "users" | "history";

export function AdminPaymentsPage() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<PaymentsTab>("subscribers");
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [selectedSubId, setSelectedSubId] = useState<string | null>(null);
  const [actionType, setActionType] = useState<
    "add" | "cancel" | "reactivate" | null
  >(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [tokenAmount, setTokenAmount] = useState<string>("");
  const [adminNote, setAdminNote] = useState<string>("");

  // Month filter state
  const now = new Date();
  const [selectedYear, setSelectedYear] = useState(now.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(now.getMonth());

  const isAdmin = useQuery(api.admin.query.isAdmin);
  const paymentStats = useQuery(
    api.admin.paymentQuery.getPaymentStats,
    isAdmin ? { year: selectedYear, month: selectedMonth } : "skip",
  );
  const paymentLogsByUser = useQuery(
    api.admin.paymentQuery.listPaymentLogsByUser,
    isAdmin ? { year: selectedYear, month: selectedMonth } : "skip",
  );
  const subscriptions = useQuery(
    api.admin.paymentQuery.listSubscriptions,
    isAdmin ? {} : "skip",
  );

  const addTokens = useMutation(api.admin.paymentMutation.addTokens);
  const cancelSubscription = useMutation(
    api.admin.paymentMutation.cancelSubscription,
  );
  const reactivateSubscription = useMutation(
    api.admin.paymentMutation.reactivateSubscription,
  );

  if (isAdmin === undefined) {
    return (
      <AdminLayout>
        <div className={cn("flex items-center justify-center min-h-[60vh]")}>
          <LoadingIndicator />
        </div>
      </AdminLayout>
    );
  }

  if (!isAdmin) {
    return <NotFoundPage />;
  }

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleString("ko-KR", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
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

  const formatCurrency = (cents: number) => {
    return `$${(cents / 100).toFixed(2)}`;
  };

  const monthNames = [
    t("admin.payments.months.jan"),
    t("admin.payments.months.feb"),
    t("admin.payments.months.mar"),
    t("admin.payments.months.apr"),
    t("admin.payments.months.may"),
    t("admin.payments.months.jun"),
    t("admin.payments.months.jul"),
    t("admin.payments.months.aug"),
    t("admin.payments.months.sep"),
    t("admin.payments.months.oct"),
    t("admin.payments.months.nov"),
    t("admin.payments.months.dec"),
  ];

  const goToPrevMonth = () => {
    if (selectedMonth === 0) {
      setSelectedMonth(11);
      setSelectedYear(selectedYear - 1);
    } else {
      setSelectedMonth(selectedMonth - 1);
    }
  };

  const goToNextMonth = () => {
    const currentDate = new Date();
    const isCurrentMonth =
      selectedYear === currentDate.getFullYear() &&
      selectedMonth === currentDate.getMonth();

    if (isCurrentMonth) return;

    if (selectedMonth === 11) {
      setSelectedMonth(0);
      setSelectedYear(selectedYear + 1);
    } else {
      setSelectedMonth(selectedMonth + 1);
    }
  };

  const isCurrentMonth =
    selectedYear === new Date().getFullYear() &&
    selectedMonth === new Date().getMonth();

  const selectAction = (type: "add" | "cancel" | "reactivate") => {
    setActionType(type);
    setOperationId(window.crypto.randomUUID());
  };

  const clearAction = () => {
    setSelectedSubId(null);
    setActionType(null);
    setOperationId(null);
    setTokenAmount("");
    setAdminNote("");
  };

  const handleAction = async () => {
    if (!selectedSubId || !actionType || !operationId || isSubmitting) return;

    const parsedTokenAmount = Number(tokenAmount);
    if (
      actionType === "add" &&
      (!Number.isSafeInteger(parsedTokenAmount) || parsedTokenAmount <= 0)
    ) {
      showToast(t("admin.payments.form.invalidTokenAmount"), "error");
      return;
    }

    setIsSubmitting(true);
    try {
      switch (actionType) {
        case "add":
          await addTokens({
            subscriptionId: selectedSubId as Id<"subscriptions">,
            tokensToAdd: parsedTokenAmount,
            operationId,
            adminNote: adminNote || undefined,
          });
          break;
        case "cancel":
          await cancelSubscription({
            subscriptionId: selectedSubId as Id<"subscriptions">,
            operationId,
            adminNote: adminNote || undefined,
          });
          break;
        case "reactivate":
          await reactivateSubscription({
            subscriptionId: selectedSubId as Id<"subscriptions">,
            operationId,
            adminNote: adminNote || undefined,
          });
          break;
      }
      clearAction();
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : t("common.error"),
        "error",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const proSubscriptions =
    subscriptions?.subscriptions.filter((s) => s.plan === "pro") ?? [];
  const allSubscriptions = subscriptions?.subscriptions ?? [];

  return (
    <>
      <Helmet>
        <title>{t("admin.payments.title")}</title>
      </Helmet>
      <AdminLayout>
        <div className={cn("max-w-7xl mx-auto px-6 py-12")}>
          {/* Header with Month Selector */}
          <div className={cn("mb-8")}>
            <div className={cn("flex items-center justify-between mb-4")}>
              <h1
                className={cn(
                  "text-3xl font-brand font-bold text-black",
                  "dark:text-white",
                )}
              >
                {t("admin.payments.heading")}
              </h1>
              {/* Month Selector */}
              <div
                className={cn(
                  "flex items-center gap-2 border border-gray-200 px-3 py-2",
                  "dark:border-gray-700",
                )}
              >
                <Calendar size={16} className="text-gray-500" />
                <button
                  onClick={goToPrevMonth}
                  className={cn(
                    "p-1 hover:bg-gray-100",
                    "dark:hover:bg-gray-800",
                  )}
                >
                  <ChevronLeft size={16} />
                </button>
                <span
                  className={cn(
                    "min-w-[120px] text-center font-medium",
                    "dark:text-white",
                  )}
                >
                  {monthNames[selectedMonth]} {selectedYear}
                </span>
                <button
                  onClick={goToNextMonth}
                  disabled={isCurrentMonth}
                  className={cn(
                    "p-1 hover:bg-gray-100",
                    "dark:hover:bg-gray-800",
                    isCurrentMonth && "opacity-30 cursor-not-allowed",
                  )}
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
            {paymentStats && (
              <div className={cn("grid grid-cols-1 gap-4", "md:grid-cols-2")}>
                {/* Monthly Revenue */}
                <div
                  className={cn(
                    "p-6 border border-gray-200 bg-white",
                    "dark:border-gray-800 dark:bg-gray-900",
                  )}
                >
                  <div className={cn("flex items-center gap-3 mb-2")}>
                    <DollarSign size={24} className="text-green-500" />
                    <span
                      className={cn(
                        "text-sm text-gray-500",
                        "dark:text-gray-400",
                      )}
                    >
                      {t("admin.payments.monthlyRevenue")}
                    </span>
                  </div>
                  <div
                    className={cn(
                      "text-4xl font-brand font-bold text-green-600",
                      "dark:text-green-400",
                    )}
                  >
                    {formatCurrency(paymentStats.monthlyRevenueCents)}
                  </div>
                  <div className={cn("text-sm text-gray-500 mt-1")}>
                    {paymentStats.monthlyTokensSold.toLocaleString()}{" "}
                    {t("admin.payments.tokensSoldThisMonth")}
                  </div>
                </div>

                {/* All-time Revenue (for Lemon Squeezy comparison) */}
                <div
                  className={cn(
                    "p-6 border border-gray-200 bg-white",
                    "dark:border-gray-800 dark:bg-gray-900",
                  )}
                >
                  <div className={cn("flex items-center gap-3 mb-2")}>
                    <DollarSign size={24} className="text-gray-400" />
                    <span
                      className={cn(
                        "text-sm text-gray-500",
                        "dark:text-gray-400",
                      )}
                    >
                      {t("admin.payments.allTimeRevenue")}
                    </span>
                  </div>
                  <div
                    className={cn(
                      "text-4xl font-brand font-bold text-gray-600",
                      "dark:text-gray-400",
                    )}
                  >
                    {formatCurrency(paymentStats.allTimeRevenueCents)}
                  </div>
                  <div className={cn("text-sm text-gray-500 mt-1")}>
                    {paymentStats.allTimeTokensSold.toLocaleString()}{" "}
                    {t("admin.payments.totalTokensSold")} •{" "}
                    {paymentStats.allTimeTotal}{" "}
                    {t("admin.payments.totalTransactions")}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Payment Stats */}
          {paymentStats && (
            <div
              className={cn("grid grid-cols-2 gap-4 mb-8", "md:grid-cols-5")}
            >
              <StatCard
                label={t("admin.payments.stats.totalEvents")}
                value={paymentStats.total}
                icon={<Activity size={20} />}
              />
              <StatCard
                label={t("admin.payments.stats.successful")}
                value={paymentStats.success}
                icon={<CheckCircle size={20} />}
                valueColor="text-green-600 dark:text-green-400"
              />
              <StatCard
                label={t("admin.payments.stats.failed")}
                value={paymentStats.failed}
                icon={<XCircle size={20} />}
                valueColor="text-red-600 dark:text-red-400"
              />
              <StatCard
                label={t("admin.payments.stats.refunded")}
                value={paymentStats.refunded}
                icon={<RefreshCw size={20} />}
                valueColor="text-purple-600 dark:text-purple-400"
              />
              <StatCard
                label={t("admin.payments.stats.tokensSold")}
                value={formatTokens(paymentStats.totalTokensSold)}
                icon={<Zap size={20} />}
              />
            </div>
          )}

          {/* Tabs Navigation */}
          <div
            className={cn(
              "flex border-b border-gray-200 mb-6",
              "dark:border-gray-800",
            )}
          >
            <button
              onClick={() => setActiveTab("subscribers")}
              className={cn(
                "flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors",
                activeTab === "subscribers"
                  ? "border-black text-black dark:border-white dark:text-white"
                  : "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300",
              )}
            >
              <Crown size={16} />
              {t("admin.payments.tabs.proUsers")}
              <span
                className={cn(
                  "text-xs px-1.5 py-0.5",
                  activeTab === "subscribers"
                    ? "bg-black text-white dark:bg-white dark:text-black"
                    : "bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-400",
                )}
              >
                {proSubscriptions.length}
              </span>
            </button>
            <button
              onClick={() => setActiveTab("users")}
              className={cn(
                "flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors",
                activeTab === "users"
                  ? "border-black text-black dark:border-white dark:text-white"
                  : "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300",
              )}
            >
              <User size={16} className="shrink-0" />
              {t("admin.payments.tabs.users")}
              <span
                className={cn(
                  "text-xs px-1.5 py-0.5",
                  activeTab === "users"
                    ? "bg-black text-white dark:bg-white dark:text-black"
                    : "bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-400",
                )}
              >
                {allSubscriptions.length}
              </span>
            </button>
            <button
              onClick={() => setActiveTab("history")}
              className={cn(
                "flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors",
                activeTab === "history"
                  ? "border-black text-black dark:border-white dark:text-white"
                  : "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300",
              )}
            >
              <DollarSign size={16} />
              {t("admin.payments.tabs.purchaseHistory")}
            </button>
          </div>

          {/* Tab Content */}
          {activeTab === "subscribers" && (
            <div
              className={cn(
                "p-6 border border-gray-200",
                "dark:border-gray-800",
              )}
            >
              {subscriptions === undefined ? (
                <LoadingIndicator />
              ) : proSubscriptions.length === 0 ? (
                <p className={cn("text-gray-500")}>
                  {t("admin.payments.empty.noProSubscribers")}
                </p>
              ) : (
                <div className={cn("space-y-3")}>
                  {proSubscriptions.map((sub) => (
                    <SubscriptionRow
                      key={sub._id}
                      sub={sub}
                      isSelected={selectedSubId === sub._id}
                      actionType={actionType}
                      tokenAmount={tokenAmount}
                      adminNote={adminNote}
                      onSelect={(id) => setSelectedSubId(id)}
                      onActionType={selectAction}
                      onTokenAmount={(val) => setTokenAmount(val)}
                      onAdminNote={(val) => setAdminNote(val)}
                      onAction={handleAction}
                      onCancel={clearAction}
                      isSubmitting={isSubmitting}
                      formatTokens={formatTokens}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === "users" && (
            <div
              className={cn(
                "p-6 border border-gray-200",
                "dark:border-gray-800",
              )}
            >
              {subscriptions === undefined ? (
                <LoadingIndicator />
              ) : allSubscriptions.length === 0 ? (
                <p className={cn("text-gray-500")}>
                  {t("admin.payments.empty.noUsers")}
                </p>
              ) : (
                <div className={cn("space-y-3")}>
                  {allSubscriptions.map((sub) => (
                    <SubscriptionRow
                      key={sub._id}
                      sub={sub}
                      isSelected={selectedSubId === sub._id}
                      actionType={actionType}
                      tokenAmount={tokenAmount}
                      adminNote={adminNote}
                      onSelect={(id) => setSelectedSubId(id)}
                      onActionType={selectAction}
                      onTokenAmount={(val) => setTokenAmount(val)}
                      onAdminNote={(val) => setAdminNote(val)}
                      onAction={handleAction}
                      onCancel={clearAction}
                      isSubmitting={isSubmitting}
                      formatTokens={formatTokens}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === "history" && (
            <div
              className={cn(
                "p-6 border border-gray-200",
                "dark:border-gray-800",
              )}
            >
              {paymentLogsByUser === undefined ? (
                <LoadingIndicator />
              ) : paymentLogsByUser.users.length === 0 ? (
                <p className={cn("text-gray-500")}>
                  {t("admin.payments.empty.noHistory")}
                </p>
              ) : (
                <div className={cn("space-y-3")}>
                  {paymentLogsByUser.users.map((user) => (
                    <PurchaseHistoryCard
                      key={user.userId}
                      user={user}
                      isExpanded={expandedUserId === user.userId}
                      onToggle={() =>
                        setExpandedUserId(
                          expandedUserId === user.userId ? null : user.userId,
                        )
                      }
                      formatDate={formatDate}
                      formatTokens={formatTokens}
                      formatCurrency={formatCurrency}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </AdminLayout>
    </>
  );
}
