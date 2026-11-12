// Issue Formatting Result types
export type IssueFormattingResult = {
  needsImprovement: boolean;
  reasoning: string;
  suggestedTitle?: string;
  suggestedBody?: string;
  changesSummary?: string;
};

export type IssueFormattingInput = {
  title: string;
  body: string;
  feedback?: string; // User feedback for regeneration
};
