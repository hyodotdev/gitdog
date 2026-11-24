import { test } from "node:test";
import assert from "node:assert/strict";
import { createProgram } from "../dist/commands.js";
import { CaptureUi } from "./helpers.mjs";
import { Ui, singleSecretLine, redactSecrets } from "../dist/ui.js";

const SECRET = `sk-proj-${"s".repeat(40)}`;

class KeyUi extends CaptureUi {
  secretPrompts = [];
  warnings = [];
  warn(message) {
    this.warnings.push(message);
  }
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
  const api = recordingApi(({ path }) =>
    path.endsWith("query:priority")
      ? null
      : [
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
        ],
  );
  await run(api, ui, ["provider-keys", "list"]);
  assert.deepEqual(api.calls, [
    { kind: "query", path: "providerApiKeys/query:list", args: undefined },
    { kind: "query", path: "providerApiKeys/query:priority", args: undefined },
  ]);
  assert.deepEqual(ui.values[0], [
    {
      provider: "anthropic",
      key: "…abcd",
      model: null,
      effort: null,
      status: "unreadable",
      role: null,
      lastChecked: "2026-11-01T00:00:00.000Z",
      lastError: null,
    },
    {
      provider: "openai",
      key: "…wxyz",
      model: null,
      effort: null,
      status: "out_of_credit",
      role: null,
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
    ["no_model_access", /no access to the chosen model/],
    ["unknown_model", /provider-keys models/],
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

test("provider-keys set never echoes a key passed through an unknown option", async () => {
  const api = recordingApi();
  for (const argv of [
    ["provider-keys", "set", "anthropic", `--key=${SECRET}`],
    ["provider-keys", "set", "anthropic", "--key", SECRET],
  ]) {
    await assert.rejects(
      createProgram({ api, ui: new KeyUi({ secret: SECRET }) })
        .exitOverride()
        .parseAsync(argv, { from: "user" }),
      (error) =>
        /Never pass an API key/.test(error.message) &&
        !error.message.includes(SECRET),
    );
  }
  assert.deepEqual(api.calls, []);
});

test("piped keys must be a single line", () => {
  assert.equal(singleSecretLine(`\n  ${SECRET}  \n\n`), SECRET);
  assert.equal(singleSecretLine(""), "");
  assert.throws(
    () => singleSecretLine(`${SECRET}\nsecond line`),
    /exactly one line/,
  );
});

test("provider-keys list prints every column for people", async () => {
  class TableUi extends Ui {
    tables = [];
    constructor() {
      super(false);
    }
    table(rows, keys) {
      this.tables.push({ rows: structuredClone(rows), keys });
    }
  }
  const ui = new TableUi();
  const api = recordingApi(({ path }) =>
    path.endsWith("query:priority")
      ? null
      : [
          {
            provider: "openai",
            last4: "wxyz",
            status: "active",
            readable: true,
            serviceUnavailable: true,
            lastValidatedAt: Date.UTC(2026, 10, 2),
            lastErrorCode: null,
          },
        ],
  );
  await run(api, ui, ["provider-keys", "list"]);
  assert.deepEqual(ui.tables, [
    {
      keys: [
        "provider",
        "key",
        "model",
        "effort",
        "status",
        "role",
        "lastChecked",
        "lastError",
      ],
      rows: [
        {
          provider: "openai",
          key: "…wxyz",
          model: null,
          effort: null,
          status: "checks_unavailable",
          role: null,
          lastChecked: "2026-11-02T00:00:00.000Z",
          lastError: null,
        },
      ],
    },
  ]);
});

test("provider-keys set names a non-default backend before reading the key", async () => {
  const ui = new KeyUi({ secret: SECRET });
  const api = recordingApi(() => ({
    provider: "anthropic",
    last4: "ssss",
    status: "active",
  }));
  await run(api, ui, [
    "--api-url",
    "https://other.example.test",
    "provider-keys",
    "set",
    "anthropic",
  ]);
  assert.deepEqual(ui.warnings, [
    "This key will be sent to other.example.test, not Gitdog's default backend.",
  ]);
  const quiet = new KeyUi({ secret: SECRET });
  await run(api, quiet, ["provider-keys", "set", "anthropic"]);
  assert.deepEqual(quiet.warnings, []);
});

test("output never shows an Anthropic or OpenAI key", () => {
  for (const key of [
    `sk-ant-api03-${"a".repeat(40)}`,
    `sk-proj-${"b".repeat(40)}`,
    `sk-svcacct-${"d".repeat(40)}`,
    `sk-${"c".repeat(48)}`,
  ]) {
    const text = redactSecrets(`Request failed for ${key}.`);
    assert.equal(text, "Request failed for [redacted provider key].");
  }
  // Ordinary names that start with sk- are left alone.
  for (const name of [
    "owner/sk-react-native-components",
    "sk-feature-login-refactor-2",
  ])
    assert.equal(redactSecrets(name), name);
});

test("provider-keys models and model choose the model for your own key", async () => {
  const ui = new KeyUi();
  const api = recordingApi(({ path }) =>
    path.endsWith("query:models")
      ? {
          anthropic: [
            {
              modelId: "claude-opus-5-5",
              name: "Claude Opus 5.5",
              efforts: ["low", "medium"],
              defaultEffort: "medium",
            },
          ],
          openai: [],
        }
      : { provider: "anthropic", modelId: "claude-opus-5-5", effort: "low" },
  );
  await run(api, ui, ["provider-keys", "models"]);
  await run(api, ui, [
    "provider-keys",
    "model",
    "anthropic",
    "claude-opus-5-5",
    "--effort",
    "low",
  ]);
  assert.deepEqual(api.calls.at(-1), {
    kind: "action",
    path: "providerApiKeys/action:setModel",
    args: { provider: "anthropic", modelId: "claude-opus-5-5", effort: "low" },
  });
});

test("provider-keys priority shows and sets which key runs first", async () => {
  const ui = new KeyUi();
  const api = recordingApi(({ path, args }) =>
    path.endsWith("query:priority")
      ? { primaryProvider: "anthropic" }
      : { primaryProvider: args.primaryProvider },
  );
  await run(api, ui, ["provider-keys", "priority"]);
  await run(api, ui, ["provider-keys", "priority", "openai"]);
  await assert.rejects(
    run(api, ui, ["provider-keys", "priority", "gemini"]),
    /anthropic or openai/,
  );
  assert.deepEqual(
    api.calls.map((call) => [call.kind, call.path, call.args]),
    [
      ["query", "providerApiKeys/query:priority", undefined],
      [
        "mutation",
        "providerApiKeys/mutation:setPriority",
        { primaryProvider: "openai" },
      ],
    ],
  );
  assert.deepEqual(ui.values, [
    { primaryProvider: "anthropic" },
    { primaryProvider: "openai" },
  ]);
});

test("provider-keys list leaves roles blank when the order cannot be read", async () => {
  const ui = new KeyUi();
  const key = (provider) => ({
    provider,
    last4: "abcd",
    status: "active",
    readable: true,
    lastValidatedAt: 0,
    lastErrorCode: null,
  });
  const api = recordingApi(({ path }) => {
    if (path.endsWith("query:priority"))
      throw new Error("Could not find public function");
    return [key("openai"), key("anthropic")];
  });
  await run(api, ui, ["--json", "provider-keys", "list"]);
  assert.deepEqual(
    ui.values[0].map((row) => [row.provider, row.role]),
    [
      ["openai", null],
      ["anthropic", null],
    ],
  );
});

test("provider-keys list marks which key runs reviews in the owner's order", async () => {
  const ui = new KeyUi();
  const key = (provider) => ({
    provider,
    last4: "abcd",
    status: "active",
    readable: true,
    lastValidatedAt: 0,
    lastErrorCode: null,
  });
  const api = recordingApi(({ path }) =>
    path.endsWith("query:priority")
      ? { primaryProvider: "openai" }
      : [key("anthropic"), key("openai")],
  );
  await run(api, ui, ["--json", "provider-keys", "list"]);
  assert.deepEqual(
    ui.values[0].map((row) => [row.provider, row.role]),
    [
      ["anthropic", "backup"],
      ["openai", "primary"],
    ],
  );
});
