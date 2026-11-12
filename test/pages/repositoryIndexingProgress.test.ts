import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepositoryIndexingProgress } from "../../src/pages/home/RepositoryIndexingProgress";
import type { PublicRepository } from "../../convex/repositories/query";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      `${key}${values ? JSON.stringify(values) : ""}`,
  }),
}));

const now = Date.parse("2026-11-04T05:00:00Z");
const repository = {
  isActive: true,
  indexVersion: 8,
  indexStatus: "completed",
  ragStatus: "indexing",
  ragIndexedChunks: 4891,
  ragTotalChunks: 5019,
  indexingProgress: {
    phase: "search",
    lastProgressAt: now - 60_000,
    staleAt: now + 11 * 60_000,
    processedFiles: 671,
    syncQueued: false,
  },
} as PublicRepository;

afterEach(() => vi.restoreAllMocks());

function render(overrides: Partial<PublicRepository> = {}) {
  vi.spyOn(Date, "now").mockReturnValue(now);
  return renderToStaticMarkup(
    createElement(RepositoryIndexingProgress, {
      repository: { ...repository, ...overrides },
    }),
  );
}

describe("repository indexing progress", () => {
  it("shows observed search work instead of an invented full-repository percentage", () => {
    const html = render({
      indexingProgress: { ...repository.indexingProgress!, syncQueued: true },
    });
    expect(html).toContain("repoCard.indexingSearch");
    expect(html).toContain("&quot;chunks&quot;:4891");
    expect(html).toContain("&quot;files&quot;:671");
    expect(html).toContain("&quot;minutes&quot;:1");
    expect(html).toContain("repoCard.syncQueued");
    expect(html).not.toContain("%");
    expect(html).not.toContain("repoCard.stalled");
  });

  it("surfaces a missing heartbeat at the shared recovery deadline", () => {
    const html = render({
      indexingProgress: {
        ...repository.indexingProgress!,
        lastProgressAt: now - 12 * 60_000,
        staleAt: now,
      },
    });
    expect(html).toContain("repoCard.stalled");
    expect(html).toContain("repoCard.stalledHelp");
    expect(html).not.toContain("repoCard.indexingSearch");
  });

  it("does not label a durable GitHub rate-limit wait as stalled", () => {
    const html = render({
      indexStatus: "indexing",
      ragStatus: "pending",
      indexingProgress: {
        ...repository.indexingProgress!,
        phase: "files",
        lastProgressAt: now - 30 * 60_000,
        staleAt: now + 13 * 60_000,
      },
    });
    expect(html).toContain("repoCard.indexingCode");
    expect(html).not.toContain("repoCard.stalled");
  });

  it("labels bounded cleanup as finalizing instead of more source work", () => {
    const html = render({
      indexingProgress: { ...repository.indexingProgress!, phase: "cleanup" },
    });
    expect(html).toContain("repoCard.finalizingSearch");
    expect(html).not.toContain("repoCard.indexingSearch");
  });
});
