import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import {
  getSubscriptionForEntitlement,
  hasEffectiveProEntitlement,
  type ProEntitlementState,
} from "../subscriptions/entitlement";

export type RepositoryRole = "owner" | "viewer";

export interface AccessCheckResult {
  hasAccess: boolean;
  role: RepositoryRole | null;
  isOwner: boolean;
  canEdit: boolean;
  canManageMembers: boolean;
}

/** Keep browser and server Pro entitlement checks on one policy. */
export function hasProSubscriptionAccess(
  subscription: ProEntitlementState | null | undefined,
  now = Date.now(),
): boolean {
  return hasEffectiveProEntitlement(subscription, now);
}

/** Team access is sponsored only by an existing owner's live trusted Pro grant. */
export async function hasLiveOwnerTeamEntitlement(
  ctx: QueryCtx | MutationCtx,
  ownerUserId: Id<"users">,
  now = Date.now(),
): Promise<boolean> {
  if (!(await ctx.db.get(ownerUserId))) {
    return false;
  }
  const subscription = await getSubscriptionForEntitlement(
    ctx,
    ownerUserId,
    now,
  );
  return hasProSubscriptionAccess(subscription, now);
}

/**
 * Check user's access to a repository
 * Supports both original owner (via repositories.userId) and team members (via repositoryMembers)
 */
export async function checkRepositoryAccess(
  ctx: QueryCtx | MutationCtx,
  repositoryId: Id<"repositories">,
  userId: Id<"users">,
): Promise<AccessCheckResult> {
  const repo = await ctx.db.get(repositoryId);
  if (!repo || repo.disconnectCleanupPending === true) {
    return {
      hasAccess: false,
      role: null,
      isOwner: false,
      canEdit: false,
      canManageMembers: false,
    };
  }

  // Check if user is the original owner
  if (repo.userId === userId) {
    return {
      hasAccess: true,
      role: "owner",
      isOwner: true,
      canEdit: true,
      canManageMembers: true,
    };
  }

  // Check repositoryMembers table
  const member = await ctx.db
    .query("repositoryMembers")
    .withIndex("by_repository_and_user", (q) =>
      q.eq("repositoryId", repositoryId).eq("userId", userId),
    )
    .first();

  if (!member || !(await hasLiveOwnerTeamEntitlement(ctx, repo.userId))) {
    return {
      hasAccess: false,
      role: null,
      isOwner: false,
      canEdit: false,
      canManageMembers: false,
    };
  }

  return {
    hasAccess: true,
    role: "viewer",
    isOwner: false,
    canEdit: false,
    canManageMembers: false,
  };
}

/**
 * Check if user has Pro subscription
 * Returns true if user has an active Pro subscription or canceled but still within period
 */
export async function checkProSubscription(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  now = Date.now(),
): Promise<boolean> {
  const subscription = await getSubscriptionForEntitlement(ctx, userId, now);

  return hasProSubscriptionAccess(subscription, now);
}
