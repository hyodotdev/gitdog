import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";
import {
  SessionStore,
  tokenExpiresSoon,
  validTokens,
  type Session,
} from "./storage.js";
import { asRecord } from "./ui.js";
import { callWithProjectKey } from "./api-keys.js";

export type Kind = "query" | "mutation" | "action";
export type Args = Record<string, Value>;
export type CallOptions = { timeoutMs?: number };
export interface Api {
  call<T = unknown>(
    kind: Kind,
    path: string,
    args?: Args,
    options?: CallOptions,
  ): Promise<T>;
}

function remainingTimeout(deadline?: number): number {
  if (deadline === undefined) return 120_000;
  const remaining = Math.ceil(deadline - Date.now());
  if (remaining <= 0) throw new Error("The request timed out.");
  return remaining;
}

export function httpClient(
  url: string,
  timeout = 120_000,
  signal?: AbortSignal,
): ConvexHttpClient {
  return new ConvexHttpClient(url, {
    logger: false,
    skipConvexDeploymentUrlCheck: true,
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
          : AbortSignal.timeout(timeout),
      }),
  });
}

export async function invoke<T = unknown>(
  client: ConvexHttpClient,
  kind: Kind,
  path: string,
  args: Args = {},
): Promise<T> {
  switch (kind) {
    case "query":
      return (await client.query(
        makeFunctionReference<"query">(path),
        args,
      )) as T;
    case "mutation":
      return (await client.mutation(
        makeFunctionReference<"mutation">(path),
        args,
      )) as T;
    case "action":
      return (await client.action(
        makeFunctionReference<"action">(path),
        args,
      )) as T;
  }
}

export class GitdogApi implements Api {
  private client: ConvexHttpClient;
  private session?: Session;
  private ready = false;

  constructor(
    readonly apiUrl: string,
    readonly siteUrl: string,
    private store = new SessionStore(),
    private readonly keyFile?: string,
  ) {
    this.client = httpClient(apiUrl);
  }

  private async authenticate(deadline?: number): Promise<void> {
    if (this.ready && (!this.session || !tokenExpiresSoon(this.session.token)))
      return;
    const token = process.env.GITDOG_TOKEN;
    if (token) {
      this.client.setAuth(token);
      this.ready = true;
      return;
    }
    const initial = await this.store.read();
    if (!initial)
      throw new Error("You are not logged in. Run npx gitdog@latest login.");
    if (initial.apiUrl !== this.apiUrl)
      throw new Error(
        "This session belongs to another API URL. Run npx gitdog@latest login --api-url <url> first.",
      );
    this.session = initial;
    if (tokenExpiresSoon(initial.token)) {
      this.session = await this.store.locked(async () => {
        const current = await this.store.read();
        if (!current || current.apiUrl !== this.apiUrl)
          throw new Error(
            "Session changed. Run npx gitdog@latest login again.",
          );
        if (!tokenExpiresSoon(current.token)) return current;
        let result: unknown;
        try {
          result = await invoke(
            httpClient(this.apiUrl, remainingTimeout(deadline)),
            "action",
            "auth:signIn",
            {
              refreshToken: current.refreshToken,
            },
          );
        } catch {
          throw new Error(
            "Could not refresh your session. Check your connection or run npx gitdog@latest login again.",
          );
        }
        const tokens = asRecord(result)?.tokens;
        if (!validTokens(tokens))
          throw new Error(
            "Your session expired. Run npx gitdog@latest login again.",
          );
        const updated = { ...current, ...tokens };
        await this.store.save(updated);
        return updated;
      }, deadline);
    }
    this.client.setAuth(this.session.token);
    this.ready = true;
  }

  async call<T = unknown>(
    kind: Kind,
    path: string,
    args: Args = {},
    options?: CallOptions,
  ): Promise<T> {
    const deadline =
      options?.timeoutMs === undefined
        ? undefined
        : Date.now() + options.timeoutMs;
    const keyFile = this.keyFile ?? process.env.GITDOG_API_KEY_FILE;
    if (keyFile || process.env.GITDOG_API_KEY)
      return callWithProjectKey<T>(
        this.apiUrl,
        keyFile,
        process.env.GITDOG_API_KEY,
        kind,
        path,
        args,
        remainingTimeout(deadline),
      );
    await this.authenticate(deadline);
    if (options?.timeoutMs !== undefined) {
      const client = httpClient(this.apiUrl, remainingTimeout(deadline));
      client.setAuth(process.env.GITDOG_TOKEN ?? this.session!.token);
      return invoke<T>(client, kind, path, args);
    }
    return invoke<T>(this.client, kind, path, args);
  }
}
