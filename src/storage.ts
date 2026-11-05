import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rmdir,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { asRecord } from "./ui.js";

export const DEFAULT_API_URL = "https://calm-hippopotamus-56.convex.cloud";
export const DEFAULT_SITE_URL = "https://gitdog.dev";
export const DEFAULT_AUTH_SITE_URL = "https://auth.gitdog.dev";
export type Tokens = { token: string; refreshToken: string };
export type Session = Tokens & { apiUrl: string; siteUrl: string };

export function configDirectory(): string {
  return (
    process.env.GITDOG_CONFIG_DIR ||
    join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "gitdog")
  );
}

export async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      `Cannot read ${path}. Check its permissions and JSON syntax.`,
    );
  }
}

export async function writeJson(
  path: string,
  value: unknown,
  privateFile = false,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await mkdir(dirname(path), {
    recursive: true,
    mode: privateFile ? 0o700 : 0o755,
  });
  if (privateFile) await chmod(dirname(path), 0o700);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", privateFile ? 0o600 : 0o644);
    try {
      signal?.throwIfAborted();
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    } finally {
      await file.close();
    }
    signal?.throwIfAborted();
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function validTokens(value: unknown): value is Tokens {
  const item = asRecord(value);
  return (
    typeof item?.token === "string" &&
    item.token.length > 0 &&
    typeof item.refreshToken === "string" &&
    item.refreshToken.length > 0
  );
}

export function validateUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL.`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `${label} must be an HTTPS origin (HTTP is allowed for localhost development).`,
    );
  }
  return url.origin;
}

export class SessionStore {
  readonly path = join(configDirectory(), "session.json");

  async read(): Promise<Session | undefined> {
    const value = await readJson(this.path);
    if (value === undefined) return undefined;
    const item = asRecord(value);
    if (
      !validTokens(value) ||
      typeof item?.apiUrl !== "string" ||
      typeof item.siteUrl !== "string"
    )
      throw new Error(
        "Invalid saved session. Run npx gitdog@latest logout, then npx gitdog@latest login.",
      );
    return {
      ...value,
      apiUrl: validateUrl(item.apiUrl, "Saved API URL"),
      siteUrl: validateUrl(item.siteUrl, "Saved site URL"),
    };
  }

  async save(session: Session, signal?: AbortSignal): Promise<void> {
    await writeJson(this.path, session, true, signal);
  }
  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }

  async locked<T>(
    callback: () => Promise<T>,
    requestDeadline?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const path = `${this.path}.lock`;
    const deadline = Math.min(Date.now() + 10_000, requestDeadline ?? Infinity);
    let handle;
    while (!handle) {
      signal?.throwIfAborted();
      if (Date.now() >= deadline)
        throw new Error(
          `Authentication lock timed out. Check that another Gitdog process is not running; stale lock: ${path} (recovery gate: ${path}.recovery).`,
        );
      try {
        const created = await open(path, "wx", 0o600);
        try {
          await created.writeFile(String(process.pid));
        } catch (error) {
          await created.close();
          await rm(path, { force: true });
          throw error;
        }
        handle = created;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await removeAbandonedLock(path)) continue;
        if (Date.now() >= deadline)
          throw new Error(
            `Another Gitdog process is updating authentication. Retry later; if it crashed, remove ${path}.`,
          );
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.min(100, Math.max(1, deadline - Date.now())),
          ),
        );
      }
    }
    try {
      signal?.throwIfAborted();
      return await callback();
    } finally {
      await handle.close();
      await rm(path, { force: true });
    }
  }
}

/** Remove a lock whose recorded owner process no longer exists. */
async function removeAbandonedLock(path: string): Promise<boolean> {
  const recovery = `${path}.recovery`;
  try {
    await mkdir(recovery, { mode: 0o700 });
  } catch {
    return false;
  }
  try {
    // Re-read under the recovery mutex: another waiter may have replaced the
    // dead owner's lock with a live lock before this cleaner acquired the gate.
    const content = (await readFile(path, "utf8")).trim();
    if (!/^[1-9]\d*$/.test(content)) return false;
    const owner = Number(content);
    if (!Number.isSafeInteger(owner) || owner === process.pid) return false;
    try {
      process.kill(owner, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
    }
    await rm(path);
    return true;
  } catch {
    return false;
  } finally {
    await rmdir(recovery);
  }
}

export function tokenExpiresSoon(token: string): boolean {
  try {
    const payload = asRecord(
      JSON.parse(
        Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
      ),
    );
    return (
      typeof payload?.exp !== "number" ||
      payload.exp * 1000 < Date.now() + 60_000
    );
  } catch {
    return true;
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
