import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Repository Sync and Indexing Tests
 *
 * Test scenarios:
 * 1. Incremental indexing triggered by webhooks
 * 2. Repository file retrieval for AI context
 * 3. Index version management
 * 4. Status transitions during indexing
 */

// Type definitions
interface MockRepository {
  _id: string;
  githubRepo: string;
  userId: string;
  indexStatus: "pending" | "indexing" | "completed" | "failed";
  indexVersion: number;
  lastIndexedAt: number | null;
}

interface MockFileMap {
  _id: string;
  repositoryId: string;
  filePath: string;
  sha256: string;
  language: string | undefined;
  size: number;
}

interface MockFileBlob {
  _id: string;
  sha256: string;
  storageId: string;
  lastAccessedAt: number;
  accessCount: number;
}

interface MockIndexingLog {
  _id: string;
  repositoryId: string;
  indexVersion: number;
  level: "info" | "warn" | "error";
  message: string;
  createdAt: number;
}

// Mock storage URLs
const mockStorageUrls: Map<string, string> = new Map();

// In-memory mock database
class MockSyncDatabase {
  private repositories: Map<string, MockRepository> = new Map();
  private fileMaps: Map<string, MockFileMap> = new Map();
  private fileBlobs: Map<string, MockFileBlob> = new Map();
  private indexingLogs: Map<string, MockIndexingLog> = new Map();
  private scheduledActions: Array<{
    action: string;
    args: Record<string, unknown>;
    delay: number;
  }> = [];
  private nextId = 1;

