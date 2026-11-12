import { SEO } from "../../components/SEO";
import { Layout } from "../../components/Layout";
import { useTranslation } from "react-i18next";
import { cn } from "../../utils/cn";

export function TermsOfServicePage() {
  const { t } = useTranslation();

  // Helper to render list items from translation array
  const renderList = (items: string[]) => (
    <ul>
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );

  return (
    <>
      <SEO
        title={t("legal.terms.title") || "Terms of Service"}
        description={t("legal.terms.description") || undefined}
        path="/legal/terms-of-service"
      />
      <Layout>
        <div className={cn("max-w-4xl mx-auto px-6 py-12")}>
          <h1
            className={cn(
              "text-4xl font-brand font-bold text-black mb-2",
              "dark:text-white",
            )}
          >
            {t("legal.terms.heading")}
          </h1>
          <p className={cn("text-gray-600 mb-8", "dark:text-gray-400")}>
            {t("legal.terms.companyInfo")}
          </p>

          <div
            className={cn(
              "prose prose-neutral max-w-none",
              "dark:prose-invert",
              "[&_h2]:text-xl [&_h2]:font-brand [&_h2]:font-bold [&_h2]:mt-8 [&_h2]:mb-4",
              "[&_h3]:text-lg [&_h3]:font-bold [&_h3]:mt-6 [&_h3]:mb-2",
              "[&_p]:text-gray-600 dark:[&_p]:text-gray-400 [&_p]:mb-4",
              "[&_ul]:list-disc [&_ul]:pl-6 [&_ul]:mb-4",
              "[&_li]:text-gray-600 dark:[&_li]:text-gray-400 [&_li]:mb-2",
            )}
          >
            <p>{t("legal.terms.intro")}</p>

            {/* Section 1 */}
            <h2>{t("legal.terms.section1.title")}</h2>
            <p>{t("legal.terms.section1.description")}</p>

            {/* Section 2 */}
            <h2>{t("legal.terms.section2.title")}</h2>
            <p>{t("legal.terms.section2.description")}</p>
            {renderList(
              t("legal.terms.section2.items", {
                returnObjects: true,
              }) as string[],
            )}

            {/* Section 3 */}
            <h2>{t("legal.terms.section3.title")}</h2>

            <h3>{t("legal.terms.section3.requirements.title")}</h3>
            <p>{t("legal.terms.section3.requirements.description")}</p>

            <h3>{t("legal.terms.section3.responsibility.title")}</h3>
            <p>{t("legal.terms.section3.responsibility.description")}</p>

            {/* Section 4 */}
            <h2>{t("legal.terms.section4.title")}</h2>
            <p>{t("legal.terms.section4.description")}</p>
            {renderList(
              t("legal.terms.section4.items", {
                returnObjects: true,
              }) as string[],
            )}

            {/* Section 5 */}
            <h2>{t("legal.terms.section5.title")}</h2>

            <h3>{t("legal.terms.section5.plans.title")}</h3>
            <p>{t("legal.terms.section5.plans.description")}</p>

            <h3>{t("legal.terms.section5.payments.title")}</h3>
            <p>{t("legal.terms.section5.payments.description")}</p>

            <h3>{t("legal.terms.section5.refunds.title")}</h3>
            <p>{t("legal.terms.section5.refunds.description")}</p>

            {/* Section 6 */}
            <h2>{t("legal.terms.section6.title")}</h2>

            <h3>{t("legal.terms.section6.ourRights.title")}</h3>
            <p>{t("legal.terms.section6.ourRights.description")}</p>

            <h3>{t("legal.terms.section6.yourContent.title")}</h3>
            <p>{t("legal.terms.section6.yourContent.description")}</p>

            {/* Section 7 */}
            <h2>{t("legal.terms.section7.title")}</h2>
            <p>{t("legal.terms.section7.description")}</p>
            {renderList(
              t("legal.terms.section7.items", {
                returnObjects: true,
              }) as string[],
            )}

            {/* Section 8 */}
            <h2>{t("legal.terms.section8.title")}</h2>
            <p>{t("legal.terms.section8.description")}</p>
            {renderList(
              t("legal.terms.section8.items", {
                returnObjects: true,
              }) as string[],
            )}

            {/* Section 9 */}
            <h2>{t("legal.terms.section9.title")}</h2>
            <p>{t("legal.terms.section9.description")}</p>

            {/* Section 10 */}
            <h2>{t("legal.terms.section10.title")}</h2>
            <p>{t("legal.terms.section10.description")}</p>

            {/* Section 11 */}
            <h2>{t("legal.terms.section11.title")}</h2>
            <p>{t("legal.terms.section11.description")}</p>

            {/* Section 12 */}
            <h2>{t("legal.terms.section12.title")}</h2>
            <p>{t("legal.terms.section12.description")}</p>

            {/* Section 13 */}
            <h2>{t("legal.terms.section13.title")}</h2>
            <p>{t("legal.terms.section13.description")}</p>
            <p>
              <strong>Hyo Dev</strong>
              <br />
              Email:{" "}
              <a
                href="mailto:hyo@hyo.dev"
                className="text-black dark:text-white hover:underline"
              >
                hyo@hyo.dev
              </a>
              <br />
              Website:{" "}
              <a
                href="https://hyo.dev"
                target="_blank"
                rel="noopener noreferrer"
                className="text-black dark:text-white hover:underline"
              >
                https://hyo.dev
              </a>
            </p>

            <p
              className={cn("text-sm text-gray-500 mt-8", "dark:text-gray-500")}
            >
              {t("legal.terms.lastUpdated")}
            </p>
          </div>
        </div>
      </Layout>
    </>
  );
}
