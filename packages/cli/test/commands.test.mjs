import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  createProgram,
  normalizeArgv,
  jsonArguments,
} from "../dist/commands.js";
import { API_CATALOG, publicOperation } from "../dist/catalog.js";
import { VERSION, clean, safeJson } from "../dist/ui.js";
import { CaptureUi, fixture, repository } from "./helpers.mjs";

const run = promisify(execFile);
const entry = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

for (const desired of [true, false]) {
  test(`concurrent projects ${desired ? "enable" : "disable"} submits the desired server state`, async () => {
    let state = !desired;
    let reads = 0;
    let release;
    const bothRead = new Promise((resolve) => {
      release = resolve;
    });
    const writes = [];
    const api = {
      async call(_kind, path, args) {
        if (path === "repositories/query:get") {
          if (reads++ < 2) {
            const snapshot = { ...repository, isActive: state };
            if (reads === 2) release();
            await bothRead;
            return snapshot;
          }
          return { ...repository, isActive: state };
        }
        assert.equal(path, "repositories/mutation:toggleActive");
        assert.equal(args.isActive, desired);
        writes.push(args);
        state = args.isActive;
        return repository._id;
      },
    };
    await Promise.all(
      [1, 2].map(() =>
        createProgram({ api, ui: new CaptureUi() }).parseAsync(
          [
            "--project",
            "owner/repo",
            "--yes",
            "projects",
            desired ? "enable" : "disable",
          ],
          { from: "user" },
        ),
      ),
    );
    assert.equal(state, desired);
    assert.equal(writes.length, 2);
  });
}

const scenarios = [
  ["whoami", "query", "users/query:getCurrentUser", {}],
  ["projects list", "query", "repositories/query:list", {}],
  [
    "projects sync",
    "action",
    "repositories/action:syncRepository",
    { repositoryId: repository._id },
  ],
  [
    "index status --wait",
    "query",
    "repoIndexing/query:getIndexingStatus",
    { repositoryId: repository._id },
  ],
  [
    "index logs --limit 7",
    "query",
    "repoIndexing/query:getIndexingLogs",
    { repositoryId: repository._id, limit: 7 },
  ],
  [
    "index file src/index.ts",
    "query",
    "repoIndexing/query:getFileContent",
    { repositoryId: repository._id, filePath: "src/index.ts" },
  ],
  [
    "index restart",
    "mutation",
    "repoIndexing/mutation:initializeIndexing",
    { repositoryId: repository._id },
  ],
  [
    "index learnings",
    "query",
    "repoLearnings/query:countByRepository",
    { repositoryId: repository._id },
  ],
  [
    "tickets list --status open --type issue --search bug --limit 4 --offset 2",
    "query",
    "tickets/query:list",
    {
      githubRepo: "owner/repo",
      status: "open",
      ticketType: "issue",
      search: "bug",
      limit: 4,
      offset: 2,
    },
  ],
  [
    "tickets pending --all --type pull_request",
    "query",
    "tickets/query:listPendingApproval",
    { ticketType: "pull_request", limit: 20, offset: 0 },
  ],
  [
    "tickets pending --all --type discussion",
    "query",
    "tickets/query:listPendingApproval",
    { ticketType: "discussion", limit: 20, offset: 0 },
  ],
  [
    "tickets get ticket-id",
    "query",
    "tickets/query:getById",
    { id: "ticket-id" },
  ],
  [
    "tickets delete ticket-id",
    "mutation",
    "tickets/mutation:softDelete",
    { id: "ticket-id" },
  ],
  [
    "tickets restore ticket-id",
    "mutation",
    "tickets/mutation:restore",
    { id: "ticket-id" },
  ],
  [
    "actions list ticket-id",
    "query",
    "ticketActions/query:listByTicket",
    { ticketId: "ticket-id" },
  ],
  [
    "actions approve action-id",
    "action",
    "ticketActions/action:approve",
    { actionId: "action-id" },
  ],
  [
    "actions reject action-id",
    "action",
    "ticketActions/action:reject",
    { actionId: "action-id" },
  ],
  [
    "notifications list --unread",
    "query",
    "notifications/query:listUnread",
    {},
  ],
  [
    "notifications read-all",
    "mutation",
    "notifications/mutation:markAllAsRead",
    {},
  ],
  [
    "team members",
    "query",
    "repositoryMembers/query:list",
    { repositoryId: repository._id },
  ],
  [
    "team invite friend",
    "action",
    "invitations/action:create",
    {
      repositoryId: repository._id,
      inviteeGithubUsername: "friend",
      role: "viewer",
    },
  ],
  [
    "team role",
    "query",
    "repositoryMembers/query:getMyRole",
    { repositoryId: repository._id },
  ],
  [
    "team leave",
    "mutation",
    "repositoryMembers/mutation:leave",
    { repositoryId: repository._id },
  ],
  [
    "invitations accept invitation-id",
    "mutation",
    "invitations/mutation:accept",
    { invitationId: "invitation-id" },
  ],
  ["usage summary", "query", "tokenUsage/query:getCurrentMonthUsage", {}],
  ["usage projects", "query", "tokenUsage/query:getUsageByRepository", {}],
  ["billing status", "query", "subscriptions/query:getCurrent", {}],
  ["billing pricing", "query", "subscriptions/query:getPricingInfo", {}],
  ["github installations", "query", "github/query:getUserInstallations", {}],
  [
    "github bind 1234",
    "action",
    "github/action:saveInstallation",
    { installationId: 1234 },
  ],
  [
    "github retry 1234",
    "action",
    "github/action:retryRepositoryAccessReconciliation",
    { installationId: 1234 },
  ],
  ["account sync", "action", "users/action:ensureProfile", {}],
  ["admin status", "query", "admin/query:isAdmin", {}],
  [
    "admin logs --limit 4 --cursor next",
    "query",
    "admin/query:listAiLogs",
    { limit: 4, cursor: "next" },
  ],
];

