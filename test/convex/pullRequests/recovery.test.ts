import { reviewState } from "./contextFixture";
import { describe, expect, it, vi } from "vitest";
import type {
  AiProvider,
  ChatCompletionResult,
  ChatMessage,
  ChatCompletionOptions,
} from "../../../convex/_ai/model";
import { reviewWithContext } from "../../../convex/pullRequests/workflow";
import { getChatReservationLimits } from "../../../convex/_ai/chatBilling";
import {
  type ChangedFile,
  type Finding,
} from "../../../convex/pullRequests/review";

const file: ChangedFile = {
  filename: "src/service.ts",
  status: "modified",
  additions: 1,
  deletions: 1,
  patch:
    "@@ -1,3 +1,3 @@\n function find(key) {\n- return cache.get(key);\n+ return cache.get('constant');\n }",
};
const source = "function find(key) {\n return cache.get('constant');\n}";
const largeSource =
  source + "\n" + "// surrounding implementation\n".repeat(600);
const finding: Finding = {
  path: file.filename,
  line: 2,
  priority: "P2",
  confidence: 0.95,
  title: "Preserve the requested cache key",
  body: "When callers request different keys, the constant lookup returns the same entry for both, so unrelated data is returned. Preserve the requested key.",
  evidence: [
    {
      path: file.filename,
      ref: "head",
      quote: "return cache.get('constant');",
    },
  ],
};
const stop = (findings: Finding[] = []): ChatCompletionResult => ({
  content: JSON.stringify({ findings }),
  finishReason: "stop",
});
const verified = (retainedFindingIds = ["F1"]) => ({
  content: JSON.stringify({ retainedFindingIds }),
  finishReason: "stop" as const,
});
const tool = (
  name: string,
  input: Record<string, unknown>,
): ChatCompletionResult => ({
  content: "",
  finishReason: "tool_use",
  toolUse: [{ id: "request", name, input }],
});
function fixture(
  responses: ChatCompletionResult[],
  overrides: Partial<Parameters<typeof reviewWithContext>[0]> = {},
) {
  const requests: ChatMessage[][] = [];
  const requestOptions: ChatCompletionOptions[] = [];
  const provider: AiProvider = {
    name: "fixture",
    providerId: "anthropic",
    modelId: "fixture",
    chat: vi.fn(async (messages, options) => {
      requests.push(structuredClone(messages));
      requestOptions.push(structuredClone(options ?? {}));
      const response = responses.shift();
      if (!response) throw new Error("Unexpected extra model call");
      return response;
    }),
  };
  const read = vi.fn(overrides.read ?? (async () => source));
  const promise = reviewWithContext({
    provider,
    repository: "owner/repo",
    title: "Refactor cache",
    body: "",
    files: [file],
    paths: [file.filename],
    basePaths: [file.filename],
    guard: async () => {},
    ...overrides,
    read,
  });
  return { promise, requests, requestOptions, provider, read };
}
const state = reviewState;

