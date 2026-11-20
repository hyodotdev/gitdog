import { useQuery } from "convex/react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { KeyRound } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { cn } from "../../utils/cn";
import { useRelativeTime } from "../../hooks/useRelativeTime";
import { summarizeProviderKeys } from "../../utils/providerKeyState";
import { actionTypeLabel } from "../../utils/actionTypes";
import { formatTokens, formatUsdCents } from "../../utils/usageFormat";

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

const boxClass = cn("p-6", "border border-gray-200", "dark:border-gray-800");
const mutedClass = cn("text-sm text-gray-500", "dark:text-gray-400");
const linkClass = cn(
  "shrink-0 px-4 py-2 text-sm border border-black text-black",
  "hover:bg-black hover:text-white",
  "dark:border-white dark:text-white dark:hover:bg-white dark:hover:text-black",
);

function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className={boxClass}>
      <div className={cn("text-sm text-gray-600 mb-2", "dark:text-gray-400")}>
        {label}
      </div>
      <div
        className={cn(
          "text-3xl font-brand font-bold text-black tabular-nums",
          "dark:text-white",
        )}
      >
        {value}
      </div>
      <div className={cn(mutedClass, "mt-1")}>{note}</div>
    </div>
  );
}

/**
 * What runs on the owner's own provider keys: which key and model reviews use
 * now, and what that usage cost this period at provider prices.
 */
