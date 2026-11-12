import { describe, expect, it, vi } from "vitest";
import type { ActionCtx } from "../../../convex/_generated/server";
import type { Id } from "../../../convex/_generated/dataModel";
import type {
  AiProvider,
  ChatCompletionResult,
} from "../../../convex/_ai/model";
import { analyzeIssueWithTools } from "../../../convex/_ai/issueAnalysis/agenticWorkflow";
import {
  executeTool,
  findAiGuideFiles,
} from "../../../convex/_ai/tools/executors";
import type { ToolInput } from "../../../convex/_ai/tools/executors";

const repositoryId = "repository-id" as Id<"repositories">;
const indexVersion = 17;

function createReadyRunQuery(
  fallback: (
    args: Record<string, unknown>,
  ) => unknown | Promise<unknown> = () => [],
) {
  return vi.fn(async (_query, args: Record<string, unknown>) => {
    if ("expectedIndexVersion" in args) {
      return {
        indexVersion:
          typeof args.expectedIndexVersion === "number"
            ? args.expectedIndexVersion
            : indexVersion,
      };
    }
    return await fallback(args);
  });
}

describe("repository snapshot pinning", () => {
  it("keeps the workflow's guide lookup and tool calls on one snapshot", async () => {
    const responses: ChatCompletionResult[] = [
      {
        content: "",
        finishReason: "tool_use",
        toolUse: [
          {
            id: "read-source",
            name: "read_file",
            input: { path: "src/index.ts" },
          },
        ],
      },
      {
        content: JSON.stringify({
          isActionable: false,
          issueType: "question",
          reasoning: "Read the implementation before answering",
          suggestedResponse:
            "`src/index.ts` contains the snapshot implementation used by this repository.",
          confidence: 0.8,
        }),
        finishReason: "stop",
      },
    ];
    const provider: AiProvider = {
      name: "Test provider",
      modelId: "test-model",
      providerId: "test-provider",
      chat: vi.fn(async () => responses.shift()!),
    };
    const runQuery = createReadyRunQuery();
    const runAction = vi.fn().mockResolvedValue([
      {
        path: "src/index.ts",
        language: "TypeScript",
        content: "export const snapshotVersion = 17;",
      },
    ]);
    const ctx = { runQuery, runAction } as unknown as ActionCtx;

    const result = await analyzeIssueWithTools(
      ctx,
      repositoryId,
      {
        title: "How is the repository snapshot handled?",
        body: "Please point me to the indexed implementation.",
      },
      provider,
      { indexVersion },
    );

    expect(result.success).toBe(true);
    expect(result.output?.filesReadPaths).toEqual(["src/index.ts"]);
    expect(
      runQuery.mock.calls
        .filter((call) => "indexVersion" in call[1])
        .every((call) => call[1].indexVersion === 17),
    ).toBe(true);
    expect(
      runQuery.mock.calls
        .filter((call) => "expectedIndexVersion" in call[1])
        .every(
          (call) =>
            call[1].expectedIndexVersion === undefined ||
            call[1].expectedIndexVersion === 17,
        ),
    ).toBe(true);
    expect(runAction).toHaveBeenCalledOnce();
    expect(runAction.mock.calls[0][1]).toMatchObject({ indexVersion });
  });

  it("pins semantic search to the requested index version", async () => {
    const runAction = vi.fn().mockResolvedValue([]);
    const runQuery = createReadyRunQuery();
    const ctx = { runAction, runQuery } as unknown as ActionCtx;

    await executeTool(
      ctx,
      repositoryId,
      { name: "hybrid_search", input: { query: "checkout flow" } },
      indexVersion,
    );

    expect(runAction).toHaveBeenCalledOnce();
    expect(runAction.mock.calls[0][1]).toMatchObject({
      repositoryId,
      indexVersion,
      query: "checkout flow",
      embeddingDataProvenance: "private_user_input",
    });
  });

  it("threads explicit public GitHub provenance through agent tool calls", async () => {
    const responses: ChatCompletionResult[] = [
      {
        content: "",
        finishReason: "tool_use",
        toolUse: [
          {
            id: "semantic-search",
            name: "hybrid_search",
            input: { query: "public checkout issue" },
          },
        ],
      },
      {
        content: JSON.stringify({
          isActionable: false,
          issueType: "question",
          reasoning: "The public issue was checked against the codebase",
          suggestedResponse:
            "The checkout implementation is documented in the repository and matches the public issue context.",
          confidence: 0.8,
        }),
        finishReason: "stop",
      },
    ];
    const provider: AiProvider = {
      name: "Test provider",
      modelId: "test-model",
      providerId: "test-provider",
      chat: vi.fn(async () => responses.shift()!),
    };
    const runQuery = createReadyRunQuery();
    const runAction = vi.fn().mockResolvedValue([]);
    const ctx = { runQuery, runAction } as unknown as ActionCtx;

    await analyzeIssueWithTools(
      ctx,
      repositoryId,
      { title: "Public issue", body: "Public issue body" },
      provider,
      {
        indexVersion,
        embeddingDataProvenance: "public_github",
      },
    );

    expect(runAction).toHaveBeenCalledOnce();
    expect(runAction.mock.calls[0][1]).toMatchObject({
      repositoryId,
      indexVersion,
      query: "public checkout issue",
      embeddingDataProvenance: "public_github",
    });
  });

  it("taints tool queries when a private response style enters the prompt", async () => {
    const responses: ChatCompletionResult[] = [
      {
        content: "",
        finishReason: "tool_use",
        toolUse: [
          {
            id: "semantic-search",
            name: "hybrid_search",
            input: { query: "styled checkout issue" },
          },
        ],
      },
      {
        content: JSON.stringify({
          isActionable: false,
          issueType: "question",
          reasoning: "The repository implementation was checked",
          suggestedResponse:
            "The checkout implementation follows the repository's documented behavior.",
          confidence: 0.8,
        }),
        finishReason: "stop",
      },
    ];
    const provider: AiProvider = {
      name: "Test provider",
      modelId: "test-model",
      providerId: "test-provider",
      chat: vi.fn(async () => responses.shift()!),
    };
    const runQuery = createReadyRunQuery();
    const runAction = vi.fn().mockResolvedValue([]);
    const ctx = { runQuery, runAction } as unknown as ActionCtx;

    await analyzeIssueWithTools(
      ctx,
      repositoryId,
      { title: "Public issue", body: "Public issue body" },
      provider,
      {
        indexVersion,
        responseStyle: "Use the private dashboard response style.",
        embeddingDataProvenance: "public_github",
      },
    );

    expect(runAction).toHaveBeenCalledOnce();
    expect(runAction.mock.calls[0][1]).toMatchObject({
      repositoryId,
      indexVersion,
      query: "styled checkout issue",
      embeddingDataProvenance: "private_user_input",
    });
  });

  it("does not fall back to the repository's live version for exact search", async () => {
    const runQuery = createReadyRunQuery(() => ({
      chunks: [],
      cursor: null,
      hasMore: false,
    }));
    const ctx = { runQuery } as unknown as ActionCtx;

    await executeTool(
      ctx,
      repositoryId,
      { name: "search_code", input: { pattern: "purchase" } },
      indexVersion,
    );

    const searchCall = runQuery.mock.calls.find(
      (call) => "indexVersion" in call[1],
    );
    expect(searchCall?.[1]).toMatchObject({
      repositoryId,
      indexVersion,
    });
  });

  it("pins file reads and directory listings to the same version", async () => {
    const runAction = vi.fn().mockResolvedValue([]);
    const runQuery = createReadyRunQuery(() => ({
      paths: ["src/index.ts"],
      cursor: null,
      hasMore: false,
    }));
    const ctx = { runAction, runQuery } as unknown as ActionCtx;

    await executeTool(
      ctx,
      repositoryId,
      { name: "read_file", input: { path: "src/index.ts" } },
      indexVersion,
    );
    await executeTool(
      ctx,
      repositoryId,
      { name: "list_directory", input: { path: "src" } },
      indexVersion,
    );

    expect(runAction.mock.calls[0][1]).toMatchObject({
      repositoryId,
      filePaths: ["src/index.ts"],
      indexVersion,
    });
    const directoryCall = runQuery.mock.calls.find(
      (call) => "indexVersion" in call[1],
    );
    expect(directoryCall?.[1]).toMatchObject({
      repositoryId,
      indexVersion,
    });
  });

  it("pages directory listings instead of treating the first page as complete", async () => {
    const pages = [
      {
        paths: ["src/early.ts"],
        cursor: "next",
        hasMore: true,
      },
      {
        paths: ["packages/late/index.ts"],
        cursor: null,
        hasMore: false,
      },
    ];
    const runQuery = createReadyRunQuery(() => pages.shift());
    const ctx = { runQuery } as unknown as ActionCtx;

    const result = await executeTool(
      ctx,
      repositoryId,
      {
        name: "list_directory",
        input: { path: "packages", recursive: true },
      },
      indexVersion,
    );

    expect(result).toContain("packages/late/index.ts");
    expect(runQuery).toHaveBeenCalledTimes(4);
  });

  it("caps directory tool output while retaining the full match count", async () => {
    const paths = Array.from(
      { length: 301 },
      (_, index) => `packages/package-${index}/index.ts`,
    );
    const runQuery = createReadyRunQuery(() => ({
      paths,
      cursor: null,
      hasMore: false,
    }));
    const ctx = { runQuery } as unknown as ActionCtx;

    const result = await executeTool(
      ctx,
      repositoryId,
      {
        name: "list_directory",
        input: { path: "packages", recursive: true },
      },
      indexVersion,
    );

    expect(result).toContain('Found 301 files in "packages"');
    expect(result).toContain("1 additional matching files omitted");
  });

  it("fails closed when a directory scan reaches its page limit", async () => {
    let pageNumber = 0;
    const runQuery = createReadyRunQuery(async () => {
      pageNumber++;
      return {
        paths: [`src/generated-${pageNumber}.ts`],
        cursor: `cursor-${pageNumber}`,
        hasMore: true,
      };
    });
    const ctx = { runQuery } as unknown as ActionCtx;

    const result = await executeTool(
      ctx,
      repositoryId,
      {
        name: "list_directory",
        input: { path: "packages", recursive: true },
      },
      indexVersion,
    );

    expect(result).toMatch(
      /^Error listing directory: scan limit reached after 64 current-version files/,
    );
    expect(runQuery).toHaveBeenCalledTimes(66);
  });

  it("pins both AI-guide discovery passes to the same version", async () => {
    const runQuery = createReadyRunQuery();
    const ctx = { runQuery } as unknown as ActionCtx;

    const result = await findAiGuideFiles(ctx, repositoryId, indexVersion);

    expect(result).toEqual({ found: false, content: "", files: [] });
    expect(runQuery).toHaveBeenCalledTimes(3);
    expect(runQuery.mock.calls[1][1]).toMatchObject({
      repositoryId,
      indexVersion,
    });
    expect(runQuery.mock.calls[2][1]).toMatchObject({
      repositoryId,
      indexVersion,
    });
  });

  it.each<{
    name: string;
    tool: ToolInput;
  }>([
    {
      name: "hybrid search",
      tool: { name: "hybrid_search", input: { query: "privateMarker" } },
    },
    {
      name: "exact search",
      tool: { name: "search_code", input: { pattern: "privateMarker" } },
    },
    {
      name: "file read",
      tool: { name: "read_file", input: { path: "src/privateMarker.ts" } },
    },
    {
      name: "directory listing",
      tool: {
        name: "list_directory",
        input: { path: "src", recursive: true },
      },
    },
  ])(
    "drops $name output when reconciliation starts in flight",
    async ({ tool }) => {
      let accessChecks = 0;
      const runQuery = vi.fn(async (_query, args: Record<string, unknown>) => {
        if ("expectedIndexVersion" in args) {
          accessChecks++;
          return accessChecks === 1 ? { indexVersion } : null;
        }
        if (tool.name === "search_code") {
          return {
            chunks: [
              {
                path: "src/privateMarker.ts",
                language: "TypeScript",
                symbols: ["privateMarker"],
                code: "export const privateMarker = true;",
                startLine: 1,
                endLine: 1,
              },
            ],
            cursor: null,
            hasMore: false,
          };
        }
        return {
          paths: ["src/privateMarker.ts"],
          cursor: null,
          hasMore: false,
        };
      });
      const runAction = vi.fn(async () =>
        tool.name === "hybrid_search"
          ? [
              {
                chunkId: "private-marker",
                path: "src/privateMarker.ts",
                startLine: 1,
                endLine: 1,
                code: "export const privateMarker = true;",
                symbols: ["privateMarker"],
                score: 1,
                language: "TypeScript",
              },
            ]
          : [
              {
                path: "src/privateMarker.ts",
                language: "TypeScript",
                content: "export const privateMarker = true;",
              },
            ],
      );
      const ctx = { runQuery, runAction } as unknown as ActionCtx;

      const result = await executeTool(ctx, repositoryId, tool, indexVersion);

      expect(result).toMatch(/^Error executing tool:/);
      expect(result).not.toContain("privateMarker");
      expect(accessChecks).toBe(2);
    },
  );

  it("does not send tool results to the next provider call after reconciliation starts", async () => {
    let accessChecks = 0;
    const runQuery = vi.fn(async (_query, args: Record<string, unknown>) => {
      if ("expectedIndexVersion" in args) {
        accessChecks++;
        return accessChecks <= 4 ? { indexVersion } : null;
      }
      return [];
    });
    const runAction = vi.fn().mockResolvedValue([
      {
        path: "src/privateMarker.ts",
        language: "TypeScript",
        content: "export const privateMarker = true;",
      },
    ]);
    const provider: AiProvider = {
      name: "Test provider",
      modelId: "test-model",
      providerId: "test-provider",
      chat: vi.fn(async () => ({
        content: "",
        finishReason: "tool_use",
        toolUse: [
          {
            id: "read-private-marker",
            name: "read_file",
            input: { path: "src/privateMarker.ts" },
          },
        ],
      })),
    };
    const ctx = { runQuery, runAction } as unknown as ActionCtx;

    await expect(
      analyzeIssueWithTools(
        ctx,
        repositoryId,
        { title: "Read private marker", body: "Inspect the implementation." },
        provider,
        { indexVersion },
      ),
    ).rejects.toThrow("Repository access or indexed version changed");
    expect(provider.chat).toHaveBeenCalledOnce();
    expect(accessChecks).toBe(6);
  });
});
