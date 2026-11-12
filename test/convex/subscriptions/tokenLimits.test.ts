import { describe, it, expect, beforeEach } from "vitest";
import { GENERATION_MODELS, PRICING } from "../../../convex/_ai/config";

/**
 * Token Limit Tests
 *
 * Test Structure:
 * 1. Token limit checks for different subscription tiers
 * 2. Monthly usage tracking
 * 3. Limit enforcement
 * 4. Prepaid token-pack handling for paid tiers
 */

type SubscriptionPlan = "free" | "pro";
type SubscriptionStatus = "active" | "canceled" | "expired";

interface Subscription {
  id: string;
  userId: string;
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  includedTokens: number;
  purchasedTokens: number;
  serviceFeeRate: number;
  periodStart: number;
  periodEnd: number;
  createdAt: number;
}

interface MonthlyUsage {
  id: string;
  userId: string;
  yearMonth: string;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
}

interface TokenLimitCheckResult {
  allowed: boolean;
  reason?: "limit_reached";
  message?: string;
}

// In-memory database
class MockDatabase {
  private subscriptions: Map<string, Subscription> = new Map();
  private monthlyUsage: Map<string, MonthlyUsage> = new Map();
  private nextId = 1;

  reset() {
    this.subscriptions.clear();
    this.monthlyUsage.clear();
    this.nextId = 1;
  }

  generateId() {
    return `id_${this.nextId++}`;
  }

  insertSubscription(
    sub: Omit<Subscription, "id" | "createdAt">,
  ): Subscription {
    const id = this.generateId();
    const newSub: Subscription = { ...sub, id, createdAt: Date.now() };
    this.subscriptions.set(id, newSub);
    return newSub;
  }

