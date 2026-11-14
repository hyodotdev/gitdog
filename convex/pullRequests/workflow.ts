import { ChatBillingError } from "../_ai/chatBilling";
import { chatRequestBytes } from "../_ai/requestSize";
import { reviewContextMessage } from "./context";
import type {
  AiProvider,
  ChatMessage,
  ChatCompletionOptions,
  ToolDefinition,
} from "../_ai/model";
import {
  ReviewResponseFormatError,
  ReviewContextLimitError,
  ReviewEvidenceError,
  reviewFailureCause,
  runReviewRequest,
} from "./errors";
import {
  REVIEW_PROMPT,
  REVIEW_RESPONSE_FORMAT,
  addedLines,
  hasReviewablePatch,
  safePath,
  validateFindings,
  type ChangedFile,
  type Finding,
  type ReadEvidence,
} from "./review";

const REVIEW_OUTPUT_TOKENS = 16_384;

const tools: ToolDefinition[] = [
  {
    name: "read_file",
    description:
      "Read the exact entire file at the immutable head or merge-base commit. Source starts at line 1; addedLineAnchors maps allowed finding lines to the shown head text.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        ref: { type: "string", enum: ["head", "base"] },
      },
      required: ["path", "ref"],
    },
  },
  {
    name: "search_code",
    description:
      "Search an exact identifier in up to six chosen repository files at head or base. Returns exact full source for matching files; choose paths using search_paths first.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        paths: { type: "array", items: { type: "string" }, maxItems: 6 },
        ref: { type: "string", enum: ["head", "base"] },
      },
      required: ["pattern", "paths", "ref"],
    },
  },
  {
    name: "search_paths",
    description:
      "Find source, tests, callers or documentation paths in this repository. Use an empty query to list paths. This searches filenames, not source contents.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
];

const descriptionTool: ToolDefinition = {
  name: "read_pr_description",
  description:
    "Read up to 8,000 characters of the PR description when its initial excerpt omits relevant requirements.",
  input_schema: { type: "object", properties: {}, required: [] },
};

function confidentCandidates(
  value: unknown,
  allowSuggestions?: boolean,
  groupPaths?: Set<string>,
): unknown {
  if (
    value === null ||
    typeof value !== "object" ||
    !("findings" in value) ||
    !Array.isArray(value.findings) ||
    value.findings.length > 8
  )
    return value;
  return {
    ...value,
    // Discard uncertain candidates, and suggestions that are uncertain or
    // disabled for the repository, without repairing their confidence or
    // relaxing any source, quote, anchor or suggestion validation. An optional
    // suggestion alone must not fail the whole review.
    findings: value.findings
      .filter((item: unknown) => !((confidenceOf(item) ?? 1) < 0.9))
      // A batched group reports only its own files; another group reviews
      // the rest, so a finding elsewhere is dropped instead of failing all.
      .filter(
        (item: unknown) =>
          !groupPaths ||
          item === null ||
          typeof item !== "object" ||
          !("path" in item) ||
          typeof item.path !== "string" ||
          groupPaths.has(item.path),
      )
      .map((item: unknown) =>
        (allowSuggestions === false || (confidenceOf(item) ?? 1) < 0.95) &&
        item !== null &&
        typeof item === "object" &&
        "suggestion" in item &&
        item.suggestion !== null &&
        item.suggestion !== undefined
          ? { ...item, suggestion: null }
          : item,
      ),
  };
}

// Invalid confidence is left for validation to reject.
function confidenceOf(item: unknown): number | undefined {
  return item !== null &&
    typeof item === "object" &&
    "confidence" in item &&
    typeof item.confidence === "number" &&
    Number.isFinite(item.confidence) &&
    item.confidence >= 0
    ? item.confidence
    : undefined;
}

function relativeSourcePaths(path: string, source: string, known: Set<string>) {
  const result = new Set<string>();
  const imports = source.matchAll(
    /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["'](\.[^"']+)["']/g,
  );
  for (const match of imports) {
    const parts = path.split("/").slice(0, -1);
    let escaped = false;
    for (const part of match[1].split("/")) {
      if (part === ".") continue;
      if (part === "..") {
        if (parts.length === 0) escaped = true;
        parts.pop();
      } else parts.push(part);
    }
    const stem = parts.join("/");
    if (
      escaped ||
      !safePath(stem) ||
      /\/(?:_generated|\.claude|\.codex)\//.test(`/${stem}`)
    )
      continue;
    const candidates = [
      stem,
      stem.replace(/\.js$/, ".ts"),
      ...["ts", "tsx", "js", "jsx"].flatMap((extension) => [
        `${stem}.${extension}`,
        `${stem}/index.${extension}`,
      ]),
    ];
    const resolved = candidates.find(
      (candidate) => /\.[cm]?[jt]sx?$/.test(candidate) && known.has(candidate),
    );
    if (resolved) result.add(resolved);
  }
  return [...result];
}

