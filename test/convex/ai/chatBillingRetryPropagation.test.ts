import { describe, expect, it, vi } from "vitest";

import type { Id } from "../../../convex/_generated/dataModel";
import type { ActionCtx } from "../../../convex/_generated/server";
import { ChatBillingError } from "../../../convex/_ai/chatBilling";
import {
  PROVIDER_START_RETRY_TIMEOUT_MS,
  getProviderStartRetryWindow,
} from "../../../convex/_ai/chatRecovery";
import { analyzeIssueWithTools } from "../../../convex/_ai/issueAnalysis/agenticWorkflow";
import type { AiProvider } from "../../../convex/_ai/model";
import { Workflow } from "../../../convex/_ai/workflow";

const aiProvider: AiProvider = {
  name: "Test provider",
  modelId: "test-model",
  providerId: "google",
  chat: vi.fn(),
};

function createReadyActionContext(): ActionCtx {
  const runQuery = vi.fn(async (_query, args: Record<string, unknown>) => {
    if ("expectedIndexVersion" in args) {
      return { indexVersion: 7 };
    }
    return [];
  });
  return { runQuery, runAction: vi.fn() } as unknown as ActionCtx;
}

describe("AI chat billing retry propagation", () => {
  it("bounds pre-provider retries with a deterministic one-hour watchdog", () => {
    const startedAt = 1_000;
    expect(
      getProviderStartRetryWindow(
        startedAt,
        startedAt + PROVIDER_START_RETRY_TIMEOUT_MS - 1,
      ),
    ).toEqual({ startedAt });
    expect(
      getProviderStartRetryWindow(
        startedAt,
        startedAt + PROVIDER_START_RETRY_TIMEOUT_MS,
      ),
    ).toEqual({
      startedAt,
      timeoutReason: "AI provider could not start durably within one hour",
    });
  });

  it("rethrows a durable billing error from a generic workflow step", async () => {
    const error = new ChatBillingError(
      "Another provider request is active",
      "provider_attempt_in_progress",
    );
    const workflow = new Workflow<string, string>().addStep(
      "provider",
      async () => {
        throw error;
      },
    );

    await expect(
      workflow.execute("input", { aiProvider, metadata: {} }),
    ).rejects.toBe(error);
  });

  it("keeps terminal billing errors in the normal workflow failure result", async () => {
    const workflow = new Workflow<string, string>().addStep(
      "provider",
      async () => {
        throw new ChatBillingError(
          "Provider usage requires reconciliation",
          "unresolved_provider_usage",
        );
      },
    );

    await expect(
      workflow.execute("input", { aiProvider, metadata: {} }),
    ).resolves.toMatchObject({
      success: false,
      errors: ["provider: Provider usage requires reconciliation"],
    });
  });

  it("rethrows a durable billing error from the agentic workflow", async () => {
    const error = new ChatBillingError(
      "Provider start was not durably recorded",
      "provider_start_failed",
    );
    const provider: AiProvider = {
      ...aiProvider,
      chat: vi.fn(async () => {
        throw error;
      }),
    };

    await expect(
      analyzeIssueWithTools(
        createReadyActionContext(),
        "repository-id" as Id<"repositories">,
        { title: "Question", body: "Body" },
        provider,
        { indexVersion: 7 },
      ),
    ).rejects.toBe(error);
  });

  it("keeps ambiguous usage terminal in the agentic workflow", async () => {
    const provider: AiProvider = {
      ...aiProvider,
      chat: vi.fn(async () => {
        throw new ChatBillingError(
          "Provider usage requires reconciliation",
          "unresolved_provider_usage",
        );
      }),
    };

    await expect(
      analyzeIssueWithTools(
        createReadyActionContext(),
        "repository-id" as Id<"repositories">,
        { title: "Question", body: "Body" },
        provider,
        { indexVersion: 7 },
      ),
    ).resolves.toMatchObject({
      success: false,
      errors: ["Provider usage requires reconciliation"],
    });
  });
});
