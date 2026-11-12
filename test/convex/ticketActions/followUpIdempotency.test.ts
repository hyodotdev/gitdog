import { describe, expect, it } from "vitest";
import { findFollowUpActionByCommentId } from "../../../convex/ticketActions/internalMutation";

describe("follow-up comment idempotency", () => {
  const actions = [
    {
      _id: "answer-1",
      actionType: "answer",
      proposedChanges: { commentId: 123 },
    },
    {
      _id: "follow-up-1",
      actionType: "follow_up",
      sourceCommentId: 456,
      proposedChanges: { commentId: 456 },
    },
  ];

  it("returns the existing follow-up for a repeated GitHub comment", () => {
    expect(findFollowUpActionByCommentId(actions, 456)?._id).toBe(
      "follow-up-1",
    );
  });

  it("does not confuse answer actions or different comments", () => {
    expect(findFollowUpActionByCommentId(actions, 123)).toBeUndefined();
    expect(findFollowUpActionByCommentId(actions, 999)).toBeUndefined();
  });
});
