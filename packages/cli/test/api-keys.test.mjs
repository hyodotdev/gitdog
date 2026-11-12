import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  saveProjectKey,
  readProjectKey,
  callWithProjectKey,
  assertUntrackedKeyPath,
} from "../dist/api-keys.js";
import { GitdogApi } from "../dist/client.js";
import { createProgram } from "../dist/commands.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { CaptureUi, fixture, repository } from "./helpers.mjs";

const secret = "gdk_" + "a".repeat(64);
const keyId = "a".repeat(32);
const run = promisify(execFile);
const entry = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const key = (url = "https://test.convex.cloud") => ({
  version: 1,
  apiKey: secret,
  apiUrl: url,
  httpUrl: url,
  keyId,
  repositoryId: repository._id,
  name: "CI",
  scopes: ["read"],
  expiresAt: Date.now() + 86400000,
});
async function server(t, handler) {
  const instance = createServer(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk;
    const result = await handler(req, JSON.parse(data));
    res.writeHead(result.status ?? 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.body));
  });
  await new Promise((resolve) => instance.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        instance.closeAllConnections();
        instance.close(resolve);
      }),
  );
  return `http://127.0.0.1:${instance.address().port}`;
}

test("private key files round-trip, use restrictive permissions and cannot overwrite existing files", async (t) => {
  const file = join(await fixture(t), "private", "ci.json");
  const credential = key();
  await saveProjectKey(file, credential);
  assert.deepEqual(await readProjectKey(file), credential);
  if (process.platform !== "win32")
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  await assert.rejects(saveProjectKey(file, key()), { code: "EEXIST" });
});

test("key creation saves the secret but outputs only metadata", async (t) => {
  const file = join(await fixture(t), "key.json");
  const ui = new CaptureUi();
  const calls = [];
  const api = {
    async call(kind, path, args) {
      calls.push({ kind, path, args });
      if (path === "repositories/query:get") return repository;
      return {
        keyId,
        key: secret,
        prefix: secret.slice(0, 12),
        scopes: ["read", "write"],
        expiresAt: 123456789,
      };
    },
  };
  await createProgram({ api, ui }).parseAsync(
    [
      "--project",
      "owner/repo",
      "keys",
      "create",
      "--name",
      "CI",
      "--write",
      "--expires-in",
      "7",
      "--out",
      file,
    ],
    { from: "user" },
  );
  assert.equal((await readProjectKey(file)).apiKey, secret);
  assert.equal(JSON.stringify(ui.values).includes(secret), false);
  assert.equal(JSON.stringify(ui.messages).includes(secret), false);
  assert.deepEqual(calls.at(-1).args, {
    repositoryId: repository._id,
    name: "CI",
    scopes: ["read", "write"],
    expiresInDays: 7,
  });
});

test("failed private file creation revokes the unusable issued key", async (t) => {
  const directory = await fixture(t);
  const file = join(directory, "key.json");
  const calls = [];
  const api = {
    async call(_kind, path) {
      calls.push(path);
      if (path === "repositories/query:get") return repository;
      if (path === "apiKeys/action:create")
        await writeFile(file, "concurrent file");
      return {
        keyId,
        key: secret,
        prefix: secret.slice(0, 12),
        scopes: ["read"],
        expiresAt: 123456789,
      };
    },
  };
  await assert.rejects(
    createProgram({ api, ui: new CaptureUi() }).parseAsync(
      ["--project", "owner/repo", "keys", "create", "--out", file],
      { from: "user" },
    ),
  );
  assert.equal(calls.at(-1), "apiKeys/mutation:revoke");
  assert.equal(await readFile(file, "utf8"), "concurrent file");
});

test("an existing output file is preserved before key issuance", async (t) => {
  const file = join(await fixture(t), "existing.json");
  await writeFile(file, "preserve");
  const calls = [];
  const api = {
    async call(_kind, path) {
      calls.push(path);
      return repository;
    },
  };
  await assert.rejects(
    createProgram({ api, ui: new CaptureUi() }).parseAsync(
      ["--project", "owner/repo", "keys", "create", "--out", file],
      { from: "user" },
    ),
    /already exists/,
  );
  assert.deepEqual(calls, ["repositories/query:get"]);
  assert.equal(await readFile(file, "utf8"), "preserve");
});

test("key-only HTTP calls work without a login session or bearer token", async (t) => {
  const url = await server(t, (req, body) => {
    assert.equal(req.url, "/v1/cli");
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers["x-gitdog-api-key"], secret);
    assert.deepEqual(body, {
      kind: "query",
      path: "repositories/query:list",
      args: {},
    });
    return { body: { value: [repository] } };
  });
  const file = join(await fixture(t), "key.json");
  await saveProjectKey(file, key(url));
  const api = new GitdogApi(
    url,
    "https://gitdog.dev",
    {
      async read() {
        throw new Error("Owner session must not be read");
      },
    },
    file,
  );
  assert.deepEqual(await api.call("query", "repositories/query:list"), [
    repository,
  ]);
});

test("revoked keys fail without falling back to an available owner session", async (t) => {
  const url = await server(t, () => ({
    status: 401,
    body: {
      error: {
        code: "UNAUTHORIZED",
        message: "Invalid, expired or revoked API key.",
      },
    },
  }));
  const file = join(await fixture(t), "key.json");
  await saveProjectKey(file, key(url));
  const api = new GitdogApi(
    url,
    "https://gitdog.dev",
    {
      async read() {
        throw new Error("Unsafe owner session fallback");
      },
    },
    file,
  );
  await assert.rejects(
    api.call("query", "repositories/query:list"),
    /revoked API key/,
  );
});

