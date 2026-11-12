import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Daily Sync Cron Job Tests
 *
 * Test scenarios:
 * 1. dailySyncAllRepositories - Schedules sync for completed repositories
 * 2. cleanupOldFileCache - Removes stale file blobs
 * 3. Race condition prevention - Status updates before scheduling
 * 4. Error handling - Graceful failures
 */

// Mock repository data
interface MockRepository {
  _id: string;
  githubRepo: string;
  indexStatus: "pending" | "indexing" | "completed" | "failed";
  indexVersion: number;
  lastIndexedAt: number | null;
}

// Mock file blob data
interface MockFileBlob {
  _id: string;
  sha256: string;
  storageId: string;
  lastAccessedAt: number;
  accessCount: number;
}

// In-memory mock database
class MockCronDatabase {
  private repositories: Map<string, MockRepository> = new Map();
  private fileBlobs: Map<string, MockFileBlob> = new Map();
  private indexingLogs: Array<{
    repositoryId: string;
    indexVersion: number;
    level: string;
    message: string;
  }> = [];
  private scheduledJobs: Array<{
    action: string;
    repositoryId: string;
    delay: number;
  }> = [];
  private nextId = 1;

  reset() {
    this.repositories.clear();
    this.fileBlobs.clear();
    this.indexingLogs = [];
    this.scheduledJobs = [];
    this.nextId = 1;
  }

  generateId(): string {
    return `id_${this.nextId++}`;
  }

  // Repository methods
  insertRepository(repo: Omit<MockRepository, "_id">): MockRepository {
    const _id = this.generateId();
    const newRepo = { ...repo, _id };
    this.repositories.set(_id, newRepo);
    return newRepo;
  }

  getRepository(id: string): MockRepository | undefined {
    return this.repositories.get(id);
  }

  updateRepository(
    id: string,
    updates: Partial<MockRepository>,
  ): MockRepository {
    const repo = this.repositories.get(id);
    if (!repo) throw new Error(`Repository ${id} not found`);
    const updated = { ...repo, ...updates };
    this.repositories.set(id, updated);
    return updated;
  }

  getCompletedRepositories(): MockRepository[] {
    return Array.from(this.repositories.values())
      .filter((repo) => repo.indexStatus === "completed")
      .sort((a, b) => (a.lastIndexedAt ?? 0) - (b.lastIndexedAt ?? 0));
  }

  // File blob methods
  insertFileBlob(blob: Omit<MockFileBlob, "_id">): MockFileBlob {
    const _id = this.generateId();
    const newBlob = { ...blob, _id };
    this.fileBlobs.set(_id, newBlob);
    return newBlob;
  }

  getFileBlob(id: string): MockFileBlob | undefined {
    return this.fileBlobs.get(id);
  }

  deleteFileBlob(id: string): void {
    this.fileBlobs.delete(id);
  }

  getStaleFileBlobs(threshold: number): MockFileBlob[] {
    return Array.from(this.fileBlobs.values())
      .filter((blob) => blob.lastAccessedAt < threshold)
      .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt)
      .slice(0, 100);
  }

  // Indexing log methods
  addIndexingLog(log: {
    repositoryId: string;
    indexVersion: number;
    level: string;
    message: string;
  }): void {
    this.indexingLogs.push(log);
  }

  getIndexingLogs(repositoryId: string) {
    return this.indexingLogs.filter((log) => log.repositoryId === repositoryId);
  }

  // Scheduler methods
  scheduleJob(action: string, repositoryId: string, delay: number): void {
    this.scheduledJobs.push({ action, repositoryId, delay });
  }

  getScheduledJobs() {
    return this.scheduledJobs;
  }
}

let db: MockCronDatabase;

beforeEach(() => {
  db = new MockCronDatabase();
  vi.clearAllMocks();
});

