import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import schema from "../../../convex/schema";
import {
  CURRENT_PRIVACY_POLICY_VERSION,
  CURRENT_TERMS_VERSION,
} from "../../../convex/users/legal";
import { drainScheduledFunctions } from "../scheduling";
import { RAG_CHUNKER_VERSION } from "../../../convex/ragV2/chunkPaths";

const modules = import.meta.glob("../../../convex/**/*.ts");
const originalFetch = globalThis.fetch;

type Backend = ReturnType<typeof convexTest>;

let storageContents: Map<string, string>;
let fetchedUrls: string[];

beforeEach(() => {
  vi.useFakeTimers();
  storageContents = new Map();
  fetchedUrls = [];
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    fetchedUrls.push(url);
    const content = storageContents.get(url);
    return content === undefined
      ? new Response("missing", { status: 404 })
      : new Response(content, { status: 200 });
  }) as unknown as typeof fetch;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function insertRepository(
  t: Backend,
  layout: "path_v1" | undefined,
  fields: Record<string, unknown> = {},
): Promise<Id<"repositories">> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("userProfiles", {
      userId,
      githubUsername: "owner",
      minimumAgeAttestedAt: now,
      professionalUseAttestedAt: now,
      termsAcceptedVersion: CURRENT_TERMS_VERSION,
      privacyPolicyAcceptedVersion: CURRENT_PRIVACY_POLICY_VERSION,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("githubInstallations", {
      userId,
      installationId: 101,
      ownerGithubAccountId: "5001",
      ownershipVerifiedAt: now,
      accountLogin: "owner",
      accountType: "Organization",
      targetType: "Organization",
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.insert("repositories", {
      userId,
      installationId: 101,
      githubRepositoryId: 1001,
      githubRepo: "owner/repo",
      githubRepoKey: "owner/repo",
      name: "repo",
      githubUrl: "https://github.com/owner/repo",
      isActive: true,
      indexVersion: 3,
      indexStatus: "completed",
      indexProgressAt: now,
      ragStatus: "pending",
      ragTotalChunks: 0,
      ragIndexedChunks: 0,
      ragFailedChunks: 0,
      ragChunkLayout: layout,
      ...(layout ? { ragChunkerVersion: RAG_CHUNKER_VERSION } : {}),
      ...fields,
      indexSyncPending: false,
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
  });
}

/** Store a file blob and map it into generation 3. */
async function insertFile(
  t: Backend,
  repositoryId: Id<"repositories">,
  path: string,
  content: string,
  ragPending: boolean,
): Promise<void> {
  const url = await t.run(async (ctx) => {
    const now = Date.now();
    const sha256 = `sha-${path}-${content.length}`;
    const storageId = await ctx.storage.store(new Blob([content]));
    await ctx.db.insert("repoFileBlobs", {
      sha256,
      storageId,
      size: content.length,
      createdAt: now,
      lastAccessedAt: now,
      accessCount: 1,
    });
    await ctx.db.insert("repoFileMap", {
      repositoryId,
      filePath: path,
      sha256,
      language: "typescript",
      size: content.length,
      isText: true,
      indexVersion: 3,
      ...(ragPending ? { ragPending: true } : {}),
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.storage.getUrl(storageId);
  });
  storageContents.set(url!, content);
}

async function insertChunk(
  t: Backend,
  repositoryId: Id<"repositories">,
  path: string,
  symbol: string,
  indexVersion: number,
): Promise<Id<"repoChunks">> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("repoChunks", {
      repositoryId,
      repositoryIndexKey: `${repositoryId}:${indexVersion}`,
      chunkId: `${path}#1#1`,
      path,
      language: "typescript",
      code: `export function ${symbol}() {}`,
      startLine: 1,
      endLine: 1,
      symbols: [symbol],
      searchableText: `${symbol} export function ${symbol}`,
      contentHash: `hash-${symbol}`,
      indexVersion,
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function search(
  t: Backend,
  repositoryId: Id<"repositories">,
  query: string,
): Promise<string[]> {
  const results = await t.query(internal.ragV2.internalQuery.keywordSearch, {
    repositoryId,
    indexVersion: 3,
    query,
    topK: 20,
  });
  return results.map((result) => result.path);
}

async function runRagPass(t: Backend, repositoryId: Id<"repositories">) {
  await t.action(internal.ragV2.action.generateChunkEmbeddings, {
    repositoryId,
  });
  await drainScheduledFunctions(t);
}

describe("incremental repository chunking", () => {
  it("re-chunks only changed paths and serves one consistent chunk set", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, "path_v1");
    await insertFile(
      t,
      repositoryId,
      "src/alpha.ts",
      "export function alphaUnchanged() { return 1; }",
      false,
    );
    await insertFile(
      t,
      repositoryId,
      "src/beta.ts",
      "export function betaRewritten() { return 2; }",
      true,
    );
    await insertFile(
      t,
      repositoryId,
      "src/gamma.ts",
      "export function gammaAdded() { return 3; }",
      true,
    );
    const alphaChunkId = await insertChunk(
      t,
      repositoryId,
      "src/alpha.ts",
      "alphaUnchanged",
      2,
    );
    await insertChunk(t, repositoryId, "src/beta.ts", "betaStale", 2);
    const alphaBefore = await t.run((ctx) => ctx.db.get(alphaChunkId));

    await runRagPass(t, repositoryId);

    const state = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      chunks: await ctx.db
        .query("repoChunks")
        .withIndex("by_repository", (q) => q.eq("repositoryId", repositoryId))
        .collect(),
      pending: await ctx.db
        .query("repoFileMap")
        .withIndex("by_repository_rag_pending_and_path", (q) =>
          q.eq("repositoryId", repositoryId).eq("ragPending", true),
        )
        .collect(),
    }));
    expect(state.repository).toMatchObject({
      ragStatus: "completed",
      ragChunkLayout: "path_v1",
    });
    expect(state.pending).toHaveLength(0);
    // The unchanged path was neither fetched nor rewritten.
    expect(
      fetchedUrls.some((url) => storageContents.get(url)?.includes("alpha")),
    ).toBe(false);
    expect(await t.run((ctx) => ctx.db.get(alphaChunkId))).toEqual(alphaBefore);
    expect(state.chunks.map((chunk) => chunk.path).sort()).toEqual([
      "src/alpha.ts",
      "src/beta.ts",
      "src/gamma.ts",
    ]);
    expect(
      state.chunks.find((chunk) => chunk.path === "src/beta.ts")?.symbols,
    ).toContain("betaRewritten");

    expect(await search(t, repositoryId, "alphaUnchanged")).toEqual([
      "src/alpha.ts",
    ]);
    expect(await search(t, repositoryId, "betaRewritten")).toEqual([
      "src/beta.ts",
    ]);
    expect(await search(t, repositoryId, "betaStale")).toEqual([]);
    expect(await search(t, repositoryId, "gammaAdded")).toEqual([
      "src/gamma.ts",
    ]);

    const byId = await t.query(internal.ragV2.internalQuery.getChunksByIds, {
      repositoryId,
      indexVersion: 3,
      chunkIds: state.chunks.map((chunk) => chunk.chunkId),
    });
    expect(byId).toHaveLength(3);
  });

  it("rebuilds every path once and sweeps older generations before the per-path layout exists", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, undefined);
    await insertFile(
      t,
      repositoryId,
      "src/alpha.ts",
      "export function alphaKept() { return 1; }",
      false,
    );
    await insertChunk(t, repositoryId, "src/alpha.ts", "alphaKept", 2);
    await insertChunk(t, repositoryId, "src/removed.ts", "removedOrphan", 2);

    await runRagPass(t, repositoryId);

    const state = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      chunks: await ctx.db
        .query("repoChunks")
        .withIndex("by_repository", (q) => q.eq("repositoryId", repositoryId))
        .collect(),
    }));
    expect(state.repository).toMatchObject({
      ragStatus: "completed",
      ragChunkLayout: "path_v1",
    });
    expect(
      state.chunks.map((chunk) => [chunk.path, chunk.indexVersion]),
    ).toEqual([["src/alpha.ts", 3]]);
    expect(await search(t, repositoryId, "removedOrphan")).toEqual([]);
    expect(await search(t, repositoryId, "alphaKept")).toEqual([
      "src/alpha.ts",
    ]);
  });

  it("does not read or rewrite chunks when nothing changed", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, "path_v1");
    await insertFile(
      t,
      repositoryId,
      "src/alpha.ts",
      "export function alphaSteady() { return 1; }",
      false,
    );
    const chunkId = await insertChunk(
      t,
      repositoryId,
      "src/alpha.ts",
      "alphaSteady",
      2,
    );
    const before = await t.run((ctx) => ctx.db.get(chunkId));

    await runRagPass(t, repositoryId);

    expect(fetchedUrls).toEqual([]);
    expect(await t.run((ctx) => ctx.db.get(chunkId))).toEqual(before);
    expect(await t.run((ctx) => ctx.db.get(repositoryId))).toMatchObject({
      ragStatus: "completed",
      ragChunkLayout: "path_v1",
    });
  });

  it("rebuilds every path when the chunker version changed or a rebuild was requested", async () => {
    for (const fields of [
      { ragChunkerVersion: RAG_CHUNKER_VERSION - 1 },
      { ragFullRebuildRequested: true },
    ]) {
      const t = convexTest(schema, modules);
      fetchedUrls = [];
      const repositoryId = await insertRepository(t, "path_v1", fields);
      await insertFile(
        t,
        repositoryId,
        "src/alpha.ts",
        "export function alphaRechunked() { return 1; }",
        false,
      );
      await insertChunk(t, repositoryId, "src/alpha.ts", "alphaOutdated", 2);

      await runRagPass(t, repositoryId);

      expect(fetchedUrls).toHaveLength(1);
      const repository = await t.run((ctx) => ctx.db.get(repositoryId));
      expect(repository).toMatchObject({
        ragStatus: "completed",
        ragChunkLayout: "path_v1",
        ragChunkerVersion: RAG_CHUNKER_VERSION,
      });
      expect(repository?.ragFullRebuildRequested).toBeUndefined();
      expect(await search(t, repositoryId, "alphaOutdated")).toEqual([]);
      expect(await search(t, repositoryId, "alphaRechunked")).toEqual([
        "src/alpha.ts",
      ]);
    }
  });

  it("fails the pass and keeps the flag when a changed path has no cached source", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, "path_v1");
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("repoFileMap", {
        repositoryId,
        filePath: "src/lost.ts",
        sha256: "sha-without-blob",
        language: "typescript",
        size: 10,
        isText: true,
        indexVersion: 3,
        ragPending: true,
        createdAt: now,
        updatedAt: now,
      });
    });
    const chunkId = await insertChunk(
      t,
      repositoryId,
      "src/lost.ts",
      "lostPrevious",
      2,
    );

    await runRagPass(t, repositoryId);

    const state = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      chunk: await ctx.db.get(chunkId),
      map: await ctx.db
        .query("repoFileMap")
        .withIndex("by_repository_and_path", (q) =>
          q.eq("repositoryId", repositoryId).eq("filePath", "src/lost.ts"),
        )
        .first(),
    }));
    expect(state.repository?.ragStatus).toBe("failed");
    expect(state.chunk).not.toBeNull();
    expect(state.map?.ragPending).toBe(true);
  });

  it("serves only the newest copy of a chunk ID", async () => {
    for (const layout of ["path_v1", undefined] as const) {
      const t = convexTest(schema, modules);
      const repositoryId = await insertRepository(t, layout);
      await t.run((ctx) =>
        ctx.db.patch(repositoryId, { ragStatus: "completed" }),
      );
      await insertChunk(t, repositoryId, "src/dup.ts", "dupSymbol", 2);
      const newestId = await insertChunk(
        t,
        repositoryId,
        "src/dup.ts",
        "dupSymbol",
        3,
      );

      const results = await t.query(
        internal.ragV2.internalQuery.keywordSearch,
        { repositoryId, indexVersion: 3, query: "dupSymbol", topK: 20 },
      );
      expect(results).toHaveLength(1);
      const byId = await t.query(internal.ragV2.internalQuery.getChunksByIds, {
        repositoryId,
        indexVersion: 3,
        chunkIds: ["src/dup.ts#1#1"],
      });
      expect(byId.map((chunk) => chunk._id)).toEqual([newestId]);
      const page = await t.query(
        internal.ragV2.internalQuery.getSearchableChunksPage,
        { repositoryId, indexVersion: 3 },
      );
      expect(page.chunks).toHaveLength(1);
    }
  });
});
