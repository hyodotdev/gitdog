import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { internal } from "../../../convex/_generated/api";
import {
  CURRENT_PRIVACY_POLICY_VERSION,
  CURRENT_TERMS_VERSION,
} from "../../../convex/users/legal";
import { DIRECT_REQUESTER_LEGAL_ATTESTATION_REQUIRED_MESSAGE } from "../../../convex/_ai/legalAttestation";
import schema from "../../../convex/schema";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/ticketActions/internalAction.ts": () =>
    import("../../../convex/ticketActions/internalAction"),
  "../../../convex/ticketActions/internalQuery.ts": () =>
    import("../../../convex/ticketActions/internalQuery"),
  "../../../convex/ticketActions/internalMutation.ts": () =>
    import("../../../convex/ticketActions/internalMutation"),
  "../../../convex/tickets/internalQuery.ts": () =>
    import("../../../convex/tickets/internalQuery"),
  "../../../convex/users/internalQuery.ts": () =>
    import("../../../convex/users/internalQuery"),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("direct-requester follow-up legal gate", () => {
  it("rechecks a persisted requester before resuming and stops when policy becomes stale", async () => {
    const t = convexTest(schema, modules);
    const { actionId, profileId } = await t.run(async (ctx) => {
      const now = Date.now();
      const ownerId = await ctx.db.insert("users", {});
      const requesterId = await ctx.db.insert("users", {});
      const profileId = await ctx.db.insert("userProfiles", {
        userId: requesterId,
        githubUsername: "requester",
        minimumAgeAttestedAt: now,
        professionalUseAttestedAt: now,
        termsAcceptedVersion: CURRENT_TERMS_VERSION,
        privacyPolicyAcceptedVersion: CURRENT_PRIVACY_POLICY_VERSION,
        createdAt: now,
        updatedAt: now,
      });
      const ticketId = await ctx.db.insert("tickets", {
        aiInputVersion: 1,
        userId: ownerId,
        githubRepo: "owner/repo",
        ticketType: "issue",
        githubNumber: 42,
        githubTitle: "Question",
        status: "open",
        createdAt: now,
      });
      const actionId = await ctx.db.insert("ticketActions", {
        ticketId,
        requestedByUserId: requesterId,
        actionType: "follow_up",
        chatHistory: [],
        proposalVersion: 0,
        status: "pending",
        createdAt: now,
      });
      await ctx.db.delete(ticketId);
      return { actionId, profileId };
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await t.run(async (ctx) => {
      await ctx.db.patch(profileId, {
        termsAcceptedVersion: "2025-01-01",
      });
    });
    await t.action(internal.ticketActions.internalAction.processFollowUp, {
      actionId,
    });

    await expect(
      t.run(async (ctx) => await ctx.db.get(actionId)),
    ).resolves.toMatchObject({
      status: "failed",
      errorMessage: DIRECT_REQUESTER_LEGAL_ATTESTATION_REQUIRED_MESSAGE,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
