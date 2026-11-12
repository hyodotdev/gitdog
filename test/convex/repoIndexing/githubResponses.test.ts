import { describe, expect, it } from "vitest";

import {
  decodeGitHubContentResponse,
  getGitHubRateLimitRetryAt,
} from "../../../convex/repoIndexing/action";

describe("GitHub indexing responses", () => {
  it("accepts an empty base64 Git blob as legitimate file content", async () => {
    const response = Response.json({ content: "", encoding: "base64" });

    await expect(decodeGitHubContentResponse(response)).resolves.toBe("");
  });

  it("distinguishes a missing Git blob content field from an empty blob", async () => {
    const response = Response.json({ encoding: "base64" });

    await expect(decodeGitHubContentResponse(response)).resolves.toBeNull();
  });

  it("detects a headerless secondary rate limit without consuming the response", async () => {
    const now = 1_750_000_000_000;
    const body = {
      message: "You have exceeded a secondary rate limit. Please wait.",
    };
    const response = Response.json(body, { status: 403 });

    await expect(getGitHubRateLimitRetryAt(response, now)).resolves.toBe(
      now + 60_000,
    );
    await expect(response.json()).resolves.toEqual(body);
  });

  it("does not misclassify an ordinary forbidden response", async () => {
    const response = Response.json(
      { message: "Resource not accessible by integration" },
      { status: 403 },
    );

    await expect(
      getGitHubRateLimitRetryAt(response, 1_750_000_000_000),
    ).resolves.toBeNull();
  });

  it("waits at least one minute for a 429 without useful headers", async () => {
    const now = 1_750_000_000_000;
    const response = new Response("too many requests", { status: 429 });

    await expect(getGitHubRateLimitRetryAt(response, now)).resolves.toBe(
      now + 60_000,
    );
  });

  it("does not use a primary reset timestamp for a secondary limit", async () => {
    const now = 1_750_000_000_000;
    const response = Response.json(
      { message: "You have exceeded a secondary rate limit." },
      {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "100",
          "x-ratelimit-reset": String(Math.floor((now + 30_000) / 1_000)),
        },
      },
    );

    await expect(getGitHubRateLimitRetryAt(response, now)).resolves.toBe(
      now + 60_000,
    );
  });
});
