import { Helmet } from "react-helmet-async";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Layout } from "../../components/Layout";
import { cn } from "../../utils/cn";
import { Home, RefreshCw } from "lucide-react";

export function ErrorPage() {
  const { t } = useTranslation();

  const handleRefresh = () => {
    window.location.reload();
  };

  return (
    <>
      <Helmet>
        <title>{t("serverError.title") || "Server Error - Gitdog"}</title>
        <meta name="description" content={t("serverError.description") || ""} />
      </Helmet>
      <Layout>
        <div
          className={cn(
            "flex flex-col items-center justify-center",
            "min-h-[calc(100vh-300px)]",
            "px-6 py-12",
          )}
        >
          <h1
            className={cn(
              "text-8xl font-brand font-bold text-black mb-4",
              "dark:text-white",
            )}
          >
            500
          </h1>
          <h2
            className={cn(
              "text-2xl font-brand font-bold text-black mb-4",
              "dark:text-white",
            )}
          >
            {t("serverError.heading")}
          </h2>
          <p
            className={cn(
              "text-gray-600 mb-8 text-center max-w-md",
              "dark:text-gray-400",
            )}
          >
            {t("serverError.message")}
          </p>
          <div className={cn("flex gap-4")}>
            <button
              onClick={handleRefresh}
              className={cn(
                "flex items-center gap-2",
                "px-6 py-3",
                "bg-black text-white",
                "hover:bg-gray-800",
                "dark:bg-white dark:text-black dark:hover:bg-gray-200",
              )}
            >
              <RefreshCw size={20} />
              {t("serverError.tryAgain")}
            </button>
            <Link
              to="/"
              className={cn(
                "flex items-center gap-2",
                "px-6 py-3",
                "border border-gray-300",
                "hover:bg-gray-100",
                "dark:border-gray-700 dark:hover:bg-gray-900",
              )}
            >
              <Home size={20} />
              {t("serverError.goHome")}
            </Link>
          </div>
        </div>
      </Layout>
    </>
  );
}
