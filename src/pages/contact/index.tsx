import { SEO } from "../../components/SEO";
import { Layout } from "../../components/Layout";
// Both icon packs dropped the Slack brand mark (Simple Icons in 13.9, Lucide in
// 1.x), so the Slack card falls back to a generic message glyph.
import { Mail, MessageSquare } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../utils/cn";

export function ContactPage() {
  const { t } = useTranslation();

  return (
    <>
      <SEO
        title={t("contact.title") || "Contact"}
        description={t("contact.description") || undefined}
        path="/contact"
      />
      <Layout>
        <div className={cn("max-w-3xl mx-auto px-6 py-12")}>
          <div className={cn("text-center mb-12")}>
            <h1
              className={cn(
                "text-4xl font-brand font-bold text-black mb-4",
                "dark:text-white",
              )}
            >
              {t("contact.heading")}
            </h1>
            <p className={cn("text-lg text-gray-600", "dark:text-gray-400")}>
              {t("contact.subtitle")}
            </p>
          </div>

          <div className={cn("grid grid-cols-1 gap-6", "md:grid-cols-2")}>
            {/* Slack */}
            <a
              href="https://hyo.dev/joinSlack"
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                "p-8 text-center",
                "border-2 border-gray-200",
                "hover:border-black",
                "transition-colors",
                "dark:border-gray-800 dark:hover:border-white",
              )}
            >
              <MessageSquare
                size={48}
                className={cn("mx-auto mb-4 text-black", "dark:text-white")}
              />
              <h2
                className={cn(
                  "text-xl font-brand font-bold text-black mb-2",
                  "dark:text-white",
                )}
              >
                {t("contact.slack.title")}
              </h2>
              <p className={cn("text-gray-600", "dark:text-gray-400")}>
                {t("contact.slack.description")}
              </p>
            </a>

            {/* Email */}
            <a
              href="mailto:hyo@hyo.dev"
              className={cn(
                "p-8 text-center",
                "border-2 border-gray-200",
                "hover:border-black",
                "transition-colors",
                "dark:border-gray-800 dark:hover:border-white",
              )}
            >
              <Mail
                size={48}
                className={cn("mx-auto mb-4 text-black", "dark:text-white")}
              />
              <h2
                className={cn(
                  "text-xl font-brand font-bold text-black mb-2",
                  "dark:text-white",
                )}
              >
                {t("contact.email.title")}
              </h2>
              <p className={cn("text-gray-600 mb-2", "dark:text-gray-400")}>
                {t("contact.email.description")}
              </p>
              <p className={cn("text-black font-medium", "dark:text-white")}>
                hyo@hyo.dev
              </p>
            </a>
          </div>

          <div
            className={cn(
              "mt-12 p-6 text-center",
              "bg-gray-50",
              "dark:bg-gray-900",
            )}
          >
            <p className={cn("text-gray-600", "dark:text-gray-400")}>
              {t("contact.responseTime")}
            </p>
          </div>
        </div>
      </Layout>
    </>
  );
}
