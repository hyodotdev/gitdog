import type { FunctionReturnType } from "convex/server";
import { useTranslation } from "react-i18next";
import { KeyRound } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { cn } from "../../utils/cn";
import { formatTokens, formatUsdCents } from "../../utils/usageFormat";

type ActionUsage = FunctionReturnType<
  typeof api.tokenUsage.query.getTicketUsage
>[number];

/**
 * What one run cost: the provider's price when it ran on the owner's key,
 * otherwise the Gitdog tokens it used, with the models that served it.
 */
export function ActionUsageChip({ usage }: { usage: ActionUsage | undefined }) {
  const { t } = useTranslation();
  if (!usage) return null;
  const { userKey, gitdog } = usage;
  if (!userKey && !gitdog) return null;
  const more = usage.isPartial ? "+" : "";
  const models = [...(userKey?.models ?? []), ...(gitdog?.models ?? [])];
  const parts = [
    userKey &&
      t("tickets.detail.usage.userKey", {
        cost: `${formatUsdCents(userKey.costCents)}${more}`,
      }),
    gitdog &&
      t("tickets.detail.usage.gitdog", {
        tokens: `${formatTokens(gitdog.quotaTokens)}${more}`,
      }),
  ].filter(Boolean);
  const requests = t("tickets.detail.usage.requests", {
    count: (userKey?.requests ?? 0) + (gitdog?.requests ?? 0),
  });

  return (
    <span
      title={requests}
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 text-xs tabular-nums border",
        "border-gray-300 text-gray-700",
        "dark:border-gray-700 dark:text-gray-300",
      )}
    >
      {userKey && (
        <KeyRound size={12} className="shrink-0" aria-hidden="true" />
      )}
      {[...new Set(models)].join(", ")} · {parts.join(" + ")}
      <span className="sr-only"> · {requests}</span>
    </span>
  );
}
