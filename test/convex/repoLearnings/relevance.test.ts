import { describe, expect, it } from "vitest";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import {
  getLearningEmbeddingPolicy,
  getLearningSearchLimit,
  isRelevantLearningScore,
  mergeLearningResults,
  MIN_LEARNING_RELEVANCE_SCORE,
} from "../../../convex/repoLearnings/action";
import {
  buildLearningContextForProvenance,
  isLearningAllowedForSearch,
} from "../../../convex/repoLearnings/trust";

function makeLearning(
  id: string,
  content: string,
  embeddingDataProvenance:
    "public_github" | "private_user_input" = "private_user_input",
): Doc<"repoLearnings"> {
  return {
    _id: id as Id<"repoLearnings">,
    _creationTime: 0,
    repositoryId: "repository" as Id<"repositories">,
    content,
    source: "test",
    sourceType: "comment",
    isTrusted: true,
    repositoryTrustKey: "trusted:repository",
    embeddingDataProvenance,
    createdAt: 0,
  };
}

describe("repository learning relevance", () => {
  it("accepts scores at the threshold", () => {
    expect(isRelevantLearningScore(MIN_LEARNING_RELEVANCE_SCORE)).toBe(true);
  });

  it("rejects weak or invalid matches", () => {
    expect(isRelevantLearningScore(MIN_LEARNING_RELEVANCE_SCORE - 0.01)).toBe(
      false,
    );
    expect(isRelevantLearningScore(Number.NaN)).toBe(false);
  });

  it("bounds result limits", () => {
    expect(getLearningSearchLimit(undefined)).toBe(5);
    expect(getLearningSearchLimit(Number.NaN)).toBe(5);
    expect(getLearningSearchLimit(0)).toBe(1);
    expect(getLearningSearchLimit(3.9)).toBe(3);
    expect(getLearningSearchLimit(100)).toBe(20);
  });

  it("defaults missing repository metadata to paid-only routing", () => {
    expect(getLearningEmbeddingPolicy(null)).toEqual({
      route: "paid",
      allowPaidFallback: false,
    });
  });

  it("uses the paid route for every repository", () => {
    expect(
      getLearningEmbeddingPolicy({
        githubVisibility: "public",
        licenseSpdxId: "MIT",
        licenseOsiApproved: true,
      }),
    ).toEqual({ route: "paid", allowPaidFallback: false });
    expect(
      getLearningEmbeddingPolicy({
        githubVisibility: "public",
      }),
    ).toEqual({ route: "paid", allowPaidFallback: false });
    expect(
      getLearningEmbeddingPolicy({
        githubVisibility: "private",
        licenseSpdxId: "MIT",
        licenseOsiApproved: true,
      }),
    ).toEqual({ route: "paid", allowPaidFallback: false });
  });

  it("deduplicates vector and keyword results within the requested limit", () => {
    const vectorLearning = makeLearning("learning-1", "Vector match");
    const keywordLearning = makeLearning("learning-2", "Keyword match");

    const merged = mergeLearningResults(
      [{ ...vectorLearning, score: 0.92 }],
      [vectorLearning, keywordLearning],
      2,
      "private_user_input",
    );

    expect(merged.map((learning) => learning._id)).toEqual([
      vectorLearning._id,
      keywordLearning._id,
    ]);
    expect(merged.map((learning) => learning.score)).toEqual([
      0.92,
      MIN_LEARNING_RELEVANCE_SCORE,
    ]);
  });

  it("fails closed when public searches encounter private learnings", () => {
    const publicLearning = makeLearning(
      "learning-public",
      "Public GitHub guidance",
      "public_github",
    );
    const privateLearning = makeLearning(
      "learning-private",
      "Private dashboard guidance",
      "private_user_input",
    );
    const publicResults = mergeLearningResults(
      [
        { ...privateLearning, score: 0.99 },
        { ...publicLearning, score: 0.9 },
      ],
      [privateLearning, publicLearning],
      5,
      "public_github",
    );
    const publicContext = buildLearningContextForProvenance(
      [privateLearning, publicLearning],
      "public_github",
    );

    expect(publicResults.map((learning) => learning._id)).toEqual([
      publicLearning._id,
    ]);
    expect(publicContext).toBe("- Public GitHub guidance");
    expect(isLearningAllowedForSearch(privateLearning, "public_github")).toBe(
      false,
    );
  });

  it("keeps every trusted provenance available to private workflows", () => {
    const learnings = [
      makeLearning("learning-public", "Public guidance", "public_github"),
      makeLearning(
        "learning-private",
        "Private guidance",
        "private_user_input",
      ),
    ];

    const results = mergeLearningResults(
      [],
      learnings,
      learnings.length,
      "private_user_input",
    );

    expect(results.map((learning) => learning._id)).toEqual(
      learnings.map((learning) => learning._id),
    );
  });
});
