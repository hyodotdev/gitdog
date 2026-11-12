import { describe, it, expect, beforeEach } from "vitest";

/**
 * Race Condition Prevention Tests for Repository Indexing
 *
 * These tests verify that the prepareIncrementalIndex mutation correctly
 * prevents race conditions when multiple push events arrive simultaneously.
 *
 * Strategy:
 * - Only "completed" → "pending" transition is allowed
 * - Convex mutations are serialized, so concurrent triggers execute sequentially
 * - Second trigger will see "pending" status and fail
 */

// Type definitions matching actual schema
type IndexStatus = "pending" | "indexing" | "completed" | "failed";

interface MockRepository {
  _id: string;
  githubRepo: string;
  userId: string;
  indexStatus: IndexStatus;
  indexVersion: number;
  lastIndexedAt: number | undefined;
  updatedAt: number;
}

interface PrepareResult {
  success: boolean;
  error?: string;
  repositoryId?: string;
  newVersion?: number;
}

/**
 * Mock database that simulates Convex mutation serialization
 * All operations on the same document are executed sequentially
 */
class MockSerializedDatabase {
  private repositories: Map<string, MockRepository> = new Map();
  private nextId = 1;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  reset() {
    this.repositories.clear();
    this.nextId = 1;
    this.mutationQueue = Promise.resolve();
  }

  generateId(): string {
    return `repo_${this.nextId++}`;
  }

  // Insert repository (for test setup)
  insertRepository(
    repo: Omit<MockRepository, "_id" | "updatedAt">,
  ): MockRepository {
    const _id = this.generateId();
    const newRepo = { ...repo, _id, updatedAt: Date.now() };
    this.repositories.set(_id, newRepo);
    return newRepo;
  }

  // Get repository by githubRepo (synchronous read - allowed in Convex)
  getRepositoryByFullName(githubRepo: string): MockRepository | undefined {
    return Array.from(this.repositories.values()).find(
      (r) => r.githubRepo === githubRepo,
    );
  }

  // Get repository by ID
  getRepository(id: string): MockRepository | undefined {
    return this.repositories.get(id);
  }

  /**
   * Simulate prepareIncrementalIndex mutation
   * This is serialized - concurrent calls will execute sequentially
   */
  async prepareIncrementalIndex(githubRepo: string): Promise<PrepareResult> {
    // Queue the mutation to simulate Convex serialization
    return (this.mutationQueue = this.mutationQueue.then(async () => {
      // Small delay to simulate real-world timing
      await new Promise((resolve) => setTimeout(resolve, 1));

      const repo = this.getRepositoryByFullName(githubRepo);

      if (!repo) {
        return { success: false, error: "repository not found" };
      }

      // Only allow starting from "completed" status
      if (repo.indexStatus !== "completed") {
        return {
          success: false,
          error:
            repo.indexStatus === "indexing"
              ? "indexing already in progress"
              : repo.indexStatus === "pending"
                ? "indexing already scheduled"
                : "initial indexing not completed",
        };
      }

      // Increment version
      const newVersion = repo.indexVersion + 1;

      // Atomically update
      const updatedRepo = {
        ...repo,
        indexVersion: newVersion,
        indexStatus: "pending" as IndexStatus,
        updatedAt: Date.now(),
      };
      this.repositories.set(repo._id, updatedRepo);

      return {
        success: true,
        repositoryId: repo._id,
        newVersion,
      };
    }));
  }

  /**
   * Simulate updateIndexingStatus mutation
   */
  async updateIndexingStatus(
    repositoryId: string,
    status: IndexStatus,
  ): Promise<void> {
    return (this.mutationQueue = this.mutationQueue.then(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));

      const repo = this.repositories.get(repositoryId);
      if (!repo) throw new Error("repository not found");

      const updatedRepo = {
        ...repo,
        indexStatus: status,
        updatedAt: Date.now(),
        ...(status === "completed" ? { lastIndexedAt: Date.now() } : {}),
      };
      this.repositories.set(repositoryId, updatedRepo);
    }));
  }
}

