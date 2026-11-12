# AI Models & Pricing

Gitdog uses Claude for issue, discussion and pull request generation, OpenAI as
the credit fallback, and OpenAI embeddings with keyword retrieval for
repository search. All model calls run on the server (Convex); the web app and
CLI never hold provider keys.

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

## Authentication

- OpenAI uses a restricted API key per environment (`OPENAI_API_KEY`).
- Claude supports `ANTHROPIC_AUTH_MODE=api-key` (default) or `federation`.
  Federation signs a short-lived workload assertion inside Convex and exchanges
  it with Anthropic, so no static Anthropic key is stored. See
  [Anthropic workload identity federation](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation).

Configure distinct credentials per environment; see `.env.example` for the
variable names.

## Repository retrieval

Repository indexing, code queries and repository learnings use OpenAI
`text-embedding-3-small` (1536 dimensions) together with keyword search.

- First connection indexes the repository; default-branch pushes trigger
  incremental indexing, and a daily sync refreshes active repositories.
- Vector batches are cached by content and provider/model identity, so
  unchanged content is reused after reindexing.
- Searches filter by exact provider/model keys, so vectors from different
  models are never mixed. Without OpenAI access or quota, Gitdog falls back to
  keyword search instead of sending data to another provider.

## Token pricing

| Model                         | Input per 1M tokens | Output per 1M tokens |
| ----------------------------- | ------------------- | -------------------- |
| Claude Sonnet 5.5             | $2.00               | $10.00               |
| GPT-6.1 Sol                   | $2.00               | $10.00               |
| OpenAI text-embedding-3-small | $0.02               | —                    |

Sol prompts above 272K input tokens use 2x input and 1.5x output pricing.
Prompt caching is disabled, so recorded token counts map directly to the listed
uncached prices. Thinking tokens are included in the provider's output usage.
See [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing)
and [Sol pricing](https://developers.openai.com/api/docs/models/gpt-6.1-sol).

## Plans and token packs

Free and Pro both stop when their included and purchased balance is exhausted.
Gitdog never creates automatic overage charges; prepaid token packs extend the
limit and never expire.

| Tier               | Included or prepaid tokens | Notes                        |
| ------------------ | -------------------------- | ---------------------------- |
| Free               | 100K per month             | Stops at the available limit |
| Pro                | 2.4M per month             | Stops at the available limit |
| Token Pack (Small) | 2.2M                       | $9.99 one-time purchase      |
| Token Pack (Large) | 7.5M                       | $29.99 one-time purchase     |

## Usage accounting

Token usage is recorded per request from the provider's own usage report:

- Input includes the reported prompt and tool-use prompt tokens.
- Output is the remaining provider-reported total.
- The actual provider and model are stored with every usage record.
- Usage consumes included tokens first, then the prepaid balance.

## Configuration

Model and pricing constants live in
[`convex/_ai/config.ts`](../convex/_ai/config.ts).
