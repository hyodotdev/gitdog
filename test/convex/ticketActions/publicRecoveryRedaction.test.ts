import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "../../../convex/_generated/api";
import schema from "../../../convex/schema";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/tickets/query.ts": () =>
    import("../../../convex/tickets/query"),
  "../../../convex/ticketActions/query.ts": () =>
    import("../../../convex/ticketActions/query"),
  "../../../convex/tickets/internalMutation.ts": () =>
    import("../../../convex/tickets/internalMutation"),
};

describe("public ticket recovery redaction", () => {
  it("does not expose scheduler leases, targets, or checkpoint keys", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      const ticketId = await ctx.db.insert("tickets", {
        userId,
        githubRepo: "owner/repo",
        ticketType: "issue",
        githubNumber: 1,
        githubTitle: "Issue",
        aiInputVersion: 1,
        status: "open",
        githubInitialProcessingPending: true,
        githubInitialProcessingGeneration: 9,
        githubInitialProcessingAiInputVersion: 1,
        githubInitialProcessingExpiresAt: now + 60_000,
        githubInitialProcessingLeaseUntil: now + 30_000,
        githubStateAttestationPending: true,
        createdAt: now,
      });
      const scheduleId = await ctx.scheduler.runAfter(
        60_000,
        internal.tickets.internalMutation.clearInitialTicketProcessing,
        {
          ticketId,
          expectedAiInputVersion: 1,
          initialProcessingGeneration: 9,
        },
      );
      await ctx.db.patch(ticketId, {
        githubInitialProcessingScheduleId: scheduleId,
      });
      const actionId = await ctx.db.insert("ticketActions", {
        ticketId,
        actionType: "answer",
        chatHistory: [],
        proposalVersion: 0,
        status: "pending",
        resultCheckpointKey: "private-checkpoint",
        resultCheckpointExpiresAt: now + 60_000,
        resultRecoveryLeaseUntil: now + 30_000,
        resultRecoveryScheduleId: scheduleId,
        pendingGenerationTarget: {
          kind: "initial_ticket",
          stage: "answer",
          expectedAiInputVersion: 1,
          expectedIndexVersion: 1,
        },
        pendingGenerationExpiresAt: now + 60_000,
        pendingGenerationScheduleId: scheduleId,
        pendingGenerationLeaseUntil: now + 30_000,
        providerRetryStartedAt: now,
        autoExecutionRecoveryExpiresAt: now + 60_000,
        autoExecutionRecoveryLeaseUntil: now + 30_000,
        autoExecutionRecoveryScheduleId: scheduleId,
        executionIdempotencyKey: "00000000-0000-4000-8000-000000000000",
        executionRecoveryMode: "auto_approved",
        executionRecoveryReconcileOnly: true,
        executionRecoveryReconcileDeadlineAt: now + 45_000,
        executionRecoveryExpiresAt: now + 60_000,
        executionRecoveryLeaseUntil: now + 30_000,
        executionRecoveryScheduleId: scheduleId,
        createdAt: now,
      });
      return { userId, ticketId, actionId };
    });
    const caller = t.withIdentity({
      subject: `${fixture.userId}|test-session`,
    });

    const [tickets, ticket, actions, action] = await Promise.all([
      caller.query(api.tickets.query.list, {}),
      caller.query(api.tickets.query.getById, { id: fixture.ticketId }),
      caller.query(api.ticketActions.query.listByTicket, {
        ticketId: fixture.ticketId,
      }),
      caller.query(api.ticketActions.query.getById, { id: fixture.actionId }),
    ]);
    const publicTickets = [tickets.items[0], ticket];
    for (const publicTicket of publicTickets) {
      expect(publicTicket).not.toHaveProperty("githubInitialProcessingPending");
      expect(publicTicket).not.toHaveProperty(
        "githubInitialProcessingGeneration",
      );
      expect(publicTicket).not.toHaveProperty(
        "githubInitialProcessingAiInputVersion",
      );
      expect(publicTicket).not.toHaveProperty(
        "githubInitialProcessingScheduleId",
      );
      expect(publicTicket).not.toHaveProperty("githubStateAttestationPending");
    }
    for (const publicAction of [actions[0], action]) {
      expect(publicAction).not.toHaveProperty("resultCheckpointKey");
      expect(publicAction).not.toHaveProperty("pendingGenerationTarget");
      expect(publicAction).not.toHaveProperty("pendingGenerationScheduleId");
      expect(publicAction).not.toHaveProperty(
        "autoExecutionRecoveryScheduleId",
      );
      expect(publicAction).not.toHaveProperty(
        "autoExecutionRecoveryLeaseUntil",
      );
      expect(publicAction).not.toHaveProperty("executionIdempotencyKey");
      expect(publicAction).not.toHaveProperty("executionRecoveryMode");
      expect(publicAction).not.toHaveProperty("executionRecoveryReconcileOnly");
      expect(publicAction).not.toHaveProperty(
        "executionRecoveryReconcileDeadlineAt",
      );
      expect(publicAction).not.toHaveProperty("executionRecoveryExpiresAt");
      expect(publicAction).not.toHaveProperty("executionRecoveryLeaseUntil");
      expect(publicAction).not.toHaveProperty("executionRecoveryScheduleId");
    }
  });
});
