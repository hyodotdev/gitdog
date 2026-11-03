import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ProjectContext,
  findConfig,
  validateProjectConfig,
  validateSettings,
} from "../dist/projects.js";
import { CaptureUi, fixture, repository, settings } from "./helpers.mjs";

function apiFixture() {
  const calls = [];
  const repo = structuredClone(repository);
  return {
    repo,
    calls,
    async call(kind, path, args = {}) {
      calls.push({ kind, path, args: structuredClone(args) });
      switch (path) {
        case "repositories/query:get":
        case "repositories/query:getById":
          return structuredClone(repo);
        case "repositories/mutation:updateSettings":
          repo.settings = structuredClone(args.settings);
          return repo._id;
        default:
          throw new Error(`Unexpected API call ${path}`);
      }
    },
  };
}

test("init connects a project, creates portable configuration, and refuses accidental overwrite", async (t) => {
  const directory = await fixture(t);
  const config = join(directory, "gitdog.json");
  const api = apiFixture();
  const project = new ProjectContext(api, new CaptureUi(), undefined, config);
  await project.init("owner/repo");
  const saved = JSON.parse(await readFile(config, "utf8"));
  assert.equal(saved.defaultProject, "default");
  assert.equal(saved.projects.default.repository, "owner/repo");
  assert.deepEqual(saved.projects.default.settings, settings);
  assert.equal("token" in saved, false);
  await assert.rejects(project.init("owner/repo"), /already exists/);
});

test("project discovery works in nested directories", async (t) => {
  const directory = await fixture(t);
  const nested = join(directory, "packages", "app");
  await mkdir(nested, { recursive: true });
  await writeFile(join(directory, "gitdog.json"), "{}");
  assert.equal(
    await findConfig(undefined, nested),
    join(directory, "gitdog.json"),
  );
});

test("init preserves existing falsy JSON configuration without --force", async (t) => {
  const config = join(await fixture(t), "gitdog.json");
  for (const content of ["null", "false", "0"]) {
    await writeFile(config, content);
    await assert.rejects(
      new ProjectContext(apiFixture(), new CaptureUi(), undefined, config).init(
        "owner/repo",
      ),
      /already exists/,
    );
    assert.equal(await readFile(config, "utf8"), content);
  }
});

test("local edits never mutate the server; dry-run and verified push preserve unrelated settings", async (t) => {
  const config = join(await fixture(t), "gitdog.json");
  const api = apiFixture();
  const ui = new CaptureUi();
  const project = new ProjectContext(api, ui, undefined, config);
  await project.init("owner/repo");
  await project.configSet("requireApproval", "false");
  await project.configSet(
    "issueResponseStyle",
    "Be concise and answer in Korean.",
  );
  assert.equal(
    api.calls.some((call) => call.kind === "mutation"),
    false,
  );
  await project.configPush(true);
  assert.equal(
    api.calls.some((call) => call.kind === "mutation"),
    false,
  );
  assert.equal(ui.values.at(-1).changes.length, 2);
  await assert.rejects(project.configPush(), /Confirmation required/);
  await project.configPush(false, true);
  assert.equal(api.repo.settings.requireApproval, false);
  assert.equal(api.repo.settings.autoAnswerQuestions, true);
  assert.equal(ui.values.at(-1).applied, true);
  await project.configPush(false, true);
  assert.equal(api.calls.filter((call) => call.kind === "mutation").length, 1);
});

test("rejects invalid settings and poisoned aliases", () => {
  assert.throws(
    () => validateSettings({ requireApproval: "false" }),
    /true or false/,
  );
  assert.throws(() => validateSettings({ unknownSetting: true }), /Unknown/);
  assert.throws(
    () => validateSettings({ issueResponseStyle: false }),
    /string/,
  );
  assert.throws(
    () =>
      validateProjectConfig(
        JSON.parse(
          '{"version":1,"defaultProject":"__proto__","projects":{"__proto__":{"repository":"owner/repo"}}}',
        ),
      ),
    /aliases/,
  );
  assert.throws(
    () =>
      validateProjectConfig({
        version: 1,
        defaultProject: "missing",
        projects: {},
      }),
    /Invalid/,
  );
});

