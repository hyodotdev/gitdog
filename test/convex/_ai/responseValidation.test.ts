import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { validateAiResponse } from "../../../convex/_ai/responseValidation";

describe("validateAiResponse", () => {
  it("blocks internal knowledge path leaks", () => {
    const response = `
The deployment workflow described in \`knowledge/internal/06-git-deployment.md\` runs GitHub Actions for each package release.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.leakedInternalPaths).toContain("knowledge/");
    expect(validation.issues[0]).toContain("Internal file paths leaked");
  });

  it("blocks internal compiled context path leaks", () => {
    const response = `
The release notes are summarized in \`knowledge/_claude-context/recent.md\`.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.leakedInternalPaths).toContain("knowledge/");
  });

  it("blocks internal knowledge path leaks without trailing slash", () => {
    const response = `
The release process is documented in \`knowledge/internal\`.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.leakedInternalPaths).toContain("knowledge/");
  });

  it("blocks any knowledge directory path leak", () => {
    const response = `
The context is summarized in \`knowledge/public/context.md\`.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.leakedInternalPaths).toContain("knowledge/");
  });

  it("blocks high-risk external dependency overclaims", () => {
    const response = `
Root cause: Firebase always emits all cached events every time a connection is established.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.externalOverclaimPatterns[0]).toContain(
      "Firebase always emits",
    );
    expect(validation.issues[0]).toContain(
      "High-risk external dependency overclaim",
    );
  });

  it("allows corrections that mention a previous overclaim", () => {
    const response = `
Do not say Firebase always emits all cached events every time a connection is established. The repository only shows that it subscribes to the event stream.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(true);
    expect(validation.externalOverclaimPatterns).toHaveLength(0);
  });

  it("blocks multi-word universal claims with flexible whitespace", () => {
    const response = `
Firebase each
 time emits cached events.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.externalOverclaimPatterns[0]).toContain("Firebase each");
  });

  it("still blocks overclaims that contain unrelated negation", () => {
    const response = `
Firebase always emits all cached events, not just new events.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.externalOverclaimPatterns[0]).toContain(
      "Firebase always emits",
    );
  });

  it("still blocks overclaims when negation belongs to another claim", () => {
    const response = `
This is not a bug. Stripe always fails during checkout.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.externalOverclaimPatterns[0]).toContain(
      "Stripe always fails",
    );
  });

  it("does not block connection wording without an external dependency claim", () => {
    const response = `
This repository calls connectClient each time a connection is established, then registers local listeners.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(true);
    expect(validation.externalOverclaimPatterns).toHaveLength(0);
  });

  it("does not block repository-scoped implementation claims", () => {
    const response = `
The Android implementation in this repository always returns null for this unsupported method.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(true);
    expect(validation.externalOverclaimPatterns).toHaveLength(0);
  });

  it("blocks external lifecycle overclaims that mention generic code words", () => {
    const response = `
Vercel always runs this function on every request.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.externalOverclaimPatterns[0]).toContain(
      "Vercel always runs",
    );
  });

  it("blocks broad external behavior overclaims", () => {
    const response = `
Firebase always works this way.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.externalOverclaimPatterns[0]).toContain(
      "Firebase always works",
    );
  });

  it("blocks universal dependency claims where the quantifier precedes the dependency", () => {
    const response = `
All Firebase events are returned by the SDK.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.externalOverclaimPatterns[0]).toContain(
      "All Firebase events",
    );
  });

  it("blocks external overclaims when the behavior verb precedes the dependency", () => {
    const response = `
Always works on Firebase.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.externalOverclaimPatterns[0]).toContain(
      "Always works on Firebase",
    );
  });

  it("blocks external overclaims when the universal term follows the behavior verb", () => {
    const response = `
Firebase works always.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.externalOverclaimPatterns[0]).toContain(
      "Firebase works always",
    );
  });

  it("blocks base-form external behavior verbs", () => {
    const initializeValidation = validateAiResponse(
      "Firebase will always initialize the listener.",
      0.9,
    );
    const receiveValidation = validateAiResponse(
      "Stripe should never receive duplicate webhook events.",
      0.9,
    );

    expect(initializeValidation.isValid).toBe(false);
    expect(initializeValidation.externalOverclaimPatterns[0]).toContain(
      "Firebase will always initialize",
    );
    expect(receiveValidation.isValid).toBe(false);
    expect(receiveValidation.externalOverclaimPatterns[0]).toContain(
      "Stripe should never receive",
    );
  });

  it("blocks external overclaims split across sentences in the same paragraph", () => {
    const response = `
I checked Firebase. It always emits all events.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.externalOverclaimPatterns[0]).toContain(
      "I checked Firebase",
    );
  });

  it("treats whitespace-only blank lines as paragraph breaks", () => {
    const response = [
      "Firebase.",
      "  ",
      "It always returns cached local data.",
    ].join("\n");

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(true);
    expect(validation.externalOverclaimPatterns).toHaveLength(0);
  });

  it("truncates external overclaim issue previews while keeping full debug text", () => {
    const tailMarker = "tail-marker";
    const response = `
Firebase always emits cached events ${"x ".repeat(90)}${tailMarker}.
`;

    const validation = validateAiResponse(response, 0.9);
    const overclaimIssue = validation.issues.find((issue) =>
      issue.startsWith("High-risk external dependency overclaim:"),
    );

    expect(validation.isValid).toBe(false);
    expect(overclaimIssue).toBeDefined();
    expect(overclaimIssue).toContain("...");
    expect(overclaimIssue).not.toContain(tailMarker);
    expect(validation.externalOverclaimPatterns[0]).toContain(tailMarker);
  });

  it("does not block unrelated universal wording elsewhere in the same sentence", () => {
    const response = `
Firebase configuration is mentioned here, and this local parser always returns the default value.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(true);
    expect(validation.externalOverclaimPatterns).toHaveLength(0);
  });

  it("allows negated universal wording as a correction guard", () => {
    const response = `
Firebase does not always emit cached events when a connection is established.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(true);
    expect(validation.externalOverclaimPatterns).toHaveLength(0);
  });

  it("does not match short dependency names inside unrelated words", () => {
    const response = `
I was curious whether all cached events are returned, so I checked the repository code.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(true);
    expect(validation.externalOverclaimPatterns).toHaveLength(0);
  });

  it("blocks high-confidence responses that drift away from the issue API", () => {
    const response = `
## Confirmed Bug ✅

I read the relevant code and can confirm this is a real bug.

The restorePurchases(andDangerouslyFinishTransactions: Bool, _: Double) parameter is accepted by the function signature but never used. The fix should finish restored transactions when the flag is true.
`;

    const validation = validateAiResponse(response, 0.92, {
      issueTitle:
        '[iOS] syncIOS() user-cancel surfaces as code "service-error" instead of UserCancelled, defeats isUserCancelledError',
      issueType: "actionable",
    });

    expect(validation.isValid).toBe(false);
    expect(validation.topicDriftPatterns[0]).toContain("syncIOS");
    expect(validation.issues[0]).toContain("Issue topic drift");
  });

  it("allows high-confidence responses that mention the issue API", () => {
    const response = `
## Confirmed Bug ✅

I read syncIOS() and found AppStore.sync() cancel errors are wrapped as service-error instead of UserCancelled.
`;

    const validation = validateAiResponse(response, 0.92, {
      issueTitle:
        '[iOS] syncIOS() user-cancel surfaces as code "service-error" instead of UserCancelled, defeats isUserCancelledError',
      issueType: "actionable",
    });

    expect(validation.isValid).toBe(true);
    expect(validation.topicDriftPatterns).toHaveLength(0);
  });

  it("requires the primary issue API instead of any related identifier", () => {
    const response = `
## Confirmed Bug ✅

I found that UserCancelled is not preserved correctly, but the root cause is in restorePurchases(andDangerouslyFinishTransactions:).
`;

    const validation = validateAiResponse(response, 0.92, {
      issueTitle:
        '[iOS] syncIOS() user-cancel surfaces as code "service-error" instead of UserCancelled, defeats isUserCancelledError',
      issueType: "actionable",
    });

    expect(validation.isValid).toBe(false);
    expect(validation.topicDriftPatterns[0]).toBe(
      "Missing issue topic identifier: syncIOS",
    );
  });

  it("does not apply topic drift checks when confidence is missing", () => {
    const response = `
I found related purchase restoration code that may need maintainer review.
`;

    const validation = validateAiResponse(response, undefined, {
      issueTitle: "syncIOS() user-cancel returns service-error",
      issueType: "actionable",
    });

    expect(validation.isValid).toBe(true);
    expect(validation.topicDriftPatterns).toHaveLength(0);
  });

  it("allows callers to skip topic drift checks for follow-up summaries", () => {
    const response = `
Short version: the cancel path is being wrapped too broadly in the native error mapper.
`;

    const validation = validateAiResponse(response, 0.92, {
      issueTitle: "syncIOS() user-cancel returns service-error",
      issueType: "question",
      skipTopicDrift: true,
    });

    expect(validation.isValid).toBe(true);
    expect(validation.topicDriftPatterns).toHaveLength(0);
  });

  it("uses a follow-up focus for topic drift while retaining original issue context", () => {
    const response = `
BillingClient.showInAppMessages() is not implemented. File a GitHub issue for this feature request.
`;

    const validation = validateAiResponse(response, 0.9, {
      issueTitle: "[Feature] Add BillingClient.showInAppMessages() support",
      issueBody: "Expose the native API through the public wrapper.",
      topicFocus: "Can you verify BillingClient.showInAppMessages()?",
      issueType: "actionable",
    });

    expect(validation.topicDriftPatterns).toHaveLength(0);
    expect(validation.issueContextPatterns).toContain(
      "redundant issue-filing advice for an existing feature request",
    );
  });

  it("matches topic identifiers on token boundaries", () => {
    const response = `
I checked the asynchronous purchase restoration flow and found no direct issue.
`;

    const validation = validateAiResponse(response, 0.92, {
      issueTitle: "AppStore.sync() returns service-error on cancel",
      issueType: "actionable",
    });

    expect(validation.isValid).toBe(false);
    expect(validation.topicDriftPatterns[0]).toContain("AppStore.sync");
    expect(validation.topicDriftPatterns[0]).toContain("sync");
  });

  it("does not let broad class names satisfy dotted API topics", () => {
    const response = `
I checked AppStore purchase restoration behavior and found the issue in a different restore path.
`;

    const validation = validateAiResponse(response, 0.92, {
      issueTitle: "`AppStore.sync()` returns service-error on cancel",
      issueType: "actionable",
    });

    expect(validation.isValid).toBe(false);
    expect(validation.topicDriftPatterns[0]).toContain("AppStore.sync");
  });

  it("blocks suspicious no-op Set.has code snippets", () => {
    const response = `
\`\`\`typescript
const seenTransactionIds = new Set<string>();
if (seenTransactionIds.has(tid)) return;
seenTransactionIds.has(tid);
seenTransactionIds.add(tid);
\`\`\`
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.suspiciousCodePatterns).toContain(
      "standalone Set.has() call",
    );
  });

  it("blocks suspicious no-op Set.has lines with trailing comments", () => {
    const response = `
\`\`\`typescript
seenTransactionIds.has(tid); // check if we saw this transaction
\`\`\`
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.suspiciousCodePatterns).toContain(
      "standalone Set.has() call",
    );
  });

  it("blocks suspicious no-op Set.has lines without semicolons", () => {
    const response = `
\`\`\`typescript
seenTransactionIds.has(tid)
\`\`\`
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.suspiciousCodePatterns).toContain(
      "standalone Set.has() call",
    );
  });

  it("blocks suspicious no-op Set.has calls on object properties", () => {
    const response = `
\`\`\`typescript
this.seenTransactionIds.has(tid);
context.cache.has(key); // check cache
\`\`\`
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.suspiciousCodePatterns).toContain(
      "standalone Set.has() call",
    );
  });

  it("allows corrective explanations that show a no-op Set.has line", () => {
    const response = `
Remove the no-op line:

\`\`\`typescript
seenTransactionIds.has(tid);
\`\`\`

It only checks the set and does not record the transaction id.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(true);
    expect(validation.suspiciousCodePatterns).toHaveLength(0);
  });

  it("allows repository-scoped claims that avoid external lifecycle certainty", () => {
    const response = `
I read \`src/events.ts\` and found that this repository emits purchase updates from both \`requestPurchase\` and the event listener. The code should guard duplicate delivery of the same event id, but distinct event ids should still be treated as separate records.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(true);
    expect(validation.externalOverclaimPatterns).toHaveLength(0);
    expect(validation.suspiciousCodePatterns).toHaveLength(0);
  });

  it("blocks ungrounded overclaims after repository-scoped text in the same paragraph", () => {
    const response = `
I read \`src/events.ts\` and found that this repository emits purchase updates from the local event listener.
Stripe always fails during checkout.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.externalOverclaimPatterns[0]).toContain(
      "Stripe always fails",
    );
  });

  it("blocks high-risk per-request purchase token forwarding guidance", () => {
    const response = `
Pass the purchaseToken from the frontend on every premium request before granting access.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.highRiskTechnicalClaimPatterns).toContain(
      "per-request purchase token forwarding",
    );
  });

  it("blocks high-risk plural purchase token attachment guidance", () => {
    const response = `
Attach the purchase tokens to every request before granting access.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.highRiskTechnicalClaimPatterns).toContain(
      "per-request purchase token forwarding",
    );
  });

  it("blocks inflected and passive per-request purchase token guidance", () => {
    const riskyResponses = [
      "Use the purchaseToken for every request.",
      "The purchase token should be sent on every request.",
      "Attach the purchase-token to every request.",
      "Including the receipt on each backend request is required.",
      "Every API request should include the JWS.",
    ];

    for (const response of riskyResponses) {
      const validation = validateAiResponse(response, 0.9);

      expect(validation.isValid).toBe(false);
      expect(validation.highRiskTechnicalClaimPatterns).toContain(
        "per-request purchase token forwarding",
      );
    }
  });

  it("allows normal auth token request guidance", () => {
    const response = `
Send the auth token on every request.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(true);
    expect(validation.highRiskTechnicalClaimPatterns).toHaveLength(0);
  });

  it("allows corrections that reject per-request purchase token forwarding", () => {
    const responses = [
      "Do not pass the purchaseToken from the frontend on every API request. Verify once, bind it to the user, then check server-side entitlement state.",
      "The purchase token should not be sent on every request.",
    ];

    for (const response of responses) {
      const validation = validateAiResponse(response, 0.9);

      expect(validation.isValid).toBe(true);
      expect(validation.highRiskTechnicalClaimPatterns).toHaveLength(0);
    }
  });

  it("does not let unrelated request negation suppress purchase token forwarding", () => {
    const response = `
Do not use a delay on every request. Pass the purchaseToken from the frontend on every premium request before granting access.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.highRiskTechnicalClaimPatterns).toContain(
      "per-request purchase token forwarding",
    );
  });

  it("does not let a correction suppress a separate high-risk paragraph", () => {
    const response = `
Do not pass the purchaseToken from the frontend on every API request.

Pass the purchaseToken from the frontend on every premium request before granting access.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.highRiskTechnicalClaimPatterns).toContain(
      "per-request purchase token forwarding",
    );
  });

  it("blocks unsupported IAPKit state literal guidance", () => {
    const response = `
The IAPKit verification endpoint returns state values such as "entitled", "expired", and "cancelled".
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.highRiskTechnicalClaimPatterns).toContain(
      "unsupported IAPKit state literals",
    );
  });

  it("blocks unsupported unquoted IAPKit state literal guidance", () => {
    const response = `
The IAPKit verification endpoint returns state values such as entitled, expired, and cancelled.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.highRiskTechnicalClaimPatterns).toContain(
      "unsupported IAPKit state literals",
    );
  });

  it("blocks unsupported plural IAPKit state literal guidance", () => {
    const response = `
The IAPKit verification endpoint returns states such as "entitled", "expired", and "cancelled".
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.highRiskTechnicalClaimPatterns).toContain(
      "unsupported IAPKit state literals",
    );
  });

  it("blocks unsupported spaced IAP Kit state literal guidance", () => {
    const response = `
The IAP Kit verification endpoint returns states such as "entitled" and "expired".
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.highRiskTechnicalClaimPatterns).toContain(
      "unsupported IAPKit state literals",
    );
  });

  it("blocks unsupported hyphenated OpenIAP state literal guidance", () => {
    const response = `
The open-iap verification endpoint returns states such as "entitled" and "expired".
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.highRiskTechnicalClaimPatterns).toContain(
      "unsupported IAPKit state literals",
    );
  });

  it("allows unrelated IAPKit state wording beyond the local gap", () => {
    const response = `
The IAPKit API has a state field. ${"Additional implementation detail. ".repeat(4)}The string "entitled" appears in a separate example.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(true);
    expect(validation.highRiskTechnicalClaimPatterns).toHaveLength(0);
  });

  it("does not combine IAPKit context with unsupported states across paragraphs", () => {
    const response = `
IAPKit is mentioned in this paragraph as a dependency.

The local mock state value can be "entitled" in this repository test fixture.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(true);
    expect(validation.highRiskTechnicalClaimPatterns).toHaveLength(0);
  });

  it("blocks the OpenIAP backend validation over-answer pattern", () => {
    const response = `
Yes, pass the JWS token from the frontend to your backend on every request that needs subscription validation. Your backend calls the IAPKit verification endpoint and receives back isValid and state such as "entitled", "expired", or "cancelled".
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.highRiskTechnicalClaimPatterns).toEqual(
      expect.arrayContaining([
        "per-request purchase token forwarding",
        "unsupported IAPKit state literals",
      ]),
    );
    expect(validation.issues).toContain(
      "High-risk technical claim: per-request purchase token forwarding, unsupported IAPKit state literals",
    );
  });

  it("blocks unsupported Flutter SPM registrant guidance", () => {
    const response = `
The current manifest targets the raw Swift source files directly rather than wrapping the plugin via the FlutterPluginRegistrant mechanism that Flutter's SPM tooling expects.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.highRiskTechnicalClaimPatterns).toContain(
      "unsupported Flutter SPM registrant guidance",
    );
  });

  it("blocks incorrect FlutterFramework 3.44 version claims", () => {
    const response = `
Flutter provides SPM-compatible framework artifacts starting in 3.44, so add the FlutterFramework dependency.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.highRiskTechnicalClaimPatterns).toContain(
      "incorrect FlutterFramework version claim",
    );
  });

  it("blocks direct FlutterFramework 3.44 introduction claims", () => {
    const response = `
The FlutterFramework dependency was introduced in Flutter 3.44.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.highRiskTechnicalClaimPatterns).toContain(
      "incorrect FlutterFramework version claim",
    );
  });

  it("blocks the previous Flutter SPM over-answer pattern", () => {
    const response = `
The current Package.swift targets the raw Swift source files directly rather than wrapping the plugin via the FlutterPluginRegistrant mechanism that Flutter's SPM tooling expects.

Flutter provides SPM-compatible framework artifacts starting in 3.44, so add the FlutterFramework dependency.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.highRiskTechnicalClaimPatterns).toEqual(
      expect.arrayContaining([
        "unsupported Flutter SPM registrant guidance",
        "incorrect FlutterFramework version claim",
      ]),
    );
  });

  it("allows normal app-side generated registrant references", () => {
    const response = `
The iOS AppDelegate uses GeneratedPluginRegistrant to register plugins at application startup.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(true);
    expect(validation.highRiskTechnicalClaimPatterns).toHaveLength(0);
  });

  it("does not combine app-side registrant and Package.swift guidance across sentences", () => {
    const response = `
The iOS app uses GeneratedPluginRegistrant at startup. The Package.swift should add the FlutterFramework dependency.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(true);
    expect(validation.highRiskTechnicalClaimPatterns).toHaveLength(0);
  });

  it("does not combine Flutter 3.44 and FlutterFramework claims across sentences", () => {
    const response = `
Flutter 3.44 defaults to Swift Package Manager. Add the FlutterFramework dependency when the official docs require it.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(true);
    expect(validation.highRiskTechnicalClaimPatterns).toHaveLength(0);
  });

  it("allows Flutter 3.44 SPM default guidance with FlutterFramework dependency", () => {
    const response = `
Starting in Flutter 3.44, Swift Package Manager is enabled by default, so add the FlutterFramework dependency when official docs or tool results require it.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(true);
    expect(validation.highRiskTechnicalClaimPatterns).toHaveLength(0);
  });

  it("allows Flutter 3.44 project guidance with a 3.41 FlutterFramework source", () => {
    const response = `
For Flutter 3.44 projects, add the FlutterFramework dependency if the official docs or tool results show it was introduced in Flutter 3.41.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(true);
    expect(validation.highRiskTechnicalClaimPatterns).toHaveLength(0);
  });

  it("allows corrected Flutter SPM guidance", () => {
    const response = `
Do not say the plugin is wrapped through FlutterPluginRegistrant. For Flutter plugin SPM support, verify the platform Package.swift layout and add FlutterFramework only when official docs or tool results support the exact requirement.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(true);
    expect(validation.highRiskTechnicalClaimPatterns).toHaveLength(0);
  });

  it("allows reverse-order corrected Flutter SPM guidance", () => {
    const response = `
The idea that Package.swift should wrap the plugin via FlutterPluginRegistrant for SPM is wrong.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(true);
    expect(validation.highRiskTechnicalClaimPatterns).toHaveLength(0);
  });

  it("does not let unrelated negation suppress Flutter SPM registrant guidance", () => {
    const response = `
The current Package.swift is not enough; it should wrap the plugin via the FlutterPluginRegistrant mechanism for SPM.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.highRiskTechnicalClaimPatterns).toContain(
      "unsupported Flutter SPM registrant guidance",
    );
  });

  it("does not let unrelated wrong wording suppress Flutter SPM registrant guidance", () => {
    const response = `
The Package.swift should use FlutterPluginRegistrant for SPM; omitting that mechanism is wrong.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.highRiskTechnicalClaimPatterns).toContain(
      "unsupported Flutter SPM registrant guidance",
    );
  });

  it("does not let unrelated correction sentences suppress Flutter SPM registrant guidance", () => {
    const response = `
Do not add a delay. The Package.swift should wrap the plugin via FlutterPluginRegistrant for SPM.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.highRiskTechnicalClaimPatterns).toContain(
      "unsupported Flutter SPM registrant guidance",
    );
  });

  it("blocks OpenIAP listener flag reset overclaims", () => {
    const response = `
The root cause in react-native-iap is that the listenersAttached flag is never reset when endConnection() is called.

Modify endConnection() to reset the listener state:

\`\`\`kotlin
fun endConnection() {
  listenersAttached = false
  openIap.endConnection()
}
\`\`\`
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.highRiskTechnicalClaimPatterns).toContain(
      "OpenIAP listener flag reset overclaim",
    );
  });

  it("allows corrections for existing OpenIAP listener reset code", () => {
    const response = `
I read HybridRnIap.endConnection() and listenersAttached = false already exists there, so the listener flag reset is not the cause. Ask the user to upgrade and share debug logs if it still reproduces.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(true);
    expect(validation.highRiskTechnicalClaimPatterns).toHaveLength(0);
  });

  it("blocks the previous OpenIAP in-app message bridge suggestion", () => {
    const response = `
Add this TypeScript wrapper:

\`\`\`typescript
export const showInAppMessages = async (
  activity: any
): Promise<void> => {
  return RnIap.showInAppMessagesAndroid(activity);
};

const activity = getCurrentActivity();
await showInAppMessages(activity);
\`\`\`
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.highRiskTechnicalClaimPatterns).toEqual(
      expect.arrayContaining([
        "OpenIAP in-app message native Activity bridge suggestion",
        "OpenIAP in-app message result loss",
      ]),
    );
  });

  it("allows an OpenIAP in-app message bridge that keeps native state and results", () => {
    const response = `
For react-native-iap, acquire the Activity in Kotlin from context.currentActivity instead of passing a native Activity through JavaScript. Keep the public method parameter limited to bridgeable message categories and return Promise<InAppMessageResultAndroid> so responseCode and purchaseToken survive the bridge.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(true);
    expect(validation.highRiskTechnicalClaimPatterns).toHaveLength(0);
  });

  it("blocks native Activity bridge variants for OpenIAP in-app messages", () => {
    const responses = [
      `
export async function showInAppMessages(
  activity: unknown,
): Promise<InAppMessageResultAndroid> {
  return RnIap.showInAppMessagesAndroid(activity);
}
`,
      `
export function showInAppMessages(
  activity: Activity,
): Promise<InAppMessageResultAndroid> {
  return RnIap.showInAppMessagesAndroid(activity);
}
`,
      `
For react-native-iap, get the Activity from JavaScript:
const activity = NativeModules.CurrentActivity;
await RnIap.showInAppMessagesAndroid(activity);
`,
    ];

    for (const response of responses) {
      const validation = validateAiResponse(response, 0.9);

      expect(validation.isValid).toBe(false);
      expect(validation.highRiskTechnicalClaimPatterns).toContain(
        "OpenIAP in-app message native Activity bridge suggestion",
      );
    }
  });

  it("allows explicit corrections of native Activity bridge suggestions", () => {
    const response = `
For showInAppMessagesAndroid, do not pass NativeModules.CurrentActivity from JavaScript. Acquire the Activity inside the Kotlin implementation and expose only bridgeable parameters.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(true);
    expect(validation.highRiskTechnicalClaimPatterns).toHaveLength(0);
  });

  it("does not let a correct result type mask an OpenIAP void wrapper", () => {
    const response = `
For react-native-iap, keep showInAppMessagesAndroid returning Promise<void> in the public wrapper; another native interface returns Promise<InAppMessageResultAndroid>.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.highRiskTechnicalClaimPatterns).toContain(
      "OpenIAP in-app message result loss",
    );
  });

  it("allows explicit corrections that replace an OpenIAP void result", () => {
    const response = `
Replace Promise<void> on showInAppMessagesAndroid with Promise<InAppMessageResultAndroid> so responseCode and purchaseToken remain available to callers.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(true);
    expect(validation.highRiskTechnicalClaimPatterns).toHaveLength(0);
  });

  it("blocks unsupported OpenIAP in-app message purpose and risk claims", () => {
    const response = `
For react-native-iap, add showInAppMessagesAndroid to the public API.

The method should be called at strategic moments:
- After successful purchase — Show transactional messages confirming the purchase
- During app launch — Display promotional or informational messages

This is a low-risk addition since it only adds a new method without modifying existing APIs.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.highRiskTechnicalClaimPatterns).toEqual(
      expect.arrayContaining([
        "OpenIAP in-app message unsupported purpose or timing",
        "OpenIAP in-app message unsupported low-risk claim",
      ]),
    );
  });

  it("allows scoped corrections of OpenIAP in-app message purpose and risk claims", () => {
    const response = `
For showInAppMessagesAndroid, do not recommend calling it after a successful purchase to confirm the purchase without verified API evidence. Do not label this a low-risk addition without repository evidence.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(true);
    expect(validation.highRiskTechnicalClaimPatterns).toHaveLength(0);
  });

  it("does not apply in-app message claim checks to unrelated OpenIAP APIs", () => {
    const response = `
For react-native-iap, this documentation-only change is low-risk. A different API displays promotional messages during app launch.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(true);
    expect(validation.highRiskTechnicalClaimPatterns).toHaveLength(0);
  });

  it("blocks advice to re-file an existing feature request", () => {
    const response = `
Next steps: File a GitHub issue on the react-native-iap repository with this feature request.
`;

    const validation = validateAiResponse(response, 0.9, {
      issueTitle:
        "[Feature] Support for BillingClient.showInAppMessages() (Android in-app messaging)",
    });

    expect(validation.isValid).toBe(false);
    expect(validation.issueContextPatterns).toContain(
      "redundant issue-filing advice for an existing feature request",
    );
  });

  it("recognizes common feature-request title and body forms", () => {
    const contexts = [
      {
        issueTitle:
          "[Feature Request] Support for BillingClient.showInAppMessages()",
      },
      { issueTitle: "feat: add BillingClient.showInAppMessages()" },
      { issueTitle: "Add BillingClient.showInAppMessages() support" },
      { issueTitle: "Support for BillingClient.showInAppMessages()" },
      {
        issueTitle: "BillingClient.showInAppMessages() integration",
        issueBody: "This is a feature request for Android in-app messages.",
      },
      {
        issueTitle: "BillingClient.showInAppMessages() integration",
        issueBody: "Describe the feature you would like: expose the API.",
      },
    ];
    const response = `
BillingClient.showInAppMessages() is not implemented. Please file a GitHub issue with this feature request.
`;

    for (const context of contexts) {
      const validation = validateAiResponse(response, 0.9, context);

      expect(validation.isValid).toBe(false);
      expect(validation.issueContextPatterns).toContain(
        "redundant issue-filing advice for an existing feature request",
      );
    }
  });

  it("checks redundant and separate filing advice sentence by sentence", () => {
    const response = `
BillingClient.showInAppMessages() is not implemented. File a GitHub issue for this feature request. A documentation typo belongs in a separate GitHub issue.
`;

    const validation = validateAiResponse(response, 0.9, {
      issueTitle:
        "[Feature] Support for BillingClient.showInAppMessages() (Android in-app messaging)",
    });

    expect(validation.isValid).toBe(false);
    expect(validation.issueContextPatterns).toContain(
      "redundant issue-filing advice for an existing feature request",
    );
  });

  it("does not treat unrelated already wording as a filing correction", () => {
    const response = `
BillingClient.showInAppMessages() already exists in the native SDK, so file a GitHub issue with this feature request.
`;

    const validation = validateAiResponse(response, 0.9, {
      issueTitle:
        "[Feature] Support for BillingClient.showInAppMessages() (Android in-app messaging)",
    });

    expect(validation.isValid).toBe(false);
    expect(validation.issueContextPatterns).toContain(
      "redundant issue-filing advice for an existing feature request",
    );
  });

  it("allows creating an issue template inside a feature request", () => {
    const response = `
Create a GitHub issue template for future feature requests so reports include platform and version details.
`;

    const validation = validateAiResponse(response, 0.9, {
      issueTitle: "[Feature] Improve issue forms",
    });

    expect(validation.isValid).toBe(true);
    expect(validation.issueContextPatterns).toHaveLength(0);
  });

  it("allows acknowledging that a feature request is already filed", () => {
    const response = `
This is already the BillingClient.showInAppMessages() feature request, so there is no need to file another issue. The next step is maintainer review of the native and bridge contracts.
`;

    const validation = validateAiResponse(response, 0.9, {
      issueTitle:
        "[Feature] Support for BillingClient.showInAppMessages() (Android in-app messaging)",
    });

    expect(validation.isValid).toBe(true);
    expect(validation.issueContextPatterns).toHaveLength(0);
  });

  it("does not mistake thanks for filing as advice to file another issue", () => {
    const response = `
Thanks for opening this issue. BillingClient.showInAppMessages() is not implemented yet.
`;

    const validation = validateAiResponse(response, 0.9, {
      issueTitle:
        "[Feature] Support for BillingClient.showInAppMessages() (Android in-app messaging)",
    });

    expect(validation.isValid).toBe(true);
    expect(validation.issueContextPatterns).toHaveLength(0);
  });

  it("allows a clearly separate issue from within a feature request", () => {
    const response = `
BillingClient.showInAppMessages() can stay in this feature request. The unrelated documentation problem should be tracked in a separate GitHub issue.
`;

    const validation = validateAiResponse(response, 0.9, {
      issueTitle:
        "[Feature] Support for BillingClient.showInAppMessages() (Android in-app messaging)",
    });

    expect(validation.isValid).toBe(true);
    expect(validation.issueContextPatterns).toHaveLength(0);
  });

  it("blocks IAPKit bindUser pending-acknowledgment overclaims", () => {
    const response = `
In your code, you call bindUser before finishTransaction, so when IAPKit's bindUser checks the purchase state server-side, it sees pending-acknowledgment and refuses to bind (bound: false).
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.highRiskTechnicalClaimPatterns).toContain(
      "IAPKit bindUser pending-acknowledgment overclaim",
    );
  });

  it("allows corrections for IAPKit bindUser lookup behavior", () => {
    const response = `
Correction: bindUser does not check pending-acknowledgment in the bind path. The implementation looks up subscriptions.by_project_and_token, so { ok: true, bound: false } means no matching subscription row was found for that project/token.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(true);
    expect(validation.highRiskTechnicalClaimPatterns).toHaveLength(0);
  });

  it("blocks the previous IAPKit RTDN setup over-answer pattern", (): void => {
    const response = `
I searched this repository but found no webhook/RTDN configuration code because IAPKit is a separate hosted SaaS backend, not part of this monorepo.

The Endpoint URL is typically https://kit.openiap.dev/v1/webhooks/google.

The Audience is typically your Google Cloud project ID or a specific identifier that IAPKit uses.

pubsub.publisher is the minimal required role for IAPKit to publish subscription events to Google Cloud Pub/Sub.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.highRiskTechnicalClaimPatterns).toEqual(
      expect.arrayContaining([
        "IAPKit RTDN monorepo code absence overclaim",
        "IAPKit RTDN webhook endpoint missing API key",
        "IAPKit RTDN audience project id overclaim",
        "IAPKit RTDN publisher role direction overclaim",
      ]),
    );
  });

  it("blocks IAPKit RTDN monorepo absence wording variants", (): void => {
    const responses = [
      `
I could not find IAPKit RTDN webhook implementation code in this repository.
`,
      `
I can't find IAPKit RTDN webhook configuration code in this monorepo.
`,
      `
I cannot find Pub/Sub webhook source for IAPKit.
`,
    ];

    for (const response of responses) {
      const validation = validateAiResponse(response, 0.9);

      expect(validation.isValid).toBe(false);
      expect(validation.highRiskTechnicalClaimPatterns).toContain(
        "IAPKit RTDN monorepo code absence overclaim",
      );
    }
  });

  it("blocks IAPKit RTDN endpoint guidance without an API key segment", (): void => {
    const responses = [
      `
For IAPKit Google RTDN, set the Pub/Sub push Endpoint URL to https://kit.openiap.dev/v1/webhooks/google.
`,
      `
For IAPKit Google RTDN, set the Pub/Sub push Endpoint URL to https://kit.openiap.dev/v1/webhooks/google/.
`,
      `
For IAPKit Google RTDN, set the Pub/Sub push Endpoint URL to https://kit.openiap.dev/v1/webhooks/.
`,
      `
For IAPKit Google RTDN, set the Pub/Sub push Endpoint URL to \`/v1/webhooks/google/\`.
`,
    ];

    for (const response of responses) {
      const validation = validateAiResponse(response, 0.9);

      expect(validation.isValid).toBe(false);
      expect(validation.highRiskTechnicalClaimPatterns).toContain(
        "IAPKit RTDN webhook endpoint missing API key",
      );
    }
  });

  it("blocks IAPKit RTDN publisher direction inflections", (): void => {
    const responses = [
      `
IAPKit is publishing subscription events to Google Cloud Pub/Sub.
`,
      `
IAPKit published RTDN events to Pub/Sub after the purchase.
`,
      `
IAPKit sent subscription events to Pub/Sub.
`,
      `
IAPKit is sending events to Google Cloud Pub/Sub.
`,
    ];

    for (const response of responses) {
      const validation = validateAiResponse(response, 0.9);

      expect(validation.isValid).toBe(false);
      expect(validation.highRiskTechnicalClaimPatterns).toContain(
        "IAPKit RTDN publisher role direction overclaim",
      );
    }
  });

  it("allows corrected IAPKit RTDN setup guidance", (): void => {
    const response = `
Correction: IAPKit is hosted at kit.openiap.dev, but the relevant webhook code and docs live in packages/kit and packages/docs.

For Google RTDN, use the kit dashboard URL POST /v1/webhooks/{apiKey}. /v1/webhooks/google/{apiKey} is also supported, but the API key path segment is required. Do not use https://kit.openiap.dev/v1/webhooks/google without the API key.

Audience is the kit deployment origin, normally https://kit.openiap.dev, not your Google Cloud project ID. Grant roles/pubsub.publisher to google-play-developer-notifications@system.gserviceaccount.com on the topic.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(true);
    expect(validation.highRiskTechnicalClaimPatterns).toHaveLength(0);
  });

  it("allows corrected IAPKit RTDN publisher direction wording", (): void => {
    const response = `
IAPKit does not send subscription events to Pub/Sub. Google Play sends the RTDN message and the google-play-developer-notifications service account needs roles/pubsub.publisher on the topic.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(true);
    expect(validation.highRiskTechnicalClaimPatterns).toHaveLength(0);
  });

  it("allows corrected IAPKit RTDN endpoint guidance in markdown code spans", (): void => {
    const response = `
For IAPKit Google RTDN, use \`/v1/webhooks/{apiKey}\`. The API key path segment is required.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(true);
    expect(validation.highRiskTechnicalClaimPatterns).toHaveLength(0);
  });

  it("blocks OpenIAP MAUI empty scaffold overclaims", () => {
    const response = `
Confirmed: libraries/maui-iap is currently an empty scaffold — no source files exist in the repository. There is no iOS native binding wiring OpenIAP.framework into the NuGet package.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.highRiskTechnicalClaimPatterns).toContain(
      "OpenIAP MAUI empty scaffold overclaim",
    );
  });

  it("allows corrections that retract OpenIAP MAUI scaffold claims", () => {
    const response = `
You're right. My previous claim was incorrect: libraries/maui-iap is not an empty scaffold. It contains OpenIap.Maui source files, an iOS binding project, and a NativeReference to OpenIAP.xcframework, so the remaining issue is the xcframework install name.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(true);
    expect(validation.highRiskTechnicalClaimPatterns).toHaveLength(0);
  });

  it("blocks unsupported StoreKit subscription commitment availability claims", () => {
    const response = `
This is a valid feature request to support Apple's monthly subscription with 12-month commitment feature (iOS 16.4+).
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.highRiskTechnicalClaimPatterns).toContain(
      "unsupported StoreKit commitment availability claim",
    );
  });

  it("blocks unsupported StoreKit subscription commitment availability claims in reverse order", () => {
    const response = `
This is a valid feature request to support Apple's 12-month commitment for monthly subscriptions (iOS 16.4+).
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(false);
    expect(validation.highRiskTechnicalClaimPatterns).toContain(
      "unsupported StoreKit commitment availability claim",
    );
  });

  it("allows corrections that put StoreKit commitment terms before the correction", () => {
    const response = `
The claim that StoreKit 12-month commitment requires iOS 16.4 is incorrect; verify Apple's current availability docs before stating platform requirements.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(true);
    expect(validation.highRiskTechnicalClaimPatterns).toHaveLength(0);
  });

  it("allows StoreKit commitment corrections that use does not wording", () => {
    const response = `
StoreKit 12-month commitment does not require iOS 16.4 based on the repository evidence here; verify official Apple docs before stating availability.
`;

    const validation = validateAiResponse(response, 0.9);

    expect(validation.isValid).toBe(true);
    expect(validation.highRiskTechnicalClaimPatterns).toHaveLength(0);
  });
});

