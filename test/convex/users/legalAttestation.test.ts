import { convexTest } from "convex-test";
import { v } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "../../../convex/_generated/api";
import {
  canAcceptDisplayedLegalPolicyVersion,
  CURRENT_PRIVACY_POLICY_VERSION,
  CURRENT_TERMS_VERSION,
  hasCurrentLegalAttestation,
  isValidLegalPolicyVersion,
  requiresCurrentLegalAttestation,
  satisfiesCurrentLegalAttestationRequirement,
} from "../../../convex/users/legal";
import schema from "../../../convex/schema";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  internalAction,
  type ActionCtx,
} from "../../../convex/_generated/server";
import {
  AI_LEGAL_ATTESTATION_REQUIRED_MESSAGE,
  guardAiProviderWithCurrentLegalAttestation,
} from "../../../convex/_ai/legalAttestation";
import type { AiProvider } from "../../../convex/_ai/model";

const noopGenerateChunkEmbeddings = internalAction({
  args: {
    repositoryId: v.id("repositories"),
    indexVersion: v.optional(v.number()),
  },
  handler: async () => ({
    success: true,
    totalChunks: 0,
    successCount: 0,
    errorCount: 0,
  }),
});

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/users/mutation.ts": () =>
    import("../../../convex/users/mutation"),
  "../../../convex/users/query.ts": () => import("../../../convex/users/query"),
  "../../../convex/users/internalQuery.ts": () =>
    import("../../../convex/users/internalQuery"),
  "../../../convex/github/internalQuery.ts": () =>
    import("../../../convex/github/internalQuery"),
  "../../../convex/ragV2/internalMutation.ts": () =>
    import("../../../convex/ragV2/internalMutation"),
  "../../../convex/ragV2/action.ts": async () => ({
    generateChunkEmbeddings: noopGenerateChunkEmbeddings,
  }),
};

const confirmation = {
  minimumAgeConfirmed: true,
  professionalUseConfirmed: true,
  termsAccepted: true,
  privacyPolicyAccepted: true,
  displayedTermsVersion: CURRENT_TERMS_VERSION,
  displayedPrivacyPolicyVersion: CURRENT_PRIVACY_POLICY_VERSION,
} as const;

