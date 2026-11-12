import { describe, expect, it } from "vitest";
import { summarizeProviderKeys } from "../../src/utils/providerKeyState";

describe("provider key state for the UI", () => {
  it("never reports a usable key during a server key outage", () => {
    const keys = [
      {
        provider: "anthropic" as const,
        status: "active" as const,
        readable: true,
        serviceUnavailable: true,
      },
    ];
    expect(summarizeProviderKeys(keys)).toEqual({
      keyChecksUnavailable: true,
      activeKey: undefined,
    });
    const healthy = { ...keys[0], serviceUnavailable: false };
    expect(summarizeProviderKeys([healthy])).toEqual({
      keyChecksUnavailable: false,
      activeKey: healthy,
    });
    expect(summarizeProviderKeys(undefined)).toEqual({
      keyChecksUnavailable: false,
      activeKey: undefined,
    });
  });
});
