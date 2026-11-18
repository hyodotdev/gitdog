# AI Models & Pricing

Gitdog uses Claude for issue, discussion and pull request generation and
OpenAI as the credit fallback. Repository search is keyword-based; Gitdog does
not create embeddings. All model calls run on the server (Convex); the web app
and CLI never store provider keys.

## Generation routing

- Primary: **Claude Opus 5.5** (`claude-opus-5-5`) at `medium` effort, with
  Anthropic's server-side refusal fallback.
- Fallback: **GPT-6.2 Sol** (`gpt-6.2-sol`) at `high` reasoning effort through
  the OpenAI Responses API.
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

- Each key runs the model and effort its owner chooses (web settings or
  `gitdog provider-keys model`), checked against the key when chosen and when
  the key is saved again. Anthropic: Claude Opus 5.5 (default, `medium`),
  Sonnet 5.5 (`high`) or Haiku 5.5 (`medium`); OpenAI: GPT-6.1 Sol (default,
  `high`; keys saved before 6.2 were checked against it) or GPT-6.2 Sol
  (`high`).
  Efforts are `low`, `medium` or `high`: requests are not streamed and stop
  after two minutes, so Fable 5.1 and `xhigh`/`max` are not offered. Haiku
  5.5 bills prompts over 100K tokens at 5x and has no server-side refusal
  fallback. A new key without access to the chosen model is saved with the
  default model, and a model no longer offered falls back to the default.
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
- Every saved key must use the same server key. Its id is recorded on the
  first save (or taken from existing keys). A missing `BYOK_ENCRYPTION_KEY`,
  or one with another id, is treated as a server misconfiguration: saved keys
  are paused, saving is refused, and users are not told their keys failed.
- To rotate the server key on purpose, set the new `BYOK_ENCRYPTION_KEY`, then
  record its id:
  `bunx convex run providerApiKeys/internalMutation:setExpectedEncryptionKeyId '{"keyId":"<id>"}'`,
  where the id is the first 16 hex characters of
  `printf %s "$BYOK_ENCRYPTION_KEY" | base64 -d | shasum -a 256`. Keys saved
  under the old server key then become unreadable, and their owners are asked
  to enter them again. There is no decrypt-only previous key.
- Keys are validated against their chosen model on save, encrypted with
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

| Model             | Input per 1M tokens | Output per 1M tokens | Quota weight |
| ----------------- | ------------------- | -------------------- | ------------ |
| Claude Opus 5.5   | $4.00               | $20.00               | 2            |
| GPT-6.2 Sol       | $2.00               | $10.00               | 1            |
| GPT-6.1 Sol       | $2.00               | $10.00               | 1            |
| Claude Sonnet 5.5 | $2.00               | $10.00               | 1 (own keys) |
| Claude Haiku 5.5  | $0.10               | $0.50                | own keys     |

On Gitdog's keys, each provider token counts as its model's quota weight in
Gitdog tokens: an Opus 5.5 call with 30K input and 5K output tokens uses 70K.
Every reservation holds the highest weight a request could be routed to, so a
call that falls back to Sol holds 2x but is charged 1x. A call is charged the
lower of its model's weight and its reservation's, so a reservation made before
weights existed is charged at most 1x. Usage on your own key is billed by the
provider and is never weighted.

Claude requests use prompt caching: the system prompt and tools of every
request, and in a review's main loop the repository context and every source
shown so far, which the loop resends each turn ahead of the turn's own state.
Cached prompt tokens are recorded as the input tokens they cost: a cache write
counts 1.25x and a read 0.05x on Opus 5.5 (0.1x on other Claude models),
rounded up. Quota, cost and reservations therefore need no separate cache
accounting. A reservation holds the request size plus a quarter of its
cacheable prefix (tools, system prompt and any marked part), so that prefix
can be written to the cache in full. Two consequences: a long-context price
tier (Haiku 5.5 above 100K) is chosen from these equivalent tokens rather than
the raw prompt length, which only affects the recorded cost of own-key usage;
and an admin reconciling an ambiguous Claude attempt enters the equivalent
input (`input + 1.25 x cache writes + read rate x cache reads`), not the raw
`input_tokens`.

A request Opus 5.5 declines may be served inside the same call by Anthropic's
refusal fallback model (Claude Opus 5 or Opus 4.8, $5/$25), and later turns
of that conversation go to the fallback model directly for a while. Whenever
the response names another serving model, the usage row keeps
`claude-opus-5-5` and its weight, since the reservation is bound to it, stores
the serving model as `servedModel`, and records its cost at that model's
price.

Sol prompts above 272K input tokens use 2x input and 1.5x output pricing.
OpenAI prompt caching is turned off (explicit mode with no breakpoint), since
its automatic mode writes the whole prompt again whenever its end changes. If
OpenAI still reports cache usage, it is recorded like Claude's: a write at
1.25x and a read at 0.05x on GPT-6.2 Sol (0.1x on 6.1). Thinking tokens are included in the provider's output usage.
See [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing)
and [Sol pricing](https://developers.openai.com/api/docs/models/gpt-6.2-sol).

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
`trialCreditGrants`, so it is never granted again. It is granted on first
sign-in, on consent, or the first time a free account's quota is checked;
accounts on Pro (or with Pro history still being settled) are skipped and get
it once they are on Free, including former Pro owners. Usage spends included
tokens, then the trial, then paid tokens, and a token-pack refund never takes
back trial tokens. Free periods that started
before December 2026 keep the former 100K monthly allowance; later free
periods include no tokens.

## Usage accounting

Token usage is recorded per request from the provider's own usage report:

- Input includes the reported prompt and tool-use prompt tokens.
- Output is the remaining provider-reported total.
- The actual provider and model are stored with every usage record.
- `totalTokens` is the quota amount: provider tokens times the weight charged,
  which is stored as `quotaWeight` when it is not 1. Input and output stay
  raw provider counts, so on Opus rows they add up to half of `totalTokens`.
- Usage consumes included tokens first, then the prepaid balance.

## Configuration

Model and pricing constants live in
[`convex/_ai/config.ts`](../convex/_ai/config.ts).
