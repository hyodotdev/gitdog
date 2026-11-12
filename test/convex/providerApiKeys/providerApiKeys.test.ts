import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  decryptProviderKey,
  encryptProviderKey,
} from "../../../convex/providerApiKeys/crypto";
import schema from "../../../convex/schema";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/providerApiKeys/action.ts": () =>
    import("../../../convex/providerApiKeys/action"),
  "../../../convex/providerApiKeys/mutation.ts": () =>
    import("../../../convex/providerApiKeys/mutation"),
  "../../../convex/providerApiKeys/query.ts": () =>
    import("../../../convex/providerApiKeys/query"),
  "../../../convex/providerApiKeys/internalMutation.ts": () =>
    import("../../../convex/providerApiKeys/internalMutation"),
  "../../../convex/providerApiKeys/internalQuery.ts": () =>
    import("../../../convex/providerApiKeys/internalQuery"),
};

const TEST_ENCRYPTION_KEY = btoa("k".repeat(32));
const ANTHROPIC_KEY = `sk-ant-api03-${"a".repeat(40)}`;
const OPENAI_KEY = `sk-proj-${"b".repeat(40)}`;
const originalEncryptionKey = process.env.BYOK_ENCRYPTION_KEY;

beforeEach(() => {
  process.env.BYOK_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalEncryptionKey === undefined)
    delete process.env.BYOK_ENCRYPTION_KEY;
  else process.env.BYOK_ENCRYPTION_KEY = originalEncryptionKey;
});

async function signedIn(t: ReturnType<typeof convexTest>) {
  const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
  return {
    userId,
    as: t.withIdentity({ subject: `${userId}|session` }),
  };
}

describe("provider key encryption", () => {
  it("round-trips and binds the ciphertext to its user and provider", async () => {
    const encrypted = await encryptProviderKey(
      "user-a",
      "anthropic",
      ANTHROPIC_KEY,
    );
    expect(encrypted.ciphertext).not.toContain(ANTHROPIC_KEY);
    const row = {
      userId: "user-a" as Id<"users">,
      provider: "anthropic" as const,
      ...encrypted,
    };
    await expect(decryptProviderKey(row)).resolves.toBe(ANTHROPIC_KEY);
    await expect(
      decryptProviderKey({ ...row, userId: "user-b" as Id<"users"> }),
    ).rejects.toThrow("could not be decrypted");
    await expect(
      decryptProviderKey({ ...row, provider: "openai" }),
    ).rejects.toThrow("could not be decrypted");
  });

  it("refuses a rotated or missing encryption key", async () => {
    const encrypted = await encryptProviderKey("user-a", "openai", OPENAI_KEY);
    process.env.BYOK_ENCRYPTION_KEY = btoa("z".repeat(32));
    await expect(
      decryptProviderKey({
        userId: "user-a" as Id<"users">,
        provider: "openai",
        ...encrypted,
      }),
    ).rejects.toThrow("different key");
    process.env.BYOK_ENCRYPTION_KEY = btoa("short");
    await expect(
      encryptProviderKey("user-a", "openai", OPENAI_KEY),
    ).rejects.toThrow("not configured");
    delete process.env.BYOK_ENCRYPTION_KEY;
    await expect(
      encryptProviderKey("user-a", "openai", OPENAI_KEY),
    ).rejects.toThrow("not configured");
  });
});

