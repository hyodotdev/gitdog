import type { Doc, Id } from "../_generated/dataModel";
import { chatModelName } from "../_ai/config";

type UsageRow = Doc<"tokenUsage">;

export type UsageSum = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  // What the provider billed for own-key rows; Gitdog's cost for the rest.
  costCents: number;
  // Gitdog tokens the rows counted against the owner's quota.
  quotaTokens: number;
};

export type ModelUsage = UsageSum & {
  provider: UsageRow["provider"];
  modelId: string;
  name: string;
  actions: number;
};

export type ActionUsage = UsageSum & {
  ticketActionId: Id<"ticketActions">;
  // A fallback may serve part of an action, so it can list several models.
  models: string[];
  lastAt: number;
};

const emptySum = (): UsageSum => ({
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  costCents: 0,
  quotaTokens: 0,
});

function addRow(sum: UsageSum, row: UsageRow): void {
  sum.requests += 1;
  sum.inputTokens += row.inputTokens;
  sum.outputTokens += row.outputTokens;
  sum.costCents += row.baseCostCents;
  if (row.keySource !== "user") sum.quotaTokens += row.totalTokens;
}

// A refusal fallback may serve a request; its cost is priced at that model.
const servedModelId = (row: UsageRow) => row.servedModel ?? row.model;

/**
 * Own-key usage by model, repository and action. Actions come newest first,
 * so the first ones are what the owner ran most recently.
 */
export function summarizeUserKeyUsage(rows: UsageRow[]) {
  const totals = emptySum();
  const models = new Map<string, ModelUsage & { actionIds: Set<string> }>();
  const repositories = new Map<
    string,
    { repositoryId?: Id<"repositories">; costCents: number }
  >();
  const actions = new Map<string, ActionUsage>();

  for (const row of rows) {
    addRow(totals, row);
    const modelId = servedModelId(row);
    const modelKey = `${row.provider}/${modelId}`;
    const model = models.get(modelKey) ?? {
      ...emptySum(),
      provider: row.provider,
      modelId,
      name: chatModelName(modelId),
      actions: 0,
      actionIds: new Set<string>(),
    };
    addRow(model, row);
    if (row.ticketActionId) model.actionIds.add(row.ticketActionId);
    models.set(modelKey, model);

    const repositoryKey = row.repositoryId ?? "";
    const repository = repositories.get(repositoryKey) ?? {
      ...(row.repositoryId ? { repositoryId: row.repositoryId } : {}),
      costCents: 0,
    };
    repository.costCents += row.baseCostCents;
    repositories.set(repositoryKey, repository);

    if (!row.ticketActionId) continue;
    const action = actions.get(row.ticketActionId) ?? {
      ...emptySum(),
      ticketActionId: row.ticketActionId,
      models: [],
      lastAt: 0,
    };
    addRow(action, row);
    const name = chatModelName(modelId);
    if (!action.models.includes(name)) action.models.push(name);
    action.lastAt = Math.max(action.lastAt, row.createdAt);
    actions.set(row.ticketActionId, action);
  }

  return {
    totals: { ...totals, actions: actions.size },
    models: [...models.values()]
      .map(({ actionIds, ...model }) => ({ ...model, actions: actionIds.size }))
      .sort((a, b) => b.costCents - a.costCents),
    repositories: [...repositories.values()],
    actions: [...actions.values()].sort((a, b) => b.lastAt - a.lastAt),
  };
}

/** What one action used, split by whose key paid for it. */
export function summarizeActionUsage(rows: UsageRow[]) {
  const sides = {
    userKey: null as (UsageSum & { models: string[] }) | null,
    gitdog: null as (UsageSum & { models: string[] }) | null,
  };
  for (const row of rows) {
    const side = row.keySource === "user" ? "userKey" : "gitdog";
    const entry = (sides[side] ??= { ...emptySum(), models: [] });
    addRow(entry, row);
    const name = chatModelName(servedModelId(row));
    if (!entry.models.includes(name)) entry.models.push(name);
  }
  return sides;
}