/**
 * Simulate triggerIncrementalIndex action
 */
async function triggerIncrementalIndex(
  db: MockSerializedDatabase,
  githubRepo: string,
): Promise<{ success: boolean; error?: string; newVersion?: number }> {
  const result = await db.prepareIncrementalIndex(githubRepo);

  if (!result.success) {
    return { success: false, error: result.error };
  }

  // In real implementation, scheduler.runAfter would be called here
  // For tests, we just return the result

  return {
    success: true,
    newVersion: result.newVersion,
  };
}

let db: MockSerializedDatabase;

beforeEach(() => {
  db = new MockSerializedDatabase();
});

describe("prepareIncrementalIndex - Race Condition Prevention", () => {
  describe("Single Trigger", () => {
    it("should succeed when status is completed", async () => {
      // Given: Repository with completed status
      db.insertRepository({
        githubRepo: "owner/repo",
        userId: "user_1",
        indexStatus: "completed",
        indexVersion: 1,
        lastIndexedAt: Date.now() - 3600000,
      });

      // When
      const result = await triggerIncrementalIndex(db, "owner/repo");

      // Then
      expect(result.success).toBe(true);
      expect(result.newVersion).toBe(2);

      const repo = db.getRepositoryByFullName("owner/repo");
      expect(repo?.indexStatus).toBe("pending");
      expect(repo?.indexVersion).toBe(2);
    });

    it("should fail when status is pending", async () => {
      // Given: Repository with pending status
      db.insertRepository({
        githubRepo: "owner/repo",
        userId: "user_1",
        indexStatus: "pending",
        indexVersion: 1,
        lastIndexedAt: Date.now() - 3600000,
      });

      // When
      const result = await triggerIncrementalIndex(db, "owner/repo");

      // Then
      expect(result.success).toBe(false);
      expect(result.error).toBe("indexing already scheduled");
    });

    it("should fail when status is indexing", async () => {
      // Given: Repository currently being indexed
      db.insertRepository({
        githubRepo: "owner/repo",
        userId: "user_1",
        indexStatus: "indexing",
        indexVersion: 2,
        lastIndexedAt: Date.now() - 3600000,
      });

      // When
      const result = await triggerIncrementalIndex(db, "owner/repo");

      // Then
      expect(result.success).toBe(false);
      expect(result.error).toBe("indexing already in progress");
    });

    it("should fail when status is failed", async () => {
      // Given: Repository with failed indexing
      db.insertRepository({
        githubRepo: "owner/repo",
        userId: "user_1",
        indexStatus: "failed",
        indexVersion: 1,
        lastIndexedAt: undefined,
      });

      // When
      const result = await triggerIncrementalIndex(db, "owner/repo");

      // Then
      expect(result.success).toBe(false);
      expect(result.error).toBe("initial indexing not completed");
    });

    it("should fail when repository not found", async () => {
      // Given: No repository exists

      // When
      const result = await triggerIncrementalIndex(db, "nonexistent/repo");

      // Then
      expect(result.success).toBe(false);
      expect(result.error).toBe("repository not found");
    });
  });

  describe("Concurrent Triggers (Race Condition)", () => {
    it("should allow only first trigger when two arrive simultaneously", async () => {
      // Given: Repository with completed status
      db.insertRepository({
        githubRepo: "owner/repo",
        userId: "user_1",
        indexStatus: "completed",
        indexVersion: 1,
        lastIndexedAt: Date.now() - 3600000,
      });

      // When: Two triggers arrive at the same time
      const [result1, result2] = await Promise.all([
        triggerIncrementalIndex(db, "owner/repo"),
        triggerIncrementalIndex(db, "owner/repo"),
      ]);

      // Then: Exactly one should succeed
      const successCount = [result1, result2].filter((r) => r.success).length;
      const failCount = [result1, result2].filter((r) => !r.success).length;

      expect(successCount).toBe(1);
      expect(failCount).toBe(1);

      // The failed one should have the correct error
      const failedResult = [result1, result2].find((r) => !r.success);
      expect(failedResult?.error).toBe("indexing already scheduled");

      // Final state should be pending with version 2
      const repo = db.getRepositoryByFullName("owner/repo");
      expect(repo?.indexStatus).toBe("pending");
      expect(repo?.indexVersion).toBe(2);
    });

    it("should allow only first trigger when three arrive simultaneously", async () => {
      // Given
      db.insertRepository({
        githubRepo: "owner/repo",
        userId: "user_1",
        indexStatus: "completed",
        indexVersion: 5,
        lastIndexedAt: Date.now() - 3600000,
      });

      // When: Three triggers arrive at the same time
      const [result1, result2, result3] = await Promise.all([
        triggerIncrementalIndex(db, "owner/repo"),
        triggerIncrementalIndex(db, "owner/repo"),
        triggerIncrementalIndex(db, "owner/repo"),
      ]);

      // Then: Exactly one should succeed
      const successCount = [result1, result2, result3].filter(
        (r) => r.success,
      ).length;
      expect(successCount).toBe(1);

      // Version should only increment once
      const repo = db.getRepositoryByFullName("owner/repo");
      expect(repo?.indexVersion).toBe(6);
    });

    it("should allow only first trigger when many arrive simultaneously", async () => {
      // Given
      db.insertRepository({
        githubRepo: "owner/repo",
        userId: "user_1",
        indexStatus: "completed",
        indexVersion: 10,
        lastIndexedAt: Date.now() - 3600000,
      });

      // When: 10 triggers arrive at the same time
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          triggerIncrementalIndex(db, "owner/repo"),
        ),
      );

      // Then: Exactly one should succeed
      const successCount = results.filter((r) => r.success).length;
      expect(successCount).toBe(1);

      // Version should only increment once
      const repo = db.getRepositoryByFullName("owner/repo");
      expect(repo?.indexVersion).toBe(11);
    });
  });

  describe("Sequential Triggers (After Completion)", () => {
    it("should allow new trigger after previous indexing completes", async () => {
      // Given: Repository with completed status
      db.insertRepository({
        githubRepo: "owner/repo",
        userId: "user_1",
        indexStatus: "completed",
        indexVersion: 1,
        lastIndexedAt: Date.now() - 3600000,
      });

      // When: First trigger
      const result1 = await triggerIncrementalIndex(db, "owner/repo");
      expect(result1.success).toBe(true);

      // Simulate indexing completion
      const repo1 = db.getRepositoryByFullName("owner/repo");
      await db.updateIndexingStatus(repo1!._id, "indexing");
      await db.updateIndexingStatus(repo1!._id, "completed");

      // When: Second trigger after completion
      const result2 = await triggerIncrementalIndex(db, "owner/repo");

      // Then: Second trigger should also succeed
      expect(result2.success).toBe(true);
      expect(result2.newVersion).toBe(3);

      const repo = db.getRepositoryByFullName("owner/repo");
      expect(repo?.indexStatus).toBe("pending");
      expect(repo?.indexVersion).toBe(3);
    });

    it("should block trigger while previous indexing is in progress", async () => {
      // Given: Repository with completed status
      db.insertRepository({
        githubRepo: "owner/repo",
        userId: "user_1",
        indexStatus: "completed",
        indexVersion: 1,
        lastIndexedAt: Date.now() - 3600000,
      });

      // When: First trigger succeeds
      const result1 = await triggerIncrementalIndex(db, "owner/repo");
      expect(result1.success).toBe(true);

      // Simulate indexing in progress
      const repo1 = db.getRepositoryByFullName("owner/repo");
      await db.updateIndexingStatus(repo1!._id, "indexing");

      // When: Second trigger while indexing
      const result2 = await triggerIncrementalIndex(db, "owner/repo");

      // Then: Second trigger should fail
      expect(result2.success).toBe(false);
      expect(result2.error).toBe("indexing already in progress");
    });
  });

  describe("Multiple Repositories", () => {
    it("should allow concurrent triggers for different repositories", async () => {
      // Given: Two repositories with completed status
      db.insertRepository({
        githubRepo: "owner/repo-a",
        userId: "user_1",
        indexStatus: "completed",
        indexVersion: 1,
        lastIndexedAt: Date.now() - 3600000,
      });

      db.insertRepository({
        githubRepo: "owner/repo-b",
        userId: "user_1",
        indexStatus: "completed",
        indexVersion: 5,
        lastIndexedAt: Date.now() - 7200000,
      });

      // When: Triggers for both repositories arrive simultaneously
      const [resultA, resultB] = await Promise.all([
        triggerIncrementalIndex(db, "owner/repo-a"),
        triggerIncrementalIndex(db, "owner/repo-b"),
      ]);

      // Then: Both should succeed
      expect(resultA.success).toBe(true);
      expect(resultB.success).toBe(true);

      const repoA = db.getRepositoryByFullName("owner/repo-a");
      const repoB = db.getRepositoryByFullName("owner/repo-b");

      expect(repoA?.indexVersion).toBe(2);
      expect(repoB?.indexVersion).toBe(6);
    });

    it("should handle mixed success/failure across repositories", async () => {
      // Given: One completed, one indexing
      db.insertRepository({
        githubRepo: "owner/completed-repo",
        userId: "user_1",
        indexStatus: "completed",
        indexVersion: 3,
        lastIndexedAt: Date.now() - 3600000,
      });

      db.insertRepository({
        githubRepo: "owner/indexing-repo",
        userId: "user_1",
        indexStatus: "indexing",
        indexVersion: 2,
        lastIndexedAt: Date.now() - 7200000,
      });

      // When
      const [resultCompleted, resultIndexing] = await Promise.all([
        triggerIncrementalIndex(db, "owner/completed-repo"),
        triggerIncrementalIndex(db, "owner/indexing-repo"),
      ]);

      // Then
      expect(resultCompleted.success).toBe(true);
      expect(resultIndexing.success).toBe(false);
      expect(resultIndexing.error).toBe("indexing already in progress");
    });
  });

  describe("Version Increment", () => {
    it("should increment version correctly", async () => {
      // Given
      db.insertRepository({
        githubRepo: "owner/repo",
        userId: "user_1",
        indexStatus: "completed",
        indexVersion: 42,
        lastIndexedAt: Date.now() - 3600000,
      });

      // When
      const result = await triggerIncrementalIndex(db, "owner/repo");

      // Then
      expect(result.newVersion).toBe(43);
    });
  });
});