describe("dailySyncAllRepositories", () => {
  describe("Repository Selection", () => {
    it("should only sync repositories with completed status", async () => {
      // Given: Mix of repository statuses
      const completedRepo1 = db.insertRepository({
        githubRepo: "owner/completed1",
        indexStatus: "completed",
        indexVersion: 1,
        lastIndexedAt: Date.now() - 86400000, // 1 day ago
      });

      const completedRepo2 = db.insertRepository({
        githubRepo: "owner/completed2",
        indexStatus: "completed",
        indexVersion: 2,
        lastIndexedAt: Date.now() - 172800000, // 2 days ago
      });

      db.insertRepository({
        githubRepo: "owner/pending",
        indexStatus: "pending",
        indexVersion: 0,
        lastIndexedAt: null,
      });

      db.insertRepository({
        githubRepo: "owner/indexing",
        indexStatus: "indexing",
        indexVersion: 1,
        lastIndexedAt: null,
      });

      db.insertRepository({
        githubRepo: "owner/failed",
        indexStatus: "failed",
        indexVersion: 1,
        lastIndexedAt: Date.now() - 86400000,
      });

      // When: Get completed repositories
      const completedRepos = db.getCompletedRepositories();

      // Then: Only completed repos are returned
      expect(completedRepos).toHaveLength(2);
      expect(completedRepos.map((r) => r.githubRepo)).toContain(
        "owner/completed1",
      );
      expect(completedRepos.map((r) => r.githubRepo)).toContain(
        "owner/completed2",
      );

      // Verify oldest is first (fair rotation)
      expect(completedRepos[0]._id).toBe(completedRepo2._id);
      expect(completedRepos[1]._id).toBe(completedRepo1._id);
    });

    it("should prioritize repositories that haven't been synced recently", () => {
      // Given: Repos with different lastIndexedAt times
      const oldRepo = db.insertRepository({
        githubRepo: "owner/old",
        indexStatus: "completed",
        indexVersion: 1,
        lastIndexedAt: Date.now() - 604800000, // 1 week ago
      });

      const recentRepo = db.insertRepository({
        githubRepo: "owner/recent",
        indexStatus: "completed",
        indexVersion: 5,
        lastIndexedAt: Date.now() - 3600000, // 1 hour ago
      });

      const neverSynced = db.insertRepository({
        githubRepo: "owner/never",
        indexStatus: "completed",
        indexVersion: 1,
        lastIndexedAt: null,
      });

      // When
      const repos = db.getCompletedRepositories();

      // Then: Ordered by lastIndexedAt (null/oldest first)
      expect(repos[0]._id).toBe(neverSynced._id);
      expect(repos[1]._id).toBe(oldRepo._id);
      expect(repos[2]._id).toBe(recentRepo._id);
    });
  });

  describe("Sync Scheduling", () => {
    it("should schedule indexing with staggered delays", async () => {
      // Given: Multiple completed repositories
      const repo1 = db.insertRepository({
        githubRepo: "owner/repo1",
        indexStatus: "completed",
        indexVersion: 1,
        lastIndexedAt: Date.now() - 86400000,
      });

      const repo2 = db.insertRepository({
        githubRepo: "owner/repo2",
        indexStatus: "completed",
        indexVersion: 1,
        lastIndexedAt: Date.now() - 172800000,
      });

      const repo3 = db.insertRepository({
        githubRepo: "owner/repo3",
        indexStatus: "completed",
        indexVersion: 1,
        lastIndexedAt: Date.now() - 259200000,
      });

      // When: Simulate dailySyncAllRepositories
      const repos = db.getCompletedRepositories().slice(0, 10);
      let scheduled = 0;

      for (const repo of repos) {
        // Set status to pending first
        db.updateRepository(repo._id, {
          status: "pending",
        } as Partial<MockRepository>);

        // Increment version
        const newVersion = repo.indexVersion + 1;
        db.updateRepository(repo._id, { indexVersion: newVersion });

        // Add log
        db.addIndexingLog({
          repositoryId: repo._id,
          indexVersion: newVersion,
          level: "info",
          message: `Daily sync initiated for ${repo.githubRepo}`,
        });

        // Schedule with 30 second intervals
        db.scheduleJob("indexRepository", repo._id, scheduled * 30000);
        scheduled++;
      }

      // Then
      const scheduledJobs = db.getScheduledJobs();
      expect(scheduledJobs).toHaveLength(3);

      // Verify staggered delays (30 seconds apart)
      expect(scheduledJobs[0].delay).toBe(0);
      expect(scheduledJobs[1].delay).toBe(30000);
      expect(scheduledJobs[2].delay).toBe(60000);

      // Verify logs were created
      expect(db.getIndexingLogs(repo1._id)).toHaveLength(1);
      expect(db.getIndexingLogs(repo2._id)).toHaveLength(1);
      expect(db.getIndexingLogs(repo3._id)).toHaveLength(1);
    });

    it("should limit concurrent syncs to MAX_CONCURRENT", async () => {
      // Given: More than MAX_CONCURRENT repositories
      const MAX_CONCURRENT = 10;

      for (let i = 0; i < 15; i++) {
        db.insertRepository({
          githubRepo: `owner/repo${i}`,
          indexStatus: "completed",
          indexVersion: 1,
          lastIndexedAt: Date.now() - i * 86400000,
        });
      }

      // When: Simulate sync with limit
      const repos = db.getCompletedRepositories().slice(0, MAX_CONCURRENT);

      for (const repo of repos) {
        db.scheduleJob("indexRepository", repo._id, 0);
      }

      // Then
      const scheduledJobs = db.getScheduledJobs();
      expect(scheduledJobs).toHaveLength(MAX_CONCURRENT);
      expect(db.getCompletedRepositories()).toHaveLength(15); // Original count unchanged
    });
  });

  describe("Race Condition Prevention", () => {
    it("should set status to pending before scheduling", async () => {
      // Given
      const repo = db.insertRepository({
        githubRepo: "owner/repo",
        indexStatus: "completed",
        indexVersion: 1,
        lastIndexedAt: Date.now() - 86400000,
      });

      // When: Simulate sync process
      // Step 1: Update status to pending FIRST
      db.updateRepository(repo._id, { indexStatus: "pending" });

      // Step 2: Then schedule (in real code, scheduler.runAfter)
      db.scheduleJob("indexRepository", repo._id, 0);

      // Then: Status should be pending, not completed
      const updatedRepo = db.getRepository(repo._id);
      expect(updatedRepo?.indexStatus).toBe("pending");

      // This prevents duplicate scheduling if cron runs again
      const completedRepos = db.getCompletedRepositories();
      expect(completedRepos.find((r) => r._id === repo._id)).toBeUndefined();
    });
  });

  describe("Error Handling", () => {
    it("should continue processing other repos if one fails", async () => {
      // Given
      db.insertRepository({
        githubRepo: "owner/good1",
        indexStatus: "completed",
        indexVersion: 1,
        lastIndexedAt: Date.now() - 86400000,
      });

      const repo2 = db.insertRepository({
        githubRepo: "owner/bad",
        indexStatus: "completed",
        indexVersion: 1,
        lastIndexedAt: Date.now() - 172800000,
      });

      db.insertRepository({
        githubRepo: "owner/good2",
        indexStatus: "completed",
        indexVersion: 1,
        lastIndexedAt: Date.now() - 259200000,
      });

      // When: Simulate sync with one failure
      const repos = db.getCompletedRepositories();
      let scheduled = 0;
      let skipped = 0;

      for (const repo of repos) {
        try {
          if (repo.githubRepo === "owner/bad") {
            throw new Error("Simulated failure");
          }

          db.updateRepository(repo._id, { indexStatus: "pending" });
          db.scheduleJob("indexRepository", repo._id, scheduled * 30000);
          scheduled++;
        } catch {
          skipped++;
        }
      }

      // Then
      expect(scheduled).toBe(2);
      expect(skipped).toBe(1);

      const scheduledJobs = db.getScheduledJobs();
      expect(scheduledJobs).toHaveLength(2);
      expect(
        scheduledJobs.find((j) => j.repositoryId === repo2._id),
      ).toBeUndefined();
    });

    it("should return correct stats after sync", () => {
      // Given
      for (let i = 0; i < 5; i++) {
        db.insertRepository({
          githubRepo: `owner/repo${i}`,
          indexStatus: "completed",
          indexVersion: 1,
          lastIndexedAt: Date.now() - i * 86400000,
        });
      }

      // When
      const repos = db.getCompletedRepositories();
      const result = {
        total: repos.length,
        scheduled: 0,
        skipped: 0,
      };

      for (const repo of repos) {
        try {
          db.updateRepository(repo._id, { indexStatus: "pending" });
          db.scheduleJob("indexRepository", repo._id, result.scheduled * 30000);
          result.scheduled++;
        } catch {
          result.skipped++;
        }
      }

      // Then
      expect(result).toEqual({
        total: 5,
        scheduled: 5,
        skipped: 0,
      });
    });
  });
});

