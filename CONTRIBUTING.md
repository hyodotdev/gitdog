# Contributing to Gitdog

Thank you for your interest in contributing to Gitdog! This document provides guidelines and information about our architecture.

## AI Architecture

Gitdog uses a **Google Gemini AI architecture**:

```text
[Data]
   ↓
[Embedding Model: Gemini]
   ↓ (vector embeddings)
[Vector DB: Convex]
   ↓ (semantic search)
[Generation Model: Gemini 2.5 Flash]
   ↓
[Issue & Discussion Assistance]
```

### Components

#### 1. **Embeddings (Gemini)**

- **Model**: `gemini-embedding-2`
- **Purpose**: Convert code into vectors for semantic search
- **Routing**: Use a separate free-tier Google project only for a locally de-identified code-structure representation of public repositories whose GitHub-recognized SPDX license is confirmed by OSI; use a billing-enabled project for raw repository content and every other Gemini operation
- **Safety**: Private, internal, unlicensed, and unrecognized-license repositories never fall back to the free-tier key
- **Data use**: Raw source, retrieval queries, and repository learnings are never sent through the free tier. Google's free tier may use the de-identified structural input to improve its products; paid-tier inputs are not used for that purpose under the current Gemini API pricing terms
- **Used for**: RAG (Retrieval-Augmented Generation) search when connecting repositories

#### 2. **Vector Database (Convex)**

- **Storage**: Code chunks with embeddings
- **Search**: Hybrid search (Vector + BM25 + RRF + Reranking + MMR)
- **Chunking**: Function/class-level (not file-level)

#### 3. **Issue and Discussion Assistance (Gemini)**

- **Model**: Stable `gemini-2.5-flash`
- **Provider**: Google Gemini paid service
- **Capabilities**: Repository-grounded analysis, formatting, answers, and maintainer tagging
- **Routing**: Generation always uses the billing-enabled paid key; the free key is never used for prompts or responses

## Environment Variables

### Required

```bash
# Disabled by default; see the deployment compliance note below
GEMINI_FREE_TIER_ENABLED=false

# Used only when the free-tier gate is explicitly enabled
GEMINI_FREE_API_KEY=...

# Manual assertion that the paid key's Google Cloud project has billing enabled
GEMINI_PAID_PROJECT_BILLING_ENABLED=true

# For private, internal, unlicensed, or unrecognized-license repositories
# and for every issue or discussion generation request
GEMINI_PAID_API_KEY=...
```

`GEMINI_PAID_API_KEY` is ignored unless
`GEMINI_PAID_PROJECT_BILLING_ENABLED` is exactly `true`. This flag does not
enable billing; verify the key's Google Cloud project manually before setting it
in both development and production. When the free route is enabled, its key must
be different from the paid key.

Gemini API clients made available to users in the EEA, Switzerland, or the UK
must use Paid Services under the current
[Gemini API terms](https://ai.google.dev/gemini-api/terms). Because Gitdog has
no regional access block, the official production workflow is paid-only and
requires `GEMINI_FREE_TIER_ENABLED=false`. An independently operated alternate or
local deployment may set the flag to `true` only after confirming that deployment
is not available to those regions or otherwise satisfies the current terms.
Repository license eligibility is an additional requirement and does not
override this deployment-level gate.

### Direct GitHub requests and legal eligibility

A newly created issue or discussion comment that explicitly mentions
`@gitdogbot` (or `@gitdogbot-dev` in development) runs only when the signed GitHub webhook sender is a
human GitHub user linked through OAuth to exactly one live Gitdog account with
the current legal-eligibility confirmation. The same rule applies when deleting
a Gitdog bot response would create repository learning. Ineligible or ambiguous
requests are intentionally skipped before comment-history reads, durable AI
work, or provider calls, and queued retries recheck eligibility before each AI
provider attempt.

This direct-requester rule does not change repository-owner-configured automatic
issue or discussion automation. Those lifecycle workflows remain governed by
the repository settings and the repository owner's eligibility.

## Gemini RAG Architecture

### Hybrid Search Pipeline

```text
1. Code Parsing
   - Function/class-level chunking
   - 20-line overlap for context
   - Extract: symbols, imports, exports, signatures

2. Embedding Generation (Gemini)
   - Input: symbol + signature + docstring + code
   - Model: gemini-embedding-2
   - Incremental: contentHash deduplication
   - Key routing: free only for locally de-identified structure from public repositories with a GitHub-recognized, OSI-confirmed SPDX license; paid for raw content and all retrieval interactions

3. Hybrid Search
   a. Vector Search (top 200)
      - Cosine similarity
      - Semantic understanding

   b. BM25 Keyword Search (top 200)
      - Exact keyword matching
      - Good for function names

   c. RRF Fusion (top 50)
      - Reciprocal Rank Fusion (k=60)
      - Combines vector + keyword results

   d. Reranking (top 20)
      - Symbol match (weight: 10)
      - Signature match (weight: 5)
      - Code match (weight: 1)

   e. MMR Diversification (final 8)
      - λ=0.7 (relevance vs diversity)
      - Path-based similarity
      - Ensure diverse file coverage

4. Return Results
   - Top 8 most relevant code chunks
   - With line numbers and scores
```

### Why This Architecture?

#### Embeddings Are Essential

- **2x+ better recall** than keyword search alone
- Understands **synonyms** (validate = verify = check)
- Handles **concept search** (error 21002 → receipt validation)
- Works across **languages** (Korean query → English code)

#### Provider Roles

| Service                     | Use Case                                                  |
| --------------------------- | --------------------------------------------------------- |
| **Gemini embeddings**       | RAG indexing and search with repository-aware key routing |
| **Gemini 2.5 Flash (paid)** | All issue and discussion generation tasks                 |

## Development Setup

1. **Install dependencies**

   ```bash
   bun install
   ```

2. **Set environment variables**

   ```bash
   cp .env.example .env
   # Edit .env and add your API keys
   ```

3. **Run Convex**

   ```bash
   bunx convex dev
   ```

4. **Run development server**
   ```bash
   bun run dev
   ```

## Code Style

- Follow existing patterns in the codebase
- Use TypeScript strictly
- Run `bun run typecheck && bun run lint` before committing
- See [CLAUDE.md](./CLAUDE.md) for detailed conventions

## Testing

Before submitting a PR:

```bash
# Type check
bun run typecheck

# Lint
bun run lint

# Build (if applicable)
bun run build
```

## Questions?

- Check [CLAUDE.md](./CLAUDE.md) for project conventions
- Open an issue for bugs or feature requests
- Join our community discussions

## License

This repository is currently marked `UNLICENSED` in `package.json`.
