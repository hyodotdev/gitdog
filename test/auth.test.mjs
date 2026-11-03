import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rmdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createLoginListener,
  login,
  logout,
  validateAuthRedirect,
} from "../dist/auth.js";
import { GitdogApi } from "../dist/client.js";
import { SessionStore, validateUrl } from "../dist/storage.js";
import { CaptureUi, fixture, jwt, mockServer } from "./helpers.mjs";

test("loopback listener rejects incorrect state, path, method and duplicate code", async (t) => {
  const listener = await createLoginListener(5000);
  t.after(listener.close);
  const correct = new URL(listener.redirectTo);
  correct.searchParams.set("code", "one-time-code");
  const wrong = new URL(correct);
  wrong.searchParams.set("state", "bad");
  assert.equal((await fetch(wrong)).status, 400);
  const path = new URL(correct);
  path.pathname = "/unexpected";
  assert.equal((await fetch(path)).status, 404);
  assert.equal((await fetch(correct, { method: "POST" })).status, 404);
  const duplicate = new URL(correct);
  duplicate.searchParams.append("code", "second");
  assert.equal((await fetch(duplicate)).status, 400);
  const response = await fetch(correct);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.text()).includes("one-time-code"), false);
  assert.equal(await listener.code, "one-time-code");
  assert.equal((await fetch(correct)).status, 410);
});

test("loopback listener times out and supports cancellation", async () => {
  const listener = await createLoginListener(20);
  await assert.rejects(listener.code, /timed out/);
  await listener.close();
  const cancelled = await createLoginListener();
  await cancelled.close();
  await assert.rejects(cancelled.code, /cancelled/);
});

test("Convex OAuth cancellation without a code fails immediately", async (t) => {
  const listener = await createLoginListener(5000);
  t.after(listener.close);
  const response = await fetch(listener.redirectTo);
  assert.equal(response.status, 400);
  await assert.rejects(listener.code, /declined or failed/);
});

test("auth redirects cannot send the browser to a third-party origin", () => {
  assert.doesNotThrow(() =>
    validateAuthRedirect(
      "https://my-app.convex.site/api/auth/signin/github?code=x",
      "https://my-app.convex.cloud",
    ),
  );
  assert.throws(
    () =>
      validateAuthRedirect(
        "https://evil.example/api/auth/signin/github",
        "https://my-app.convex.cloud",
      ),
    /unexpected/,
  );
  assert.throws(
    () =>
      validateAuthRedirect(
        "https://my-app.convex.site/other",
        "https://my-app.convex.cloud",
      ),
    /unexpected/,
  );
  for (const url of [
    "http://evil.example",
    "https://user:password@example.com",
    "https://example.com/path",
  ])
    assert.throws(() => validateUrl(url, "API URL"));
});

