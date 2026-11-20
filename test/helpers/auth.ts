import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import { registerCore, sessionIdentity } from "@convex-dev/auth/test";
import { components } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

type AnyTestConvex = TestConvex<SchemaDefinition<GenericSchema, boolean>>;

const withCore = new WeakSet<object>();

/**
 * Call as `userId` through a real @convex-dev/auth session, as a signed-in
 * client would: the access token's subject is a session in the core
 * component, and getAuthUserId resolves the user through it.
 */
export async function asUser<T extends AnyTestConvex>(
  t: T,
  userId: Id<"users">,
): Promise<ReturnType<T["withIdentity"]>> {
  // Convex Auth checks token issuers against the deployment's cloud URL.
  process.env.CONVEX_CLOUD_URL ??= "https://gitdog-test.convex.cloud";
  if (!withCore.has(t)) {
    registerCore(t);
    withCore.add(t);
  }
  const tokens = await t.run(async (ctx) =>
    ctx.runMutation(components.auth.public._internal_dangerous_signIn, {
      claims: { method: "github", profile: {} },
      componentPath: "authGithub",
      userId,
      accessTokenTtlSeconds: 60,
      refreshInactivityTimeoutSeconds: 30 * 24 * 60 * 60,
      sessionMaxLifetimeSeconds: 30 * 24 * 60 * 60,
    }),
  );
  return t.withIdentity(sessionIdentity(tokens)) as ReturnType<
    T["withIdentity"]
  >;
}
