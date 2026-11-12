import { SEO } from "../../components/SEO";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Layout } from "../../components/Layout";
import { cn } from "../../utils/cn";
import { Home, ArrowLeft } from "lucide-react";

export function NotFoundPage() {
  const { t } = useTranslation();

  return (
    <>
      <SEO
        title={t("notFound.title") || "Page Not Found"}
        description={t("notFound.description") || undefined}
        noIndex
      />
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
            404
          </h1>
          <h2
            className={cn(
              "text-2xl font-brand font-bold text-black mb-4",
              "dark:text-white",
            )}
          >
            {t("notFound.heading")}
          </h2>
          <p
            className={cn(
              "text-gray-600 mb-8 text-center max-w-md",
              "dark:text-gray-400",
            )}
          >
            {t("notFound.message")}
          </p>
          <div className={cn("flex flex-wrap justify-center gap-4")}>
            <Link
              to="/"
              className={cn(
                "flex items-center gap-2",
                "px-6 py-3",
                "bg-black text-white",
                "hover:bg-gray-800",
                "dark:bg-white dark:text-black dark:hover:bg-gray-200",
              )}
            >
              <Home size={20} />
              {t("notFound.goHome")}
            </Link>
            <button
              onClick={() => window.history.back()}
              className={cn(
                "flex items-center gap-2",
                "px-6 py-3",
                "border border-gray-300",
                "hover:bg-gray-100",
                "dark:border-gray-700 dark:hover:bg-gray-900",
              )}
            >
              <ArrowLeft size={20} />
              {t("notFound.goBack")}
            </button>
          </div>
        </div>
      </Layout>
    </>
  );
}
