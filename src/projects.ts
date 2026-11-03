import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { exists, readJson, writeJson } from "./storage.js";
import { asRecord, integer, type Ui } from "./ui.js";
import type { Api } from "./client.js";

export const BOOLEAN_SETTINGS = [
  "issueAssistantEnabled",
  "autoFormatIssue",
  "autoAnswerQuestions",
  "tagMaintainersForCodeChanges",
  "requireApproval",
  "discussionAssistantEnabled",
  "autoFormatDiscussion",
  "autoAnswerDiscussionQuestions",
  "tagMaintainersForDiscussionCodeChanges",
  "requireApprovalForDiscussions",
] as const;
export const STYLE_SETTINGS = [
  "issueResponseStyle",
  "discussionResponseStyle",
] as const;
export type Settings = Record<(typeof BOOLEAN_SETTINGS)[number], boolean> &
  Partial<Record<(typeof STYLE_SETTINGS)[number], string>>;
export type Project = { repository: string; settings: Partial<Settings> };
export type ProjectConfig = {
  version: 1;
  defaultProject: string;
  projects: Record<string, Project>;
};
export type Repository = {
  _id: string;
  githubRepo: string;
  settings: Settings;
  isActive: boolean;
  [key: string]: unknown;
};

export function repositoryName(value: string): string {
  if (
    !/^[a-z\d](?:[a-z\d-]*[a-z\d])?\/[\w.-]+$/i.test(value) ||
    value.endsWith("/.") ||
    value.endsWith("/..")
  )
    throw new Error("Use a GitHub repository name such as owner/repo.");
  return value;
}

export function aliasName(value: string): string {
  if (
    !/^[a-z\d][a-z\d_-]{0,63}$/i.test(value) ||
    ["__proto__", "constructor", "prototype"].includes(value)
  )
    throw new Error(
      "Project aliases must use letters, numbers, underscores or hyphens (1–64 characters).",
    );
  return value;
}

export function validateSettings(
  value: unknown,
  complete = false,
): Partial<Settings> {
  const record = asRecord(value);
  if (!record) throw new Error("Settings must be a JSON object.");
  const settings: Record<string, boolean | string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (BOOLEAN_SETTINGS.includes(key as (typeof BOOLEAN_SETTINGS)[number])) {
      if (typeof item !== "boolean")
        throw new Error(`${key} must be true or false.`);
    } else if (
      STYLE_SETTINGS.includes(key as (typeof STYLE_SETTINGS)[number])
    ) {
      if (typeof item !== "string") throw new Error(`${key} must be a string.`);
    } else
      throw new Error(
        `Unknown setting: ${key}. Run npx gitdog@latest config keys.`,
      );
    settings[key] = item;
  }
  if (
    complete &&
    BOOLEAN_SETTINGS.some((key) => typeof settings[key] !== "boolean")
  )
    throw new Error(
      "The server returned incomplete project settings. Update Gitdog before applying settings.",
    );
  return settings;
}

export function validateProjectConfig(value: unknown): ProjectConfig {
  const config = asRecord(value);
  const projects = asRecord(config?.projects);
  if (
    config?.version !== 1 ||
    typeof config.defaultProject !== "string" ||
    !projects ||
    !Object.hasOwn(projects, config.defaultProject)
  )
    throw new Error(
      "Invalid gitdog.json. Run npx gitdog@latest init in a new directory, or repair the project configuration.",
    );
  const result: Record<string, Project> = {};
  for (const [alias, value] of Object.entries(projects)) {
    aliasName(alias);
    const project = asRecord(value);
    if (typeof project?.repository !== "string")
      throw new Error(`Missing repository for ${alias}.`);
    result[alias] = {
      repository: repositoryName(project.repository),
      settings: validateSettings(project.settings ?? {}),
    };
  }
  return {
    version: 1,
    defaultProject: config.defaultProject,
    projects: result,
  };
}

export async function findConfig(
  explicit?: string,
  cwd = process.cwd(),
): Promise<string | undefined> {
  if (explicit) return resolve(cwd, explicit);
  // Stop at the repository root or home so a file planted in a shared parent
  // directory cannot choose the project.
  let directory = resolve(cwd);
  const home = resolve(homedir());
  while (true) {
    const path = join(directory, "gitdog.json");
    if (await exists(path)) return path;
    const parent = dirname(directory);
    if (
      parent === directory ||
      directory === home ||
      (await exists(join(directory, ".git")))
    )
      return undefined;
    directory = parent;
  }
}

export class ProjectContext {
  constructor(
    readonly api: Api,
    public readonly ui: Ui,
    readonly selected?: string,
    readonly configOption?: string,
  ) {}

  async config(): Promise<{ path: string; value: ProjectConfig }> {
    const path = await findConfig(this.configOption);
    if (!path)
      throw new Error(
        "No gitdog.json found. Run npx gitdog@latest init, or pass --project owner/repo.",
      );
    const value = await readJson(path);
    if (value === undefined)
      throw new Error(
        `No project configuration at ${path}. Run npx gitdog@latest init.`,
      );
    return { path, value: validateProjectConfig(value) };
  }

