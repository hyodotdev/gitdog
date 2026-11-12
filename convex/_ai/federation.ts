import {
  calculateJwkThumbprint,
  exportJWK,
  importJWK,
  importPKCS8,
  jwtVerify,
  SignJWT,
  type JWK,
} from "jose";
import { CLAUDE_API_ENDS_AT } from "./config";
import { ChatProviderRequestError } from "./providerErrors";

export const ANTHROPIC_WORKLOAD_AUDIENCE = "https://api.anthropic.com";
export const WORKLOAD_JWKS_PATH = "/ai/workload/jwks.json";
const ASSERTION_LIFETIME_SECONDS = 300;
const EXCHANGE_TIMEOUT_MS = 15_000;

type FederationEnvironment = {
  CONVEX_SITE_URL?: string;
  JWT_PRIVATE_KEY?: string;
  JWKS?: string;
  ANTHROPIC_ORGANIZATION_ID?: string;
  ANTHROPIC_FEDERATION_RULE_ID?: string;
  ANTHROPIC_SERVICE_ACCOUNT_ID?: string;
  ANTHROPIC_WORKSPACE_ID?: string;
  ANTHROPIC_FEDERATION_SCOPE?: string;
};

function federationError(message: string): ChatProviderRequestError {
  // Federation never invokes inference. An auth/network failure cannot have
  // consumed generation tokens and must not leave an ambiguous billing hold.
  return new ChatProviderRequestError(message, "not_billed");
}