describe("bounded importing container preparation", () => {
  const files = [
    file,
    ...["src/b.ts", "src/c.ts"].map((filename) => ({ ...file, filename })),
  ];
  const caller = "src/App.tsx";
  const callerSource =
    'const Page = lazy(() => import("./service"));\nexport const boundaryKey = location.key;';
  const paths = [...files.map((f) => f.filename), caller];

  it("includes a complete importing container for a modest change", async () => {
    const { promise, requests, read } = fixture([stop()], {
      files,
      paths,
      read: async (path) => (path === caller ? callerSource : source),
    });
    const result = await promise;
    expect(state(requests[0]).headImplementationContext).toContainEqual({
      path: caller,
      ref: "head",
      content: callerSource,
    });
    expect(result.reads).toContainEqual({
      path: caller,
      ref: "head",
      content: callerSource,
    });
    expect(read.mock.calls.filter(([path]) => path === caller)).toHaveLength(1);
    expect(result.excludedPaths).toEqual([]);
  });

  it("does not fetch containers for tiny changes or from unrelated directories", async () => {
    const tiny = fixture([stop()], { paths: [file.filename, caller] });
    await tiny.promise;
    expect(tiny.read.mock.calls.map(([path]) => path)).not.toContain(caller);
    const unrelated = fixture([stop()], {
      files,
      paths: [...paths.filter((path) => path !== caller), "other/App.tsx"],
    });
    await unrelated.promise;
    expect(unrelated.read.mock.calls.map(([path]) => path)).not.toContain(
      "other/App.tsx",
    );
  });

  it("fetches at most two container candidates, nearest directory first", async () => {
    const nestedFiles = files.map((f) => ({
      ...f,
      filename: f.filename.replace("src/", "src/pages/"),
    }));
    const candidates = [caller, "src/pages/router.tsx", "src/pages/App.tsx"];
    const { promise, read, requests } = fixture([stop()], {
      files: nestedFiles,
      paths: [...nestedFiles.map((f) => f.filename), ...candidates],
      read: async (path) =>
        candidates.includes(path) ? 'import "./service";' : source,
    });
    await promise;
    expect(
      read.mock.calls
        .map(([path]) => path)
        .filter((path) => candidates.includes(path)),
    ).toEqual(["src/pages/App.tsx", "src/pages/router.tsx"]);
    expect(
      state(requests[0]).headImplementationContext.map(
        (r: { path: string }) => r.path,
      ),
    ).not.toContain(caller);
  });

  it.each(["unrelated", "oversized"])(
    "does not authorize evidence from a fetched but unshown %s container",
    async (kind) => {
      const hidden =
        kind === "oversized"
          ? callerSource + "x".repeat(8000)
          : "export const hiddenContract = true;";
      const candidate = {
        ...finding,
        evidence: [
          ...finding.evidence,
          { path: caller, ref: "head" as const, quote: hidden.slice(0, 70) },
        ],
      };
      const { promise, requests } = fixture(
        [stop([candidate]), stop([candidate])],
        {
          files,
          paths,
          read: async (path) => (path === caller ? hidden : source),
        },
      );
      await expect(promise).rejects.toThrow(
        "not present in commit-pinned reads",
      );
      expect(
        state(requests[0]).inspectedSource.some(
          (r: { path: string }) => r.path === caller,
        ),
      ).toBe(false);
    },
  );

  it("anchors repeated source lines to absolute added lines only", async () => {
    const content =
      "const unchanged = true;\nrepeat();\nconst gap = true;\nrepeat();";
    const changed = {
      ...file,
      additions: 2,
      deletions: 0,
      patch:
        "@@ -1,2 +1,4 @@\n const unchanged = true;\n+repeat();\n const gap = true;\n+repeat();",
    };
    const { promise, requests } = fixture([stop()], {
      files: [changed],
      read: async () => content,
    });
    await promise;
    expect(state(requests[0]).changedFiles[0].addedLineAnchors).toEqual([
      { line: 2, text: "repeat();" },
      { line: 4, text: "repeat();" },
    ]);
  });
});