// Up to 8 guides plus 8 preloaded files leave 8 of the 24 file reads for tools.
const PRELOAD_READS = 8;

export async function reviewWithContext(args: {
  provider: AiProvider;
  allowSuggestions?: boolean;
  // One group of a batched review: preload a bounded share of its files, and
  // report the group as uncovered instead of failing when nothing in it was
  // inspected, so the other groups can still publish.
  batchGroup?: boolean;
  repository: string;
  title: string;
  body: string;
  files: ChangedFile[];
  paths: string[];
  basePaths: string[];
  read: (path: string, ref: "head" | "base") => Promise<string>;
  guard: () => Promise<void>;
}): Promise<{
  findings: Finding[];
  reads: ReadEvidence[];
  excludedPaths: string[];
}> {
  const reads: ReadEvidence[] = [];
  const sourceCache = new Map<string, string>();
  const unavailablePaths = new Set<string>();
  const incompleteGuides = new Set<string>();
  const headPaths = new Set([
    ...args.paths,
    ...args.files.filter((f) => f.status !== "removed").map((f) => f.filename),
  ]);
  const basePaths = new Set(args.basePaths);
  const knownPaths = (ref: "head" | "base") =>
    ref === "head" ? headPaths : basePaths;
  const missingPath = (path: string, ref: "head" | "base") => {
    const filename = path.split("/").at(-1)?.toLowerCase() ?? "";
    return {
      path,
      ref,
      missing: true,
      suggestedPaths: [...knownPaths(ref)]
        .filter((p) => p.split("/").at(-1)?.toLowerCase() === filename)
        .slice(0, 8),
      warning:
        "This path is absent from the commit file inventory. Discover the actual path with search_paths before reading it. No source was inspected.",
    };
  };
  const chat = async (
    messages: ChatMessage[],
    options: ChatCompletionOptions,
  ) => {
    if (chatRequestBytes(messages, options) > 180_000)
      throw new Error("Review conversation exceeds the context budget");
    return await runReviewRequest(
      {
        operation: `Request AI review (${options.billingLabel ?? "generation"})`,
      },
      () => args.provider.chat(messages, options),
    );
  };
  let readBudget = 0;
  // A review's own changed files are bounded by its file count and the source
  // budget, so they do not use up the reads that guides and tools share.
  const groupSources = new Set(args.files.map((f) => `head:${f.filename}`));
  const groupPaths = args.batchGroup
    ? new Set(args.files.map((f) => f.filename))
    : undefined;
  let cappedReads = 0;
  const readCapReached = (path: string, ref: "head" | "base") => {
    const key = `${ref}:${path}`;
    return !sourceCache.has(key) && !groupSources.has(key) && cappedReads >= 24;
  };
  const read = async (path: string, ref: "head" | "base"): Promise<string> => {
    const key = `${ref}:${path}`;
    const cached = sourceCache.get(key);
    if (cached !== undefined) return cached;
    if (readCapReached(path, ref))
      throw new Error("Review file-read budget exhausted");
    await args.guard();
    const content = await args.read(path, ref);
    sourceCache.set(key, content);
    if (!groupSources.has(key)) cappedReads++;
    return content;
  };
  // Evidence contains exactly the source shown to the reviewer, not fetched
  // guide tails or nonmatching search candidates held in the source cache.
  const recordRead = (path: string, ref: "head" | "base", content: string) => {
    const existing = reads.find((r) => r.path === path && r.ref === ref);
    const additional = content.length - (existing?.content.length ?? 0);
    if (readBudget + additional > 100_000)
      throw new Error("Review source budget exhausted");
    readBudget += additional;
    if (existing) existing.content = content;
    else reads.push({ path, ref, content });
    if (ref === "base" && content === sourceCache.get(`base:${path}`))
      incompleteGuides.delete(path);
  };
  const readOptionalContext = async (path: string, ref: "head" | "base") => {
    try {
      return await read(path, ref);
    } catch (error) {
      const cause = reviewFailureCause(error);
      const unsupported =
        cause instanceof Error &&
        [
          "Review context is unavailable, binary or too large",
          "Review context is binary or too large",
        ].includes(cause.message);
      if (!(cause instanceof ReviewContextLimitError) && !unsupported)
        throw error;
      unavailablePaths.add(path);
      return null;
    }
  };
  const guides = new Set(["AGENTS.md"]);
  for (const file of args.files) {
    const parts = file.filename.split("/");
    for (let n = 1; n < parts.length; n++)
      guides.add(`${parts.slice(0, n).join("/")}/AGENTS.md`);
  }
  for (const path of ["CONTRIBUTING.md", "package.json", "README.md"])
    guides.add(path);
  const guidePaths = [...guides].filter((p) => args.basePaths.includes(p));
  const smallChange =
    args.files.length <= 2 &&
    args.files.reduce((sum, f) => sum + f.additions + f.deletions, 0) <= 20 &&
    JSON.stringify(args.files).length <= 4000;
  const compactChange =
    args.files.length <= 8 &&
    args.files.reduce((sum, f) => sum + f.additions + f.deletions, 0) <= 100 &&
    JSON.stringify(args.files).length <= 12_000;
  const contextLimit = compactChange ? 4000 : 12_000;
  const perGuideLimit = compactChange ? 1000 : 3000;
  const context: Array<ReadEvidence & { truncated: boolean }> = [];
  for (const path of guidePaths) incompleteGuides.add(path);
  for (const path of guidePaths.slice(0, 8)) {
    // Reserve room for the serialized path, ref and truncation metadata too.
    const entry = { path, ref: "base" as const, content: "", truncated: true };
    const available = Math.min(
      perGuideLimit,
      contextLimit - JSON.stringify([...context, entry]).length,
    );
    if (available <= 0) continue;
    const content = await readOptionalContext(path, "base");
    if (content === null) continue;
    let end = 0;
    let upper = Math.min(content.length, available);
    // Keep the longest exact prefix whose JSON escapes fit the envelope.
    while (end < upper) {
      const middle = Math.ceil((end + upper) / 2);
      if (JSON.stringify(content.slice(0, middle)).length - 2 <= available)
        end = middle;
      else upper = middle - 1;
    }
    // Avoid splitting a UTF-16 surrogate pair at the excerpt boundary.
    if (end > 0 && /[\uD800-\uDBFF]/.test(content[end - 1])) end--;
    const excerpt = content.slice(0, end);
    context.push({
      ...entry,
      content: excerpt,
      truncated: end < content.length,
    });
    recordRead(path, "base", excerpt);
  }
  const excludedPaths = args.files
    .filter((f) => !hasReviewablePatch(f))
    .map((f) => f.filename);
  const headContext: ReadEvidence[] = [];
  const preparedReads: ReadEvidence[] = [];
  const lineAnchors = (file: ChangedFile, content: string | undefined) => {
    const lines = content?.split("\n");
    return lines && file.patch
      ? [...addedLines(file.patch)]
          .filter((line) => line <= lines.length)
          .map((line) => ({ line, text: lines[line - 1] }))
      : [];
  };
  const reviewFiles = (sources: ReadEvidence[]) =>
    args.files.map((file) => ({
      ...file,
      // Hints only describe source included in this request, never an unseen
      // cache entry or a diff promoted into implementation evidence.
      addedLineAnchors: lineAnchors(
        file,
        sources.find(
          (source) => source.ref === "head" && source.path === file.filename,
        )?.content,
      ),
    }));
  // A batched group leaves source budget for the reviewer's own tool reads.
  const headContextLimit = smallChange
    ? 12_000
    : args.batchGroup && !compactChange
      ? 40_000
      : 60_000;
  let description = args.body.slice(0, compactChange ? 1200 : 8000);
  const descriptionTruncated = description.length < args.body.length;
  const reviewTools = descriptionTruncated
    ? [...tools, descriptionTool]
    : tools;
  const initialMetadata = (sources = headContext) => ({
    repository: args.repository,
    title: args.title.slice(0, 500),
    description,
    descriptionTruncated,
    uninspectedChangedPaths: args.files
      .filter(
        (f) => !sources.some((r) => r.path === f.filename && r.ref === "head"),
      )
      .map((f) => f.filename),
    incompleteGuidePaths: [...incompleteGuides].slice(0, 8),
    additionalGuideCount: Math.max(0, incompleteGuides.size - 8),
    guideContextWarning:
      "Guide excerpts and the guide path list may be incomplete. Discover other guides with search_paths. Use read_file at base for truncated or omitted guides when conventions or compatibility affect a finding. Never infer omitted content.",
    unavailableContextPaths: [...unavailablePaths],
    changedFiles: reviewFiles(sources),
    excludedPaths,
    warning:
      "Excluded paths cannot be reviewed completely. No findings is not a clean bill of health.",
  });
  // Every request that returns findings carries the repository's setting.
  const findingsPrompt =
    REVIEW_PROMPT +
    (args.allowSuggestions === false
      ? "\nCommit suggestions are disabled for this repository. Set suggestion to null."
      : "");
  const initialMessages = (sources = headContext): ChatMessage[] => [
    { role: "system", content: findingsPrompt },
    reviewContextMessage(initialMetadata(sources), [...context, ...sources]),
  ];
  // Returns whether a source read was used, so batched preloading can stop
  // before the shared file-read budget is exhausted.
  const preloadHead = async (path: string, contentLimit?: number) => {
    if (headContext.some((r) => r.path === path)) return false;
    const content = await readOptionalContext(path, "head");
    if (content === null) return false;
    if (contentLimit !== undefined && content.length > contentLimit)
      return true;
    const evidence = { path, ref: "head" as const, content };
    if (JSON.stringify([...headContext, evidence]).length > headContextLimit)
      return true;
    const prepared = [...headContext, evidence];
    // Use the same UTF-8/escaping estimate as billing before claiming source
    // inspection. Optional preparation must fit a fresh Free account's hold.
    const reserved =
      chatRequestBytes(initialMessages(prepared), {
        tools: reviewTools,
        responseFormat: REVIEW_RESPONSE_FORMAT,
      }) + REVIEW_OUTPUT_TOKENS;
    if (reserved > 90_000) return true;
    headContext.push(evidence);
    preparedReads.push(evidence);
    return true;
  };
  // Every review starts from the changed source, not only the diff, so a
  // reviewer that answers early has still seen each changed file it could.
  let preloadReads = 0;
  for (const file of args.files) {
    if (excludedPaths.includes(file.filename)) continue;
    if (!compactChange && preloadReads >= PRELOAD_READS) break;
    if (await preloadHead(file.filename)) preloadReads++;
  }
  if (compactChange) {
    if (!smallChange) {
      // A bounded importing container can establish lifecycle behavior that
      // cannot be inferred from an edited helper or local event handler.
      const changedPaths = new Set(args.files.map((file) => file.filename));
      const callers = args.paths
        .filter((path) => {
          if (
            !/(?:^|\/)(?:App|routes?|router|_?layout|_app)\.[jt]sx$/i.test(path)
          )
            return false;
          const directory = path.slice(0, path.lastIndexOf("/") + 1);
          return (
            !headContext.some((read) => read.path === path) &&
            args.files.some((file) => file.filename.startsWith(directory))
          );
        })
        .sort(
          (a, b) =>
            b.split("/").length - a.split("/").length ||
            (a < b ? -1 : a > b ? 1 : 0),
        )
        .slice(0, 2);
      for (const path of callers) {
        const content = await readOptionalContext(path, "head");
        if (
          content !== null &&
          content.length <= 8000 &&
          relativeSourcePaths(path, content, headPaths).some((dependency) =>
            changedPaths.has(dependency),
          )
        )
          await preloadHead(path, 8000);
      }
      const dependencies = new Set<string>();
      for (const file of args.files) {
        const shown = headContext.some((r) => r.path === file.filename)
          ? sourceCache.get(`head:${file.filename}`)
          : undefined;
        if (shown === undefined || shown.length > 8000) continue;
        for (const path of relativeSourcePaths(
          file.filename,
          shown,
          headPaths,
        )) {
          if (!headContext.some((r) => r.path === path)) dependencies.add(path);
        }
      }
      for (const path of [...dependencies].slice(0, 4))
        await preloadHead(path, 4000);
    }
  }
  // Later unavailable-path metadata can increase the prepared request too.
  // Commit evidence only after the final initial envelope has been bounded.
  while (
    headContext.length > 0 &&
    chatRequestBytes(initialMessages(), {
      tools: reviewTools,
      responseFormat: REVIEW_RESPONSE_FORMAT,
    }) +
      REVIEW_OUTPUT_TOKENS >
      90_000
  ) {
    headContext.pop();
    preparedReads.pop();
  }
  for (const evidence of preparedReads)
    recordRead(evidence.path, evidence.ref, evidence.content);
  // Failed reads do not count toward the preload cap, so every file of a batch
  // group has been tried here; one that cannot be read needs no model call.
  if (
    args.batchGroup &&
    args.files.every(
      (f) =>
        excludedPaths.includes(f.filename) || unavailablePaths.has(f.filename),
    )
  )
    return {
      findings: [],
      reads,
      excludedPaths: [
        ...new Set([
          ...args.files.map((f) => f.filename),
          ...unavailablePaths,
          ...incompleteGuides,
        ]),
      ],
    };
  let messages = initialMessages();
  const task: Record<string, unknown> = initialMetadata();
  const observations: Array<Record<string, unknown>> = [];
  let omittedObservations = 0;
  let evidenceCorrections = 0;
  let validationFeedback: Record<string, unknown> | undefined;
  const addObservation = (result: Record<string, unknown>) => {
    observations.push(result);
    while (JSON.stringify(observations).length > 12_000) {
      observations.shift();
      omittedObservations++;
    }
  };
  const requestBytes = () =>
    chatRequestBytes(messages, {
      tools: reviewTools,
      responseFormat: REVIEW_RESPONSE_FORMAT,
    });
  const rebuildMessages = () => {
    // Keep one copy of each shown source, without cached unseen tails,
    // duplicate tool transcripts, or provider reasoning from earlier turns.
    messages = [
      messages[0],
      reviewContextMessage(
        {
          ...task,
          description,
          descriptionTruncated: description.length < args.body.length,
          changedFiles: reviewFiles(reads),
          uninspectedChangedPaths: args.files
            .filter(
              (f) =>
                !reads.some((r) => r.ref === "head" && r.path === f.filename),
            )
            .map((f) => f.filename),
          incompleteGuidePaths: [...incompleteGuides].slice(0, 8),
          additionalGuideCount: Math.max(0, incompleteGuides.size - 8),
          unavailableContextPaths: [...unavailablePaths],
          recentToolResults: observations,
          omittedToolResultCount: omittedObservations,
          ...(validationFeedback ? { validationFeedback } : {}),
        },
        reads.map((r) => ({
          ...r,
          truncated: r.ref === "base" && incompleteGuides.has(r.path),
        })),
      ),
    ];
  };
  // Source the reviewer asks for is shown only while the request keeps room
  // for the answer; the rest is reported as unavailable instead of failing the
  // review. A changed file may use the room that optional context may not.
  const showRead = (path: string, ref: "head" | "base", content: string) => {
    const shown = reads.find((r) => r.path === path && r.ref === ref);
    if (shown?.content !== content) {
      const previous = { messages, readBudget, content: shown?.content };
      const guide = incompleteGuides.has(path);
      const fits =
        readBudget + content.length - (shown?.content.length ?? 0) <= 100_000;
      if (fits) {
        recordRead(path, ref, content);
        rebuildMessages();
      }
      const limit =
        ref === "head" && args.files.some((f) => f.filename === path)
          ? 176_000
          : 150_000;
      if (!fits || requestBytes() > limit) {
        if (fits) {
          if (shown && previous.content !== undefined)
            shown.content = previous.content;
          else reads.pop();
          readBudget = previous.readBudget;
          if (guide) incompleteGuides.add(path);
          messages = previous.messages;
        }
        if (!reads.some((r) => r.path === path && r.ref === "head"))
          unavailablePaths.add(path);
        return false;
      }
      if (ref === "head") unavailablePaths.delete(path);
    } else recordRead(path, ref, content);
    return true;
  };
  let formatCorrections = 0;
  const decode = (text: string): unknown => {
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text.trim());
    try {
      return JSON.parse(fenced ? fenced[1] : text);
    } catch {
      throw new ReviewResponseFormatError();
    }
  };
  const parse = async (content: string): Promise<unknown> => {
    try {
      return decode(content);
    } catch (error) {
      if (!(error instanceof ReviewResponseFormatError)) throw error;
      if (
        formatCorrections >= 1 ||
        !reads.some(
          (r) =>
            r.ref === "head" && args.files.some((f) => f.filename === r.path),
        )
      )
        throw error;
      formatCorrections++;
      await args.guard();
      const correctionContext = {
        previousResponse: content,
        changedFiles: reviewFiles(reads),
      };
      const corrected = await chat(
        [
          {
            role: "system",
            content: `${findingsPrompt}\nCorrect only the response format. Return a JSON object with a findings array using the recorded source evidence. Do not treat prose as proof of an empty findings array. Tools are unavailable.`,
          },
          reviewContextMessage(
            correctionContext,
            reads.map((r) => ({
              ...r,
              truncated: r.ref === "base" && incompleteGuides.has(r.path),
            })),
          ),
        ],
        {
          maxTokens: REVIEW_OUTPUT_TOKENS,
          billingLabel: "pr-review/format",
          responseFormat: REVIEW_RESPONSE_FORMAT,
        },
      );
      if (corrected.finishReason !== "stop")
        throw new ReviewResponseFormatError();
      return decode(corrected.content);
    }
  };
  const inspectedChange = () =>
    reads.some(
      (r) => r.ref === "head" && args.files.some((f) => f.filename === r.path),
    );
  const finalize = async (findings: Finding[]) => {
    if (!inspectedChange() && !(args.batchGroup && findings.length === 0))
      throw new Error("Reviewer did not inspect the changed implementation");
    const uncovered = args.files
      .filter(
        (f) => !reads.some((r) => r.path === f.filename && r.ref === "head"),
      )
      .map((f) => f.filename);
    const coverage = [
      ...new Set([
        ...excludedPaths,
        ...uncovered,
        ...unavailablePaths,
        ...incompleteGuides,
      ]),
    ];
    if (
      args.allowSuggestions === false &&
      findings.some((f) => f.suggestion !== undefined)
    )
      throw new Error("Commit suggestions are disabled");
    if (findings.length === 0)
      return { findings, reads, excludedPaths: coverage };
    await args.guard();
    // A second model pass challenges candidates; deterministic quote/line checks
    // remain mandatory. This is self-critique, not an independent review.
    const candidates = findings.map((finding, index) => ({
      id: `F${index + 1}`,
      finding,
    }));
    const critique = await chat(
      [
        {
          role: "system",
          content: `${REVIEW_PROMPT}\nThis is the verification pass. Challenge each supplied candidate against the source. Discard speculative, pre-existing or already-handled defects. Return only retainedFindingIds from the supplied candidate IDs, using the verification schema. An empty list is valid. Do not rewrite findings, change anchors or confidence, add suggestions, or introduce new findings.`,
        },
        reviewContextMessage(
          {
            candidates,
            changedFiles: args.files,
          },
          reads.map((r) => ({
            ...r,
            truncated: r.ref === "base" && incompleteGuides.has(r.path),
          })),
        ),
      ],
      {
        maxTokens: REVIEW_OUTPUT_TOKENS,
        billingLabel: "pr-review/critique",
        responseFormat: {
          name: "pull_request_verification",
          schema: {
            type: "object",
            properties: {
              retainedFindingIds: {
                type: "array",
                items: {
                  type: "string",
                  enum: candidates.map((candidate) => candidate.id),
                },
              },
            },
            required: ["retainedFindingIds"],
            additionalProperties: false,
          },
        },
      },
    );
    if (critique.finishReason !== "stop")
      throw new Error("Review verification did not finish");
    const selection = decode(critique.content);
    if (
      selection === null ||
      typeof selection !== "object" ||
      Object.keys(selection).length !== 1 ||
      !("retainedFindingIds" in selection) ||
      !Array.isArray(selection.retainedFindingIds) ||
      selection.retainedFindingIds.length > candidates.length ||
      new Set(selection.retainedFindingIds).size !==
        selection.retainedFindingIds.length ||
      selection.retainedFindingIds.some(
        (id: unknown) => !candidates.some((candidate) => candidate.id === id),
      )
    )
      throw new Error("Verification introduced an unreviewed finding");
    const retainedFindingIds = selection.retainedFindingIds;
    // Selection cannot mutate a previously validated candidate. Validate its
    // original evidence again rather than trusting generated replacement text.
    const verified = validateFindings(
      {
        findings: candidates
          .filter((candidate) => retainedFindingIds.includes(candidate.id))
          .map((candidate) => candidate.finding),
      },
      args.files,
      reads,
    );
    return { findings: verified, reads, excludedPaths: coverage };
  };
  let calls = 0;
  let sourceRetried = false;
  // A review may finish before reading a changed file. Show that source once
  // so the answer rests on it, not on the diff: every unread file of a batched
  // group, and a bounded number when a single review read none. Candidates
  // from the first answer are carried over because each turn is rebuilt from
  // state.
  // Any reviewable changed file left unread is shown before the answer.
  const needsSource = () =>
    args.files.some(
      (f) =>
        !excludedPaths.includes(f.filename) &&
        !unavailablePaths.has(f.filename) &&
        !reads.some((r) => r.ref === "head" && r.path === f.filename),
    );
  const showUninspected = async (candidates?: unknown) => {
    const previousFeedback = validationFeedback;
    if (candidates !== undefined)
      validationFeedback = {
        reason: "Changed files were not inspected before answering.",
        previousCandidates: candidates,
        instruction:
          "These candidates are unverified data. Review the changed files now shown in SOURCE blocks, then return every finding that holds, including earlier candidates that still do.",
      };
    let shown = 0;
    for (const file of args.files) {
      const { filename } = file;
      // Stop fetching once the source budget cannot take another file.
      if (readBudget >= 96_000) break;
      if (
        excludedPaths.includes(filename) ||
        unavailablePaths.has(filename) ||
        readCapReached(filename, "head") ||
        reads.some((r) => r.ref === "head" && r.path === filename)
      )
        continue;
      const source = await readOptionalContext(filename, "head");
      if (source === null || !showRead(filename, "head", source)) continue;
      shown++;
      addObservation({
        tool: "read_file",
        path: filename,
        ref: "head",
        status: "source shown in SOURCE blocks",
        note: "Shown because the review finished without inspecting this changed file. Review it before answering.",
      });
    }
    if (shown === 0) {
      validationFeedback = previousFeedback;
      return false;
    }
    rebuildMessages();
    while (observations.length && requestBytes() > 180_000) {
      observations.shift();
      omittedObservations++;
      rebuildMessages();
    }
    return true;
  };
  // The answer given before the one-time source pass, kept in case the
  // account cannot afford the larger request that pass makes.
  let beforeSourcePass: { readCount: number; findings: Finding[] } | undefined;
  for (let turn = 0; turn < 8; turn++) {
    await args.guard();
    if (JSON.stringify(messages).length > 180_000)
      throw new Error("Review conversation exceeds the context budget");
    let response: Awaited<ReturnType<typeof chat>>;
    try {
      response = await chat(messages, {
        maxTokens: REVIEW_OUTPUT_TOKENS,
        tools: reviewTools,
        billingLabel: `pr-review/${turn}`,
        responseFormat: REVIEW_RESPONSE_FORMAT,
      });
    } catch (error) {
      const cause = reviewFailureCause(error);
      if (
        !beforeSourcePass ||
        !(cause instanceof ChatBillingError) ||
        cause.reason !== "limit_reached"
      )
        throw error;
      // Finish on the earlier answer; the files the pass would have shown
      // are reported as not reviewed.
      reads.splice(beforeSourcePass.readCount);
      return await finalize(beforeSourcePass.findings);
    }
    beforeSourcePass = undefined;
    if (response.finishReason === "tool_use" && response.toolUse?.length) {
      // Calls past the budget are refused, not fatal: the review answers
      // from the source it already has.
      const allowed = response.toolUse.slice(0, Math.min(6, 24 - calls));
      if (allowed.length === 0) break;
      const refused = response.toolUse.length - allowed.length;
      if (refused > 0)
        addObservation({
          error: `${refused} tool calls were not run. Use at most 6 tool calls per turn; ${24 - calls - allowed.length} remain for this review.`,
        });
      for (const tool of allowed) {
        calls++;
        if (
          tool.name === "read_file" &&
          typeof tool.input.path === "string" &&
          safePath(tool.input.path) &&
          (tool.input.ref === "head" || tool.input.ref === "base")
        ) {
          const { path, ref } = tool.input;
          if (!knownPaths(ref).has(path)) {
            addObservation({ tool: tool.name, ...missingPath(path, ref) });
            continue;
          }
          // A read past the cap is refused, not fatal: the review finishes
          // on the source it already has.
          if (readCapReached(path, ref)) {
            addObservation({
              tool: tool.name,
              path,
              ref,
              status: "unavailable",
              warning:
                "The file-read budget is used up, so this source was not read. Do not infer its contents; finish with the source already shown.",
            });
            continue;
          }
          const source = await readOptionalContext(path, ref);
          const shown = source !== null && showRead(path, ref, source);
          addObservation({
            tool: tool.name,
            path,
            ref,
            status: shown ? "source shown in SOURCE blocks" : "unavailable",
            ...(shown
              ? {}
              : {
                  warning:
                    source === null
                      ? "This source is unsupported or exceeds the 40 KB limit. Do not infer its contents; it will be excluded."
                      : "The review context budget is used up, so this source was not shown. Do not infer its contents; finish with the source already shown.",
                }),
          });
        } else if (
          tool.name === "search_code" &&
          typeof tool.input.pattern === "string" &&
          tool.input.pattern.length >= 3 &&
          tool.input.pattern.length <= 100 &&
          Array.isArray(tool.input.paths) &&
          tool.input.paths.length <= 6 &&
          tool.input.paths.every((p) => typeof p === "string" && safePath(p)) &&
          (tool.input.ref === "head" || tool.input.ref === "base")
        ) {
          const matchedPaths: string[] = [];
          const missingPaths: string[] = [];
          const unavailable: string[] = [];
          const suggestions = new Set<string>();
          for (const path of tool.input.paths as string[]) {
            if (!knownPaths(tool.input.ref).has(path)) {
              missingPaths.push(path);
              for (const suggestion of missingPath(path, tool.input.ref)
                .suggestedPaths)
                suggestions.add(suggestion);
              continue;
            }
            const source = readCapReached(path, tool.input.ref)
              ? null
              : await readOptionalContext(path, tool.input.ref);
            if (source === null) {
              unavailable.push(path);
              continue;
            }
            if (source.includes(tool.input.pattern)) {
              if (showRead(path, tool.input.ref, source))
                matchedPaths.push(path);
              else unavailable.push(path);
            }
          }
          addObservation({
            tool: tool.name,
            pattern: tool.input.pattern,
            ref: tool.input.ref,
            matchedPaths,
            missingPaths,
            unavailablePaths: unavailable,
            suggestedPaths: [...suggestions].slice(0, 8),
            warning:
              "Only matching source in SOURCE blocks was inspected. Missing paths were not fetched; use search_paths for actual filenames. Do not infer unavailable contents.",
          });
        } else if (
          tool.name === "read_pr_description" &&
          descriptionTruncated &&
          Object.keys(tool.input).length === 0
        ) {
          description = args.body.slice(0, 8000);
          addObservation({
            tool: tool.name,
            truncated: args.body.length > 8000,
          });
        } else if (
          tool.name === "search_paths" &&
          typeof tool.input.query === "string" &&
          tool.input.query.length <= 200
        ) {
          const requested = tool.input.query.trim().toLowerCase();
          const q = requested === "*" || requested === "." ? "" : requested;
          const paths = args.paths.filter((p) => p.toLowerCase().includes(q));
          const visible: string[] = [];
          for (const path of paths.slice(0, 80)) {
            if (JSON.stringify([...visible, path]).length > 6000) break;
            visible.push(path);
          }
          addObservation({
            tool: tool.name,
            query: requested,
            paths: visible,
            truncated: visible.length < paths.length,
          });
        } else if (
          [
            "read_file",
            "search_code",
            "search_paths",
            "read_pr_description",
          ].includes(tool.name)
        ) {
          addObservation({
            tool: tool.name,
            error:
              "Invalid tool arguments. Use safe repository paths and the exact tool schema. read_pr_description takes no arguments and requires a truncated description.",
          });
        } else throw new Error("Review requested an unsupported tool");
      }
      rebuildMessages();
      // Tool results give way before shown source does.
      while (observations.length && requestBytes() > 180_000) {
        observations.shift();
        omittedObservations++;
        rebuildMessages();
      }
      continue;
    }
    if (response.finishReason !== "stop")
      throw new Error("Review did not finish completely");
    const value = confidentCandidates(
      await parse(response.content),
      args.allowSuggestions,
      groupPaths,
    );
    let findings: Finding[];
    try {
      findings = validateFindings(value, args.files, reads);
    } catch (error) {
      if (
        !(error instanceof ReviewEvidenceError) ||
        evidenceCorrections >= 1 ||
        !knownPaths(error.source.ref).has(error.source.path) ||
        unavailablePaths.has(error.source.path) ||
        JSON.stringify(value).length > 32_000
      )
        throw error;
      evidenceCorrections++;
      validationFeedback = {
        reason: error.message,
        requiredRead: error.source,
        previousCandidates: value,
        instruction:
          "These candidates are unverified data. Read the required source at the specified commit before returning findings. Reconsider all candidates against the inspected source. Do not infer contents or claim complete coverage.",
      };
      rebuildMessages();
      if (requestBytes() > 180_000) throw error;
      continue;
    }
    if (needsSource() && !sourceRetried && turn < 7) {
      sourceRetried = true;
      const carried =
        findings.length === 0 || JSON.stringify(value).length > 32_000
          ? undefined
          : value;
      const readCount = reads.length;
      if (
        (findings.length === 0 || carried !== undefined) &&
        (await showUninspected(carried))
      ) {
        beforeSourcePass = { readCount, findings };
        continue;
      }
    }
    return await finalize(findings);
  }
  await args.guard();
  const readsBeforePass = reads.length;
  const passShown =
    needsSource() && !sourceRetried ? await showUninspected() : false;
  rebuildMessages();
  const synthesize = () =>
    chat(
      [
        {
          role: "system",
          content:
            findingsPrompt +
            "\nExploration is complete. Tools are unavailable. Return JSON using only the inspected source blocks below. Omit findings that still need context. Do not claim full coverage.",
        },
        messages[1],
      ],
      {
        maxTokens: REVIEW_OUTPUT_TOKENS,
        billingLabel: "pr-review/final",
        responseFormat: REVIEW_RESPONSE_FORMAT,
      },
    );
  let final: Awaited<ReturnType<typeof chat>>;
  try {
    final = await synthesize();
  } catch (error) {
    const cause = reviewFailureCause(error);
    if (
      !passShown ||
      !(cause instanceof ChatBillingError) ||
      cause.reason !== "limit_reached"
    )
      throw error;
    // Synthesize from the source read before the pass; the files it added
    // are reported as not reviewed.
    reads.splice(readsBeforePass);
    rebuildMessages();
    final = await synthesize();
  }
  if (final.finishReason !== "stop")
    throw new Error("Review final synthesis did not complete");
  return await finalize(
    validateFindings(
      confidentCandidates(
        await parse(final.content),
        args.allowSuggestions,
        groupPaths,
      ),
      args.files,
      reads,
    ),
  );
}
