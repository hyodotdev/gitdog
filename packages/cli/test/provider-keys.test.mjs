import { test } from "node:test";
import assert from "node:assert/strict";
import { createProgram } from "../dist/commands.js";
import { CaptureUi } from "./helpers.mjs";

const SECRET = `sk-proj-${"s".repeat(40)}`;

class KeyUi extends CaptureUi {
  secretPrompts = [];
  constructor({ secret, stdin } = {}) {
    super();
    this.secretValue = secret;
    this.stdinValue = stdin;
  }
  async secret(question) {
    this.secretPrompts.push(question);
    if (this.secretValue === undefined) throw new Error("No terminal.");
    return this.secretValue;
  }
  async readStdin() {
    if (this.stdinValue === undefined) throw new Error("Nothing piped.");
    return this.stdinValue;
  }
}

function recordingApi(handler = () => ({})) {
  const calls = [];
  return {
    calls,
    async call(kind, path, args) {
      calls.push({ kind, path, args });
      return handler({ kind, path, args });
    },
  };
}

const run = (api, ui, argv) =>
  createProgram({ api, ui }).parseAsync(argv, { from: "user" });

test("provider-keys list shows metadata and flags unreadable keys", async () => {
  const ui = new KeyUi();
  const api = recordingApi(() => [
    {
      provider: "anthropic",
      last4: "abcd",
      status: "active",
      readable: false,
      lastValidatedAt: Date.UTC(2026, 10, 1),
      lastErrorCode: null,
    },
    {
      provider: "openai",
      last4: "wxyz",
      status: "out_of_credit",
      readable: true,
      lastValidatedAt: Date.UTC(2026, 10, 2),
      lastErrorCode: "out_of_credit",
    },
  ]);
  await run(api, ui, ["provider-keys", "list"]);
  assert.deepEqual(api.calls, [
    { kind: "query", path: "providerApiKeys/query:list", args: undefined },
  ]);
  assert.deepEqual(ui.values[0], [
    {
      provider: "anthropic",
      key: "…abcd",
      status: "unreadable",
      lastChecked: "2026-11-01T00:00:00.000Z",
      lastError: null,
    },
    {
      provider: "openai",
      key: "…wxyz",
      status: "out_of_credit",
      lastChecked: "2026-11-02T00:00:00.000Z",
      lastError: "out_of_credit",
    },
  ]);
});

test("provider-keys set reads the key from a hidden prompt and never prints it", async () => {
  const ui = new KeyUi({ secret: SECRET });
  const api = recordingApi(() => ({
    provider: "openai",
    last4: SECRET.slice(-4),
    status: "active",
  }));
  await run(api, ui, ["ai-keys", "set", "openai"]);
  assert.deepEqual(ui.secretPrompts, ["OpenAI API key"]);
  assert.deepEqual(api.calls, [
    {
      kind: "action",
      path: "providerApiKeys/action:save",
      args: { provider: "openai", apiKey: SECRET },
    },
  ]);
  assert.deepEqual(ui.values, [
    { provider: "openai", key: `…${SECRET.slice(-4)}`, status: "active" },
  ]);
  assert.ok(!JSON.stringify([ui.values, ui.messages]).includes(SECRET));
});

test("provider-keys set --stdin reads a piped key", async () => {
  const ui = new KeyUi({ stdin: SECRET });
  const api = recordingApi(() => ({
    provider: "openai",
    last4: "ssss",
    status: "active",
  }));
  await run(api, ui, ["provider-keys", "set", "openai", "--stdin"]);
  assert.equal(api.calls[0].args.apiKey, SECRET);
  assert.deepEqual(ui.secretPrompts, []);
});

test("provider-keys set refuses a key in argv and non-interactive use without --stdin", async () => {
  const api = recordingApi();
  await assert.rejects(
    run(api, new KeyUi({ secret: SECRET }), [
      "provider-keys",
      "set",
      "openai",
      SECRET,
    ]),
    (error) =>
      /Never pass an API key/.test(error.message) &&
      !error.message.includes(SECRET),
  );
  // The real prompt needs a terminal; tests run without one.
  await assert.rejects(
    run(api, new CaptureUi(), ["provider-keys", "set", "openai"]),
    /--stdin/,
  );
  await assert.rejects(
    run(api, new KeyUi({ secret: SECRET }), ["provider-keys", "set", "gemini"]),
    /anthropic or openai/,
  );
  assert.deepEqual(api.calls, []);
});

test("provider-keys maps server reasons to clear messages", async () => {
  for (const [reason, message] of [
    ["invalid_key", /rejected this API key/],
    ["wrong_provider", /other provider/],
    ["rate_limited", /few minutes/],
    ["not_configured", /cannot store API keys/],
    ["no_model_access", /no access to the model/],
    ["unreadable", /enter it again/],
  ]) {
    const api = recordingApi(() => {
      throw Object.assign(new Error("server error"), {
        data: { code: "BAD_REQUEST", reason, message: "raw" },
      });
    });
    await assert.rejects(
      run(api, new KeyUi({ secret: SECRET }), [
        "provider-keys",
        "set",
        "openai",
      ]),
      message,
    );
  }
});

test("provider-keys check and remove call the public operations", async () => {
  const ui = new KeyUi();
  const api = recordingApi(({ path }) =>
    path.endsWith("revalidate")
      ? { provider: "anthropic", status: "active" }
      : { removed: true, provider: "anthropic" },
  );
  await run(api, ui, ["provider-keys", "check", "anthropic"]);
  await assert.rejects(
    run(api, ui, ["provider-keys", "remove", "anthropic"]),
    /Confirmation required/,
  );
  await run(api, ui, ["provider-keys", "remove", "anthropic", "--yes"]);
  assert.deepEqual(
    api.calls.map((call) => [call.path, call.args]),
    [
      ["providerApiKeys/action:revalidate", { provider: "anthropic" }],
      ["providerApiKeys/mutation:remove", { provider: "anthropic" }],
    ],
  );
  assert.deepEqual(ui.confirmations, [
    "Remove your Anthropic API key from Gitdog?",
    "Remove your Anthropic API key from Gitdog?",
  ]);
});
