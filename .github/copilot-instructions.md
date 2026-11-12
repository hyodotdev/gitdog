# Copilot Instructions for Gitdog Project

**Objective**: Provide guidelines and best practices for building Gitdog, an AI-powered GitHub issue and discussion assistant, including Convex database patterns, React components, AI workflows, Lemon Squeezy payments, and internationalization.

**File Scope**: Applies to files matching the patterns: `**/*.ts`, `**/*.tsx`, `**/*.js`, `**/*.jsx`

---

## Convex Structure and Rules

### File Organization

- **DO NOT** create barrel export files in the convex root directory
- Organize Convex functions in subdirectories with `query.ts`, `mutation.ts`, and `action.ts` files
- Example structure:
  ```
  convex/
    repositories/
      query.ts
      mutation.ts
      action.ts
    tickets/
      query.ts
      mutation.ts
    lemonSqueezy/
      webhook.ts
    ticketActions/
      query.ts
      mutation.ts
      action.ts
  ```

### Function Guidelines

- Always use the new Convex function syntax with proper validators
- Example query:

  ```typescript
  import { query } from "../_generated/server";
  import { v } from "convex/values";

  export const list = query({
    args: {},
    handler: async (ctx, args) => {
      // Function body
    },
  });
  ```

### API Usage in Client Code

- Use dot notation to access Convex functions
- Format: `api.module.type.functionName`
- Examples:

  ```typescript
  // Queries
  const repositories = useQuery(api.repositories.query.list);
  const user = useQuery(api.users.query.getCurrentUser);

  // Mutations
  const updateSettings = useMutation(api.repositories.mutation.updateSettings);

  // Actions
  const createAndIndex = useAction(api.repositories.action.createAndIndex);
  ```

### Authentication

- Always use `getAuthUserId(ctx)` to check authentication:

  ```typescript
  import { getAuthUserId } from "@convex-dev/auth/server";

  export const myFunction = query({
    args: {},
    handler: async (ctx, args) => {
      const userId = await getAuthUserId(ctx);
      if (!userId) {
        return null; // or throw error
      }
      // Continue with authenticated logic
    },
  });
  ```

### Best Practices

- Keep query/mutation/action handlers simple and focused
- Use descriptive function names
- Add proper TypeScript types for arguments and return values
- Use Convex validators (v.object, v.string, etc.) for runtime type checking
- **Use `.withIndex()` instead of `.filter()` for queries** (performance)
- Avoid floating promises - use `void` operator when needed

---

## TypeScript Guidelines

### General Rules

- Prefer explicit types over inference for function parameters
- Use const assertions for literal types
- Avoid `any` types unless absolutely necessary
- Define arrays as `const array: Array<T> = [...]`
- Define records as `const record: Record<KeyType, ValueType> = {...}`
- Use `Id<'tableName'>` type for Convex document IDs
- Prefer `type` for object shapes and function signatures
- Use `interface` only for class contracts or declaration merging
- Use explicit return types for named functions when they clarify a contract or resolve an inference cycle
- Use contextual return-type inference for inline callbacks and Convex handlers unless an explicit type is required

### Promise Handling

- Always handle promises properly:

  ```typescript
  // Await in async functions
  await myPromiseFunction();

  // Use void for intentionally ignored promises
  void myAsyncFunction();

  // Handle errors properly
  myPromise.catch((error) => console.error(error));
  ```

---

## React Component Guidelines

### Component Structure

- Use functional components with TypeScript type aliases for plain prop object shapes
- Example:

  ```typescript
  type MyComponentProps = {
    title: string;
    onSubmit: (data: FormData) => void;
  };

  export function MyComponent({ title, onSubmit }: MyComponentProps) {
    // Component logic
  }
  ```

### Hooks Usage

- Use React hooks appropriately
- Memoize expensive computations with `useMemo`
- Use `useCallback` for stable function references
- Follow Rules of Hooks

### Error Handling

- Implement proper error boundaries
- Show user-friendly error messages
- Log errors for debugging

---

## Styling Guidelines

### Tailwind CSS

- Use Tailwind CSS classes for styling
- Follow the existing design system:
  - Use the existing black and white monochrome palette
  - Spacing: Use consistent spacing scale
  - Typography: Follow established font sizes
- **No rounded corners**: All border-radius values are set to 0

### Responsive Design

- Use responsive modifiers: `sm:`, `md:`, `lg:`, `xl:`
- Mobile-first approach
- Test on different screen sizes

---

## Internationalization (i18n)

### Setup

- Use react-i18next for translations
- Support languages: en, ko, ja
- Translation files in `src/i18n/locales/`

### Usage

- Import translation hook:

  ```typescript
  import { useTranslation } from 'react-i18next';

  function MyComponent() {
    const { t } = useTranslation();
    return <h1>{t('home.title')}</h1>;
  }
  ```

### Translation Keys

- Use hierarchical structure:
  ```json
  {
    "tickets": {
      "title": "Tickets",
      "empty": "No tickets yet"
    }
  }
  ```

### Best Practices

- Keep keys organized by feature
- Use interpolation for dynamic values
- Handle pluralization properly
- Test all languages

---

## Lemon Squeezy Payment Integration

### Payment Flow

- Use Lemon Squeezy checkout for payments
- Handle webhooks in `convex/lemonSqueezy/webhook.ts`
- Verify purchases before granting access
- Track subscription and token pack purchases

### Implementation

- Initialize Lemon Squeezy checkout properly
- Handle payment success/failure
- Process webhooks securely with signature verification
- Grant access only after webhook confirmation

---

## Security Guidelines

### Input Validation

- Validate all user inputs
- Sanitize content before storage
- Use Convex validators

### Access Control

- Check permissions in every query/mutation
- Use role-based access control
- Verify repository ownership and the current GitHub App installation before access
- Resolve repositories through their immutable numeric GitHub repository IDs
- Verify subscription entitlements before paid AI requests

### Sensitive Data

- Never expose sensitive information
- Use environment variables for secrets
- Follow principle of least privilege

---

## Performance Guidelines

### Query Optimization

- **Use `.withIndex()` instead of `.filter()`**
- Use indexes for frequent queries
- Use `paginatedCollect()` for bounded multi-item reads, direct `.first()` or `.take(n)` for local limits, and cursor pagination for complete traversal
- Avoid N+1 query problems

### Client Optimization

- Lazy load components
- Use React.memo for expensive components
- Optimize bundle size
- Use `useMemo` and `useCallback` appropriately

### Caching

- Leverage Convex's built-in caching
- Use appropriate query dependencies
- Invalidate cache when needed
