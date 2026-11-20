type ListedKey = {
  provider: "anthropic" | "openai";
  status: "active" | "invalid" | "out_of_credit";
  readable: boolean;
  serviceUnavailable?: boolean;
};

/**
 * How saved provider keys stand for the UI. During a server key outage keys
 * exist but cannot be used, which is neither "your own key" nor "add a key".
 * Reviews run on the first working key, Claude before OpenAI; a working
 * OpenAI key behind it is the backup that takes over when Claude runs out
 * of credit.
 */
export function summarizeProviderKeys<Key extends ListedKey>(
  keys: Key[] | undefined,
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
  const activeKey =
    working.find((key) => key.provider === "anthropic") ??
    working.find((key) => key.provider === "openai");
  return {
    keyChecksUnavailable,
    activeKey,
    backupKey:
      activeKey?.provider === "anthropic"
        ? working.find((key) => key.provider === "openai")
        : undefined,
  };
}
