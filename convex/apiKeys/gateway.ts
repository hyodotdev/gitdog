import { internalMutation } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { v } from "convex/values";
import { authorizeKey, apiError } from "./security";
import { toPublicRepository } from "../repositories/query";
import { toPublicTicket } from "../tickets/query";
import { toPublicTicketAction } from "../ticketActions/query";
import {
  getIncrementalIndexStaleAt,
  INDEXING_STALE_THRESHOLD_MS,
} from "../repoIndexing/readiness";
import { getTrustedLearningRepositoryKey } from "../repoLearnings/trust";

const WRITE_PATHS = new Set([
  "repositories/mutation:updateSettings",
  "tickets/mutation:softDelete",
  "tickets/mutation:restore",
]);
const BOOLEAN_SETTINGS = [
  "pullRequestReviewsEnabled",
  "pullRequestSuggestionsEnabled",
  "requireApprovalForPullRequests",
  "issueAssistantEnabled",
  "autoFormatIssue",
  "autoAnswerQuestions",
  "tagMaintainersForCodeChanges",
  "requireApproval",
  "discussionAssistantEnabled",
  "autoFormatDiscussion",
  "autoAnswerDiscussionQuestions",
  "tagMaintainersForDiscussionCodeChanges",
  "requireApprovalForDiscussions",
];
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    apiError("BAD_REQUEST", "Expected a JSON object.");
  return value as Record<string, unknown>;
}
function number(
  value: unknown,
  fallback: number,
  minimum = 1,
  maximum = 500,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    apiError("BAD_REQUEST", "Invalid pagination limit or offset.");
  return value;
}
function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 500)
    apiError("BAD_REQUEST", "A string argument is missing or invalid.");
  return value;
}
function only(args: Record<string, unknown>, keys: string[]) {
  if (Object.keys(args).some((key) => !keys.includes(key)))
    apiError("BAD_REQUEST", "Unexpected operation arguments.");
}
function projectMatch(
  repo: Doc<"repositories">,
  args: Record<string, unknown>,
) {
  if (args.repositoryId !== undefined && args.repositoryId !== repo._id)
    apiError("FORBIDDEN", "This key belongs to a different project.");
  if (
    args.githubRepo !== undefined &&
    string(args.githubRepo).toLowerCase() !== repo.githubRepo.toLowerCase()
  )
    apiError("FORBIDDEN", "This key belongs to a different project.");
}
async function ticketById(
  ctx: MutationCtx,
  value: unknown,
  repository: Doc<"repositories">,
  includeDeleted = false,
) {
  const id = ctx.db.normalizeId("tickets", string(value));
  const ticket = id ? await ctx.db.get(id) : null;
  if (
    !ticket ||
    ticket.repositoryId !== repository._id ||
    ticket.userId !== repository.userId ||
    ticket.githubLifecycleOnly ||
    (!includeDeleted && ticket.deletedAt !== undefined)
  )
    apiError("NOT_FOUND", "Ticket not found in this project.");
  return ticket;
}
type ReadBudget = { bytes: number };
function chargeRead(budget: ReadBudget, value: unknown) {
  budget.bytes -= new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (budget.bytes < 0)
    apiError(
      "BAD_REQUEST",
      "Ticket actions exceed the project API response byte budget.",
    );
}
async function ticketActions(
  ctx: MutationCtx,
  ticketId: Doc<"tickets">["_id"],
  budget: ReadBudget,
  pendingOnly = false,
) {
  const query = pendingOnly
    ? ctx.db
        .query("ticketActions")
        .withIndex("by_ticket_and_status", (q) =>
          q.eq("ticketId", ticketId).eq("status", "pending_approval"),
        )
    : ctx.db
        .query("ticketActions")
        .withIndex("by_ticket", (q) => q.eq("ticketId", ticketId));
  const actions = [];
  for await (const action of query) {
    chargeRead(budget, action);
    if (actions.length >= (pendingOnly ? 100 : 500))
      apiError(
        "BAD_REQUEST",
        "This ticket has too many actions for a single API response.",
      );
    actions.push(toPublicTicketAction(action));
  }
  return actions;
}

