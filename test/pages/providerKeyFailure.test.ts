import { describe, expect, it } from "vitest";
import {
  UserApiKeyError,
  type UserApiKeyErrorCode,
} from "../../convex/_ai/providerResolution";
import { getProviderKeyFailure } from "../../src/utils/errorMessages";

describe("provider key failure recognition", () => {
  it("recognizes every message the backend writes for a user-key failure", () => {
    const expected: Record<UserApiKeyErrorCode, string> = {
      invalid: "invalid",
      out_of_credit: "outOfCredit",
      rate_limited: "rateLimited",
      removed: "removed",
      unavailable: "unavailable",
      unreadable: "unreadable",
      service_unavailable: "serviceUnavailable",
    };
    for (const [code, kind] of Object.entries(expected)) {
      const error = new UserApiKeyError(code as UserApiKeyErrorCode, "openai");
      expect(getProviderKeyFailure(error.message)).toMatchObject({ kind });
    }
    expect(
      getProviderKeyFailure(
        "Your AI provider API key is no longer available. Add it again in Gitdog settings",
      ),
    ).toEqual({ kind: "unavailable", provider: undefined });
    expect(getProviderKeyFailure("Token limit reached.")).toBeNull();
  });
});
