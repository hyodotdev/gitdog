import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  allowedSignInOrigins,
  CLI_LOGIN_PORTS,
} from "../../../convex/_utils/authRedirect";

describe("sign-in redirect origins", () => {
  it("allows only the site's origin and the CLI's fixed loopback ports", () => {
    expect(allowedSignInOrigins("https://gitdog.dev/some/path?x=1")).toEqual([
      "https://gitdog.dev",
      ...CLI_LOGIN_PORTS.map((port) => `http://127.0.0.1:${port}`),
    ]);
  });

  it("matches the ports the CLI listens on", () => {
    const cli = readFileSync(
      new URL("../../../packages/cli/src/auth.ts", import.meta.url),
      "utf8",
    );
    const listed = /LOGIN_CALLBACK_PORTS = \[([^\]]+)\]/.exec(cli)?.[1];
    expect(listed?.split(",").map((port) => Number(port.trim()))).toEqual([
      ...CLI_LOGIN_PORTS,
    ]);
  });
});