test("real HTTP login exchanges a verifier-bound code and stores private credentials", async (t) => {
  const directory = await fixture(t);
  const oldDirectory = process.env.GITDOG_CONFIG_DIR;
  process.env.GITDOG_CONFIG_DIR = directory;
  t.after(() => {
    if (oldDirectory === undefined) delete process.env.GITDOG_CONFIG_DIR;
    else process.env.GITDOG_CONFIG_DIR = oldDirectory;
  });
  const tokens = { token: jwt(), refreshToken: "private-refresh-token" };
  let callback;
  const server = await mockServer(t, (call) => {
    if (call.path === "auth:signIn" && call.args.provider === "github") {
      callback = new URL(call.args.params.redirectTo);
      callback.searchParams.set("code", "exchanged-once");
      return {
        redirect: `${server.url}/api/auth/signin/github?code=verifier`,
        verifier: "verifier",
      };
    }
    if (call.path === "auth:signIn") {
      assert.equal(call.args.verifier, "verifier");
      assert.equal(call.args.params.code, "exchanged-once");
      return { tokens };
    }
    if (call.path === "users/query:getCurrentUser") {
      assert.equal(call.authorization, `Bearer ${tokens.token}`);
      return { name: "gitdog-user", requiresCurrentLegalAttestation: false };
    }
    throw new Error(call.path);
  });
  const ui = new CaptureUi();
  Object.defineProperty(ui, "json", { value: false });
  ui.banner = () => {};
  ui.info = (message) => {
    ui.messages.push(message);
    if (message.startsWith("Open this URL")) void fetch(callback);
  };
  await login(server.url, "https://gitdog.dev", ui, true);
  const store = new SessionStore();
  assert.deepEqual(await store.read(), {
    ...tokens,
    apiUrl: server.url,
    siteUrl: "https://gitdog.dev",
  });
  assert.equal((await stat(store.path)).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal(JSON.stringify(ui.values).includes(tokens.refreshToken), false);
  assert.equal(JSON.stringify(ui.values).includes(tokens.token), false);
  assert.ok(ui.messages.includes("Next: npx gitdog@latest init"));
});

test("concurrent expired clients rotate a refresh token only once", async (t) => {
  const directory = await fixture(t);
  const store = new SessionStore();
  Object.defineProperty(store, "path", {
    value: join(directory, "session.json"),
  });
  const tokens = { token: jwt(), refreshToken: "rotated-refresh" };
  let refreshes = 0;
  const server = await mockServer(t, async (call) => {
    if (call.path === "auth:signIn") {
      refreshes++;
      assert.equal(call.args.refreshToken, "original-refresh");
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { tokens };
    }
    assert.equal(call.authorization, `Bearer ${tokens.token}`);
    return { name: "user" };
  });
  await store.save({
    token: jwt(1),
    refreshToken: "original-refresh",
    apiUrl: server.url,
    siteUrl: "https://gitdog.dev",
  });
  const clients = [
    new GitdogApi(server.url, "https://gitdog.dev", store),
    new GitdogApi(server.url, "https://gitdog.dev", store),
  ];
  await Promise.all(
    clients.map((client) => client.call("query", "users/query:getCurrentUser")),
  );
  assert.equal(refreshes, 1);
  assert.equal((await store.read()).refreshToken, "rotated-refresh");
});

for (const phase of ["start", "exchange", "profile", "lock"]) {
  test(`Ctrl+C during login ${phase} preserves credentials and cancels the whole flow`, async (t) => {
    const directory = await fixture(t);
    const oldDirectory = process.env.GITDOG_CONFIG_DIR;
    process.env.GITDOG_CONFIG_DIR = directory;
    t.after(() => {
      if (oldDirectory === undefined) delete process.env.GITDOG_CONFIG_DIR;
      else process.env.GITDOG_CONFIG_DIR = oldDirectory;
    });
    const store = new SessionStore();
    const original = {
      token: jwt(),
      refreshToken: "existing-refresh",
      apiUrl: "https://existing.convex.cloud",
      siteUrl: "https://gitdog.dev",
    };
    await store.save(original);
    const tokens = { token: jwt(), refreshToken: "new-refresh" };
    let callback;
    const server = await mockServer(t, async (call) => {
      if (call.path === "auth:signIn" && call.args.provider === "github") {
        callback = new URL(call.args.params.redirectTo);
        callback.searchParams.set("code", "cancelled-code");
        if (phase === "start") {
          process.emit("SIGINT");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return {
          redirect: `${server.url}/api/auth/signin/github?code=verifier`,
          verifier: "verifier",
        };
      }
      if (call.path === "auth:signIn") {
        if (phase === "exchange") {
          process.emit("SIGINT");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return { tokens };
      }
      if (phase === "profile") {
        process.emit("SIGINT");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (phase === "lock") setTimeout(() => process.emit("SIGINT"), 20);
      return { name: "new-user" };
    });
    if (phase === "lock")
      await writeFile(`${store.path}.lock`, "another login owns this lock");
    const ui = new CaptureUi();
    Object.defineProperty(ui, "json", { value: false });
    ui.banner = () => {};
    ui.info = (message) => {
      ui.messages.push(message);
      if (message.startsWith("Open this URL")) void fetch(callback);
    };
    const signalHandlers = process.listenerCount("SIGINT");
    await assert.rejects(
      login(server.url, "https://gitdog.dev", ui, true),
      /cancelled/,
    );
    assert.deepEqual(await store.read(), original);
    assert.equal(process.listenerCount("SIGINT"), signalHandlers);
    assert.equal(ui.values.length, 0);
    if (phase === "start")
      assert(
        !ui.messages.some((message) => message.startsWith("Open this URL")),
      );
    if (phase === "lock")
      assert.equal(
        await readFile(`${store.path}.lock`, "utf8"),
        "another login owns this lock",
      );
  });
}

test("saved credentials are never sent to a different deployment", async (t) => {
  const directory = await fixture(t);
  const store = new SessionStore();
  Object.defineProperty(store, "path", {
    value: join(directory, "session.json"),
  });
  await store.save({
    token: jwt(),
    refreshToken: "refresh",
    apiUrl: "https://trusted.convex.cloud",
    siteUrl: "https://gitdog.dev",
  });
  let contacted = false;
  const server = await mockServer(t, () => {
    contacted = true;
    return {};
  });
  await assert.rejects(
    new GitdogApi(server.url, "https://gitdog.dev", store).call(
      "query",
      "users/query:getCurrentUser",
    ),
    /another API URL/,
  );
  assert.equal(contacted, false);
});

test("a failed refresh preserves the previous session for recovery", async (t) => {
  const directory = await fixture(t);
  const store = new SessionStore();
  Object.defineProperty(store, "path", {
    value: join(directory, "session.json"),
  });
  const server = await mockServer(t, () => {
    throw new Error("temporary failure");
  });
  const session = {
    token: jwt(1),
    refreshToken: "keep-me",
    apiUrl: server.url,
    siteUrl: "https://gitdog.dev",
  };
  await store.save(session);
  await assert.rejects(
    new GitdogApi(server.url, "https://gitdog.dev", store).call(
      "query",
      "users/query:getCurrentUser",
    ),
    /refresh/,
  );
  assert.deepEqual(await store.read(), session);
});

test("an already-authenticated client refreshes without sending its expired bearer", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const directory = await fixture(t);
  const store = new SessionStore();
  Object.defineProperty(store, "path", {
    value: join(directory, "session.json"),
  });
  const server = await mockServer(t, (call) => {
    if (call.path === "auth:signIn") {
      assert.equal(call.authorization, undefined);
      return { tokens: { token: jwt(), refreshToken: "new-refresh" } };
    }
    return { name: "user" };
  });
  await store.save({
    token: jwt(),
    refreshToken: "refresh",
    apiUrl: server.url,
    siteUrl: "https://gitdog.dev",
  });
  const api = new GitdogApi(server.url, "https://gitdog.dev", store);
  await api.call("query", "users/query:getCurrentUser");
  now += 2 * 60 * 60 * 1000;
  await api.call("query", "users/query:getCurrentUser");
  assert.equal((await store.read()).refreshToken, "new-refresh");
});

test("a per-call deadline includes token refresh", async (t) => {
  const directory = await fixture(t);
  const store = new SessionStore();
  Object.defineProperty(store, "path", {
    value: join(directory, "session.json"),
  });
  const server = await mockServer(t, async (call) => {
    if (call.path === "auth:signIn") {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { tokens: { token: jwt(), refreshToken: "new-token" } };
    }
    throw new Error("The data query must not run after its deadline.");
  });
  await store.save({
    token: jwt(1),
    refreshToken: "old-token",
    apiUrl: server.url,
    siteUrl: "https://gitdog.dev",
  });
  const api = new GitdogApi(server.url, "https://gitdog.dev", store);
  await assert.rejects(
    api.call("query", "users/query:getCurrentUser", {}, { timeoutMs: 10 }),
    /refresh|timed out/,
  );
  assert.equal(
    server.requests.some((call) => call.path === "users/query:getCurrentUser"),
    false,
  );
});

test("logout can clear damaged credentials locally", async (t) => {
  const directory = await fixture(t);
  const old = process.env.GITDOG_CONFIG_DIR;
  process.env.GITDOG_CONFIG_DIR = directory;
  t.after(() => {
    if (old === undefined) delete process.env.GITDOG_CONFIG_DIR;
    else process.env.GITDOG_CONFIG_DIR = old;
  });
  await writeFile(join(directory, "session.json"), "broken JSON");
  await logout(new CaptureUi(), true);
  await assert.rejects(readFile(join(directory, "session.json")), {
    code: "ENOENT",
  });
});

test("logout serializes revocation and clearing with a concurrent login", async (t) => {
  const directory = await fixture(t);
  const store = new SessionStore();
  Object.defineProperty(store, "path", {
    value: join(directory, "session.json"),
  });
  let entered;
  const requestStarted = new Promise((resolve) => {
    entered = resolve;
  });
  let release;
  const proceed = new Promise((resolve) => {
    release = resolve;
  });
  const server = await mockServer(t, async (call) => {
    assert.equal(call.path, "auth:signOut");
    entered();
    await proceed;
    return null;
  });
  const first = {
    token: jwt(),
    refreshToken: "first-refresh",
    apiUrl: server.url,
    siteUrl: "https://gitdog.dev",
  };
  await store.save(first);
  const signingOut = logout(new CaptureUi(), false, store);
  await requestStarted;
  const second = { ...first, refreshToken: "second-refresh" };
  const signingIn = store.locked(() => store.save(second));
  release();
  await Promise.all([signingOut, signingIn]);
  assert.equal((await store.read()).refreshToken, "second-refresh");
});

test("HTTP call deadlines abort requests instead of waiting for the default timeout", async (t) => {
  const directory = await fixture(t);
  const store = new SessionStore();
  Object.defineProperty(store, "path", {
    value: join(directory, "session.json"),
  });
  const server = await mockServer(t, async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    return {};
  });
  await store.save({
    token: jwt(),
    refreshToken: "refresh",
    apiUrl: server.url,
    siteUrl: "https://gitdog.dev",
  });
  const api = new GitdogApi(server.url, "https://gitdog.dev", store);
  await assert.rejects(
    api.call("query", "users/query:getCurrentUser", {}, { timeoutMs: 10 }),
    /timed out|timeout/i,
  );
});

test("a lock left by a dead process is recovered; a live owner is respected", async (t) => {
  const directory = await fixture(t);
  const store = new SessionStore();
  Object.defineProperty(store, "path", {
    value: join(directory, "session.json"),
  });
  const lock = `${store.path}.lock`;
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", ""]);
  await new Promise((resolve) => child.once("exit", resolve));
  await writeFile(lock, String(child.pid));
  assert.equal(await store.locked(async () => "ran"), "ran");
  await assert.rejects(stat(lock), { code: "ENOENT" });
  await writeFile(lock, String(process.ppid));
  await assert.rejects(
    store.locked(async () => "ran", Date.now() + 300),
    /another Gitdog process|lock timed out/i,
  );
  assert.equal(await readFile(lock, "utf8"), String(process.ppid));
});

test("stale recovery respects another cleaner and keeps waiting callbacks exclusive", async (t) => {
  const directory = await fixture(t);
  const store = new SessionStore();
  Object.defineProperty(store, "path", {
    value: join(directory, "session.json"),
  });
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", ""]);
  await new Promise((resolve) => child.once("exit", resolve));
  const lock = `${store.path}.lock`;
  await writeFile(lock, String(child.pid));
  await mkdir(`${lock}.recovery`);
  await assert.rejects(
    store.locked(
      async () => assert.fail("another cleaner owns recovery"),
      Date.now() + 150,
    ),
    /lock timed out/i,
  );
  assert.equal(await readFile(lock, "utf8"), String(child.pid));
  await rmdir(`${lock}.recovery`);
  let active = 0;
  let maximum = 0;
  await Promise.all(
    Array.from({ length: 8 }, () =>
      store.locked(async () => {
        maximum = Math.max(maximum, ++active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
      }),
    ),
  );
  assert.equal(maximum, 1);
  await assert.rejects(stat(lock), { code: "ENOENT" });
});
