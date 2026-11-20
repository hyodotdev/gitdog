import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ConvexError } from "convex/values";
import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, ExternalLink, KeyRound } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { LoadingIndicator } from "../../components/uis/LoadingIndicator";
import { cn } from "../../utils/cn";
import { summarizeProviderKeys } from "../../utils/providerKeyState";
import { useRelativeTime } from "../../hooks/useRelativeTime";
import {
  formatPerMillion,
  formatTokens,
  formatUsdCents,
} from "../../utils/usageFormat";

export const PROVIDER_KEYS_ANCHOR = "ai-keys";

type KeyProvider = "anthropic" | "openai";

type SavedKey = {
  provider: KeyProvider;
  last4: string;
  status: "active" | "invalid" | "out_of_credit";
  readable: boolean;
  serviceUnavailable?: boolean;
  lastValidatedAt: number;
  modelId: string;
  effort: string;
};

type ModelOption = FunctionReturnType<
  typeof api.providerApiKeys.query.models
>[KeyProvider][number];

// Which saved key reviews run on: Claude first, OpenAI when Claude cannot.
type KeyRole = "primary" | "backup";

const PROVIDERS: Record<
  KeyProvider,
  { label: string; placeholder: string; pattern: RegExp; keysUrl: string }
> = {
  anthropic: {
    label: "Anthropic",
    placeholder: "sk-ant-...",
    pattern: /^sk-ant-[A-Za-z0-9_-]{20,500}$/,
    keysUrl: "https://console.anthropic.com/settings/keys",
  },
  openai: {
    label: "OpenAI",
    placeholder: "sk-...",
    pattern: /^sk-(?!ant-)[A-Za-z0-9_-]{20,500}$/,
    keysUrl: "https://platform.openai.com/api-keys",
  },
};

const OTHER: Record<KeyProvider, KeyProvider> = {
  anthropic: "openai",
  openai: "anthropic",
};

function serverReason(error: unknown): string | null {
  if (!(error instanceof ConvexError)) return null;
  const data = error.data as { reason?: unknown };
  return typeof data?.reason === "string" ? data.reason : null;
}

// A labelled native radio drawn as a square choice, with a visible focus ring.
const choiceClass = cn(
  "flex items-center text-sm cursor-pointer border",
  "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2",
  "has-[:focus-visible]:outline-black dark:has-[:focus-visible]:outline-white",
  "has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50",
);

function SquareMark({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex h-3.5 w-3.5 shrink-0 items-center justify-center border",
        "border-black dark:border-white",
      )}
    >
      {checked && <span className="h-2 w-2 bg-black dark:bg-white" />}
    </span>
  );
}

const buttonClass = cn(
  "px-4 py-2 text-sm",
  "border border-gray-300 dark:border-gray-700",
  "hover:bg-gray-100 dark:hover:bg-gray-800",
  "disabled:opacity-50 disabled:cursor-not-allowed",
);
const primaryButtonClass = cn(
  "px-4 py-2 text-sm",
  "bg-black text-white hover:bg-gray-800",
  "dark:bg-white dark:text-black dark:hover:bg-gray-200",
  "disabled:opacity-50 disabled:cursor-not-allowed",
);