  getSubscriptionByUser(userId: string): Subscription | undefined {
    return Array.from(this.subscriptions.values())
      .filter((sub) => sub.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  insertMonthlyUsage(usage: Omit<MonthlyUsage, "id">): MonthlyUsage {
    const id = this.generateId();
    const newUsage: MonthlyUsage = { ...usage, id };
    this.monthlyUsage.set(id, newUsage);
    return newUsage;
  }

  getMonthlyUsage(userId: string, yearMonth: string): MonthlyUsage | undefined {
    return Array.from(this.monthlyUsage.values()).find(
      (usage) => usage.userId === userId && usage.yearMonth === yearMonth,
    );
  }

  updateMonthlyUsage(
    userId: string,
    yearMonth: string,
    updates: Partial<MonthlyUsage>,
  ): MonthlyUsage {
    const existing = this.getMonthlyUsage(userId, yearMonth);
    if (!existing) {
      throw new Error("Usage record not found");
    }
    const updated = { ...existing, ...updates };
    this.monthlyUsage.set(existing.id, updated);
    return updated;
  }
}

// Mock canPerformAction logic
function canPerformAction(
  db: MockDatabase,
  userId: string,
): TokenLimitCheckResult {
  const subscription = db.getSubscriptionByUser(userId);
  const plan = subscription?.plan ?? "free";
  const includedTokens =
    subscription?.includedTokens ?? PRICING.FREE_INCLUDED_TOKENS;
  const purchasedTokens = subscription?.purchasedTokens ?? 0;
  const tokenLimit = includedTokens + purchasedTokens;

  const yearMonth = new Date().toISOString().slice(0, 7);
  const usage = db.getMonthlyUsage(userId, yearMonth);
  const tokensUsed = usage?.totalTokens ?? 0;

  // Both plans stop at included tokens plus the prepaid token wallet.
  if (tokensUsed >= tokenLimit) {
    return {
      allowed: false,
      reason: "limit_reached",
      message:
        plan === "free"
          ? `Free tier limit reached (${tokenLimit.toLocaleString()} tokens/month). Purchase a token pack or upgrade to Pro.`
          : `Pro prepaid token limit reached (${tokenLimit.toLocaleString()} tokens). Purchase a token pack to continue.`,
    };
  }

  return { allowed: true };
}

let db: MockDatabase;

beforeEach(() => {
  db = new MockDatabase();
});

describe("Token Limit Checks", () => {
  describe("Free Tier", () => {
    it("should allow actions when under token limit", () => {
      // Given: Free tier user with 10k tokens used (limit: 100k)
      const userId = "user_1";
      db.insertSubscription({
        userId,
        plan: "free",
        status: "active",
        includedTokens: PRICING.FREE_INCLUDED_TOKENS,
        purchasedTokens: 0,
        serviceFeeRate: PRICING.PLATFORM_FEE_FREE,
        periodStart: Date.now(),
        periodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000,
      });

      const yearMonth = new Date().toISOString().slice(0, 7);
      db.insertMonthlyUsage({
        userId,
        yearMonth,
        totalTokens: 10_000,
        totalInputTokens: 8_000,
        totalOutputTokens: 2_000,
        totalCost: 0,
      });

      // When: Check if action is allowed
      const result = canPerformAction(db, userId);

      // Then: Should be allowed
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("should block actions when at token limit", () => {
      // Given: Free tier user with exactly 100k tokens used
      const userId = "user_1";
      db.insertSubscription({
        userId,
        plan: "free",
        status: "active",
        includedTokens: PRICING.FREE_INCLUDED_TOKENS,
        purchasedTokens: 0,
        serviceFeeRate: PRICING.PLATFORM_FEE_FREE,
        periodStart: Date.now(),
        periodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000,
      });

      const yearMonth = new Date().toISOString().slice(0, 7);
      db.insertMonthlyUsage({
        userId,
        yearMonth,
        totalTokens: PRICING.FREE_INCLUDED_TOKENS, // 100,000
        totalInputTokens: 40_000,
        totalOutputTokens: 10_000,
        totalCost: 0,
      });

      // When: Check if action is allowed
      const result = canPerformAction(db, userId);

      // Then: Should be blocked
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("limit_reached");
      expect(result.message).toContain("Free tier limit reached");
      expect(result.message).toContain("100,000 tokens/month");
    });

    it("should block actions when over token limit", () => {
      // Given: Free tier user with 110k tokens used
      const userId = "user_1";
      db.insertSubscription({
        userId,
        plan: "free",
        status: "active",
        includedTokens: PRICING.FREE_INCLUDED_TOKENS,
        purchasedTokens: 0,
        serviceFeeRate: PRICING.PLATFORM_FEE_FREE,
        periodStart: Date.now(),
        periodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000,
      });

      const yearMonth = new Date().toISOString().slice(0, 7);
      db.insertMonthlyUsage({
        userId,
        yearMonth,
        totalTokens: 110_000,
        totalInputTokens: 88_000,
        totalOutputTokens: 22_000,
        totalCost: 0,
      });

      // When: Check if action is allowed
      const result = canPerformAction(db, userId);

      // Then: Should be blocked
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("limit_reached");
    });

    it("should allow new user with no usage", () => {
      // Given: Free tier user with no usage record
      const userId = "user_1";
      db.insertSubscription({
        userId,
        plan: "free",
        status: "active",
        includedTokens: PRICING.FREE_INCLUDED_TOKENS,
        purchasedTokens: 0,
        serviceFeeRate: PRICING.PLATFORM_FEE_FREE,
        periodStart: Date.now(),
        periodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000,
      });

      // No monthly usage record

      // When: Check if action is allowed
      const result = canPerformAction(db, userId);

      // Then: Should be allowed
      expect(result.allowed).toBe(true);
    });
  });

  describe("Pro Tier", () => {
    it("should allow actions when under included tokens", () => {
      // Given: Pro tier user with 500k tokens used (limit: 1M)
      const userId = "user_1";
      db.insertSubscription({
        userId,
        plan: "pro",
        status: "active",
        includedTokens: PRICING.PRO_INCLUDED_TOKENS,
        purchasedTokens: 0,
        serviceFeeRate: PRICING.PLATFORM_FEE_PRO,
        periodStart: Date.now(),
        periodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000,
      });

      const yearMonth = new Date().toISOString().slice(0, 7);
      db.insertMonthlyUsage({
        userId,
        yearMonth,
        totalTokens: 500_000,
        totalInputTokens: 400_000,
        totalOutputTokens: 100_000,
        totalCost: 0,
      });

      // When: Check if action is allowed
      const result = canPerformAction(db, userId);

      // Then: Should be allowed
      expect(result.allowed).toBe(true);
    });

    it("should block actions at the included limit without prepaid tokens", () => {
      // Given: Pro tier user with no prepaid token balance
      const userId = "user_1";
      db.insertSubscription({
        userId,
        plan: "pro",
        status: "active",
        includedTokens: PRICING.PRO_INCLUDED_TOKENS,
        purchasedTokens: 0,
        serviceFeeRate: PRICING.PLATFORM_FEE_PRO,
        periodStart: Date.now(),
        periodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000,
      });

      const yearMonth = new Date().toISOString().slice(0, 7);
      db.insertMonthlyUsage({
        userId,
        yearMonth,
        totalTokens: PRICING.PRO_INCLUDED_TOKENS,
        totalInputTokens: PRICING.PRO_INCLUDED_TOKENS,
        totalOutputTokens: 0,
        totalCost: 0,
      });

      // When: Check if action is allowed
      const result = canPerformAction(db, userId);

      // Then: Pro cannot create postpaid usage
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("limit_reached");
      expect(result.message).toContain("Pro prepaid token limit reached");
    });
  });

  describe("Token Pack Purchases", () => {
    it("should allow actions with purchased token balance", () => {
      // Given: Pro tier user with purchased tokens
      const userId = "user_1";
      db.insertSubscription({
        userId,
        plan: "pro",
        status: "active",
        includedTokens: PRICING.PRO_INCLUDED_TOKENS,
        purchasedTokens: 200_000,
        serviceFeeRate: PRICING.PLATFORM_FEE_PRO,
        periodStart: Date.now(),
        periodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000,
      });

      const yearMonth = new Date().toISOString().slice(0, 7);
      db.insertMonthlyUsage({
        userId,
        yearMonth,
        totalTokens: PRICING.PRO_INCLUDED_TOKENS + 199_999,
        totalInputTokens: PRICING.PRO_INCLUDED_TOKENS + 199_999,
        totalOutputTokens: 0,
        totalCost: 0,
      });

      // When: Check if action is allowed
      const result = canPerformAction(db, userId);

      // Then: Should be allowed within included plus purchased tokens
      expect(result.allowed).toBe(true);
    });

    it("should allow heavy usage for pro tier with token packs", () => {
      // Given: Pro tier user with 5M tokens used (has purchased 10M token pack)
      const userId = "user_1";
      db.insertSubscription({
        userId,
        plan: "pro",
        status: "active",
        includedTokens: PRICING.PRO_INCLUDED_TOKENS,
        purchasedTokens: 10_000_000,
        serviceFeeRate: PRICING.PLATFORM_FEE_PRO,
        periodStart: Date.now(),
        periodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000,
      });

      const yearMonth = new Date().toISOString().slice(0, 7);
      db.insertMonthlyUsage({
        userId,
        yearMonth,
        totalTokens: 5_000_000,
        totalInputTokens: 4_000_000,
        totalOutputTokens: 1_000_000,
        totalCost: 24.0, // Internal provider-cost accounting
      });

      // When: Check if action is allowed
      const result = canPerformAction(db, userId);

      // Then: Should be allowed within the prepaid token pack
      expect(result.allowed).toBe(true);
    });
  });

  describe("No Subscription (defaults to free tier)", () => {
    it("should use free tier limits when user has no subscription", () => {
      // Given: User with no subscription but with usage
      const userId = "user_1";
      const yearMonth = new Date().toISOString().slice(0, 7);
      db.insertMonthlyUsage({
        userId,
        yearMonth,
        totalTokens: 110_000, // Over free tier limit (100k)
        totalInputTokens: 88_000,
        totalOutputTokens: 22_000,
        totalCost: 0,
      });

      // When: Check if action is allowed
      const result = canPerformAction(db, userId);

      // Then: Should be blocked (free tier limit)
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("limit_reached");
    });

    it("should allow new user with no subscription and no usage", () => {
      // Given: Completely new user
      const userId = "user_new";

      // When: Check if action is allowed
      const result = canPerformAction(db, userId);

      // Then: Should be allowed
      expect(result.allowed).toBe(true);
    });
  });
});

describe("Subscription Creation", () => {
  it("should create free tier subscription with correct limits", () => {
    // When: Create free tier subscription
    const sub = db.insertSubscription({
      userId: "user_1",
      plan: "free",
      status: "active",
      includedTokens: PRICING.FREE_INCLUDED_TOKENS,
      purchasedTokens: 0,
      serviceFeeRate: PRICING.PLATFORM_FEE_FREE,
      periodStart: Date.now(),
      periodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000,
    });

    // Then: Should have correct settings
    expect(sub.plan).toBe("free");
    expect(sub.includedTokens).toBe(100_000);
    expect(sub.serviceFeeRate).toBe(0.25); // 25% platform fee for free tier
  });

  it("should create pro tier subscription with correct limits", () => {
    // When: Create pro tier subscription
    const sub = db.insertSubscription({
      userId: "user_1",
      plan: "pro",
      status: "active",
      includedTokens: PRICING.PRO_INCLUDED_TOKENS,
      purchasedTokens: 0,
      serviceFeeRate: PRICING.PLATFORM_FEE_PRO,
      periodStart: Date.now(),
      periodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000,
    });

    // Then: Should have correct settings
    expect(sub.plan).toBe("pro");
    expect(sub.includedTokens).toBe(2_400_000);
    expect(sub.serviceFeeRate).toBe(0.18); // 18% platform fee for pro tier
  });

  it("should handle token pack purchases", () => {
    // Token packs: small = $9.99 (2.2M, 25% margin), large = $29.99 (7.5M, 20% margin)
    const tokenPackSmallSize = PRICING.TOKEN_PACK_SMALL_SIZE;
    const tokenPackLargeSize = PRICING.TOKEN_PACK_LARGE_SIZE;

    expect(tokenPackSmallSize).toBe(2_200_000);
    expect(tokenPackLargeSize).toBe(7_500_000);
    expect(PRICING.PLATFORM_FEE_TOKEN_PACK_SMALL).toBe(0.25); // 25% margin for small pack
    expect(PRICING.PLATFORM_FEE_TOKEN_PACK_LARGE).toBe(0.2); // 20% margin for large pack
  });
});

describe("Cost Calculation", () => {
  it("should calculate internal provider cost for free usage", () => {
    // This documents provider-cost accounting, not a customer charge.
    const inputTokens = 10_000;
    const outputTokens = 2_000;
    const totalCost =
      (inputTokens / 1_000_000) * GENERATION_MODELS.anthropic.inputPer1M +
      (outputTokens / 1_000_000) * GENERATION_MODELS.anthropic.outputPer1M;
    const platformFee = totalCost * PRICING.PLATFORM_FEE_FREE;
    const totalWithFee = totalCost + platformFee;

    expect(totalCost).toBeCloseTo(0.04, 4);
    expect(platformFee).toBeCloseTo(0.01, 4);
    expect(totalWithFee).toBeCloseTo(0.05, 4);
  });

  it("should calculate internal provider cost for Pro prepaid usage", () => {
    const inputTokens = 80_000;
    const outputTokens = 20_000;
    const totalCost =
      (inputTokens / 1_000_000) * GENERATION_MODELS.anthropic.inputPer1M +
      (outputTokens / 1_000_000) * GENERATION_MODELS.anthropic.outputPer1M;
    const platformFee = totalCost * PRICING.PLATFORM_FEE_PRO;
    const totalWithFee = totalCost + platformFee;

    expect(totalCost).toBeCloseTo(0.36, 4);
    expect(platformFee).toBeCloseTo(0.0648, 5);
    expect(totalWithFee).toBeCloseTo(0.4248, 5);
  });

  it("should calculate cost correctly for small token pack fee (25%)", () => {
    // Given: User with a small token pack purchase using 1M tokens.
    const inputTokens = 800_000;
    const outputTokens = 200_000;
    const totalCost =
      (inputTokens / 1_000_000) * GENERATION_MODELS.anthropic.inputPer1M +
      (outputTokens / 1_000_000) * GENERATION_MODELS.anthropic.outputPer1M;
    const platformFee = totalCost * PRICING.PLATFORM_FEE_TOKEN_PACK_SMALL;
    const totalWithFee = totalCost + platformFee;

    expect(totalCost).toBeCloseTo(3.6, 3);
    expect(platformFee).toBeCloseTo(0.9, 4);
    expect(totalWithFee).toBeCloseTo(4.5, 4);
  });

  it("should calculate embedding cost correctly", () => {
    // Given: OpenAI text-embedding-3-small pricing ($0.02/1M tokens)
    const embeddingTokens = 1_000_000;
    const embeddingCost =
      (embeddingTokens / 1_000_000) * PRICING.OPENAI_EMBEDDING_PER_1M;
    const platformFee = embeddingCost * PRICING.PLATFORM_FEE_PRO;
    const totalWithFee = embeddingCost + platformFee;

    expect(embeddingCost).toBeCloseTo(0.02, 4); // $0.02
    expect(platformFee).toBeCloseTo(0.0036, 4); // $0.0036 (18%)
    expect(totalWithFee).toBeCloseTo(0.0236, 4); // $0.0236
  });
});
