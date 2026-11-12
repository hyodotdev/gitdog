import type { convexTest } from "convex-test";
import type { FunctionArgs, FunctionReference } from "convex/server";
import { vi } from "vitest";

type TestBackend = ReturnType<typeof convexTest>;

/** Observe the same pinned transaction clock as the mutation under test. */
export async function mutationWithTime<
  Ref extends FunctionReference<"mutation", "public" | "internal">,
>(t: TestBackend, reference: Ref, args: FunctionArgs<Ref>) {
  return await t.run(async (ctx) => ({
    now: Date.now(),
    result: await ctx.runMutation(reference, args),
  }));
}

/** Advance only after current work settles, so watchdogs cannot overtake it. */
export async function runNextScheduledFunctions(
  t: TestBackend,
): Promise<boolean> {
  await t.finishInProgressScheduledFunctions();
  const next = await t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    return jobs
      .filter((job) => job.state.kind === "pending")
      .sort((a, b) => a.scheduledTime - b.scheduledTime)[0];
  });
  if (!next) return false;
  await vi.advanceTimersByTimeAsync(
    Math.max(1, Math.ceil(next.scheduledTime - Date.now())),
  );
  await t.finishInProgressScheduledFunctions();
  return true;
}

export async function drainScheduledFunctions(t: TestBackend): Promise<void> {
  for (let i = 0; i < 1_000; i++) {
    if (!(await runNextScheduledFunctions(t))) return;
  }
  throw new Error("Scheduled work did not settle within 1,000 batches");
}