test("partial local configuration merges with the current server state", async (t) => {
  const config = join(await fixture(t), "gitdog.json");
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      defaultProject: "prod",
      projects: {
        prod: {
          repository: "owner/repo",
          settings: { requireApproval: false },
        },
      },
    }),
  );
  const api = apiFixture();
  api.repo.settings.discussionResponseStyle = "Keep this remote value.";
  await new ProjectContext(api, new CaptureUi(), "prod", config).configPush(
    false,
    true,
  );
  assert.equal(api.repo.settings.requireApproval, false);
  assert.equal(
    api.repo.settings.discussionResponseStyle,
    "Keep this remote value.",
  );
});

test("use adds aliases and changing the default stays local", async (t) => {
  const config = join(await fixture(t), "gitdog.json");
  const api = apiFixture();
  const project = new ProjectContext(api, new CaptureUi(), undefined, config);
  await project.init("owner/repo");
  await project.use("owner/repo", "production");
  assert.equal((await project.config()).value.defaultProject, "production");
  await project.use("default");
  assert.equal((await project.config()).value.defaultProject, "default");
  await assert.rejects(project.use("missing"), /Unknown alias/);
  await assert.rejects(project.use("owner/repo", "default"), /already exists/);
  assert.equal(
    api.calls.every((call) => call.kind === "query"),
    true,
  );
});

test("project creation follows all available pages and uses immutable GitHub IDs", async () => {
  const calls = [];
  let connected = false;
  const api = {
    async call(kind, path, args) {
      calls.push({ kind, path, args });
      switch (path) {
        case "repositories/query:get":
          return connected ? repository : null;
        case "github/action:listUserRepositories":
          return args.cursor
            ? {
                repositories: [
                  { fullName: "OWNER/REPO", id: 55, installationId: 99 },
                ],
                continueCursor: null,
              }
            : { repositories: [], continueCursor: "page2" };
        case "repositories/action:createAndIndex":
          connected = true;
          return "new-id";
        default:
          throw new Error(path);
      }
    },
  };
  const result = await new ProjectContext(api, new CaptureUi()).connect(
    "owner/repo",
  );
  assert.equal(result.githubRepo, "owner/repo");
  assert.deepEqual(
    calls.find((call) => call.path.endsWith("createAndIndex")).args,
    { installationId: 99, githubRepositoryId: 55 },
  );
});

test("pagination detects repeated cursors instead of looping forever", async () => {
  const api = {
    async call() {
      return { repositories: [], continueCursor: "repeated" };
    },
  };
  await assert.rejects(
    new ProjectContext(api, new CaptureUi()).available(),
    /repeated/,
  );
});

test("explicit project override never depends on cwd or a local alias", async () => {
  const api = apiFixture();
  const project = new ProjectContext(api, new CaptureUi(), "owner/repo");
  assert.equal((await project.repository())._id, repository._id);
  assert.deepEqual(api.calls[0].args, { owner: "owner", repo: "repo" });
});

test("project discovery stops at the repository root", async (t) => {
  const directory = await fixture(t);
  const checkout = join(directory, "checkout");
  const nested = join(checkout, "src");
  await mkdir(join(checkout, ".git"), { recursive: true });
  await mkdir(nested, { recursive: true });
  await writeFile(join(directory, "gitdog.json"), "{}");
  assert.equal(await findConfig(undefined, nested), undefined);
  await writeFile(join(checkout, "gitdog.json"), "{}");
  assert.equal(
    await findConfig(undefined, nested),
    join(checkout, "gitdog.json"),
  );
});

test("PR review settings accept old server defaults and strict booleans", () => {
  const legacy = Object.fromEntries(
    Object.entries(settings).filter(
      ([k]) =>
        ![
          "pullRequestReviewsEnabled",
          "pullRequestSuggestionsEnabled",
          "requireApprovalForPullRequests",
        ].includes(k),
    ),
  );
  const current = validateSettings(legacy, true);
  assert.equal(current.pullRequestReviewsEnabled, false);
  assert.equal(current.pullRequestSuggestionsEnabled, true);
  assert.equal(current.requireApprovalForPullRequests, true);
  assert.deepEqual(
    validateSettings({
      pullRequestReviewsEnabled: true,
      requireApprovalForPullRequests: false,
    }),
    { pullRequestReviewsEnabled: true, requireApprovalForPullRequests: false },
  );
  assert.throws(
    () => validateSettings({ pullRequestReviewsEnabled: "true" }),
    /true or false/,
  );
});
