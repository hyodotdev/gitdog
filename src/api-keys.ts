import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { asRecord } from "./ui.js";
import { exists, validateUrl } from "./storage.js";

export type ProjectKey = {
  version: 1;
  apiKey: string;
  apiUrl: string;
  httpUrl: string;
  keyId: string;
  repositoryId: string;
  name: string;
  scopes: string[];
  expiresAt: number;
};

export function projectHttpUrl(apiUrl: string): string {
  return validateUrl(
    process.env.GITDOG_HTTP_URL ??
      apiUrl.replace(/\.convex\.cloud$/, ".convex.site"),
    "Project HTTP URL",
  );
}

export async function readProjectKey(path: string): Promise<ProjectKey> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(resolve(path), "utf8"));
  } catch {
    throw new Error(
      "Cannot read the API key file. Check its path, permissions and JSON syntax.",
    );
  }
  const key = asRecord(value);
  if (
    key?.version !== 1 ||
    typeof key.apiKey !== "string" ||
    !/^gdk_[a-f0-9]{64}$/.test(key.apiKey) ||
    typeof key.apiUrl !== "string" ||
    typeof key.httpUrl !== "string" ||
    typeof key.keyId !== "string" ||
    typeof key.repositoryId !== "string" ||
    typeof key.name !== "string" ||
    !Array.isArray(key.scopes) ||
    !key.scopes.every((scope) => typeof scope === "string") ||
    typeof key.expiresAt !== "number"
  )
    throw new Error("Invalid Gitdog project API key file.");
  return {
    version: 1,
    apiKey: key.apiKey,
    apiUrl: validateUrl(key.apiUrl, "Key API URL"),
    httpUrl: validateUrl(key.httpUrl, "Key HTTP URL"),
    keyId: key.keyId,
    repositoryId: key.repositoryId,
    name: key.name,
    scopes: key.scopes,
    expiresAt: key.expiresAt,
  };
}

/** Refuse key paths that Git would track, so secrets are not committed. */
export async function assertUntrackedKeyPath(path: string): Promise<void> {
  let directory = dirname(path);
  while (!(await exists(directory))) {
    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
  try {
    await promisify(execFile)("git", ["check-ignore", "-q", "--", path], {
      cwd: directory,
      timeout: 5000,
    });
  } catch (error) {
    // Exit 1 means inside a work tree and not ignored; anything else means
    // no repository or no Git, where the file cannot be committed by mistake.
    if ((error as { code?: unknown }).code === 1)
      throw new Error(
        "The key file would be inside a Git repository and not ignored. Choose a path outside the repository or add it to .gitignore.",
      );
  }
}

export async function saveProjectKey(
  path: string,
  key: ProjectKey,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(key, null, 2) + "\n");
  } catch (error) {
    await handle.close();
    await rm(path, { force: true });
    throw error;
  }
  await handle.close();
}

export async function callWithProjectKey<T>(
  apiUrl: string,
  keyFile: string | undefined,
  rawKey: string | undefined,
  kind: string,
  path: string,
  args: unknown,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  if (rawKey && keyFile)
    throw new Error("Select GITDOG_API_KEY or a key file, not both.");
  const credential = keyFile ? await readProjectKey(keyFile) : undefined;
  if (credential && credential.apiUrl !== apiUrl)
    throw new Error(
      "This API key file belongs to another API URL. Select the matching --api-url.",
    );
  const key = credential?.apiKey ?? rawKey;
  if (!key || !/^gdk_[a-f0-9]{64}$/.test(key))
    throw new Error("Invalid Gitdog project API key.");
  if (kind === "action")
    throw new Error(
      "This command requires an owner login. Project API keys cannot manage accounts, keys, billing or GitHub actions.",
    );
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Project API request timed out.");
  const response = await fetch(
    `${credential?.httpUrl ?? projectHttpUrl(apiUrl)}/v1/cli`,
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(remaining),
      headers: { "Content-Type": "application/json", "X-Gitdog-Api-Key": key },
      body: JSON.stringify({ kind, path, args }),
    },
  );
  let result: Record<string, unknown> | undefined;
  try {
    result = asRecord(await response.json());
  } catch {
    throw new Error(
      `Project API returned HTTP ${response.status} without a JSON response.`,
    );
  }
  if (!response.ok) {
    const error = asRecord(result?.error);
    throw new Error(
      typeof error?.message === "string"
        ? error.message
        : `Project API returned HTTP ${response.status}.`,
    );
  }
  if (!result || !Object.hasOwn(result, "value"))
    throw new Error("Invalid project API response.");
  return result.value as T;
}
