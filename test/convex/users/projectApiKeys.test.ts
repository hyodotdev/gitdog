import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { api, internal } from "../../../convex/_generated/api";
import schema from "../../../convex/schema";
import { hashApiKey } from "../../../convex/apiKeys/security";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/apiKeys/action.ts": () =>
    import("../../../convex/apiKeys/action"),
  "../../../convex/apiKeys/internalMutation.ts": () =>
    import("../../../convex/apiKeys/internalMutation"),
  "../../../convex/apiKeys/mutation.ts": () =>
    import("../../../convex/apiKeys/mutation"),
  "../../../convex/apiKeys/query.ts": () =>
    import("../../../convex/apiKeys/query"),
  "../../../convex/apiKeys/gateway.ts": () =>
    import("../../../convex/apiKeys/gateway"),
  "../../../convex/http.ts": () => import("../../../convex/http"),
  "../../../convex/repositories/mutation.ts": () =>
    import("../../../convex/repositories/mutation"),
};
const settings = {
  issueAssistantEnabled: true,
  autoFormatIssue: true,
  autoAnswerQuestions: true,
  tagMaintainersForCodeChanges: true,
  requireApproval: true,
  discussionAssistantEnabled: true,
  autoFormatDiscussion: true,
  autoAnswerDiscussionQuestions: true,
  tagMaintainersForDiscussionCodeChanges: true,
  requireApprovalForDiscussions: true,
};

async function fixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "key-owner" });
    const viewer = await ctx.db.insert("users", { name: "key-viewer" });
    const now = Date.now();
    await ctx.db.insert("githubInstallations", {
      userId: owner,
      installationId: 123,
      ownerGithubAccountId: "123",
      ownershipVerifiedAt: now,
      accountLogin: "owner",
      accountType: "User",
      targetType: "User",
      createdAt: now,
      updatedAt: now,
    });
    const makeRepo = (name: string, githubRepositoryId: number) =>
      ctx.db.insert("repositories", {
        userId: owner,
        installationId: 123,
        githubRepositoryId,
        githubRepo: name,
        githubRepoKey: name,
        name: name.split("/")[1],
        githubUrl: `https://github.com/${name}`,
        isActive: true,
        indexVersion: 1,
        indexStatus: "completed",
        indexProgressAt: now,
        indexSyncPending: false,
        ragStatus: "completed",
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        settings,
        monthlyActions: 0,
        lastResetAt: now,
        createdAt: now,
        updatedAt: now,
      });
    const repositoryId = await makeRepo("owner/project", 1);
    const otherRepositoryId = await makeRepo("owner/other", 2);
    const ticketId = await ctx.db.insert("tickets", {
      repositoryId,
      userId: owner,
      githubRepo: "owner/project",
      ticketType: "issue",
      githubNumber: 1,
      githubTitle: "Test ticket",
      aiInputVersion: 1,
      status: "open",
      createdAt: now,
    });
    const foreignTicketId = await ctx.db.insert("tickets", {
      repositoryId: otherRepositoryId,
      userId: owner,
      githubRepo: "owner/other",
      ticketType: "issue",
      githubNumber: 2,
      githubTitle: "Foreign ticket",
      aiInputVersion: 1,
      status: "open",
      createdAt: now,
    });
    return {
      owner,
      viewer,
      repositoryId,
      otherRepositoryId,
      ticketId,
      foreignTicketId,
    };
  });
  const owner = t.withIdentity({ subject: ids.owner });
  const viewer = t.withIdentity({ subject: ids.viewer });
  const create = (scopes: Array<"read" | "write"> = ["read"]) =>
    owner.action(api.apiKeys.action.create, {
      repositoryId: ids.repositoryId,
      name: "CI key",
      scopes,
      expiresInDays: 30,
    });
  const execute = async (
    key: string,
    path = "repositories/query:list",
    args = {},
    kind: "query" | "mutation" = "query",
  ) =>
    t.mutation(internal.apiKeys.gateway.execute, {
      tokenHash: await hashApiKey(key),
      path,
      kind,
      argsJson: JSON.stringify(args),
    });
  return { t, ids, owner, viewer, create, execute };
}

