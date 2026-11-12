import { useAction, useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { LoadingIndicator } from "../../components/uis/LoadingIndicator";
import { cn } from "../../utils/cn";

type KeyProvider = "anthropic" | "openai";

const PROVIDERS: Array<{
  provider: KeyProvider;
  label: string;
  placeholder: string;
  pattern: RegExp;
}> = [
  {
    provider: "anthropic",
    label: "Anthropic",
    placeholder: "sk-ant-...",
    pattern: /^sk-ant-[A-Za-z0-9_-]{20,500}$/,
  },
  {
    provider: "openai",
    label: "OpenAI",
    placeholder: "sk-...",
    pattern: /^sk-(?!ant-)[A-Za-z0-9_-]{20,500}$/,
  },
];

function serverReason(error: unknown): string | null {
  if (!(error instanceof ConvexError)) return null;
  const data = error.data as { reason?: unknown };
  return typeof data?.reason === "string" ? data.reason : null;
}

function ProviderKeyCard({
  provider,
  label,
  placeholder,
  pattern,
  saved,
}: (typeof PROVIDERS)[number] & {
  saved:
    | {
        last4: string;
        status: "active" | "invalid" | "out_of_credit";
        lastValidatedAt: number;
      }
    | undefined;
}) {
  const { t } = useTranslation();
  const saveKey = useAction(api.providerApiKeys.action.save);
  const revalidateKey = useAction(api.providerApiKeys.action.revalidate);
  const removeKey = useMutation(api.providerApiKeys.mutation.remove);
  const [apiKey, setApiKey] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const translateError = (cause: unknown) => {
    switch (serverReason(cause)) {
      case "invalid_key":
        return t("profile.providerKeys.errors.rejected", { provider: label });
      case "no_model_access":
        return t("profile.providerKeys.errors.noModelAccess", {
          provider: label,
        });
      case "wrong_provider":
        return t("profile.providerKeys.errors.wrongProvider", {
          provider: label,
        });
      case "malformed":
        return t("profile.providerKeys.errors.format", { provider: label });
      case "rate_limited":
        return t("profile.providerKeys.errors.rateLimited");
      case "not_configured":
        return t("profile.providerKeys.errors.notConfigured");
      case "unreadable":
        return t("profile.providerKeys.errors.reenter");
      case "validation_unavailable":
        return t("profile.providerKeys.errors.unavailable", {
          provider: label,
        });
      default:
        return t("common.error");
    }
  };

  const run = async (task: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await task();
      return true;
    } catch (cause) {
      setError(translateError(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = apiKey.trim();
    if (!pattern.test(trimmed)) {
      const other = PROVIDERS.find(
        (entry) => entry.provider !== provider && entry.pattern.test(trimmed),
      );
      setError(
        other
          ? t("profile.providerKeys.errors.wrongProvider", { provider: label })
          : t("profile.providerKeys.errors.format", { provider: label }),
      );
      return;
    }
    if (await run(() => saveKey({ provider, apiKey: trimmed }))) {
      setApiKey("");
      setEditing(false);
    }
  };

  const statusLabel = saved
    ? t(`profile.providerKeys.status.${saved.status}`)
    : t("profile.providerKeys.status.notSet");
  const showForm = !saved || editing;

  return (
    <div
      className={cn(
        "p-6",
        "border border-gray-200",
        "dark:border-gray-800",
        "flex flex-col gap-4",
      )}
    >
      <div className={cn("flex items-center justify-between gap-4")}>
        <div className={cn("flex items-center gap-2")}>
          <KeyRound size={18} className="shrink-0" />
          <h3 className={cn("text-lg font-bold text-black", "dark:text-white")}>
            {label}
          </h3>
        </div>
        <span
          className={cn(
            "px-2 py-0.5 text-xs border",
            saved?.status === "active"
              ? "border-black text-black dark:border-white dark:text-white"
              : saved
                ? "border-red-500 text-red-600 dark:text-red-400"
                : "border-gray-300 text-gray-500 dark:border-gray-700",
          )}
        >
          {statusLabel}
        </span>
      </div>

      {saved && (
        <p className={cn("text-sm text-gray-600", "dark:text-gray-400")}>
          {t("profile.providerKeys.savedKey", { last4: saved.last4 })}
          {" · "}
          {t("profile.providerKeys.lastChecked", {
            date: new Date(saved.lastValidatedAt).toLocaleDateString(),
          })}
        </p>
      )}

      {showForm ? (
        <form onSubmit={handleSave} className={cn("flex flex-col gap-2")}>
          <label
            htmlFor={`provider-key-${provider}`}
            className={cn("text-sm font-medium")}
          >
            {t("profile.providerKeys.inputLabel", { provider: label })}
          </label>
          <input
            id={`provider-key-${provider}`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value);
              setError(null);
            }}
            placeholder={placeholder}
            className={cn(
              "w-full px-4 py-2 font-mono text-sm",
              "border border-gray-300 dark:border-gray-700",
              "bg-white dark:bg-gray-900",
              "focus:outline-hidden focus:border-black dark:focus:border-white",
            )}
          />
          <div className={cn("flex gap-2")}>
            <button
              type="submit"
              disabled={busy || !apiKey.trim()}
              className={cn(
                "px-4 py-2",
                "bg-black text-white",
                "hover:bg-gray-800",
                "dark:bg-white dark:text-black dark:hover:bg-gray-200",
                "disabled:opacity-50 disabled:cursor-not-allowed",
              )}
            >
              {saved
                ? t("profile.providerKeys.replace")
                : t("profile.providerKeys.save")}
            </button>
            {saved && (
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setApiKey("");
                  setError(null);
                }}
                className={cn(
                  "px-4 py-2",
                  "border border-gray-300 dark:border-gray-700",
                  "hover:bg-gray-100 dark:hover:bg-gray-800",
                )}
              >
                {t("common.cancel")}
              </button>
            )}
          </div>
        </form>
      ) : (
        <div className={cn("flex flex-wrap gap-2")}>
          <button
            type="button"
            onClick={() => setEditing(true)}
            disabled={busy}
            className={cn(
              "px-4 py-2",
              "border border-gray-300 dark:border-gray-700",
              "hover:bg-gray-100 dark:hover:bg-gray-800",
              "disabled:opacity-50",
            )}
          >
            {t("profile.providerKeys.replace")}
          </button>
          {saved?.status !== "active" && (
            <button
              type="button"
              onClick={() => void run(() => revalidateKey({ provider }))}
              disabled={busy}
              className={cn(
                "px-4 py-2",
                "border border-gray-300 dark:border-gray-700",
                "hover:bg-gray-100 dark:hover:bg-gray-800",
                "disabled:opacity-50",
              )}
            >
              {t("profile.providerKeys.checkAgain")}
            </button>
          )}
          <button
            type="button"
            onClick={() => void run(() => removeKey({ provider }))}
            disabled={busy}
            className={cn(
              "px-4 py-2",
              "border border-red-500 text-red-600",
              "hover:bg-red-50 dark:hover:bg-red-900/20",
              "dark:text-red-400",
              "disabled:opacity-50",
            )}
          >
            {t("profile.providerKeys.remove")}
          </button>
        </div>
      )}

      {busy && <LoadingIndicator />}
      {error && (
        <div
          className={cn(
            "p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm",
          )}
        >
          {error}
        </div>
      )}
    </div>
  );
}

export function ProviderKeysSection() {
  const { t } = useTranslation();
  const keys = useQuery(api.providerApiKeys.query.list);

  return (
    <section className={cn("mb-8")}>
      <h2
        className={cn(
          "text-2xl font-brand font-bold text-black mb-2",
          "dark:text-white",
        )}
      >
        {t("profile.providerKeys.title")}
      </h2>
      <p className={cn("text-gray-600 mb-2", "dark:text-gray-400")}>
        {t("profile.providerKeys.description")}
      </p>
      <p className={cn("text-sm text-gray-500 mb-6", "dark:text-gray-500")}>
        {t("profile.providerKeys.note")}
      </p>
      {keys === undefined ? (
        <LoadingIndicator />
      ) : (
        <div className={cn("grid gap-4 md:grid-cols-2")}>
          {PROVIDERS.map((entry) => (
            <ProviderKeyCard
              key={entry.provider}
              {...entry}
              saved={keys.find((key) => key.provider === entry.provider)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
