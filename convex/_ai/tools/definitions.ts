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
      "Ranked keyword search over the repository's indexed code chunks (functions, classes), boosted by path, symbol and documentation matches. Use this FIRST with the identifiers, file names and domain terms you expect in the code; run several focused queries rather than one long sentence. Follow up with search_code for exact patterns and read_file to confirm details.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Keywords for what you're looking for, ideally identifiers or terms used in the code (e.g., 'webhook signature verify', 'createCheckoutUrl', 'auth session refresh')",
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
