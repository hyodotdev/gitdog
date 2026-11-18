import { ChatBillingError } from "../_ai/chatBilling";
import { chatRequestBytes } from "../_ai/requestSize";
import { reviewContextMessage } from "./context";
import type {
  AiProvider,
  ChatMessage,
  ChatCompletionOptions,
  ToolDefinition,
} from "../_ai/model";
import { ChatProviderRequestError } from "../_ai/providerErrors";
import {
  ReviewResponseFormatError,
  ReviewContextLimitError,
  ReviewEvidenceError,
  isLifecycleChange,
  isReviewGroupModelFailure,
  reviewFailureCause,
  runReviewRequest,
} from "./errors";
import type { DiscussionEntry } from "./github";
import {
  MAX_REVIEW_FINDINGS,
  validOpenRequests,
  type OpenRequest,
  MIN_FINDING_CONFIDENCE,
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
      .filter(
        (item: unknown) =>
          !((confidenceOf(item) ?? 1) < MIN_FINDING_CONFIDENCE),
      )
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

// Changed files the main review never read are reviewed afterwards in fresh
// requests of their own. Each pass shows up to this much head source.
const COVERAGE_PASS_SOURCE = 90_000;
const COVERAGE_PASS_REQUEST = 150_000;
const MAX_COVERAGE_PASSES = 8;
// Convex stops an action after 10 minutes. A request may wait up to 90 seconds
// for another on the account, once for each provider route, and then run for
// up to 120. A coverage request starts only within 4 minutes of the action's
// start, so even the slowest one ends before the action is stopped.
const COVERAGE_REQUEST_CUTOFF_MS = 4 * 60_000;
// The closing synthesis reads the whole review and can take a reasoning model
// past the usual two minutes. It may run until this long after the action
// started (never less than two minutes nor more than five), which still leaves
// room for verification before Convex stops the action.
const FINAL_REQUEST_END_MS = 7 * 60_000;
// After the main review, focused second looks at the same source. Each one
// resends the main review's last request with only its closing state
// replaced, so the repository context and sources are read from the prompt
// cache and a look costs little more than its answer.
const SECOND_LOOKS = [
  {
    name: "removed-behavior",
    focus:
      "Removed behavior and cross-file contracts. For every line the diff deletes or replaces, name the guard, invariant, validation or error path it enforced and check that the new code re-establishes it. For each function, type, schema field, constant or message the diff changes, check its callers and callees in the shown source for a new precondition, a changed return shape or unit, a new exception, a removed field or an ordering dependency the change breaks.",
  },
  {
    name: "edge-cases",
    focus:
      "Edge cases and failure paths. For each changed line, find the input, state or timing that makes it wrong: missing, empty, zero or duplicate values, retries and idempotency, concurrent requests and races, partial failure, limits and truncation, and error handling that swallows or misreports a failure.",
  },
] as const;
// Implementation first, then tests, then documentation and data, so a pass
// cut short by the limit or the time budget leaves the least important
// files unreviewed.
function coverageRank(path: string): number {
  if (
    /(?:^|\/)(?:test|tests|__tests__|e2e)\/|\.(?:test|spec)\.[^/]+$/.test(path)
  )
    return 1;
  if (
    /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|swift|rb|php|cs|c|cc|cpp|h|scala|dart|vue|svelte|sql|ya?ml|toml|sh)$/i.test(
      path,
    )
  )
    return 0;
  return 2;
}

