import { describe, expect, it } from "vitest";
import { resolveAuthRedirect } from "../../../convex/_utils/authRedirect";

const site = "https://gitdog.dev";
const state = "a".repeat(64);
const callback = `http://127.0.0.1:54321/gitdog/callback?state=${state}`;

describe("authentication redirect destinations", () => {
  it("permits the CLI's exact state-bound loopback callback", () => {
    expect(resolveAuthRedirect(callback, site)).toBe(callback);
  });

  it.each([
    "/tickets",
    "?next=profile",
    "https://gitdog.dev/repositories/connect",
  ])("preserves web sign-in to %s", (target) => {
    expect(new URL(resolveAuthRedirect(target, site)).origin).toBe(site);
  });

  it.each([
    "https://evil.example/",
    "https://gitdog.dev.evil.example/",
    "//evil.example/",
    "/\\evil.example/",
    "https://attacker@gitdog.dev/",
    "javascript:alert(1)",
    `http://localhost:54321/gitdog/callback?state=${state}`,
    `http://127.0.0.1.evil.example:54321/gitdog/callback?state=${state}`,
    `http://127.0.0.2:54321/gitdog/callback?state=${state}`,
    callback.replace(":54321", ":80"),
    callback.replace(":54321", ":65536"),
    callback.replace("/gitdog/callback", "/other"),
    callback.replace("http:", "https:"),
    callback.replace(state, "short"),
    callback + "&next=https://evil.example",
    callback + "#fragment",
    callback + "\n",
    callback + "\r\n",
    callback.replace("127.0.0.1", "2130706433"),
  ])("rejects unsafe destination %s", (target) => {
    expect(() => resolveAuthRedirect(target, site)).toThrow();
  });
});
