# AI Models & Pricing

Gitdog uses Claude for issue and discussion generation, OpenAI for credit
fallback, and OpenAI embeddings with keyword retrieval for repository search.

## Generation routing

- Primary: **Claude Sonnet 5.5** (`claude-sonnet-5-5`), using the selected server authentication mode.
- Fallback: **GPT-6.1 Sol** (`gpt-6.1-sol`) through OpenAI Responses, using
  `OPENAI_API_KEY`. These are server-side Convex variables, never frontend keys.
- Claude is available strictly before **2027-01-18 00:00 Asia/Seoul**
  (`2027-01-17T15:00:00Z`). At and after that instant, new requests go directly
  to OpenAI. The deadline is checked again immediately before Claude dispatch.
- Confirmed credit exhaustion or a provider spending limit selects OpenAI.
  Ordinary rate limits, invalid keys, content rejection, and ambiguous network
  failures do not silently switch providers. Each logical call uses one durable
  reservation and replays a billed checkpoint across provider switches.
- Every new call checks Claude eligibility again, so replenished monthly credits
  are used automatically before the deadline. A missing Claude key selects
  OpenAI; production preflight requires valid authentication configuration for both providers before the deadline.
- `AI_GENERATION_ROUTE=claude-openai` is the only supported route. Any other
  value is rejected.

