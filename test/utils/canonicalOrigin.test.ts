import { describe, expect, it } from "vitest";
import { getCanonicalOriginRedirect } from "../../src/utils/canonicalOrigin";

describe("canonical authentication origin", () => {
  it("moves legacy consent and callback routes before authentication starts", () => {
    for (const path of [
      "/legal/consent?redirectTo=%2Ftickets#eligibility",
      "/legal/consent?code=oauth-code&redirectTo=%2Fusage",
      "/repositories/hyodotdev/openiap",
    ]) {
      expect(getCanonicalOriginRedirect(`https://gitdog.hyo.dev${path}`)).toBe(
        `https://gitdog.dev${path}`,
      );
    }
  });

  it("leaves canonical, development, preview and lookalike origins alone", () => {
    for (const origin of [
      "https://gitdog.dev",
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "https://gitdog-preview.web.app",
      "https://gitdog.hyo.dev.example.com",
    ]) {
      expect(getCanonicalOriginRedirect(`${origin}/legal/consent`)).toBeNull();
    }
  });

  it("uses HTTPS and removes a legacy port", () => {
    expect(
      getCanonicalOriginRedirect("http://gitdog.hyo.dev:8080/tickets"),
    ).toBe("https://gitdog.dev/tickets");
  });

  it("keeps hostile paths and redirect parameters on the fixed origin", () => {
    const target = getCanonicalOriginRedirect(
      "https://gitdog.hyo.dev//other.example/login?redirectTo=https%3A%2F%2Fother.example#test",
    );
    expect(new URL(target!).origin).toBe("https://gitdog.dev");
    expect(new URL(target!).pathname).toBe("//other.example/login");
  });
});