export type ReviewTraceEvent =
  | {
      stage: "proposed";
      step: string;
      candidates: Array<{
        path: unknown;
        priority: unknown;
        confidence: unknown;
        title: unknown;
      }>;
    }
  | { stage: "verified"; step: string; kept: string[]; discarded: string[] };

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
  // Receives what each step proposed and kept, for review-quality checks.
  trace?: (event: ReviewTraceEvent) => void;
  // When the enclosing action started, for its deadline; defaults to now.
  startedAt?: number;
  // What people and other reviewers said on the pull request.
  discussion?: DiscussionEntry[];
  // Run SECOND_LOOKS after the main review of a single review.
  secondLooks?: boolean;
}): Promise<{
  findings: Finding[];
  reads: ReadEvidence[];
  excludedPaths: string[];
  openRequests: OpenRequest[];
}> {
  const actionStarted = args.startedAt ?? Date.now();
  const discussion = args.discussion ?? [];
  // The latest answer's unaddressed reviewer requests.
  let openRequests: OpenRequest[] = [];
  const recordOpenRequests = (answer: unknown) => {
    openRequests = validOpenRequests(answer, discussion);
    return answer;
  };
  // Reports the raw candidates of one step before any filtering.
  const proposed = (step: string, value: unknown) => {
    if (
      args.trace &&
      value !== null &&
      typeof value === "object" &&
      "findings" in value &&
      Array.isArray(value.findings)
    )
      args.trace({
        stage: "proposed",
        step,
        candidates: value.findings.map((item: Record<string, unknown>) => ({
          path: item?.path,
          priority: item?.priority,
          confidence: item?.confidence,
          title: item?.title,
        })),
      });
    return value;
  };
  const reads: ReadEvidence[] = [];
  const sourceCache = new Map<string, string>();
  const unavailablePaths = new Set<string>();
  // Paths whose source cannot be read at all, unlike ones the main
  // conversation had no room left to show.
  const unreadablePaths = new Set<string>();
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
      unreadablePaths.add(path);
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
    ...(args.discussion?.length ? { discussion: args.discussion } : {}),
  });
  // Every request that returns findings carries the repository's setting.
  const findingsPrompt =
    REVIEW_PROMPT +
    (args.allowSuggestions === false
      ? "\nCommit suggestions are disabled for this repository. Set suggestion to null."
      : "");
  const initialMessages = (sources = headContext): ChatMessage[] => [
    { role: "system", content: findingsPrompt },
    reviewContextMessage(
      initialMetadata(sources),
      [...context, ...sources].map((r) => ({
        ...r,
        truncated: r.ref === "base" && incompleteGuides.has(r.path),
      })),
      { cached: true },
    ),
  ];
  const initialBytes = (sources = headContext) =>
    chatRequestBytes(initialMessages(sources), {
      tools: reviewTools,
      responseFormat: REVIEW_RESPONSE_FORMAT,
    }) + REVIEW_OUTPUT_TOKENS;
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
    // inspection, so optional preparation stays bounded. Billing holds up to
    // a quarter more for the cache write of this prefix.
    if (initialBytes(prepared) > 90_000) return true;
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
  while (headContext.length > 0 && initialBytes() > 90_000) {
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
      openRequests: [],
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
        { cached: true },
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
  // A second model pass challenges candidates; deterministic quote/line checks
  // remain mandatory. This is self-critique, not an independent review.
  type VerificationCandidate = {
    id: string;
    finding: Finding;
    refutation?: string;
  };
  // One verification request: which candidates hold, and which are refuted by
  // a quote of the shown source.
  const askVerification = async (
    instruction: string,
    candidates: VerificationCandidate[],
    files: ChangedFile[],
    sources: ReadEvidence[],
    billingLabel: string,
  ) => {
    const critique = await chat(
      [
        { role: "system", content: `${REVIEW_PROMPT}\n${instruction}` },
        reviewContextMessage(
          {
            candidates,
            changedFiles: files,
          },
          sources.map((r) => ({
            ...r,
            truncated: r.ref === "base" && incompleteGuides.has(r.path),
          })),
        ),
      ],
      {
        maxTokens: REVIEW_OUTPUT_TOKENS,
        billingLabel,
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
              refutations: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: {
                      type: "string",
                      enum: candidates.map((candidate) => candidate.id),
                    },
                    quote: { type: "string" },
                  },
                  required: ["id", "quote"],
                  additionalProperties: false,
                },
              },
            },
            required: ["retainedFindingIds", "refutations"],
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
      Object.keys(selection).some(
        (key) => key !== "retainedFindingIds" && key !== "refutations",
      ) ||
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
    // A candidate is dropped only on a refutation quoting the shown source;
    // an unsupported "not retained" keeps it, since in practice verification
    // mostly removed real defects it was merely unsure about.
    // A refutation quotes the candidate's own target or evidence files, and
    // not merely the evidence the candidate already cites.
    const refutes = (id: string, quote: string) => {
      const finding = candidates.find((c) => c.id === id)?.finding;
      if (!finding) return false;
      const paths = new Set([
        finding.path,
        ...finding.evidence.map((e) => e.path),
      ]);
      return (
        !finding.evidence.some((e) => e.quote.includes(quote)) &&
        sources.some(
          (source) => paths.has(source.path) && source.content.includes(quote),
        )
      );
    };
    const refuted = new Map<string, string>();
    for (const r of "refutations" in selection &&
    Array.isArray(selection.refutations)
      ? selection.refutations
      : [])
      if (
        r !== null &&
        typeof r === "object" &&
        "id" in r &&
        typeof r.id === "string" &&
        "quote" in r &&
        typeof r.quote === "string" &&
        r.quote.trim().length >= 12 &&
        r.quote.length <= 1500 &&
        !refuted.has(r.id) &&
        refutes(r.id, r.quote)
      )
        refuted.set(r.id, r.quote);
    const retained = new Set(selection.retainedFindingIds as string[]);
    return candidates
      .filter((c) => !retained.has(c.id) && refuted.has(c.id))
      .map((c) => ({ ...c, refutation: refuted.get(c.id) }));
  };
  // A second model pass challenges candidates; deterministic quote/line checks
  // remain mandatory. This is self-critique, not an independent review.
  const verify = async (
    findings: Finding[],
    files: ChangedFile[],
    sources: ReadEvidence[],
    billingLabel: string,
  ): Promise<Finding[]> => {
    if (findings.length === 0) return findings;
    await args.guard();
    const candidates = findings.map((finding, index) => ({
      id: `F${index + 1}`,
      finding,
    }));
    let dropped = await askVerification(
      "This is the verification pass. Check each supplied candidate against the source. Return retainedFindingIds for the candidates that hold. A candidate may be dropped only when the source shows it is incorrect, pre-existing or already handled: for each such candidate add a refutation with its id and an exact quote of 12-1500 characters from the SOURCE blocks that shows it. A candidate without a quoted refutation is kept; uncertainty alone is not a reason to drop it. Do not rewrite findings, change anchors or confidence, add suggestions, or introduce new findings.",
      candidates,
      files,
      sources,
      billingLabel,
    );
    const trace = (step: string, checked: VerificationCandidate[]) =>
      args.trace?.({
        stage: "verified",
        step,
        kept: checked
          .filter((c) => !dropped.some((d) => d.id === c.id))
          .map((c) => c.finding.title),
        discarded: dropped.map((c) => c.finding.title),
      });
    trace(billingLabel, candidates);
    // A refuted candidate gets a second check of its refutation, so one
    // misread of the source cannot drop a real defect. It is dropped only when
    // that check refutes it again; if the check cannot run, the first
    // decision stands.
    if (
      dropped.length > 0 &&
      Date.now() - actionStarted <= COVERAGE_REQUEST_CUTOFF_MS
    ) {
      const appealed = dropped;
      try {
        await args.guard();
        dropped = await askVerification(
          "This is a second check of refutations. Each supplied candidate was dropped by an earlier check, which quoted the source in its refutation field. Re-check each refutation independently against the source: it holds only if the quoted code, read with the code around it, shows the candidate is incorrect, pre-existing or already handled on every path the candidate describes. A refutation that misreads the code, covers only some of those paths, or quotes code the defect does not depend on does not hold. Return retainedFindingIds for the candidates whose refutation does not hold, and a refutation with an exact quote of 12-1500 characters from the SOURCE blocks for each candidate that is still refuted. Do not rewrite findings or introduce new ones.",
          appealed,
          files,
          sources,
          `${billingLabel}/appeal`,
        );
        trace(`${billingLabel}/appeal`, appealed);
      } catch (error) {
        if (isLifecycleChange(error)) throw error;
        dropped = appealed;
      }
    }
    const retainedFindingIds = candidates
      .filter((c) => !dropped.some((d) => d.id === c.id))
      .map((c) => c.id);
    // Selection cannot mutate a previously validated candidate. Validate its
    // original evidence again rather than trusting generated replacement text.
    return validateFindings(
      {
        findings: candidates
          .filter((candidate) => retainedFindingIds.includes(candidate.id))
          .map((candidate) => candidate.finding),
      },
      files,
      sources,
    );
  };
  // Set once the account cannot afford another request in this review.
  let accountLimited = false;
  const unread = (skipped: Set<string>) =>
    args.files
      .filter(
        (f) =>
          !excludedPaths.includes(f.filename) &&
          !unreadablePaths.has(f.filename) &&
          !skipped.has(f.filename) &&
          !reads.some((r) => r.ref === "head" && r.path === f.filename),
      )
      .sort((a, b) => coverageRank(a.filename) - coverageRank(b.filename));
  const coverageMessages = (
    files: ChangedFile[],
    sources: ReadEvidence[],
  ): ChatMessage[] => [
    {
      role: "system",
      content: `${findingsPrompt}\nThis is a coverage pass over changed files the main review did not read. Review only the changed files listed here, using their SOURCE blocks and the diff. Tools are unavailable. Return every finding that meets the rules above for these files; an empty findings array is valid. There is no discussion here: return an empty openRequests array.`,
    },
    reviewContextMessage(
      {
        repository: args.repository,
        title: args.title.slice(0, 500),
        description,
        descriptionTruncated: description.length < args.body.length,
        changedFiles: files.map((file) => ({
          ...file,
          addedLineAnchors: lineAnchors(
            file,
            sources.find((s) => s.path === file.filename)?.content,
          ),
        })),
        otherChangedPaths: args.files
          .filter((f) => !files.includes(f))
          .map((f) => f.filename)
          .slice(0, 80),
        guideContextWarning:
          "Guide excerpts may be incomplete. Never infer omitted content.",
      },
      [...context, ...sources],
    ),
  ];
  // The main conversation holds at most 100K characters of source, so a large
  // change can end with changed files the reviewer never read. Those files are
  // reviewed in fresh requests of their own, each verified on its own source.
  // A pass the model cannot complete leaves its files reported as not
  // reviewed, and the account limit or the time budget ends the passes.
  const coverUnread = async (): Promise<Finding[]> => {
    const found: Finding[] = [];
    // A batch group runs on a quota hold sized for one request chain; the
    // groups themselves are how a large change gets covered.
    if (accountLimited || args.batchGroup) return found;
    const skipped = new Set<string>();
    const timeLeft = () =>
      Date.now() - actionStarted <= COVERAGE_REQUEST_CUTOFF_MS;
    for (let pass = 1; pass <= MAX_COVERAGE_PASSES && timeLeft(); pass++) {
      const pending = unread(skipped);
      if (pending.length === 0) break;
      await args.guard();
      const files: ChangedFile[] = [];
      const sources: ReadEvidence[] = [];
      let content: string | null;
      for (const file of pending) {
        try {
          content = await readOptionalContext(file.filename, "head");
        } catch (error) {
          // A GitHub read failure ends the optional passes; the review keeps
          // what it already has.
          if (isLifecycleChange(error)) throw error;
          return found;
        }
        if (content === null) continue;
        const evidence = {
          path: file.filename,
          ref: "head" as const,
          content,
        };
        const fits =
          JSON.stringify([...sources, evidence]).length <=
            COVERAGE_PASS_SOURCE &&
          chatRequestBytes(
            coverageMessages([...files, file], [...sources, evidence]),
            { responseFormat: REVIEW_RESPONSE_FORMAT },
          ) +
            REVIEW_OUTPUT_TOKENS <=
            COVERAGE_PASS_REQUEST;
        if (fits) {
          files.push(file);
          sources.push(evidence);
        } else if (files.length === 0) {
          // Too large to review alone: reported as not reviewed.
          skipped.add(file.filename);
        } else break;
      }
      if (files.length === 0) continue;
      const passReads = [...context, ...sources];
      // Files whose candidate could not be validated stay reported as not
      // reviewed, so a defect the model saw can never read as a clean file.
      const doubtful = new Set<string>();
      // Reading the files takes time too: check again right before the request.
      if (!timeLeft()) break;
      try {
        const response = await chat(coverageMessages(files, sources), {
          maxTokens: REVIEW_OUTPUT_TOKENS,
          billingLabel: `pr-review/coverage/${pass}`,
          responseFormat: REVIEW_RESPONSE_FORMAT,
        });
        if (response.finishReason !== "stop")
          throw new Error("Review did not finish completely");
        const decoded = proposed(`coverage/${pass}`, decode(response.content));
        if (
          decoded === null ||
          typeof decoded !== "object" ||
          !("findings" in decoded) ||
          !Array.isArray(decoded.findings)
        )
          throw new Error("Invalid review result");
        const value = confidentCandidates(
          {
            // Uncertain candidates go first, so they never displace a
            // confident one past the cap.
            findings: decoded.findings
              .filter(
                (item: unknown) =>
                  !((confidenceOf(item) ?? 1) < MIN_FINDING_CONFIDENCE),
              )
              .slice(0, MAX_REVIEW_FINDINGS),
          },
          args.allowSuggestions,
          new Set(files.map((f) => f.filename)),
        ) as { findings: unknown[] };
        let candidates: Finding[] = [];
        for (const item of value.findings) {
          try {
            candidates = validateFindings(
              { findings: [...candidates, item] },
              files,
              passReads,
            );
          } catch (error) {
            if (!isReviewGroupModelFailure(error)) throw error;
            const path =
              item !== null && typeof item === "object" && "path" in item
                ? item.path
                : undefined;
            for (const file of files)
              if (typeof path !== "string" || file.filename === path)
                doubtful.add(file.filename);
          }
        }
        if (candidates.length > 0) {
          // Verification needs room for the candidates as well as the source.
          if (
            !timeLeft() ||
            JSON.stringify(sources).length + JSON.stringify(candidates).length >
              COVERAGE_PASS_REQUEST
          )
            throw new Error("Review verification did not finish");
          found.push(
            ...(await verify(
              candidates,
              files,
              passReads,
              `pr-review/coverage/${pass}/critique`,
            )),
          );
        }
      } catch (error) {
        if (isLifecycleChange(error)) throw error;
        const cause = reviewFailureCause(error);
        if (cause instanceof ChatBillingError) {
          accountLimited ||= cause.reason === "limit_reached";
          break;
        }
        // A timeout or provider outage ends the optional passes; the review
        // keeps what it already has.
        if (
          cause instanceof ChatProviderRequestError &&
          !isReviewGroupModelFailure(error)
        )
          break;
        if (!isReviewGroupModelFailure(error)) throw error;
        for (const file of files) skipped.add(file.filename);
        continue;
      }
      for (const source of sources) {
        if (doubtful.has(source.path)) {
          skipped.add(source.path);
          continue;
        }
        reads.push(source);
        unavailablePaths.delete(source.path);
      }
    }
    return found;
  };
  const secondLooks = async (
    known: Finding[],
    sources: ReadEvidence[],
  ): Promise<Finding[]> => {
    const found: Finding[] = [];
    const last = messages[1]?.content;
    const state = Array.isArray(last) ? last.at(-1) : undefined;
    if (
      !args.secondLooks ||
      accountLimited ||
      args.batchGroup ||
      !Array.isArray(last) ||
      state?.type !== "text" ||
      state.cache ||
      // The cached layout ends with a state block after the sources.
      !last.slice(0, -1).some((part) => part.type === "text" && part.cache)
    )
      return found;
    let anchors: unknown;
    try {
      anchors = (JSON.parse(state.text) as Record<string, unknown>)
        .addedLineAnchors;
    } catch {
      return found;
    }
    const prefix = last.slice(0, -1);
    const timeLeft = () =>
      Date.now() - actionStarted <= COVERAGE_REQUEST_CUTOFF_MS;
    for (const look of SECOND_LOOKS) {
      if (!timeLeft()) break;
      await args.guard();
      const reported = [...known, ...found].map((f) => ({
        path: f.path,
        line: f.line,
        title: f.title,
      }));
      try {
        const response = await chat(
          [
            messages[0],
            {
              role: "user",
              content: [
                ...prefix,
                {
                  type: "text",
                  text: JSON.stringify({
                    addedLineAnchors: anchors,
                    secondLook: {
                      focus: look.focus,
                      alreadyReported: reported,
                      instruction:
                        "The review above is done, and first reviews of a change usually miss real defects. Look again at the same source with only this focus: go through every changed hunk one by one and apply the focus to it. Report each defect not already reported that the shown source supports, with the usual evidence and confidence rules; a separate verification checks every finding. Answer from the source shown; do not call tools. Return an empty findings array only when no hunk has such a defect.",
                    },
                  }),
                },
              ],
            },
          ],
          {
            maxTokens: REVIEW_OUTPUT_TOKENS,
            tools: reviewTools,
            billingLabel: `pr-review/look/${look.name}`,
            responseFormat: REVIEW_RESPONSE_FORMAT,
          },
        );
        // A look that wants more source has nothing to add from this one.
        if (response.finishReason !== "stop") continue;
        const decoded = proposed(`look/${look.name}`, decode(response.content));
        if (
          decoded === null ||
          typeof decoded !== "object" ||
          !("findings" in decoded) ||
          !Array.isArray(decoded.findings)
        )
          continue;
        const value = confidentCandidates(
          {
            findings: decoded.findings
              .filter(
                (item: unknown) =>
                  !((confidenceOf(item) ?? 1) < MIN_FINDING_CONFIDENCE),
              )
              .slice(0, MAX_REVIEW_FINDINGS),
          },
          // A look's suggestion could overlap one already reported, which
          // publication refuses, so looks report findings only.
          false,
          new Set(args.files.map((f) => f.filename)),
        ) as { findings: unknown[] };
        let candidates: Finding[] = [];
        for (const item of value.findings) {
          try {
            candidates = validateFindings(
              { findings: [...candidates, item] },
              args.files,
              sources,
            );
          } catch (error) {
            if (!isReviewGroupModelFailure(error)) throw error;
          }
        }
        // A look may repeat what the review already found.
        candidates = candidates.filter(
          (c) =>
            !reported.some(
              (r) =>
                r.path === c.path && (r.line === c.line || r.title === c.title),
            ),
        );
        if (candidates.length === 0 || !timeLeft()) continue;
        found.push(
          ...(await verify(
            candidates,
            args.files,
            sources,
            `pr-review/look/${look.name}/critique`,
          )),
        );
      } catch (error) {
        if (isLifecycleChange(error)) throw error;
        const cause = reviewFailureCause(error);
        if (cause instanceof ChatBillingError)
          accountLimited ||= cause.reason === "limit_reached";
        // A second look is optional: an answer that cannot be used skips it,
        // and any other failure ends the looks with what the review has.
        if (isReviewGroupModelFailure(error)) continue;
        break;
      }
    }
    return found;
  };
  const finalize = async (findings: Finding[]) => {
    if (!inspectedChange() && !(args.batchGroup && findings.length === 0))
      throw new Error("Reviewer did not inspect the changed implementation");
    if (
      args.allowSuggestions === false &&
      findings.some((f) => f.suggestion !== undefined)
    )
      throw new Error("Commit suggestions are disabled");
    const verified = await verify(
      findings,
      args.files,
      reads,
      "pr-review/critique",
    );
    // Second looks read the source the main review was shown, captured
    // before coverage passes add their own.
    const mainReads = [...reads];
    const covered = await coverUnread();
    const looked = await secondLooks([...verified, ...covered], mainReads);
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
    return {
      openRequests,
      // The most severe and certain findings come first, so a cap on what is
      // published keeps them.
      findings: [...verified, ...covered, ...looked].sort(
        (a, b) =>
          a.priority.localeCompare(b.priority) || b.confidence - a.confidence,
      ),
      reads,
      excludedPaths: coverage,
    };
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
      accountLimited = true;
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
    const answer = proposed(`main/${turn}`, await parse(response.content));
    openRequests = validOpenRequests(answer, discussion);
    const value = confidentCandidates(
      answer,
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
        timeoutMs: Math.min(
          5 * 60_000,
          Math.max(
            2 * 60_000,
            actionStarted + FINAL_REQUEST_END_MS - Date.now(),
          ),
        ),
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
    accountLimited = true;
    reads.splice(readsBeforePass);
    rebuildMessages();
    final = await synthesize();
  }
  if (final.finishReason !== "stop")
    throw new Error("Review final synthesis did not complete");
  return await finalize(
    validateFindings(
      confidentCandidates(
        recordOpenRequests(proposed("final", await parse(final.content))),
        args.allowSuggestions,
        groupPaths,
      ),
      args.files,
      reads,
    ),
  );
}
