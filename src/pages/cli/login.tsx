import { Check, CircleAlert, Copy } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";
import { SEO } from "../../components/SEO";
import { cn } from "../../utils/cn";

export function CliLoginPage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const [copied, setCopied] = useState(false);
  const succeeded = searchParams.get("status") === "success";
  const copy = succeeded ? "auth.cliLogin.success" : "auth.cliLogin.failed";
  const command = succeeded
    ? "npx gitdog@latest init"
    : "npx gitdog@latest login";
  const StatusIcon = succeeded ? Check : CircleAlert;

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <>
      <SEO
        title={t("auth.cliLogin.seoTitle") || "Gitdog CLI"}
        path="/cli/login"
        noIndex
      />
      <main
        className={cn(
          "flex items-center justify-center min-h-screen",
          "px-6 py-12",
          "bg-[#F5F5F5]",
          "dark:bg-[#1a1a1a]",
        )}
      >
        <div
          className={cn(
            "w-full max-w-xl",
            "p-8",
            "bg-white border border-gray-200 shadow-xl",
            "dark:bg-[#0a0a0a] dark:border-gray-800",
          )}
        >
          <Link to="/" className={cn("inline-flex items-center gap-3 mb-8")}>
            <img
              src="/icon-bg.jpg"
              alt="Gitdog"
              className="w-10 h-10 dark:hidden"
            />
            <img
              src="/icon.png"
              alt="Gitdog"
              className="w-10 h-10 hidden dark:block"
            />
            <span
              className={cn(
                "font-brand font-bold text-2xl text-black",
                "dark:text-white",
              )}
            >
              Gitdog
            </span>
          </Link>
          <h1
            className={cn(
              "flex items-center gap-3 mb-3",
              "font-brand font-bold text-3xl text-black",
              "dark:text-white",
            )}
          >
            <StatusIcon size={28} className="shrink-0" aria-hidden="true" />
            {t(`${copy}.title`)}
          </h1>
          <p className={cn("mb-6 text-gray-600", "dark:text-gray-400")}>
            {t(`${copy}.description`)}
          </p>
          <p
            className={cn(
              "mb-2 text-sm font-medium text-black",
              "dark:text-white",
            )}
          >
            {t(`${copy}.nextStep`)}
          </p>
          <div
            className={cn(
              "flex items-center justify-between gap-3 mb-6 px-4 py-3",
              "border border-gray-200 bg-[#F5F5F5]",
              "dark:border-gray-800 dark:bg-[#1a1a1a]",
            )}
          >
            <code
              className={cn("text-sm text-black break-all", "dark:text-white")}
            >
              {command}
            </code>
            <button
              type="button"
              onClick={() => void copyCommand()}
              aria-label={t("auth.cliLogin.copy")}
              className={cn(
                "shrink-0 p-1 text-gray-600 hover:text-black",
                "dark:text-gray-400 dark:hover:text-white",
              )}
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
          <div
            aria-live="polite"
            className={cn(
              "flex flex-wrap items-center justify-between gap-3",
              "text-sm text-gray-600",
              "dark:text-gray-400",
            )}
          >
            <span>
              {copied ? t("auth.cliLogin.copied") : t("auth.cliLogin.closeTab")}
            </span>
            <Link
              to="/"
              className={cn(
                "font-medium text-black underline",
                "dark:text-white",
              )}
            >
              {t("auth.cliLogin.openWorkspace")}
            </Link>
          </div>
        </div>
      </main>
    </>
  );
}
