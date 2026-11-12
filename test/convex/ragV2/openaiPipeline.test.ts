import { convexTest } from "convex-test";
import { drainScheduledFunctions } from "../scheduling";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { v } from "convex/values";
import { internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { internalQuery } from "../../../convex/_generated/server";
import schema from "../../../convex/schema";
import {
  CURRENT_PRIVACY_POLICY_VERSION,
  CURRENT_TERMS_VERSION,
} from "../../../convex/users/legal";
import { CODE_EMBEDDING_KEY } from "../../../convex/ragV2/action";
import { EMBEDDING_MODEL } from "../../../convex/_ai/retrievalEmbeddings";
vi.mock("../../../convex/github/helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../convex/github/helpers")>()),
  getRepositoryInstallationToken: async () => "test-installation-token",
}));
const content = 'export function uniqueNeedle() { return "stable"; }';
let filePaths = ["src/auth.ts"];
let fixtureContent = content;
const filePage = internalQuery({
  args: {
    repositoryId: v.id("repositories"),
    indexVersion: v.number(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async () => ({
    files: filePaths.map((path) => ({
      path,
      url: `https://fixture.test/${path}`,
      language: "typescript",
      size: fixtureContent.length,
      isText: true,
    })),
    hasMore: false,
    cursor: null,
  }),
});
const modules = {
  ...import.meta.glob("../../../convex/**/*.ts"),
  "../../../convex/repoIndexing/internalQuery.ts": async () => ({
    ...(await import("../../../convex/repoIndexing/internalQuery")),
    getRepositoryFilesPage: filePage,
  }),
};
beforeEach(() => {
  filePaths = ["src/auth.ts"];
  fixtureContent = content;
  vi.useFakeTimers();
  vi.stubEnv("SITE_URL", "https://gitdog.hyo.dev");
  vi.stubEnv("OPENAI_API_KEY", "test-openai");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
function vector() {
  return Array.from({ length: 1536 }, () => 1);
}
function mockNetwork() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const target = String(url);
    if (target.startsWith("https://fixture.test/"))
      return new Response(fixtureContent);
    if (target.startsWith("https://api.github.com/repositories/101"))
      return Response.json({
        id: 101,
        full_name: "owner/repo",
        visibility: "private",
        private: true,
        license: null,
      });
    if (target === "https://api.openai.com/v1/embeddings") {
      const request = JSON.parse(String(init?.body));
      return Response.json({
        model: EMBEDDING_MODEL,
        usage: { prompt_tokens: 2, total_tokens: 2 },
        data: request.input.map((_: unknown, index: number) => ({
          index,
          embedding: vector(),
        })),
      });
    }
    throw new Error("Unexpected external request: " + target);
  });
}
async function insertFixture(t: ReturnType<typeof convexTest>): Promise<{
  userId: Id<"users">;
  repositoryId: Id<"repositories">;
  ticketActionId: Id<"ticketActions">;
  requirePendingTicketAction: true;
}> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", {});
    const repositoryId = await ctx.db.insert("repositories", {
      indexSyncPending: false,
      indexVersion: 1,
      indexStatus: "completed",
      indexProgressAt: Date.now(),
      ragStatus: "completed",
      ragTotalChunks: 0,
      ragIndexedChunks: 0,
      ragFailedChunks: 0,
      userId,
      installationId: 101,
      githubRepositoryId: 101,
      githubRepo: "owner/repo",
      githubRepoKey: "owner/repo",
      name: "repo",
      githubUrl: "https://github.com/owner/repo",
      isActive: true,
      settings: {
        issueAssistantEnabled: true,
        autoFormatIssue: true,
        autoAnswerQuestions: true,
        tagMaintainersForCodeChanges: true,
        discussionAssistantEnabled: true,
        autoFormatDiscussion: true,
        autoAnswerDiscussionQuestions: true,
        tagMaintainersForDiscussionCodeChanges: true,
        requireApproval: false,
        requireApprovalForDiscussions: false,
      },
      monthlyActions: 0,
      lastResetAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const ticketId = await ctx.db.insert("tickets", {
      repositoryId,
      userId,
      githubRepo: "owner/repo",
      ticketType: "issue",
      githubNumber: 42,
      githubTitle: "Issue",
      aiInputVersion: 1,
      status: "open",
      createdAt: now,
    });
    const ticketActionId = await ctx.db.insert("ticketActions", {
      ticketId,
      actionType: "answer",
      chatHistory: [],
      proposalVersion: 0,
      status: "pending",
      createdAt: now,
    });
    return {
      userId,
      repositoryId,
      ticketActionId,
      requirePendingTicketAction: true,
    };
  });
}

async function enableRepositoryAccess(
  t: ReturnType<typeof convexTest>,
  f: Awaited<ReturnType<typeof insertFixture>>,
) {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("userProfiles", {
      userId: f.userId,
      githubUsername: "owner",
      minimumAgeAttestedAt: now,
      professionalUseAttestedAt: now,
      termsAcceptedVersion: CURRENT_TERMS_VERSION,
      privacyPolicyAcceptedVersion: CURRENT_PRIVACY_POLICY_VERSION,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("githubInstallations", {
      userId: f.userId,
      installationId: 101,
      ownerGithubAccountId: "5001",
      ownershipVerifiedAt: now,
      accountLogin: "owner",
      accountType: "Organization",
      targetType: "Organization",
      createdAt: now,
      updatedAt: now,
    });
  });
}

