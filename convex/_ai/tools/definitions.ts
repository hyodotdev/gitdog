/**
 * Tool definitions for AI function calling.
 * These tools allow the model to explore the codebase.
 */

export type ToolDefinition = {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
};

/**
 * Tools for codebase exploration
 */
export const codebaseTools: ToolDefinition[] = [
  {
    name: "hybrid_search",
    description:
      "Semantic search using vector embeddings + keyword search to find relevant code chunks (functions, classes). This is the MOST POWERFUL search tool - use this FIRST for finding relevant code. Returns ranked chunks with semantic similarity scores.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural language query describing what you're looking for (e.g., 'authentication logic', 'webhook handling', 'database queries')",
        },
        topK: {
          type: "number",
          description: "Number of results to return (default: 8, max: 20)",
        },
        language: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional: Filter by programming language (e.g., ['TypeScript', 'JavaScript'])",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "search_code",
    description:
      "Text-based search for exact code patterns, functions, classes, or text in the repository. Use this for finding specific identifiers or when hybrid_search doesn't find what you need. Returns matching files with line numbers and context.",
    input_schema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "Text or regex pattern to search for (e.g., 'function handleWebhook', 'class UserProfile', 'TODO')",
        },
        file_pattern: {
          type: "string",
          description:
            "Optional glob pattern to filter files (e.g., '*.ts', '**/*.tsx', 'src/components/**')",
        },
        case_sensitive: {
          type: "boolean",
          description:
            "Whether the search should be case sensitive (default: false)",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "read_file",
    description:
      "Read the contents of a specific file from the repository. Use this after finding relevant files with search_code to understand implementation details.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Relative path to the file from repository root (e.g., 'src/utils/helper.ts')",
        },
        start_line: {
          type: "number",
          description:
            "Optional: Start reading from this line number (1-indexed)",
        },
        end_line: {
          type: "number",
          description: "Optional: Stop reading at this line number (1-indexed)",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "list_directory",
    description:
      "List files and subdirectories in a directory. Use this to explore the project structure and find relevant modules.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Directory path relative to repository root (e.g., 'src/components', '.')",
        },
        pattern: {
          type: "string",
          description:
            "Optional glob pattern to filter results (e.g., '*.ts', '*.tsx')",
        },
        recursive: {
          type: "boolean",
          description: "Whether to list files recursively (default: false)",
        },
      },
      required: ["path"],
    },
  },
];