function requireBeforeDeadline(now: number): void {
  if (now >= CLAUDE_API_ENDS_AT) {
    throw new ChatProviderRequestError(
      "Claude API access has ended",
      "not_billed",
      {
        unavailable: true,
      },
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A separate public view; never modify Convex Auth's existing JWKS. */
export async function getWorkloadJwks(
  serialized: string,
): Promise<{ keys: JWK[] }> {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("Invalid workload public keys");
  }
  if (
    !isRecord(value) ||
    !Array.isArray(value.keys) ||
    value.keys.length < 1 ||
    value.keys.length > 10
  ) {
    throw new Error("Invalid workload public keys");
  }
  const keys: JWK[] = [];
  for (const entry of value.keys as unknown[]) {
    if (
      !isRecord(entry) ||
      entry.kty !== "RSA" ||
      typeof entry.n !== "string" ||
      typeof entry.e !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(entry.n) ||
      !/^[A-Za-z0-9_-]+$/.test(entry.e)
    ) {
      throw new Error("Invalid workload public keys");
    }
    // Explicit allowlist prevents private or unrelated JWK properties escaping.
    const publicKey: JWK = { kty: "RSA", n: entry.n, e: entry.e };
    await importJWK(publicKey, "RS256");
    const kid = await calculateJwkThumbprint(publicKey);
    if (keys.some((key) => key.kid === kid))
      throw new Error("Duplicate workload public key");
    keys.push({ ...publicKey, alg: "RS256", use: "sig", kid });
  }
  return { keys };
}

export function getWorkloadIdentity(issuer: string): {
  issuer: string;
  subject: string;
  audience: string;
} {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new Error("Invalid Convex workload issuer");
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== issuer ||
    url.username ||
    url.password ||
    !url.hostname.endsWith(".convex.site") ||
    url.port
  ) {
    throw new Error("Invalid Convex workload issuer");
  }
  return {
    issuer,
    subject: `gitdog:ai:${url.hostname}`,
    audience: ANTHROPIC_WORKLOAD_AUDIENCE,
  };
}

/** Server-only helper, not an exported Convex function or public mint endpoint. */
export async function createWorkloadAssertion(
  environment: FederationEnvironment,
  now: number = Date.now(),
): Promise<string> {
  requireBeforeDeadline(now);
  try {
    const identity = getWorkloadIdentity(environment.CONVEX_SITE_URL ?? "");
    const jwks = await getWorkloadJwks(environment.JWKS ?? "");
    const key = await importPKCS8(environment.JWT_PRIVATE_KEY ?? "", "RS256", {
      extractable: true,
    });
    const exported = await exportJWK(key);
    const kid = await calculateJwkThumbprint({
      kty: exported.kty,
      n: exported.n,
      e: exported.e,
    });
    const publicKey = jwks.keys.find((candidate) => candidate.kid === kid);
    if (!publicKey) throw new Error("Signing key does not match public keys");
    const issuedAt = Math.floor(now / 1000);
    const expiresAt = Math.min(
      issuedAt + ASSERTION_LIFETIME_SECONDS,
      Math.floor(CLAUDE_API_ENDS_AT / 1000),
    );
    if (expiresAt <= issuedAt)
      throw new Error("Workload assertion would already be expired");
    const assertion = await new SignJWT({ workload: "gitdog-ai" })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(identity.issuer)
      .setSubject(identity.subject)
      .setAudience(identity.audience)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .setJti(crypto.randomUUID())
      .sign(key);
    await jwtVerify(assertion, await importJWK(publicKey, "RS256"), {
      issuer: identity.issuer,
      audience: identity.audience,
      subject: identity.subject,
      algorithms: ["RS256"],
      currentDate: new Date(now),
    });
    return assertion;
  } catch (error) {
    if (error instanceof ChatProviderRequestError) throw error;
    throw federationError(
      "Claude workload identity could not be signed or verified",
    );
  }
}

/** No static Claude credential, token file, or browser/session token is used. */
export function createAnthropicFederationAuthorizer(
  environment: FederationEnvironment = process.env,
): () => Promise<Record<string, string>> {
  let cached: { token: string; expiresAt: number } | undefined;
  return async () => {
    requireBeforeDeadline(Date.now());
    if (cached && cached.expiresAt > Date.now() + 30_000) {
      return { Authorization: `Bearer ${cached.token}` };
    }
    try {
      const {
        ANTHROPIC_ORGANIZATION_ID: organizationId,
        ANTHROPIC_FEDERATION_RULE_ID: ruleId,
        ANTHROPIC_SERVICE_ACCOUNT_ID: serviceId,
        ANTHROPIC_WORKSPACE_ID: workspaceId,
      } = environment;
      if (
        !organizationId ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
          organizationId,
        ) ||
        !ruleId ||
        !/^fdrl_[A-Za-z0-9]+$/.test(ruleId) ||
        !serviceId ||
        !/^svac_[A-Za-z0-9]+$/.test(serviceId) ||
        !workspaceId ||
        !/^wrkspc_[A-Za-z0-9]+$/.test(workspaceId)
      ) {
        throw federationError(
          "Claude federation configuration is incomplete or invalid",
        );
      }
      const expectedScope =
        environment.ANTHROPIC_FEDERATION_SCOPE ?? "workspace:inference";
      if (
        expectedScope !== "workspace:inference" &&
        expectedScope !== "workspace:developer"
      ) {
        throw federationError(
          "Claude federation scope must be an approved workspace scope",
        );
      }
      const assertion = await createWorkloadAssertion(environment);
      requireBeforeDeadline(Date.now());
      const exchangeStartedAt = Date.now();
      const response = await fetch("https://api.anthropic.com/v1/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
          organization_id: organizationId,
          federation_rule_id: ruleId,
          service_account_id: serviceId,
          workspace_id: workspaceId,
        }),
        signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw federationError(
          `Claude identity exchange failed with HTTP ${response.status}`,
        );
      }
      const body: unknown = await response.json();
      if (
        !isRecord(body) ||
        typeof body.access_token !== "string" ||
        !/^sk-ant-oat01-[A-Za-z0-9_-]+$/.test(body.access_token) ||
        body.token_type !== "Bearer" ||
        body.scope !== expectedScope ||
        !Number.isSafeInteger(body.expires_in) ||
        (body.expires_in as number) < 1 ||
        (body.expires_in as number) > 86400
      ) {
        throw federationError(
          "Claude identity exchange returned invalid credentials",
        );
      }
      requireBeforeDeadline(Date.now());
      cached = {
        token: body.access_token,
        expiresAt: exchangeStartedAt + (body.expires_in as number) * 1000,
      };
      if (cached.expiresAt <= Date.now() + 30_000) {
        cached = undefined;
        throw federationError(
          "Claude identity exchange returned an expiring credential",
        );
      }
      return { Authorization: `Bearer ${cached.token}` };
    } catch (error) {
      if (error instanceof ChatProviderRequestError) throw error;
      throw federationError("Claude identity exchange could not complete");
    }
  };
}
