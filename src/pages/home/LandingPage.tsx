import { Link } from "react-router";
import { SiGithub } from "@icons-pack/react-simple-icons";
import { Check, Edit3, X } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { StatusBadge } from "../../components/uis/StatusBadge";
import { cn } from "../../utils/cn";

const CAPABILITIES = ["format", "answer", "review", "tag"] as const;
const STEPS = ["connect", "mention", "approve"] as const;
const SAMPLE_CODE_CLASS =
  "bg-black/5 px-1 py-0.5 text-[0.8125rem] dark:bg-white/10";

function SignInLink({ children }: { children: string }) {
  return (
    <Link
      to="/legal/consent"
      className={cn(
        "inline-flex items-center justify-center gap-3 px-6 py-4",
        "bg-[#FF8C42] text-base font-medium text-black",
        "transition-colors",
        "hover:bg-[#FF7A2E]",
      )}
    >
      <SiGithub size={20} className="shrink-0" aria-hidden="true" />
      {children}
    </Link>
  );
}

function SampleThread() {
  const { t } = useTranslation();

  return (
    <figure
      className={cn(
        "min-w-0 border border-black bg-white",
        "dark:border-gray-600 dark:bg-gray-950",
      )}
    >
      <figcaption
        className={cn(
          "flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-4",
          "border-b border-gray-200 dark:border-gray-800",
        )}
      >
        <span className="font-medium text-black dark:text-white">
          <span className="text-gray-500">#214</span>{" "}
          {t("home.landing.thread.title")}
        </span>
        <span className="text-xs text-gray-500">
          {t("home.landing.thread.sample")}
        </span>
      </figcaption>

      <div className="px-5 py-4">
        <p className="mb-1 text-sm font-medium text-black dark:text-white">
          sam
        </p>
        <p className="text-sm leading-relaxed text-gray-700 dark:text-gray-300">
          <span className="font-medium text-black dark:text-white">
            @gitdogbot
          </span>{" "}
          {t("home.landing.thread.question")}
        </p>
      </div>

      <div
        className={cn(
          "px-5 py-4 motion-safe:animate-rise",
          "border-t border-gray-200 bg-gray-50",
          "dark:border-gray-800 dark:bg-gray-900",
        )}
      >
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium text-black dark:text-white">
            {t("home.landing.thread.draftBy")}
          </p>
          <StatusBadge
            status="pending_approval"
            label={t("tickets.actionStatus.pending_approval")}
            size="small"
          />
        </div>
        <p className="text-sm leading-relaxed text-gray-700 dark:text-gray-300">
          <Trans
            i18nKey="home.landing.thread.answer"
            components={{
              symbol: <code className={SAMPLE_CODE_CLASS} />,
              path: (
                <code className={cn(SAMPLE_CODE_CLASS, "whitespace-nowrap")} />
              ),
            }}
          />
        </p>
        <div
          aria-hidden="true"
          className="mt-4 flex flex-wrap gap-2 text-xs font-medium"
        >
          <span className="flex items-center gap-1.5 bg-black px-3 py-2 text-white dark:bg-white dark:text-black">
            <Check size={14} />
            {t("tickets.detail.postComment")}
          </span>
          <span className="flex items-center gap-1.5 border border-gray-300 px-3 py-2 text-gray-700 dark:border-gray-700 dark:text-gray-300">
            <Edit3 size={14} />
            {t("tickets.detail.requestChanges")}
          </span>
          <span className="flex items-center gap-1.5 border border-gray-300 px-3 py-2 text-gray-700 dark:border-gray-700 dark:text-gray-300">
            <X size={14} />
            {t("tickets.detail.reject")}
          </span>
        </div>
      </div>
    </figure>
  );
}

export function LandingPage() {
  const { t } = useTranslation();

  return (
    <div className="bg-white text-black dark:bg-black dark:text-white">
      <section
        className={cn(
          "mx-auto grid max-w-7xl items-center gap-12 px-6 py-16",
          "lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-16 lg:py-24",
        )}
      >
        <div className="min-w-0">
          <h1 className="font-brand text-5xl font-bold leading-[1.02] tracking-[-0.03em] sm:text-6xl xl:text-7xl">
            {t("home.landing.heading")}
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-gray-600 dark:text-gray-400">
            {t("home.landing.subtitle")}
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
            <SignInLink>{t("home.landing.cta")}</SignInLink>
            <Link
              to="/pricing"
              className="underline underline-offset-4 hover:no-underline"
            >
              {t("home.landing.viewPricing")}
            </Link>
          </div>
        </div>
        <SampleThread />
      </section>

      <section className="border-t border-gray-200 dark:border-gray-800">
        <div className="mx-auto max-w-7xl px-6 py-16 lg:py-24">
          <h2 className="mb-10 font-brand text-3xl font-bold tracking-[-0.02em] sm:text-4xl">
            {t("home.landing.capabilitiesTitle")}
          </h2>
          <dl className="border-t border-black dark:border-white">
            {CAPABILITIES.map((capability) => (
              <div
                key={capability}
                className={cn(
                  "grid gap-2 py-6 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] md:gap-8",
                  "border-b border-gray-200 dark:border-gray-800",
                )}
              >
                <dt className="font-brand text-xl font-bold">
                  {t(`home.landing.capabilities.${capability}.title`)}
                </dt>
                <dd className="max-w-2xl leading-relaxed text-gray-600 dark:text-gray-400">
                  {t(`home.landing.capabilities.${capability}.description`)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="bg-gray-100 dark:bg-gray-950">
        <div className="mx-auto max-w-7xl px-6 py-16 lg:py-24">
          <h2 className="mb-10 font-brand text-3xl font-bold tracking-[-0.02em] sm:text-4xl">
            {t("home.landing.stepsTitle")}
          </h2>
          <ol className="grid gap-10 md:grid-cols-3 md:gap-8">
            {STEPS.map((step, index) => (
              <li key={step} className="min-w-0">
                <span
                  aria-hidden="true"
                  className="font-brand text-5xl font-bold text-gray-300 dark:text-gray-700"
                >
                  {index + 1}
                </span>
                <h3 className="mb-2 mt-3 font-brand text-xl font-bold">
                  {t(`home.landing.steps.${step}.title`)}
                </h3>
                <p className="leading-relaxed text-gray-600 dark:text-gray-400">
                  {t(`home.landing.steps.${step}.description`)}
                </p>
              </li>
            ))}
          </ol>
          <div className="mt-14 aspect-video max-w-4xl bg-black">
            <iframe
              className="h-full w-full"
              src="https://www.youtube-nocookie.com/embed/In3PkIbcx6k"
              title={t("home.landing.demoTitle")}
              loading="lazy"
              allow="encrypted-media; picture-in-picture; web-share"
              referrerPolicy="strict-origin-when-cross-origin"
              allowFullScreen
            />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 py-16 lg:py-24">
        <h2 className="max-w-3xl font-brand text-4xl font-bold tracking-[-0.03em] sm:text-5xl">
          {t("home.landing.ctaBottomTitle")}
        </h2>
        <p className="mb-8 mt-4 max-w-2xl text-lg text-gray-600 dark:text-gray-400">
          {t("home.landing.ctaBottomSubtitle")}
        </p>
        <SignInLink>{t("auth.getStartedFree")}</SignInLink>
      </section>
    </div>
  );
}
