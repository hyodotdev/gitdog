import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { httpClient, invoke } from "./client.js";
import { SessionStore, validTokens, tokenExpiresSoon } from "./storage.js";
import { asRecord, type Ui } from "./ui.js";

const runFile = promisify(execFile);
export const CALLBACK_PATH = "/gitdog/callback";

export async function openBrowser(
  url: string,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  const parsed = new URL(url);
  if (!["https:", "http:"].includes(parsed.protocol))
    throw new Error("Invalid browser URL.");
  try {
    switch (process.platform) {
      case "darwin":
        await runFile("open", [url], { timeout: 10_000, signal });
        break;
      case "win32":
        await runFile("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
          timeout: 10_000,
          signal,
        });
        break;
      default:
        await runFile("xdg-open", [url], { timeout: 10_000, signal });
    }
    return true;
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}

export async function createLoginListener(timeoutMs = 300_000) {
  const cancellation = new AbortController();
  const state = randomBytes(32).toString("hex");
  let resolveCode: (code: string) => void;
  let rejectCode: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  void code.catch(() => {});
  let expectedHost = "";
  let settled = false;
  const finish = (error?: Error, value?: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) {
      cancellation.abort(error);
      rejectCode(error);
    } else resolveCode(value!);
  };
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 5000 },
    (request, response) => {
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; frame-ancestors 'none'",
      );
      let url: URL;
      try {
        url = new URL(request.url ?? "/", `http://${expectedHost}`);
      } catch {
        response.writeHead(400).end("Invalid request URL.");
        return;
      }
      if (
        request.method !== "GET" ||
        request.headers.host !== expectedHost ||
        url.origin !== `http://${expectedHost}` ||
        url.pathname !== CALLBACK_PATH
      ) {
        response.writeHead(404).end("Not found.");
        return;
      }
      if (
        url.searchParams.getAll("state").length !== 1 ||
        url.searchParams.get("state") !== state
      ) {
        response
          .writeHead(400)
          .end("Invalid sign-in state. Return to your terminal and try again.");
        return;
      }
      if (settled) {
        response.writeHead(410).end("This sign-in has already completed.");
        return;
      }
      if (url.searchParams.has("error")) {
        response
          .writeHead(400)
          .end("Gitdog sign-in was not completed. Return to your terminal.");
        finish(new Error("GitHub sign-in was declined or failed."));
        return;
      }
      const value = url.searchParams.get("code");
      if (!url.searchParams.has("code")) {
        response
          .writeHead(400)
          .end("Gitdog sign-in was not completed. Return to your terminal.");
        finish(new Error("GitHub sign-in was declined or failed."));
        return;
      }
      if (
        url.searchParams.getAll("code").length !== 1 ||
        !value ||
        value.length > 4096
      ) {
        response.writeHead(400).end("Missing or invalid sign-in code.");
        return;
      }
      response.end(
        "Gitdog received your sign-in. Return to your terminal to finish. You can close this tab.",
      );
      finish(undefined, value);
    },
  );
  const timer = setTimeout(
    () =>
      finish(new Error("Sign-in timed out. Run gitdog login to try again.")),
    timeoutMs,
  );
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
  server.on("error", () =>
    finish(new Error("The local sign-in listener failed.")),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not start the local sign-in listener.");
  expectedHost = `127.0.0.1:${address.port}`;
  const redirectTo = `http://${expectedHost}${CALLBACK_PATH}?state=${state}`;
  const onInterrupt = () => {
    const error = new Error("Sign-in cancelled.");
    cancellation.abort(error);
    finish(error);
  };
  process.once("SIGINT", onInterrupt);
  return {
    redirectTo,
    signal: cancellation.signal,
    code,
    close: async () => {
      finish(new Error("Sign-in cancelled."));
      process.off("SIGINT", onInterrupt);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function validateAuthRedirect(value: string, apiUrl: string): void {
  const url = new URL(value);
  const api = new URL(apiUrl);
  const siteOrigin = api.origin.replace(/\.convex\.cloud$/, ".convex.site");
  if (
    ![api.origin, siteOrigin].includes(url.origin) ||
    url.pathname !== "/api/auth/signin/github" ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("The server returned an unexpected sign-in URL.");
  }
}

export async function login(
  apiUrl: string,
  siteUrl: string,
  ui: Ui,
  noBrowser = false,
): Promise<void> {
  if (ui.json)
    throw new Error(
      "Browser login needs human interaction. Omit --json; use GITDOG_TOKEN for automation.",
    );
  ui.banner();
  const listener = await createLoginListener();
  const client = httpClient(apiUrl, 30_000, listener.signal);
  try {
    ui.info("1 / 2  Sign in with your GitHub account");
    const result = asRecord(
      await invoke(client, "action", "auth:signIn", {
        provider: "github",
        params: { redirectTo: listener.redirectTo },
      }),
    );
    listener.signal.throwIfAborted();
    if (
      typeof result?.redirect !== "string" ||
      typeof result.verifier !== "string"
    )
      throw new Error("The server did not start GitHub sign-in.");
    validateAuthRedirect(result.redirect, apiUrl);
    ui.info(
      `Open this URL in a browser on this computer:\n${result.redirect}\n`,
    );
    if (!noBrowser && !(await openBrowser(result.redirect, listener.signal)))
      ui.info("Could not open your browser automatically. Use the URL above.");
    ui.info("Waiting for GitHub authorization… (Ctrl+C to cancel)");
    const code = await listener.code;
    listener.signal.throwIfAborted();
    ui.info("2 / 2  Securely save your Gitdog session");
    let exchange: unknown;
    try {
      exchange = await invoke(client, "action", "auth:signIn", {
        params: { code },
        verifier: result.verifier,
      });
    } catch {
      listener.signal.throwIfAborted();
      throw new Error(
        "Could not finish sign-in. Check that the CLI loopback callback is deployed, then run gitdog login again.",
      );
    }
    const tokens = asRecord(exchange)?.tokens;
    if (!validTokens(tokens))
      throw new Error(
        "Sign-in did not return a session. Run gitdog login again.",
      );
    client.setAuth(tokens.token);
    const user = asRecord(
      await invoke(client, "query", "users/query:getCurrentUser"),
    );
    if (!user)
      throw new Error("Gitdog could not verify the signed-in account.");
    const store = new SessionStore();
    await store.locked(
      () => store.save({ ...tokens, apiUrl, siteUrl }, listener.signal),
      undefined,
      listener.signal,
    );
    listener.signal.throwIfAborted();
    ui.output(`✓ Signed in as ${String(user.name ?? "GitHub user")}.`);
    if (user.requiresCurrentLegalAttestation)
      ui.info(
        `Complete account consent at ${siteUrl}/legal/consent before running AI workflows.`,
      );
    ui.info("Next: gitdog init");
  } finally {
    await listener.close();
  }
}

export async function logout(
  ui: Ui,
  localOnly = false,
  store = new SessionStore(),
): Promise<void> {
  if (process.env.GITDOG_TOKEN && !localOnly)
    throw new Error(
      "GITDOG_TOKEN is set. Unset it to log out a saved session, or use --local.",
    );
  let revoked = false;
  await store.locked(async () => {
    let session = localOnly ? undefined : await store.read();
    if (session) {
      const client = httpClient(session.apiUrl, 30_000);
      if (tokenExpiresSoon(session.token)) {
        const result = asRecord(
          await invoke(client, "action", "auth:signIn", {
            refreshToken: session.refreshToken,
          }),
        );
        if (!validTokens(result?.tokens))
          throw new Error(
            "Could not refresh this session to revoke it. Run logout --local to remove only local credentials.",
          );
        session = { ...session, ...result.tokens };
        await store.save(session);
      }
      client.setAuth(session.token);
      await invoke(client, "action", "auth:signOut");
      revoked = true;
    }
    await store.clear();
  });
  ui.output({ loggedOut: true, revoked });
}
