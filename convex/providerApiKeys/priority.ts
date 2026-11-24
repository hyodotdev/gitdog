import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { KeyProvider } from "./crypto";

/** Without a saved choice, Claude runs first and OpenAI is the backup. */
export const DEFAULT_PRIMARY_PROVIDER: KeyProvider = "anthropic";

/** Which of the owner's keys generation tries first when both work. */
export async function readPrimaryProvider(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<KeyProvider> {
  const row = await ctx.db
    .query("providerKeyPreferences")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  return row?.primaryProvider ?? DEFAULT_PRIMARY_PROVIDER;
}

/** Both providers, the one that runs first leading. */
export function providerOrder(
  primary: KeyProvider,
): readonly [KeyProvider, KeyProvider] {
  return primary === "openai"
    ? ["openai", "anthropic"]
    : ["anthropic", "openai"];
}