  async target(override?: string): Promise<string> {
    const selection = override ?? this.selected;
    if (selection?.includes("/")) return repositoryName(selection);
    if (selection && /^[a-z0-9]{20,64}$/.test(selection)) {
      const path = await findConfig(this.configOption);
      const raw = path ? await readJson(path) : undefined;
      if (
        !raw ||
        !Object.hasOwn(validateProjectConfig(raw).projects, selection)
      )
        return selection;
    }
    const { value } = await this.config();
    const alias = selection ?? value.defaultProject;
    if (!Object.hasOwn(value.projects, alias))
      throw new Error(
        `Unknown project alias ${alias}. Run npx gitdog@latest use --list.`,
      );
    return value.projects[alias].repository;
  }

  async repository(override?: string): Promise<Repository> {
    const target = await this.target(override);
    const repository = target.includes("/")
      ? await this.api.call<Repository | null>(
          "query",
          "repositories/query:get",
          { owner: target.split("/")[0], repo: target.split("/")[1] },
        )
      : await this.api.call<Repository | null>(
          "query",
          "repositories/query:getById",
          { repositoryId: target },
        );
    if (!repository)
      throw new Error(
        `Project ${target} is not connected or accessible. Run npx gitdog@latest projects create ${target}.`,
      );
    return repository;
  }