describe("provider key management", () => {
  it("validates, encrypts and lists a key without exposing it", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await signedIn(t);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    await expect(
      as.action(api.providerApiKeys.action.save, {
        provider: "anthropic",
        apiKey: ` ${ANTHROPIC_KEY} `,
      }),
    ).resolves.toEqual({
      provider: "anthropic",
      last4: ANTHROPIC_KEY.slice(-4),
      status: "active",
    });
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toContain("/v1/models/");
    expect((init?.headers as Record<string, string>)["x-api-key"]).toBe(
      ANTHROPIC_KEY,
    );

    const rows = await t.run(async (ctx) =>
      ctx.db.query("providerApiKeys").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(ANTHROPIC_KEY);
    await expect(decryptProviderKey(rows[0])).resolves.toBe(ANTHROPIC_KEY);

    const listed = await as.query(api.providerApiKeys.query.list, {});
    expect(listed).toEqual([
      expect.objectContaining({
        provider: "anthropic",
        last4: ANTHROPIC_KEY.slice(-4),
        status: "active",
        lastErrorCode: null,
      }),
    ]);
    expect(listed[0]).not.toHaveProperty("ciphertext");
    expect(listed[0]).not.toHaveProperty("iv");

    const other = t.withIdentity({
      subject: `${await t.run(async (ctx) => ctx.db.insert("users", {}))}|other`,
    });
    await expect(
      other.query(api.providerApiKeys.query.list, {}),
    ).resolves.toEqual([]);
    expect(rows[0].userId).toBe(userId);
  });

  it("stores nothing when the provider rejects the key or the model", async () => {
    const t = convexTest(schema, modules);
    const { as } = await signedIn(t);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 404 }));
    await expect(
      as.action(api.providerApiKeys.action.save, {
        provider: "openai",
        apiKey: OPENAI_KEY,
      }),
    ).rejects.toMatchObject({ data: { reason: "invalid_key" } });
    await expect(
      as.action(api.providerApiKeys.action.save, {
        provider: "openai",
        apiKey: OPENAI_KEY,
      }),
    ).rejects.toMatchObject({ data: { reason: "no_model_access" } });
    await expect(
      t.run(async (ctx) => ctx.db.query("providerApiKeys").collect()),
    ).resolves.toEqual([]);
  });

  it("rejects malformed keys and unauthenticated callers before any request", async () => {
    const t = convexTest(schema, modules);
    const { as } = await signedIn(t);
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(
      as.action(api.providerApiKeys.action.save, {
        provider: "anthropic",
        apiKey: OPENAI_KEY,
      }),
    ).rejects.toMatchObject({ data: { reason: "wrong_provider" } });
    await expect(
      as.action(api.providerApiKeys.action.save, {
        provider: "openai",
        apiKey: ANTHROPIC_KEY,
      }),
    ).rejects.toMatchObject({
      data: {
        reason: "wrong_provider",
        message: "This looks like an Anthropic API key.",
      },
    });
    await expect(
      as.action(api.providerApiKeys.action.save, {
        provider: "openai",
        apiKey: "not-a-key",
      }),
    ).rejects.toMatchObject({ data: { reason: "malformed" } });
    await expect(
      t.action(api.providerApiKeys.action.save, {
        provider: "anthropic",
        apiKey: ANTHROPIC_KEY,
      }),
    ).rejects.toMatchObject({ data: { reason: "unauthorized" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("limits key checks per user across providers, even before a key is saved", async () => {
    const t = convexTest(schema, modules);
    const { as } = await signedIn(t);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 401 }));
    for (const [provider, apiKey] of [
      ["anthropic", ANTHROPIC_KEY],
      ["openai", OPENAI_KEY],
      ["anthropic", ANTHROPIC_KEY],
      ["openai", OPENAI_KEY],
      ["anthropic", ANTHROPIC_KEY],
    ] as const) {
      await expect(
        as.action(api.providerApiKeys.action.save, { provider, apiKey }),
      ).rejects.toMatchObject({ data: { reason: "invalid_key" } });
    }
    await expect(
      as.action(api.providerApiKeys.action.save, {
        provider: "openai",
        apiKey: OPENAI_KEY,
      }),
    ).rejects.toMatchObject({ data: { reason: "rate_limited" } });
    expect(fetch).toHaveBeenCalledTimes(5);

    // Another user has an independent allowance.
    const other = await signedIn(t);
    fetch.mockResolvedValue(new Response("{}", { status: 200 }));
    await expect(
      other.as.action(api.providerApiKeys.action.save, {
        provider: "openai",
        apiKey: OPENAI_KEY,
      }),
    ).resolves.toMatchObject({ status: "active" });
  });

  it("accepts a restricted OpenAI key that cannot list models", async () => {
    const t = convexTest(schema, modules);
    const { as } = await signedIn(t);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 403 }),
    );
    await expect(
      as.action(api.providerApiKeys.action.save, {
        provider: "openai",
        apiKey: OPENAI_KEY,
      }),
    ).resolves.toMatchObject({ status: "active" });
    await expect(
      as.action(api.providerApiKeys.action.save, {
        provider: "anthropic",
        apiKey: ANTHROPIC_KEY,
      }),
    ).rejects.toMatchObject({ data: { reason: "invalid_key" } });
  });

  it("reports configuration problems without touching saved key status", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await signedIn(t);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    await as.action(api.providerApiKeys.action.save, {
      provider: "openai",
      apiKey: OPENAI_KEY,
    });
    process.env.BYOK_ENCRYPTION_KEY = btoa("z".repeat(32));
    // A different server key than the one keys were saved with is a server
    // misconfiguration, not a problem with this key.
    await expect(
      as.action(api.providerApiKeys.action.revalidate, { provider: "openai" }),
    ).rejects.toMatchObject({ data: { reason: "not_configured" } });
    delete process.env.BYOK_ENCRYPTION_KEY;
    await expect(
      as.action(api.providerApiKeys.action.save, {
        provider: "anthropic",
        apiKey: ANTHROPIC_KEY,
      }),
    ).rejects.toMatchObject({ data: { reason: "not_configured" } });
    expect(fetch).toHaveBeenCalledTimes(1);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("providerApiKeys").collect(),
    );
    expect(rows).toEqual([
      expect.objectContaining({ userId, provider: "openai", status: "active" }),
    ]);
    expect(rows[0].lastError).toBeUndefined();
  });

  it("records failures and removes a saved key", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await signedIn(t);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );
    await as.action(api.providerApiKeys.action.save, {
      provider: "openai",
      apiKey: OPENAI_KEY,
    });
    await t.mutation(
      internal.providerApiKeys.internalMutation.recordKeyFailure,
      { userId, provider: "openai", code: "out_of_credit", httpStatus: 429 },
    );
    await expect(as.query(api.providerApiKeys.query.list, {})).resolves.toEqual(
      [
        expect.objectContaining({
          status: "out_of_credit",
          lastErrorCode: "out_of_credit",
        }),
      ],
    );
    await expect(
      as.action(api.providerApiKeys.action.revalidate, { provider: "openai" }),
    ).resolves.toEqual({ provider: "openai", status: "active" });

    await expect(
      as.mutation(api.providerApiKeys.mutation.remove, { provider: "openai" }),
    ).resolves.toEqual({ removed: true, provider: "openai" });
    await expect(as.query(api.providerApiKeys.query.list, {})).resolves.toEqual(
      [],
    );
  });
});

