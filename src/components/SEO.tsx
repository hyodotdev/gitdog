import { Helmet } from "react-helmet-async";
import { useTranslation } from "react-i18next";

interface SEOProps {
  title?: string;
  description?: string;
  path?: string;
  image?: string;
  noIndex?: boolean;
  locale?: string;
}

const SITE_URL = "https://gitdog.dev";
const DEFAULT_TITLE = "Gitdog - AI GitHub Assistant";
const DEFAULT_DESCRIPTION =
  "AI assistant for GitHub issues and discussions. Get intelligent answers based on your codebase context.";
const DEFAULT_IMAGE = "/og-image.png";
const SUPPORTED_LOCALES = ["en", "ko", "ja"];
// Most locale titles already carry the brand as a prefix or suffix.
const BRANDED_TITLE = /^Gitdog\b|\s-\sGitdog$/;

export function SEO({
  title,
  description = DEFAULT_DESCRIPTION,
  path = "",
  image = DEFAULT_IMAGE,
  noIndex = false,
  locale,
}: SEOProps) {
  const { i18n } = useTranslation();
  const activeLocale = (
    locale ??
    i18n.resolvedLanguage ??
    i18n.language ??
    "en"
  ).split("-")[0];
  const fullTitle = !title
    ? DEFAULT_TITLE
    : BRANDED_TITLE.test(title)
      ? title
      : `${title} - Gitdog`;
  const fullUrl = `${SITE_URL}${path}`;
  const fullImage = image.startsWith("http") ? image : `${SITE_URL}${image}`;

  return (
    <Helmet htmlAttributes={{ lang: activeLocale }}>
      {/* Primary Meta Tags */}
      <title>{fullTitle}</title>
      <meta name="title" content={fullTitle} />
      <meta name="description" content={description} />
      <link rel="canonical" href={fullUrl} />

      {/* Hreflang Tags for Multi-language Support */}
      {SUPPORTED_LOCALES.map((lang) => (
        <link
          key={lang}
          rel="alternate"
          hrefLang={lang}
          href={`${fullUrl}${fullUrl.includes("?") ? "&" : "?"}lang=${lang}`}
        />
      ))}
      <link rel="alternate" hrefLang="x-default" href={fullUrl} />

      {/* Open Graph / Facebook */}
      <meta property="og:type" content="website" />
      <meta property="og:url" content={fullUrl} />
      <meta property="og:title" content={fullTitle} />
      <meta property="og:description" content={description} />
      <meta property="og:image" content={fullImage} />
      <meta property="og:site_name" content="Gitdog" />
      <meta property="og:locale" content={activeLocale} />
      {SUPPORTED_LOCALES.filter((lang) => lang !== activeLocale).map((lang) => (
        <meta key={lang} property="og:locale:alternate" content={lang} />
      ))}

      {/* Twitter */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:url" content={fullUrl} />
      <meta name="twitter:title" content={fullTitle} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={fullImage} />

      {/* No Index */}
      {noIndex && <meta name="robots" content="noindex, nofollow" />}
    </Helmet>
  );
}
