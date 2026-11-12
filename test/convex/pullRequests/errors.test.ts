import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitHubAppRateLimitError } from "../../../convex/github/helpers";
import { ChatProviderRequestError } from "../../../convex/_ai/providerErrors";
import {
  reviewGenerationError,
  ReviewResponseFormatError,
  ReviewEvidenceError,
  reviewFailureDetails,
  runReviewRequest,
} from "../../../convex/pullRequests/errors";

describe("safe PR generation diagnostics", () => {
  const stage = "AI generation and evidence validation";
  it("does not persist the source metadata carried by evidence recovery errors", () => {
    const message = reviewGenerationError(
      new ReviewEvidenceError(
        "Finding target was not read at the head commit",
        {
          path: "private-source-token.ts",
          ref: "head",
        },
      ),
      stage,
    );
    expect(message).not.toContain("private-source-token");
    expect(message).toContain("No review was published");
  });
  it("distinguishes malformed responses, source limits and changed source", () => {
    expect(
      reviewGenerationError(new ReviewResponseFormatError(), stage),
    ).toContain("not valid JSON");
    expect(
      reviewGenerationError(
        new Error("Review context is unavailable, binary or too large"),
        stage,
      ),
    ).toContain("40 KB");
    expect(
      reviewGenerationError(
        new Error("Review source, settings or lifecycle changed"),
        stage,
      ),
    ).toContain("changed before verification");
  });
  it("identifies a GitHub access failure without confusing rate limits", () => {
    expect(
      reviewGenerationError(
        new Error("Read review context failed (HTTP 403)"),
        stage,
      ),
    ).toContain("GitHub denied access");
    expect(
      reviewGenerationError(
        new GitHubAppRateLimitError("Read review context", 100, 403),
        stage,
      ),
    ).toContain("rate limited");
    expect(
      reviewGenerationError(
        new Error("Read review context failed (HTTP 404)"),
        stage,
      ),
    ).not.toContain("permissions");
    expect(
      reviewGenerationError(
        new Error("Read pull request diff (page 3) failed (HTTP 403)"),
        stage,
      ),
    ).toContain("GitHub denied access");
  });
  it("never persists arbitrary provider messages or injected source", () => {
    const result = reviewGenerationError(
      new Error("permission denied: secret-token private source"),
      stage,
    );
    expect(result).not.toContain("secret-token");
    expect(result).not.toContain("private source");
    expect(result).not.toContain("permissions");
    expect(result).toContain("No review was published");
  });
  it.each([
    [
      "Unsafe suggestion range or replacement",
      "invalid shape, line range or replacement",
    ],
    [
      "Suggestion original must match the reviewed commit exactly",
      "did not match the reviewed lines",
    ],
    ["Invalid review result", "did not match the required review schema"],
    [
      "Invalid or low-confidence review finding",
      "did not match the required review schema",
    ],
    [
      "Verification introduced an unreviewed finding",
      "not a valid selection of the reviewed findings",
    ],
    [
      "Finding evidence was not present in commit-pinned reads",
      "could not be verified against the source read",
    ],
    [
      "Finding contains unsupported evidence or mentions",
      "did not quote its target line, or contained an @mention",
    ],
    ["Duplicate review finding", "same finding more than once"],
    ["Review did not finish completely", "did not finish normally"],
    ["Review verification did not finish", "did not finish normally"],
    [
      "Reviewer did not inspect the changed implementation",
      "finished without inspecting a changed file",
    ],
    ["Review history is unavailable", "invalid review history response"],
    ["Review has no supported findings", "publishable set of findings"],
    ["Invalid commit-pinned file request", "unsafe path or an invalid commit"],
  ])("names the internal review failure %s", (message, reason) => {
    for (const text of [
      reviewGenerationError(new Error(message), stage),
      reviewFailureDetails(new Error(message), stage),
    ]) {
      expect(text).toContain(reason);
      expect(text).not.toContain("complete, current code evidence");
    }
  });
  it("names every fixed failure the review workflow throws", () => {
    const thrown = [
      "review.ts",
      "workflow.ts",
      "github.ts",
      "internalAction.ts",
    ].flatMap((file) => [
      ...readFileSync(
        join(process.cwd(), "convex/pullRequests", file),
        "utf8",
      ).matchAll(/throw new (?:Error|ReviewEvidenceError)\(\s*"([^"]+)"/g),
    ]);
    expect(thrown.length).toBeGreaterThan(30);
    for (const [, message] of thrown) {
      // The observer's failure goes to the Convex log, not to a stored review.
      if (message.startsWith("PR observation failed")) continue;
      expect(
        reviewFailureDetails(new Error(message), stage),
        message,
      ).not.toContain("complete, current code evidence");
    }
  });
  it("records which limit a review exceeded", () => {
    expect(
      reviewFailureDetails(new Error("Review tool budget exhausted"), stage),
    ).toBe(
      [
        `Stage · ${stage}`,
        "Reason · Review exceeded a source or context limit, or encountered an unsupported file. Large source files are limited to 40 KB; use smaller changes where possible.",
        "Limit · Review tool budget exhausted",
      ].join("\n"),
    );
    expect(
      reviewFailureDetails(new Error("private source text"), stage),
    ).not.toContain("Limit");
  });
  it("records only the provider status and request label for an upstream rejection", async () => {
    const error = await runReviewRequest(
      { operation: "Request AI review (pr-review/0)" },
      async () => {
        throw new ChatProviderRequestError(
          "Bearer secret-key and private source",
          "not_billed",
          {
            httpStatus: 429,
            providerRequestId: "private-request-id",
          },
        );
      },
    ).catch((error: unknown) => error);
    expect(reviewFailureDetails(error, stage)).toBe(
      [
        `Stage · ${stage}`,
        "Request · Request AI review (pr-review/0)",
        "Reason · The model provider returned HTTP 429.",
      ].join("\n"),
    );
  });
  it("uses a fixed bot exclusion diagnostic without copying appended content", () => {
    expect(
      reviewGenerationError(
        new Error("Bot-authored pull requests are not reviewed"),
        stage,
      ),
    ).toContain("Bot-authored pull requests are excluded from AI reviews");
    expect(
      reviewGenerationError(
        new Error(
          "Bot-authored pull requests are not reviewed: private source",
        ),
        stage,
      ),
    ).not.toContain("private source");
  });
});
