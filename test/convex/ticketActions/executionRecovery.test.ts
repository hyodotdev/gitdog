import { describe, expect, it } from "vitest";

import {
  attachExecutionMarker,
  buildExecutionMarker,
  classifyFormatExecutionReconciliation,
  stripExecutionMarkers,
} from "../../../convex/ticketActions/executionRecovery";

const key = "00000000-0000-4000-8000-000000000000";
const marker = buildExecutionMarker(key);
const expectedBody = attachExecutionMarker("Formatted body", key);

describe("claimed execution recovery", () => {
  it.each([
    {
      name: "observes the completed write",
      liveTitle: "Formatted title",
      liveBody: expectedBody,
      expected: "already_applied",
    },
    {
      name: "retries exactly from the unchanged source snapshot",
      liveTitle: "Original title",
      liveBody: "Original body",
      expected: "safe_to_apply",
    },
    {
      name: "fails closed for divergent live content",
      liveTitle: "Human title",
      liveBody: "Human body",
      expected: "conflict",
    },
  ])("$name", ({ liveTitle, liveBody, expected }) => {
    expect(
      classifyFormatExecutionReconciliation({
        liveState: "open",
        liveTitle,
        liveBody,
        originalTitle: "Original title",
        originalBody: "Original body",
        expectedTitle: "Formatted title",
        expectedBody,
        marker,
      }),
    ).toBe(expected);
  });

  it("recognizes a completed marker even after a later user edit", () => {
    expect(
      classifyFormatExecutionReconciliation({
        liveState: "closed",
        liveTitle: "Later title",
        liveBody: `${expectedBody}\nLater edit`,
        originalTitle: "Original title",
        originalBody: "Original body",
        expectedTitle: "Formatted title",
        expectedBody,
        marker,
      }),
    ).toBe("already_applied");
  });

  it("strips private execution markers before AI context is built", () => {
    expect(stripExecutionMarkers(expectedBody)).toBe("Formatted body");
  });
});