export const execute = internalMutation({
  args: {
    tokenHash: v.string(),
    kind: v.union(v.literal("query"), v.literal("mutation")),
    path: v.string(),
    argsJson: v.string(),
  },
  handler: async (ctx, request) => {
    const actionBudget: ReadBudget = { bytes: 6_000_000 };
    const write = WRITE_PATHS.has(request.path);
    const { repository: repo } = await authorizeKey(
      ctx,
      request.tokenHash,
      write ? "write" : "read",
    );
    if (request.kind !== (write ? "mutation" : "query"))
      apiError(
        "FORBIDDEN",
        "This operation is unavailable to project API keys.",
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(request.argsJson);
    } catch {
      apiError("BAD_REQUEST", "Invalid JSON arguments.");
    }
    const args = object(parsed);
    projectMatch(repo, args);
    switch (request.path) {
      case "repositories/query:list":
        only(args, []);
        return [{ ...toPublicRepository(repo), userRole: "owner" }];
      case "repositories/query:get": {
        only(args, ["owner", "repo"]);
        if (
          `${string(args.owner)}/${string(args.repo)}`.toLowerCase() !==
          repo.githubRepo.toLowerCase()
        )
          apiError("FORBIDDEN", "This key belongs to a different project.");
        return { ...toPublicRepository(repo), userRole: "owner" };
      }
      case "repositories/query:getById":
        only(args, ["repositoryId"]);
        if (args.repositoryId !== repo._id)
          apiError("FORBIDDEN", "This key belongs to a different project.");
        return { ...toPublicRepository(repo), userRole: "owner" };
      case "repositories/mutation:updateSettings": {
        only(args, ["repositoryId", "settings"]);
        if (args.repositoryId !== repo._id)
          apiError("FORBIDDEN", "This key belongs to a different project.");
        const patch = object(args.settings);
        const settings = { ...repo.settings };
        for (const [key, value] of Object.entries(patch)) {
          if (BOOLEAN_SETTINGS.includes(key)) {
            if (typeof value !== "boolean")
              apiError(
                "BAD_REQUEST",
                "Boolean settings require true or false.",
              );
          } else if (
            ["issueResponseStyle", "discussionResponseStyle"].includes(key)
          ) {
            if (typeof value !== "string" || value.length > 10_000)
              apiError(
                "BAD_REQUEST",
                "Response styles must contain at most 10000 characters.",
              );
          } else apiError("BAD_REQUEST", "Unknown project setting.");
          Object.assign(settings, { [key]: value });
        }
        await ctx.db.patch(repo._id, { settings, updatedAt: Date.now() });
        return repo._id;
      }
      case "repoIndexing/query:getIndexingStatus":
        only(args, ["repositoryId"]);
        return {
          status: repo.indexStatus,
          version: repo.indexVersion,
          lastIndexedAt: repo.lastIndexedAt,
          error: repo.indexError,
          ragStatus: repo.ragStatus,
          ragError: repo.ragError,
          ragLastIndexedAt: repo.ragLastIndexedAt,
          ragTotalChunks: repo.ragTotalChunks,
          ragIndexedChunks: repo.ragIndexedChunks,
          ragFailedChunks: repo.ragFailedChunks,
          isActive: repo.isActive,
          updatedAt: repo.updatedAt,
          progressAt: repo.indexProgressAt,
          staleAt: getIncrementalIndexStaleAt(repo),
          staleThresholdMs: INDEXING_STALE_THRESHOLD_MS,
          githubAccessRevoked: false,
          requiresReconnect: false,
          canRestoreGithubAccess: false,
          canReconnect: false,
          canRetry: false,
        };
      case "repoIndexing/query:getIndexingLogs":
        only(args, ["repositoryId", "limit"]);
        return (
          await ctx.db
            .query("repoIndexingLogs")
            .withIndex("by_repository_and_version", (q) =>
              q
                .eq("repositoryId", repo._id)
                .eq("indexVersion", repo.indexVersion),
            )
            .order("desc")
            .take(number(args.limit, 100))
        ).reverse();
      case "repoIndexing/query:getFileList":
        only(args, ["repositoryId", "limit"]);
        if (!repo.isActive)
          apiError(
            "FORBIDDEN",
            "Cached files are unavailable while the project is paused.",
          );
        return await ctx.db
          .query("repoFileMap")
          .withIndex("by_repository", (q) => q.eq("repositoryId", repo._id))
          .take(number(args.limit, 100));
      case "repoIndexing/query:getFileContent": {
        only(args, ["repositoryId", "filePath"]);
        if (!repo.isActive)
          apiError(
            "FORBIDDEN",
            "Cached files are unavailable while the project is paused.",
          );
        const file = await ctx.db
          .query("repoFileMap")
          .withIndex("by_repository_and_path", (q) =>
            q
              .eq("repositoryId", repo._id)
              .eq("filePath", string(args.filePath)),
          )
          .first();
        if (!file) return null;
        const blob = await ctx.db
          .query("repoFileBlobs")
          .withIndex("by_sha256", (q) => q.eq("sha256", file.sha256))
          .first();
        if (!blob) return null;
        const url = await ctx.storage.getUrl(blob.storageId);
        return url
          ? {
              filePath: file.filePath,
              sha256: file.sha256,
              language: file.language,
              size: file.size,
              isText: file.isText,
              url,
            }
          : null;
      }
      case "repoLearnings/query:countByRepository": {
        only(args, ["repositoryId"]);
        const page = await ctx.db
          .query("repoLearnings")
          .withIndex("by_repository_trust_key", (q) =>
            q.eq(
              "repositoryTrustKey",
              getTrustedLearningRepositoryKey(repo._id),
            ),
          )
          .paginate({
            numItems: 1001,
            cursor: null,
            maximumBytesRead: 4_000_000,
            maximumRowsRead: 1001,
          });
        if (!page.isDone || page.page.length > 1000)
          apiError(
            "BAD_REQUEST",
            "Learning count exceeds the API aggregation limit.",
          );
        return page.page.length;
      }
      case "tickets/query:list":
      case "tickets/query:listPendingApproval": {
        only(args, [
          "githubRepo",
          "status",
          "ticketType",
          "search",
          "limit",
          "offset",
        ]);
        const limit = number(args.limit, 20, 1, 500);
        const offset = number(args.offset, 0, 0, 1000);
        if (
          args.status !== undefined &&
          (typeof args.status !== "string" ||
            !["open", "closed"].includes(args.status))
        )
          apiError("BAD_REQUEST", "Invalid ticket status.");
        if (
          args.ticketType !== undefined &&
          (typeof args.ticketType !== "string" ||
            !["issue", "discussion", "pull_request"].includes(args.ticketType))
        )
          apiError("BAD_REQUEST", "Invalid ticket type.");
        const search =
          args.search === undefined
            ? undefined
            : string(args.search).toLowerCase();
        const page = await ctx.db
          .query("tickets")
          .withIndex("by_repository", (q) => q.eq("repositoryId", repo._id))
          .order("desc")
          .paginate({
            numItems: 1001,
            cursor: null,
            maximumBytesRead: 4_000_000,
            maximumRowsRead: 1001,
          });
        const rows = page.page;
        if (
          !page.isDone ||
          rows.length > 1000 ||
          new TextEncoder().encode(JSON.stringify(rows)).byteLength > 4_000_000
        )
          apiError(
            "BAD_REQUEST",
            "Ticket history exceeds the project API aggregation limit.",
          );
        const matching = rows.filter(
          (ticket) =>
            ticket.userId === repo.userId &&
            ticket.deletedAt === undefined &&
            !ticket.githubLifecycleOnly &&
            (args.status === undefined || ticket.status === args.status) &&
            (args.ticketType === undefined ||
              ticket.ticketType === args.ticketType) &&
            (search === undefined ||
              `${ticket.githubTitle} ${ticket.githubRepo} ${ticket.githubNumber}`
                .toLowerCase()
                .includes(search)),
        );
        if (request.path.endsWith("listPendingApproval")) {
          const pending = [];
          for (const ticket of matching) {
            if (ticket.status !== "open") continue;
            const first = await ctx.db
              .query("ticketActions")
              .withIndex("by_ticket_and_status", (q) =>
                q.eq("ticketId", ticket._id).eq("status", "pending_approval"),
              )
              .first();
            if (first) {
              chargeRead(actionBudget, first);
              pending.push(ticket);
            }
          }
          const items = [];
          for (const ticket of pending.slice(offset, offset + limit)) {
            const actions = await ticketActions(
              ctx,
              ticket._id,
              actionBudget,
              true,
            );
            items.push({
              ...toPublicTicket(ticket),
              pendingActions: actions,
            });
          }
          return { items, total: pending.length };
        }
        const items = [];
        for (const ticket of matching.slice(offset, offset + limit)) {
          const actions = await ticketActions(ctx, ticket._id, actionBudget);
          items.push({
            ...toPublicTicket(ticket),
            actionCount: actions.length,
            pendingActionCount: actions.filter(
              (action) => action.status === "pending_approval",
            ).length,
          });
        }
        return { items, total: matching.length };
      }
      case "tickets/query:getById": {
        only(args, ["id"]);
        const ticket = await ticketById(ctx, args.id, repo);
        return {
          ...toPublicTicket(ticket),
          actions: await ticketActions(ctx, ticket._id, actionBudget),
        };
      }
      case "tickets/mutation:softDelete":
      case "tickets/mutation:restore": {
        only(args, ["id"]);
        const ticket = await ticketById(ctx, args.id, repo, true);
        const restore = request.path.endsWith(":restore");
        if (restore === (ticket.deletedAt === undefined))
          apiError(
            "BAD_REQUEST",
            restore ? "Ticket is not deleted." : "Ticket is already deleted.",
          );
        await ctx.db.patch(ticket._id, {
          deletedAt: restore ? undefined : Date.now(),
        });
        return { success: true };
      }
      case "ticketActions/query:listByTicket": {
        only(args, ["ticketId"]);
        const ticket = await ticketById(ctx, args.ticketId, repo);
        return await ticketActions(ctx, ticket._id, actionBudget);
      }
      case "ticketActions/query:getById": {
        only(args, ["id"]);
        const id = ctx.db.normalizeId("ticketActions", string(args.id));
        const action = id ? await ctx.db.get(id) : null;
        if (!action) apiError("NOT_FOUND", "Action not found in this project.");
        await ticketById(ctx, action.ticketId, repo);
        return toPublicTicketAction(action);
      }
      default:
        apiError(
          "UNSUPPORTED_OPERATION",
          "Project API keys cannot access this operation. Use a signed-in owner session.",
        );
    }
  },
});
