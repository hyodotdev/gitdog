import { Helmet } from "react-helmet-async";

const SITE_URL = "https://gitdog.dev";

interface JsonLdProps {
  data: Record<string, unknown>;
}

export function JsonLd({ data }: JsonLdProps) {
  return (
    <Helmet>
      <script type="application/ld+json">{JSON.stringify(data)}</script>
    </Helmet>
  );
}

export function OrganizationJsonLd() {
  const data = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Gitdog",
    url: SITE_URL,
    logo: `${SITE_URL}/icon-bg.jpg`,
    description:
      "AI-powered assistant for GitHub repositories. Automates issue responses and discussion replies with intelligent codebase-aware answers.",
    sameAs: ["https://github.com/hyodotdev"],
    contactPoint: {
      "@type": "ContactPoint",
      contactType: "customer support",
      url: `${SITE_URL}/contact`,
    },
  };

  return <JsonLd data={data} />;
}

export function WebSiteJsonLd() {
  const data = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "Gitdog",
    url: SITE_URL,
    description:
      "AI-powered assistant for GitHub repositories. Automates issue responses and discussion replies with intelligent codebase-aware answers.",
    potentialAction: {
      "@type": "SearchAction",
      target: `${SITE_URL}/?q={search_term_string}`,
      "query-input": "required name=search_term_string",
    },
  };

  return <JsonLd data={data} />;
}

export function SoftwareApplicationJsonLd() {
  const data = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Gitdog",
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Web",
    url: SITE_URL,
    description:
      "AI-powered assistant for GitHub repositories. Automates issue responses and discussion replies with intelligent codebase-aware answers.",
    offers: [
      {
        "@type": "Offer",
        name: "Free",
        price: "0",
        priceCurrency: "USD",
        description:
          "100,000 one-time trial tokens, then your own Anthropic or OpenAI API key; prepaid token packs available for additional usage",
      },
      {
        "@type": "Offer",
        name: "Pro",
        price: "9.99",
        priceCurrency: "USD",
        priceSpecification: {
          "@type": "UnitPriceSpecification",
          price: "9.99",
          priceCurrency: "USD",
          billingDuration: "P1M",
        },
        description:
          "2.4M tokens per month with prepaid token packs for additional usage and no automatic overage charges",
      },
    ],
    featureList: [
      "Issue Automation",
      "Discussion Assistant",
      "Repository-Grounded Answers",
      "Codebase Indexing",
      "All Programming Languages",
    ],
    screenshot: `${SITE_URL}/og-image.png`,
  };

  return <JsonLd data={data} />;
}

interface FAQItem {
  question: string;
  answer: string;
}

interface FAQPageJsonLdProps {
  faqs: FAQItem[];
}

export function FAQPageJsonLd({ faqs }: FAQPageJsonLdProps) {
  const data = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((faq) => ({
      "@type": "Question",
      name: faq.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: faq.answer,
      },
    })),
  };

  return <JsonLd data={data} />;
}

interface BreadcrumbItem {
  name: string;
  url: string;
}

interface BreadcrumbJsonLdProps {
  items: BreadcrumbItem[];
}

export function BreadcrumbJsonLd({ items }: BreadcrumbJsonLdProps) {
  const data = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: item.url.startsWith("http") ? item.url : `${SITE_URL}${item.url}`,
    })),
  };

  return <JsonLd data={data} />;
}

export function PricingPageJsonLd() {
  const data = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: "Gitdog",
    description:
      "AI-powered assistant for GitHub repositories. Automates issue responses and discussion replies.",
    brand: {
      "@type": "Brand",
      name: "Gitdog",
    },
    offers: [
      {
        "@type": "Offer",
        name: "Free Plan",
        price: "0",
        priceCurrency: "USD",
        description:
          "100,000 one-time trial tokens, then your own Anthropic or OpenAI API key; prepaid token packs available for additional usage",
        availability: "https://schema.org/InStock",
      },
      {
        "@type": "Offer",
        name: "Pro Plan",
        price: "9.99",
        priceCurrency: "USD",
        priceSpecification: {
          "@type": "UnitPriceSpecification",
          price: "9.99",
          priceCurrency: "USD",
          billingDuration: "P1M",
          unitText: "month",
        },
        description:
          "2.4M tokens per month with prepaid token packs for additional usage and no automatic overage charges",
        availability: "https://schema.org/InStock",
      },
      {
        "@type": "Offer",
        name: "Small Token Pack",
        price: "9.99",
        priceCurrency: "USD",
        description: "2.2M tokens, never expire",
        availability: "https://schema.org/InStock",
      },
      {
        "@type": "Offer",
        name: "Large Token Pack",
        price: "29.99",
        priceCurrency: "USD",
        description: "7.5M tokens, never expire, best value",
        availability: "https://schema.org/InStock",
      },
    ],
  };

  return <JsonLd data={data} />;
}