  async available(
    reconnectRepositoryId?: string,
  ): Promise<Record<string, unknown>[]> {
    const repositories: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 500; page++) {
      const result = await this.api.call<{
        repositories: Record<string, unknown>[];
        continueCursor: string | null;
      }>("action", "github/action:listUserRepositories", {
        ...(cursor ? { cursor } : {}),
        ...(reconnectRepositoryId ? { reconnectRepositoryId } : {}),
      });
      repositories.push(...result.repositories);
      if (result.continueCursor === null) return repositories;
      if (seen.has(result.continueCursor))
        throw new Error(
          "GitHub returned a repeated repository page. Try again later.",
        );
      seen.add(result.continueCursor);
      cursor = result.continueCursor;
    }
    throw new Error(
      "Too many repository pages. Use projects available --cursor for explicit pagination.",
    );
  }

  async connect(
    name: string,
    reconnectRepositoryId?: string,
  ): Promise<Repository> {
    repositoryName(name);
    const [owner, repo] = name.split("/");
    const existing = await this.api.call<Repository | null>(
      "query",
      "repositories/query:get",
      { owner, repo },
    );
    if (existing && !reconnectRepositoryId) return existing;
    const available = await this.available(reconnectRepositoryId);
    const matches = available.filter(
      (item) => String(item.fullName).toLowerCase() === name.toLowerCase(),
    );
    if (matches.length !== 1)
      throw new Error(
        `Repository ${name} is unavailable. Run npx gitdog@latest github install, authorize it, then npx gitdog@latest github recover. Check projects available.`,
      );
    const item = matches[0];
    if (typeof item.installationId !== "number" || typeof item.id !== "number")
      throw new Error("GitHub returned invalid repository identifiers.");
    this.ui.info(`Connecting ${name} and scheduling repository indexing…`);
    await this.api.call("action", "repositories/action:createAndIndex", {
      installationId: item.installationId,
      githubRepositoryId: item.id,
      ...(reconnectRepositoryId ? { reconnectRepositoryId } : {}),
    });
    const result = await this.api.call<Repository | null>(
      "query",
      "repositories/query:get",
      { owner, repo },
    );
    if (!result)
      throw new Error(
        "The connection was accepted but is not readable yet. Check projects list before retrying.",
      );
    return result;
  }

  async init(name?: string, alias = "default", force = false): Promise<void> {
    this.ui.banner();
    aliasName(alias);
    const path =
      (await findConfig(this.configOption)) ??
      join(process.cwd(), "gitdog.json");
    const previous = await readJson(path);
    if (previous !== undefined && !force)
      throw new Error(
        `Project configuration already exists at ${path}. Use npx gitdog@latest use --add, or --force to replace it.`,
      );
    if (!name) {
      let detected: string | undefined;
      try {
        const { stdout } = await promisify(execFile)(
          "git",
          ["remote", "get-url", "origin"],
          { timeout: 5000 },
        );
        const match =
          /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([^\s]+?)\/?$/.exec(
            stdout.trim(),
          );
        if (match) detected = repositoryName(match[1].replace(/\.git$/, ""));
      } catch {
        /* A project can be initialized outside a Git checkout. */
      }
      this.ui.info("1 / 3  Choose a GitHub repository");
      name = await this.ui.ask("Repository (owner/repo)", detected);
    }
    this.ui.info("2 / 3  Connect your Gitdog project");
    const repo = await this.connect(name);
    const value: ProjectConfig = {
      version: 1,
      defaultProject: alias,
      projects: {
        [alias]: {
          repository: repo.githubRepo,
          settings: validateSettings(repo.settings, true),
        },
      },
    };
    this.ui.info("3 / 3  Save project settings");
    await writeJson(path, value);
    this.ui.output({
      initialized: true,
      project: repo.githubRepo,
      alias,
      config: path,
    });
    this.ui.info(
      "✓ Ready. Try npx gitdog@latest status, npx gitdog@latest config get, or npx gitdog@latest tickets list.",
    );
  }

  async use(selection?: string, add?: string, list = false): Promise<void> {
    const { path, value } = await this.config();
    if (add) {
      aliasName(add);
      if (!selection)
        throw new Error("Use npx gitdog@latest use owner/repo --add alias.");
      if (Object.hasOwn(value.projects, add))
        throw new Error(`Alias ${add} already exists. Choose a new alias.`);
      const repo = await this.repository(selection);
      value.projects[add] = {
        repository: repo.githubRepo,
        settings: validateSettings(repo.settings, true),
      };
      value.defaultProject = add;
    } else if (selection) {
      if (!Object.hasOwn(value.projects, selection))
        throw new Error(
          `Unknown alias ${selection}. Use --add alias to add a project.`,
        );
      value.defaultProject = selection;
    }
    if (selection || add) await writeJson(path, value);
    this.ui.output(
      list
        ? Object.entries(value.projects).map(([name, project]) => ({
            name,
            githubRepo: project.repository,
            status: name === value.defaultProject ? "active" : "",
          }))
        : {
            alias: value.defaultProject,
            project: value.projects[value.defaultProject].repository,
          },
    );
  }

  async localProject(): Promise<{
    path: string;
    value: ProjectConfig;
    alias: string;
    project: Project;
  }> {
    const { path, value } = await this.config();
    const alias = this.selected ?? value.defaultProject;
    const match = Object.hasOwn(value.projects, alias)
      ? alias
      : Object.keys(value.projects).find(
          (key) =>
            value.projects[key].repository.toLowerCase() ===
            alias.toLowerCase(),
        );
    if (!match)
      throw new Error(
        "This project has no local settings. Add it with npx gitdog@latest use owner/repo --add alias.",
      );
    return { path, value, alias: match, project: value.projects[match] };
  }

  async configGet(key?: string, remote = false): Promise<void> {
    const settings = remote
      ? (await this.repository()).settings
      : (await this.localProject()).project.settings;
    if (key && !Object.hasOwn(settings, key))
      throw new Error(`Setting ${key} is not set.`);
    this.ui.output(key ? settings[key as keyof Settings] : settings);
  }

  async configSet(key: string, text: string): Promise<void> {
    const value: unknown = BOOLEAN_SETTINGS.includes(
      key as (typeof BOOLEAN_SETTINGS)[number],
    )
      ? text === "true"
        ? true
        : text === "false"
          ? false
          : text
      : text;
    const patch = validateSettings({ [key]: value });
    const local = await this.localProject();
    local.project.settings = { ...local.project.settings, ...patch };
    await writeJson(local.path, local.value);
    this.ui.output({ saved: true, settings: patch });
    this.ui.info("Saved locally. Run npx gitdog@latest config push to apply.");
  }

  async configPull(force = false): Promise<void> {
    const local = await this.localProject();
    const settings = validateSettings(
      (await this.repository(local.project.repository)).settings,
      true,
    );
    await this.ui.confirm(
      "Replace local settings with server settings?",
      force,
    );
    local.project.settings = settings;
    await writeJson(local.path, local.value);
    this.ui.output({ pulled: true, settings });
  }

  async configPush(dryRun = false, yes = false): Promise<void> {
    const local = await this.localProject();
    const repo = await this.repository(local.project.repository);
    const before = validateSettings(repo.settings, true);
    const after = validateSettings(
      { ...before, ...local.project.settings },
      true,
    );
    const changes = Object.entries(after)
      .filter(([key, value]) => before[key as keyof Settings] !== value)
      .map(([key, value]) => ({
        key,
        before: before[key as keyof Settings] ?? null,
        after: value,
      }));
    if (!this.ui.json) this.ui.output({ project: repo.githubRepo, changes });
    if (dryRun || changes.length === 0) {
      this.ui.output({
        dryRun,
        applied: false,
        project: repo.githubRepo,
        changes,
      });
      return;
    }
    await this.ui.confirm(
      `Apply ${changes.length} setting change(s) to ${repo.githubRepo}?`,
      yes,
    );
    await this.api.call("mutation", "repositories/mutation:updateSettings", {
      repositoryId: repo._id,
      settings: after,
    });
    const actual = validateSettings(
      (await this.repository(local.project.repository)).settings,
      true,
    );
    if (
      Object.entries(after).some(
        ([key, value]) => actual[key as keyof Settings] !== value,
      )
    )
      throw new Error(
        "Settings changed during verification. Run config get --remote and compare before retrying.",
      );
    this.ui.output({
      applied: true,
      project: repo.githubRepo,
      changes,
      settings: actual,
    });
  }
}

export async function chooseProject(ui: Ui, api: Api): Promise<string> {
  const repos = await api.call<Repository[]>(
    "query",
    "repositories/query:list",
  );
  ui.output(repos);
  return ui.ask("Repository to use (owner/repo)");
}

export const limitParser = (value: string) => integer(value, 1, 500);