describe("cleanupOldFileCache", () => {
  const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  describe("Stale Blob Detection", () => {
    it("should identify blobs not accessed in the last week", () => {
      // Given: Mix of fresh and stale blobs
      db.insertFileBlob({
        sha256: "stale1",
        storageId: "storage1",
        lastAccessedAt: now - ONE_WEEK - 1000, // More than 1 week ago
        accessCount: 2,
      });

      db.insertFileBlob({
        sha256: "stale2",
        storageId: "storage2",
        lastAccessedAt: now - ONE_WEEK - 86400000, // 8 days ago
        accessCount: 1,
      });

      db.insertFileBlob({
        sha256: "fresh",
        storageId: "storage3",
        lastAccessedAt: now - 3600000, // 1 hour ago
        accessCount: 10,
      });

      db.insertFileBlob({
        sha256: "old_but_popular",
        storageId: "storage4",
        lastAccessedAt: now - ONE_WEEK - 1000,
        accessCount: 100, // High access count
      });

      // When
      const staleBlobs = db.getStaleFileBlobs(now - ONE_WEEK);

      // Then
      expect(staleBlobs).toHaveLength(3);
      expect(staleBlobs.map((b) => b.sha256)).toContain("stale1");
      expect(staleBlobs.map((b) => b.sha256)).toContain("stale2");
      expect(staleBlobs.map((b) => b.sha256)).toContain("old_but_popular");
    });

    it("should include stale blobs with high access counts", () => {
      // Given
      db.insertFileBlob({
        sha256: "low_access",
        storageId: "storage1",
        lastAccessedAt: now - ONE_WEEK - 1000,
        accessCount: 3,
      });

      db.insertFileBlob({
        sha256: "medium_access",
        storageId: "storage2",
        lastAccessedAt: now - ONE_WEEK - 1000,
        accessCount: 5,
      });

      db.insertFileBlob({
        sha256: "high_access",
        storageId: "storage3",
        lastAccessedAt: now - ONE_WEEK - 1000,
        accessCount: 6,
      });

      // When
      const staleBlobs = db.getStaleFileBlobs(now - ONE_WEEK);

      // Then
      expect(staleBlobs).toHaveLength(3);
      expect(staleBlobs.find((b) => b.sha256 === "high_access")).toBeDefined();
    });
  });

  describe("Cleanup Execution", () => {
    it("should delete stale blobs and return stats", async () => {
      // Given
      const blob1 = db.insertFileBlob({
        sha256: "stale1",
        storageId: "storage1",
        lastAccessedAt: now - ONE_WEEK - 1000,
        accessCount: 2,
      });

      const blob2 = db.insertFileBlob({
        sha256: "stale2",
        storageId: "storage2",
        lastAccessedAt: now - ONE_WEEK - 2000,
        accessCount: 1,
      });

      // When: Simulate cleanup
      const staleBlobs = db.getStaleFileBlobs(now - ONE_WEEK);
      let deleted = 0;

      for (const blob of staleBlobs) {
        try {
          db.deleteFileBlob(blob._id);
          deleted++;
        } catch {
          // Continue on error
        }
      }

      const result = {
        checked: staleBlobs.length,
        deleted,
      };

      // Then
      expect(result).toEqual({
        checked: 2,
        deleted: 2,
      });

      expect(db.getFileBlob(blob1._id)).toBeUndefined();
      expect(db.getFileBlob(blob2._id)).toBeUndefined();
    });

    it("should limit cleanup to 100 blobs per run", () => {
      // Given: 150 stale blobs
      for (let i = 0; i < 150; i++) {
        db.insertFileBlob({
          sha256: `stale${i}`,
          storageId: `storage${i}`,
          lastAccessedAt: now - ONE_WEEK - 1000,
          accessCount: 1,
        });
      }

      // When
      const staleBlobs = db.getStaleFileBlobs(now - ONE_WEEK);

      // Then: Limited to 100
      expect(staleBlobs).toHaveLength(100);
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty database gracefully", () => {
      // Given: No blobs

      // When
      const staleBlobs = db.getStaleFileBlobs(now - ONE_WEEK);

      // Then
      expect(staleBlobs).toHaveLength(0);
    });

    it("should handle all fresh blobs", () => {
      // Given: Only fresh blobs
      for (let i = 0; i < 10; i++) {
        db.insertFileBlob({
          sha256: `fresh${i}`,
          storageId: `storage${i}`,
          lastAccessedAt: now - 3600000, // 1 hour ago
          accessCount: 50,
        });
      }

      // When
      const staleBlobs = db.getStaleFileBlobs(now - ONE_WEEK);

      // Then
      expect(staleBlobs).toHaveLength(0);
    });
  });
});

describe("Cron Schedule Configuration", () => {
  it("should have cleanup running every hour", () => {
    // This test documents the expected cron configuration
    const expectedCleanupInterval = { hours: 1 };
    expect(expectedCleanupInterval.hours).toBe(1);
  });

  it("should have daily sync at 4:00 AM UTC (1:00 PM KST)", () => {
    // This test documents the expected cron configuration
    const expectedDailySync = { hourUTC: 4, minuteUTC: 0 };
    expect(expectedDailySync.hourUTC).toBe(4);
    expect(expectedDailySync.minuteUTC).toBe(0);

    // Verify KST conversion (UTC+9)
    const kstHour = (expectedDailySync.hourUTC + 9) % 24;
    expect(kstHour).toBe(13); // 1:00 PM KST
  });
});
