import { useQuery } from "convex/react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { api } from "../../convex/_generated/api";
import { cn } from "../utils/cn";
import { summarizeProviderKeys } from "../utils/providerKeyState";

/**
 * What a free account does after the trial: add its own provider key or go
 * Pro. Turns into a prominent call to action once nothing is left to spend.
 */
export function TrialNextStep({ tokensLeft }: { tokensLeft: number }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const keys = useQuery(api.providerApiKeys.query.list);
  if (keys === undefined) return null;
  const { keyChecksUnavailable, activeKey } = summarizeProviderKeys(keys);
  const hasUsableKey = activeKey !== undefined;
  const exhausted = tokensLeft <= 0 && !hasUsableKey && !keyChecksUnavailable;

  const addKey = () => navigate("/profile#ai-keys");
  return (
    <div
      className={cn(
        "p-6",
        exhausted
          ? "bg-black text-white dark:bg-white dark:text-black"
          : "border border-gray-200 dark:border-gray-800",
      )}
    >
      <h3 className={cn("text-lg font-bold mb-2")}>
        {keyChecksUnavailable
          ? t("trial.keyChecksUnavailableTitle")
          : exhausted
            ? t("trial.exhaustedTitle")
            : hasUsableKey
              ? t("trial.usingKeyTitle")
              : t("trial.nextTitle")}
      </h3>
      <p
        className={cn(
          "text-sm mb-4",
          exhausted ? "opacity-80" : "text-gray-600 dark:text-gray-400",
        )}
      >
        {keyChecksUnavailable
          ? t("trial.keyChecksUnavailableBody")
          : exhausted
            ? t("trial.exhaustedBody")
            : hasUsableKey
              ? t("trial.usingKeyBody")
              : t("trial.nextBody")}
      </p>
      <div className={cn("flex flex-wrap gap-2")}>
        <button
          onClick={addKey}
          className={cn(
            "px-4 py-2 text-sm font-medium",
            exhausted
              ? "bg-white text-black hover:bg-gray-200 dark:bg-black dark:text-white dark:hover:bg-gray-800"
              : "bg-black text-white hover:bg-gray-800 dark:bg-white dark:text-black dark:hover:bg-gray-200",
          )}
        >
          {hasUsableKey ? t("trial.manageKeys") : t("trial.addKey")}
        </button>
        <button
          onClick={() => navigate("/pricing")}
          className={cn(
            "px-4 py-2 text-sm font-medium border",
            exhausted
              ? "border-white hover:bg-white/10 dark:border-black dark:hover:bg-black/10"
              : "border-gray-300 hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-800",
          )}
        >
          {t("trial.viewPro")}
        </button>
      </div>
    </div>
  );
}