describe("OpenAI repository retrieval pipeline", () => {
  it.each([
    { paths: ["src/auth.ts"], source: content },
    { paths: ["src/auth.ts", "src/copy.ts"], source: content },
    {
      paths: ["src/auth.ts"],
      source:
        "export function one() { return 1; }\nexport function two() { return 2; }",
    },
  ])(
    "reuses unchanged file vectors after batch cache eviction (%s)",
    async ({ paths, source }) => {
      filePaths = paths;
      fixtureContent = source;
      const t = convexTest(schema, modules);
      const f = await insertFixture(t);
      await enableRepositoryAccess(t, f);
      await t.run((ctx) =>
        ctx.db.patch(f.repositoryId, { ragStatus: "pending" }),
      );
      const fetch = mockNetwork();
      await t.action(internal.ragV2.action.generateChunkEmbeddings, {
        repositoryId: f.repositoryId,
      });
      await drainScheduledFunctions(t);
      const first = await t.run(async (ctx) => ({
        repo: await ctx.db.get(f.repositoryId),
        chunks: await ctx.db
          .query("repoChunks")
          .withIndex("by_index_version", (q) =>
            q.eq("repositoryId", f.repositoryId).eq("indexVersion", 1),
          )
          .take(5),
        usage: await ctx.db
          .query("tokenUsage")
          .withIndex("by_user", (q) => q.eq("userId", f.userId))
          .take(5),
      }));
      expect(first.repo).toMatchObject({
        ragStatus: "completed",
        ragEmbeddingMode: "openai",
        ragEmbeddingKey: CODE_EMBEDDING_KEY,
      });
      expect(first.chunks.length).toBeGreaterThan(0);
      expect(first.chunks[0].embeddingKey).toBe(CODE_EMBEDDING_KEY);
      expect(first.usage).toHaveLength(filePaths.length);
      expect(first.usage[0]).toMatchObject({
        provider: "openai",
        model: EMBEDDING_MODEL,
        embeddingTokens: 2,
      });
      await t.run(async (ctx) => {
        for (const batch of await ctx.db
          .query("ragEmbeddingBatches")
          .withIndex("by_repository", (q) =>
            q.eq("repositoryId", f.repositoryId),
          )
          .take(20))
          await ctx.db.delete(batch._id);
        await ctx.db.patch(f.repositoryId, {
          indexVersion: 2,
          ragStatus: "pending",
          indexStatus: "completed",
        });
      });
      await t.action(internal.ragV2.action.generateChunkEmbeddings, {
        repositoryId: f.repositoryId,
      });
      await drainScheduledFunctions(t);
      expect(
        fetch.mock.calls.filter((c) => String(c[0]).includes("api.openai.com")),
      ).toHaveLength(filePaths.length);
      expect(
        fetch.mock.calls.some(
          (c) =>
            String(c[0]).includes("googleapis") ||
            String(c[0]).includes("licenses.opensource"),
        ),
      ).toBe(false);
    },
  );
  it("embeds queries with OpenAI and excludes incompatible Google vectors", async () => {
    const t = convexTest(schema, modules);
    const f = await insertFixture(t);
    await enableRepositoryAccess(t, f);
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.patch(f.repositoryId, {
        ragEmbeddingMode: "openai",
        ragEmbeddingKey: CODE_EMBEDDING_KEY,
        ragEmbeddingBillingTier: "paid",
      });
      for (const [id, key] of [
        ["new-openai", CODE_EMBEDDING_KEY],
        ["old-google", "google:gemini-embedding-2:1536:code_retrieval"],
      ])
        await ctx.db.insert("repoChunks", {
          repositoryId: f.repositoryId,
          repositoryIndexKey: `${f.repositoryId}:1`,
          chunkId: id,
          path: `src/${id}.ts`,
          language: "typescript",
          code: "export const unrelated = 1;",
          searchableText: "unrelated",
          startLine: 1,
          endLine: 1,
          symbols: [],
          embedding: vector(),
          embeddingKey: key,
          embeddingScopeKey: `${f.repositoryId}:1:${key}`,
          embeddingLanguageScopeKey: `${f.repositoryId}:1:${key}:typescript`,
          contentHash: id,
          indexVersion: 1,
          createdAt: now,
          updatedAt: now,
        });
    });
    const fetch = mockNetwork();
    const result = await t.action(internal.ragV2.action.hybridSearch, {
      repositoryId: f.repositoryId,
      query: "semantic authentication",
      indexVersion: 1,
    });
    expect(result.map((x) => x.chunkId)).toEqual(["new-openai"]);
    expect(
      fetch.mock.calls.filter((c) => String(c[0]).includes("api.openai.com")),
    ).toHaveLength(1);
  });
});

describe("OpenAI repository learning retrieval", () => {
  it("publishes and searches learning vectors using the OpenAI model identity", async () => {
    const t = convexTest(schema, modules);
    const f = await insertFixture(t);
    await enableRepositoryAccess(t, f);
    const fetch = mockNetwork();
    const id = await t.action(internal.repoLearnings.action.createLearning, {
      repositoryId: f.repositoryId,
      content: "Keep stable identifiers for authentication retries",
      source: "owner correction",
      sourceType: "correction",
      isTrusted: true,
      requestedByUserId: f.userId,
    });
    const learning = await t.run((ctx) => ctx.db.get(id));
    expect(learning?.embedding).toHaveLength(1536);
    expect(learning?.embeddingKey).toContain(
      "openai:text-embedding-3-small:1536",
    );
    const results = await t.action(
      internal.repoLearnings.action.searchLearnings,
      {
        repositoryId: f.repositoryId,
        query: "semantic sign in recovery",
        requestedByUserId: f.userId,
      },
    );
    expect(results.map((x) => x._id)).toContain(id);
    expect(
      fetch.mock.calls.filter((c) => String(c[0]).includes("api.openai.com")),
    ).toHaveLength(2);
  });
});
