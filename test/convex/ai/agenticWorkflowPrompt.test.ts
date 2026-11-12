import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflowSource = readFileSync(
  join(process.cwd(), "convex/_ai/issueAnalysis/agenticWorkflow.ts"),
  "utf8",
);

const ticketActionsSource = readFileSync(
  join(process.cwd(), "convex/ticketActions/internalAction.ts"),
  "utf8",
);

describe("agentic issue analysis prompt", (): void => {
  it("keeps existing feature requests in context and verifies bridge contracts", (): void => {
    const featureRequestSection = workflowSource.match(
      /## Feature Request \/ Missing Support Issues \(CRITICAL\)[\s\S]*?(?=\n## Bug Reports)/,
    )?.[0];

    expect(featureRequestSection).toBeDefined();
    expect(featureRequestSection).toContain(
      "NEVER tell them to file, open, create, or submit the same issue again",
    );
    expect(featureRequestSection).toContain(
      "trace the public contract end to end",
    );
    expect(featureRequestSection).toContain(
      "do NOT replace it with \\`void\\`",
    );
    expect(featureRequestSection).toContain("activity: any");
    expect(featureRequestSection).toContain("purchase confirmation");
    expect(workflowSource).not.toContain(
      "or opening this as a feature request",
    );
  });

  it("requires cross-package bridge verification before dismissing monorepo bugs", (): void => {
    const crossPackageSection = workflowSource.match(
      /### ⛔ CROSS-PACKAGE BUG VERIFICATION \(CRITICAL\)[\s\S]*?(?=\n---)/,
    )?.[0];

    expect(crossPackageSection).toBeDefined();
    expect(crossPackageSection?.replaceAll("\\`", "'")).toMatchInlineSnapshot(`
        "### ⛔ CROSS-PACKAGE BUG VERIFICATION (CRITICAL)
        For monorepo bug reports involving an SDK, adapter, bridge, wrapper, generated type, or platform variant, a lower-level implementation being correct does NOT prove the reported package is correct.

        Before saying "the bug does not exist", "not reproducible", or "already fixed":
        1. Identify every package/platform named or implied by the issue title/body, such as 'expo-iap', 'react-native-iap', 'flutter_inapp_purchase', 'kmp-iap', Android, iOS, Play, Horizon, bridge, adapter, or wrapper.
        2. Read the package-specific implementation for that named surface. If the issue says 'expo-iap', you MUST inspect 'libraries/expo-iap'; reading only 'packages/google' is insufficient.
        3. Follow the data path across layers: core/native result → wrapper/adapter → JSON/JS/Dart/Kotlin-facing result. Bugs often exist in the bridge mapping even when the core implementation is correct.
        4. Search for exact result/union/type names across the repo and compare every branch that handles the same union. Missing one union branch in an adapter is still a real bug.
        5. If you only verified one layer or one platform, explicitly say that your check is partial, lower confidence, and do NOT recommend closing the issue.

        Specific OpenIAP example:
        - For 'fetchProducts(type: all)', search/read 'fetchProducts', 'ProductQueryType.All', 'FetchProductsResultAll', and 'ProductOrSubscription' across both 'packages/' and 'libraries/'.
        - Verify framework bridge mappings such as Expo/Flutter/KMP/RN/Godot/MAUI, not just 'packages/google' Play core.
        - If 'packages/google' returns 'FetchProductsResultAll' correctly but a framework bridge drops that union variant, the issue is valid.
        "
      `);
  });

  it("includes OpenIAP IAPKit RTDN webhook guardrails", (): void => {
    const rtdnSection = workflowSource.match(
      /### ⛔ OPENIAP \/ IAPKIT RTDN WEBHOOK CLAIMS[\s\S]*?(?=\n\n###)/,
    )?.[0];

    expect(rtdnSection).toBeDefined();
    expect(rtdnSection).toContain("packages/docs/src/pages/docs/webhooks.tsx");
    expect(rtdnSection).toContain("packages/kit/server/api/v1/webhooks.ts");
    expect(rtdnSection).toContain("POST /v1/webhooks/{apiKey}");
    expect(rtdnSection).toContain("/v1/webhooks/google/{apiKey}");
    expect(rtdnSection).toContain("Google Cloud project ID");
    expect(rtdnSection).toContain(
      "google-play-developer-notifications@system.gserviceaccount.com",
    );
  });

  it("validates follow-up topic drift against the latest comment", (): void => {
    const followUpCall = ticketActionsSource.match(
      /const analysisResult = await analyzeIssueWithTools\([\s\S]*?validationFocus: latestUserComment\.content,[\s\S]*?\);/,
    )?.[0];
    const workflowValidationCall = workflowSource.match(
      /validateAiResponse\([\s\S]*?issueBody: issue\.body,[\s\S]*?issueTitle: issue\.title,[\s\S]*?topicFocus,[\s\S]*?\);/,
    )?.[0];

    expect(followUpCall).toBeDefined();
    expect(workflowValidationCall).toBeDefined();
    expect(workflowSource).toContain("cleanValidationTopicFocus");
  });
});