async function drainScheduledFunctions(
  t: ReturnType<typeof convexTest>,
): Promise<void> {
  await t.finishAllScheduledFunctions(() => vi.advanceTimersToNextTimer());
  await t.finishInProgressScheduledFunctions();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("user legal eligibility attestation", () => {
  it("validates exact calendar-date policy versions", () => {
    for (const version of ["2026-07-19", "2024-02-29", "9999-12-31"]) {
      expect(isValidLegalPolicyVersion(version)).toBe(true);
    }
    for (const version of [
      "2026-7-19",
      "2026-00-01",
      "2026-02-29",
      "2024-02-30",
      "0000-01-01",
      "2026-07-19T00:00:00Z",
    ]) {
      expect(isValidLegalPolicyVersion(version)).toBe(false);
    }

    expect(
      canAcceptDisplayedLegalPolicyVersion("2026-07-19", "2026-07-19"),
    ).toBe(true);
    expect(
      canAcceptDisplayedLegalPolicyVersion("2026-07-20", "2026-07-19"),
    ).toBe(false);
    expect(
      canAcceptDisplayedLegalPolicyVersion("2026-07-18", "2026-07-19"),
    ).toBe(false);
    expect(
      canAcceptDisplayedLegalPolicyVersion("not-a-date", "2026-07-19"),
    ).toBe(false);
    expect(
      canAcceptDisplayedLegalPolicyVersion("2026-07-19", "not-a-date"),
    ).toBe(false);
  });

  it("always requires current legal attestation", () => {
    expect(requiresCurrentLegalAttestation(null)).toBe(true);
    expect(satisfiesCurrentLegalAttestationRequirement(null)).toBe(false);
  });

  it("rejects malformed attestation timestamps", () => {
    const currentVersions = {
      termsAcceptedVersion: CURRENT_TERMS_VERSION,
      privacyPolicyAcceptedVersion: CURRENT_PRIVACY_POLICY_VERSION,
    };

    expect(
      hasCurrentLegalAttestation({
        ...currentVersions,
        minimumAgeAttestedAt: 0,
        professionalUseAttestedAt: Date.now(),
      }),
    ).toBe(false);
    expect(
      hasCurrentLegalAttestation({
        ...currentVersions,
        minimumAgeAttestedAt: Date.now(),
        professionalUseAttestedAt: 1.5,
      }),
    ).toBe(false);
  });

  it("requires authentication and explicit affirmative values", async () => {
    const t = convexTest(schema, modules);

    await expect(
      t.mutation(api.users.mutation.attestLegalEligibility, confirmation),
    ).rejects.toThrow("Not authenticated");

    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "octocat" }),
    );
    const authenticated = t.withIdentity({
      subject: `${userId}|test-session`,
    });

    await expect(
      authenticated.mutation(api.users.mutation.attestLegalEligibility, {
        ...confirmation,
        minimumAgeConfirmed: false,
      } as unknown as typeof confirmation),
    ).rejects.toThrow();
    await expect(
      authenticated.mutation(api.users.mutation.attestLegalEligibility, {
        ...confirmation,
        professionalUseConfirmed: false,
      } as unknown as typeof confirmation),
    ).rejects.toThrow();
  });

  it("rejects stale displayed policy versions without writing attestation state", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "octocat" }),
    );
    const authenticated = t.withIdentity({
      subject: `${userId}|test-session`,
    });

    await expect(
      authenticated.mutation(api.users.mutation.attestLegalEligibility, {
        ...confirmation,
        displayedTermsVersion: "2025-01-01",
      }),
    ).rejects.toThrow("LEGAL_POLICY_VERSION_MISMATCH");
    await expect(
      authenticated.mutation(api.users.mutation.attestLegalEligibility, {
        ...confirmation,
        displayedPrivacyPolicyVersion: "2025-01-01",
      }),
    ).rejects.toThrow("LEGAL_POLICY_VERSION_MISMATCH");

    const state = await t.run(async (ctx) => ({
      profiles: await ctx.db
        .query("userProfiles")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(2),
      scheduled: await ctx.db.system.query("_scheduled_functions").take(1),
    }));
    expect(state).toEqual({ profiles: [], scheduled: [] });
  });

  it("rejects future displayed policy versions", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "octocat" }),
    );
    const authenticated = t.withIdentity({
      subject: `${userId}|test-session`,
    });

    await expect(
      authenticated.mutation(api.users.mutation.attestLegalEligibility, {
        ...confirmation,
        displayedTermsVersion: "2026-07-20",
        displayedPrivacyPolicyVersion: "2026-08-01",
      }),
    ).rejects.toThrow("LEGAL_POLICY_VERSION_MISMATCH");

    const profiles = await t.run(async (ctx) =>
      ctx.db
        .query("userProfiles")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(2),
    );
    expect(profiles).toEqual([]);
  });

  it("creates a durable current attestation without exposing its raw fields", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        name: "octocat",
        image: "https://avatars.example/octocat.png",
      }),
    );
    const authenticated = t.withIdentity({
      subject: `${userId}|test-session`,
    });

    await expect(
      t.query(internal.users.internalQuery.hasCurrentLegalAttestation, {
        userId,
      }),
    ).resolves.toBe(false);
    await expect(
      authenticated.query(api.users.query.getCurrentUser, {}),
    ).resolves.toMatchObject({
      hasCurrentLegalAttestation: false,
      requiresCurrentLegalAttestation: true,
    });

    await expect(
      authenticated.mutation(
        api.users.mutation.attestLegalEligibility,
        confirmation,
      ),
    ).resolves.toEqual({ success: true });

    const currentUser = await authenticated.query(
      api.users.query.getCurrentUser,
      {},
    );
    expect(currentUser).toMatchObject({
      name: "octocat",
      hasCurrentLegalAttestation: true,
      requiresCurrentLegalAttestation: false,
      profile: {
        githubUsername: "octocat",
        displayName: "octocat",
      },
    });
    expect(currentUser?.profile).not.toHaveProperty("minimumAgeAttestedAt");
    expect(currentUser?.profile).not.toHaveProperty(
      "professionalUseAttestedAt",
    );
    expect(currentUser?.profile).not.toHaveProperty("termsAcceptedVersion");
    expect(currentUser?.profile).not.toHaveProperty(
      "privacyPolicyAcceptedVersion",
    );

    const profiles = await t.run(async (ctx) =>
      ctx.db
        .query("userProfiles")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(2),
    );
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      minimumAgeAttestedAt: expect.any(Number),
      professionalUseAttestedAt: expect.any(Number),
      termsAcceptedVersion: CURRENT_TERMS_VERSION,
      privacyPolicyAcceptedVersion: CURRENT_PRIVACY_POLICY_VERSION,
    });
    await expect(
      t.query(internal.users.internalQuery.hasCurrentLegalAttestation, {
        userId,
      }),
    ).resolves.toBe(true);
    await drainScheduledFunctions(t);
  });

  it("requires the professional or business-use attestation", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      await ctx.db.insert("userProfiles", {
        userId,
        githubUsername: "maintainer",
        minimumAgeAttestedAt: now,
        termsAcceptedVersion: CURRENT_TERMS_VERSION,
        privacyPolicyAcceptedVersion: CURRENT_PRIVACY_POLICY_VERSION,
        createdAt: now,
        updatedAt: now,
      });
      return userId;
    });

    await expect(
      t.query(internal.users.internalQuery.hasCurrentLegalAttestation, {
        userId,
      }),
    ).resolves.toBe(false);
  });

  it("requires re-attestation when either policy version is stale", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      await ctx.db.insert("userProfiles", {
        userId,
        githubUsername: "maintainer",
        minimumAgeAttestedAt: now,
        termsAcceptedVersion: "2025-01-01",
        privacyPolicyAcceptedVersion: CURRENT_PRIVACY_POLICY_VERSION,
        createdAt: now,
        updatedAt: now,
      });
      return userId;
    });
    const authenticated = t.withIdentity({
      subject: `${userId}|test-session`,
    });

    await expect(
      authenticated.query(api.users.query.getCurrentUser, {}),
    ).resolves.toMatchObject({ hasCurrentLegalAttestation: false });

    await authenticated.mutation(
      api.users.mutation.attestLegalEligibility,
      confirmation,
    );

    await expect(
      authenticated.query(api.users.query.getCurrentUser, {}),
    ).resolves.toMatchObject({ hasCurrentLegalAttestation: true });
    await expect(
      t.run(async (ctx) =>
        ctx.db
          .query("userProfiles")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .take(2),
      ),
    ).resolves.toHaveLength(1);
    await drainScheduledFunctions(t);
  });

  it("resolves a direct GitHub requester only from one live account and one current profile", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const now = Date.now();
      const insertCurrentProfile = async (userId: Id<"users">) =>
        await ctx.db.insert("userProfiles", {
          userId,
          githubUsername: "maintainer",
          minimumAgeAttestedAt: now,
          professionalUseAttestedAt: now,
          termsAcceptedVersion: CURRENT_TERMS_VERSION,
          privacyPolicyAcceptedVersion: CURRENT_PRIVACY_POLICY_VERSION,
          createdAt: now,
          updatedAt: now,
        });
      const insertAccount = async (
        userId: Id<"users">,
        providerAccountId: string,
      ) =>
        await ctx.db.insert("authAccounts", {
          userId,
          provider: "github",
          providerAccountId,
        });

      const currentUserId = await ctx.db.insert("users", {});
      await insertAccount(currentUserId, "77");
      await insertCurrentProfile(currentUserId);

      const missingProfileUserId = await ctx.db.insert("users", {});
      await insertAccount(missingProfileUserId, "78");

      const staleProfileUserId = await ctx.db.insert("users", {});
      await insertAccount(staleProfileUserId, "79");
      await ctx.db.insert("userProfiles", {
        userId: staleProfileUserId,
        githubUsername: "stale",
        minimumAgeAttestedAt: now,
        professionalUseAttestedAt: now,
        termsAcceptedVersion: "2025-01-01",
        privacyPolicyAcceptedVersion: CURRENT_PRIVACY_POLICY_VERSION,
        createdAt: now,
        updatedAt: now,
      });

      const duplicateAccountFirstUserId = await ctx.db.insert("users", {});
      const duplicateAccountSecondUserId = await ctx.db.insert("users", {});
      await insertAccount(duplicateAccountFirstUserId, "80");
      await insertAccount(duplicateAccountSecondUserId, "80");
      await insertCurrentProfile(duplicateAccountFirstUserId);
      await insertCurrentProfile(duplicateAccountSecondUserId);

      const duplicateProfileUserId = await ctx.db.insert("users", {});
      await insertAccount(duplicateProfileUserId, "81");
      await insertCurrentProfile(duplicateProfileUserId);
      await insertCurrentProfile(duplicateProfileUserId);

      const deletedUserId = await ctx.db.insert("users", {});
      await insertAccount(deletedUserId, "82");
      await ctx.db.delete(deletedUserId);

      return { currentUserId, duplicateProfileUserId, deletedUserId };
    });

    await expect(
      t.query(
        internal.github.internalQuery.getLegallyEligibleUserIdByGithubAccountId,
        { githubAccountId: "77" },
      ),
    ).resolves.toBe(ids.currentUserId);
    for (const githubAccountId of ["78", "79", "80", "81", "82", "0"]) {
      await expect(
        t.query(
          internal.github.internalQuery
            .getLegallyEligibleUserIdByGithubAccountId,
          { githubAccountId },
        ),
      ).resolves.toBeNull();
    }
    await expect(
      t.query(internal.users.internalQuery.hasStrictCurrentLegalAttestation, {
        userId: ids.currentUserId,
      }),
    ).resolves.toBe(true);
    await expect(
      t.query(internal.users.internalQuery.hasStrictCurrentLegalAttestation, {
        userId: ids.duplicateProfileUserId,
      }),
    ).resolves.toBe(false);
    await expect(
      t.query(internal.users.internalQuery.hasStrictCurrentLegalAttestation, {
        userId: ids.deletedUserId,
      }),
    ).resolves.toBe(false);
  });

  it("drains legally blocked repositories in bounded pages from cached files", async () => {
    const t = convexTest(schema, modules);
    const { userId, repositoryIds } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { name: "maintainer" });
      const now = Date.now();
      await ctx.db.insert("userProfiles", {
        userId,
        githubUsername: "maintainer",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 811,
        ownerGithubAccountId: "811",
        ownershipVerifiedAt: now,
        accountLogin: "maintainer",
        accountType: "Organization",
        targetType: "Organization",
        createdAt: now,
        updatedAt: now,
      });
      const repositoryIds = [];
      for (let index = 0; index < 11; index++) {
        repositoryIds.push(
          await ctx.db.insert("repositories", {
            indexSyncPending: false,
            indexProgressAt: Date.now(),
            ragTotalChunks: 0,
            ragIndexedChunks: 0,
            ragFailedChunks: 0,
            userId,
            installationId: 811,
            githubRepositoryId: 9_000 + index,
            githubRepo: `maintainer/repository-${index}`,
            githubRepoKey: `maintainer/repository-${index}`,
            name: `repository-${index}`,
            githubUrl: `https://github.com/maintainer/repository-${index}`,
            isActive: true,
            indexVersion: 7,
            indexStatus: "completed",
            ragStatus: "completed",
            ragEmbeddingMode: "keyword_only",
            ragLegalEligibilityBlockedAt: now + index,
            ragLegalEligibilityBlockedIndexVersion: 7,
            settings: {
              issueAssistantEnabled: true,
              autoFormatIssue: true,
              autoAnswerQuestions: true,
              tagMaintainersForCodeChanges: true,
              discussionAssistantEnabled: true,
              autoFormatDiscussion: true,
              autoAnswerDiscussionQuestions: true,
              tagMaintainersForDiscussionCodeChanges: true,
              requireApproval: false,
              requireApprovalForDiscussions: false,
            },
            monthlyActions: 0,
            lastResetAt: now,
            createdAt: now,
            updatedAt: now,
          }),
        );
      }
      return { userId, repositoryIds };
    });
    const authenticated = t.withIdentity({
      subject: `${userId}|test-session`,
    });

    await authenticated.mutation(
      api.users.mutation.attestLegalEligibility,
      confirmation,
    );
    await expect(
      t.mutation(
        internal.users.mutation.resumeLegalEligibilityBlockedRepositories,
        { userId },
      ),
    ).resolves.toEqual({
      scanned: 10,
      scheduled: 10,
      cleared: 0,
      hasMore: true,
    });
    await expect(
      t.mutation(
        internal.users.mutation.resumeLegalEligibilityBlockedRepositories,
        { userId },
      ),
    ).resolves.toEqual({
      scanned: 1,
      scheduled: 1,
      cleared: 0,
      hasMore: false,
    });

    const state = await t.run(async (ctx) => ({
      repositories: await Promise.all(
        repositoryIds.map((repositoryId) => ctx.db.get(repositoryId)),
      ),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    for (const repository of state.repositories) {
      expect(repository?.ragStatus).toBe("pending");
      expect(repository?.ragEmbeddingMode).toBeUndefined();
      expect(repository?.ragLegalEligibilityBlockedAt).toBeUndefined();
      expect(
        repository?.ragLegalEligibilityBlockedIndexVersion,
      ).toBeUndefined();
    }
    expect(
      state.scheduled.filter(
        (job) => job.name === "ragV2/action:generateChunkEmbeddings",
      ),
    ).toHaveLength(11);
    expect(
      state.scheduled.some(
        (job) =>
          job.name ===
          "users/mutation:resumeLegalEligibilityBlockedRepositories",
      ),
    ).toBe(true);
    await drainScheduledFunctions(t);
  });
});

