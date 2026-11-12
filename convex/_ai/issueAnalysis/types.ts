// Issue Analysis Result types
export type IssueType =
  | "actionable"
  | "needs_more_info"
  | "question"
  | "discussion"
  | "documentation";

export type IssueAnalysisResult = {
  isActionable: boolean;
  issueType: IssueType;
  reasoning: string;
  suggestedResponse?: string; // AI-generated response
  confidence?: number; // 0-1 confidence score based on code evidence found
  toolsUsed?: number; // Number of tool calls made before answering
  filesRead?: number; // Number of successful read_file calls
  filesReadPaths?: string[]; // Unique repository paths successfully read
  toolErrors?: number; // Number of failed or unavailable tool calls
  wasRepaired?: boolean; // Deterministic validation required a constrained repair
  validationPassed?: boolean; // Set internally only after deterministic validation
};

export type IssueInput = {
  title: string;
  body: string;
  codebaseContext?: string; // RAG search results, README, project structure
};