export function UserKeyUsageSection() {
  const { t, i18n } = useTranslation();
  const relativeTime = useRelativeTime();
  const keys = useQuery(api.providerApiKeys.query.list);
  const usage = useQuery(api.tokenUsage.query.getUserKeyUsage);
  if (keys === undefined || usage === undefined || usage === null) return null;
  if (keys.length === 0 && usage.totals.requests === 0) return null;

  const { keyChecksUnavailable, activeKey, backupKey } =
    summarizeProviderKeys(keys);
  // Saved keys never fall back to Gitdog tokens: reviews stop until one works.
  const inactiveKeyMessage =
    keys.length === 0
      ? "noKey"
      : keyChecksUnavailable
        ? "keyChecksUnavailable"
        : "noWorkingKey";
  const { totals } = usage;
  const average = totals.actions > 0 ? totals.costCents / totals.actions : 0;

  return (
    <section className={cn("mb-8")}>
      <div className={cn("flex items-center gap-3 mb-4")}>
        <KeyRound size={22} className="shrink-0" aria-hidden="true" />
        <h2
          className={cn(
            "text-2xl font-brand font-bold text-black",
            "dark:text-white",
          )}
        >
          {t("usage.userKey.title")}
        </h2>
      </div>

      <div
        className={cn(
          boxClass,
          "mb-4 flex flex-wrap items-center justify-between gap-4",
        )}
      >
        {activeKey ? (
          <div>
            <p className={cn("text-sm text-gray-600", "dark:text-gray-400")}>
              {t("usage.userKey.runsOn", {
                provider: PROVIDER_LABELS[activeKey.provider],
                last4: activeKey.last4,
              })}
            </p>
            <p
              className={cn(
                "text-xl font-brand font-bold text-black",
                "dark:text-white",
              )}
            >
              {activeKey.name}
              <span className={cn("ml-2 text-base font-normal", mutedClass)}>
                {t("usage.userKey.effort", {
                  effort: t(`profile.providerKeys.efforts.${activeKey.effort}`),
                })}
              </span>
            </p>
            {backupKey && (
              <p className={cn(mutedClass, "mt-1")}>
                {t("usage.userKey.backup", {
                  provider: PROVIDER_LABELS[backupKey.provider],
                  model: backupKey.name,
                })}
              </p>
            )}
          </div>
        ) : (
          <p className={cn("text-sm text-gray-700", "dark:text-gray-300")}>
            {t(`usage.userKey.${inactiveKeyMessage}`)}
          </p>
        )}
        <Link to="/profile#ai-keys" className={linkClass}>
          {activeKey
            ? t("usage.userKey.changeModel")
            : t("usage.userKey.manageKeys")}
        </Link>
      </div>

      <div className={cn("grid grid-cols-1 gap-4 mb-4", "md:grid-cols-3")}>
        <Stat
          label={t("usage.userKey.costLabel")}
          value={`${formatUsdCents(totals.costCents)}${usage.isPartial ? "+" : ""}`}
          note={t("usage.userKey.costNote")}
        />
        <Stat
          label={t("usage.userKey.runsLabel")}
          value={totals.actions.toLocaleString(i18n.language)}
          note={t("usage.userKey.requests", { count: totals.requests })}
        />
        <Stat
          label={t("usage.userKey.averageLabel")}
          value={formatUsdCents(average)}
          note={t("usage.userKey.tokens", {
            input: formatTokens(totals.inputTokens),
            output: formatTokens(totals.outputTokens),
          })}
        />
      </div>

      {usage.models.length > 0 && (
        <div className={cn(boxClass, "mb-4 overflow-x-auto")}>
          <h3 className={cn("font-bold text-black mb-3", "dark:text-white")}>
            {t("usage.userKey.byModel")}
          </h3>
          <table className={cn("w-full text-sm")}>
            <thead>
              <tr
                className={cn(
                  "text-left text-gray-500 border-b border-gray-200",
                  "dark:text-gray-400 dark:border-gray-800",
                )}
              >
                <th className="py-2 pr-4 font-medium">
                  {t("usage.userKey.columns.model")}
                </th>
                <th className="py-2 pr-4 font-medium text-right">
                  {t("usage.userKey.columns.runs")}
                </th>
                <th className="py-2 pr-4 font-medium text-right">
                  {t("usage.userKey.columns.tokens")}
                </th>
                <th className="py-2 pr-4 font-medium text-right">
                  {t("usage.userKey.columns.average")}
                </th>
                <th className="py-2 font-medium text-right">
                  {t("usage.userKey.columns.cost")}
                </th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {usage.models.map((model) => (
                <tr
                  key={`${model.provider}/${model.modelId}`}
                  className={cn(
                    "border-b border-gray-100 last:border-0",
                    "dark:border-gray-900",
                  )}
                >
                  <td className="py-2 pr-4">
                    <span className="font-medium">{model.name}</span>
                    <span className={cn("ml-2", mutedClass)}>
                      {PROVIDER_LABELS[model.provider] ?? model.provider}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-right">{model.actions}</td>
                  <td className="py-2 pr-4 text-right">
                    {formatTokens(model.inputTokens + model.outputTokens)}
                  </td>
                  <td className="py-2 pr-4 text-right">
                    {formatUsdCents(
                      model.actions > 0 ? model.costCents / model.actions : 0,
                    )}
                  </td>
                  <td className="py-2 text-right font-medium">
                    {formatUsdCents(model.costCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className={boxClass}>
        <h3 className={cn("font-bold text-black mb-3", "dark:text-white")}>
          {t("usage.userKey.recent")}
        </h3>
        {usage.recentActions.length === 0 ? (
          <p className={mutedClass}>{t("usage.userKey.noRuns")}</p>
        ) : (
          <ul
            className={cn("divide-y divide-gray-100", "dark:divide-gray-900")}
          >
            {usage.recentActions.map((run) => {
              const title = `${run.githubRepo} #${run.githubNumber} ${run.githubTitle}`;
              return (
                <li
                  key={run.ticketActionId}
                  className={cn(
                    "flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 text-sm",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <span className={cn("mr-2", mutedClass)}>
                      {actionTypeLabel(t, run.actionType)}
                    </span>
                    {run.ticketId ? (
                      <Link
                        to={`/tickets/${run.ticketId}`}
                        className="underline hover:no-underline break-words"
                      >
                        {title}
                      </Link>
                    ) : (
                      <span className="break-words">{title}</span>
                    )}
                    <div className={mutedClass}>
                      {run.models.join(", ")} ·{" "}
                      {t("usage.userKey.tokens", {
                        input: formatTokens(run.inputTokens),
                        output: formatTokens(run.outputTokens),
                      })}{" "}
                      · {relativeTime(run.lastAt)}
                    </div>
                  </div>
                  <span className="font-medium tabular-nums">
                    {formatUsdCents(run.costCents)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {usage.isPartial && (
          <p className={cn(mutedClass, "mt-3")}>{t("usage.userKey.partial")}</p>
        )}
      </div>
    </section>
  );
}
