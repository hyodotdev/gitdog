import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { httpClient, invoke } from "./client.js";
import { DEFAULT_SITE_URL, SessionStore, tokensFromBundle } from "./storage.js";
import { asRecord, type Ui } from "./ui.js";

const runFile = promisify(execFile);
export const CALLBACK_PATH = "/gitdog/callback";
export const LOGIN_RESULT_PATH = "/cli/login";
// Gitdog's sign-in returns only to exact origins, so the listener uses one of
// these ports. convex/_utils/authRedirect.ts allows the same list.
export const LOGIN_CALLBACK_PORTS = [41721, 41722, 41723, 41724, 41725];
// The query parameters @convex-dev/auth adds when it returns to the CLI.
const CODE_PARAM = "convexAuthCode";
const ERROR_PARAM = "convexAuthError";

type LoginOutcome = "success" | "failed";

function sendToLoginResult(
  response: ServerResponse,
  siteUrl: string,
  outcome: LoginOutcome,
): Promise<void> {
  if (response.destroyed) return Promise.resolve();
  const location = new URL(LOGIN_RESULT_PATH, siteUrl);
  location.searchParams.set("status", outcome);
  return new Promise((resolve) => {
    response.once("close", resolve);
    response
      .writeHead(302, { Location: location.href, Connection: "close" })
      .end();
  });
}

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

export async function createLoginListener(
  timeoutMs = 300_000,
  siteUrl = DEFAULT_SITE_URL,
) {
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
  // Held open so the browser reports the real result, not just a received code.
  let pendingResponse: ServerResponse | undefined;
  const complete = async (outcome: LoginOutcome): Promise<void> => {
    const response = pendingResponse;
    pendingResponse = undefined;
    if (response) await sendToLoginResult(response, siteUrl, outcome);
  };
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
      // One-shot listener on a fixed port: never leave a reusable socket.
      response.setHeader("Connection", "close");
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
      if (
        url.searchParams.has(ERROR_PARAM) ||
        !url.searchParams.has(CODE_PARAM)
      ) {
        void sendToLoginResult(response, siteUrl, "failed");
        finish(new Error("GitHub sign-in was declined or failed."));
        return;
      }
      const value = url.searchParams.get(CODE_PARAM);
      if (
        url.searchParams.getAll(CODE_PARAM).length !== 1 ||
        !value ||
        value.length > 4096
      ) {
        response.writeHead(400).end("Missing or invalid sign-in code.");
        return;
      }
      pendingResponse = response;
      finish(undefined, value);
    },
  );
  const timer = setTimeout(
    () =>
      finish(
        new Error(
          "Sign-in timed out. Run npx gitdog@latest login to try again.",
        ),
      ),
    timeoutMs,
  );
  const listenOn = (port: number) =>
    new Promise<boolean>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) =>
        error.code === "EADDRINUSE" ? resolve(false) : reject(error);
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", onError);
        resolve(true);
      });
    });
  try {
    let listening = false;
    for (const port of LOGIN_CALLBACK_PORTS) {
      if ((listening = await listenOn(port))) break;
    }
    if (!listening)
      throw new Error(
        `Ports ${LOGIN_CALLBACK_PORTS.join(", ")} are all in use. Free one and run npx gitdog@latest login again.`,
      );
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
    complete,
    close: async () => {
      finish(new Error("Sign-in cancelled."));
      await complete("failed");
      process.off("SIGINT", onInterrupt);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** GitHub's authorization page is the only place the CLI may send the user. */
export function validateAuthRedirect(value: string): void {
  const url = URL.canParse(value) ? new URL(value) : undefined;
  if (
    !url ||
    url.origin !== "https://github.com" ||
    url.pathname !== "/login/oauth/authorize" ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error(
      "The server returned an unexpected GitHub authorization URL.",
    );
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
  const listener = await createLoginListener(undefined, siteUrl);
  const client = httpClient(apiUrl, 30_000, listener.signal);
  try {
    ui.info("1 / 2  Sign in with your GitHub account");
    const result = asRecord(
      await invoke(client, "mutation", "auth:startSignInWithGithub", {
        redirectTo: listener.redirectTo,
      }),
    );
    listener.signal.throwIfAborted();
    if (
      typeof result?.redirect !== "string" ||
      typeof result.state !== "string"
    )
      throw new Error("The server did not start GitHub sign-in.");
    validateAuthRedirect(result.redirect);
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
      exchange = await invoke(
        client,
        "mutation",
        "auth:completeSignInWithGithub",
        { code, state: result.state },
      );
    } catch {
      listener.signal.throwIfAborted();
      throw new Error(
        "Could not finish sign-in. Check that the CLI loopback callback is deployed, then run npx gitdog@latest login again.",
      );
    }
    const completed = asRecord(exchange);
    const tokens =
      completed?.status === "complete"
        ? tokensFromBundle(completed.tokens)
        : null;
    if (!tokens)
      throw new Error(
        "Sign-in did not return a session. Run npx gitdog@latest login again.",
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
    await listener.complete("success");
    ui.output(`✓ Signed in as ${String(user.name ?? "GitHub user")}.`);
    if (user.requiresCurrentLegalAttestation)
      ui.info(
        `Complete account consent at ${siteUrl}/legal/consent before running AI workflows.`,
      );
    ui.info("Next: npx gitdog@latest init");
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
    const session = localOnly ? undefined : await store.read();
    if (session) {
      // Signing out needs only the refresh token, not a fresh access token.
      await invoke(
        httpClient(session.apiUrl, 30_000),
        "mutation",
        "auth:signOut",
        { refreshToken: session.refreshToken },
      );
      revoked = true;
    }
    await store.clear();
  });
  ui.output({ loggedOut: true, revoked });
}
