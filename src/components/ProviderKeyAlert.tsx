import { useQuery } from "convex/react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { api } from "../../convex/_generated/api";
import { cn } from "../utils/cn";

const PROVIDER_NAMES = { anthropic: "Anthropic", openai: "OpenAI" } as const;

/** Persistent notice while a saved provider key cannot be used. */
export function ProviderKeyAlert() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const keys = useQuery(api.providerApiKeys.query.list);
  const failing = keys?.find(
    (key) => key.status !== "active" || key.readable === false,
  );
  if (!failing) return null;

  const provider = PROVIDER_NAMES[failing.provider];
  const message =
    failing.readable === false
      ? t("banner.providerKey.unreadable", { provider })
      : failing.status === "out_of_credit"
        ? t("banner.providerKey.outOfCredit", { provider })
        : t("banner.providerKey.invalid", { provider });

  return (
    <div
      role="alert"
      className={cn("py-3", "bg-red-600 text-white", "dark:bg-red-700")}
    >
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-x-4 gap-y-1",
          "max-w-7xl mx-auto",
          "px-4 sm:px-6",
        )}
      >
        <p className={cn("text-sm")}>{message}</p>
        <button
          onClick={() => navigate("/profile")}
          className={cn("text-sm font-medium underline", "hover:no-underline")}
        >
          {t("banner.providerKey.action")}
        </button>
      </div>
    </div>
  );
}