function ProviderKeyCard({
  provider,
  saved,
  models,
  draft,
  onDraftChange,
  editing,
  onEditingChange,
  onMoveToOther,
  role,
  periodCost,
}: {
  provider: KeyProvider;
  saved: SavedKey | undefined;
  models: ModelOption[] | undefined;
  role: KeyRole | undefined;
  // What this key's provider billed this period, formatted; unset when nothing.
  periodCost: string | undefined;
  draft: string;
  onDraftChange: (value: string) => void;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  // Set when the other card is empty and can take a mis-pasted key.
  onMoveToOther?: () => void;
}) {
  const { t } = useTranslation();
  const relativeTime = useRelativeTime();
  const saveKey = useAction(api.providerApiKeys.action.save);
  const revalidateKey = useAction(api.providerApiKeys.action.revalidate);
  const removeKey = useMutation(api.providerApiKeys.mutation.remove);
  const setModel = useAction(api.providerApiKeys.action.setModel);
  const [modelSaved, setModelSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { label, placeholder, pattern, keysUrl } = PROVIDERS[provider];
  const otherLabel = PROVIDERS[OTHER[provider]].label;

  const trimmed = draft.trim();
  const looksLikeOther =
    trimmed.length > 0 && PROVIDERS[OTHER[provider]].pattern.test(trimmed);
  const valid = pattern.test(trimmed);

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
          other: otherLabel,
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
      case "unknown_model":
        return t("profile.providerKeys.errors.unknownModel");
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
    if (!valid) return;
    if (await run(() => saveKey({ provider, apiKey: trimmed }))) {
      onDraftChange("");
      onEditingChange(false);
    }
  };

  const status = !saved
    ? "notSet"
    : saved.serviceUnavailable
      ? "serviceUnavailable"
      : !saved.readable
        ? "unreadable"
        : saved.status;
  const healthy = status === "active";
  const showForm = !saved || editing;
  const chosen = models?.find((m) => m.modelId === saved?.modelId);
  const chooseModel = async (modelId: string, effort?: string) => {
    setModelSaved(false);
    if (await run(() => setModel({ provider, modelId, effort })))
      setModelSaved(true);
  };

  return (
    <div
      className={cn(
        "p-6 flex flex-col gap-4",
        "border",
        saved && !healthy
          ? "border-black dark:border-white"
          : "border-gray-200 dark:border-gray-800",
      )}
    >
      <div className={cn("flex items-center justify-between gap-4")}>
        <div className={cn("flex items-center gap-2")}>
          <KeyRound size={18} className="shrink-0" />
          <h3 className={cn("text-lg font-bold text-black", "dark:text-white")}>
            {label}
          </h3>
          {role && (
            <span
              className={cn(
                "px-2 py-0.5 text-xs border border-gray-300 text-gray-600",
                "dark:border-gray-700 dark:text-gray-400",
              )}
            >
              {t(`profile.providerKeys.role.${role}`)}
            </span>
          )}
        </div>
        <span
          className={cn(
            "px-2 py-0.5 text-xs font-medium border",
            healthy
              ? "border-black bg-black text-white dark:border-white dark:bg-white dark:text-black"
              : saved
                ? "border-black text-black dark:border-white dark:text-white"
                : "border-gray-300 text-gray-500 dark:border-gray-700",
          )}
        >
          {t(`profile.providerKeys.status.${status}`)}
        </span>
      </div>

      {saved && (
        <div
          className={cn(
            "flex flex-wrap items-baseline gap-x-3 text-sm text-gray-600",
            "dark:text-gray-400",
          )}
        >
          <span className="font-mono text-black dark:text-white">
            ••••{saved.last4}
          </span>
          <span>
            {t("profile.providerKeys.checked", {
              time: relativeTime(saved.lastValidatedAt),
            })}
          </span>
        </div>
      )}

      {saved?.readable && !saved.serviceUnavailable && models && !showForm && (
        <div className={cn("flex flex-col gap-3")}>
          <fieldset disabled={busy} className={cn("flex flex-col gap-2")}>
            <legend className={cn("mb-2 text-sm font-medium")}>
              {t("profile.providerKeys.modelLabel")}
            </legend>
            {models.map((model, index) => {
              const selected = model.modelId === saved.modelId;
              return (
                <label
                  key={model.modelId}
                  className={cn(
                    choiceClass,
                    "gap-3 px-3 py-2",
                    selected
                      ? "border-black dark:border-white"
                      : "border-gray-200 hover:border-gray-400 dark:border-gray-800 dark:hover:border-gray-600",
                  )}
                >
                  <input
                    type="radio"
                    name={`model-${provider}`}
                    value={model.modelId}
                    checked={selected}
                    onChange={() => void chooseModel(model.modelId)}
                    className="sr-only"
                  />
                  <SquareMark checked={selected} />
                  <span className={cn("flex flex-1 flex-col")}>
                    <span className="font-medium">
                      {model.name}
                      {index === 0 && (
                        <span
                          className={cn(
                            "ml-2 text-xs font-normal text-gray-500",
                          )}
                        >
                          {t("profile.providerKeys.defaultModel")}
                        </span>
                      )}
                    </span>
                    <span
                      className={cn(
                        "text-xs text-gray-600 tabular-nums",
                        "dark:text-gray-400",
                      )}
                    >
                      {t("profile.providerKeys.price", {
                        input: formatPerMillion(model.inputPer1M),
                        output: formatPerMillion(model.outputPer1M),
                      })}
                      {model.longContextInputTokens !== undefined &&
                        ` · ${t("profile.providerKeys.longContextPrice", {
                          tokens: formatTokens(model.longContextInputTokens),
                        })}`}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>
          <fieldset disabled={busy || !chosen} className={cn("flex flex-col")}>
            <legend className={cn("mb-2 text-sm font-medium")}>
              {t("profile.providerKeys.effortLabel")}
            </legend>
            <div className={cn("flex")}>
              {(chosen?.efforts ?? [saved.effort]).map((effort) => {
                const selected = effort === saved.effort;
                return (
                  <label
                    key={effort}
                    className={cn(
                      choiceClass,
                      "flex-1 justify-center px-3 py-1.5 -ml-px first:ml-0",
                      selected
                        ? "relative border-black bg-black text-white dark:border-white dark:bg-white dark:text-black"
                        : "border-gray-300 hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-800",
                    )}
                  >
                    <input
                      type="radio"
                      name={`effort-${provider}`}
                      value={effort}
                      checked={selected}
                      onChange={() => void chooseModel(saved.modelId, effort)}
                      className="sr-only"
                    />
                    {t(`profile.providerKeys.efforts.${effort}`)}
                  </label>
                );
              })}
            </div>
          </fieldset>
          <p className={cn("text-xs text-gray-600 dark:text-gray-400")}>
            {t("profile.providerKeys.modelHint", { provider: label })}{" "}
            {t("profile.providerKeys.effortHint")}
            {modelSaved && ` ${t("profile.providerKeys.modelSaved")}`}
          </p>
          {periodCost && (
            <p className={cn("text-sm text-gray-700 dark:text-gray-300")}>
              {t("profile.providerKeys.thisPeriod", {
                provider: label,
                cost: periodCost,
              })}
            </p>
          )}
        </div>
      )}

      {showForm ? (
        <form onSubmit={handleSave} className={cn("flex flex-col gap-2")}>
          <div className={cn("flex items-center justify-between gap-2")}>
            <label
              htmlFor={`provider-key-${provider}`}
              className={cn("text-sm font-medium")}
            >
              {t("profile.providerKeys.inputLabel", { provider: label })}
            </label>
            <a
              href={keysUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                "inline-flex items-center gap-1 text-sm underline",
                "hover:no-underline",
              )}
            >
              {t("profile.providerKeys.getKey")}
              <ExternalLink size={14} aria-hidden="true" />
            </a>
          </div>
          <input
            id={`provider-key-${provider}`}
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={draft}
            onChange={(event) => {
              onDraftChange(event.target.value);
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
          {looksLikeOther && (
            <div
              className={cn(
                "flex flex-wrap items-center justify-between gap-2 p-3 text-sm",
                "border border-black dark:border-white",
              )}
            >
              <span>
                {t("profile.providerKeys.errors.wrongProvider", {
                  other: otherLabel,
                })}
              </span>
              {onMoveToOther && (
                <button
                  type="button"
                  onClick={onMoveToOther}
                  className={primaryButtonClass}
                >
                  {t("profile.providerKeys.moveTo", { provider: otherLabel })}
                </button>
              )}
            </div>
          )}
          <div className={cn("flex items-center gap-2")}>
            <button
              type="submit"
              disabled={busy || !valid}
              className={primaryButtonClass}
            >
              {saved
                ? t("profile.providerKeys.replace")
                : t("profile.providerKeys.save")}
            </button>
            {saved && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  onEditingChange(false);
                  onDraftChange("");
                  setError(null);
                }}
                className={buttonClass}
              >
                {t("common.cancel")}
              </button>
            )}
            {busy && <LoadingIndicator />}
          </div>
        </form>
      ) : confirmingRemove ? (
        <div
          className={cn(
            "flex flex-wrap items-center gap-2 p-3 text-sm",
            "border border-black dark:border-white",
          )}
        >
          <span className="flex-1">
            {t("profile.providerKeys.confirmRemove", { provider: label })}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              if (await run(() => removeKey({ provider })))
                setConfirmingRemove(false);
            }}
            className={primaryButtonClass}
          >
            {t("profile.providerKeys.remove")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirmingRemove(false)}
            className={buttonClass}
          >
            {t("common.cancel")}
          </button>
          {busy && <LoadingIndicator />}
        </div>
      ) : (
        <div className={cn("flex flex-wrap items-center gap-2")}>
          <button
            type="button"
            onClick={() => onEditingChange(true)}
            disabled={busy}
            className={buttonClass}
          >
            {t("profile.providerKeys.replace")}
          </button>
          {saved?.readable && !saved.serviceUnavailable && (
            <button
              type="button"
              onClick={() => void run(() => revalidateKey({ provider }))}
              disabled={busy}
              className={buttonClass}
            >
              {t("profile.providerKeys.checkAgain")}
            </button>
          )}
          <button
            type="button"
            onClick={() => setConfirmingRemove(true)}
            disabled={busy}
            className={buttonClass}
          >
            {t("profile.providerKeys.remove")}
          </button>
          {busy && <LoadingIndicator />}
        </div>
      )}

      {error && (
        <div
          role="alert"
          className={cn(
            "flex items-start gap-2 p-3 text-sm",
            "border border-black text-black",
            "dark:border-white dark:text-white",
          )}
        >
          <AlertTriangle
            size={16}
            className="mt-0.5 shrink-0"
            aria-hidden="true"
          />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}

export function ProviderKeysSection() {
  const { t } = useTranslation();
  const keys = useQuery(api.providerApiKeys.query.list);
  const models = useQuery(api.providerApiKeys.query.models);
  const usage = useQuery(api.tokenUsage.query.getUserKeyUsage);
  const [drafts, setDrafts] = useState<Record<KeyProvider, string>>({
    anthropic: "",
    openai: "",
  });
  const [editing, setEditing] = useState<Record<KeyProvider, boolean>>({
    anthropic: false,
    openai: false,
  });

  const savedKey = (provider: KeyProvider) =>
    keys?.find((key) => key.provider === provider);
  const { activeKey, backupKey } = summarizeProviderKeys(keys);
  const roleOf = (provider: KeyProvider): KeyRole | undefined =>
    activeKey?.provider === provider
      ? "primary"
      : backupKey?.provider === provider
        ? "backup"
        : undefined;
  const periodCostOf = (provider: KeyProvider) => {
    const cents = usage?.models
      .filter((model) => model.provider === provider)
      .reduce((sum, model) => sum + model.costCents, 0);
    if (!usage || !cents) return undefined;
    return `${formatUsdCents(cents)}${usage.isPartial ? "+" : ""}`;
  };

  // "Add your own key" links land here from other pages.
  const location = useLocation();
  const loaded = keys !== undefined;
  useEffect(() => {
    if (loaded && location.hash === `#${PROVIDER_KEYS_ANCHOR}`)
      document
        .getElementById(PROVIDER_KEYS_ANCHOR)
        ?.scrollIntoView({ block: "start" });
  }, [loaded, location.hash]);

  // Move a mis-pasted key to the other card's input; nothing is saved.
  const moveDraft = (from: KeyProvider) => {
    const to = OTHER[from];
    setDrafts((current) => ({ ...current, [from]: "", [to]: current[from] }));
    setEditing((current) => ({ ...current, [to]: true }));
    window.setTimeout(
      () => document.getElementById(`provider-key-${to}`)?.focus(),
      0,
    );
  };

  return (
    <section id={PROVIDER_KEYS_ANCHOR} className={cn("mb-8 scroll-mt-8")}>
      <h2
        className={cn(
          "text-2xl font-brand font-bold text-black mb-2",
          "dark:text-white",
        )}
      >
        {t("profile.providerKeys.title")}
      </h2>
      <p className={cn("text-gray-700 mb-3", "dark:text-gray-300")}>
        {t("profile.providerKeys.valueProp")}
      </p>
      <ul
        className={cn(
          "mb-6 space-y-1 text-sm text-gray-600",
          "dark:text-gray-400",
        )}
      >
        {(["order", "noFallback", "encrypted"] as const).map((bullet) => (
          <li key={bullet} className={cn("flex items-start gap-2")}>
            <Check size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>{t(`profile.providerKeys.bullets.${bullet}`)}</span>
          </li>
        ))}
      </ul>
      {keys === undefined ? (
        <LoadingIndicator />
      ) : (
        <div className={cn("grid gap-4 md:grid-cols-2")}>
          {(["anthropic", "openai"] as const).map((provider) => {
            const other = OTHER[provider];
            const otherIsEmpty =
              !savedKey(other) && drafts[other].trim() === "";
            return (
              <ProviderKeyCard
                key={provider}
                provider={provider}
                saved={savedKey(provider)}
                models={models?.[provider]}
                role={roleOf(provider)}
                periodCost={periodCostOf(provider)}
                draft={drafts[provider]}
                onDraftChange={(value) =>
                  setDrafts((current) => ({ ...current, [provider]: value }))
                }
                editing={editing[provider]}
                onEditingChange={(value) =>
                  setEditing((current) => ({ ...current, [provider]: value }))
                }
                onMoveToOther={
                  otherIsEmpty ? () => moveDraft(provider) : undefined
                }
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
