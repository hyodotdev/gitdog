export function getTrustedLearningRepositoryKey(repositoryId: string): string {
  return `${repositoryId}:trusted`;
}

export type LearningEmbeddingDataProvenance =
  "public_github" | "private_user_input";

type LearningWithProvenance = {
  content: string;
  embeddingDataProvenance: LearningEmbeddingDataProvenance;
};

export function isLearningAllowedForSearch(
  learning: LearningWithProvenance,
  requestProvenance: LearningEmbeddingDataProvenance,
): boolean {
  return (
    requestProvenance === "private_user_input" ||
    learning.embeddingDataProvenance === "public_github"
  );
}

export function buildLearningContextForProvenance(
  learnings: Array<LearningWithProvenance>,
  requestProvenance: LearningEmbeddingDataProvenance,
): string | undefined {
  const context = learnings
    .filter((learning) =>
      isLearningAllowedForSearch(learning, requestProvenance),
    )
    .map((learning) => `- ${learning.content}`)
    .join("\n");

  return context.length > 0 ? context : undefined;
}