describe("AI legal attestation provider guard", () => {
  const userId = "users:test-user" as Id<"users">;
  const messages = [{ role: "user" as const, content: "Test" }];

  function createProvider(chat: AiProvider["chat"]): AiProvider {
    return {
      name: "Test provider",
      modelId: "test-model",
      providerId: "test-provider",
      chat,
    };
  }

  it("does not call the provider when attestation is missing or stale", async () => {
    const runQuery = vi.fn().mockResolvedValue(false);
    const providerChat = vi.fn<AiProvider["chat"]>();
    const guardedProvider = guardAiProviderWithCurrentLegalAttestation(
      { runQuery } as unknown as ActionCtx,
      userId,
      createProvider(providerChat),
    );

    await expect(guardedProvider.chat(messages)).rejects.toThrow(
      AI_LEGAL_ATTESTATION_REQUIRED_MESSAGE,
    );
    expect(runQuery).toHaveBeenCalledTimes(1);
    expect(providerChat).not.toHaveBeenCalled();
  });

  it("rechecks the current attestation before every provider attempt", async () => {
    const runQuery = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const providerChat = vi.fn<AiProvider["chat"]>().mockResolvedValue({
      content: "Allowed once",
      finishReason: "stop",
    });
    const guardedProvider = guardAiProviderWithCurrentLegalAttestation(
      { runQuery } as unknown as ActionCtx,
      userId,
      createProvider(providerChat),
    );

    await expect(guardedProvider.chat(messages)).resolves.toMatchObject({
      content: "Allowed once",
    });
    await expect(guardedProvider.chat(messages)).rejects.toThrow(
      AI_LEGAL_ATTESTATION_REQUIRED_MESSAGE,
    );
    expect(runQuery).toHaveBeenCalledTimes(2);
    expect(providerChat).toHaveBeenCalledTimes(1);
  });
});
