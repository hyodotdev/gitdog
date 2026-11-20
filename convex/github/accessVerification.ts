import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  fetchAccessibleGitHubInstallationIds,
  GITHUB_INSTALLATION_ATTESTATION_REQUEST_TIMEOUT_MS,
  githubApiHeaders,
} from "./oauthInstallationAttestation";
import {
  ACCESS_VERIFICATION_RESULT_PARAM,
  type AccessVerificationResult,
} from "./accessVerificationResult";

/**
 * "Verify GitHub access": a GitHub App user authorization, separate from
 * sign-in, that records which installations the signed-in user can reach.
 * The user token lives only for the callback request and is revoked after.
 */
export const ACCESS_VERIFICATION_CALLBACK_PATH = "/github/access/callback";
export const ACCESS_VERIFICATION_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_RETURN_PATH = "/repositories/connect";

/**
 * Where GitHub sends the user back: the same site as sign-in's OAuth
 * callback, so one GitHub App lists both under one host.
 */
export function accessVerificationRedirectUri(): string | null {
  const site =
    process.env.CUSTOM_AUTH_SITE_URL || process.env.CONVEX_SITE_URL || null;
  return site && `${site}${ACCESS_VERIFICATION_CALLBACK_PATH}`;
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

/** A random secret for the OAuth state or the PKCE verifier. */
export function generateSecret(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashState(state: string): Promise<string> {
  return Array.from(await sha256(state), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** A path on Gitdog's site to return to; anything else is refused. */
export function readReturnPath(value: string): string | null {
  if (!value.startsWith("/") || value.includes("\\")) return null;
  const base = "https://gitdog.invalid";
  try {
    const url = new URL(value, base);
    // Check the normalized path: "/..//evil.example" becomes "//evil.example",
    // which a browser reads as another host.
    if (url.origin !== base || url.pathname.startsWith("//")) return null;
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

export async function buildAuthorizeUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeVerifier: string;
}): Promise<string> {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("state", args.state);
  url.searchParams.set(
    "code_challenge",
    base64Url(await sha256(args.codeVerifier)),
  );
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("allow_signup", "false");
  return url.toString();
}

async function requestJson(
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(
      GITHUB_INSTALLATION_ATTESTATION_REQUEST_TIMEOUT_MS,
    ),
  });
  if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
  const payload = (await response.json()) as unknown;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload))
    throw new Error("GitHub returned an invalid response");
  return payload as Record<string, unknown>;
}

async function exchangeCode(args: {
  code: string;
  codeVerifier: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<string> {
  const payload = await requestJson(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: args.clientId,
        client_secret: args.clientSecret,
        code: args.code,
        code_verifier: args.codeVerifier,
        redirect_uri: args.redirectUri,
      }),
    },
  );
  const token = payload.access_token;
  if (typeof token !== "string" || token === "")
    throw new Error("GitHub did not grant user authorization");
  return token;
}

async function fetchGitHubAccountId(token: string): Promise<string> {
  const user = await requestJson("https://api.github.com/user", {
    headers: githubApiHeaders(`Bearer ${token}`),
  });
  if (typeof user.id !== "number" || !Number.isSafeInteger(user.id))
    throw new Error("GitHub returned an invalid user");
  return user.id.toString();
}

/** Best effort: the token is never stored, and GitHub expires it anyway. */
async function revokeToken(args: {
  token: string;
  clientId: string;
  clientSecret: string;
}): Promise<void> {
  try {
    await fetch(`https://api.github.com/applications/${args.clientId}/token`, {
      method: "DELETE",
      headers: githubApiHeaders(
        `Basic ${btoa(`${args.clientId}:${args.clientSecret}`)}`,
      ),
      body: JSON.stringify({ access_token: args.token }),
      signal: AbortSignal.timeout(
        GITHUB_INSTALLATION_ATTESTATION_REQUEST_TIMEOUT_MS,
      ),
    });
  } catch {
    // The token expires on GitHub's side regardless.
  }
}

function returnTo(
  siteUrl: string,
  returnPath: string,
  result: AccessVerificationResult,
): Response {
  let url = new URL(returnPath, siteUrl);
  // Never leave Gitdog's site, whatever the stored path says.
  if (url.origin !== new URL(siteUrl).origin)
    url = new URL(DEFAULT_RETURN_PATH, siteUrl);
  url.searchParams.set(ACCESS_VERIFICATION_RESULT_PARAM, result);
  return new Response(null, {
    status: 302,
    headers: { Location: url.toString(), "Cache-Control": "no-store" },
  });
}

export const accessVerificationCallback = httpAction(async (ctx, request) => {
  const siteUrl = process.env.SITE_URL;
  const clientId = process.env.GITHUB_APP_CLIENT_ID;
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET;
  const redirectUri = accessVerificationRedirectUri();
  if (!siteUrl || !clientId || !clientSecret || !redirectUri)
    return new Response("GitHub access verification is not configured", {
      status: 503,
    });

  const params = new URL(request.url).searchParams;
  const state = params.get("state");
  if (!state) return returnTo(siteUrl, DEFAULT_RETURN_PATH, "failed");
  const pending = await ctx.runMutation(
    internal.github.internalMutation.consumeAccessVerification,
    { stateHash: await hashState(state), now: Date.now() },
  );
  if (!pending) return returnTo(siteUrl, DEFAULT_RETURN_PATH, "failed");
  if (pending.expired) return returnTo(siteUrl, pending.returnPath, "failed");

  const code = params.get("code");
  if (!code) {
    // Only the user declining is a cancellation; GitHub reports setup
    // problems such as a redirect_uri mismatch the same way.
    const declined = params.get("error") === "access_denied";
    if (!declined)
      console.error("GitHub access verification error:", params.get("error"));
    return returnTo(
      siteUrl,
      pending.returnPath,
      declined ? "cancelled" : "failed",
    );
  }

  let token: string | null = null;
  try {
    token = await exchangeCode({
      code,
      codeVerifier: pending.codeVerifier,
      clientId,
      clientSecret,
      redirectUri,
    });
    const [githubAccountId, installationIds] = await Promise.all([
      fetchGitHubAccountId(token),
      fetchAccessibleGitHubInstallationIds(token),
    ]);
    const result = await ctx.runMutation(
      internal.github.internalMutation.saveVerifiedInstallationAccess,
      { userId: pending.userId, githubAccountId, installationIds },
    );
    return returnTo(siteUrl, pending.returnPath, result);
  } catch (error) {
    // Messages never include the token.
    console.error(
      "GitHub access verification failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    return returnTo(siteUrl, pending.returnPath, "failed");
  } finally {
    if (token) await revokeToken({ token, clientId, clientSecret });
  }
});
