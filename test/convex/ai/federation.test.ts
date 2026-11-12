import {
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  generateKeyPair,
  exportPKCS8,
  exportJWK,
  decodeJwt,
  decodeProtectedHeader,
} from "jose";
import {
  createWorkloadAssertion,
  createAnthropicFederationAuthorizer,
  getWorkloadJwks,
  getWorkloadIdentity,
} from "../../../convex/_ai/federation";
import { CLAUDE_API_ENDS_AT } from "../../../convex/_ai/config";
import {
  ClaudeProvider,
  CreditFallbackProvider,
  OpenAIProvider,
} from "../../../convex/_ai/providers";
import { convexTest } from "convex-test";
import schema from "../../../convex/schema";
import { internal } from "../../../convex/_generated/api";

const now = Date.parse("2026-11-03T00:00:00Z");
let environment: Parameters<typeof createWorkloadAssertion>[0];
beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  environment = {
    CONVEX_SITE_URL: "https://fortunate-chihuahua-679.convex.site",
    JWT_PRIVATE_KEY: await exportPKCS8(pair.privateKey),
    JWKS: JSON.stringify({ keys: [await exportJWK(pair.publicKey)] }),
    ANTHROPIC_ORGANIZATION_ID: "00000000-0000-0000-0000-000000000001",
    ANTHROPIC_FEDERATION_RULE_ID: "fdrl_test",
    ANTHROPIC_SERVICE_ACCOUNT_ID: "svac_test",
    ANTHROPIC_WORKSPACE_ID: "wrkspc_test",
    ANTHROPIC_FEDERATION_SCOPE: "workspace:inference",
  };
});
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(now);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function credentials(expires = 300) {
  return Response.json({
    access_token: "sk-ant-oat01-test",
    token_type: "Bearer",
    scope: "workspace:inference",
    expires_in: expires,
  });
}

