import { describe, expect, it } from "vitest";
import { summarizeProviderKeys } from "../../src/utils/providerKeyState";

const anthropic = {
  provider: "anthropic" as const,
  status: "active" as const,
  readable: true,
  serviceUnavailable: false,
};
const openai = { ...anthropic, provider: "openai" as const };

describe("provider key state for the UI", () => {
  it("never reports a usable key during a server key outage", () => {
    const keys = [{ ...anthropic, serviceUnavailable: true }];
    expect(summarizeProviderKeys(keys)).toEqual({
      keyChecksUnavailable: true,
      activeKey: undefined,
      backupKey: undefined,
    });
    expect(summarizeProviderKeys([anthropic])).toEqual({
      keyChecksUnavailable: false,
      activeKey: anthropic,
      backupKey: undefined,
    });
    expect(summarizeProviderKeys(undefined)).toEqual({
      keyChecksUnavailable: false,
      activeKey: undefined,
      backupKey: undefined,
    });
  });

  it("runs Claude first with a working OpenAI key as its backup", () => {
    expect(summarizeProviderKeys([openai, anthropic])).toMatchObject({
      activeKey: anthropic,
      backupKey: openai,
    });
    const rejected = { ...anthropic, status: "invalid" as const };
    expect(summarizeProviderKeys([rejected, openai])).toMatchObject({
      activeKey: openai,
      backupKey: undefined,
    });
  });
});
