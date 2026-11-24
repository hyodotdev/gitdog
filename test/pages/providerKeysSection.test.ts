import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { getFunctionName } from "convex/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const queryResults = new Map<string, unknown>();

vi.mock("convex/react", () => ({
  useQuery: (ref: Parameters<typeof getFunctionName>[0]) =>
    queryResults.get(getFunctionName(ref)),
  useMutation: () => Object.assign(vi.fn(), { withOptimisticUpdate: vi.fn() }),
  useAction: () => vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) =>
      values ? `${key}(${Object.values(values).join(",")})` : key,
    i18n: { language: "en" },
  }),
}));

const key = (provider: "anthropic" | "openai") => ({
  provider,
  last4: "abcd",
  status: "active",
  readable: true,
  serviceUnavailable: false,
  lastValidatedAt: 0,
  lastErrorCode: null,
  modelId: provider === "anthropic" ? "claude-opus-5-5" : "gpt-6.1-sol",
  name: provider,
  effort: "medium",
  efforts: ["low", "medium", "high"],
  defaultEffort: "medium",
  inputPer1M: 1,
  outputPer1M: 1,
  createdAt: 0,
  updatedAt: 0,
});

let ProviderKeysSection: typeof import("../../src/pages/profile/ProviderKeysSection").ProviderKeysSection;

beforeAll(async () => {
  ({ ProviderKeysSection } =
    await import("../../src/pages/profile/ProviderKeysSection"));
});

function render(): string {
  return renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(ProviderKeysSection)),
  );
}

describe("provider key order on the profile page", () => {
  beforeEach(() => {
    queryResults.clear();
    queryResults.set("providerApiKeys/query:models", {
      anthropic: [],
      openai: [],
    });
    queryResults.set("tokenUsage/query:getUserKeyUsage", null);
  });

  it("asks which key runs first only when both keys are saved", () => {
    queryResults.set("providerApiKeys/query:list", [key("anthropic")]);
    queryResults.set("providerApiKeys/query:priority", {
      primaryProvider: "anthropic",
    });
    expect(render()).not.toContain("profile.providerKeys.order.label");

    queryResults.set("providerApiKeys/query:list", [
      key("anthropic"),
      key("openai"),
    ]);
    const html = render();
    expect(html).toContain("profile.providerKeys.order.label");
    expect(html).toMatch(/checked="" value="anthropic"/);
  });

  it("marks the owner's choice and the matching roles", () => {
    queryResults.set("providerApiKeys/query:list", [
      key("anthropic"),
      key("openai"),
    ]);
    queryResults.set("providerApiKeys/query:priority", {
      primaryProvider: "openai",
    });
    const html = render();
    expect(html).toMatch(/checked="" value="openai"/);
    expect(html).not.toMatch(/checked="" value="anthropic"/);
    // OpenAI's card comes second and now runs reviews; Claude is the backup.
    const roles = [...html.matchAll(/profile\.providerKeys\.role\.(\w+)/g)].map(
      (match) => match[1],
    );
    expect(roles).toEqual(["backup", "primary"]);
  });
});
