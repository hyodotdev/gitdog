import { Command, Option } from "commander";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { rm } from "node:fs/promises";
import type { Value } from "convex/values";
import { GitdogApi, type Api, type Args, type Kind } from "./client.js";
import { login, logout, openBrowser } from "./auth.js";
import { API_CATALOG, publicOperation } from "./catalog.js";
import {
  BOOLEAN_SETTINGS,
  STYLE_SETTINGS,
  ProjectContext,
  limitParser,
} from "./projects.js";
import {
  DEFAULT_API_URL,
  DEFAULT_SITE_URL,
  SessionStore,
  validateUrl,
  configDirectory,
  exists,
} from "./storage.js";
import {
  assertUntrackedKeyPath,
  readProjectKey,
  saveProjectKey,
  projectHttpUrl,
} from "./api-keys.js";
import { Ui, VERSION, asRecord, integer } from "./ui.js";

type Options = Record<string, unknown>;
type Context = {
  api: Api;
  project: ProjectContext;
  ui: Ui;
  options: Options;
  apiUrl: string;
  siteUrl: string;
};
type Handler = (
  context: Context,
  args: string[],
  options: Options,
) => Promise<void>;
const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const number = (value: unknown): number | undefined =>
  typeof value === "number" ? value : undefined;
const flag = (value: unknown): boolean => value === true;
const compact = (object: Record<string, Value | undefined>): Args =>
  Object.fromEntries(
    Object.entries(object).filter(
      (entry): entry is [string, Value] => entry[1] !== undefined,
    ),
  );

export async function jsonArguments(value: string): Promise<Args> {
  const content = value.startsWith("@")
    ? await readFile(resolve(value.slice(1)), "utf8")
    : value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("--data must be a JSON object, or @path/to/file.json.");
  }
  const object = asRecord(parsed);
  if (!object) throw new Error("--data must be a JSON object.");
  return object as Args;
}

type KeyProvider = "anthropic" | "openai";
const PROVIDER_NAMES: Record<KeyProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};
const PROVIDER_KEY_ERRORS: Record<string, string> = {
  unauthorized: "You are not logged in. Run npx gitdog@latest login.",
  not_found: "No API key is saved for this provider.",
  malformed: "That does not look like an API key for this provider.",
  wrong_provider:
    "That key belongs to the other provider. Run provider-keys set with the matching provider.",
  rate_limited: "Too many API key checks. Try again in a few minutes.",
  not_configured:
    "Gitdog cannot store API keys right now. Contact support if this continues.",
  unreadable:
    "Gitdog can no longer read this saved key. Run provider-keys set to enter it again.",
  invalid_key: "The provider rejected this API key.",
  no_model_access:
    "This API key has no access to the model Gitdog uses. Check the key's project or model permissions.",
  validation_unavailable:
    "The provider could not check this key right now. Try again shortly.",
};

function keyProvider(value: string): KeyProvider {
  if (value === "anthropic" || value === "openai") return value;
  throw new Error("Choose a provider: anthropic or openai.");
}

function providerKeyErrorReason(error: unknown): string | undefined {
  const data = asRecord(asRecord(error)?.data);
  return typeof data?.reason === "string" && data.reason in PROVIDER_KEY_ERRORS
    ? data.reason
    : undefined;
}