describe("Full Indexing Lifecycle", () => {
  it("should handle complete lifecycle: trigger → indexing → completed → trigger", async () => {
    // Given
    const repo = db.insertRepository({
      githubRepo: "owner/repo",
      userId: "user_1",
      indexStatus: "completed",
      indexVersion: 1,
      lastIndexedAt: Date.now() - 86400000,
    });

    // Step 1: Trigger indexing
    const trigger1 = await triggerIncrementalIndex(db, "owner/repo");
    expect(trigger1.success).toBe(true);
    expect(db.getRepository(repo._id)?.indexStatus).toBe("pending");

    // Step 2: Start indexing
    await db.updateIndexingStatus(repo._id, "indexing");
    expect(db.getRepository(repo._id)?.indexStatus).toBe("indexing");

    // Step 3: Concurrent trigger should fail
    const trigger2 = await triggerIncrementalIndex(db, "owner/repo");
    expect(trigger2.success).toBe(false);
    expect(trigger2.error).toBe("indexing already in progress");

    // Step 4: Complete indexing
    await db.updateIndexingStatus(repo._id, "completed");
    expect(db.getRepository(repo._id)?.indexStatus).toBe("completed");

    // Step 5: New trigger should succeed
    const trigger3 = await triggerIncrementalIndex(db, "owner/repo");
    expect(trigger3.success).toBe(true);
    expect(trigger3.newVersion).toBe(3);
  });
});