for (const [input, expectedKind, expectedPath, expectedArgs] of scenarios) {
  test(`command maps to the public API: ${input}`, async () => {
    const calls = [];
    const api = {
      async call(kind, path, args = {}) {
        assert.equal(publicOperation(path).kind, kind);
        calls.push({ kind, path, args });
        if (
          ["repositories/query:get", "repositories/query:getById"].includes(
            path,
          )
        )
          return repository;
        if (path === "repoIndexing/query:getIndexingStatus")
          return { status: "completed", ragStatus: "completed" };
        return { success: true };
      },
    };
    const ui = new CaptureUi();
    const program = createProgram({ api, ui });
    await program.parseAsync(
      ["--yes", "--project", "owner/repo", ...input.split(" ")],
      { from: "user" },
    );
    assert.deepEqual(calls.at(-1), {
      kind: expectedKind,
      path: expectedPath,
      args: expectedArgs,
    });
  });
}

test("mutation confirmation happens before a GitHub action executes", async () => {
  let called = false;
  const api = {
    async call() {
      called = true;
    },
  };
  const program = createProgram({ api, ui: new CaptureUi() });
  await assert.rejects(
    program.parseAsync(["actions", "approve", "id"], { from: "user" }),
    /Confirmation required/,
  );
  assert.equal(called, false);
});

test("API escape hatch excludes internal operations and passes explicit public arguments", async () => {
  const calls = [];
  const api = {
    async call(...args) {
      calls.push(args);
      return {};
    },
  };
  const ui = new CaptureUi();
  await createProgram({ api, ui }).parseAsync(
    ["api", "call", "tickets/query:list", "--data", '{"limit":3}'],
    { from: "user" },
  );
  assert.deepEqual(calls[0], ["query", "tickets/query:list", { limit: 3 }]);
  await assert.rejects(
    createProgram({ api, ui }).parseAsync(
      ["api", "call", "repositories/internalMutation:delete"],
      { from: "user" },
    ),
    /Unknown public/,
  );
  assert.equal(calls.length, 1);
});

test("JSON argument files preserve newlines and reject arrays", async (t) => {
  const path = join(await fixture(t), "args.json");
  await writeFile(
    path,
    JSON.stringify({
      feedback: "Line one\nLine two with `literal` and $(text).",
    }),
  );
  assert.deepEqual(await jsonArguments(`@${path}`), {
    feedback: "Line one\nLine two with `literal` and $(text).",
  });
  await assert.rejects(jsonArguments("[]"), /JSON object/);
  await assert.rejects(jsonArguments("broken"), /JSON object/);
});

test("Firebase-style colon aliases only rewrite the command token", () => {
  assert.deepEqual(
    normalizeArgv(["--project", "owner/repo", "projects:list", "--json"]),
    ["--project", "owner/repo", "projects", "list", "--json"],
  );
  assert.deepEqual(
    normalizeArgv(["--config", "projects:list", "projects:list"]),
    ["--config", "projects:list", "projects", "list"],
  );
  assert.deepEqual(
    normalizeArgv(["actions", "request-changes", "id", "api:call"]),
    ["actions", "request-changes", "id", "api:call"],
  );
});

test("terminal output strips control characters from untrusted content", () => {
  assert.equal(
    clean("safe\x1b]52;c;YXR0YWNr\x07\x1b[31mred\x1b[0m\rtext"),
    "saferedtext",
  );
});

