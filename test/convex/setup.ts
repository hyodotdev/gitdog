// Test setup file
import { beforeEach, vi } from "vitest";
import * as globModule from "glob";

// Make glob available globally for convex-test
// convex-test expects glob.glob to be a function
(globalThis as Record<string, unknown>).glob = globModule.glob.bind(globModule);

beforeEach(() => {
  // Reset all mocks before each test
  vi.clearAllMocks();
});

// Mock environment variables
process.env.GITHUB_APP_ID = "test-app-id";
process.env.GITHUB_APP_PRIVATE_KEY = "test-private-key";
process.env.GITHUB_APP_SLUG = "gitdogbot";
process.env.FREE_TIER_ENABLED = "true";
process.env.PAID_PROJECT_BILLING_ENABLED = "true";

// Unit tests must never inherit a real provider key from local development files.
process.env.OPENAI_API_KEY = "test-openai-key";
