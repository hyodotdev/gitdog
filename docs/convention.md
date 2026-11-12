# Gitdog Development Conventions

**Objective**: Provide comprehensive guidelines and best practices for building the Gitdog platform.

**Scope**: React, TypeScript, Convex, Tailwind CSS, Lemon Squeezy integration

---

## Table of Contents

- [Convex Structure and Rules](#convex-structure-and-rules)
- [TypeScript Guidelines](#typescript-guidelines)
- [React Component Guidelines](#react-component-guidelines)
- [State Management](#state-management)
- [Styling Guidelines](#styling-guidelines)
- [Internationalization (i18n)](#internationalization-i18n)
- [File Upload Guidelines](#file-upload-guidelines)
- [Security Guidelines](#security-guidelines)
- [Performance Guidelines](#performance-guidelines)

---

## Convex Structure and Rules

### File Organization

- **DO NOT** create barrel export files (e.g., `projects.ts`, `users.ts`, etc.) in the convex root directory
- Organize Convex functions in subdirectories with `query.ts`, `mutation.ts`, and `action.ts` files
- Example structure:

  ```txt
  convex/
    users/
      query.ts
      mutation.ts
    projects/
      query.ts
      mutation.ts
    tickets/
      query.ts
      mutation.ts
      action.ts
  ```

### Function Syntax

- Always use the new Convex function syntax with proper validators
- Keep query/mutation/action handlers simple and focused
- Use descriptive function names
- Add proper TypeScript types for arguments and return values
- Use Convex validators (v.object, v.string, etc.) for runtime type checking
- Use `.withIndex()` instead of `.filter()` for queries
- Avoid floating promises - use `void` operator when needed
- Example:

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
  const projects = useQuery(api.projects.query.list);
  const user = useQuery(api.users.query.getCurrentUser);

  // Mutations
  const createProject = useMutation(api.projects.mutation.create);
  const updateProfile = useMutation(api.users.mutation.updateProfile);

  // Actions
  const sendEmail = useAction(api.notifications.action.sendEmail);
  ```

### Authentication in Convex Functions

- Always use `getAuthUserId(ctx)` from `@convex-dev/auth/server` to check authentication
- Example:

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

### Bounded Queries, Pagination, and the 16MB Limit

Convex has a **16MB read limit per function execution**. To avoid hitting this limit:

- **Never use an unbounded `.collect()`** - it can read unlimited data and cause 16MB errors
- Prefer `.first()` or a caller-specific `.take(n)` whenever possible
- Use `paginatedCollect()` only as the shared bounded-take wrapper; despite its legacy name, it does not traverse cursor pages
- Pass a small explicit `maxItems` for large documents; the 10,000-item hard cap is not a byte-size guarantee
- **Only ONE actual `.paginate()` call is allowed per function** - multiple cursor-paginated queries will error
- Use a cursor-paginated query or durable continuation when every row must be traversed

#### Using paginatedCollect

```typescript
import { paginatedCollect } from "../_utils/pagination";

// ❌ NEVER do this - can cause 16MB limit error
const allItems = await ctx.db
  .query("myTable")
  .withIndex("by_user", (q) => q.eq("userId", userId))
  .collect();

// ✅ Use the shared wrapper when a bounded maximum is appropriate
const allItems = await paginatedCollect(
  ctx.db.query("myTable").withIndex("by_user", (q) => q.eq("userId", userId)),
  { maxItems: 500 },
);

// ✅ With options (maxItems limits total results)
const items = await paginatedCollect(
  ctx.db
    .query("myTable")
    .withIndex("by_status", (q) => q.eq("status", "active")),
  { maxItems: 500 },
);
```

#### Why This Matters

Tables with large documents (e.g., `repoChunks` with embedding vectors) can easily exceed 16MB when collecting all rows. The `paginatedCollect` utility handles this by:

1. Normalizing `maxItems` to a finite integer between 0 and 10,000
2. Calling `.take(maxItems)` once so rows after that bound are not read
3. Returning at most that many documents

The default item cap does not guarantee that the result fits within 16MB. Use a smaller explicit maximum for large documents. When the operation must visit every matching row, use `.paginate()` with a cursor across separate calls or a durable continuation instead.

#### Multiple Reads and Cursor Pagination

Keep nested reads small even though bounded `.take()` queries can coexist in one function:

```typescript
import { paginatedCollect, paginatedQuery } from "../_utils/pagination";

// ✅ Bound the outer read and use a small local bound for nested reads
const tickets = await paginatedCollect(
  ctx.db.query("tickets").withIndex(...),
  { maxItems: 250 },
);
const ticketsWithActions = await Promise.all(
  tickets.map(async (ticket) => {
    const actions = await ctx.db
      .query("actions")
      .withIndex("by_ticket", (q) => q.eq("ticketId", ticket._id))
      .take(25);
    return { ...ticket, actions };
  }),
);

// ✅ For complete traversal, expose one cursor-paginated query and continue it
// across separate function calls.
const page = await paginatedQuery(ctx.db.query("files"), {
  pageSize: 100,
  cursor: null,
});
// Pass page.cursor into the next function call while page.hasMore is true.
```

---

## TypeScript Guidelines

### Modern JavaScript/TypeScript Syntax

- Use explicit return types for named functions when they clarify a contract or resolve an inference cycle
- Use contextual return-type inference for inline callbacks and Convex handlers unless an explicit type is required
- **Prefer ES6+ syntax** throughout the codebase
- **Number parsing guidelines:**
  - For **integers only**: Use `Number.parseInt(str, 10)` or `parseInt(str, 10)` with explicit radix
  - For **decimals/floats**: Use `Number(str)` or `Number.parseFloat(str)`
  - Always validate with `Number.isNaN()` to avoid coercion issues
- Use optional chaining (`?.`) and nullish coalescing (`??`)
- Prefer `const` and `let` over `var`
- Examples:

  ```typescript
  // ✅ Preferred - Safe integer parsing
  const lineNum = Number.parseInt(match[1], 10);
  if (!Number.isNaN(lineNum)) {
    // Use lineNum safely
  }

  // ✅ Preferred - Safe float parsing
  const price = Number(priceStr); // or Number.parseFloat(priceStr)
  if (!Number.isNaN(price)) {
    // Use price safely
  }

  // ✅ Modern syntax
  const value = obj?.property ?? defaultValue;

  // ❌ Avoid - parseInt truncates decimals silently
  const price = parseInt("3.14", 10); // Returns 3, not 3.14
  const count = parseInt("12abc", 10); // Returns 12, silently ignoring "abc"

  // ❌ Avoid - isNaN coerces values
  if (!isNaN(value)) {
  } // Use Number.isNaN() instead
  ```

### Type Definitions

- Prefer explicit types over inference for function parameters
- Use const assertions for literal types
- Avoid `any` types unless absolutely necessary
- Define arrays as `const array: Array<T> = [...]` or `T[]`
- Define records as `const record: Record<KeyType, ValueType> = {...}`
- Use `Id<'tableName'>` type for Convex document IDs

### Null/Undefined Checks and Falsy Values

#### When to Use Falsy Checks

- **Use falsy checks (`!value`) ONLY for objects, arrays, and reference types** where `null`/`undefined` are the only expected falsy values
- **Always use explicit checks (`=== null`, `!== undefined`) for primitives** that can legitimately be `0`, `""`, or `false`
- **Always use `!!` for array length checks** to convert to boolean
- Examples:

  ```typescript
  // ✅ Safe falsy checks - objects/arrays
  if (!user) return; // user is object or null/undefined
  if (!repository) throw new Error("not found");
  if (!!items?.length) { /* ... */ }

  // ✅ Array length checks - always use !!
  {!!proposedChanges.changes?.length && <FileList changes={proposedChanges.changes} />}
  const hasItems = !!items?.length;

  // ✅ Explicit checks - primitives that can be 0/""/false
  if (count !== undefined) { /* count can be 0 */ }
  if (name !== null && name !== "") { /* name can be empty string */ }
  if (isEnabled !== undefined) { /* boolean flag can be false */ }

  // ❌ Avoid - falsy check on primitives (BUG!)
  if (!count) { /* ... */ } // WRONG: treats 0 as missing value
  if (!name) { /* ... */ } // WRONG: treats "" as missing value
  if (!isEnabled) { /* ... */ } // WRONG: can't distinguish false from undefined

  // ❌ Avoid - Verbose checks when falsy is safe
  if (user === null || user === undefined) return; // Just use !user

  // ❌ Avoid - Array length without !!
  {proposedChanges.changes?.length ? <FileList /> : null}
  ```

#### Exception: Explicit Checks with Comments

- **Use explicit `=== null` or `=== undefined` checks ONLY when the distinction matters**
- **Always add a comment** explaining why the specific check is needed
- Common cases:
  - Convex queries: `undefined` means loading, `null` means not found/unauthorized
  - API responses: Different handling for missing vs explicitly null values
  - Form inputs: Distinguish between unset and cleared values

- Examples:

  ```typescript
  // ✅ Explicit check with explanation
  // Must check === undefined because undefined means still loading
  const isLoading = data === undefined;

  // Must check === null because null means query completed but not found
  if (data === null) {
    return <NotFound />;
  }

  // ✅ Define state variables for better readability
  const isUserLoading = currentUser === undefined; // undefined = loading
  const isAuthenticated = currentUser !== null;    // null = not authenticated

  // ❌ Without explanation - unclear why specific check is needed
  if (value === null) { /* ... */ }
  ```

#### Recommended Pattern for Complex States

For complex loading/error states, define clear state variables at the top:

```typescript
// ✅ Clear state definitions
const isLoading = data === undefined;  // undefined means still loading
const isNotFound = data === null;      // null means not found
const isError = error !== undefined;   // error is set

// Then use these variables in conditionals
if (isLoading) return <LoadingIndicator />;
if (isNotFound) return <NotFound />;
if (isError) return <Error message={error} />;
```

### Naming Conventions for Acronyms

- When acronyms appear as **suffix** in type names, use all caps only when the acronym is at the very end
  - ✅ `AiProviderConfig` (AI is not a suffix, treat as word)
  - ✅ `ApiClientResult` (API is not a suffix, treat as word)
  - ✅ `ConfigAI` (AI is suffix, use all caps)
  - ✅ `ProviderConfigAPI` (API is suffix, use all caps)
  - ❌ `AIProviderConfig` (AI not at suffix position)
  - ❌ `APIClientResult` (API not at suffix position)
- In other positions, treat acronyms as regular words with PascalCase
  - ✅ `HtmlParser`, `JsonData`, `XmlConfig`
  - ❌ `HTMLParser`, `JSONData`, `XMLConfig`

### Never Use `any` Type

- **NEVER use `any` type** - it defeats the purpose of TypeScript
- **Always define proper types**, even for complex objects
- **Use `unknown` if the type is truly unknown**, then narrow it with type guards
- **In Convex schemas**, only use `v.any()` for database fields that store truly dynamic data (e.g., `details`, `executionResult` in schema)
- **In Convex mutations/queries args**, ALWAYS define specific object shapes with `v.object()`
- Examples:

  ```typescript
  // ✅ Define proper types
  type ExecutionResult = {
    relatedPr?: number;
    prUrl?: string;
    githubCommentId?: number;
  };

  export const updateAction = internalMutation({
    args: {
      executionResult: v.object({
        relatedPr: v.optional(v.number()),
        prUrl: v.optional(v.string()),
        githubCommentId: v.optional(v.number()),
      }),
    },
    // ...
  });

  // ✅ Use unknown for truly unknown types, then narrow
  function parseResponse(data: unknown) {
    if (typeof data === 'object' && data !== null && 'status' in data) {
      // Now TypeScript knows data is an object with status
    }
  }

  // ❌ NEVER use any
  function badFunction(data: any) { ... }
  const result: any = await someCall();

  // ❌ NEVER use any in Convex args
  export const badMutation = internalMutation({
    args: { data: v.any() }, // ❌ Define specific shape!
  });

  // ❌ NEVER disable eslint for any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const value: any = ...;  // ❌ Fix the type instead!
  ```

### Type vs Interface

- **Prefer `type` for most type definitions**, including object shapes and function signatures
- **Use `interface` ONLY when:**
  - Defining contracts for classes to implement
  - You need declaration merging (rare cases)
- **NEVER prefix interfaces with `I`** (e.g., use `AiProvider` not `IAiProvider`)
- Examples:
  - ✅ `type User = { name: string; email: string; }` (use type for object shapes)
  - ✅ `type Config = { apiKey: string; model?: string; }` (use type for configs)
  - ✅ `interface AiProvider { chat(...): Promise<...>; }` (interface for class contract)
  - ✅ `class GrokProvider implements AiProvider { ... }` (class implements interface)
  - ❌ `interface IAiProvider { ... }` (don't prefix with I)
  - ❌ `interface User { name: string; }` (use type instead for plain objects)
  - ❌ `type AiProvider = { chat(...): ... }` (use interface for class contracts)

### Promise Handling

- Always handle promises properly
- Await in async functions: `await myPromiseFunction()`
- Use void for intentionally ignored promises: `void myAsyncFunction()`
- Handle errors: `myPromise.catch((error) => console.error(error))`

---

## React Component Guidelines

### Component Structure and Organization

- Use functional components with TypeScript type aliases for plain prop object shapes
- Page components go in `src/pages/[route]/index.tsx`
- Screen-level components (Hero, Features, etc.) go directly in the page folder
  - Example: `src/pages/home/Hero.tsx` NOT `src/pages/home/components/Hero.tsx`
- Small reusable UI components are organized by type in `src/components/`:
  - **UI components** (buttons, inputs, indicators) → `src/components/uis/`
    - Examples: `LoadingIndicator.tsx`, `Snackbar.tsx`, `AuthButton.tsx`
  - **Modals** → `src/components/modals/`
    - Examples: `IntroModal.tsx`, `ConfirmModal.tsx`
  - **Layout components** → `src/components/`
    - Examples: `Layout.tsx`, `Header.tsx`, `Footer.tsx`
- Keep one component per file
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

### Component Props

#### ClassName Props

- Always use `ClassValue` type from `clsx` for className props
- This allows passing strings, arrays, or conditional objects to the `cn()` utility
- Provides better TypeScript support and works seamlessly with the `cn()` function
- Example:

  ```typescript
  import type { ClassValue } from "clsx";
  import { cn } from "../utils/cn";

  type MyComponentProps = {
    className?: ClassValue;  // ✅ Correct - flexible and type-safe
    // className?: string;   // ❌ Too restrictive - only accepts strings
  };

  export function MyComponent({ className }: MyComponentProps) {
    return (
      <div className={cn("base-class", "another-class", className)}>
        Content
      </div>
    );
  }

  // Usage examples:
  <MyComponent className="text-red-500" />
  <MyComponent className={["flex", "items-center"]} />
  <MyComponent className={{ "bg-black": isDark, "bg-white": !isDark }} />
  ```

### Hooks and Error Handling

- Use React hooks appropriately
- Memoize expensive computations with `useMemo`
- Use `useCallback` for stable function references
- Follow Rules of Hooks
- Implement proper error boundaries
- Show user-friendly error messages
- Log errors for debugging

---

## State Management

### Signals (@preact/signals-react)

- Use `@preact/signals-react` for global state management
- DO NOT use React Context API or other state management libraries for global state
- Store all signals in `src/utils/signals/` directory
- Signal files should export the signal and any helper functions
- Keep signal logic simple and focused on one concern per file
- Use `computed` for derived state
- Use `effect` for side effects (localStorage, subscriptions, etc.)

### Usage Example

```typescript
import { signal, computed, effect } from "@preact/signals-react";

// Define signals
export const count = signal(0);
export const double = computed(() => count.value * 2);

// Use effect for side effects (like localStorage)
effect(() => {
  localStorage.setItem("count", count.value.toString());
});

// In components, use signals directly
function Counter() {
  return (
    <button onClick={() => count.value++}>
      {count.value} x 2 = {double.value}
    </button>
  );
}
```

---

## Styling Guidelines

### Tailwind CSS and Design System

- Use Tailwind CSS classes for styling
- Follow the design system:
  - **No border-radius**: Keep all UI elements rectangular (no rounded corners)
  - **Colors**: Black and white monochrome style with accent color `#FF8C42`
  - **Typography**:
    - Brand/Headers: 'Space Grotesk', sans-serif (font-weight: 700)
    - Body/Text: 'Inter', sans-serif (font-weight: 400)
  - **Dark mode**: Support via `dark:` prefix

### Tailwind CSS Class Organization

Use the `cn()` utility function from `src/utils/cn.ts` to combine classes:

```typescript
import { cn } from "../utils/cn";

<div className={cn("base-class", conditionalClass && "conditional-class")} />
```

#### Class Ordering Convention

Order Tailwind classes by their purpose in the following sequence:

1. **Layout & Positioning** (affects element position in document flow)
   - `relative`, `absolute`, `fixed`, `sticky`
   - `inset-*`, `top-*`, `right-*`, `bottom-*`, `left-*`
   - `z-*` (z-index)

2. **Display & Container** (defines how element behaves as a container)
   - `block`, `inline-block`, `inline`, `flex`, `grid`, `hidden`
   - `container`

3. **Flexbox/Grid Parent Properties** (affects children layout)
   - `flex-row`, `flex-col`, `flex-wrap`
   - `items-*`, `justify-*`, `content-*`, `place-*`
   - `gap-*`
   - `grid-cols-*`, `grid-rows-*`

4. **Flexbox/Grid Child Properties** (affects self in parent layout)
   - `flex-*`, `flex-grow`, `flex-shrink`
   - `order-*`
   - `col-span-*`, `row-span-*`

5. **Sizing** (width, height, min/max)
   - `w-*`, `min-w-*`, `max-w-*`
   - `h-*`, `min-h-*`, `max-h-*`

6. **Spacing** (margin, padding)
   - `m-*`, `mx-*`, `my-*`, `mt-*`, `mr-*`, `mb-*`, `ml-*`
   - `p-*`, `px-*`, `py-*`, `pt-*`, `pr-*`, `pb-*`, `pl-*`
   - `space-x-*`, `space-y-*`

7. **Typography** (text-related)
   - `font-*` (family, weight)
   - `text-*` (size, color, alignment)
   - `leading-*`, `tracking-*`
   - `uppercase`, `lowercase`, `capitalize`
   - `truncate`, `overflow-ellipsis`

8. **Backgrounds** (background colors, images, gradients)
   - `bg-*` (color, gradient, image)
   - `bg-opacity-*`

9. **Borders** (border width, color, style)
   - `border`, `border-*` (width, color, style)
   - `divide-*`

10. **Effects** (shadows, opacity, filters)
    - `shadow-*`
    - `opacity-*`
    - `blur-*`, `brightness-*`, `contrast-*`

11. **Transitions & Animations**
    - `transition-*`
    - `duration-*`
    - `ease-*`
    - `animate-*`

12. **Interactivity** (cursor, pointer-events)
    - `cursor-*`
    - `pointer-events-*`
    - `select-*`

13. **Responsive Modifiers** (group all responsive variants together at the end)
    - `sm:*`
    - `md:*`
    - `lg:*`
    - `xl:*`
    - `2xl:*`

14. **State Modifiers** (pseudo-classes and states)
    - `hover:*`
    - `focus:*`
    - `active:*`
    - `disabled:*`
    - `group-hover:*`

15. **Dark Mode** (always last)
    - `dark:*`

#### Example: Proper Class Organization

```typescript
// ❌ Bad - Unorganized classes
<div className="text-white hover:bg-gray-800 bg-black w-full p-6 flex items-center dark:bg-white dark:text-black">

// ✅ Good - Organized with cn()
<div className={cn(
  // Layout
  "relative",
  // Display & Container
  "flex",
  // Flexbox Parent
  "items-center",
  // Sizing
  "w-full",
  // Spacing
  "p-6",
  // Typography
  "text-white",
  // Backgrounds
  "bg-black",
  // State
  "hover:bg-gray-800",
  // Dark mode
  "dark:bg-white dark:text-black"
)}>
```

#### Complex Component Example

```typescript
// ✅ Well-organized button with multiple states
<button className={cn(
  // Layout & Positioning
  "relative inline-flex",
  // Flexbox Parent
  "items-center justify-center gap-2",
  // Sizing
  "w-full max-w-md",
  // Spacing
  "px-6 py-3",
  // Typography
  "font-brand font-bold text-lg",
  // Backgrounds
  "bg-black",
  // Borders
  "border-2 border-transparent",
  // Effects
  "shadow-lg",
  // Transitions
  "transition-all duration-300",
  // State
  "hover:shadow-xl hover:-translate-y-1",
  "disabled:opacity-50 disabled:cursor-not-allowed",
  // Responsive
  "md:w-auto",
  // Dark mode
  "dark:bg-white"
)}>
```

#### Multi-line Formatting Guidelines

- Use multi-line format with `cn()` when there are 5+ class groups
- Group related classes together with comments
- One group per line for better readability
- Keep responsive and dark mode modifiers at the end

```typescript
// ✅ Multi-line for complex components
<div className={cn(
  // Layout
  "relative z-50",
  // Display & Flex
  "flex items-center justify-between",
  // Sizing
  "w-full max-w-7xl",
  // Spacing
  "px-6 py-4 mb-8",
  // Typography
  "text-xl font-brand font-bold",
  // Background & Border
  "bg-white border-b border-gray-200",
  // Effects
  "shadow-sm",
  // Transitions
  "transition-colors duration-200",
  // Responsive
  "md:px-8 lg:py-6",
  // State
  "hover:border-black",
  // Dark mode
  "dark:bg-[#0a0a0a] dark:border-gray-800 dark:hover:border-white"
)}>

// ✅ Single-line for simple components
<span className={cn("text-sm text-gray-600 dark:text-gray-400")}>
```

### Custom Select/Dropdown Styling

When creating custom styled select dropdowns, always wrap the select element with a relative container and add a custom chevron icon:

```typescript
import { ChevronDown } from "lucide-react";

// ✅ Correct - Wrapper div with custom icon
<div className={cn("relative")}>
  <select
    className={cn(
      "w-full px-4 py-2 pr-10",  // pr-10 for icon space
      "border border-gray-300 dark:border-gray-700",
      "bg-white dark:bg-gray-900",
      "appearance-none cursor-pointer",  // Hide default arrow
    )}
  >
    <option value="1">Option 1</option>
    <option value="2">Option 2</option>
  </select>
  <ChevronDown
    size={16}
    className={cn(
      "absolute right-3 top-1/2 -translate-y-1/2",
      "pointer-events-none",
      "text-gray-500 dark:text-gray-400",
    )}
  />
</div>

// ❌ Wrong - Select without wrapper, default browser arrow shows incorrectly
<select className="w-full px-4 py-2">
  <option>Option</option>
</select>
```

Key points:

- Always use `appearance-none` on select to hide the default browser arrow
- Add `pr-10` (or appropriate padding) to make room for the custom icon
- Use `pointer-events-none` on the icon so clicks pass through to the select
- Position the icon with `absolute right-3 top-1/2 -translate-y-1/2`

### Responsive Design and Principles

- Use responsive modifiers: `sm:`, `md:`, `lg:`, `xl:`
- Mobile-first approach
- Test on different screen sizes
- Prefer sharp, clean edges over rounded elements
- Use consistent spacing and alignment
- Maintain visual hierarchy with typography and spacing

---

## Internationalization (i18n)

### Configuration and Usage

- Use react-i18next for translations
- Support languages: en, ko, ja
- Translation files in `src/i18n/locales/`
- Keep keys organized by feature
- Use interpolation for dynamic values: `t('greeting', { name: 'John' })`
- Handle pluralization properly
- Always update all locale files (en, ko, ja) when changing user-facing text

### Implementation Example

```typescript
import { useTranslation } from "react-i18next";

function MyComponent() {
  const { t } = useTranslation();
  return <h1>{t("welcome.title")}</h1>;
}
```

### Translation Key Structure

```json
{
  "projects": {
    "title": "Projects",
    "create": "Create Project",
    "delete": "Delete Project"
  }
}
```

---

## File Upload Guidelines

### Image Handling and Implementation

- Use Convex storage for file uploads
- Generate upload URLs with mutations
- Clean up unused files
- Support image formats: JPEG, PNG, GIF, WebP
- Use `generateUploadUrl` mutation from Convex
- Upload to storage, then save file reference in `files` table
- Handle upload progress and errors
- Store file metadata (size, type, etc.)

### Upload Example

```typescript
// Generate upload URL
const uploadUrl = await generateUploadUrl();

// Upload file
const response = await fetch(uploadUrl, {
  method: "POST",
  body: file,
});
const { storageId } = await response.json();

// Save file reference
await saveFile({ storageId, fileName, fileSize, contentType });
```

---

## Security Guidelines

### Input Validation and Access Control

- Validate all user inputs on both client and server
- Sanitize content before storage
- Use Convex validators for runtime type checking
- Never trust client-side data
- Check permissions in every query/mutation
- Use role-based access control (owner, maintainer, etc.)
- Verify document ownership before allowing operations
- Always authenticate users with `getAuthUserId(ctx)`

### Sensitive Data Protection

- Never expose sensitive information in API responses
- Use environment variables for secrets
- Follow principle of least privilege
- Secure payment information through Lemon Squeezy

---

## Performance Guidelines

### Query and Client Optimization

- Use indexes for frequent queries
- Paginate large result sets
- Avoid N+1 query problems
- Use `.withIndex()` for filtered queries
- Lazy load components with `React.lazy()`
- Use `React.memo` for expensive components
- Optimize bundle size with code splitting
- Minimize re-renders with proper dependencies

### Caching and Bundle Optimization

- Leverage Convex's built-in caching
- Use appropriate query dependencies
- Invalidate cache when needed
- Consider stale-while-revalidate patterns
- Tree-shake unused code
- Use dynamic imports for large dependencies
- Analyze bundle size regularly
- Optimize images and assets

---

## Additional Notes

- Always run `bun run typecheck && bun run lint` before committing
- Follow existing code patterns and conventions
- Keep code DRY (Don't Repeat Yourself)
- Write self-documenting code with clear naming
- Add comments only when necessary to explain "why", not "what"
