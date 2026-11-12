import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import type { AiProvider } from "./model";

export const AI_LEGAL_ATTESTATION_REQUIRED_MESSAGE =
  "Repository owner must confirm current account eligibility at https://gitdog.dev/legal/consent before AI automation can continue.";
export const DIRECT_REQUESTER_LEGAL_ATTESTATION_REQUIRED_MESSAGE =
  "The GitHub user requesting this AI action must sign in to Gitdog and confirm current account eligibility at https://gitdog.dev/legal/consent.";

export class AiLegalAttestationRequiredError extends Error {
  constructor() {
    super(AI_LEGAL_ATTESTATION_REQUIRED_MESSAGE);
    this.name = "AiLegalAttestationRequiredError";
  }
}

export class DirectRequesterLegalAttestationRequiredError extends Error {
  constructor() {
    super(DIRECT_REQUESTER_LEGAL_ATTESTATION_REQUIRED_MESSAGE);
    this.name = "DirectRequesterLegalAttestationRequiredError";
  }
}

export async function hasCurrentAiLegalAttestation(
  ctx: ActionCtx,
  userId: Id<"users">,
): Promise<boolean> {
  return await ctx.runQuery(
    internal.users.internalQuery.hasStrictCurrentLegalAttestation,
    { userId },
  );
}

export async function requireCurrentAiLegalAttestation(
  ctx: ActionCtx,
  userId: Id<"users">,
): Promise<void> {
  if (!(await hasCurrentAiLegalAttestation(ctx, userId))) {
    throw new AiLegalAttestationRequiredError();
  }
}

export async function hasStrictCurrentAiLegalAttestation(
  ctx: ActionCtx,
  userId: Id<"users">,
): Promise<boolean> {
  return await ctx.runQuery(
    internal.users.internalQuery.hasStrictCurrentLegalAttestation,
    { userId },
  );
}

export async function requireStrictCurrentAiLegalAttestation(
  ctx: ActionCtx,
  userId: Id<"users">,
): Promise<void> {
  if (!(await hasStrictCurrentAiLegalAttestation(ctx, userId))) {
    throw new DirectRequesterLegalAttestationRequiredError();
  }
}

export function guardAiProviderWithStrictCurrentLegalAttestation(
  ctx: ActionCtx,
  userId: Id<"users">,
  provider: AiProvider,
): AiProvider {
  return {
    get name() {
      return provider.name;
    },
    get modelId() {
      return provider.modelId;
    },
    get providerId() {
      return provider.providerId;
    },
    chat: async (messages, options) => {
      await requireStrictCurrentAiLegalAttestation(ctx, userId);
      return await provider.chat(messages, options);
    },
  };
}

export function guardAiProviderWithCurrentLegalAttestation(
  ctx: ActionCtx,
  userId: Id<"users">,
  provider: AiProvider,
): AiProvider {
  return {
    get name() {
      return provider.name;
    },
    get modelId() {
      return provider.modelId;
    },
    get providerId() {
      return provider.providerId;
    },
    chat: async (messages, options) => {
      await requireCurrentAiLegalAttestation(ctx, userId);
      return await provider.chat(messages, options);
    },
  };
}
