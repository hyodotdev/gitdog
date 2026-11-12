import { describe, expect, it, vi } from "vitest";

import {
  MAX_COLLECT_LIMIT,
  paginatedCollect,
} from "../../../convex/_utils/pagination";

describe("bounded query collection", () => {
  it("uses take so rows beyond the requested limit are not read", async () => {
    const take = vi.fn(async (limit: number) =>
      ["first", "second", "third"].slice(0, limit),
    );

    await expect(paginatedCollect({ take }, { maxItems: 2 })).resolves.toEqual([
      "first",
      "second",
    ]);
    expect(take).toHaveBeenCalledOnce();
    expect(take).toHaveBeenCalledWith(2);
  });

  it("caps untrusted limits at the shared collection maximum", async () => {
    const take = vi.fn(async () => [] as string[]);

    await paginatedCollect({ take }, { maxItems: MAX_COLLECT_LIMIT + 1_000 });

    expect(take).toHaveBeenCalledWith(MAX_COLLECT_LIMIT);
  });
});
