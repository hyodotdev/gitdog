# /test - Bug Detection and Test Generation

Run comprehensive tests and detect potential bugs in the codebase.

## Usage

```
/test [target]
```

### Arguments

- `target` (optional): Specific file, directory, or test pattern to focus on
  - If omitted, runs all tests and performs full codebase analysis
  - Examples: `/test src/pages/pricing`, `/test convex/tickets`

## Instructions

When this command is invoked, perform the following steps:

### 1. Run Existing Tests

First, run the existing test suite to establish a baseline:

```bash
bun run test
```

Report any failing tests immediately.

### 2. Type Check

Run TypeScript type checking:

```bash
bun run typecheck
```

Report any type errors found.

### 3. Lint Check

Run the linter:

```bash
bun run lint
```

Report any linting issues.

### 4. Bug Detection Analysis

Analyze the codebase (or specified target) for potential bugs:

#### Common Bug Patterns to Check

1. **Null/Undefined Access**
   - Missing null checks before property access
   - Optional chaining not used where needed
   - Array index access without bounds checking

2. **Async/Await Issues**
   - Missing `await` on async operations
   - Unhandled promise rejections
   - Race conditions in state updates

3. **React-Specific Issues**
   - Missing dependencies in `useEffect`/`useMemo`/`useCallback`
   - State updates on unmounted components
   - Incorrect key props in lists
   - Missing `useSignals()` hook when using signals

4. **Convex-Specific Issues**
   - Using `.filter()` instead of `.withIndex()` in queries
   - Missing auth validation with `getAuthUserId(ctx)`
   - Incorrect API path notation (should use dot notation like `api.users.query`)

5. **Security Issues**
   - Command injection vulnerabilities
   - XSS vulnerabilities in React
   - Sensitive data exposure in logs
   - Missing input validation

6. **Logic Errors**
   - Off-by-one errors in loops
   - Incorrect comparison operators
   - Missing break/return statements
   - Incorrect boolean logic

### 5. Test Coverage Analysis

Identify areas lacking test coverage:

1. Check for untested Convex mutations/queries
2. Check for untested React components
3. Check for untested utility functions

### 6. Generate Missing Tests

For any untested critical paths found, generate test files following the project's test patterns:

- Use Vitest for testing
- Follow existing test file structure in `test/convex/`
- Use mock patterns from `test/convex/mocks.ts`

## Output Format

Provide a structured report:

```
## Test Results Summary

### Existing Tests
- Total: X tests
- Passed: X
- Failed: X

### Type Errors
- Count: X
- [List of errors if any]

### Lint Issues
- Count: X
- [List of issues if any]

### Potential Bugs Detected
1. [File:Line] - [Description of potential bug]
   - Severity: High/Medium/Low
   - Suggested fix: [Brief fix description]

### Test Coverage Gaps
1. [File/Function] - Missing tests for [functionality]

### Generated Tests
- [List of test files created]
```

## Example

```
/test convex/tickets
```

This would:

1. Run tests matching `tickets`
2. Analyze `convex/tickets/` for bugs
3. Check test coverage for ticket-related functionality
4. Generate any missing tests

## Project-Specific Notes

- This project uses `bun` as the package manager
- Convex functions are organized in subdirectories: `query.ts`, `mutation.ts`, `action.ts`
- React uses `@preact/signals-react` for global state
- Always use `useSignals()` hook in components reading signal values
- Test files should be in `test/convex/` directory
