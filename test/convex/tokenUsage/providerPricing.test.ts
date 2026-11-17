import { describe, expect, it } from "vitest";

import {
  getChatModel,
  RESERVATION_QUOTA_WEIGHT,
} from "../../../convex/_ai/config";
import { calculateChatCost } from "../../../convex/tokenUsage/internalMutation";

function getModelPricing(model: string, provider: string) {
  const { inputPer1M, outputPer1M } = getChatModel(model, provider);
  return { inputPer1M, outputPer1M };
}

describe("provider-aware chat pricing", () => {
  it("uses the configured paid AI 2.5 Flash pricing", () => {
    expect(getModelPricing("gemini-2.5-flash", "google")).toEqual({
      inputPer1M: 0.3,
      outputPer1M: 2.5,
    });
  });

  it("fails closed for providers without an explicit price table", () => {
    expect(() =>
      calculateChatCost(1_000, 1_000, 0.18, "grok-build-0.1", "xai"),
    ).toThrow("Unsupported chat pricing: xai/grok-build-0.1");
  });

  it("fails closed for unknown or preview AI models", () => {
    expect(() => getModelPricing("gemini-future", "google")).toThrow(
      "Unsupported chat pricing",
    );
    expect(() => getModelPricing("gemini-2.5-flash-preview", "google")).toThrow(
      "Unsupported chat pricing",
    );
  });

  it("preserves fractional cents for small requests", () => {
    const costs = calculateChatCost(
      1_000,
      500,
      0.25,
      "gemini-2.5-flash",
      "google",
    );

    expect(costs.inputCostCents).toBeCloseTo(0.03);
    expect(costs.outputCostCents).toBeCloseTo(0.125);
    expect(costs.baseCostCents).toBeCloseTo(0.155);
    expect(costs.serviceFeeCents).toBeCloseTo(0.03875);
    expect(costs.totalCostCents).toBeCloseTo(0.19375);
  });
});

describe("Claude and OpenAI generation pricing", () => {
  it("prices both current providers and rejects cross-provider model attribution", () => {
    expect(getModelPricing("claude-opus-5-5", "anthropic")).toEqual({
      inputPer1M: 4,
      outputPer1M: 20,
    });
    expect(getModelPricing("claude-sonnet-5-5", "anthropic")).toEqual({
      inputPer1M: 2,
      outputPer1M: 10,
    });
    expect(getModelPricing("gpt-6.1-sol", "openai")).toEqual({
      inputPer1M: 2,
      outputPer1M: 10,
    });
    expect(() => getModelPricing("claude-sonnet-5-5", "openai")).toThrow();
    expect(() => getModelPricing("toString", "anthropic")).toThrow(
      "Unsupported chat pricing",
    );
  });
  it("weighs Opus twice and reserves at the highest routed weight", () => {
    expect(getChatModel("claude-opus-5-5", "anthropic").quotaWeight).toBe(2);
    expect(getChatModel("gpt-6.1-sol", "openai").quotaWeight).toBe(1);
    expect(RESERVATION_QUOTA_WEIGHT).toBe(2);
  });
  it("does not apply long-context pricing to Claude", () => {
    expect(
      calculateChatCost(500_000, 0, 0, "claude-opus-5-5", "anthropic")
        .baseCostCents,
    ).toBeCloseTo(200);
  });
  it("uses Sol long-context pricing only above 272K input tokens", () => {
    expect(
      calculateChatCost(272_000, 100, 0, "gpt-6.1-sol", "openai").baseCostCents,
    ).toBeCloseTo(54.5);
    expect(
      calculateChatCost(272_001, 100, 0, "gpt-6.1-sol", "openai").baseCostCents,
    ).toBeCloseTo(108.9504);
  });
});
