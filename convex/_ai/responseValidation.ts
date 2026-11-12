/**
 * AI Response Validation
 *
 * Validates AI responses before posting to GitHub to prevent:
 * 1. Internal field name leakage (e.g., "suggestedResponse", "isActionable")
 * 2. Context loss indicators (e.g., "I don't have any record of...")
 *
 * Based on production bug #3134 where gitdog exposed internal implementation details.
 */

// Internal field names that should NEVER appear in user-facing responses
const INTERNAL_FIELD_NAMES = [
  "suggestedResponse",
  "isActionable",
  "issueType",
  "proposedChanges",
  "ticketId",
  "actionId",
  "repositoryId",
  "chatHistory",
  "tokenUsage",
  "inputTokens",
  "outputTokens",
];

// Internal file path patterns that should NEVER be referenced in user-facing responses
// These are AI guide files, internal configs, or system files not meant for users
const INTERNAL_PATH_PATTERNS = [
  /\.claude\//i, // .claude/ directory (AI guide files)
  /\.ai\//i, // .ai/ directory (AI config files)
  /\.gemini\//i, // Gemini-specific instruction directory
  /knowledge\//i, // compiled/internal AI knowledge
  /AGENTS\.md/i, // AI agent instructions
  /CLAUDE\.md/i, // Claude-specific instructions
  /GEMINI\.md/i, // Gemini-specific instructions
  /COPILOT\.md/i, // Copilot-specific instructions
  /llm\.txt/i, // LLM instruction files
];

// Phrases that indicate the AI lost conversation context
const CONTEXT_LOSS_PHRASES = [
  "I don't have any record of",
  "I don't have access to previous",
  "Each conversation with me starts fresh",
  "without access to prior interactions",
  "I'm not aware of any previous",
  "I would need you to provide the full context",
  "I don't have context about",
  "no record of a previous conversation",
];

const SPECULATION_CONFIDENCE_THRESHOLD = 0.5;
const TOPIC_DRIFT_CONFIDENCE_THRESHOLD = 0.7;

// Speculation patterns that indicate the AI is guessing without code evidence
// These are WARNING-level (logged but not blocking) unless combined with low confidence
const SPECULATION_PATTERNS = [
  "timing requirements",
  "stricter timing",
  "timing issues",
  "initialization timing",
  "race condition",
  "race conditions",
  "initialization order",
  "bridge initialization",
  "different initialization",
  "may not be ready",
  "might not be initialized",
  "could be a timing",
  "platform has different",
  "platform differences",
  "Try adding setTimeout",
  "you could try adding a delay",
  "try wrapping it in",
];

function escapeRegexTerm(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
}

const EXTERNAL_DEPENDENCY_TERMS = [
  "android",
  "app store",
  "aws",
  "azure",
  "browser",
  "bun",
  "chrome",
  "cloudflare",
  "convex",
  "deno",
  "docker",
  "expo",
  "firebase",
  "flutter",
  "github actions",
  "google play",
  "google play billing",
  "iapkit",
  "ios",
  "kubernetes",
  "lemon squeezy",
  "linux",
  "macos",
  "node.js",
  "openiap",
  "play store",
  "react native",
  "safari",
  "stripe",
  "storekit",
  "tvos",
  "vercel",
  "watchos",
  "windows",
];

const EXTERNAL_DEPENDENCY_TERM_SOURCE =
  EXTERNAL_DEPENDENCY_TERMS.map(escapeRegexTerm).join("|");

const EXTERNAL_DEPENDENCY_TERM_PATTERN = new RegExp(
  `\\b(?:${EXTERNAL_DEPENDENCY_TERM_SOURCE})\\b`,
  "i",
);

const UNIVERSAL_CLAIM_TERMS = [
  "all",
  "always",
  "each time",
  "every",
  "every time",
  "never",
  "whenever",
];

const UNIVERSAL_CLAIM_TERM_SOURCE =
  UNIVERSAL_CLAIM_TERMS.map(escapeRegexTerm).join("|");

const EXTERNAL_BEHAVIOR_VERB_SOURCE =
  "acts?|behaves?|crash(?:es|ed)?|deliver(?:s|ed)?|disconnect(?:s|ed)?|emit(?:s|ted)?|fail(?:s|ed)?|fire(?:s|d)?|initializ(?:e|es|ed)|load(?:s|ed)?|receiv(?:e|es|ed)|replay(?:s|ed)?|retr(?:y|ies|ied)|return(?:s|ed)?|runs?|ran|sends?|sent|trigger(?:s|ed)?|work(?:s|ed)?";

const NEARBY_CLAIM_TERM_GAP = "[\\s\\S]{0,40}";

const UNIVERSAL_EXTERNAL_CLAIM_PATTERNS = [
  [
    EXTERNAL_DEPENDENCY_TERM_SOURCE,
    UNIVERSAL_CLAIM_TERM_SOURCE,
    EXTERNAL_BEHAVIOR_VERB_SOURCE,
  ],
  [
    EXTERNAL_DEPENDENCY_TERM_SOURCE,
    EXTERNAL_BEHAVIOR_VERB_SOURCE,
    UNIVERSAL_CLAIM_TERM_SOURCE,
  ],
  [
    UNIVERSAL_CLAIM_TERM_SOURCE,
    EXTERNAL_DEPENDENCY_TERM_SOURCE,
    EXTERNAL_BEHAVIOR_VERB_SOURCE,
  ],
  [
    UNIVERSAL_CLAIM_TERM_SOURCE,
    EXTERNAL_BEHAVIOR_VERB_SOURCE,
    EXTERNAL_DEPENDENCY_TERM_SOURCE,
  ],
  [
    EXTERNAL_BEHAVIOR_VERB_SOURCE,
    EXTERNAL_DEPENDENCY_TERM_SOURCE,
    UNIVERSAL_CLAIM_TERM_SOURCE,
  ],
  [
    EXTERNAL_BEHAVIOR_VERB_SOURCE,
    UNIVERSAL_CLAIM_TERM_SOURCE,
    EXTERNAL_DEPENDENCY_TERM_SOURCE,
  ],
].map(
  ([first, second, third]) =>
    new RegExp(
      `\\b(?:${first})\\b${NEARBY_CLAIM_TERM_GAP}\\b(?:${second})\\b${NEARBY_CLAIM_TERM_GAP}\\b(?:${third})\\b`,
      "gi",
    ),
);

const CORRECTION_OR_META_PATTERN = new RegExp(
  [
    "\\b(?:avoid saying|do not (?:claim|say|state|write)|don't (?:claim|say|state|write)|incorrect|isn't true|never (?:claim|say|state|write)|not true|overclaim|should(?: not|n't) (?:claim|say|state|write)|wrong)\\b",
    `\\b(?:does not|doesn't|do not|don't|not)\\b\\s+\\b(?:${UNIVERSAL_CLAIM_TERM_SOURCE})\\b`,
  ].join("|"),
  "i",
);

