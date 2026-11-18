import { describe, expect, it } from "vitest";
import { getChatReservationLimits } from "../../../convex/_ai/chatBilling";
import {
  cachedPrefixBytes,
  chatRequestBytes,
} from "../../../convex/_ai/requestSize";
import type { ChatMessage } from "../../../convex/_ai/model";

const system: ChatMessage = { role: "system", content: "Review carefully" };
const long = "x".repeat(20_000);

describe("prompt cache reservations", () => {
  it("holds the cache write premium only for the cacheable prefix", () => {
    const plain: ChatMessage[] = [
      system,
      { role: "user", content: [{ type: "text", text: long }] },
    ];
    const marked: ChatMessage[] = [
      system,
      {
        role: "user",
        content: [
          { type: "text", text: long, cache: true },
          { type: "text", text: "Turn state" },
        ],
      },
    ];
    // Without a marker only the system prompt and tools can be written.
    expect(cachedPrefixBytes(plain)).toBeLessThan(200);
    expect(getChatReservationLimits(plain).inputTokenLimit).toBe(
      chatRequestBytes(plain) + Math.ceil(cachedPrefixBytes(plain) * 0.25),
    );
    // A marked prefix may be written in full, and the turn state after it
    // never is.
    expect(cachedPrefixBytes(marked)).toBeGreaterThan(20_000);
    expect(cachedPrefixBytes(marked)).toBeLessThan(chatRequestBytes(marked));
    expect(getChatReservationLimits(marked).inputTokenLimit).toBe(
      chatRequestBytes(marked) + Math.ceil(cachedPrefixBytes(marked) * 0.25),
    );
  });
});