describe("project API key lifecycle and isolation", () => {
  it("bounds aggregate action bytes before exceeding the database read limit", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      for (let i = 0; i < 8; i++)
        await ctx.db.insert("ticketActions", {
          ticketId: f.ids.ticketId,
          actionType: "answer",
          chatHistory: [
            {
              role: "assistant",
              content: "x".repeat(900_000),
              timestamp: Date.now(),
            },
          ],
          proposalVersion: 1,
          status: "completed",
          createdAt: Date.now(),
        });
    });
    const key = await f.create();
    await expect(
      f.execute(key.key, "tickets/query:getById", { id: f.ids.ticketId }),
    ).rejects.toThrow("byte budget");
  });

  it("hydrates only the requested ticket page", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      for (let i = 0; i < 501; i++)
        await ctx.db.insert("ticketActions", {
          ticketId: f.ids.ticketId,
          actionType: "answer",
          chatHistory: [],
          proposalVersion: 1,
          status: "completed",
          createdAt: Date.now(),
        });
      await ctx.db.insert("tickets", {
        repositoryId: f.ids.repositoryId,
        userId: f.ids.owner,
        githubRepo: "owner/project",
        ticketType: "issue",
        githubNumber: 3,
        githubTitle: "Newest ticket",
        aiInputVersion: 1,
        status: "open",
        createdAt: Date.now(),
      });
    });
    const key = await f.create();
    const result = (await f.execute(key.key, "tickets/query:list", {
      limit: 1,
    })) as { items: Array<{ githubTitle: string }>; total: number };
    expect(result.total).toBe(2);
    expect(result.items[0].githubTitle).toBe("Newest ticket");
  });

  it("pending lists include open tickets and preserve the pendingActions contract", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      const closed = await ctx.db.insert("tickets", {
        repositoryId: f.ids.repositoryId,
        userId: f.ids.owner,
        githubRepo: "owner/project",
        ticketType: "issue",
        githubNumber: 4,
        githubTitle: "Closed ticket",
        aiInputVersion: 1,
        status: "closed",
        createdAt: Date.now(),
      });
      for (const ticketId of [f.ids.ticketId, closed])
        await ctx.db.insert("ticketActions", {
          ticketId,
          actionType: "answer",
          chatHistory: [],
          proposalVersion: 1,
          status: "pending_approval",
          createdAt: Date.now(),
        });
    });
    const key = await f.create();
    const result = (await f.execute(
      key.key,
      "tickets/query:listPendingApproval",
      {},
    )) as {
      items: Array<{ _id: string; pendingActions: unknown[] }>;
      total: number;
    };
    expect(result.total).toBe(1);
    expect(result.items[0]._id).toBe(f.ids.ticketId);
    expect(result.items[0].pendingActions).toHaveLength(1);
  });

  it("rejects coerced JSON filter and request types", async () => {
    const f = await fixture();
    const key = await f.create();
    for (const value of [["open"], {}, null, 1])
      await expect(
        f.execute(key.key, "tickets/query:list", { status: value }),
      ).rejects.toThrow();
    for (const value of [["issue"], {}, null, 1])
      await expect(
        f.execute(key.key, "tickets/query:list", { ticketType: value }),
      ).rejects.toThrow();
    for (const kind of [["query"], {}, null, 1]) {
      const response = await f.t.fetch("/v1/cli", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Gitdog-Api-Key": key.key,
        },
        body: JSON.stringify({
          kind,
          path: "repositories/query:list",
          args: {},
        }),
      });
      expect(response.status).toBe(400);
    }
  });

  it("bounds key issuance at 50 unrevoked keys", async () => {
    const f = await fixture();
    for (let i = 0; i < 50; i++) await f.create();
    await expect(f.create()).rejects.toThrow();
  });

  it("deletes key metadata through project disconnect cleanup", async () => {
    vi.useFakeTimers();
    try {
      const f = await fixture();
      const key = await f.create();
      await f.owner.mutation(api.repositories.mutation.remove, {
        repositoryId: f.ids.repositoryId,
      });
      await expect(f.execute(key.key)).rejects.toThrow();
      for (
        let i = 0;
        i < 30 && (await f.t.run((ctx) => ctx.db.get(f.ids.repositoryId)));
        i++
      ) {
        await f.t.mutation(
          internal.repositories.mutation.continueRepositoryDisconnectCleanup,
          { repositoryId: f.ids.repositoryId },
        );
      }
      expect(await f.t.run((ctx) => ctx.db.get(key.keyId))).toBeNull();
      expect(await f.t.run((ctx) => ctx.db.get(f.ids.repositoryId))).toBeNull();
      expect(
        await f.t.run((ctx) => ctx.db.get(f.ids.otherRepositoryId)),
      ).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
  it("issues a cryptographically random secret once and persists only its hash", async () => {
    const f = await fixture();
    const first = await f.create();
    const second = await f.create();
    expect(first.key).toMatch(/^gdk_[a-f0-9]{64}$/);
    expect(first.key).not.toBe(second.key);
    const stored = await f.t.run((ctx) => ctx.db.get(first.keyId));
    expect(stored?.tokenHash).toBe(await hashApiKey(first.key));
    expect(JSON.stringify(stored)).not.toContain(first.key);
    const list = await f.owner.query(api.apiKeys.query.list, {
      repositoryId: f.ids.repositoryId,
      paginationOpts: { numItems: 1, cursor: null },
    });
    expect(list.items).toHaveLength(1);
    expect(list.hasMore).toBe(true);
    expect(JSON.stringify(list)).not.toContain("tokenHash");
    expect(JSON.stringify(list)).not.toContain(first.key);
    expect(
      (
        await f.owner.query(api.apiKeys.query.list, {
          repositoryId: f.ids.repositoryId,
          paginationOpts: { numItems: 1, cursor: list.nextCursor },
        })
      ).items,
    ).toHaveLength(1);
  });

  it("requires an owner login for issuance, listing and revocation", async () => {
    const f = await fixture();
    const args = {
      repositoryId: f.ids.repositoryId,
      name: "Forbidden",
      scopes: ["read" as const],
      expiresInDays: 30,
    };
    await expect(f.t.action(api.apiKeys.action.create, args)).rejects.toThrow();
    await expect(
      f.viewer.action(api.apiKeys.action.create, args),
    ).rejects.toThrow();
    const key = await f.create();
    await expect(
      f.viewer.query(api.apiKeys.query.list, {
        repositoryId: f.ids.repositoryId,
        paginationOpts: { numItems: 20, cursor: null },
      }),
    ).rejects.toThrow();
    await expect(
      f.viewer.mutation(api.apiKeys.mutation.revoke, { keyId: key.keyId }),
    ).rejects.toThrow();
  });

  it.each([0, -1, 366, 1.5])(
    "rejects invalid expiry %s",
    async (expiresInDays) => {
      const f = await fixture();
      await expect(
        f.owner.action(api.apiKeys.action.create, {
          repositoryId: f.ids.repositoryId,
          name: "Key",
          scopes: ["read"],
          expiresInDays,
        }),
      ).rejects.toThrow();
    },
  );

  it("rejects write-only scopes, empty names and disconnected installations", async () => {
    const f = await fixture();
    await expect(
      f.owner.action(api.apiKeys.action.create, {
        repositoryId: f.ids.repositoryId,
        name: "Key",
        scopes: ["write"],
        expiresInDays: 1,
      }),
    ).rejects.toThrow();
    await expect(
      f.owner.action(api.apiKeys.action.create, {
        repositoryId: f.ids.repositoryId,
        name: "  ",
        scopes: ["read"],
        expiresInDays: 1,
      }),
    ).rejects.toThrow();
    await f.t.run((ctx) =>
      ctx.db.patch(f.ids.repositoryId, { githubAccessRevokedAt: Date.now() }),
    );
    await expect(f.create()).rejects.toThrow();
  });

  it("limits reads to the key's project and validates ticket ownership", async () => {
    const f = await fixture();
    const key = await f.create();
    const projects = (await f.execute(key.key)) as Array<{ _id: string }>;
    expect(projects.map((project) => project._id)).toEqual([
      f.ids.repositoryId,
    ]);
    await expect(
      f.execute(key.key, "repositories/query:get", {
        owner: "owner",
        repo: "other",
      }),
    ).rejects.toThrow();
    await expect(
      f.execute(key.key, "repositories/query:getById", {
        repositoryId: f.ids.otherRepositoryId,
      }),
    ).rejects.toThrow();
    await expect(
      f.execute(key.key, "tickets/query:getById", {
        id: f.ids.foreignTicketId,
      }),
    ).rejects.toThrow();
    expect(
      await f.execute(key.key, "tickets/query:getById", { id: f.ids.ticketId }),
    ).toMatchObject({ _id: f.ids.ticketId });
  });

  it("enforces read/write scopes and preserves omitted settings", async () => {
    const f = await fixture();
    const reader = await f.create();
    const writer = await f.create(["read", "write"]);
    const args = {
      repositoryId: f.ids.repositoryId,
      settings: { requireApproval: false },
    };
    await expect(
      f.execute(
        reader.key,
        "repositories/mutation:updateSettings",
        args,
        "mutation",
      ),
    ).rejects.toThrow();
    await f.execute(
      writer.key,
      "repositories/mutation:updateSettings",
      args,
      "mutation",
    );
    expect(
      (await f.t.run((ctx) => ctx.db.get(f.ids.repositoryId)))?.settings,
    ).toEqual({ ...settings, requireApproval: false });
    await expect(
      f.execute(
        writer.key,
        "repositories/mutation:updateSettings",
        { ...args, settings: { isAdmin: true } },
        "mutation",
      ),
    ).rejects.toThrow();
  });

  it("does not delegate account, billing, key management or arbitrary internal functions", async () => {
    const f = await fixture();
    const writer = await f.create(["read", "write"]);
    for (const path of [
      "users/query:getCurrentUser",
      "subscriptions/query:getCurrent",
      "apiKeys/query:list",
      "apiKeys/mutation:revoke",
      "repositories/mutation:remove",
      "admin/paymentMutation:addTokens",
      "auth:store",
    ]) {
      await expect(
        f.execute(
          writer.key,
          path,
          {},
          path.includes("mutation") ? "mutation" : "query",
        ),
      ).rejects.toThrow();
    }
  });

  it("revokes immediately and idempotently", async () => {
    const f = await fixture();
    const key = await f.create();
    await f.execute(key.key);
    expect(
      (await f.t.run((ctx) => ctx.db.get(key.keyId)))?.lastUsedAt,
    ).toBeTypeOf("number");
    await f.owner.mutation(api.apiKeys.mutation.revoke, { keyId: key.keyId });
    await f.owner.mutation(api.apiKeys.mutation.revoke, { keyId: key.keyId });
    await expect(f.execute(key.key)).rejects.toThrow();
  });

  it("rejects expired keys, deleted owners and project disconnects", async () => {
    const f = await fixture();
    const key = await f.create();
    await f.t.run((ctx) =>
      ctx.db.patch(key.keyId, { expiresAt: Date.now() - 1 }),
    );
    await expect(f.execute(key.key)).rejects.toThrow();
    await f.t.run((ctx) =>
      ctx.db.patch(key.keyId, { expiresAt: Date.now() + 10000 }),
    );
    await f.t.run((ctx) =>
      ctx.db.patch(f.ids.repositoryId, { disconnectCleanupPending: true }),
    );
    await expect(f.execute(key.key)).rejects.toThrow();
    await f.t.run((ctx) =>
      ctx.db.patch(f.ids.repositoryId, { disconnectCleanupPending: false }),
    );
    await f.t.run((ctx) => ctx.db.delete(f.ids.owner));
    await expect(f.execute(key.key)).rejects.toThrow();
  });

  it("allows scoped ticket deletion and restoration without crossing projects", async () => {
    const f = await fixture();
    const key = await f.create(["read", "write"]);
    await f.execute(
      key.key,
      "tickets/mutation:softDelete",
      { id: f.ids.ticketId },
      "mutation",
    );
    await expect(
      f.execute(key.key, "tickets/query:getById", { id: f.ids.ticketId }),
    ).rejects.toThrow();
    await f.execute(
      key.key,
      "tickets/mutation:restore",
      { id: f.ids.ticketId },
      "mutation",
    );
    await expect(
      f.execute(
        key.key,
        "tickets/mutation:softDelete",
        { id: f.ids.foreignTicketId },
        "mutation",
      ),
    ).rejects.toThrow();
    expect(
      await f.execute(key.key, "tickets/query:list", { limit: 10 }),
    ).toMatchObject({ total: 1 });
  });

  it("serves real HTTP responses, with no caching and structured revocation errors", async () => {
    const f = await fixture();
    const key = await f.create();
    const request = () =>
      f.t.fetch("/v1/cli", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Gitdog-Api-Key": key.key,
        },
        body: JSON.stringify({
          kind: "query",
          path: "repositories/query:list",
          args: {},
        }),
      });
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await response.json()).value).toHaveLength(1);
    await f.owner.mutation(api.apiKeys.mutation.revoke, { keyId: key.keyId });
    const revoked = await request();
    expect(revoked.status).toBe(401);
    expect((await revoked.json()).error.code).toBe("UNAUTHORIZED");
  });

  it("bounds request bodies and rejects malformed requests without leaking secrets", async () => {
    const f = await fixture();
    const key = await f.create();
    const headers = {
      "Content-Type": "application/json",
      "X-Gitdog-Api-Key": key.key,
    };
    expect(
      (await f.t.fetch("/v1/cli", { method: "POST", body: "{}" })).status,
    ).toBe(401);
    expect(
      (await f.t.fetch("/v1/cli", { method: "POST", headers, body: "broken" }))
        .status,
    ).toBe(400);
    expect(
      (
        await f.t.fetch("/v1/cli", {
          method: "POST",
          headers,
          body: "x".repeat(65537),
        })
      ).status,
    ).toBe(413);
    const result = await f.t.fetch("/v1/cli", {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "action", path: "auth:signIn", args: {} }),
    });
    expect(result.status).toBe(400);
    expect(await result.text()).not.toContain(key.key);
  });
});