const REPOSITORY_SCOPED_PATTERN =
  /\b(?:in this repo|in this repository|i found|i read|repository's|the code|this code|this repo|this repository)\b/i;

// Exempt only wording close to the matched claim so one grounded sentence does
// not suppress a distinct external overclaim later in the same paragraph.
const LOCAL_CLAIM_CONTEXT_CHARS = 32;

// Code snippets with likely no-op lines. These are cheap syntactic checks for
// mistakes that make an otherwise useful response unsafe to post.
const SUSPICIOUS_CODE_PATTERNS = [
  {
    label: "standalone Set.has() call",
    pattern:
      /^\s*(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*\.has\([^;\n]+\);?\s*(?:\/\/.*)?$/m,
    correctionPattern:
      /\b(?:delete|does nothing|incorrect|no-op|remove|should remove|wrong)\b[\s\S]{0,160}\.has\(/i,
  },
];

const MAX_ISSUE_PREVIEW_CHARS = 120;
const MAX_TOPIC_IDENTIFIERS = 8;

const GENERIC_TOPIC_IDENTIFIERS = new Set([
  "actual",
  "android",
  "app",
  "apple",
  "bug",
  "code",
  "error",
  "expected",
  "github",
  "ios",
  "issue",
  "request",
  "store",
  "storekit",
  "summary",
]);

const PER_REQUEST_FORWARDING_VERB_SOURCE =
  "attach(?:es|ed|ing)?|forward(?:s|ed|ing)?|includ(?:e|es|ed|ing)|pass(?:es|ed|ing)?|provid(?:e|es|ed|ing)|send(?:s|ing)?|sent|us(?:e|es|ed|ing)";
const IAP_TOKEN_TERM_SOURCE = "jws|purchase[\\s-]*tokens?|receipts?";
const PER_REQUEST_SCOPE_SOURCE =
  "(?:each|every)\\s+(?:api\\s+|authenticated\\s+|backend\\s+|premium\\s+)?requests?";
const PER_REQUEST_CORRECTION_WORD_SOURCE =
  "avoid|do not|don't|instead|rather than|should not|shouldn't";
const PER_REQUEST_CORRECTION_NON_SCOPE_GAP_SOURCE = `(?:(?!\\b${PER_REQUEST_SCOPE_SOURCE}\\b)[^.\\n])`;
const PER_REQUEST_CORRECTION_GAP_SOURCE = "[^.\\n]{0,100}";

const PER_REQUEST_TOKEN_FORWARDING_PATTERN = new RegExp(
  [
    `\\b(?:${PER_REQUEST_FORWARDING_VERB_SOURCE})\\b[\\s\\S]{0,100}\\b(?:${IAP_TOKEN_TERM_SOURCE})\\b[\\s\\S]{0,100}\\b${PER_REQUEST_SCOPE_SOURCE}\\b`,
    `\\b${PER_REQUEST_SCOPE_SOURCE}\\b[\\s\\S]{0,100}\\b(?:${PER_REQUEST_FORWARDING_VERB_SOURCE})\\b[\\s\\S]{0,100}\\b(?:${IAP_TOKEN_TERM_SOURCE})\\b`,
    `\\b(?:${IAP_TOKEN_TERM_SOURCE})\\b[\\s\\S]{0,100}\\b(?:${PER_REQUEST_FORWARDING_VERB_SOURCE})\\b[\\s\\S]{0,100}\\b${PER_REQUEST_SCOPE_SOURCE}\\b`,
  ].join("|"),
  "i",
);

const PER_REQUEST_TOKEN_CORRECTION_PATTERN = new RegExp(
  [
    `\\b(?:${PER_REQUEST_CORRECTION_WORD_SOURCE})\\b${PER_REQUEST_CORRECTION_NON_SCOPE_GAP_SOURCE}{0,160}\\b(?:${IAP_TOKEN_TERM_SOURCE})\\b${PER_REQUEST_CORRECTION_GAP_SOURCE}\\b${PER_REQUEST_SCOPE_SOURCE}\\b`,
    `\\b(?:${IAP_TOKEN_TERM_SOURCE})\\b${PER_REQUEST_CORRECTION_NON_SCOPE_GAP_SOURCE}{0,100}\\b(?:${PER_REQUEST_CORRECTION_WORD_SOURCE})\\b${PER_REQUEST_CORRECTION_GAP_SOURCE}\\b${PER_REQUEST_SCOPE_SOURCE}\\b`,
  ].join("|"),
  "i",
);

const IAPKIT_CONTEXT_PATTERN =
  /\b(?:iap\s+kit|iapkit|open-?iap|kit\.openiap\.dev)\b/i;

const UNSUPPORTED_IAPKIT_STATE_LITERAL_PATTERN =
  /\bstates?\b[\s\S]{0,80}(?:^|[^A-Za-z0-9_-])(?:`|"|')?(?:billing-retry|cancelled|canceled|entitled|expired|grace-period)(?:`|"|')?(?=$|[^A-Za-z0-9_-])/i;

const FLUTTER_SPM_CONTEXT_SOURCE =
  "spm|swift\\s+package\\s+manager|package\\.swift|plugin\\s+manifest";
const FLUTTER_SPM_REGISTRANT_ACTION_SOURCE =
  "expects?|mechanism|requires?|should|through|using|uses?|via|wrap(?:s|ped|ping)?|wrapping";
const SAME_SENTENCE_GAP_SOURCE = "[^.!?\\n]{0,120}";
const SAME_CLAUSE_GAP_SOURCE = "[^.!?;:\\n]{0,120}";

const FLUTTER_SPM_REGISTRANT_PATTERN = new RegExp(
  [
    `\\b(?:${FLUTTER_SPM_CONTEXT_SOURCE})\\b${SAME_SENTENCE_GAP_SOURCE}\\b(?:${FLUTTER_SPM_REGISTRANT_ACTION_SOURCE})\\b${SAME_SENTENCE_GAP_SOURCE}\\b(?:FlutterPluginRegistrant|GeneratedPluginRegistrant)\\b`,
    `\\b(?:${FLUTTER_SPM_REGISTRANT_ACTION_SOURCE})\\b${SAME_SENTENCE_GAP_SOURCE}\\b(?:FlutterPluginRegistrant|GeneratedPluginRegistrant)\\b${SAME_SENTENCE_GAP_SOURCE}\\b(?:${FLUTTER_SPM_CONTEXT_SOURCE})\\b`,
    `\\b(?:FlutterPluginRegistrant|GeneratedPluginRegistrant)\\b${SAME_SENTENCE_GAP_SOURCE}\\b(?:${FLUTTER_SPM_REGISTRANT_ACTION_SOURCE})\\b${SAME_SENTENCE_GAP_SOURCE}\\b(?:${FLUTTER_SPM_CONTEXT_SOURCE})\\b`,
  ].join("|"),
  "i",
);

const FLUTTER_SPM_CORRECTION_WORD_SOURCE =
  "avoid(?: saying)?|do not (?:add|claim|recommend|say|state|use|write)|don't (?:add|claim|recommend|say|state|use|write)|incorrect(?: to say)?|isn't true|not true|overclaim|should(?: not|n't) (?:add|claim|recommend|say|state|use|write)|wrong";
const FLUTTER_SPM_CORRECTION_TARGET_SOURCE =
  "FlutterPluginRegistrant|GeneratedPluginRegistrant|FlutterFramework|3\\.44";
const FLUTTER_SPM_REVERSE_CORRECTION_SOURCE =
  "(?:is|are|was|were|would\\s+be)\\s+(?:incorrect|not\\s+true|wrong)|isn't\\s+true";

const FLUTTER_SPM_CORRECTION_PATTERN = new RegExp(
  [
    `\\b(?:${FLUTTER_SPM_CORRECTION_WORD_SOURCE})\\b${SAME_SENTENCE_GAP_SOURCE}\\b(?:${FLUTTER_SPM_CORRECTION_TARGET_SOURCE})\\b`,
    `\\b(?:${FLUTTER_SPM_CORRECTION_TARGET_SOURCE})\\b${SAME_CLAUSE_GAP_SOURCE}\\b(?:${FLUTTER_SPM_REVERSE_CORRECTION_SOURCE})\\b`,
  ].join("|"),
  "i",
);

const FLUTTER_FRAMEWORK_TERM_SOURCE =
  "FlutterFramework|framework\\s+(?:artifacts?|dependenc(?:y|ies))";
const FLUTTER_VERSION_CLAIM_VERB_SOURCE =
  "available|introduced|new\\s+in|provided|since|starting";

const FLUTTER_FRAMEWORK_344_VERSION_PATTERN = new RegExp(
  [
    `\\b(?:${FLUTTER_FRAMEWORK_TERM_SOURCE})\\b${SAME_SENTENCE_GAP_SOURCE}\\b(?:${FLUTTER_VERSION_CLAIM_VERB_SOURCE})\\b[^.!?\\n]{0,24}\\b3\\.44\\b`,
    `\\bflutter\\b[^.!?\\n]{0,40}\\bprovides?\\b${SAME_SENTENCE_GAP_SOURCE}\\b(?:${FLUTTER_FRAMEWORK_TERM_SOURCE})\\b${SAME_SENTENCE_GAP_SOURCE}\\b(?:starting|since|from)\\b[^.!?\\n]{0,24}\\b3\\.44\\b`,
  ].join("|"),
  "i",
);

const OPENIAP_LISTENER_CONTEXT_PATTERN =
  /\b(?:openiap|react-native-iap|rn-iap|HybridRnIap|listenersAttached)\b/i;
const OPENIAP_LISTENER_RESET_ADVICE_PATTERN = new RegExp(
  [
    "\\bendConnection\\b[\\s\\S]{0,600}\\b(?:add|include|modify|place|put|reset|set)\\b[\\s\\S]{0,180}\\blistenersAttached\\s*=\\s*false\\b",
    "\\b(?:add|include|modify|place|put|reset|set)\\b[\\s\\S]{0,180}\\blistenersAttached\\s*=\\s*false\\b[\\s\\S]{0,600}\\bendConnection\\b",
    "\\blistenersAttached\\s*=\\s*false\\b[\\s\\S]{0,180}\\b(?:add|include|modify|place|put|reset|set)\\b[\\s\\S]{0,600}\\bendConnection\\b",
  ].join("|"),
  "i",
);
const OPENIAP_LISTENER_NEVER_RESET_PATTERN = new RegExp(
  [
    "\\b(?:listenersAttached|listener\\s+flag|listeners?\\s+flag)\\b[\\s\\S]{0,180}\\b(?:never|not|isn'?t|is\\s+not|doesn'?t|does\\s+not)\\b[\\s\\S]{0,100}\\b(?:clear(?:ed)?|detach(?:ed)?|remove(?:d)?|reset)\\b",
    "\\b(?:never|not|isn'?t|is\\s+not|doesn'?t|does\\s+not)\\b[\\s\\S]{0,100}\\b(?:clear(?:ed)?|detach(?:ed)?|remove(?:d)?|reset)\\b[\\s\\S]{0,180}\\b(?:listenersAttached|listener\\s+flag|listeners?\\s+flag)\\b",
  ].join("|"),
  "i",
);
const OPENIAP_LISTENER_CORRECTION_PATTERN = new RegExp(
  [
    "\\b(?:already\\s+(?:appears|exists|has|is|resets?)|does\\s+reset|is\\s+reset|isn'?t\\s+the\\s+cause)\\b[\\s\\S]{0,240}\\b(?:listenersAttached|endConnection)\\b",
    "\\b(?:do\\s+not|don'?t|incorrect|not\\s+true|wrong)\\b[\\s\\S]{0,240}\\b(?:listenersAttached|endConnection)\\b",
    "\\b(?:listenersAttached|endConnection)\\b[\\s\\S]{0,240}\\b(?:already\\s+(?:appears|exists|has|is|resets?)|does\\s+reset|is\\s+reset|isn'?t\\s+the\\s+cause|incorrect|not\\s+true|wrong)\\b",
  ].join("|"),
  "i",
);
const OPENIAP_IAPKIT_BIND_CONTEXT_PATTERN =
  /\b(?:openiap|iapkit|kitApi|bindUser|bound\s*:\s*false|pending-acknowledg(?:e)?ment)\b/i;
const OPENIAP_IAPKIT_BIND_PENDING_ACK_PATTERN = new RegExp(
  [
    "\\bbindUser\\b[\\s\\S]{0,260}\\b(?:checks?|detects?|refuses?|rejects?|sees|cannot|can't|won'?t|will\\s+not|fails?)\\b[\\s\\S]{0,260}\\bpending-acknowledg(?:e)?ment\\b",
    "\\bpending-acknowledg(?:e)?ment\\b[\\s\\S]{0,260}\\bbindUser\\b[\\s\\S]{0,260}\\b(?:bound\\s*:\\s*false|cannot|can't|fails?|refuses?|rejects?|will\\s+not|won'?t)\\b",
    "\\bbound\\s*:\\s*false\\b[\\s\\S]{0,260}\\bpending-acknowledg(?:e)?ment\\b[\\s\\S]{0,260}\\bbindUser\\b",
  ].join("|"),
  "i",
);
const OPENIAP_IAPKIT_BIND_CORRECTION_SOURCE =
  "correct(?:ion|ed)|incorrect|wrong|not\\s+(?:the\\s+)?cause|does\\s+not\\s+(?:check|gate|inspect|read|refuse|reject)|doesn'?t\\s+(?:check|gate|inspect|read|refuse|reject)|no\\s+code\\s+path|no\\s+matching\\s+subscription\\s+row|subscriptions\\.by_project_and_token";
const OPENIAP_IAPKIT_BIND_CORRECTION_PATTERN = new RegExp(
  [
    `\\b(?:${OPENIAP_IAPKIT_BIND_CORRECTION_SOURCE})\\b[\\s\\S]{0,280}\\b(?:bindUser|pending-acknowledg(?:e)?ment|bound\\s*:\\s*false|subscriptions\\.by_project_and_token)\\b`,
    `\\b(?:bindUser|pending-acknowledg(?:e)?ment|bound\\s*:\\s*false|subscriptions\\.by_project_and_token)\\b[\\s\\S]{0,280}\\b(?:${OPENIAP_IAPKIT_BIND_CORRECTION_SOURCE})\\b`,
  ].join("|"),
  "i",
);
const OPENIAP_IAPKIT_RTDN_CONTEXT_PATTERN =
  /\b(?:rtdn|real[-\s]*time developer notifications?|pub\/?sub|webhooks?|google)\b/i;
const OPENIAP_IAPKIT_RTDN_MONOREPO_ABSENCE_PATTERN = new RegExp(
  [
    "\\b(?:no|not\\s+any|could(?:n'?t|\\s+not)\\s+find|can(?:'?t|not)\\s+find|found\\s+no)\\b[\\s\\S]{0,140}\\b(?:webhook|rtdn|real[-\\s]*time developer notifications?|pub/?sub)\\b[\\s\\S]{0,180}\\b(?:code|configuration|implementation|source)\\b",
    "\\b(?:iap\\s*kit|iapkit)\\b[\\s\\S]{0,160}\\b(?:separate\\s+(?:hosted\\s+)?(?:saas\\s+)?backend|not\\s+part\\s+of\\s+this\\s+monorepo|not\\s+in\\s+(?:this\\s+)?(?:monorepo|repository|repo))\\b",
    "\\b(?:webhook|rtdn|real[-\\s]*time developer notifications?|pub/?sub)\\b[\\s\\S]{0,180}\\b(?:not\\s+in|outside)\\b[\\s\\S]{0,120}\\b(?:openiap|source\\s+code|monorepo|repo(?:sitory)?)\\b",
  ].join("|"),
  "i",
);
const OPENIAP_IAPKIT_RTDN_MONOREPO_CORRECTION_PATTERN = new RegExp(
  [
    "\\b(?:correction|incorrect|wrong|not\\s+true|does\\s+live|is\\s+in|lives\\s+in)\\b[\\s\\S]{0,220}\\b(?:packages/kit|monorepo|webhook|rtdn|pub/?sub)\\b",
    "\\b(?:packages/kit|packages/docs)\\b[\\s\\S]{0,220}\\b(?:contains|has|includes|webhook|rtdn|pub/?sub)\\b",
  ].join("|"),
  "i",
);
const OPENIAP_IAPKIT_RTDN_ENDPOINT_MISSING_API_KEY_PATTERN = new RegExp(
  [
    "https?://kit\\.openiap\\.dev/v1/webhooks(?:/google)?/?(?=$|[`\\s).,])",
    "(?:^|\\s|[`\"'])/v1/webhooks(?:/google)?/?(?=$|[`\"'\\s).,])",
    "\\bEndpoint\\s+URL\\b[\\s\\S]{0,120}\\bhttps?://kit\\.openiap\\.dev/v1\\b(?!/webhooks/)",
  ].join("|"),
  "i",
);
const OPENIAP_IAPKIT_RTDN_ENDPOINT_CORRECTION_PATTERN = new RegExp(
  [
    "\\b(?:apiKey|api\\s+key|path\\s+segment)\\b[\\s\\S]{0,180}\\b(?:required|include|missing|without)\\b",
    "\\b(?:required|include|missing|without|do\\s+not|don'?t|incorrect|wrong)\\b[\\s\\S]{0,180}\\b(?:apiKey|api\\s+key|path\\s+segment)\\b",
    "(?:^|\\s|[`\"'])/v1/webhooks/(?:google/)?\\{apiKey\\}(?=$|[`\"'\\s).,])",
  ].join("|"),
  "i",
);
const OPENIAP_IAPKIT_RTDN_AUDIENCE_PROJECT_ID_PATTERN = new RegExp(
  [
    "\\b(?:audience|oidc\\s+audience)\\b[\\s\\S]{0,160}\\b(?:google\\s+cloud|gcp)\\s+project\\s+id\\b",
    "\\b(?:google\\s+cloud|gcp)\\s+project\\s+id\\b[\\s\\S]{0,160}\\b(?:audience|oidc\\s+audience)\\b",
  ].join("|"),
  "i",
);
const OPENIAP_IAPKIT_RTDN_AUDIENCE_CORRECTION_PATTERN = new RegExp(
  [
    "\\b(?:not|do\\s+not|don'?t|isn'?t|incorrect|wrong)\\b[\\s\\S]{0,180}\\b(?:google\\s+cloud|gcp)\\s+project\\s+id\\b",
    "\\b(?:google\\s+cloud|gcp)\\s+project\\s+id\\b[\\s\\S]{0,180}\\b(?:not|do\\s+not|don'?t|isn'?t|incorrect|wrong)\\b",
    "\\b(?:audience|oidc\\s+audience)\\b[\\s\\S]{0,180}\\bkit\\s+deployment\\s+origin\\b",
  ].join("|"),
  "i",
);
const OPENIAP_IAPKIT_RTDN_PUBLISHER_DIRECTION_PATTERN =
  /\biap\s*kit\b[\s\S]{0,140}\b(?:publish(?:es|ing|ed)?|send(?:s|ing)?|sent)\b[\s\S]{0,140}\b(?:subscription\s+events?|rtdn|events?)\b[\s\S]{0,140}\b(?:pub\/?sub|google\s+cloud\s+pub\/?sub)\b/i;
const OPENIAP_IAPKIT_RTDN_PUBLISHER_CORRECTION_PATTERN = new RegExp(
  [
    "\\b(?:google-play-developer-notifications|google\\s+play|play\\s+console)\\b[\\s\\S]{0,180}\\b(?:roles/pubsub\\.publisher|pub/?sub\\s+publisher|pubsub\\.publisher)\\b",
    "\\b(?:iap\\s*kit|iapkit)\\b[\\s\\S]{0,120}\\b(?:does\\s+not|doesn'?t|isn'?t|not)\\b[\\s\\S]{0,120}\\b(?:publish(?:es|ing|ed)?|send(?:s|ing)?|sent)\\b",
  ].join("|"),
  "i",
);
const OPENIAP_MAUI_CONTEXT_SOURCE =
  "libraries/maui-iap|maui-iap|OpenIap\\.Maui|OpenIAP\\s+MAUI|MAUI\\s+library|NuGet\\s+package";
const OPENIAP_MAUI_UNIMPLEMENTED_SOURCE =
  "empty\\s+scaffold|no\\s+source\\s+files|no\\s+iOS\\s+native\\s+binding|not\\s+(?:yet\\s+)?implemented|does\\s+not\\s+include\\s+source\\s+files";
const OPENIAP_MAUI_EMPTY_SCAFFOLD_PATTERN = new RegExp(
  [
    `\\b(?:${OPENIAP_MAUI_CONTEXT_SOURCE})\\b[\\s\\S]{0,260}\\b(?:${OPENIAP_MAUI_UNIMPLEMENTED_SOURCE})\\b`,
    `\\b(?:${OPENIAP_MAUI_UNIMPLEMENTED_SOURCE})\\b[\\s\\S]{0,260}\\b(?:${OPENIAP_MAUI_CONTEXT_SOURCE})\\b`,
  ].join("|"),
  "i",
);
const OPENIAP_MAUI_SCAFFOLD_CORRECTION_PATTERN = new RegExp(
  [
    `\\b(?:wrong|incorrect|not\\s+true|outdated|previous(?:\\s+answer|\\s+claim)?|earlier\\s+claim)\\b[\\s\\S]{0,260}\\b(?:${OPENIAP_MAUI_CONTEXT_SOURCE}|${OPENIAP_MAUI_UNIMPLEMENTED_SOURCE})\\b`,
    `\\b(?:${OPENIAP_MAUI_CONTEXT_SOURCE})\\b[\\s\\S]{0,260}\\b(?:isn'?t|is\\s+not|wasn'?t|was\\s+not)\\b[\\s\\S]{0,120}\\b(?:empty\\s+scaffold|unimplemented)\\b`,
    `\\b(?:${OPENIAP_MAUI_CONTEXT_SOURCE})\\b[\\s\\S]{0,260}\\b(?:contains|has|includes|ships|references)\\b[\\s\\S]{0,120}\\b(?:source\\s+files|binding|NativeReference|xcframework)\\b`,
  ].join("|"),
  "i",
);
const STOREKIT_COMMITMENT_CONTEXT_PATTERN = new RegExp(
  [
    "\\b(?:storekit|subscription|subscriptions?)\\b[\\s\\S]{0,260}\\b(?:12-month|12\\s+month|commitment|billing\\s+plan|pricing\\s+terms?)\\b",
    "\\b(?:12-month|12\\s+month|commitment|billing\\s+plan|pricing\\s+terms?)\\b[\\s\\S]{0,260}\\b(?:storekit|subscription|subscriptions?)\\b",
  ].join("|"),
  "i",
);
const STOREKIT_COMMITMENT_IOS_164_PATTERN =
  /\b(?:iOS\s*16\.4\+?|iOS\s+16\.4\s+or\s+later)\b/i;
const STOREKIT_COMMITMENT_CORRECTION_SOURCE =
  "do\\s+not|don'?t|does\\s+not|doesn'?t|incorrect|not\\s+true|wrong|requires?\\s+verification|verify";
const STOREKIT_COMMITMENT_CORRECTION_PATTERN = new RegExp(
  [
    `\\b(?:${STOREKIT_COMMITMENT_CORRECTION_SOURCE})\\b[\\s\\S]{0,220}\\b(?:iOS\\s*16\\.4|12-month|commitment|storekit)\\b`,
    `\\b(?:iOS\\s*16\\.4|12-month|commitment|storekit)\\b[\\s\\S]{0,220}\\b(?:${STOREKIT_COMMITMENT_CORRECTION_SOURCE})\\b`,
  ].join("|"),
  "i",
);
const OPENIAP_IN_APP_MESSAGE_CONTEXT_PATTERN =
  /\b(?:openiap|react-native-iap|rn-iap|showInAppMessages(?:Android)?)\b/i;
const OPENIAP_IN_APP_MESSAGE_API_PATTERN = /\bshowInAppMessages(?:Android)?\b/i;
const OPENIAP_IN_APP_MESSAGE_ACTIVITY_VALUE_SOURCE = [
  "\\b(?:activity|currentActivity)\\s*\\??\\s*:\\s*(?:any|unknown|object|(?:Android|Native)?Activity)\\b",
  "\\b(?:activity|currentActivity)\\s+as\\s+(?:any|unknown|object|(?:Android|Native)?Activity)\\b",
  "\\bgetCurrentActivity\\b\\s*(?:\\(\\s*\\))?",
  "\\bNativeModules(?:\\??\\.)?(?:[A-Za-z_$][\\w$]*\\.)?(?:currentActivity|getCurrentActivity)\\b",
].join("|");
const OPENIAP_IN_APP_MESSAGE_ACTIVITY_BRIDGE_PATTERN = new RegExp(
  [
    `\\bshowInAppMessages(?:Android)?\\b[\\s\\S]{0,500}(?:${OPENIAP_IN_APP_MESSAGE_ACTIVITY_VALUE_SOURCE})`,
    `(?:${OPENIAP_IN_APP_MESSAGE_ACTIVITY_VALUE_SOURCE})[\\s\\S]{0,500}\\bshowInAppMessages(?:Android)?\\b`,
    "\\bshowInAppMessages(?:Android)?\\b[\\s\\S]{0,500}\\b(?:pass|provide|supply|expose)\\b[^.!?\\n]{0,100}\\b(?:an?\\s+)?(?:android\\s+|native\\s+)?Activity\\b[^.!?\\n]{0,100}\\b(?:javascript|typescript|react[ -]native)\\b",
    "\\b(?:pass|provide|supply|expose)\\b[^.!?\\n]{0,100}\\b(?:an?\\s+)?(?:android\\s+|native\\s+)?Activity\\b[^.!?\\n]{0,100}\\b(?:javascript|typescript|react[ -]native)\\b[\\s\\S]{0,500}\\bshowInAppMessages(?:Android)?\\b",
  ].join("|"),
  "i",
);
const OPENIAP_IN_APP_MESSAGE_ACTIVITY_CORRECTION_PATTERN = new RegExp(
  [
    `\\b(?:do\\s+not|don'?t|must\\s+not|never|should\\s+not|shouldn'?t)\\b[^.!?\\n]{0,180}(?:(?:${OPENIAP_IN_APP_MESSAGE_ACTIVITY_VALUE_SOURCE})|\\b(?:pass|provide|supply|expose)\\b)`,
    "\\b(?:activity|currentActivity)\\b[^.!?\\n]{0,100}\\b(?:acquir(?:e|ed)|get|obtain(?:ed)?)\\b[^.!?\\n]{0,80}\\b(?:in|inside|from)\\s+(?:the\\s+)?(?:kotlin|native\\s+(?:code|implementation|layer))\\b",
    "\\b(?:kotlin|native\\s+(?:code|implementation|layer))\\b[^.!?\\n]{0,100}\\b(?:acquir(?:e|ed)|get|obtain(?:ed)?)\\b[^.!?\\n]{0,100}\\b(?:activity|currentActivity)\\b",
  ].join("|"),
  "i",
);
const OPENIAP_IN_APP_MESSAGE_VOID_RESULT_SOURCE =
  "Promise\\s*<\\s*(?:void|undefined)\\s*>|(?::|=>)\\s*void\\b";
const OPENIAP_IN_APP_MESSAGE_VOID_RESULT_PATTERN = new RegExp(
  [
    `\\bshowInAppMessages(?:Android)?\\b[\\s\\S]{0,320}(?:${OPENIAP_IN_APP_MESSAGE_VOID_RESULT_SOURCE})`,
    `(?:${OPENIAP_IN_APP_MESSAGE_VOID_RESULT_SOURCE})[\\s\\S]{0,320}\\bshowInAppMessages(?:Android)?\\b`,
  ].join("|"),
  "i",
);
const OPENIAP_IN_APP_MESSAGE_RESULT_CORRECTION_PATTERN = new RegExp(
  [
    `\\b(?:do\\s+not|don'?t|must\\s+not|never|should\\s+not|shouldn'?t|replace|instead\\s+of|rather\\s+than)\\b[^.!?\\n]{0,180}(?:${OPENIAP_IN_APP_MESSAGE_VOID_RESULT_SOURCE})`,
    `(?:${OPENIAP_IN_APP_MESSAGE_VOID_RESULT_SOURCE})[^.!?\\n]{0,180}\\b(?:drops?|los(?:e|es|ing)|must\\s+not|replace|should\\s+not|shouldn'?t|wrong)\\b`,
  ].join("|"),
  "i",
);
const OPENIAP_IN_APP_MESSAGE_UNSUPPORTED_PURPOSE_PATTERN = new RegExp(
  [
    "\\bafter\\s+(?:a\\s+)?successful\\s+purchase\\b[^.!?\\n]{0,180}\\b(?:confirm(?:ing)?\\s+(?:the\\s+)?purchase|purchase\\s+confirmation)\\b",
    "\\bduring\\s+app\\s+launch\\b[^.!?\\n]{0,180}\\b(?:promotional|informational)\\s+messages?\\b",
    "\\b(?:promotional|informational)\\s+messages?\\b[^.!?\\n]{0,180}\\b(?:during|at|on)\\s+app\\s+launch\\b",
  ].join("|"),
  "i",
);
const OPENIAP_IN_APP_MESSAGE_PURPOSE_CORRECTION_PATTERN = new RegExp(
  [
    "\\b(?:cannot\\s+verify|can'?t\\s+verify|do\\s+not|don'?t|incorrect|must\\s+not|should\\s+not|shouldn'?t|unsupported|unverified|wrong)\\b[^.!?\\n]{0,220}\\b(?:after\\s+(?:a\\s+)?successful\\s+purchase|during\\s+app\\s+launch|promotional|informational|purchase\\s+confirmation)\\b",
    "\\b(?:after\\s+(?:a\\s+)?successful\\s+purchase|during\\s+app\\s+launch|promotional|informational|purchase\\s+confirmation)\\b[^.!?\\n]{0,220}\\b(?:cannot\\s+verify|can'?t\\s+verify|incorrect|not\\s+supported|unverified|wrong)\\b",
  ].join("|"),
  "i",
);
const OPENIAP_IN_APP_MESSAGE_LOW_RISK_PATTERN = new RegExp(
  [
    "\\b(?:low[-\\s]?risk|minimal[-\\s]?risk|no[-\\s]?risk|risk[-\\s]?free)\\b[^.!?\\n]{0,120}\\b(?:addition|change|feature|implementation|method)\\b",
    "\\b(?:addition|change|feature|implementation|method)\\b[^.!?\\n]{0,120}\\b(?:low[-\\s]?risk|minimal[-\\s]?risk|no[-\\s]?risk|risk[-\\s]?free)\\b",
  ].join("|"),
  "i",
);
const OPENIAP_IN_APP_MESSAGE_LOW_RISK_CORRECTION_PATTERN = new RegExp(
  [
    "\\b(?:cannot|can'?t|do\\s+not|don'?t|must\\s+not|should\\s+not|shouldn'?t)\\b[^.!?\\n]{0,160}\\b(?:call|claim|consider|describe|label|treat)\\b[^.!?\\n]{0,100}\\b(?:low[-\\s]?risk|minimal[-\\s]?risk|no[-\\s]?risk|risk[-\\s]?free)\\b",
    "\\b(?:low[-\\s]?risk|minimal[-\\s]?risk|no[-\\s]?risk|risk[-\\s]?free)\\b[^.!?\\n]{0,160}\\b(?:cannot\\s+be\\s+(?:assumed|concluded|verified)|needs?\\s+(?:maintainer|repository)\\s+(?:evidence|review)|unverified)\\b",
  ].join("|"),
  "i",
);

const FEATURE_REQUEST_ISSUE_TITLE_PATTERN = new RegExp(
  [
    "^\\s*\\[(?:feature(?:\\s+request)?|fr)\\]",
    "^\\s*(?:feat|feature)(?:\\([^\\n)]*\\))?!?\\s*:",
    "^\\s*feature\\s+(?:request|proposal)\\b",
    "^\\s*(?:add|implement|introduce|expose)\\b",
    "^\\s*(?:missing\\s+)?support\\s+for\\b",
  ].join("|"),
  "i",
);
const FEATURE_REQUEST_ISSUE_BODY_PATTERN =
  /\b(?:feature\s+(?:request|proposal)|request(?:ed|ing)?\s+(?:a\s+)?(?:new\s+)?(?:api|feature|integration|support)|describe\s+the\s+(?:feature|solution)\s+(?:you|you'd|you\s+would)\s+(?:like|want))\b/i;
const NEGATED_FEATURE_REQUEST_ISSUE_BODY_PATTERN =
  /\b(?:is\s+not|isn'?t|not)\s+(?:an?\s+)?feature\s+request\b/i;
const ISSUE_FILING_IMPERATIVE_SOURCE = "file|open|create|submit|raise";
const ISSUE_FILING_ACTION_SOURCE =
  "fil(?:e|ing)|open(?:ing)?|creat(?:e|ing)|submit(?:ting)?|rais(?:e|ing)";
const ISSUE_FILING_TARGET_SOURCE =
  "(?:github\\s+)?(?:issues?|feature\\s+requests?)";
const REDUNDANT_FEATURE_REQUEST_FILING_PATTERN = new RegExp(
  [
    `^\\s*(?:(?:next\\s+steps?|recommendation)\\s*:\\s*)?(?:please\\s+)?(?:${ISSUE_FILING_IMPERATIVE_SOURCE})\\b[^.!?\\n]{0,100}\\b(?:${ISSUE_FILING_TARGET_SOURCE})\\b`,
    `\\b(?:can|consider|could|may|must|need\\s+to|recommend|should|suggest|try\\s+to)\\b[^.!?\\n]{0,100}\\b(?:${ISSUE_FILING_ACTION_SOURCE})\\b[^.!?\\n]{0,100}\\b(?:${ISSUE_FILING_TARGET_SOURCE})\\b`,
    `\\b(?:please|so|then)\\s+(?:${ISSUE_FILING_IMPERATIVE_SOURCE})\\b[^.!?\\n]{0,100}\\b(?:${ISSUE_FILING_TARGET_SOURCE})\\b`,
  ].join("|"),
  "i",
);
const REDUNDANT_FEATURE_REQUEST_FILING_CORRECTION_PATTERN = new RegExp(
  [
    `\\b(?:do\\s+not|don'?t|must\\s+not|need\\s+not|no\\s+need\\s+to|should\\s+not|shouldn'?t)\\b[^.!?\\n]{0,80}\\b(?:${ISSUE_FILING_ACTION_SOURCE})\\b[^.!?\\n]{0,100}\\b(?:${ISSUE_FILING_TARGET_SOURCE})\\b`,
    `\\b(?:${ISSUE_FILING_ACTION_SOURCE})\\b[^.!?\\n]{0,100}\\b(?:${ISSUE_FILING_TARGET_SOURCE})\\b[^.!?\\n]{0,100}\\b(?:not\\s+necessary|redundant|unnecessary)\\b`,
    `\\b(?:already\\s+(?:filed|opened|created|submitted|raised)|currently\\s+open)\\b[^.!?\\n]{0,140}\\b(?:${ISSUE_FILING_TARGET_SOURCE})\\b`,
  ].join("|"),
  "i",
);
const DISTINCT_ISSUE_FILING_PATTERN =
  /\b(?:different|follow-up|separate|upstream)\s+(?:github\s+)?issue\b/i;
const ISSUE_TEMPLATE_CREATION_PATTERN =
  /\b(?:github\s+)?issue\s+(?:forms?|templates?)\b|\b(?:bug\s+report|feature\s+request)\s+templates?\b/i;

interface HighRiskTechnicalClaimPattern {
  label: string;
  pattern: RegExp | ((unit: string, response: string) => boolean);
  correctionPattern?: RegExp;
}

const HIGH_RISK_TECHNICAL_CLAIM_PATTERNS: HighRiskTechnicalClaimPattern[] = [
  {
    label: "per-request purchase token forwarding",
    pattern: PER_REQUEST_TOKEN_FORWARDING_PATTERN,
    correctionPattern: PER_REQUEST_TOKEN_CORRECTION_PATTERN,
  },
  {
    label: "unsupported IAPKit state literals",
    pattern: (unit: string): boolean =>
      IAPKIT_CONTEXT_PATTERN.test(unit) &&
      UNSUPPORTED_IAPKIT_STATE_LITERAL_PATTERN.test(unit),
  },
  {
    label: "unsupported Flutter SPM registrant guidance",
    pattern: FLUTTER_SPM_REGISTRANT_PATTERN,
    correctionPattern: FLUTTER_SPM_CORRECTION_PATTERN,
  },
  {
    label: "incorrect FlutterFramework version claim",
    pattern: FLUTTER_FRAMEWORK_344_VERSION_PATTERN,
    correctionPattern: FLUTTER_SPM_CORRECTION_PATTERN,
  },
  {
    label: "OpenIAP listener flag reset overclaim",
    pattern: (unit: string): boolean =>
      OPENIAP_LISTENER_CONTEXT_PATTERN.test(unit) &&
      (OPENIAP_LISTENER_RESET_ADVICE_PATTERN.test(unit) ||
        OPENIAP_LISTENER_NEVER_RESET_PATTERN.test(unit)),
    correctionPattern: OPENIAP_LISTENER_CORRECTION_PATTERN,
  },
  {
    label: "IAPKit bindUser pending-acknowledgment overclaim",
    pattern: (unit: string): boolean =>
      OPENIAP_IAPKIT_BIND_CONTEXT_PATTERN.test(unit) &&
      OPENIAP_IAPKIT_BIND_PENDING_ACK_PATTERN.test(unit),
    correctionPattern: OPENIAP_IAPKIT_BIND_CORRECTION_PATTERN,
  },
  {
    label: "IAPKit RTDN monorepo code absence overclaim",
    pattern: (unit: string): boolean =>
      IAPKIT_CONTEXT_PATTERN.test(unit) &&
      OPENIAP_IAPKIT_RTDN_CONTEXT_PATTERN.test(unit) &&
      OPENIAP_IAPKIT_RTDN_MONOREPO_ABSENCE_PATTERN.test(unit),
    correctionPattern: OPENIAP_IAPKIT_RTDN_MONOREPO_CORRECTION_PATTERN,
  },
  {
    label: "IAPKit RTDN webhook endpoint missing API key",
    pattern: (unit: string): boolean =>
      IAPKIT_CONTEXT_PATTERN.test(unit) &&
      OPENIAP_IAPKIT_RTDN_CONTEXT_PATTERN.test(unit) &&
      OPENIAP_IAPKIT_RTDN_ENDPOINT_MISSING_API_KEY_PATTERN.test(unit),
    correctionPattern: OPENIAP_IAPKIT_RTDN_ENDPOINT_CORRECTION_PATTERN,
  },
  {
    label: "IAPKit RTDN audience project id overclaim",
    pattern: (unit: string): boolean =>
      IAPKIT_CONTEXT_PATTERN.test(unit) &&
      OPENIAP_IAPKIT_RTDN_CONTEXT_PATTERN.test(unit) &&
      OPENIAP_IAPKIT_RTDN_AUDIENCE_PROJECT_ID_PATTERN.test(unit),
    correctionPattern: OPENIAP_IAPKIT_RTDN_AUDIENCE_CORRECTION_PATTERN,
  },
  {
    label: "IAPKit RTDN publisher role direction overclaim",
    pattern: (unit: string): boolean =>
      IAPKIT_CONTEXT_PATTERN.test(unit) &&
      OPENIAP_IAPKIT_RTDN_CONTEXT_PATTERN.test(unit) &&
      OPENIAP_IAPKIT_RTDN_PUBLISHER_DIRECTION_PATTERN.test(unit),
    correctionPattern: OPENIAP_IAPKIT_RTDN_PUBLISHER_CORRECTION_PATTERN,
  },
  {
    label: "OpenIAP MAUI empty scaffold overclaim",
    pattern: OPENIAP_MAUI_EMPTY_SCAFFOLD_PATTERN,
    correctionPattern: OPENIAP_MAUI_SCAFFOLD_CORRECTION_PATTERN,
  },
  {
    label: "unsupported StoreKit commitment availability claim",
    pattern: (unit: string): boolean =>
      STOREKIT_COMMITMENT_CONTEXT_PATTERN.test(unit) &&
      STOREKIT_COMMITMENT_IOS_164_PATTERN.test(unit),
    correctionPattern: STOREKIT_COMMITMENT_CORRECTION_PATTERN,
  },
  {
    label: "OpenIAP in-app message native Activity bridge suggestion",
    pattern: (unit: string): boolean =>
      OPENIAP_IN_APP_MESSAGE_CONTEXT_PATTERN.test(unit) &&
      OPENIAP_IN_APP_MESSAGE_ACTIVITY_BRIDGE_PATTERN.test(unit),
    correctionPattern: OPENIAP_IN_APP_MESSAGE_ACTIVITY_CORRECTION_PATTERN,
  },
  {
    label: "OpenIAP in-app message result loss",
    pattern: (unit: string): boolean =>
      OPENIAP_IN_APP_MESSAGE_CONTEXT_PATTERN.test(unit) &&
      OPENIAP_IN_APP_MESSAGE_VOID_RESULT_PATTERN.test(unit),
    correctionPattern: OPENIAP_IN_APP_MESSAGE_RESULT_CORRECTION_PATTERN,
  },
  {
    label: "OpenIAP in-app message unsupported purpose or timing",
    pattern: (unit: string, response: string): boolean =>
      OPENIAP_IN_APP_MESSAGE_API_PATTERN.test(response) &&
      splitIntoReviewSentences(unit).some(
        (sentence) =>
          OPENIAP_IN_APP_MESSAGE_UNSUPPORTED_PURPOSE_PATTERN.test(sentence) &&
          !OPENIAP_IN_APP_MESSAGE_PURPOSE_CORRECTION_PATTERN.test(sentence),
      ),
  },
  {
    label: "OpenIAP in-app message unsupported low-risk claim",
    pattern: (unit: string, response: string): boolean =>
      OPENIAP_IN_APP_MESSAGE_API_PATTERN.test(response) &&
      splitIntoReviewSentences(unit).some(
        (sentence) =>
          OPENIAP_IN_APP_MESSAGE_LOW_RISK_PATTERN.test(sentence) &&
          !OPENIAP_IN_APP_MESSAGE_LOW_RISK_CORRECTION_PATTERN.test(sentence),
      ),
  },
];

function matchesHighRiskTechnicalClaim(
  unit: string,
  response: string,
  { pattern, correctionPattern }: HighRiskTechnicalClaimPattern,
): boolean {
  const matches =
    typeof pattern === "function"
      ? pattern(unit, response)
      : pattern.test(unit);
  const isCorrection =
    correctionPattern !== undefined && correctionPattern.test(unit);

  return matches && !isCorrection;
}

function detectHighRiskTechnicalClaimPatterns(response: string): string[] {
  const matches: string[] = [];

  for (const unit of splitIntoReviewUnits(response)) {
    for (const pattern of HIGH_RISK_TECHNICAL_CLAIM_PATTERNS) {
      if (
        matches.includes(pattern.label) ||
        !matchesHighRiskTechnicalClaim(unit, response, pattern)
      ) {
        continue;
      }

      matches.push(pattern.label);
    }
  }

  return matches;
}

export interface ResponseValidationResult {
  isValid: boolean;
  issues: string[];
  leakedFields: string[];
  leakedInternalPaths: string[];
  contextLossPhrases: string[];
  speculationPatterns: string[];
  externalOverclaimPatterns: string[];
  suspiciousCodePatterns: string[];
  highRiskTechnicalClaimPatterns: string[];
  topicDriftPatterns: string[];
  issueContextPatterns: string[];
}

export interface ResponseValidationContext {
  issueTitle?: string;
  issueBody?: string;
  /**
   * Narrow text used only for topic-drift detection. The original issue title
   * and body remain available for issue-context rules such as detecting an
   * already-filed feature request.
   */
  topicFocus?: string;
  issueType?: string;
  skipTopicDrift?: boolean;
}

function truncateIssuePreview(value: string): string {
  return value.length > MAX_ISSUE_PREVIEW_CHARS
    ? `${value.substring(0, MAX_ISSUE_PREVIEW_CHARS)}...`
    : value;
}

function splitIntoReviewUnits(response: string): string[] {
  return response
    .split(/\n\s*\n/)
    .map((unit) => unit.trim())
    .filter(Boolean);
}

function splitIntoReviewSentences(response: string): string[] {
  return splitIntoReviewUnits(response)
    .flatMap((unit) => unit.split(/(?<=[.!?])\s+|\n+/))
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function detectIssueContextPatterns(
  response: string,
  context: ResponseValidationContext | undefined,
): string[] {
  if (!context) {
    return [];
  }

  const issueTitle = context.issueTitle ?? "";
  const issueBody = context.issueBody ?? "";
  const bodyIdentifiesFeatureRequest =
    FEATURE_REQUEST_ISSUE_BODY_PATTERN.test(issueBody) &&
    !NEGATED_FEATURE_REQUEST_ISSUE_BODY_PATTERN.test(issueBody);

  if (
    !FEATURE_REQUEST_ISSUE_TITLE_PATTERN.test(issueTitle) &&
    !bodyIdentifiesFeatureRequest
  ) {
    return [];
  }

  const hasRedundantFilingAdvice = splitIntoReviewSentences(response).some(
    (sentence) =>
      REDUNDANT_FEATURE_REQUEST_FILING_PATTERN.test(sentence) &&
      !REDUNDANT_FEATURE_REQUEST_FILING_CORRECTION_PATTERN.test(sentence) &&
      !DISTINCT_ISSUE_FILING_PATTERN.test(sentence) &&
      !ISSUE_TEMPLATE_CREATION_PATTERN.test(sentence),
  );

  return hasRedundantFilingAdvice
    ? ["redundant issue-filing advice for an existing feature request"]
    : [];
}

function addTopicIdentifier(
  identifiers: string[],
  seen: Set<string>,
  rawIdentifier: string,
): void {
  const identifier = rawIdentifier
    .trim()
    .replace(/^[`"'.]+|[`"',;:.]+$/g, "")
    .replace(/\(\)$/g, "");
  const normalized = identifier.toLowerCase();

  if (
    identifier.length < 4 ||
    GENERIC_TOPIC_IDENTIFIERS.has(normalized) ||
    seen.has(normalized)
  ) {
    return;
  }

  identifiers.push(identifier);
  seen.add(normalized);
}

function extractTopicIdentifiersFromText(text: string): string[] {
  const identifiers: string[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(/`([^`]{1,120})`/g)) {
    const codeSpan = match[1];
    for (const dottedIdentifier of codeSpan.matchAll(
      /\b[A-Za-z_$][\w$]*(?:\(\))?(?:\.[A-Za-z_$][\w$]*(?:\(\))?)+/g,
    )) {
      addTopicIdentifier(
        identifiers,
        seen,
        dottedIdentifier[0].replace(/\(\)/g, ""),
      );
    }
    for (const codeIdentifier of codeSpan.matchAll(
      /\b[A-Za-z_$][\w$]*(?:\(\))?\b/g,
    )) {
      addTopicIdentifier(identifiers, seen, codeIdentifier[0]);
    }
  }

  for (const match of text.matchAll(
    /\b([A-Za-z_$][\w$]*(?:\(\))?(?:\.[A-Za-z_$][\w$]*(?:\(\))?)+)/g,
  )) {
    addTopicIdentifier(identifiers, seen, match[1].replace(/\(\)/g, ""));
  }

  for (const match of text.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    addTopicIdentifier(identifiers, seen, match[1]);
  }

  for (const match of text.matchAll(
    /\b([A-Za-z_$]*[a-z][A-Za-z_$]*[A-Z][\w$]*)\b/g,
  )) {
    addTopicIdentifier(identifiers, seen, match[1]);
  }

  for (const match of text.matchAll(/\b([A-Z][a-z]+[A-Z][\w$]*)\b/g)) {
    addTopicIdentifier(identifiers, seen, match[1]);
  }

  for (const match of text.matchAll(/["'`]([a-z]+(?:-[a-z]+)+)["'`]/g)) {
    addTopicIdentifier(identifiers, seen, match[1]);
  }

  return identifiers;
}

function extractPrimaryTopicIdentifiersFromText(text: string): string[] {
  const identifiers: string[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(/`([^`]{1,120})`/g)) {
    const codeSpan = match[1];
    let foundDottedIdentifier = false;

    for (const dottedIdentifier of codeSpan.matchAll(
      /\b[A-Za-z_$][\w$]*(?:\(\))?(?:\.[A-Za-z_$][\w$]*(?:\(\))?)+/g,
    )) {
      foundDottedIdentifier = true;
      addTopicIdentifier(
        identifiers,
        seen,
        dottedIdentifier[0].replace(/\(\)/g, ""),
      );
    }

    if (!foundDottedIdentifier) {
      for (const codeIdentifier of codeSpan.matchAll(
        /\b[A-Za-z_$][\w$]*(?:\(\))?\b/g,
      )) {
        addTopicIdentifier(identifiers, seen, codeIdentifier[0]);
      }
    }
  }

  for (const match of text.matchAll(
    /\b([A-Za-z_$][\w$]*(?:\(\))?(?:\.[A-Za-z_$][\w$]*(?:\(\))?)+)/g,
  )) {
    addTopicIdentifier(identifiers, seen, match[1].replace(/\(\)/g, ""));
  }

  for (const match of text.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    addTopicIdentifier(identifiers, seen, match[1]);
  }

  return identifiers;
}

function extractIssueTopicIdentifiers(
  context: ResponseValidationContext,
): string[] {
  if (context.topicFocus !== undefined) {
    const focusedPrimaryIdentifiers = extractPrimaryTopicIdentifiersFromText(
      context.topicFocus,
    );
    if (focusedPrimaryIdentifiers.length > 0) {
      return focusedPrimaryIdentifiers.slice(0, MAX_TOPIC_IDENTIFIERS);
    }

    return extractTopicIdentifiersFromText(context.topicFocus).slice(
      0,
      MAX_TOPIC_IDENTIFIERS,
    );
  }

  const titlePrimaryIdentifiers = extractPrimaryTopicIdentifiersFromText(
    context.issueTitle ?? "",
  );

  if (titlePrimaryIdentifiers.length > 0) {
    return titlePrimaryIdentifiers.slice(0, MAX_TOPIC_IDENTIFIERS);
  }

  const titleIdentifiers = extractTopicIdentifiersFromText(
    context.issueTitle ?? "",
  );
  if (titleIdentifiers.length > 0) {
    return titleIdentifiers.slice(0, MAX_TOPIC_IDENTIFIERS);
  }

  const bodyPrimaryIdentifiers = extractPrimaryTopicIdentifiersFromText(
    context.issueBody ?? "",
  );
  if (bodyPrimaryIdentifiers.length > 0) {
    return bodyPrimaryIdentifiers.slice(0, MAX_TOPIC_IDENTIFIERS);
  }

  return extractTopicIdentifiersFromText(context.issueBody ?? "").slice(
    0,
    MAX_TOPIC_IDENTIFIERS,
  );
}

function detectTopicDriftPatterns(
  response: string,
  confidence: number | undefined,
  context: ResponseValidationContext | undefined,
): string[] {
  if (
    !context ||
    context.skipTopicDrift === true ||
    confidence === undefined ||
    context.issueType === "needs_more_info" ||
    confidence < TOPIC_DRIFT_CONFIDENCE_THRESHOLD
  ) {
    return [];
  }

  const identifiers = extractIssueTopicIdentifiers(context);
  if (identifiers.length === 0) {
    return [];
  }

  const hasTopicIdentifier = identifiers.some((identifier) =>
    new RegExp(
      `(^|[^A-Za-z0-9_$-])${escapeRegexTerm(identifier)}($|[^A-Za-z0-9_$-])`,
      "i",
    ).test(response),
  );

  if (hasTopicIdentifier) {
    return [];
  }

  return [`Missing issue topic identifier: ${identifiers.join(", ")}`];
}

function containsExternalDependencyTerm(unit: string): boolean {
  return EXTERNAL_DEPENDENCY_TERM_PATTERN.test(unit);
}

function getLocalClaimContext(unit: string, match: RegExpExecArray): string {
  const start = Math.max(0, match.index - LOCAL_CLAIM_CONTEXT_CHARS);
  const end = Math.min(
    unit.length,
    match.index + match[0].length + LOCAL_CLAIM_CONTEXT_CHARS,
  );

  return unit.slice(start, end);
}

function hasUnscopedExternalOverclaim(unit: string): boolean {
  if (!containsExternalDependencyTerm(unit)) {
    return false;
  }

  for (const pattern of UNIVERSAL_EXTERNAL_CLAIM_PATTERNS) {
    pattern.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(unit)) !== null) {
      const localContext = getLocalClaimContext(unit, match);

      if (
        CORRECTION_OR_META_PATTERN.test(localContext) ||
        REPOSITORY_SCOPED_PATTERN.test(localContext)
      ) {
        continue;
      }

      return true;
    }
  }

  return false;
}

function detectExternalOverclaimPatterns(response: string): string[] {
  const matches: string[] = [];

  for (const unit of splitIntoReviewUnits(response)) {
    if (hasUnscopedExternalOverclaim(unit)) {
      matches.push(unit);
    }
  }

  return matches;
}

/**
 * Validates an AI response for common issues
 */
export function validateAiResponse(
  response: string,
  confidence?: number,
  context?: ResponseValidationContext,
): ResponseValidationResult {
  const issues: string[] = [];
  const leakedFields: string[] = [];
  const leakedInternalPaths: string[] = [];
  const contextLossPhrases: string[] = [];
  const speculationPatterns: string[] = [];
  const externalOverclaimPatterns: string[] = [];
  const suspiciousCodePatterns: string[] = [];
  const highRiskTechnicalClaimPatterns: string[] = [];
  const topicDriftPatterns: string[] = [];
  const issueContextPatterns: string[] = [];

  // Check for internal field name leakage
  for (const fieldName of INTERNAL_FIELD_NAMES) {
    // Word boundary check to avoid false positives
    const regex = new RegExp(`\\b${fieldName}\\b`, "i");
    if (regex.test(response)) {
      leakedFields.push(fieldName);
    }
  }

  if (leakedFields.length > 0) {
    issues.push(`Internal field names leaked: ${leakedFields.join(", ")}`);
  }

  // Check for internal file path references (e.g., .claude/guides/*, AGENTS.md)
  for (const pattern of INTERNAL_PATH_PATTERNS) {
    const match = response.match(pattern);
    if (match) {
      leakedInternalPaths.push(match[0]);
    }
  }

  if (leakedInternalPaths.length > 0) {
    issues.push(
      `Internal file paths leaked: ${leakedInternalPaths.join(", ")}`,
    );
  }

  // Check for context loss indicators
  const lowerResponse = response.toLowerCase();
  for (const phrase of CONTEXT_LOSS_PHRASES) {
    if (lowerResponse.includes(phrase.toLowerCase())) {
      contextLossPhrases.push(phrase);
    }
  }

  if (contextLossPhrases.length > 0) {
    issues.push(`Context loss detected: "${contextLossPhrases[0]}"`);
  }

  // Check for speculation patterns
  for (const pattern of SPECULATION_PATTERNS) {
    if (lowerResponse.includes(pattern.toLowerCase())) {
      speculationPatterns.push(pattern);
    }
  }

  if (speculationPatterns.length > 0) {
    // Speculation with low confidence is an error; otherwise it's a warning
    if (
      confidence !== undefined &&
      confidence < SPECULATION_CONFIDENCE_THRESHOLD
    ) {
      issues.push(
        `Low-confidence response contains speculation: "${speculationPatterns[0]}"`,
      );
    } else {
      // Log as warning but don't block
      console.warn(
        `[Response Validation] Speculation detected (${speculationPatterns.length} patterns)`,
      );
    }
  }

  externalOverclaimPatterns.push(...detectExternalOverclaimPatterns(response));

  if (externalOverclaimPatterns.length > 0) {
    const preview = truncateIssuePreview(externalOverclaimPatterns[0]);
    issues.push(`High-risk external dependency overclaim: "${preview}"`);
  }

  for (const {
    label,
    pattern,
    correctionPattern,
  } of SUSPICIOUS_CODE_PATTERNS) {
    if (pattern.test(response) && !correctionPattern.test(response)) {
      suspiciousCodePatterns.push(label);
    }
  }

  if (suspiciousCodePatterns.length > 0) {
    issues.push(`Suspicious code pattern: "${suspiciousCodePatterns[0]}"`);
  }

  highRiskTechnicalClaimPatterns.push(
    ...detectHighRiskTechnicalClaimPatterns(response),
  );

  if (highRiskTechnicalClaimPatterns.length > 0) {
    issues.push(
      `High-risk technical claim: ${highRiskTechnicalClaimPatterns.join(", ")}`,
    );
  }

  topicDriftPatterns.push(
    ...detectTopicDriftPatterns(response, confidence, context),
  );

  if (topicDriftPatterns.length > 0) {
    issues.push(`Issue topic drift: ${topicDriftPatterns[0]}`);
  }

  issueContextPatterns.push(...detectIssueContextPatterns(response, context));

  if (issueContextPatterns.length > 0) {
    issues.push(`Issue context mismatch: ${issueContextPatterns[0]}`);
  }

  // Check for empty or too short response
  if (!response || response.trim().length < 10) {
    issues.push("Response is empty or too short");
  }

  return {
    isValid: issues.length === 0,
    issues,
    leakedFields,
    leakedInternalPaths,
    contextLossPhrases,
    speculationPatterns,
    externalOverclaimPatterns,
    suspiciousCodePatterns,
    highRiskTechnicalClaimPatterns,
    topicDriftPatterns,
    issueContextPatterns,
  };
}

/**
 * Logs validation warning without blocking
 * Used for monitoring purposes
 */
export function logValidationWarning(
  context: string,
  validation: ResponseValidationResult,
): void {
  if (!validation.isValid || validation.speculationPatterns.length > 0) {
    console.warn(`[Response Validation] ${context}:`, {
      issueCount: validation.issues.length,
      leakedFieldCount: validation.leakedFields.length,
      leakedInternalPathCount: validation.leakedInternalPaths.length,
      contextLossCount: validation.contextLossPhrases.length,
      speculationCount: validation.speculationPatterns.length,
      externalOverclaimCount: validation.externalOverclaimPatterns.length,
      suspiciousCodeCount: validation.suspiciousCodePatterns.length,
      highRiskTechnicalClaimCount:
        validation.highRiskTechnicalClaimPatterns.length,
      topicDriftCount: validation.topicDriftPatterns.length,
      issueContextMismatchCount: validation.issueContextPatterns.length,
    });
  }
}