describe("verification selects immutable grounded candidates", () => {
  const secondFile = { ...file, filename: "src/other.ts" };
  const second = {
    ...finding,
    path: secondFile.filename,
    evidence: [{ ...finding.evidence[0], path: secondFile.filename }],
  };
  const context = {
    files: [file, secondFile],
    paths: [file.filename, secondFile.filename],
  };

  it("selects a strict subset without generating replacement text or suggestions", async () => {
    const { promise, requests, requestOptions } = fixture(
      [stop([finding, second]), verified(["F2"])],
      context,
    );
    expect((await promise).findings).toEqual([second]);
    expect(state(requests[1]).candidates).toEqual([
      { id: "F1", finding },
      { id: "F2", finding: second },
    ]);
    expect(requestOptions[1].responseFormat).toMatchObject({
      name: "pull_request_verification",
      schema: {
        properties: {
          retainedFindingIds: {
            items: { type: "string", enum: ["F1", "F2"] },
          },
        },
        additionalProperties: false,
      },
    });
    // Claude's output schema does not support array length constraints;
    // cardinality is enforced by the deterministic selection validator.
    expect(requestOptions[1].responseFormat).not.toHaveProperty(
      "schema.properties.retainedFindingIds.maxItems",
    );
    expect(requestOptions[1].tools).toBeUndefined();
  });

  it("preserves original order and fields regardless of selection order", async () => {
    const { promise } = fixture(
      [stop([finding, second]), verified(["F2", "F1"])],
      context,
    );
    expect((await promise).findings).toEqual([finding, second]);
  });

  it.each([
    null,
    {},
    { retainedFindingIds: ["F9"] },
    { retainedFindingIds: ["F1", "F1"] },
    { retainedFindingIds: [0] },
    { retainedFindingIds: "F1" },
    { retainedFindingIds: [null] },
    { retainedFindingIds: ["F1"], findings: [finding] },
    { findings: [{ ...finding, title: "A rewritten candidate" }] },
  ])("fails closed on invalid verification selection %j", async (selection) => {
    const { promise, provider } = fixture([
      stop([finding]),
      { content: JSON.stringify(selection), finishReason: "stop" },
    ]);
    await expect(promise).rejects.toThrow(
      "Verification introduced an unreviewed finding",
    );
    expect(provider.chat).toHaveBeenCalledTimes(2);
  });

  it("does not repair verification prose into newly generated findings", async () => {
    const { promise, provider } = fixture([
      stop([finding]),
      { content: "Keep the candidate", finishReason: "stop" },
    ]);
    await expect(promise).rejects.toThrow("required JSON format");
    expect(provider.chat).toHaveBeenCalledTimes(2);
  });

  it("rejects a truncated verification even when its JSON is valid", async () => {
    const { promise } = fixture([
      stop([finding]),
      { ...verified(), finishReason: "length" },
    ]);
    await expect(promise).rejects.toThrow("Review verification did not finish");
  });
});