describe("provider key failure notices", () => {
  it("notifies once per status change, not once per failed request", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await signedIn(t);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );
    await as.action(api.providerApiKeys.action.save, {
      provider: "anthropic",
      apiKey: ANTHROPIC_KEY,
    });
    const fail = (code: "invalid" | "out_of_credit" | "rate_limited") =>
      t.mutation(internal.providerApiKeys.internalMutation.recordKeyFailure, {
        userId,
        provider: "anthropic",
        code,
      });
    await fail("out_of_credit");
    await fail("out_of_credit");
    await fail("rate_limited");
    await fail("invalid");
    const notifications = await t.run(async (ctx) =>
      ctx.db.query("notifications").collect(),
    );
    expect(notifications).toEqual([
      expect.objectContaining({
        userId,
        type: "provider_key_failed",
        title: "Anthropic API key out of credit",
        isRead: false,
      }),
      expect.objectContaining({
        type: "provider_key_failed",
        title: "Anthropic API key rejected",
      }),
    ]);
  });

  it("reports a changed server key as a service problem, not unreadable keys", async () => {
    const t = convexTest(schema, modules);
    const { as } = await signedIn(t);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );
    await as.action(api.providerApiKeys.action.save, {
      provider: "openai",
      apiKey: OPENAI_KEY,
    });
    await expect(as.query(api.providerApiKeys.query.list, {})).resolves.toEqual(
      [expect.objectContaining({ readable: true })],
    );
    process.env.BYOK_ENCRYPTION_KEY = btoa("z".repeat(32));
    await expect(as.query(api.providerApiKeys.query.list, {})).resolves.toEqual(
      [
        expect.objectContaining({
          readable: true,
          serviceUnavailable: true,
          status: "active",
        }),
      ],
    );
  });
});

describe("provider key notice transitions", () => {
  it("notifies on every status change, again after a successful check, and once for an unreadable key", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await signedIn(t);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );
    await as.action(api.providerApiKeys.action.save, {
      provider: "openai",
      apiKey: OPENAI_KEY,
    });
    const fail = (code: "invalid" | "out_of_credit") =>
      t.mutation(internal.providerApiKeys.internalMutation.recordKeyFailure, {
        userId,
        provider: "openai",
        code,
      });
    await fail("invalid");
    await fail("out_of_credit");
    await t.mutation(internal.providerApiKeys.internalMutation.markValidated, {
      userId,
      provider: "openai",
    });
    await fail("invalid");
    const savedIv = async () =>
      (await t.run(async (ctx) => ctx.db.query("providerApiKeys").collect()))[0]
        .iv;
    const unreadable = async (keyIv?: string) =>
      t.mutation(internal.providerApiKeys.internalMutation.noteUnreadableKey, {
        userId,
        provider: "openai",
        keyIv: keyIv ?? (await savedIv()),
      });
    await unreadable();
    await unreadable();

    const notices = await t.run(async (ctx) =>
      ctx.db.query("notifications").collect(),
    );
    expect(notices.map((notice) => notice.providerKey)).toEqual([
      { provider: "openai", reason: "invalid" },
      { provider: "openai", reason: "out_of_credit" },
      { provider: "openai", reason: "invalid" },
      { provider: "openai", reason: "unreadable" },
    ]);

    // Saving the key again re-arms the unreadable notice, and a late report
    // about the replaced key is ignored.
    const replacedIv = await savedIv();
    await t.mutation(internal.providerApiKeys.internalMutation.upsert, {
      userId,
      provider: "openai",
      ...(await encryptProviderKey(userId, "openai", OPENAI_KEY)),
      last4: OPENAI_KEY.slice(-4),
    });
    await unreadable(replacedIv);
    expect(
      (await t.run(async (ctx) => ctx.db.query("providerApiKeys").collect()))[0]
        .unreadableAt,
    ).toBeUndefined();
    await unreadable();
    expect(
      (await t.run(async (ctx) => ctx.db.query("notifications").collect()))
        .length,
    ).toBe(5);
  });
});