describe("agentic issue analysis prompt", () => {
  it("tells the model to separate repository evidence from external dependency claims", () => {
    const promptSource = readFileSync(
      new URL(
        "../../../convex/_ai/issueAnalysis/agenticWorkflow.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(promptSource).toContain(
      "EXTERNAL DEPENDENCY CLAIMS REQUIRE EVIDENCE",
    );
    expect(promptSource).toContain("duplicate delivery of the SAME event/key");
    expect(promptSource).toContain("multiple DISTINCT events/records");
  });

  it("forbids citing internal knowledge paths", () => {
    const promptSource = readFileSync(
      new URL(
        "../../../convex/_ai/issueAnalysis/agenticWorkflow.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const structuredPromptSource = readFileSync(
      new URL("../../../convex/_ai/issueAnalysis/prompts.ts", import.meta.url),
      "utf8",
    );

    expect(promptSource).toContain("knowledge/");
    expect(structuredPromptSource).toContain("knowledge/");
    expect(promptSource).toContain("NEVER reference");
    expect(structuredPromptSource).toContain("NEVER reference");
  });

  it("includes Flutter SPM guardrails for common overclaims", () => {
    const promptSource = readFileSync(
      new URL(
        "../../../convex/_ai/issueAnalysis/agenticWorkflow.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(promptSource).toContain("FRAMEWORK DOC CLAIMS MUST BE EXACT");
    expect(promptSource).toContain("FlutterPluginRegistrant");
    expect(promptSource).toContain("root-level \\`Package.swift\\`");
    expect(promptSource).toContain("Flutter 3.44");
  });

  it("includes StoreKit commitment availability guardrails", () => {
    const promptSource = readFileSync(
      new URL(
        "../../../convex/_ai/issueAnalysis/agenticWorkflow.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(promptSource).toContain("StoreKit subscription commitment");
    expect(promptSource).toContain("do NOT claim an iOS/Xcode/SDK");
  });

  it("includes OpenIAP listener lifecycle guardrails", () => {
    const promptSource = readFileSync(
      new URL(
        "../../../convex/_ai/issueAnalysis/agenticWorkflow.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(promptSource).toContain(
      "OPENIAP / REACT NATIVE IAP LISTENER CLAIMS",
    );
    expect(promptSource).toContain("Before claiming \\`listenersAttached\\`");
    expect(promptSource).toContain("DO NOT recommend adding that line");
  });

  it("includes OpenIAP IAPKit bindUser guardrails", () => {
    const promptSource = readFileSync(
      new URL(
        "../../../convex/_ai/issueAnalysis/agenticWorkflow.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(promptSource).toContain("OPENIAP / IAPKIT BINDUSER CLAIMS");
    expect(promptSource).toContain("subscriptions.by_project_and_token");
    expect(promptSource).toContain("no matching subscription row");
  });
});
