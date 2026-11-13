type ListedKey = {
  provider: "anthropic" | "openai";
  status: "active" | "invalid" | "out_of_credit";
  readable: boolean;
  serviceUnavailable?: boolean;
};

/**
 * How saved provider keys stand for the UI. During a server key outage keys
 * exist but cannot be used, which is neither "your own key" nor "add a key".
 */
export function summarizeProviderKeys<Key extends ListedKey>(
  keys: Key[] | undefined,
): { keyChecksUnavailable: boolean; activeKey: Key | undefined } {
  const keyChecksUnavailable =
    keys?.some((key) => key.serviceUnavailable) ?? false;
  return {
    keyChecksUnavailable,
    activeKey: keyChecksUnavailable
      ? undefined
      : keys?.find((key) => key.readable && key.status === "active"),
  };
}
