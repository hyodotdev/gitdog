import { SEO } from "../../components/SEO";
import { Layout } from "../../components/Layout";
import { Heart } from "lucide-react";
import { SiGithub } from "@icons-pack/react-simple-icons";
import { useTranslation } from "react-i18next";
import { cn } from "../../utils/cn";

export function AboutPage() {
  const { t } = useTranslation();

  return (
    <>
      <SEO
        title={t("about.title") || "About"}
        description={t("about.description") || undefined}
        path="/about"
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
              {t("about.heading")}
            </h1>
          </div>

          <div
            className={cn(
              "p-8 text-center",
              "border border-gray-200",
              "dark:border-gray-800",
            )}
          >
            <div className={cn("flex items-center justify-center gap-2 mb-6")}>
              <span
                className={cn("text-lg text-gray-600", "dark:text-gray-400")}
              >
                {t("about.createdWith")}
              </span>
              <Heart
                size={24}
                className={cn("text-red-500")}
                fill="currentColor"
              />
              <span
                className={cn("text-lg text-gray-600", "dark:text-gray-400")}
              >
                {t("about.andPassion")}
              </span>
            </div>

            <p
              className={cn(
                "text-2xl font-brand font-bold text-black mb-2",
                "dark:text-white",
              )}
            >
              🇰🇷 {t("about.madeInKorea")}
            </p>

            <div className={cn("mt-8 space-y-4")}>
              <div>
                <span className={cn("text-gray-600", "dark:text-gray-400")}>
                  {t("about.createdBy")}{" "}
                </span>
                <a
                  href="https://github.com/hyochan"
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(
                    "inline-flex items-center gap-1",
                    "text-black font-medium",
                    "hover:underline",
                    "dark:text-white",
                  )}
                >
                  <SiGithub size={16} className="shrink-0" />
                  hyochan
                </a>
              </div>

              <div>
                <span className={cn("text-gray-600", "dark:text-gray-400")}>
                  {t("about.managedBy")}{" "}
                </span>
                <a
                  href="https://hyo.dev"
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(
                    "text-black font-medium",
                    "hover:underline",
                    "dark:text-white",
                  )}
                >
                  Hyo Dev
                </a>
              </div>
            </div>
          </div>

          <div
            className={cn(
              "mt-8 p-6",
              "border border-gray-200",
              "dark:border-gray-800",
            )}
          >
            <h2
              className={cn(
                "text-xl font-brand font-bold text-black mb-4",
                "dark:text-white",
              )}
            >
              {t("about.whatIsGitdog.title")}
            </h2>
            <p
              className={cn(
                "text-gray-600 leading-relaxed",
                "dark:text-gray-400",
              )}
            >
              {t("about.whatIsGitdog.description")}
            </p>
          </div>
        </div>
      </Layout>
    </>
  );
}