Use API keys from the organizations receiving the monthly credits. Gitdog does
not create credits, enable auto-recharge, or distinguish promotional credits
from purchased balances. Provider workspace/project spending limits determine
when requests are rejected; the $200 grant is not a separate Gitdog quota.
Never enable provider auto-recharge for this deployment. Gitdog never adds
provider credit or starts a charge when balances run out: exhausted Claude
credit selects OpenAI, and exhausted OpenAI credit stops the work.
OpenAI subscription API credits cover Responses calls; API-key Codex sessions
are excluded from that benefit. See [OpenAI API credits](https://developers.openai.com/api/docs/guides/chatgpt-api-credits)
and [Claude API credits](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers).

## Authentication

OpenAI uses separate restricted API keys for development and production. OpenAI
currently does not support arbitrary OIDC issuers such as Convex directly; see
[OpenAI Federation limitations](https://developers.openai.com/api/reference/workload-identity-federation).

Claude supports `ANTHROPIC_AUTH_MODE=api-key` (default) or `federation`.
Federation signs a fresh five-minute assertion inside Convex with the deployment's
existing Convex Auth signing key. The private key stays in Convex. A dedicated
`/ai/workload/jwks.json` endpoint publishes only RSA public fields with a
thumbprint-derived `kid`; the existing user authentication JWKS stays unchanged.
This removes the static Anthropic API key, while retaining the existing
server signing key as the workload identity's trust root.

Create separate Custom OIDC issuers, service accounts, and rules for each
deployment. Set the issuer to its exact `https://<deployment>.convex.site` origin,
JWKS mode to explicit URL with `/ai/workload/jwks.json`, exact subject to
`gitdog:ai:<deployment>.convex.site`, audience to `https://api.anthropic.com`,
and required claim `workload=gitdog-ai`. Alternatively, register the same
normalized public JWK set with inline keys when bootstrapping before the public
endpoint is deployed; update that inline set whenever the Convex signing key
rotates. Never upload private JWK fields. Prefer `workspace:inference`, a
300-second token lifetime, and the intended workspace membership. Configure
`ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_FEDERATION_RULE_ID`,
`ANTHROPIC_SERVICE_ACCOUNT_ID`, and `ANTHROPIC_WORKSPACE_ID` independently in
each deployment. Never put assertions, cached access tokens, or the Convex
signing key in either local env file. Local env files may hold these non-secret
IDs and the corresponding environment's OpenAI key for testing through Convex.
`ANTHROPIC_FEDERATION_SCOPE` defaults to `workspace:inference`. The current
Console only offers `workspace:developer` and `org:admin`; the operator approved
`workspace:developer` for the Codeyou workspace. Set that exact scope in both
environments. The runtime rejects mismatched scopes and never accepts
`org:admin`. Workspace developer includes other non-admin APIs such as Files
and Skills, so it is broader than inference-only.

Use the internal-only `aiAuth/internalAction:checkClaudeFederation` diagnostic
to verify exchange and Models access inside Convex without copying the signing
key locally, sending user content, or invoking paid inference. The separate
internal-only `aiAuth/internalAction:checkClaudeGeneration` runs one explicit
paid QA call with a fixed prompt, at most 512 output tokens, and no user content
or account quota. It returns only success and provider token counts.

Validate token exchange and inference before removing replaced API credentials.
Federation mode ignores `ANTHROPIC_API_KEY`. Cached tokens and new exchanges
are blocked at the same exclusive Claude deadline. Authentication failures are
non-billed and release reservations; they do not fabricate inference usage.
See [Anthropic Federation](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation).

The current OpenAI project has input/output data sharing enabled by the operator.
Inputs and outputs may therefore be used for OpenAI model improvement and
training. The privacy policy discloses this behavior and requires renewed
acknowledgment before repository automation can resume. `store: false` controls
Responses storage; it does not disable organization/project data sharing.

## Owner test credit

The deployment-admin-only `admin/internalMutation:provisionOwnerTestCredit`
restores the explicitly approved `hyochan` owner and grants one non-cash test
balance: 50,016,672,224 tokens, the rounded-down equivalent of $200,000 at the
existing large-pack list rate (7.5M tokens / $29.99). This is a one-time quota
allowance, not recurring billing or a provider credit purchase. Usage, provider
cost, and Gitdog fees continue to be recorded normally. A fixed operation ID
prevents duplicate credit, refilling spent tokens, or re-granting subsequently
revoked admin privileges on replay. Consent and unresolved-usage checks remain
in force.

## Token pricing

| Model                                    | Input per 1M tokens | Output per 1M tokens |
| ---------------------------------------- | ------------------- | -------------------- |
| Claude Sonnet 5.5                        | $2.00               | $10.00               |
| GPT-6.1 Sol                              | $2.00               | $10.00               |
| Gemini 2.5 Flash (historical usage only) | $0.30               | $2.50                |

Sol prompts above 272K input tokens use 2x input and 1.5x output pricing.
Prompt caching is disabled for these new providers so exact input/output token
counts map to the listed uncached prices. Unexpected cache billing is treated as
unresolved instead of recording an inaccurate amount. Thinking tokens are
included in the provider's output usage; Claude signed thinking blocks are
preserved for subsequent Claude tool turns and omitted from OpenAI requests.
Sonnet uses medium effort with adaptive thinking; Sol uses high reasoning
effort and retains encrypted reasoning items for
stateless tool and truncation continuations, including original assistant
message phases; provider-specific reasoning and phase metadata are omitted from
Claude requests.
See [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing),
[Sol pricing](https://developers.openai.com/api/docs/models/gpt-6.1-sol), and
[OpenAI caching](https://developers.openai.com/api/docs/guides/prompt-caching).

### Repository retrieval and historical Google usage

Repository indexing, code queries, and repository learnings use OpenAI
`text-embedding-3-small` with 1536 dimensions, at $0.02 per million input tokens.
See [the model specification](https://developers.openai.com/api/docs/models/text-embedding-3-small).
All retrieval inputs use the environment's OpenAI API key and the paid usage
ledger, including public repositories. There is no free tier or license-based
routing.

First connection schedules source indexing followed by OpenAI embeddings.
Default-branch push webhooks trigger incremental indexing, and daily sync at
04:00 Asia/Seoul scans active repositories in cursor pages of ten. Busy or revoked
repositories are skipped safely. Successful vector batches are cached by content
and provider/model identity, so unchanged content can reuse them after reindexing.

Gitdog no longer contains a Google provider client. Vectors from the retired
Google provider are never mixed with OpenAI vectors; repository and learning searches
filter exact provider/model keys. Missing OpenAI access or exhausted account quota
preserves keyword search instead of sending data to another embedding provider.

Usage rows and reservations recorded with the retired Google provider stay valid
for accounting and settlement recovery. Unknown
Google spend retains its original ambiguous state and reserves its full token
ceiling against future quota. It no longer serializes Claude/OpenAI requests.
Unknown Claude/OpenAI spend still pauses new generation. An unresolved ended
Pro billing period also continues to require settlement before further paid work;
provider retirement does not settle that financial boundary. Refund and account
lifecycle protections continue to treat all unresolved holds as open.

Reconcile historical requests only from actual provider evidence through
`admin.paymentMutation.reconcileChatUsage` or
`admin.paymentMutation.reconcileEmbeddingUsage`. Retirement does not mean
that an old request was unbilled, and does not create a fake usage record.

### Deployment checklist

Configure distinct OpenAI keys and Anthropic Federation identities per
environment. Keep `AI_GENERATION_ROUTE=claude-openai`; other routes are rejected.
Google credentials are not used and must be removed from Gitdog environments.
The OpenAI keys must permit Models Read, Responses Write and Embeddings Write.
Never enable automatic provider recharges.

Use exact public HTTPS origins for `SITE_URL` and `VITE_CONVEX_URL`, preserve the
pinned settlement fingerprint secret, and deploy through the combined main
workflow. Account holders must acknowledge the current provider disclosure before
automation resumes. Old unresolved Google holds remain visible for later audit.

## Token Limits and Prepaid Packs

Free and Pro both stop when their included and purchased token balance is
exhausted. Gitdog never creates automatic overage charges. Users can extend
their limit with one-time prepaid token packs, and purchased tokens never
expire.

| Tier               | Included or prepaid tokens | Notes                        |
| ------------------ | -------------------------- | ---------------------------- |
| Free               | 100K per month             | Stops at the available limit |
| Pro                | 2.4M per month             | Stops at the available limit |
| Token Pack (Small) | 2.2M                       | $9.99 one-time purchase      |
| Token Pack (Large) | 7.5M                       | $29.99 one-time purchase     |

## Usage Accounting

Token-equivalent usage is calculated per request from the actual provider's usage:

- Generation input includes the provider's reported prompt and tool-use prompt tokens
- Generation output is the remaining provider-reported total after those inputs
- The actual model and provider are recorded with every usage record
- Usage consumes included tokens first and then the prepaid token balance

## Configuration

All AI model and pricing constants are centralized in [`convex/_ai/config.ts`](../convex/_ai/config.ts).