export function createProgram(
  dependencies: { api?: Api; ui?: Ui } = {},
): Command {
  const program = new Command();
  program
    .name("gitdog")
    .description("Your Gitdog workspace, from the terminal.")
    .version(VERSION)
    .option("-P, --project <alias|owner/repo|id>", "Project for this command")
    .option("--config <path>", "Path to gitdog.json")
    .option(
      "--key-file <path>",
      "Use a private project API key file instead of an owner session",
    )
    .option(
      "--api-url <url>",
      "Use a custom Gitdog backend (or GITDOG_API_URL)",
    )
    .option(
      "--site-url <url>",
      "Use a custom Gitdog website (or GITDOG_SITE_URL)",
    )
    .option("--json", "Output JSON without banners, tables or prompts")
    .option("-y, --yes", "Confirm the requested operation without prompting")
    .showHelpAfterError()
    .showSuggestionAfterError()
    .addHelpText(
      "after",
      `\nGetting started:\n  npx gitdog@latest login\n  npx gitdog@latest init\n  npx gitdog@latest config set requireApproval true\n  npx gitdog@latest config push --dry-run\n  npx gitdog@latest config push\n\nFirebase-style aliases also work: projects:list, projects:create, config:push.\nRun npx gitdog@latest <command> --help for details.`,
    );

  async function context(command: Command): Promise<Context> {
    const options = command.optsWithGlobals() as Options;
    const ui = dependencies.ui ?? new Ui(flag(options.json));
    const keyFile = text(options.keyFile) ?? process.env.GITDOG_API_KEY_FILE;
    const key = keyFile ? await readProjectKey(keyFile) : undefined;
    let session;
    if (!dependencies.api) {
      try {
        session = await new SessionStore().read();
      } catch {
        /* Authenticated commands report corrupt sessions; login can replace them. */
      }
    }
    const apiUrl = validateUrl(
      text(options.apiUrl) ??
        process.env.GITDOG_API_URL ??
        key?.apiUrl ??
        session?.apiUrl ??
        DEFAULT_API_URL,
      "API URL",
    );
    const siteUrl = validateUrl(
      text(options.siteUrl) ??
        process.env.GITDOG_SITE_URL ??
        session?.siteUrl ??
        DEFAULT_SITE_URL,
      "Site URL",
    );
    const api =
      dependencies.api ?? new GitdogApi(apiUrl, siteUrl, undefined, keyFile);
    return {
      api,
      apiUrl,
      siteUrl,
      ui,
      options,
      project: new ProjectContext(
        api,
        ui,
        text(options.project),
        text(options.config),
      ),
    };
  }

  function command(
    parent: Command,
    signature: string,
    description: string,
    handler: Handler,
  ): Command {
    const cmd = parent.command(signature).description(description);
    cmd.action(async (...values: unknown[]) => {
      const current = values.at(-1) as Command;
      const args = values.slice(0, -2) as string[];
      const ctx = await context(current);
      await handler(ctx, args, ctx.options);
    });
    return cmd;
  }

  const service = (
    parent: Command,
    signature: string,
    description: string,
    kind: Kind,
    path: string,
    build: (args: string[], opts: Options) => Args = () => ({}),
    confirm?: string,
  ) =>
    command(parent, signature, description, async ({ api, ui }, args, opts) => {
      const data = build(args, opts);
      if (confirm) await ui.confirm(confirm, flag(opts.yes));
      const result = await api.call(kind, path, data);
      if (result === null && /getById$/.test(path))
        throw new Error("This item does not exist or is not accessible.");
      ui.output(result);
    });

  program.action(() => {
    const ui = dependencies.ui ?? new Ui(flag(program.opts().json));
    ui.banner();
    if (ui.json)
      ui.output({
        name: "gitdog",
        version: VERSION,
        next: [
          "npx gitdog@latest login",
          "npx gitdog@latest init",
          "npx gitdog@latest --help",
        ],
      });
    else
      ui.output(
        "Get started\n  1. npx gitdog@latest login       Sign in with GitHub\n  2. npx gitdog@latest init        Connect a project\n  3. npx gitdog@latest status      Check your assistant\n\nRun npx gitdog@latest --help to explore all commands.",
      );
  });

  command(
    program,
    "login",
    "Sign in with GitHub using your browser",
    async ({ apiUrl, siteUrl, ui }, _args, opts) =>
      login(apiUrl, siteUrl, ui, opts.browser === false),
  ).option("--no-browser", "Print the sign-in URL without opening a browser");
  command(
    program,
    "logout",
    "Revoke this session and remove saved credentials",
    async ({ ui }, _args, opts) => logout(ui, flag(opts.local)),
  ).option("--local", "Remove local credentials without contacting the server");
  service(
    program,
    "whoami",
    "Show your signed-in Gitdog account",
    "query",
    "users/query:getCurrentUser",
  );

  command(
    program,
    "init [repository]",
    "Create or connect a project and write gitdog.json",
    async ({ project, ui, apiUrl, siteUrl }, args, opts) => {
      if (
        !dependencies.api &&
        !process.env.GITDOG_TOKEN &&
        !opts.keyFile &&
        !process.env.GITDOG_API_KEY_FILE &&
        !process.env.GITDOG_API_KEY &&
        !(await new SessionStore().read())
      ) {
        if (!process.stdin.isTTY || ui.json)
          throw new Error(
            "Run npx gitdog@latest login before npx gitdog@latest init.",
          );
        await login(apiUrl, siteUrl, ui);
      }
      await project.init(
        args[0],
        text(opts.alias) ?? "default",
        flag(opts.force),
      );
    },
  )
    .option("--alias <name>", "Local project alias", "default")
    .option("--force", "Replace an existing local project configuration");

  command(
    program,
    "use [project]",
    "Select the default local project or add an alias",
    async ({ project }, args, opts) =>
      project.use(args[0], text(opts.add), flag(opts.list)),
  )
    .option("--add <alias>", "Add owner/repo as an alias and select it")
    .option("--list", "List local aliases");

  command(
    program,
    "status",
    "Show active project, indexing and pending approvals",
    async ({ api, project, ui }) => {
      const repo = await project.repository();
      const [indexing, pending] = await Promise.all([
        api.call("query", "repoIndexing/query:getIndexingStatus", {
          repositoryId: repo._id,
        }),
        api.call("query", "tickets/query:listPendingApproval", {
          githubRepo: repo.githubRepo,
          limit: 20,
          offset: 0,
        }),
      ]);
      ui.output({
        project: repo.githubRepo,
        active: repo.isActive,
        indexing,
        pending,
      });
    },
  );

  command(
    program,
    "open",
    "Open the active project in Gitdog",
    async ({ project, ui, siteUrl }, _args, opts) => {
      const repo = await project.repository();
      const url = `${siteUrl}/repositories/${repo.githubRepo.split("/").map(encodeURIComponent).join("/")}`;
      if (!flag(opts.print) && !ui.json) await openBrowser(url);
      ui.output({ url });
    },
  ).option("--print", "Print the URL without opening a browser");

  const keys = program
    .command("keys")
    .description("Create, list, check and revoke project API keys");
  command(
    keys,
    "create",
    "Issue a project API key and save it to a private file",
    async ({ api, project, ui, apiUrl }, _args, opts) => {
      const repository = await project.repository();
      const out = text(opts.out);
      if (out && (await exists(resolve(out))))
        throw new Error(
          "The output file already exists. Choose a new private path.",
        );
      if (out) await assertUntrackedKeyPath(resolve(out));
      const name = text(opts.name) ?? "CLI key";
      const scopes = flag(opts.write) ? ["read", "write"] : ["read"];
      const issued = await api.call<{
        keyId: string;
        key: string;
        prefix: string;
        scopes: string[];
        expiresAt: number;
      }>("action", "apiKeys/action:create", {
        repositoryId: repository._id,
        name,
        scopes,
        expiresInDays: number(opts.expiresIn) ?? 30,
      });
      const keyFile = out
        ? resolve(out)
        : join(configDirectory(), "keys", `${issued.keyId}.json`);
      try {
        if (
          !/^gdk_[a-f0-9]{64}$/.test(issued.key) ||
          !/^[a-z0-9]{20,64}$/.test(issued.keyId)
        )
          throw new Error("The server returned invalid API key material.");
        await saveProjectKey(keyFile, {
          version: 1,
          apiKey: issued.key,
          keyId: issued.keyId,
          apiUrl,
          httpUrl: projectHttpUrl(apiUrl),
          repositoryId: repository._id,
          name,
          scopes: issued.scopes,
          expiresAt: issued.expiresAt,
        });
      } catch (error) {
        try {
          await api.call("mutation", "apiKeys/mutation:revoke", {
            keyId: issued.keyId,
          });
        } catch {
          throw new Error(
            `Could not save or revoke the new key. Revoke key ${issued.keyId} with an owner session.`,
          );
        }
        throw error;
      }
      ui.output({
        keyId: issued.keyId,
        prefix: issued.prefix,
        project: repository.githubRepo,
        scopes: issued.scopes,
        expiresAt: issued.expiresAt,
        keyFile,
      });
      ui.info(
        `Key saved privately. Use: npx gitdog@latest --key-file ${JSON.stringify(keyFile)} projects list`,
      );
    },
  )
    .option("--name <name>", "Key name", "CLI key")
    .option(
      "--write",
      "Grant project settings and ticket write access (read access is always included)",
    )
    .option(
      "--expires-in <days>",
      "Expiry in days (1–365)",
      (value) => integer(value, 1, 365),
      30,
    )
    .option(
      "--out <path>",
      "Private key file path; defaults to the Gitdog credentials directory",
    );
  command(
    keys,
    "list [repository]",
    "List key metadata without exposing secrets",
    async ({ api, project, ui }, args, opts) => {
      const repository = await project.repository(args[0]);
      ui.output(
        await api.call("query", "apiKeys/query:list", {
          repositoryId: repository._id,
          paginationOpts: {
            numItems: number(opts.limit) ?? 20,
            cursor: text(opts.cursor) ?? null,
          },
        }),
      );
    },
  )
    .option(
      "--limit <n>",
      "Page size (1–100)",
      (value) => integer(value, 1, 100),
      20,
    )
    .option("--cursor <cursor>", "Continue a key metadata page");
  command(
    keys,
    "check",
    "Verify a project API key with a live authenticated request",
    async ({ api, ui }, _args, opts) => {
      if (
        !opts.keyFile &&
        !process.env.GITDOG_API_KEY_FILE &&
        !process.env.GITDOG_API_KEY &&
        !dependencies.api
      )
        throw new Error(
          "Select --key-file, GITDOG_API_KEY_FILE or GITDOG_API_KEY first.",
        );
      const projects = await api.call<
        Array<{ _id: string; githubRepo: string }>
      >("query", "repositories/query:list");
      ui.output({
        authenticated: true,
        projects: projects.map((item) => ({
          id: item._id,
          repository: item.githubRepo,
        })),
      });
    },
  );
  command(
    keys,
    "revoke <id>",
    "Revoke a key immediately and remove its default local copy",
    async ({ api, ui }, args, opts) => {
      if (!/^[a-z0-9]{20,64}$/.test(args[0]))
        throw new Error("Use an API key ID from keys list, not a key secret.");
      await ui.confirm(`Revoke project API key ${args[0]}?`, flag(opts.yes));
      const result = await api.call<{ revoked: boolean; keyId: string }>(
        "mutation",
        "apiKeys/mutation:revoke",
        { keyId: args[0] },
      );
      if (/^[a-z0-9]{20,64}$/.test(result.keyId))
        await rm(join(configDirectory(), "keys", `${result.keyId}.json`), {
          force: true,
        });
      ui.output(result);
    },
  );

  const providerKeys = program
    .command("provider-keys")
    .alias("ai-keys")
    .description(
      "Manage your own Anthropic and OpenAI API keys for Gitdog generation",
    );
  const providerKeyCall = async <T>(
    api: Api,
    kind: Kind,
    path: string,
    args: Args,
  ): Promise<T> => {
    try {
      return await api.call<T>(kind, path, args);
    } catch (error) {
      const reason = providerKeyErrorReason(error);
      if (reason)
        throw new Error(PROVIDER_KEY_ERRORS[reason], { cause: error });
      throw error;
    }
  };
  command(
    providerKeys,
    "list",
    "List saved provider keys (provider, last 4 characters, status)",
    async ({ api, ui }) => {
      const keys = await api.call<
        Array<{
          provider: string;
          last4: string;
          status: string;
          readable?: boolean;
          serviceUnavailable?: boolean;
          lastValidatedAt: number;
          lastErrorCode: string | null;
        }>
      >("query", "providerApiKeys/query:list");
      const rows = keys.map((key) => ({
        provider: key.provider,
        key: `…${key.last4}`,
        status: key.serviceUnavailable
          ? "checks_unavailable"
          : key.readable === false
            ? "unreadable"
            : key.status,
        lastChecked: new Date(key.lastValidatedAt).toISOString(),
        lastError: key.lastErrorCode,
      }));
      // The generic renderer only keeps its preferred columns, which would
      // drop provider, key and check times.
      if (ui.json || rows.length === 0) ui.output(rows);
      else
        ui.table(rows, [
          "provider",
          "key",
          "status",
          "lastChecked",
          "lastError",
        ]);
    },
  );
  command(
    providerKeys,
    "set <provider> [unexpected...]",
    "Save or replace a provider key (prompted without echo, or piped with --stdin)",
    async ({ api, ui }, args, opts) => {
      const provider = keyProvider(args[0]);
      // Declared so Commander does not echo a pasted key in its usage error.
      if ((args[1] as unknown as string[] | undefined)?.length)
        throw new Error(
          "Never pass an API key as an argument. Run provider-keys set without it to be prompted, or pipe it with --stdin.",
        );
      // The key never comes from argv, so it stays out of shell history and
      // process listings.
      const apiKey = flag(opts.stdin)
        ? await ui.readStdin()
        : await ui.secret(`${PROVIDER_NAMES[provider]} API key`);
      if (!apiKey) throw new Error("No API key was entered.");
      const saved = await providerKeyCall<{
        provider: string;
        last4: string;
        status: string;
      }>(api, "action", "providerApiKeys/action:save", { provider, apiKey });
      ui.output({
        provider: saved.provider,
        key: `…${saved.last4}`,
        status: saved.status,
      });
    },
  )
    .option("--stdin", "Read the key from standard input instead of a prompt")
    // Unknown options such as --key=... reach the handler instead of
    // Commander's error, which would print the value.
    .allowUnknownOption(true);
  command(
    providerKeys,
    "check <provider>",
    "Check a saved provider key with the provider again",
    async ({ api, ui }, args) => {
      const provider = keyProvider(args[0]);
      ui.output(
        await providerKeyCall(
          api,
          "action",
          "providerApiKeys/action:revalidate",
          {
            provider,
          },
        ),
      );
    },
  );
  command(
    providerKeys,
    "remove <provider>",
    "Remove a saved provider key; Gitdog's own models are used again",
    async ({ api, ui }, args, opts) => {
      const provider = keyProvider(args[0]);
      await ui.confirm(
        `Remove your ${PROVIDER_NAMES[provider]} API key from Gitdog?`,
        flag(opts.yes),
      );
      ui.output(
        await providerKeyCall(
          api,
          "mutation",
          "providerApiKeys/mutation:remove",
          {
            provider,
          },
        ),
      );
    },
  );

  const projects = program
    .command("projects")
    .alias("repos")
    .description("Create, connect and manage repository projects");
  service(
    projects,
    "list",
    "List owned and shared Gitdog projects",
    "query",
    "repositories/query:list",
  );
  service(
    projects,
    "available",
    "List a page of repositories available to connect",
    "action",
    "github/action:listUserRepositories",
    (_args, opts) =>
      compact({
        cursor: text(opts.cursor),
        reconnectRepositoryId: text(opts.reconnect),
      }),
  )
    .option("--cursor <cursor>", "Continue from the returned continueCursor")
    .option(
      "--reconnect <id>",
      "List candidates for an existing disconnected project",
    );
  command(
    projects,
    "create <repository>",
    "Create a Gitdog project from an authorized GitHub repository",
    async ({ project, ui }, args) => ui.output(await project.connect(args[0])),
  );
  command(
    projects,
    "get [repository]",
    "Show a project and its settings",
    async ({ project, ui }, args) =>
      ui.output(await project.repository(args[0])),
  );
  command(
    projects,
    "reconnect [repository]",
    "Reconnect an existing project's GitHub App access",
    async ({ project, ui }, args) => {
      const repo = await project.repository(args[0]);
      ui.output(await project.connect(repo.githubRepo, repo._id));
    },
  );
  command(
    projects,
    "sync [repository]",
    "Synchronize repository files and refresh the index",
    async ({ api, project, ui }, args) => {
      const repo = await project.repository(args[0]);
      const result = await api.call(
        "action",
        "repositories/action:syncRepository",
        { repositoryId: repo._id },
      );
      if (asRecord(result)?.success === false)
        throw new Error(
          String(
            asRecord(result)?.message ?? "Repository sync could not start.",
          ),
        );
      ui.output(result);
    },
  );
  for (const enabled of [true, false]) {
    command(
      projects,
      enabled ? "enable [repository]" : "disable [repository]",
      enabled ? "Enable project automation" : "Pause project automation",
      async ({ api, project, ui }, args, opts) => {
        const repo = await project.repository(args[0]);
        if (repo.isActive !== enabled) {
          await ui.confirm(
            `${enabled ? "Enable" : "Pause"} automation for ${repo.githubRepo}?`,
            flag(opts.yes),
          );
          await api.call("mutation", "repositories/mutation:toggleActive", {
            repositoryId: repo._id,
            isActive: enabled,
          });
        }
        const current = await project.repository(repo.githubRepo);
        if (current.isActive !== enabled)
          throw new Error(
            "Project activity changed during verification. Check projects get before retrying.",
          );
        ui.output({ project: current.githubRepo, active: current.isActive });
      },
    );
  }
  command(
    projects,
    "delete [repository]",
    "Disconnect a Gitdog project and remove its cached data",
    async ({ api, project, ui }, args, opts) => {
      const repo = await project.repository(args[0]);
      await ui.confirm(
        `Disconnect ${repo.githubRepo} and remove Gitdog cached data? The GitHub repository is preserved.`,
        flag(opts.yes),
      );
      ui.output(
        await api.call("mutation", "repositories/mutation:remove", {
          repositoryId: repo._id,
        }),
      );
    },
  );

  const config = program
    .command("config")
    .description("Manage all issue and discussion automation settings");
  command(
    config,
    "keys",
    "List all supported automation settings",
    async ({ ui }) =>
      ui.output([
        ...BOOLEAN_SETTINGS.map((name) => ({ name, type: "boolean" })),
        ...STYLE_SETTINGS.map((name) => ({ name, type: "string" })),
      ]),
  );
  command(
    config,
    "get [key]",
    "Read local settings (or current remote settings)",
    async ({ project }, args, opts) =>
      project.configGet(args[0], flag(opts.remote)),
  ).option("--remote", "Read settings from Gitdog");
  command(
    config,
    "set <key> <value>",
    "Set one local setting; use config push to apply",
    async ({ project }, args) => project.configSet(args[0], args[1]),
  );
  command(
    config,
    "pull",
    "Replace local settings with remote settings",
    async ({ project }, _args, opts) => project.configPull(flag(opts.yes)),
  );
  command(
    config,
    "push",
    "Preview and apply local settings to Gitdog",
    async ({ project }, _args, opts) =>
      project.configPush(flag(opts.dryRun), flag(opts.yes)),
  ).option("--dry-run", "Show changes without applying them");

  const indexing = program
    .command("index")
    .description("Inspect repository indexing and cached files");
  command(
    indexing,
    "status",
    "Show indexing progress; optionally wait for completion",
    async ({ api, project, ui }, _args, opts) => {
      const repo = await project.repository();
      const deadline = Date.now() + (number(opts.timeout) ?? 300) * 1000;
      let last = "";
      for (;;) {
        const remaining = deadline - Date.now();
        if (flag(opts.wait) && remaining <= 0)
          throw new Error(
            "Timed out waiting for indexing. Indexing continues on the server; check npx gitdog@latest index status.",
          );
        const state = await api.call(
          "query",
          "repoIndexing/query:getIndexingStatus",
          { repositoryId: repo._id },
          flag(opts.wait) ? { timeoutMs: remaining } : undefined,
        );
        const record = asRecord(state);
        if (!record) throw new Error("Indexing status is not available.");
        if (!flag(opts.wait)) {
          ui.output(state);
          return;
        }
        const fingerprint = JSON.stringify(state);
        if (fingerprint !== last) {
          ui.info(
            `Index: ${String(record.status)} / Search: ${String(record.ragStatus)}`,
          );
          last = fingerprint;
        }
        if (record.status === "failed" || record.ragStatus === "failed")
          throw new Error(
            "Indexing failed. Run npx gitdog@latest index logs for details.",
          );
        if (
          record.status === "completed" &&
          ["completed", "skipped"].includes(String(record.ragStatus))
        ) {
          ui.output(state);
          return;
        }
        if (Date.now() >= deadline)
          throw new Error(
            "Timed out waiting for indexing. Indexing continues on the server; check npx gitdog@latest index status.",
          );
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.min(2000, Math.max(1, deadline - Date.now())),
          ),
        );
      }
    },
  )
    .option("--wait", "Wait for indexing and search readiness")
    .option(
      "--timeout <seconds>",
      "Maximum wait (1–900 seconds)",
      (value) => integer(value, 1, 900),
      300,
    );
  for (const [name, path, description] of [
    ["logs", "getIndexingLogs", "Show logs for the current indexing run"],
    ["files", "getFileList", "List cached repository files"],
  ])
    command(
      indexing,
      name,
      description,
      async ({ api, project, ui }, _args, opts) =>
        ui.output(
          await api.call("query", `repoIndexing/query:${path}`, {
            repositoryId: (await project.repository())._id,
            limit: number(opts.limit) ?? 100,
          }),
        ),
    ).option("--limit <n>", "Maximum records (1–500)", limitParser, 100);
  command(
    indexing,
    "file <path>",
    "Read a cached repository file",
    async ({ api, project, ui }, args) =>
      ui.output(
        await api.call("query", "repoIndexing/query:getFileContent", {
          repositoryId: (await project.repository())._id,
          filePath: args[0],
        }),
      ),
  );
  command(
    indexing,
    "restart",
    "Restart repository indexing",
    async ({ api, project, ui }, _args, opts) => {
      const repo = await project.repository();
      await ui.confirm(
        `Restart indexing for ${repo.githubRepo}?`,
        flag(opts.yes),
      );
      ui.output(
        await api.call("mutation", "repoIndexing/mutation:initializeIndexing", {
          repositoryId: repo._id,
        }),
      );
    },
  );
  command(
    indexing,
    "learnings",
    "Count trusted repository learnings",
    async ({ api, project, ui }) =>
      ui.output({
        count: await api.call(
          "query",
          "repoLearnings/query:countByRepository",
          { repositoryId: (await project.repository())._id },
        ),
      }),
  );

  const tickets = program
    .command("tickets")
    .description(
      "Browse issues, discussions, PR reviews and pending approvals",
    );
  for (const pending of [false, true]) {
    command(
      tickets,
      pending ? "pending" : "list",
      pending
        ? "List tickets awaiting approval"
        : "List issues, discussions and PR reviews",
      async ({ api, project, ui }, _args, opts) => {
        const githubRepo = flag(opts.all)
          ? undefined
          : (await project.repository()).githubRepo;
        ui.output(
          await api.call(
            "query",
            `tickets/query:${pending ? "listPendingApproval" : "list"}`,
            compact({
              githubRepo,
              ...(!pending ? { status: text(opts.status) } : {}),
              ticketType: text(opts.type),
              search: text(opts.search),
              limit: number(opts.limit),
              offset: number(opts.offset),
            }),
          ),
        );
      },
    )
      .option("--all", "List across all projects instead of the active project")
      .addOption(
        new Option("--status <status>", "Ticket status (list only)").choices([
          "open",
          "closed",
        ]),
      )
      .addOption(
        new Option("--type <type>", "Ticket type").choices([
          "issue",
          "discussion",
          "pull_request",
        ]),
      )
      .option("--search <text>", "Search title, repository or GitHub number")
      .option("--limit <n>", "Page size (1–500)", limitParser, 20)
      .option(
        "--offset <n>",
        "Number of records to skip",
        (value) => integer(value, 0),
        0,
      );
  }
  service(
    tickets,
    "get <id>",
    "Show a ticket and its actions",
    "query",
    "tickets/query:getById",
    ([id]) => ({ id }),
  );
  service(
    tickets,
    "delete <id>",
    "Soft-delete a ticket in Gitdog",
    "mutation",
    "tickets/mutation:softDelete",
    ([id]) => ({ id }),
    "Delete this Gitdog ticket?",
  );
  service(
    tickets,
    "restore <id>",
    "Restore a soft-deleted ticket by ID",
    "mutation",
    "tickets/mutation:restore",
    ([id]) => ({ id }),
  );

  const actions = program
    .command("actions")
    .description("Review and approve assistant actions");
  service(
    actions,
    "list <ticket-id>",
    "List actions for a ticket",
    "query",
    "ticketActions/query:listByTicket",
    ([ticketId]) => ({ ticketId }),
  );
  service(
    actions,
    "get <id>",
    "Show one assistant action",
    "query",
    "ticketActions/query:getById",
    ([id]) => ({ id }),
  );
  service(
    actions,
    "approve <id>",
    "Approve and execute an action on GitHub",
    "action",
    "ticketActions/action:approve",
    ([actionId]) => ({ actionId }),
    "Approve this action and execute it on GitHub?",
  );
  service(
    actions,
    "reject <id>",
    "Reject an assistant action",
    "action",
    "ticketActions/action:reject",
    ([actionId]) => ({ actionId }),
    "Reject this assistant action?",
  );
  service(
    actions,
    "request-changes <id> <feedback>",
    "Request a revised assistant response",
    "action",
    "ticketActions/action:requestChanges",
    ([actionId, feedback]) => ({ actionId, feedback }),
    "Request a new response using this feedback?",
  );

  const notifications = program
    .command("notifications")
    .description("Read workspace notifications");
  command(
    notifications,
    "list",
    "List recent or unread notifications",
    async ({ api, ui }, _args, opts) =>
      ui.output(
        await api.call(
          "query",
          flag(opts.unread)
            ? "notifications/query:listUnread"
            : "notifications/query:list",
          flag(opts.unread) ? {} : { limit: number(opts.limit) ?? 50 },
        ),
      ),
  )
    .option("--unread", "Show the 20 most recent unread notifications")
    .option("--limit <n>", "Maximum records (1–500)", limitParser, 50);
  service(
    notifications,
    "count",
    "Show unread count (capped at 100)",
    "query",
    "notifications/query:getUnreadCount",
  );
  service(
    notifications,
    "read <id>",
    "Mark a notification as read",
    "mutation",
    "notifications/mutation:markAsRead",
    ([notificationId]) => ({ notificationId }),
  );
  service(
    notifications,
    "read-all",
    "Mark all unread notifications as read",
    "mutation",
    "notifications/mutation:markAllAsRead",
  );

  const team = program
    .command("team")
    .description("Manage project members and invitations");
  command(
    team,
    "members",
    "List project members",
    async ({ api, project, ui }) =>
      ui.output(
        await api.call("query", "repositoryMembers/query:list", {
          repositoryId: (await project.repository())._id,
        }),
      ),
  );
  command(
    team,
    "role",
    "Show your role in this project",
    async ({ api, project, ui }) =>
      ui.output(
        await api.call("query", "repositoryMembers/query:getMyRole", {
          repositoryId: (await project.repository())._id,
        }),
      ),
  );
  command(
    team,
    "invite <github-username>",
    "Invite a GitHub user as a project viewer",
    async ({ api, project, ui }, args, opts) => {
      const repo = await project.repository();
      await ui.confirm(
        `Invite ${args[0]} as a viewer of ${repo.githubRepo}?`,
        flag(opts.yes),
      );
      ui.output(
        await api.call("action", "invitations/action:create", {
          repositoryId: repo._id,
          inviteeGithubUsername: args[0],
          role: "viewer",
        }),
      );
    },
  );
  command(
    team,
    "invitations",
    "List this project's invitations",
    async ({ api, project, ui }, _args, opts) =>
      ui.output(
        await api.call(
          "query",
          flag(opts.pending)
            ? "invitations/query:getPendingForRepository"
            : "invitations/query:listForRepository",
          { repositoryId: (await project.repository())._id },
        ),
      ),
  ).option("--pending", "Show only pending project invitations");
  service(
    team,
    "remove <member-id>",
    "Remove a project member",
    "mutation",
    "repositoryMembers/mutation:remove",
    ([memberId]) => ({ memberId }),
    "Remove this project member?",
  );
  command(
    team,
    "leave",
    "Leave a shared project",
    async ({ api, project, ui }, _args, opts) => {
      const repo = await project.repository();
      await ui.confirm(`Leave ${repo.githubRepo}?`, flag(opts.yes));
      ui.output(
        await api.call("mutation", "repositoryMembers/mutation:leave", {
          repositoryId: repo._id,
        }),
      );
    },
  );
  const invitations = program
    .command("invitations")
    .description("Manage incoming invitations");
  service(
    invitations,
    "list",
    "List incoming pending invitations",
    "query",
    "invitations/query:listPending",
  );
  for (const name of ["accept", "reject", "cancel"])
    service(
      invitations,
      `${name} <id>`,
      `${name[0].toUpperCase() + name.slice(1)} a project invitation`,
      "mutation",
      `invitations/mutation:${name}`,
      ([invitationId]) => ({ invitationId }),
      `${name[0].toUpperCase() + name.slice(1)} this invitation?`,
    );

  const usage = program
    .command("usage")
    .description("Inspect token usage and billing estimates");
  service(
    usage,
    "summary",
    "Show current billing-period usage",
    "query",
    "tokenUsage/query:getCurrentMonthUsage",
  );
  service(
    usage,
    "projects",
    "Show usage grouped by repository",
    "query",
    "tokenUsage/query:getUsageByRepository",
  );
  service(
    usage,
    "estimate",
    "Show estimated overage and billing costs",
    "query",
    "subscriptions/query:calculateOverage",
  );
  service(
    usage,
    "quota",
    "Check whether your account can perform an action",
    "query",
    "subscriptions/query:canPerformAction",
  );
  const billing = program
    .command("billing")
    .description("Inspect your plan and open secure checkout");
  service(
    billing,
    "status",
    "Show current subscription",
    "query",
    "subscriptions/query:getCurrent",
  );
  service(
    billing,
    "pricing",
    "Show plans and token-pack pricing",
    "query",
    "subscriptions/query:getPricingInfo",
  );
  command(
    billing,
    "checkout [pack]",
    "Create a checkout link for Pro or a token pack",
    async ({ api, ui }, args, opts) => {
      const pack = args[0] ?? "pro";
      if (!["pro", "small", "large"].includes(pack))
        throw new Error("Choose pro, small or large.");
      const result = asRecord(
        await api.call(
          "action",
          pack === "pro"
            ? "subscriptions/action:createCheckoutUrl"
            : "subscriptions/action:createTokenPackCheckoutUrl",
          pack === "pro" ? { plan: "pro" } : { packSize: pack },
        ),
      );
      if (
        typeof result?.checkoutUrl !== "string" ||
        new URL(result.checkoutUrl).protocol !== "https:"
      )
        throw new Error("Gitdog did not return a valid checkout URL.");
      if (flag(opts.open) && !ui.json) await openBrowser(result.checkoutUrl);
      ui.output(result);
    },
  ).option(
    "--open",
    "Open checkout in a browser; payment still requires checkout confirmation",
  );

  const account = program
    .command("account")
    .description("View your account and manage consent");
  service(
    account,
    "profile",
    "Show your account profile",
    "query",
    "users/query:getCurrentUser",
  );
  service(
    account,
    "sync",
    "Refresh your GitHub profile",
    "action",
    "users/action:ensureProfile",
  );
  command(
    account,
    "consent",
    "Open the account consent screen",
    async ({ ui, siteUrl }, _args, opts) => {
      const url = `${siteUrl}/legal/consent`;
      if (!ui.json && !flag(opts.print)) await openBrowser(url);
      ui.output({
        url,
        message:
          "Review and confirm account eligibility and policies in your browser.",
      });
    },
  ).option("--print", "Print the URL without opening a browser");

  const github = program
    .command("github")
    .description("Manage GitHub App installations and repository access");
  service(
    github,
    "installations",
    "List bound GitHub App installations",
    "query",
    "github/query:getUserInstallations",
  );
  command(
    github,
    "install",
    "Open GitHub App installation and permission selection",
    async ({ ui }, _args, opts) => {
      const slug = text(opts.app) ?? "gitdogbot";
      if (!/^[a-z\d][a-z\d-]{0,99}$/.test(slug))
        throw new Error("Invalid GitHub App slug.");
      const url = `https://github.com/apps/${slug}/installations/new`;
      if (!ui.json && !flag(opts.print)) await openBrowser(url);
      ui.output({
        url,
        next: "After GitHub authorization, run npx gitdog@latest github recover, then npx gitdog@latest projects available.",
      });
    },
  )
    .option(
      "--app <slug>",
      "GitHub App slug (use gitdogbot-dev for development)",
      "gitdogbot",
    )
    .option("--print", "Print the installation URL");
  command(
    github,
    "recover",
    "Recover installation bindings after GitHub authorization",
    async ({ api, ui }) => {
      for (let count = 0; count < 500; count++) {
        const result = asRecord(
          await api.call("action", "github/action:recoverOAuthInstallation"),
        );
        if (result?.status !== "recovered") {
          ui.output({ ...result, recoveredCount: count });
          if (result?.status === "reauth_required")
            throw new Error(
              "Refresh GitHub authorization with npx gitdog@latest login, then run github recover again.",
            );
          return;
        }
        ui.info(`Recovered installation ${String(result.installationId)}.`);
      }
      throw new Error(
        "Installation recovery reached its safety limit. Check github installations before retrying.",
      );
    },
  );
  service(
    github,
    "bind <installation-id>",
    "Refresh a GitHub installation binding",
    "action",
    "github/action:saveInstallation",
    ([id]) => ({ installationId: integer(id) }),
  );
  service(
    github,
    "retry <installation-id>",
    "Retry repository-access reconciliation",
    "action",
    "github/action:retryRepositoryAccessReconciliation",
    ([id]) => ({ installationId: integer(id) }),
  );

  const admin = program
    .command("admin")
    .description("Administrator operations (server-enforced access)");
  const adminLimit = (value: string) => integer(value, 1, 100);
  service(
    admin,
    "status",
    "Check administrator access",
    "query",
    "admin/query:isAdmin",
  );
  service(
    admin,
    "stats",
    "Show assistant workflow statistics",
    "query",
    "admin/query:getAiLogStats",
  );
  service(
    admin,
    "logs",
    "List assistant logs",
    "query",
    "admin/query:listAiLogs",
    (_args, opts) =>
      compact({
        limit: number(opts.limit),
        cursor: text(opts.cursor),
        workflowType: text(opts.workflow),
        status: text(opts.status),
      }),
  )
    .option("--limit <n>", "Page size (1–100)", adminLimit, 20)
    .option("--cursor <cursor>", "Pagination cursor")
    .option("--workflow <type>", "Workflow type")
    .option("--status <status>", "Workflow status");
  service(
    admin,
    "payments",
    "List payment logs",
    "query",
    "admin/paymentQuery:listPaymentLogs",
    (_args, opts) =>
      compact({
        limit: number(opts.limit),
        cursor: text(opts.cursor),
        statusFilter: text(opts.status),
        eventTypeFilter: text(opts.event),
      }),
  )
    .option("--limit <n>", "Page size (1–100)", adminLimit, 20)
    .option("--cursor <cursor>", "Pagination cursor")
    .option("--status <status>", "Payment status")
    .option("--event <type>", "Payment event type");
  service(
    admin,
    "subscriptions",
    "List subscriptions",
    "query",
    "admin/paymentQuery:listSubscriptions",
    (_args, opts) => ({ limit: number(opts.limit) ?? 20 }),
  ).option("--limit <n>", "Maximum records (1–100)", adminLimit, 20);
  command(
    admin,
    "call <operation>",
    "Run an advanced admin operation with explicit JSON arguments",
    async ({ api, ui }, args, opts) => {
      const operation = publicOperation(args[0]);
      if (operation.path === "apiKeys/action:create")
        throw new Error(
          "Use keys create to issue API keys securely into a private file.",
        );
      if (!operation.path.startsWith("admin/"))
        throw new Error(
          "Use npx gitdog@latest api call for non-admin operations.",
        );
      const data = await jsonArguments(text(opts.data) ?? "{}");
      if (operation.kind !== "query") {
        if (!ui.json) ui.output({ operation: operation.path, arguments: data });
        await ui.confirm(`Run ${operation.path}?`, flag(opts.yes));
      }
      ui.output(await api.call(operation.kind, operation.path, data));
    },
  ).option(
    "--data <json|@file>",
    "Exact arguments; see api describe <operation>",
    "{}",
  );

  const advanced = program
    .command("api")
    .description("Discover and call every public Gitdog API operation");
  command(
    advanced,
    "list",
    "List the complete public feature inventory",
    async ({ ui }, _args, opts) =>
      ui.output(
        API_CATALOG.filter(
          (entry) => !opts.filter || entry.path.includes(String(opts.filter)),
        ),
      ),
  ).option("--filter <text>", "Filter by feature or operation name");
  command(
    advanced,
    "describe <operation>",
    "Show the server validator for an operation",
    async ({ ui }, args) => ui.output(publicOperation(args[0])),
  );
  command(
    advanced,
    "call <operation>",
    "Call a public operation using exact JSON arguments",
    async ({ api, ui }, args, opts) => {
      const operation = publicOperation(args[0]);
      if (operation.path === "apiKeys/action:create")
        throw new Error(
          "Use keys create to issue API keys securely into a private file.",
        );
      if (operation.path === "providerApiKeys/action:save")
        throw new Error(
          "Use npx gitdog@latest provider-keys set <anthropic|openai> so the key is never echoed or kept in shell history.",
        );
      const data = await jsonArguments(text(opts.data) ?? "{}");
      if (operation.kind !== "query") {
        if (!ui.json) ui.output({ operation: operation.path, arguments: data });
        await ui.confirm(`Run ${operation.path}?`, flag(opts.yes));
      }
      ui.output(await api.call(operation.kind, operation.path, data));
    },
  ).option(
    "--data <json|@file>",
    "Exact arguments; use @file to avoid shell escaping",
    "{}",
  );

  command(
    program,
    "doctor",
    "Check runtime, authentication and local project configuration",
    async ({ apiUrl, siteUrl, project, ui }, _args, opts) => {
      const keyFile = text(opts.keyFile) ?? process.env.GITDOG_API_KEY_FILE;
      const keyMode = Boolean(keyFile || process.env.GITDOG_API_KEY);
      const metadata = keyFile ? await readProjectKey(keyFile) : undefined;
      const session = keyMode ? undefined : await new SessionStore().read();
      let configuration: unknown;
      try {
        const local = await project.config();
        configuration = {
          path: local.path,
          defaultProject: local.value.defaultProject,
        };
      } catch (error) {
        configuration = { message: (error as Error).message };
      }
      ui.output({
        version: VERSION,
        node: process.version,
        apiUrl,
        siteUrl,
        authentication: keyMode
          ? "project API key"
          : process.env.GITDOG_TOKEN
            ? "environment token"
            : session
              ? "saved session"
              : "not logged in",
        apiKey: metadata
          ? {
              keyId: metadata.keyId,
              repositoryId: metadata.repositoryId,
              scopes: metadata.scopes,
              expiresAt: metadata.expiresAt,
            }
          : undefined,
        configuration,
      });
    },
  );
  return program;
}

export function normalizeArgv(argv: string[]): string[] {
  const result = [...argv];
  const groups = new Set([
    "keys",
    "projects",
    "repos",
    "config",
    "tickets",
    "actions",
    "notifications",
    "team",
    "invitations",
    "usage",
    "billing",
    "account",
    "github",
    "index",
    "admin",
    "api",
  ]);
  const valueOptions = new Set([
    "--project",
    "-P",
    "--config",
    "--key-file",
    "--api-url",
    "--site-url",
  ]);
  for (let index = 0; index < result.length; index++) {
    const value = result[index];
    if (valueOptions.has(value)) {
      index++;
      continue;
    }
    if (value.startsWith("-")) continue;
    const [group, command, ...rest] = value.split(":");
    if (groups.has(group) && command && rest.length === 0)
      result.splice(index, 1, group, command);
    break;
  }
  return result;
}
