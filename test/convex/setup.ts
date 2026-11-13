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

// Quota tests depend on the free monthly allowance, which ends at a fixed
// date (FREE_MONTHLY_ALLOWANCE_ENDS_AT). Run the wall clock from a fixed
// point before that date so results do not change once it passes. Tests
// that need another time still mock Date.now or use fake timers.
const PINNED_TEST_START = Date.parse("2026-11-15T12:00:00.000Z");
const realDateNow = Date.now.bind(Date);
const clockOffset = PINNED_TEST_START - realDateNow();
Date.now = () => realDateNow() + clockOffset;
