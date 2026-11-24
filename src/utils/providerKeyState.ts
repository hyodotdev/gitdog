type KeyProvider = "anthropic" | "openai";

type ListedKey = {
  provider: KeyProvider;
  status: "active" | "invalid" | "out_of_credit";
  readable: boolean;
  serviceUnavailable?: boolean;
};

/**
 * How saved provider keys stand for the UI. During a server key outage keys
 * exist but cannot be used, which is neither "your own key" nor "add a key".
 * Reviews run on the first working key in the owner's order (Claude first
 * unless they chose OpenAI); a working key behind it is the backup that
 * takes over when the first is rejected or runs out of credit.
 */
export function summarizeProviderKeys<Key extends ListedKey>(
  keys: Key[] | undefined,
  primaryProvider: KeyProvider,
): {
  keyChecksUnavailable: boolean;
  activeKey: Key | undefined;
  backupKey: Key | undefined;
} {
  const keyChecksUnavailable =
    keys?.some((key) => key.serviceUnavailable) ?? false;
  const working = keyChecksUnavailable
    ? []
    : (keys ?? []).filter((key) => key.readable && key.status === "active");
  const first = working.find((key) => key.provider === primaryProvider);
  const second = working.find((key) => key.provider !== primaryProvider);
  return {
    keyChecksUnavailable,
    activeKey: first ?? second,
    backupKey: first ? second : undefined,
  };
}
