# Project Guidelines for Claude

> For more information about CLAUDE.md: <https://docs.anthropic.com/en/docs/claude-code/memory>

**NOTE**: For comprehensive development conventions, see [docs/convention.md](docs/convention.md). For GitHub App setup, see [docs/github-app-setup.md](docs/github-app-setup.md).

## Project Overview

**Gitdog** is an AI-powered GitHub issue and discussion assistant.

- Repository-aware issue and discussion formatting, answers, and maintainer tagging
- Claude Sonnet 5.5 generation with GPT-6.1 Sol fallback (see [docs/ai-models.md](docs/ai-models.md))
- OpenAI embeddings for repository indexing and hybrid code search
- Private workspace per user
- Free and Pro token quotas with optional prepaid token packs
- GitHub App integration for repository access and webhook-driven synchronization
- Lemon Squeezy subscription and token-pack settlement
- Built with: React, TypeScript, Convex, Tailwind CSS, Lemon Squeezy

## Repository Layout

- Web app and Convex backend at the root; the `gitdog` npm CLI in `packages/cli` (bun workspace)
- After changing public Convex functions, run `bun run check:api` (regenerate with `bun packages/cli/scripts/sync-api.mjs`)
- CLI changes: `bun run typecheck:cli && bun run test:cli`

## Package Manager

- Use `bun` instead of `npm` for all package management
- Run `bun add` instead of `npm install`
- Run `bun run` instead of `npm run`

## Git Commits & Pull Requests

- **NEVER** add Claude co-author to commits
- **NEVER** commit without explicit user confirmation
- **ALWAYS** ask "이제 커밋할까요?" or similar before committing
- Always ask before committing or wait for user instruction
- User must explicitly say "commit", "ㅇㅇ", "응", or similar instruction before creating any commits
- Use lowercase after prefix (e.g., `feat: add` not `feat: Add`)
- PR titles must follow the same convention: lowercase after prefix
  - ✅ `fix: lemon squeezy webhook integration`
  - ❌ `Fix: Lemon Squeezy webhook integration`
- **ALL commit messages, PR titles, and PR descriptions must be written in English**
  - Commit messages: English only
  - PR title: English only
  - PR body/description: English only
  - Code comments: English only

## Code Style

- Follow existing code conventions in the project
- Maintain consistency with surrounding code
- Use TypeScript strictly with proper types
- No unnecessary comments unless requested
- Use switch statements instead of multiple if-else chains when appropriate
  - Prefer switch for 3+ conditions
  - Use switch(true) pattern for complex boolean conditions

## State Management

- **Use @preact/signals-react for global state management**
- DO NOT use React Context API or other state management libraries for global state
- Store all signals in `src/utils/signals/` directory
- **For local component state, use React's `useState` instead of signals**

### Signal Best Practices

```typescript
// Signal definition (outside components, in src/utils/signals/)
import { signal, computed, effect } from "@preact/signals-react";

export const count = signal(0);
export const double = computed(() => count.value * 2);

// Use effect() ONLY outside components for global side effects
effect(() => {
  localStorage.setItem("count", count.value.toString());
});
```

### Using Signals in Components

```typescript
import { useSignals } from "@preact/signals-react/runtime";
import { useSignalEffect } from "@preact/signals-react";
import { count, double } from "../utils/signals/counter";

function Counter() {
  // Required for reactivity (unless using Babel plugin)
  useSignals();

  // For component-specific side effects, use useSignalEffect (NOT effect)
  useSignalEffect(() => {
    console.log("Count changed:", count.value);
  });

  return (
    <button onClick={() => count.value++}>
      {count.value} x 2 = {double.value}
    </button>
  );
}
```

### Important Rules

- **Always use `useSignals()` at the top of components** that read signal values (required for reactivity)
- **Use `effect()` ONLY outside components** for global side effects (e.g., localStorage, document updates)
- **Use `useSignalEffect()` inside components** for component-specific side effects
- **DO NOT use `effect()` inside components** - it will recreate on every render
- Signal files should export the signal and any helper functions
- Keep signal logic simple and focused on one concern per file

## Component Organization

- Screen-level components (페이지 단위 컴포넌트) should be placed directly in the page folder
- Don't create separate `components` folders for screen-level components
- Only use `components` folders for small, reusable UI components
- Example: `/pages/code/CodeHero.tsx` NOT `/pages/code/components/CodeHero.tsx`

## UI Design Guidelines

- **No border-radius**: Keep all UI elements rectangular (네모낳게) - no rounded corners
- **Color scheme**: Black and white monochrome style
- **Typography**:
  - Brand/Headers: 'Space Grotesk', sans-serif (font-weight: 700)
  - Body/Text: 'Inter', sans-serif (font-weight: 400)
- Prefer sharp, clean edges over rounded elements
- Use consistent spacing and alignment
- **Icons**: Use `@icons-pack/react-simple-icons` for brand/tech icons instead of custom SVGs
  - Import from `@icons-pack/react-simple-icons`
  - Example: `import { SiGithub, SiReact } from "@icons-pack/react-simple-icons"`
- **Loading states**: Always use `<LoadingIndicator />` component instead of plain text like "Loading..." or "로딩중"
  - Import from `src/components/uis/LoadingIndicator`
  - Wrap with proper layout when needed

## Project-Specific Rules

- This is an AI-powered GitHub issue and discussion assistant
- Repository-based access control (only owner can see their repos)
- AI automation features:
  - Issue and discussion formatting
  - Repository-grounded answers
  - Maintainer tagging for code-change requests
- Monthly token limits tied to subscription tiers
- Main tech stack: React, TypeScript, Convex, Tailwind CSS, Lemon Squeezy
- Navigation: Workspace (/), Tickets (/tickets), Usage (/usage)
- All user-facing text should start with capital letters (e.g., "Connect repository" not "connect repository")

## Testing & Validation

- Run typecheck and lint before suggesting commits
- Ensure all changes pass: `bun run typecheck && bun run lint`

## Convex Best Practices

- **DO NOT** create barrel export files in convex root
- Organize functions in subdirectories: `query.ts`, `mutation.ts`, `action.ts`
- Use `.withIndex()` instead of `.filter()` for queries
- Always validate auth with `getAuthUserId(ctx)`
- Use dot notation for API calls: `api.repositories.query.list` NOT `api["repositories/query"].list`
  - The API structure follows the file directory structure
  - Examples:
    - `api.users.query.getCurrentUser` for `convex/users/query.ts`
    - `api.repositories.mutation.updateSettings` for `convex/repositories/mutation.ts`
    - `api.ticketActions.query.listByTicket` for `convex/ticketActions/query.ts`
- Core database tables (see `convex/schema.ts` for the full list):
  - `repositories`: Repository settings and indexing lifecycle
  - `tickets`: GitHub issue and discussion records
  - `ticketActions`: Assistant work, approvals, and follow-up history
  - `subscriptions`: User subscription plans and token entitlements
  - `userProfiles`: User profile information from GitHub
  - `tokenUsage`: Metered provider usage per request
  - `chatUsageReservations`: Quota reservations for in-flight generation
  - `repoChunks`: Indexed repository content for retrieval

## Important Reminders

- Read existing code before making changes
- Prefer editing existing files over creating new ones
- Never create documentation files unless explicitly requested
- Refer to [docs/convention.md](docs/convention.md) for detailed development conventions