test("key files are origin-bound and account actions cannot consume them", async (t) => {
  const file = join(await fixture(t), "key.json");
  await saveProjectKey(file, key());
  await assert.rejects(
    callWithProjectKey(
      "https://other.convex.cloud",
      file,
      undefined,
      "query",
      "repositories/query:list",
      {},
      1000,
    ),
    /another API URL/,
  );
  await assert.rejects(
    callWithProjectKey(
      "https://test.convex.cloud",
      file,
      undefined,
      "action",
      "apiKeys/action:create",
      {},
      1000,
    ),
    /owner login/,
  );
});

test("key-file mode selects its own deployment for CLI requests", async (t) => {
  const file = join(await fixture(t), "key.json");
  await saveProjectKey(file, key("https://development.convex.cloud"));
  const ui = new CaptureUi();
  const api = {
    async call() {
      return [repository];
    },
  };
  await createProgram({ api, ui }).parseAsync(
    ["--key-file", file, "keys", "check"],
    { from: "user" },
  );
  assert.equal(ui.values[0].authenticated, true);
  assert.equal(JSON.stringify(ui.values).includes(secret), false);
});

test("generic API issuance cannot bypass private key output", async () => {
  let called = false;
  const api = {
    async call() {
      called = true;
      return { key: secret };
    },
  };
  await assert.rejects(
    createProgram({ api, ui: new CaptureUi() }).parseAsync(
      ["api", "call", "apiKeys/action:create", "--yes", "--data", "{}"],
      { from: "user" },
    ),
    /keys create/,
  );
  assert.equal(called, false);
});

test("parser errors and invalid revoke IDs never expose a key secret", async (t) => {
  const env = { ...process.env, GITDOG_CONFIG_DIR: await fixture(t) };
  for (const args of [
    [secret],
    ["keys", "revoke", secret],
    ["--json", secret],
  ]) {
    await assert.rejects(
      run(process.execPath, [entry, ...args], { env }),
      (error) => {
        assert.equal(error.stdout, "");
        assert.equal(error.stderr.includes(secret), false);
        return true;
      },
    );
  }
});

test("key-only init and doctor work without an owner session", async (t) => {
  const url = await server(t, () => ({ body: { value: repository } }));
  const directory = await fixture(t);
  const file = join(directory, "credential.json");
  const project = join(directory, "gitdog.json");
  await saveProjectKey(file, key(url));
  const env = {
    ...process.env,
    GITDOG_CONFIG_DIR: join(directory, "no-owner"),
  };
  delete env.GITDOG_TOKEN;
  delete env.GITDOG_API_KEY;
  delete env.GITDOG_API_KEY_FILE;
  const initialized = await run(
    process.execPath,
    [
      entry,
      "--json",
      "--key-file",
      file,
      "--config",
      project,
      "init",
      "owner/repo",
    ],
    { env },
  );
  assert.equal(JSON.parse(initialized.stdout).initialized, true);
  const doctor = await run(
    process.execPath,
    [entry, "--json", "--key-file", file, "doctor"],
    { env },
  );
  assert.equal(JSON.parse(doctor.stdout).authentication, "project API key");
  assert.equal(doctor.stdout.includes(secret), false);
});

test("malformed credential files fail with no secret disclosure", async (t) => {
  const file = join(await fixture(t), "invalid.json");
  await writeFile(
    file,
    JSON.stringify({ ...key(), apiUrl: "http://external.example" }),
  );
  await assert.rejects(
    readProjectKey(file),
    (error) =>
      !error.message.includes(secret) && /HTTPS origin/.test(error.message),
  );
});

test("key files are never written where Git would track them", async (t) => {
  const directory = await fixture(t);
  await promisify(execFile)("git", ["init", "-q", directory]);
  await writeFile(join(directory, ".gitignore"), "ignored.json\n");
  const calls = [];
  const api = {
    async call(_kind, path) {
      calls.push(path);
      if (path === "repositories/query:get") return repository;
      return {
        keyId,
        key: secret,
        prefix: secret.slice(0, 12),
        scopes: ["read"],
        expiresAt: 123456789,
      };
    },
  };
  await assert.rejects(
    createProgram({ api, ui: new CaptureUi() }).parseAsync(
      [
        "--project",
        "owner/repo",
        "keys",
        "create",
        "--out",
        join(directory, "config", "key.json"),
      ],
      { from: "user" },
    ),
    /inside a Git repository/,
  );
  assert.deepEqual(calls, ["repositories/query:get"]);
  await createProgram({ api, ui: new CaptureUi() }).parseAsync(
    [
      "--project",
      "owner/repo",
      "keys",
      "create",
      "--out",
      join(directory, "ignored.json"),
    ],
    { from: "user" },
  );
  assert.equal(calls.at(-1), "apiKeys/action:create");
});

test("key path checks follow directory symlinks and fail closed on Git errors", async (t) => {
  const root = await fixture(t);
  const directory = join(root, "repo");
  await run("git", ["init", "-q", directory]);
  const alias = join(root, "alias");
  await symlink(directory, alias, "dir");
  await assert.rejects(
    assertUntrackedKeyPath(join(alias, "nested", "secret.json")),
    /inside a Git repository/,
  );
  await writeFile(join(directory, ".gitignore"), "private/\n");
  await assertUntrackedKeyPath(join(alias, "private", "secret.json"));
  await writeFile(join(directory, ".git", "config"), "[broken\n");
  await assert.rejects(
    assertUntrackedKeyPath(join(directory, "secret.json")),
    /Could not verify/,
  );
});