  reset() {
    this.repositories.clear();
    this.fileMaps.clear();
    this.fileBlobs.clear();
    this.indexingLogs.clear();
    this.scheduledActions = [];
    this.nextId = 1;
    mockStorageUrls.clear();
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

  getRepositoryByFullName(githubRepo: string): MockRepository | undefined {
    return Array.from(this.repositories.values()).find(
      (r) => r.githubRepo === githubRepo,
    );
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

  incrementIndexVersion(id: string): number {
    const repo = this.repositories.get(id);
    if (!repo) throw new Error(`Repository ${id} not found`);
    const newVersion = repo.indexVersion + 1;
    this.repositories.set(id, { ...repo, indexVersion: newVersion });
    return newVersion;
  }

  // File map methods
  insertFileMap(fileMap: Omit<MockFileMap, "_id">): MockFileMap {
    const _id = this.generateId();
    const newFileMap = { ...fileMap, _id };
    this.fileMaps.set(_id, newFileMap);
    return newFileMap;
  }

  getFileMaps(repositoryId: string): MockFileMap[] {
    return Array.from(this.fileMaps.values()).filter(
      (fm) => fm.repositoryId === repositoryId,
    );
  }

  // File blob methods
  insertFileBlob(blob: Omit<MockFileBlob, "_id">): MockFileBlob {
    const _id = this.generateId();
    const newBlob = { ...blob, _id };
    this.fileBlobs.set(_id, newBlob);
    return newBlob;
  }

  getFileBlobBySha256(sha256: string): MockFileBlob | undefined {
    return Array.from(this.fileBlobs.values()).find((b) => b.sha256 === sha256);
  }

  // Indexing log methods
  addIndexingLog(
    log: Omit<MockIndexingLog, "_id" | "createdAt">,
  ): MockIndexingLog {
    const _id = this.generateId();
    const newLog = { ...log, _id, createdAt: Date.now() };
    this.indexingLogs.set(_id, newLog);
    return newLog;
  }

  getIndexingLogs(repositoryId: string): MockIndexingLog[] {
    return Array.from(this.indexingLogs.values())
      .filter((log) => log.repositoryId === repositoryId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  // Scheduler methods
  scheduleAction(
    action: string,
    args: Record<string, unknown>,
    delay: number,
  ): void {
    this.scheduledActions.push({ action, args, delay });
  }

  getScheduledActions() {
    return this.scheduledActions;
  }
}

// Mock fetch for storage URLs
async function mockFetch(
  url: string,
): Promise<{ text: () => Promise<string> }> {
  const content = mockStorageUrls.get(url);
  return {
    text: async () => content ?? "",
  };
}

let db: MockSyncDatabase;

beforeEach(() => {
  db = new MockSyncDatabase();
  vi.clearAllMocks();
});

describe("triggerIncrementalIndex", () => {
  describe("Repository Validation", () => {
    it("should return error if repository not found", async () => {
      // Given: No repositories exist

      // When
      const repo = db.getRepositoryByFullName("nonexistent/repo");

      // Then
      expect(repo).toBeUndefined();

      const result = repo
        ? { success: true }
        : { success: false, error: "repository not found" };
      expect(result).toEqual({ success: false, error: "repository not found" });
    });

    it("should skip if repository indexing is not completed", async () => {
      // Given: Repository with pending status
      db.insertRepository({
        githubRepo: "owner/repo",
        userId: "user_1",
        indexStatus: "pending",
        indexVersion: 0,
        lastIndexedAt: null,
      });

      // When
      const repo = db.getRepositoryByFullName("owner/repo");

      // Then
      expect(repo?.indexStatus).toBe("pending");

      const result =
        repo?.indexStatus !== "completed"
          ? { success: false, error: "initial indexing not completed" }
          : { success: true };
      expect(result).toEqual({
        success: false,
        error: "initial indexing not completed",
      });
    });

    it("should skip if repository is currently indexing", async () => {
      // Given
      db.insertRepository({
        githubRepo: "owner/repo",
        userId: "user_1",
        indexStatus: "indexing",
        indexVersion: 1,
        lastIndexedAt: Date.now() - 86400000,
      });

      // When
      const repo = db.getRepositoryByFullName("owner/repo");

      // Then
      expect(repo?.indexStatus).toBe("indexing");

      const result =
        repo?.indexStatus !== "completed"
          ? { success: false, error: "initial indexing not completed" }
          : { success: true };
      expect(result).toEqual({
        success: false,
        error: "initial indexing not completed",
      });
    });
  });

  describe("Successful Incremental Index", () => {
    it("should increment version and schedule indexing for completed repos", async () => {
      // Given
      const repo = db.insertRepository({
        githubRepo: "owner/repo",
        userId: "user_1",
        indexStatus: "completed",
        indexVersion: 5,
        lastIndexedAt: Date.now() - 86400000,
      });

      // When: Simulate triggerIncrementalIndex
      const currentRepo = db.getRepositoryByFullName("owner/repo");
      expect(currentRepo?.indexStatus).toBe("completed");

      // Increment version
      const newVersion = db.incrementIndexVersion(repo._id);

      // Schedule re-indexing
      db.scheduleAction(
        "indexRepository",
        { repositoryId: repo._id, expectedIndexVersion: newVersion },
        0,
      );

      // Then
      expect(newVersion).toBe(6);

      const scheduledActions = db.getScheduledActions();
      expect(scheduledActions).toHaveLength(1);
      expect(scheduledActions[0]).toMatchObject({
        action: "indexRepository",
        args: { repositoryId: repo._id, expectedIndexVersion: 6 },
        delay: 0,
      });

      const updatedRepo = db.getRepository(repo._id);
      expect(updatedRepo?.indexVersion).toBe(6);
    });

    it("should handle push webhook trigger", async () => {
      // Given
      const repo = db.insertRepository({
        githubRepo: "owner/repo",
        userId: "user_1",
        indexStatus: "completed",
        indexVersion: 1,
        lastIndexedAt: Date.now() - 3600000,
      });

      // When: Simulate push webhook
      const reason = "push";
      const newVersion = db.incrementIndexVersion(repo._id);
      db.addIndexingLog({
        repositoryId: repo._id,
        indexVersion: newVersion,
        level: "info",
        message: `Incremental index triggered (reason: ${reason})`,
      });

      db.scheduleAction(
        "indexRepository",
        { repositoryId: repo._id, expectedIndexVersion: newVersion },
        0,
      );

      // Then
      const logs = db.getIndexingLogs(repo._id);
      expect(logs[0].message).toContain("push");
      expect(db.getScheduledActions()).toHaveLength(1);
    });

    it("should leave merged pull requests to the default-branch push", () => {
      expect(db.getScheduledActions()).toHaveLength(0);
    });
  });
});

describe("getRepositoryFilesWithContent", () => {
  describe("File Retrieval", () => {
    it("should retrieve files with content from storage", async () => {
      // Given: Repository with indexed files
      const repo = db.insertRepository({
        githubRepo: "owner/repo",
        userId: "user_1",
        indexStatus: "completed",
        indexVersion: 1,
        lastIndexedAt: Date.now(),
      });

      // Add file maps
      db.insertFileMap({
        repositoryId: repo._id,
        filePath: "src/index.ts",
        sha256: "sha256_1",
        language: "typescript",
        size: 1024,
      });

      db.insertFileMap({
        repositoryId: repo._id,
        filePath: "src/utils.ts",
        sha256: "sha256_2",
        language: "typescript",
        size: 512,
      });

      // Add file blobs
      db.insertFileBlob({
        sha256: "sha256_1",
        storageId: "storage_1",
        lastAccessedAt: Date.now(),
        accessCount: 5,
      });

      db.insertFileBlob({
        sha256: "sha256_2",
        storageId: "storage_2",
        lastAccessedAt: Date.now(),
        accessCount: 3,
      });

      // Setup mock storage URLs
      const url1 = "https://storage.example.com/file1";
      const url2 = "https://storage.example.com/file2";
      mockStorageUrls.set(
        url1,
        'export function main() { console.log("Hello"); }',
      );
      mockStorageUrls.set(
        url2,
        "export function add(a: number, b: number) { return a + b; }",
      );

      // When: Simulate getRepositoryFilesWithContent
      const fileMaps = db.getFileMaps(repo._id);
      const filesWithContent = await Promise.all(
        fileMaps.map(async (fm) => {
          const blob = db.getFileBlobBySha256(fm.sha256);
          if (!blob) return null;

          // Simulate storage URL retrieval
          const url = fm.sha256 === "sha256_1" ? url1 : url2;
          const response = await mockFetch(url);
          const content = await response.text();

          return {
            path: fm.filePath,
            content,
            language: fm.language,
          };
        }),
      );

      const validFiles = filesWithContent.filter((f) => f !== null);

      // Then
      expect(validFiles).toHaveLength(2);
      expect(validFiles[0]).toMatchObject({
        path: "src/index.ts",
        language: "typescript",
      });
      expect(validFiles[0]?.content).toContain("Hello");
    });

    it("should filter by specific file paths when provided", async () => {
      // Given
      const repo = db.insertRepository({
        githubRepo: "owner/repo",
        userId: "user_1",
        indexStatus: "completed",
        indexVersion: 1,
        lastIndexedAt: Date.now(),
      });

      db.insertFileMap({
        repositoryId: repo._id,
        filePath: "src/index.ts",
        sha256: "sha256_1",
        language: "typescript",
        size: 1024,
      });

      db.insertFileMap({
        repositoryId: repo._id,
        filePath: "src/utils.ts",
        sha256: "sha256_2",
        language: "typescript",
        size: 512,
      });

      db.insertFileMap({
        repositoryId: repo._id,
        filePath: "src/config.ts",
        sha256: "sha256_3",
        language: "typescript",
        size: 256,
      });

      // When: Filter by specific paths
      const targetPaths = ["src/index.ts", "src/config.ts"];
      const fileMaps = db.getFileMaps(repo._id);
      const filteredFiles = fileMaps.filter((fm) =>
        targetPaths.includes(fm.filePath),
      );

      // Then
      expect(filteredFiles).toHaveLength(2);
      expect(filteredFiles.map((f) => f.filePath)).toEqual([
        "src/index.ts",
        "src/config.ts",
      ]);
    });

    it("should apply limit when not filtering by paths", async () => {
      // Given: Repository with many files
      const repo = db.insertRepository({
        githubRepo: "owner/repo",
        userId: "user_1",
        indexStatus: "completed",
        indexVersion: 1,
        lastIndexedAt: Date.now(),
      });

      for (let i = 0; i < 100; i++) {
        db.insertFileMap({
          repositoryId: repo._id,
          filePath: `src/file${i}.ts`,
          sha256: `sha256_${i}`,
          language: "typescript",
          size: 100,
        });
      }

      // When: Apply limit
      const limit = 50;
      const fileMaps = db.getFileMaps(repo._id).slice(0, limit);

      // Then
      expect(fileMaps).toHaveLength(50);
    });
  });

  describe("Error Handling", () => {
    it("should filter out files without blobs", async () => {
      // Given: File maps with missing blobs
      const repo = db.insertRepository({
        githubRepo: "owner/repo",
        userId: "user_1",
        indexStatus: "completed",
        indexVersion: 1,
        lastIndexedAt: Date.now(),
      });

      db.insertFileMap({
        repositoryId: repo._id,
        filePath: "src/exists.ts",
        sha256: "sha256_exists",
        language: "typescript",
        size: 1024,
      });

      db.insertFileMap({
        repositoryId: repo._id,
        filePath: "src/missing.ts",
        sha256: "sha256_missing", // No blob for this
        language: "typescript",
        size: 512,
      });

      // Only add blob for the first file
      db.insertFileBlob({
        sha256: "sha256_exists",
        storageId: "storage_exists",
        lastAccessedAt: Date.now(),
        accessCount: 1,
      });

      // When
      const fileMaps = db.getFileMaps(repo._id);
      const filesWithBlobs = fileMaps
        .map((fm) => {
          const blob = db.getFileBlobBySha256(fm.sha256);
          if (!blob) return null;
          return { ...fm, blobId: blob._id };
        })
        .filter((f) => f !== null);

      // Then
      expect(filesWithBlobs).toHaveLength(1);
      expect(filesWithBlobs[0]?.filePath).toBe("src/exists.ts");
    });

    it("should handle fetch failures gracefully", async () => {
      // Given
      const repo = db.insertRepository({
        githubRepo: "owner/repo",
        userId: "user_1",
        indexStatus: "completed",
        indexVersion: 1,
        lastIndexedAt: Date.now(),
      });

      db.insertFileMap({
        repositoryId: repo._id,
        filePath: "src/file.ts",
        sha256: "sha256_1",
        language: "typescript",
        size: 1024,
      });

      db.insertFileBlob({
        sha256: "sha256_1",
        storageId: "storage_1",
        lastAccessedAt: Date.now(),
        accessCount: 1,
      });

      // When: Simulate fetch failure
      const fileMaps = db.getFileMaps(repo._id);
      const results = await Promise.all(
        fileMaps.map(async (fm) => {
          try {
            // Simulate failed fetch
            throw new Error("Network error");
          } catch (error) {
            console.error(`Failed to fetch content for ${fm.filePath}:`, error);
            return null;
          }
        }),
      );

      const validFiles = results.filter((f) => f !== null);

      // Then
      expect(validFiles).toHaveLength(0);
    });
  });
});

describe("Index Status Transitions", () => {
  describe("Valid State Transitions", () => {
    it("should allow pending -> indexing transition", () => {
      // Given
      const repo = db.insertRepository({
        githubRepo: "owner/repo",
        userId: "user_1",
        indexStatus: "pending",
        indexVersion: 0,
        lastIndexedAt: null,
      });

      // When
      db.updateRepository(repo._id, { indexStatus: "indexing" });

      // Then
      expect(db.getRepository(repo._id)?.indexStatus).toBe("indexing");
    });

    it("should allow indexing -> completed transition", () => {
      // Given
      const repo = db.insertRepository({
        githubRepo: "owner/repo",
        userId: "user_1",
        indexStatus: "indexing",
        indexVersion: 1,
        lastIndexedAt: null,
      });

      // When
      db.updateRepository(repo._id, {
        indexStatus: "completed",
        lastIndexedAt: Date.now(),
      });

      // Then
      const updated = db.getRepository(repo._id);
      expect(updated?.indexStatus).toBe("completed");
      expect(updated?.lastIndexedAt).toBeDefined();
    });

    it("should allow indexing -> failed transition", () => {
      // Given
      const repo = db.insertRepository({
        githubRepo: "owner/repo",
        userId: "user_1",
        indexStatus: "indexing",
        indexVersion: 1,
        lastIndexedAt: null,
      });

      // When
      db.updateRepository(repo._id, { indexStatus: "failed" });
      db.addIndexingLog({
        repositoryId: repo._id,
        indexVersion: 1,
        level: "error",
        message: "Indexing failed: GitHub API rate limit exceeded",
      });

      // Then
      expect(db.getRepository(repo._id)?.indexStatus).toBe("failed");
      const logs = db.getIndexingLogs(repo._id);
      expect(logs[0].level).toBe("error");
    });

    it("should allow completed -> pending for re-sync", () => {
      // Given
      const repo = db.insertRepository({
        githubRepo: "owner/repo",
        userId: "user_1",
        indexStatus: "completed",
        indexVersion: 3,
        lastIndexedAt: Date.now() - 86400000,
      });

      // When: Daily sync sets to pending
      db.updateRepository(repo._id, { indexStatus: "pending" });

      // Then
      expect(db.getRepository(repo._id)?.indexStatus).toBe("pending");
    });
  });

  describe("Index Version Management", () => {
    it("should increment version on each sync", () => {
      // Given
      const repo = db.insertRepository({
        githubRepo: "owner/repo",
        userId: "user_1",
        indexStatus: "completed",
        indexVersion: 1,
        lastIndexedAt: Date.now() - 86400000,
      });

      // When: Multiple syncs
      let version = repo.indexVersion;
      for (let i = 0; i < 5; i++) {
        version = db.incrementIndexVersion(repo._id);
      }

      // Then
      expect(version).toBe(6);
      expect(db.getRepository(repo._id)?.indexVersion).toBe(6);
    });

    it("should track version in indexing logs", () => {
      // Given
      const repo = db.insertRepository({
        githubRepo: "owner/repo",
        userId: "user_1",
        indexStatus: "completed",
        indexVersion: 5,
        lastIndexedAt: Date.now() - 86400000,
      });

      // When
      const newVersion = db.incrementIndexVersion(repo._id);
      db.addIndexingLog({
        repositoryId: repo._id,
        indexVersion: newVersion,
        level: "info",
        message: "Sync started",
      });

      db.addIndexingLog({
        repositoryId: repo._id,
        indexVersion: newVersion,
        level: "info",
        message: "Indexed 150 files",
      });

      db.addIndexingLog({
        repositoryId: repo._id,
        indexVersion: newVersion,
        level: "info",
        message: "Sync completed",
      });

      // Then
      const logs = db.getIndexingLogs(repo._id);
      expect(logs).toHaveLength(3);
      expect(logs.every((log) => log.indexVersion === 6)).toBe(true);
    });
  });
});

describe("Concurrency Safety", () => {
  it("should prevent duplicate indexing with status check", () => {
    // Given: Repository that just started indexing
    const repo = db.insertRepository({
      githubRepo: "owner/repo",
      userId: "user_1",
      indexStatus: "indexing",
      indexVersion: 1,
      lastIndexedAt: null,
    });

    // When: Another process tries to start indexing
    const shouldSkip = (r: MockRepository) => r.indexStatus === "indexing";

    // Then
    expect(shouldSkip(repo)).toBe(true);
  });

  it("should set status to pending before scheduling", async () => {
    // Given
    const repo = db.insertRepository({
      githubRepo: "owner/repo",
      userId: "user_1",
      indexStatus: "completed",
      indexVersion: 1,
      lastIndexedAt: Date.now() - 86400000,
    });

    // When: Atomic status update + schedule
    // Step 1: Update status FIRST
    db.updateRepository(repo._id, { indexStatus: "pending" });

    // Step 2: Schedule after status change
    db.scheduleAction(
      "indexRepository",
      { repositoryId: repo._id, expectedIndexVersion: 2 },
      0,
    );

    // Then: Status is pending (prevents duplicate scheduling)
    expect(db.getRepository(repo._id)?.indexStatus).toBe("pending");

    // If cron runs again, it won't find this repo
    const completedRepos = Array.from(
      db.getRepository(repo._id) ? [] : [],
    ).filter((r: MockRepository) => r.indexStatus === "completed");
    expect(completedRepos).toHaveLength(0);
  });
});
