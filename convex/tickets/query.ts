import { query } from "../_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { paginatedCollect } from "../_utils/pagination";
import type { Doc } from "../_generated/dataModel";
import { toPublicTicketAction } from "../ticketActions/query";

export function toPublicTicket(ticket: Doc<"tickets">) {
  const {
    githubLifecycleOnly,
    githubInitialProcessingPending,
    githubInitialProcessingGeneration,
    githubInitialProcessingAiInputVersion,
    githubInitialProcessingExpiresAt,
    githubInitialProcessingLeaseUntil,
    githubInitialProcessingScheduleId,
    githubStateAttestationPending,
    ...publicTicket
  } = ticket;
  void githubLifecycleOnly;
  void githubInitialProcessingPending;
  void githubInitialProcessingGeneration;
  void githubInitialProcessingAiInputVersion;
  void githubInitialProcessingExpiresAt;
  void githubInitialProcessingLeaseUntil;
  void githubInitialProcessingScheduleId;
  void githubStateAttestationPending;
  return publicTicket;
}

/**
 * List all tickets for the current user
 */
export const list = query({
  args: {
    githubRepo: v.optional(v.string()),
    status: v.optional(v.union(v.literal("open"), v.literal("closed"))),
    ticketType: v.optional(
      v.union(
        v.literal("issue"),
        v.literal("discussion"),
        v.literal("pull_request"),
      ),
    ),
    search: v.optional(v.string()),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return { items: [], total: 0 };
    }

    const limit = args.limit ?? 20;
    const offset = args.offset ?? 0;

    // Build query
    let ticketsQuery = ctx.db
      .query("tickets")
      .withIndex("by_user", (q) => q.eq("userId", userId));

    // Filter by repo if specified
    if (args.githubRepo) {
      ticketsQuery = ctx.db
        .query("tickets")
        .withIndex("by_user_and_repo", (q) =>
          q.eq("userId", userId).eq("githubRepo", args.githubRepo!),
        );
    }

    const allTickets = await paginatedCollect(ticketsQuery.order("desc"));

    // Apply filters - exclude soft deleted tickets
    let filtered = allTickets.filter(
      (ticket) => !ticket.deletedAt && ticket.githubLifecycleOnly !== true,
    );

    if (args.status) {
      filtered = filtered.filter((t) => t.status === args.status);
    }

    if (args.ticketType) {
      filtered = filtered.filter((t) => t.ticketType === args.ticketType);
    }

    if (args.search) {
      const searchLower = args.search.toLowerCase();
      filtered = filtered.filter(
        (t) =>
          t.githubTitle.toLowerCase().includes(searchLower) ||
          t.githubRepo.toLowerCase().includes(searchLower) ||
          t.githubNumber.toString().includes(searchLower),
      );
    }

    const total = filtered.length;
    const items = filtered.slice(offset, offset + limit);

    // Get pending action count for each ticket
    // Use .take() for nested queries - only ONE paginate() call allowed per function
    const ticketsWithActionCount = await Promise.all(
      items.map(async (ticket) => {
        const actions = await ctx.db
          .query("ticketActions")
          .withIndex("by_ticket", (q) => q.eq("ticketId", ticket._id))
          .take(1000);

        const pendingCount = actions.filter(
          (a) => a.status === "pending_approval",
        ).length;

        return {
          ...toPublicTicket(ticket),
          actionCount: actions.length,
          pendingActionCount: pendingCount,
        };
      }),
    );

    return { items: ticketsWithActionCount, total };
  },
});

/**
 * Get a single ticket by ID with its actions
 */
export const getById = query({
  args: {
    id: v.id("tickets"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return null;
    }

    const ticket = await ctx.db.get(args.id);
    if (
      !ticket ||
      ticket.userId !== userId ||
      ticket.deletedAt ||
      ticket.githubLifecycleOnly === true
    ) {
      return null;
    }

    const actions = await paginatedCollect(
      ctx.db
        .query("ticketActions")
        .withIndex("by_ticket", (q) => q.eq("ticketId", ticket._id))
        .order("asc"),
    );

    return {
      ...toPublicTicket(ticket),
      actions: actions.map(toPublicTicketAction),
    };
  },
});

/**
 * Get tickets with pending approval actions
 */
export const listPendingApproval = query({
  args: {
    githubRepo: v.optional(v.string()),
    ticketType: v.optional(
      v.union(
        v.literal("issue"),
        v.literal("discussion"),
        v.literal("pull_request"),
      ),
    ),
    search: v.optional(v.string()),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return { items: [], total: 0 };
    }

    const limit = args.limit ?? 20;
    const offset = args.offset ?? 0;

    // Build query with optional repository filter
    let ticketsQuery = ctx.db
      .query("tickets")
      .withIndex("by_user", (q) => q.eq("userId", userId));

    // Filter by repo if specified
    if (args.githubRepo) {
      ticketsQuery = ctx.db
        .query("tickets")
        .withIndex("by_user_and_repo", (q) =>
          q.eq("userId", userId).eq("githubRepo", args.githubRepo!),
        );
    }

    // Get all user's tickets (newest first) to count total - exclude deleted
    const allTickets = await paginatedCollect(
      ticketsQuery
        .filter((q) =>
          q.and(
            q.eq(q.field("status"), "open"),
            q.eq(q.field("deletedAt"), undefined),
          ),
        )
        .order("desc"),
    );

    // Filter to tickets that have pending approval actions
    // Use .take() for nested queries - only ONE paginate() call allowed per function
    const ticketsWithPending = await Promise.all(
      allTickets.map(async (ticket) => {
        const pendingActions = await ctx.db
          .query("ticketActions")
          .withIndex("by_ticket_and_status", (q) =>
            q.eq("ticketId", ticket._id).eq("status", "pending_approval"),
          )
          .take(100);

        if (pendingActions.length === 0) {
          return null;
        }

        return {
          ...ticket,
          pendingActions,
        };
      }),
    );

    let filteredTickets = ticketsWithPending.filter(
      (ticket): ticket is NonNullable<typeof ticket> =>
        ticket !== null && ticket.githubLifecycleOnly !== true,
    );

    // Apply ticket type filter if specified
    if (args.ticketType) {
      filteredTickets = filteredTickets.filter(
        (t) => t.ticketType === args.ticketType,
      );
    }

    if (args.search) {
      const searchLower = args.search.toLowerCase();
      filteredTickets = filteredTickets.filter(
        (ticket) =>
          ticket.githubTitle.toLowerCase().includes(searchLower) ||
          ticket.githubRepo.toLowerCase().includes(searchLower) ||
          ticket.githubNumber.toString().includes(searchLower),
      );
    }

    const total = filteredTickets.length;
    const items = filteredTickets
      .slice(offset, offset + limit)
      .map((ticket) => ({
        ...toPublicTicket(ticket),
        pendingActions: ticket.pendingActions.map(toPublicTicketAction),
      }));

    return { items, total };
  },
});