test("mascot onboarding, help, version and machine output run under Node", async (t) => {
  const directory = await fixture(t);
  const env = { ...process.env, GITDOG_CONFIG_DIR: directory, NO_COLOR: "1" };
  delete env.GITDOG_TOKEN;
  const banner = await run(process.execPath, [entry], { env });
  assert.match(banner.stdout, /G I T D O G/);
  assert.match(banner.stdout, /[█▄▀▙▟]/u);
  assert.doesNotMatch(banner.stdout, /\ufffd/u);
  assert.match(banner.stdout, /npx gitdog@latest init/);
  const json = await run(process.execPath, [entry, "--json"], { env });
  assert.equal(JSON.parse(json.stdout).version, VERSION);
  assert.equal(json.stderr, "");
  const version = await run(process.execPath, [entry, "--version"], { env });
  assert.equal(version.stdout.trim(), VERSION);
  const help = await run(process.execPath, [entry, "projects:list", "--help"], {
    env,
  });
  assert.match(help.stdout, /List owned and shared/);
  const onboardingHelp = await run(process.execPath, [entry, "--help"], {
    env,
  });
  assert.match(onboardingHelp.stdout, /npx gitdog@latest login/);
});

test("JSON errors have a nonzero exit status and never print a banner", async (t) => {
  const directory = await fixture(t);
  const env = { ...process.env, GITDOG_CONFIG_DIR: directory };
  delete env.GITDOG_TOKEN;
  for (const args of [
    ["--json", "missing-command"],
    ["--json", "tickets", "list", "--limit", "1oops"],
    ["--json", "whoami"],
  ]) {
    await assert.rejects(
      run(process.execPath, [entry, ...args], { env }),
      (error) => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, "");
        assert.equal(typeof JSON.parse(error.stderr).error.message, "string");
        return true;
      },
    );
  }
});

test("all catalog paths are unique public functions and version matches the npm package", async () => {
  assert.equal(
    new Set(API_CATALOG.map((entry) => entry.path)).size,
    API_CATALOG.length,
  );
  assert.equal(API_CATALOG.length, 91);
  assert.equal(
    API_CATALOG.every(
      (entry) =>
        !entry.path.includes("internal") &&
        ["query", "mutation", "action"].includes(entry.kind),
    ),
    true,
  );
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(VERSION, pkg.version);
});

test("sync failures are reported as failures rather than successful commands", async () => {
  const api = {
    async call(_kind, path) {
      return path.endsWith(":get")
        ? repository
        : { success: false, message: "Access was revoked." };
    },
  };
  await assert.rejects(
    createProgram({ api, ui: new CaptureUi() }).parseAsync(
      ["--project", "owner/repo", "projects", "sync"],
      { from: "user" },
    ),
    /Access was revoked/,
  );
});

test("table output retains the next-page cursor", () => {
  const ui = new CaptureUi();
  ui.json = false;
  ui.table = () => {};
  Object.getPrototypeOf(Object.getPrototypeOf(ui)).output.call(ui, {
    items: [{ name: "Log" }],
    hasMore: true,
    nextCursor: "next-page",
  });
  assert.match(ui.messages.at(-1), /--cursor "next-page"/);
});

test("admin page sizes match the backend's 100-record limit", async () => {
  for (const name of ["logs", "payments", "subscriptions"]) {
    const program = createProgram({
      api: {
        async call() {
          throw new Error("Must not call API");
        },
      },
      ui: new CaptureUi(),
    }).exitOverride();
    program.configureOutput({ writeErr: () => {} });
    await assert.rejects(
      program.parseAsync(["admin", name, "--limit", "101"], { from: "user" }),
      /between 1 and 100/,
    );
  }
});

test("index polling passes the remaining deadline into each request", async () => {
  const api = {
    async call(_kind, path, _args, options) {
      if (path.endsWith(":get")) return repository;
      assert.equal(options.timeoutMs <= 1000 && options.timeoutMs > 0, true);
      return { status: "completed", ragStatus: "completed" };
    },
  };
  await createProgram({ api, ui: new CaptureUi() }).parseAsync(
    ["--project", "owner/repo", "index", "status", "--wait", "--timeout", "1"],
    { from: "user" },
  );
});

test("C1 controls and bidi overrides never reach the terminal raw", () => {
  const hostile = "a\u009b31mb\u009d8;;x\u009cc‮d⁦e";
  assert.equal(clean(hostile), "ab8;;xcde");
  const json = safeJson({ title: hostile });
  assert.equal(/[\u0080-\u009f‪-‮⁦-⁩]/.test(json), false);
  assert.deepEqual(JSON.parse(json), { title: hostile });
});