describe("Convex workload identity", () => {
  it("publishes only public RSA fields with deterministic matching kid", async () => {
    const source = JSON.parse(environment.JWKS!);
    Object.assign(source.keys[0], {
      d: "private",
      p: "private",
      extra: "private",
    });
    const { keys } = await getWorkloadJwks(JSON.stringify(source));
    expect(Object.keys(keys[0]).sort()).toEqual([
      "alg",
      "e",
      "kid",
      "kty",
      "n",
      "use",
    ]);
    const first = await createWorkloadAssertion(environment);
    const second = await createWorkloadAssertion(environment);
    expect(decodeProtectedHeader(first)).toEqual({
      alg: "RS256",
      kid: keys[0].kid,
    });
    expect(decodeJwt(first)).toMatchObject({
      iss: environment.CONVEX_SITE_URL,
      sub: "gitdog:ai:fortunate-chihuahua-679.convex.site",
      aud: "https://api.anthropic.com",
      workload: "gitdog-ai",
      iat: now / 1000,
      exp: now / 1000 + 300,
    });
    expect(decodeJwt(first).jti).not.toBe(decodeJwt(second).jti);
  });

  it.each([
    "http://a.convex.site",
    "https://a.convex.site/",
    "https://a.convex.site/path",
    "https://a.example.com",
    "https://user@a.convex.site",
  ])("rejects invalid issuer %s", (issuer) => {
    expect(() => getWorkloadIdentity(issuer)).toThrow();
  });

  it("rejects mismatched signing keys without inference or exchange", async () => {
    const pair = await generateKeyPair("RS256", { extractable: true });
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(
      createAnthropicFederationAuthorizer({
        ...environment,
        JWT_PRIVATE_KEY: await exportPKCS8(pair.privateKey),
      })(),
    ).rejects.toMatchObject({ billingOutcome: "not_billed" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("caps assertions at the exclusive deadline", async () => {
    const assertion = await createWorkloadAssertion(
      environment,
      CLAUDE_API_ENDS_AT - 10_000,
    );
    expect(decodeJwt(assertion).exp).toBe(CLAUDE_API_ENDS_AT / 1000);
    await expect(
      createWorkloadAssertion(environment, CLAUDE_API_ENDS_AT),
    ).rejects.toMatchObject({
      billingOutcome: "not_billed",
      canFallback: true,
    });
  });
});

describe("Anthropic federation exchange", () => {
  it("accepts the explicitly approved workspace developer scope", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        access_token: "sk-ant-oat01-test",
        token_type: "Bearer",
        expires_in: 300,
        scope: "workspace:developer",
      }),
    );
    expect(
      await createAnthropicFederationAuthorizer({
        ...environment,
        ANTHROPIC_FEDERATION_SCOPE: "workspace:developer",
      })(),
    ).toEqual({ Authorization: "Bearer sk-ant-oat01-test" });
  });

  it("never permits organization administrator scope", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(
      createAnthropicFederationAuthorizer({
        ...environment,
        ANTHROPIC_FEDERATION_SCOPE: "org:admin",
      })(),
    ).rejects.toMatchObject({ billingOutcome: "not_billed" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, "workspace:developer", "org:admin"])(
    "rejects an unexpected token scope %s",
    async (scope) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        Response.json({
          access_token: "sk-ant-oat01-test",
          token_type: "Bearer",
          expires_in: 300,
          scope,
        }),
      );
      await expect(
        createAnthropicFederationAuthorizer(environment)(),
      ).rejects.toMatchObject({ billingOutcome: "not_billed" });
    },
  );

  it("sends only bearer authentication to inference", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(credentials())
      .mockResolvedValueOnce(
        Response.json({
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    const provider = new ClaudeProvider(
      "unused-key",
      createAnthropicFederationAuthorizer(environment),
    );
    await provider.chat([{ role: "user", content: "Hi" }]);
    const headers = new Headers(fetch.mock.calls[1][1]!.headers);
    expect(headers.get("Authorization")).toBe("Bearer sk-ant-oat01-test");
    expect(headers.has("x-api-key")).toBe(false);
  });

  it("caches bearer credentials and refreshes with a fresh assertion", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => credentials());
    const authorize = createAnthropicFederationAuthorizer(environment);
    expect(await authorize()).toEqual({
      Authorization: "Bearer sk-ant-oat01-test",
    });
    await authorize();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(
      "https://api.anthropic.com/v1/oauth/token",
    );
    const first = JSON.parse(fetch.mock.calls[0][1]!.body as string);
    expect(first).toMatchObject({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      federation_rule_id: "fdrl_test",
      service_account_id: "svac_test",
      workspace_id: "wrkspc_test",
    });
    vi.mocked(Date.now).mockReturnValue(now + 275_000);
    await authorize();
    const second = JSON.parse(fetch.mock.calls[1][1]!.body as string);
    expect(decodeJwt(second.assertion).jti).not.toBe(
      decodeJwt(first.assertion).jti,
    );
  });

  it.each([401, 503])(
    "keeps auth HTTP %s failures non-billed",
    async (status) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("Rejected", { status }),
      );
      await expect(
        createAnthropicFederationAuthorizer(environment)(),
      ).rejects.toMatchObject({
        billingOutcome: "not_billed",
        canFallback: false,
      });
    },
  );

  it("keeps network or malformed credential errors non-billed", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("network secret"))
      .mockResolvedValueOnce(
        Response.json({
          access_token: "bad",
          expires_in: 300,
          token_type: "Bearer",
        }),
      );
    const authorize = createAnthropicFederationAuthorizer(environment);
    await expect(authorize()).rejects.toMatchObject({
      billingOutcome: "not_billed",
      message: "Claude identity exchange could not complete",
    });
    await expect(authorize()).rejects.toMatchObject({
      billingOutcome: "not_billed",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("counts exchange delay against credential lifetime", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      vi.mocked(Date.now).mockReturnValue(now + 280_000);
      return credentials();
    });
    await expect(
      createAnthropicFederationAuthorizer(environment)(),
    ).rejects.toMatchObject({ billingOutcome: "not_billed" });
  });

  it("does not use cached credentials at or after the deadline", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(credentials());
    vi.mocked(Date.now).mockReturnValue(CLAUDE_API_ENDS_AT - 60_000);
    const authorize = createAnthropicFederationAuthorizer(environment);
    await authorize();
    vi.mocked(Date.now).mockReturnValue(CLAUDE_API_ENDS_AT);
    await expect(authorize()).rejects.toMatchObject({ canFallback: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("can authenticate during the final 30 seconds before cutoff", async () => {
    vi.mocked(Date.now).mockReturnValue(CLAUDE_API_ENDS_AT - 20_000);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(credentials(60));
    const authorize = createAnthropicFederationAuthorizer(environment);
    expect(await authorize()).toEqual({
      Authorization: "Bearer sk-ant-oat01-test",
    });
    await authorize();
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.mocked(Date.now).mockReturnValue(CLAUDE_API_ENDS_AT);
    await expect(authorize()).rejects.toMatchObject({ canFallback: true });
  });

  it("switches to OpenAI if the deadline crosses during exchange", async () => {
    vi.mocked(Date.now).mockReturnValue(CLAUDE_API_ENDS_AT - 60_000);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => {
        vi.mocked(Date.now).mockReturnValue(CLAUDE_API_ENDS_AT);
        return credentials();
      })
      .mockResolvedValueOnce(
        Response.json({
          status: "completed",
          output: [
            { type: "message", content: [{ type: "output_text", text: "ok" }] },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
      );
    const router = new CreditFallbackProvider(
      new ClaudeProvider("", createAnthropicFederationAuthorizer(environment)),
      new OpenAIProvider("test"),
    );
    expect((await router.chat([{ role: "user", content: "Hi" }])).content).toBe(
      "ok",
    );
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      "https://api.anthropic.com/v1/oauth/token",
      "https://api.openai.com/v1/responses",
    ]);
  });
});

describe("deployment-admin authentication diagnostic", () => {
  const modules = {
    "../../../convex/_generated/api.ts": () =>
      import("../../../convex/_generated/api"),
    "../../../convex/aiAuth/internalAction.ts": () =>
      import("../../../convex/aiAuth/internalAction"),
  };

  it("verifies exchange and model access without inference or secret output", async () => {
    for (const [name, value] of Object.entries(environment))
      vi.stubEnv(name, value);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(credentials())
      .mockResolvedValueOnce(Response.json({ data: [] }));
    const result = await convexTest(schema, modules).action(
      internal.aiAuth.internalAction.checkClaudeFederation,
      {},
    );
    expect(result).toEqual({ ok: true, httpStatus: 200 });
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      "https://api.anthropic.com/v1/oauth/token",
      "https://api.anthropic.com/v1/models?limit=1",
    ]);
    expect(JSON.stringify(result)).not.toContain("sk-ant-");
  });

  it("makes no authentication or model request at the cutoff", async () => {
    vi.mocked(Date.now).mockReturnValue(CLAUDE_API_ENDS_AT);
    const fetch = vi.spyOn(globalThis, "fetch");
    expect(
      await convexTest(schema, modules).action(
        internal.aiAuth.internalAction.checkClaudeFederation,
        {},
      ),
    ).toEqual({ ok: false, error: "Claude API access has ended" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds explicit inference QA and returns usage without response content", async () => {
    for (const [name, value] of Object.entries(environment))
      vi.stubEnv(name, value);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(credentials())
      .mockResolvedValueOnce(
        Response.json({
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 9, output_tokens: 2 },
        }),
      );
    const result = await convexTest(schema, modules).action(
      internal.aiAuth.internalAction.checkClaudeGeneration,
      {},
    );
    expect(result).toEqual({ ok: true, inputTokens: 9, outputTokens: 2 });
    const request = JSON.parse(fetch.mock.calls[1][1]!.body as string);
    expect(request).toMatchObject({
      max_tokens: 512,
      messages: [
        { role: "user", content: [{ type: "text", text: "Reply OK." }] },
      ],
    });
  });
});
