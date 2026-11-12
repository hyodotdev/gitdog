import { describe, expect, it } from "vitest";

import { isDevelopmentSiteUrl } from "../../../convex/_utils/environment";

describe("development SITE_URL detection", () => {
  it.each([
    "http://localhost:5173",
    "https://LOCALHOST",
    "http://127.0.0.1:3210",
    "http://[::1]:5173",
  ])("accepts the exact loopback host in %s", (siteUrl) => {
    expect(isDevelopmentSiteUrl(siteUrl)).toBe(true);
  });

  it.each([
    "https://gitdog.dev",
    "https://localhost.example.com",
    "https://notlocalhost.example",
    "https://127.0.0.1.example",
    "http://[::2]",
    "localhost:5173",
    "not a URL",
    "",
  ])("rejects a non-loopback or malformed SITE_URL in %s", (siteUrl) => {
    expect(isDevelopmentSiteUrl(siteUrl)).toBe(false);
  });
});
