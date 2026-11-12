import { SEO } from "../../components/SEO";
import { Layout } from "../../components/Layout";
import { useTranslation } from "react-i18next";
import { cn } from "../../utils/cn";

export function PrivacyPolicyPage() {
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
        title={t("legal.privacy.title") || "Privacy Policy"}
        description={t("legal.privacy.description") || undefined}
        path="/legal/privacy-policy"
      />
      <Layout>
        <div className={cn("max-w-4xl mx-auto px-6 py-12")}>
          <h1
            className={cn(
              "text-4xl font-brand font-bold text-black mb-2",
              "dark:text-white",
            )}
          >
            {t("legal.privacy.heading")}
          </h1>
          <p className={cn("text-gray-600 mb-8", "dark:text-gray-400")}>
            {t("legal.privacy.companyInfo")}
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
            <p>{t("legal.privacy.intro")}</p>

            {/* Section 1 */}
            <h2>{t("legal.privacy.section1.title")}</h2>

            <h3>{t("legal.privacy.section1.account.title")}</h3>
            <p>{t("legal.privacy.section1.account.description")}</p>
            {renderList(
              t("legal.privacy.section1.account.items", {
                returnObjects: true,
              }) as string[],
            )}
            <p>{t("legal.privacy.section1.account.note")}</p>

            <h3>{t("legal.privacy.section1.repository.title")}</h3>
            <p>{t("legal.privacy.section1.repository.description")}</p>
            {renderList(
              t("legal.privacy.section1.repository.items", {
                returnObjects: true,
              }) as string[],
            )}
            <p>{t("legal.privacy.section1.repository.note")}</p>

            <h3>{t("legal.privacy.section1.usage.title")}</h3>
            <p>{t("legal.privacy.section1.usage.description")}</p>
            {renderList(
              t("legal.privacy.section1.usage.items", {
                returnObjects: true,
              }) as string[],
            )}

            <h3>{t("legal.privacy.section1.automatic.title")}</h3>
            <p>{t("legal.privacy.section1.automatic.description")}</p>
            {renderList(
              t("legal.privacy.section1.automatic.items", {
                returnObjects: true,
              }) as string[],
            )}
            <p>{t("legal.privacy.section1.automatic.note")}</p>

            {/* Section 2 */}
            <h2>{t("legal.privacy.section2.title")}</h2>
            <p>{t("legal.privacy.section2.description")}</p>
            {renderList(
              t("legal.privacy.section2.items", {
                returnObjects: true,
              }) as string[],
            )}
            <p>{t("legal.privacy.section2.note")}</p>

            {/* Section 3 */}
            <h2>{t("legal.privacy.section3.title")}</h2>
            <p>{t("legal.privacy.section3.description")}</p>
            {renderList(
              t("legal.privacy.section3.items", {
                returnObjects: true,
              }) as string[],
            )}

            {/* Section 4 */}
            <h2>{t("legal.privacy.section4.title")}</h2>
            <p>{t("legal.privacy.section4.description")}</p>

            <h3>{t("legal.privacy.section4.convex.title")}</h3>
            <p>{t("legal.privacy.section4.convex.description")}</p>
            {renderList(
              t("legal.privacy.section4.convex.items", {
                returnObjects: true,
              }) as string[],
            )}

            <h3>{t("legal.privacy.section4.github.title")}</h3>
            <p>{t("legal.privacy.section4.github.description")}</p>
            {renderList(
              t("legal.privacy.section4.github.items", {
                returnObjects: true,
              }) as string[],
            )}

            <h3>{t("legal.privacy.section4.aiGeneration.title")}</h3>
            <p>{t("legal.privacy.section4.aiGeneration.description")}</p>
            {renderList(
              t("legal.privacy.section4.aiGeneration.items", {
                returnObjects: true,
              }) as string[],
            )}

            <h3>{t("legal.privacy.section4.lemonSqueezy.title")}</h3>
            <p>{t("legal.privacy.section4.lemonSqueezy.description")}</p>
            {renderList(
              t("legal.privacy.section4.lemonSqueezy.items", {
                returnObjects: true,
              }) as string[],
            )}
            <p>{t("legal.privacy.section4.lemonSqueezy.note")}</p>

            <p>{t("legal.privacy.section4.note")}</p>

            {/* Section 5 */}
            <h2>{t("legal.privacy.section5.title")}</h2>
            <p>{t("legal.privacy.section5.description")}</p>
            {renderList(
              t("legal.privacy.section5.items", {
                returnObjects: true,
              }) as string[],
            )}

            {/* Section 6 */}
            <h2>{t("legal.privacy.section6.title")}</h2>
            <p>{t("legal.privacy.section6.description")}</p>
            {renderList(
              t("legal.privacy.section6.items", {
                returnObjects: true,
              }) as string[],
            )}
            <p>{t("legal.privacy.section6.note")}</p>

            {/* Section 7 */}
            <h2>{t("legal.privacy.section7.title")}</h2>
            <p>{t("legal.privacy.section7.description")}</p>
            {renderList(
              t("legal.privacy.section7.items", {
                returnObjects: true,
              }) as string[],
            )}

            {/* Section 8 */}
            <h2>{t("legal.privacy.section8.title")}</h2>
            <p>{t("legal.privacy.section8.description")}</p>

            {/* Section 9 */}
            <h2>{t("legal.privacy.section9.title")}</h2>
            <p>{t("legal.privacy.section9.description")}</p>
            {renderList(
              t("legal.privacy.section9.items", {
                returnObjects: true,
              }) as string[],
            )}
            <p>
              {t("legal.privacy.section9.contact")}{" "}
              <a
                href="mailto:hyo@hyo.dev"
                className="text-black dark:text-white hover:underline"
              >
                hyo@hyo.dev
              </a>
              .
            </p>

            {/* Section 10 */}
            <h2>{t("legal.privacy.section10.title")}</h2>
            <p>{t("legal.privacy.section10.description")}</p>

            {/* Section 11 */}
            <h2>{t("legal.privacy.section11.title")}</h2>
            <p>{t("legal.privacy.section11.description")}</p>
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
              {t("legal.privacy.lastUpdated")}
            </p>
          </div>
        </div>
      </Layout>
    </>
  );
}
