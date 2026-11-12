# AI Models & Pricing

Gitdog uses Claude for issue, discussion and pull request generation and
OpenAI as the credit fallback. Repository search is keyword-based; Gitdog does
not create embeddings. All model calls run on the server (Convex); the web app
and CLI never hold provider keys.

## Generation routing

- Primary: **Claude Sonnet 5.5** (`claude-sonnet-5-5`).
- Fallback: **GPT-6.1 Sol** (`gpt-6.1-sol`) through the OpenAI Responses API.
- Claude is used strictly before **2027-01-18 00:00 Asia/Seoul**
  (`2027-01-17T15:00:00Z`); after that, new requests go to OpenAI.
- Only confirmed credit exhaustion or a provider spending limit selects OpenAI.
  Rate limits, invalid credentials, content rejection and ambiguous network
  failures do not silently switch providers.
- Each logical call holds one durable usage reservation, and a billed result
  is checkpointed so it is never charged twice across retries or a provider
  switch.
- `AI_GENERATION_ROUTE=claude-openai` is the only supported route.

## Your own provider keys

Users can add their own Anthropic and/or OpenAI API key under **Profile → Your
AI provider keys**. Generation for repositories they own (issue and discussion
replies, follow-ups, pull request reviews and learning extraction) then runs on
those keys instead of Gitdog's:

- Claude runs on the user's Anthropic key and is not affected by Gitdog's
  Claude deadline. The user's OpenAI key is used if only it is saved, if the
  Anthropic key is rejected, or if Claude reports exhausted credit.
- A key reported out of credit is skipped for an hour, or until the user
  checks it again in settings.
- A failing user key never falls back to Gitdog's keys. The request fails with
  an actionable message, and the key is marked as rejected or out of credit.
- An action that started on a user key cannot be finished on Gitdog's key.
- This usage is recorded with `keySource: "user"`. It does not consume
  included or prepaid tokens and is shown separately on the Usage page.
- Key checks are limited to five per user every ten minutes.
- Keys are validated against the generation model on save, encrypted with
  AES-256-GCM using `BYOK_ENCRYPTION_KEY`, and never returned to clients.

## Authentication

- OpenAI uses a restricted API key per environment (`OPENAI_API_KEY`).
- Claude supports `ANTHROPIC_AUTH_MODE=api-key` (default) or `federation`.
  Federation signs a short-lived workload assertion inside Convex and exchanges
  it with Anthropic, so no static Anthropic key is stored. See
  [Anthropic workload identity federation](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation).

Configure distinct credentials per environment; see `.env.example` for the
variable names.

## Repository retrieval

Repository indexing parses files into function and class chunks for BM25
keyword search, ranked by path, symbol and documentation matches. During
generation the model also searches code by exact pattern, lists directories
and reads files with its repository tools. No embedding provider is called, so
indexing costs no AI tokens.

- First connection indexes the repository; default-branch pushes trigger
  incremental indexing, and a daily sync refreshes active repositories.
- Repository learnings are stored and searched by keyword.
- Vectors stored before embeddings were retired are no longer read. Reclaim
  their storage once per deployment with
  `bunx convex run ragV2/internalMutation:purgeRetiredEmbeddings '{"confirm":"delete-retired-embeddings"}'`.

## Token pricing

| Model             | Input per 1M tokens | Output per 1M tokens |
| ----------------- | ------------------- | -------------------- |
| Claude Sonnet 5.5 | $2.00               | $10.00               |
| GPT-6.1 Sol       | $2.00               | $10.00               |

Sol prompts above 272K input tokens use 2x input and 1.5x output pricing.
Prompt caching is disabled, so recorded token counts map directly to the listed
uncached prices. Thinking tokens are included in the provider's output usage.
See [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing)
and [Sol pricing](https://developers.openai.com/api/docs/models/gpt-6.1-sol).

## Plans and token packs

Try Gitdog with trial tokens, then use your own API key or Pro. Free and Pro
both stop when their included and prepaid balance is exhausted. Gitdog never
creates automatic overage charges; prepaid token packs extend the limit and
never expire. Work that runs on your own provider key never uses these tokens.

| Tier               | Included or prepaid tokens | Notes                                      |
| ------------------ | -------------------------- | ------------------------------------------ |
| Free               | 100K trial, once           | Granted on first sign-in; no monthly reset |
| Pro                | 2.4M per month             | Stops at the available limit               |
| Token Pack (Small) | 2.2M                       | $9.99 one-time purchase                    |
| Token Pack (Large) | 7.5M                       | $29.99 one-time purchase                   |

The trial is added to the prepaid wallet once per account and recorded in
`trialCreditGrants`, so it is never granted again. Free periods that started
before December 2026 keep the former 100K monthly allowance; later free
periods include no tokens.

## Usage accounting

Token usage is recorded per request from the provider's own usage report:

- Input includes the reported prompt and tool-use prompt tokens.
- Output is the remaining provider-reported total.
- The actual provider and model are stored with every usage record.
- Usage consumes included tokens first, then the prepaid balance.

## Configuration

Model and pricing constants live in
[`convex/_ai/config.ts`](../convex/_ai/config.ts).