describe("uncertain review candidates", () => {
  const uncertain = { ...finding, confidence: 0.6 };

  it("discards a weak candidate and validates and critiques the remaining finding", async () => {
    const { promise, requests, provider } = fixture([
      stop([uncertain, finding]),
      verified(),
    ]);
    expect((await promise).findings).toEqual([finding]);
    expect(state(requests[1]).candidates).toEqual([{ id: "F1", finding }]);
    expect(provider.chat).toHaveBeenCalledTimes(2);
  });

  it("returns no finding when every inspected candidate is uncertain", async () => {
    const { promise, provider } = fixture([stop([uncertain])]);
    expect((await promise).findings).toEqual([]);
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it("still requires changed head inspection after discarding uncertain candidates", async () => {
    const { promise, requests, provider } = fixture(
      [stop([uncertain]), stop()],
      { read: async () => largeSource },
    );
    const result = await promise;
    expect(provider.chat).toHaveBeenCalledTimes(2);
    expect(state(requests[0]).inspectedSource).toEqual([]);
    expect(state(requests[1]).inspectedSource[0].content).toBe(largeSource);
    expect(result.findings).toEqual([]);
    await expect(
      fixture([stop([uncertain])], {
        read: async () => "x".repeat(100_001),
      }).promise,
    ).rejects.toThrow("Reviewer did not inspect the changed implementation");
  });

  it("cannot hide fabricated evidence in a retained candidate", async () => {
    const { promise } = fixture([
      stop([
        uncertain,
        {
          ...finding,
          evidence: [
            { ...finding.evidence[0], quote: "invented source quote" },
          ],
        },
      ]),
    ]);
    await expect(promise).rejects.toThrow(
      "Finding evidence was not present in commit-pinned reads",
    );
  });

  it.each([-1, 1.01, NaN])(
    "rejects invalid confidence %s",
    async (confidence) => {
      const { promise } = fixture([stop([{ ...finding, confidence }])]);
      await expect(promise).rejects.toThrow(
        "Invalid or low-confidence review finding",
      );
    },
  );

  it("does not use uncertainty to bypass the candidate count bound", async () => {
    const { promise } = fixture([
      stop(Array.from({ length: 9 }, () => uncertain)),
    ]);
    await expect(promise).rejects.toThrow("Invalid review result");
  });

  const suggestion = {
    startLine: 2,
    original: " return cache.get('constant');",
    replacement: " return cache.get(key);",
  };

  it.each([0.9, 0.92, 0.94])(
    "keeps a finding at confidence %s but discards its suggestion",
    async (confidence) => {
      const supported = { ...finding, confidence };
      const { promise, requests } = fixture([
        stop([{ ...supported, suggestion }]),
        verified(),
      ]);
      expect((await promise).findings).toEqual([supported]);
      expect(state(requests[1]).candidates).toEqual([
        { id: "F1", finding: supported },
      ]);
    },
  );

  it("discards a finding just below the finding confidence with its suggestion", async () => {
    const { promise, provider } = fixture([
      stop([{ ...finding, confidence: 0.89, suggestion }]),
    ]);
    expect((await promise).findings).toEqual([]);
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it("discards an uncertain suggestion without validating its shape", async () => {
    const supported = { ...finding, confidence: 0.92 };
    const { promise } = fixture([
      stop([{ ...supported, suggestion: { startLine: 99 } } as never]),
      verified(),
    ]);
    expect((await promise).findings).toEqual([supported]);
  });

  it("still rejects a malformed suggestion at the suggestion confidence", async () => {
    const { promise } = fixture([
      stop([{ ...finding, suggestion: { startLine: 99 } } as never]),
    ]);
    await expect(promise).rejects.toThrow(
      "Unsafe suggestion range or replacement",
    );
  });

  it.each([true, false])(
    "does not repair an invalid confidence when suggestions are allowed: %s",
    async (allowSuggestions) => {
      const { promise } = fixture(
        [stop([{ ...finding, confidence: 1.01, suggestion }])],
        { allowSuggestions },
      );
      await expect(promise).rejects.toThrow(
        "Invalid or low-confidence review finding",
      );
    },
  );

  it("keeps a valid suggestion at the suggestion confidence", async () => {
    const { promise } = fixture([
      stop([{ ...finding, suggestion }]),
      verified(),
    ]);
    expect((await promise).findings).toEqual([{ ...finding, suggestion }]);
  });

  it("keeps a finding but discards a suggestion the repository disabled", async () => {
    const confident = { ...finding, confidence: 0.96 };
    const { promise, requests } = fixture(
      [stop([{ ...confident, suggestion }]), verified()],
      { allowSuggestions: false },
    );
    expect((await promise).findings).toEqual([confident]);
    expect(requests[0][0].content).toContain("Commit suggestions are disabled");
  });

  it("discards a disabled suggestion returned by the format correction", async () => {
    const confident = { ...finding, confidence: 0.96 };
    const { promise, requests, requestOptions } = fixture(
      [
        { content: "The lookup ignores its key.", finishReason: "stop" },
        stop([{ ...confident, suggestion }]),
        verified(),
      ],
      { allowSuggestions: false },
    );
    expect((await promise).findings).toEqual([confident]);
    expect(requestOptions[1].billingLabel).toBe("pr-review/format");
    expect(requests[1][0].content).toContain("Commit suggestions are disabled");
  });

  it("discards a disabled suggestion returned by the final synthesis", async () => {
    const confident = { ...finding, confidence: 0.96 };
    const { promise, requests, requestOptions } = fixture(
      [
        ...Array.from({ length: 8 }, () =>
          tool("read_file", { path: file.filename, ref: "head" }),
        ),
        stop([{ ...confident, suggestion }]),
        verified(),
      ],
      { allowSuggestions: false },
    );
    expect((await promise).findings).toEqual([confident]);
    expect(requestOptions[8].billingLabel).toBe("pr-review/final");
    expect(requests[8][0].content).toContain("Commit suggestions are disabled");
  });

  it("still rejects a confident suggestion that does not match the source", async () => {
    const { promise } = fixture([
      stop([
        {
          ...finding,
          confidence: 0.96,
          suggestion: { ...suggestion, original: " return cache.get(key);" },
        },
      ]),
    ]);
    await expect(promise).rejects.toThrow(
      "Suggestion original must match the reviewed commit exactly",
    );
  });
});

describe("review recovery without weakening source evidence", () => {
  it("recovers a nonexistent path without fetching it or recording it as evidence", async () => {
    const { promise, read, requests } = fixture([
      tool("read_file", { path: "src/old/service.ts", ref: "head" }),
      tool("read_file", { path: file.filename, ref: "head" }),
      stop([finding]),
      verified(),
    ]);
    const result = await promise;
    expect(result.findings).toEqual([finding]);
    expect(read.mock.calls.map(([path]) => path)).toEqual([file.filename]);
    expect(state(requests[1]).recentToolResults[0]).toMatchObject({
      missing: true,
      suggestedPaths: [file.filename],
    });
    expect(result.reads.map((r) => r.path)).toEqual([file.filename]);
    expect(result.excludedPaths).not.toContain("src/old/service.ts");
  });

  it("continues mixed search requests after a guessed path and suggests a real filename", async () => {
    const contract = "src/contracts/policy.ts";
    const { promise, requests, read } = fixture(
      [
        tool("search_code", {
          pattern: "cache",
          paths: ["src/lib/policy.ts", file.filename],
          ref: "head",
        }),
        stop([finding]),
        verified(),
      ],
      { paths: [file.filename, contract] },
    );
    const result = await promise;
    expect(result.findings).toEqual([finding]);
    expect(state(requests[1]).recentToolResults[0]).toMatchObject({
      matchedPaths: [file.filename],
      missingPaths: ["src/lib/policy.ts"],
      suggestedPaths: [contract],
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.reads.some((r) => r.path === contract)).toBe(false);
  });

  it.each([401, 403, 404, 429])(
    "does not suppress HTTP %s for a path present in the pinned tree",
    async (status) => {
      const { promise, provider } = fixture([stop()], {
        read: async () => {
          throw new Error(`Read review context failed (HTTP ${status})`);
        },
      });
      await expect(promise).rejects.toThrow(`HTTP ${status}`);
      expect(provider.chat).not.toHaveBeenCalled();
    },
  );

  it("requires an explicit model-visible head read before repairing an unread target", async () => {
    const { promise, requests, read } = fixture(
      [
        stop([finding]),
        tool("read_file", { path: file.filename, ref: "head" }),
        stop([finding]),
        verified(),
      ],
      { read: async () => largeSource },
    );
    const result = await promise;
    expect(result.findings).toEqual([finding]);
    expect(state(requests[0]).headImplementationContext).toEqual([]);
    expect(
      state(requests[0]).changedFiles.every(
        (f: { addedLineAnchors: unknown[] }) => f.addedLineAnchors.length === 0,
      ),
    ).toBe(true);
    expect(state(requests[0]).changedFiles[0].addedLineAnchors).toEqual([]);
    expect(state(requests[1]).validationFeedback.requiredRead).toEqual({
      path: file.filename,
      ref: "head",
    });
    expect(state(requests[1]).inspectedSource).toEqual([]);
    expect(state(requests[2]).inspectedSource[0].content).toContain(
      "return cache.get('constant');",
    );
    expect(state(requests[2]).changedFiles[0].addedLineAnchors).toEqual([
      { line: 2, text: " return cache.get('constant');" },
    ]);
    expect(result.reads[0].content).toBe(largeSource);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("bounds evidence repair to one feedback round", async () => {
    const { promise, provider } = fixture([stop([finding]), stop([finding])], {
      read: async () => largeSource,
    });
    await expect(promise).rejects.toThrow("target was not read");
    expect(provider.chat).toHaveBeenCalledTimes(2);
  });

  it("cannot turn an unread target into empty success during repair", async () => {
    const { promise, requests, provider } = fixture(
      [stop([finding]), stop(), stop()],
      { read: async () => largeSource },
    );
    const result = await promise;
    expect(provider.chat).toHaveBeenCalledTimes(3);
    expect(state(requests[1]).inspectedSource).toEqual([]);
    expect(state(requests[2]).inspectedSource[0].content).toBe(largeSource);
    expect(result.findings).toEqual([]);
    await expect(
      fixture([stop([finding]), stop()], {
        read: async () => "x".repeat(100_001),
      }).promise,
    ).rejects.toThrow("did not inspect the changed implementation");
  });

  it("repairs an unread base contract only after showing its full source", async () => {
    const path = "src/contract.ts";
    const contract = "export const policy = 'key-specific';";
    const candidate: Finding = {
      ...finding,
      evidence: [...finding.evidence, { path, ref: "base", quote: contract }],
    };
    const { promise, requests } = fixture(
      [
        stop([candidate]),
        tool("read_file", { path, ref: "base" }),
        stop([candidate]),
        verified(),
      ],
      {
        basePaths: [file.filename, path],
        read: async (requested) => (requested === path ? contract : source),
      },
    );
    expect((await promise).findings).toEqual([candidate]);
    expect(state(requests[1]).validationFeedback.requiredRead).toEqual({
      path,
      ref: "base",
    });
    expect(state(requests[2]).inspectedSource).toContainEqual(
      expect.objectContaining({ path, ref: "base", content: contract }),
    );
  });

  it("rejects fabricated quotes in already shown source without paying for recovery", async () => {
    const invalid = {
      ...finding,
      evidence: [
        {
          ...finding.evidence[0],
          quote: "This contract was never present in the source.",
        },
      ],
    };
    const { promise, provider } = fixture([stop([invalid])]);
    await expect(promise).rejects.toThrow("not present in commit-pinned reads");
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it("does not use known head paths to authorize an absent base read", async () => {
    const path = "src/new.ts";
    const { promise, requests, read } = fixture(
      [tool("read_file", { path, ref: "base" }), stop()],
      { paths: [file.filename, path], basePaths: [file.filename] },
    );
    await promise;
    expect(state(requests[1]).recentToolResults[0]).toMatchObject({
      missing: true,
      ref: "base",
    });
    expect(read.mock.calls.some(([requested]) => requested === path)).toBe(
      false,
    );
  });

  it("deduplicates shown source and drops old native reasoning between turns", async () => {
    const readSource = tool("read_file", { path: file.filename, ref: "head" });
    readSource.historyContent = [
      {
        type: "thinking",
        thinking: "FIXTURE_REASONING_DO_NOT_REPLAY".repeat(1000),
        signature: "fixture",
      },
    ];
    const { promise, requests } = fixture([readSource, readSource, stop()]);
    await promise;
    for (const request of requests.slice(1)) {
      expect(request.map((m) => m.role)).toEqual(["system", "user"]);
      expect(JSON.stringify(request)).not.toContain(
        "FIXTURE_REASONING_DO_NOT_REPLAY",
      );
      expect(
        state(request).inspectedSource.filter(
          (r: { path: string }) => r.path === file.filename,
        ),
      ).toHaveLength(1);
      expect(JSON.stringify(request).length).toBeLessThan(7000);
    }
  });

  it("preloads complete modest changes and resolves small relative dependencies within an aggregate bound", async () => {
    const helper = "src/shared/cache.ts";
    const files = [
      file,
      ...["src/b.ts", "src/c.ts", "src/d.ts"].map((filename) => ({
        ...file,
        filename,
      })),
    ];
    const { promise, requests } = fixture([stop()], {
      files,
      paths: [...files.map((f) => f.filename), helper],
      read: async (path) =>
        path === file.filename
          ? `import { cache } from './shared/cache';\n${source}`
          : source,
    });
    const result = await promise;
    expect(result.excludedPaths).toEqual([]);
    expect(result.reads.map((r) => r.path)).toContain(helper);
    expect(state(requests[0]).headImplementationContext).toHaveLength(5);
    expect(
      JSON.stringify(state(requests[0]).headImplementationContext).length,
    ).toBeLessThanOrEqual(60_000);
  });

  it("keeps partially preloaded modest changes within 60 KB and excludes unshown files", async () => {
    const files = [
      file,
      ...["src/b.ts", "src/c.ts", "src/d.ts"].map((filename) => ({
        ...file,
        filename,
      })),
    ];
    const { promise, requests } = fixture([stop(), stop()], {
      files,
      read: async (path) =>
        path === file.filename ? source : "// context\n".repeat(2800),
    });
    const result = await promise;
    const shown = state(requests[0]).headImplementationContext;
    expect(JSON.stringify(shown).length).toBeLessThanOrEqual(60_000);
    expect(shown.length).toBeGreaterThan(1);
    expect(shown.length).toBeLessThan(4);
    // Files left out of the preload are shown before the answer while the
    // source budget allows; any still unread are reported as excluded.
    expect(requests).toHaveLength(2);
    for (const changed of files)
      if (!result.reads.some((r) => r.path === changed.filename))
        expect(result.excludedPaths).toContain(changed.filename);
  });

  it("does not authorize evidence from an oversized dependency fetched but omitted from preload", async () => {
    const path = "src/contract.ts";
    const quote = "export const hiddenContract = true;";
    const candidate = {
      ...finding,
      evidence: [...finding.evidence, { path, ref: "head" as const, quote }],
    };
    const files = [
      file,
      ...["src/b.ts", "src/c.ts"].map((filename) => ({ ...file, filename })),
    ];
    const { promise, read } = fixture([stop([candidate]), stop([candidate])], {
      files,
      paths: [...files.map((f) => f.filename), path],
      read: async (requested) =>
        requested === path
          ? "// context\n".repeat(500) + quote
          : `import './contract';\n${source}`,
    });
    await expect(promise).rejects.toThrow("not present in commit-pinned reads");
    expect(
      read.mock.calls.filter(([requested]) => requested === path),
    ).toHaveLength(1);
  });

  it("rechecks lifecycle before a recovery model call", async () => {
    let guards = 0;
    const { promise, provider } = fixture([stop([finding])], {
      read: async () => largeSource,
      guard: async () => {
        if (++guards === 3)
          throw new Error("Review source, settings or lifecycle changed");
      },
    });
    await expect(promise).rejects.toThrow("lifecycle changed");
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it("bounds discovery history while retaining every shown source", async () => {
    const paths = [
      file.filename,
      ...Array.from(
        { length: 100 },
        (_, i) => `src/${"nested/".repeat(40)}file${i}.ts`,
      ),
    ];
    const { promise, requests } = fixture(
      [
        ...Array.from({ length: 6 }, () => tool("search_paths", { query: "" })),
        stop(),
      ],
      { paths },
    );
    await promise;
    const snapshot = state(requests.at(-1)!);
    expect(snapshot.omittedToolResultCount).toBeGreaterThan(0);
    expect(
      JSON.stringify(snapshot.recentToolResults).length,
    ).toBeLessThanOrEqual(12_000);
    expect(
      snapshot.recentToolResults.every(
        (r: { paths: string[]; truncated: boolean }) =>
          r.truncated && JSON.stringify(r.paths).length <= 6000,
      ),
    ).toBe(true);
    expect(snapshot.inspectedSource).toHaveLength(1);
    expect(snapshot.inspectedSource[0].content).toContain(
      "return cache.get('constant');",
    );
  });

  it("bounds eager preparation using actual UTF-8 and escaped request reservations", async () => {
    const files = [
      file,
      ...["src/b.ts", "src/c.ts", "src/d.ts"].map((filename) => ({
        ...file,
        filename,
      })),
    ];
    const content = `/*${"한글😀\\\t".repeat(2000)}*/`;
    const { promise, requests, requestOptions } = fixture([stop(), stop()], {
      files,
      read: async () => content,
    });
    const result = await promise;
    const limits = getChatReservationLimits(requests[0], requestOptions[0]);
    expect(
      limits.inputTokenLimit + limits.outputTokenLimit,
    ).toBeLessThanOrEqual(90_000);
    const shown = state(requests[0]).headImplementationContext;
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(4);
    for (const changed of files) {
      const inspected = result.reads.some((r) => r.path === changed.filename);
      if (shown.some((r: { path: string }) => r.path === changed.filename))
        expect(inspected).toBe(true);
      if (!inspected) expect(result.excludedPaths).toContain(changed.filename);
    }
  });

  it("leaves out source that would overflow the request on the last tool turn", async () => {
    const files = [
      file,
      ...["src/b.ts", "src/c.ts"].map((filename) => ({ ...file, filename })),
    ];
    const response: ChatCompletionResult = {
      content: "",
      finishReason: "tool_use",
      toolUse: files.map((f, i) => ({
        id: `read${i}`,
        name: "read_file",
        input: { path: f.filename, ref: "head" },
      })),
    };
    const { promise, provider, requests } = fixture(
      [
        ...Array.from({ length: 7 }, () => tool("search_paths", { query: "" })),
        response,
        stop(),
      ],
      {
        files,
        read: async () => source + "\n/*" + "\\\t".repeat(15_000) + "*/",
      },
    );
    const result = await promise;
    expect(result.reads.map((r) => r.path)).toEqual([
      file.filename,
      "src/b.ts",
    ]);
    expect(result.excludedPaths).toContain("src/c.ts");
    expect(provider.chat).toHaveBeenCalledTimes(9);
    expect(JSON.stringify(state(requests[8]).recentToolResults)).toContain(
      "The review context budget is used up",
    );
  });

  it("rechecks optional preload after later unavailable paths enlarge metadata", async () => {
    const first = { ...file, filename: "src/first.ts" };
    const files = [
      first,
      ...Array.from({ length: 7 }, (_, i) => ({
        ...file,
        filename: `${Array(9).fill("한".repeat(84)).join("/")}/f${i}.ts`,
      })),
    ];
    const { promise, requests, requestOptions } = fixture(
      [tool("read_file", { path: first.filename, ref: "head" }), stop()],
      {
        files,
        paths: files.map((f) => f.filename),
        read: async (path) => {
          if (path === first.filename) return "/*" + "\\".repeat(11_500) + "*/";
          throw new Error("Review context is unavailable, binary or too large");
        },
      },
    );
    const result = await promise;
    const limits = getChatReservationLimits(requests[0], requestOptions[0]);
    expect(
      limits.inputTokenLimit + limits.outputTokenLimit,
    ).toBeLessThanOrEqual(90_000);
    expect(state(requests[0]).headImplementationContext).toEqual([]);
    expect(state(requests[1]).inspectedSource).toHaveLength(1);
    expect(result.reads.map((r) => r.path)).toEqual([first.filename]);
    for (const f of files.slice(1))
      expect(result.excludedPaths).toContain(f.filename);
  });

  it("keeps the critique within the request budget by leaving out late source", async () => {
    const quote = "\\".repeat(1500);
    const content = source + "\n/*" + "\\".repeat(37_800) + "*/";
    const candidate = {
      ...finding,
      evidence: [
        { ...finding.evidence[0], quote: content.slice(0, 1500) },
        ...Array.from({ length: 5 }, () => ({
          path: file.filename,
          ref: "head" as const,
          quote,
        })),
      ],
    };
    const { promise, provider, requests } = fixture(
      [
        {
          content: "",
          finishReason: "tool_use",
          toolUse: ["head", "base"].map((ref) => ({
            id: ref,
            name: "read_file",
            input: { path: file.filename, ref },
          })),
        },
        stop([candidate]),
        verified(),
      ],
      { read: async () => content },
    );
    const result = await promise;
    expect(result.findings).toHaveLength(1);
    expect(result.reads.map((r) => r.ref)).toEqual(["head"]);
    expect(result.excludedPaths).not.toContain(file.filename);
    expect(provider.chat).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(requests[2]).length).toBeLessThanOrEqual(180_000);
  });
});
