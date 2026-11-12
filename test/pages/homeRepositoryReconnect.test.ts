import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";

const mocks = {
  useQuery: vi.fn(),
};

vi.mock("convex/react", () => ({
  useQuery: mocks.useQuery,
  useAction: () => vi.fn(),
}));

vi.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({ signIn: vi.fn() }),
}));

vi.mock("react-router", () => ({
  Link: ({ children }: { children: ReactNode }) =>
    createElement("a", null, children),
  useNavigate: () => vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../src/components/Layout", () => ({
  Layout: ({ children }: { children: ReactNode }) =>
    createElement("main", null, children),
}));

vi.mock("../../src/components/SEO", () => ({
  SEO: () => createElement(Fragment),
}));

vi.mock("../../src/components/JsonLd", () => ({
  FAQPageJsonLd: () => createElement(Fragment),
  SoftwareApplicationJsonLd: () => createElement(Fragment),
}));

let HomePage: typeof import("../../src/pages/home").HomePage;
let IndexingStatus: typeof import("../../src/pages/home/IndexingStatus").IndexingStatus;

beforeAll(async () => {
  ({ HomePage } = await import("../../src/pages/home"));
  ({ IndexingStatus } = await import("../../src/pages/home/IndexingStatus"));
});

beforeEach(() => {
  mocks.useQuery.mockReset();
});

describe("workspace repository reconnect", () => {
  it("shows a reconnect CTA instead of generic paused or failed state", () => {
    const reconnectRepository = {
      _id: "reconnect-repository-id",
      userId: "owner-id",
      installationId: 123,
      githubRepositoryId: 456,
      githubRepo: "owner/reconnect-repo",
      githubRepoKey: "owner/reconnect-repo",
      name: "reconnect-repo",
      githubUrl: "https://github.com/owner/reconnect-repo",
      description: null,
      language: null,
      isActive: false,
      githubInstallationReconnectRequired: true,
      indexStatus: "failed",
      ragStatus: "failed",
      userRole: "owner",
      settings: {},
      monthlyActions: 0,
    };
    mocks.useQuery
      .mockReturnValueOnce([reconnectRepository])
      .mockReturnValueOnce({ _id: "owner-id" })
      .mockReturnValueOnce(null);

    const html = renderToStaticMarkup(createElement(HomePage));

    expect(html).toContain("home.workspace.repoCard.reconnectRequired");
    expect(html).toContain("home.workspace.repoCard.reconnectDescription");
    expect(html).toContain("home.workspace.repoCard.reconnectButton");
    expect(html).not.toContain("home.workspace.repoCard.paused");
    expect(html).not.toContain("home.workspace.repoCard.failed");
  });

  it("shows an inactive verified repository as paused without a failure badge", () => {
    const pausedRepository = {
      _id: "paused-repository-id",
      userId: "owner-id",
      installationId: 123,
      githubRepositoryId: 456,
      githubRepo: "owner/paused-repo",
      name: "paused-repo",
      githubUrl: "https://github.com/owner/paused-repo",
      description: null,
      language: null,
      isActive: false,
      indexStatus: "failed",
      ragStatus: "failed",
      userRole: "owner",
      settings: {},
      monthlyActions: 0,
    };
    mocks.useQuery
      .mockReturnValueOnce([pausedRepository])
      .mockReturnValueOnce({ _id: "owner-id" })
      .mockReturnValueOnce(null);

    const html = renderToStaticMarkup(createElement(HomePage));

    expect(html).toContain("home.workspace.repoCard.paused");
    expect(html).not.toContain("home.workspace.repoCard.failed");
  });

  it("presents paused indexing as intentional instead of failed", () => {
    mocks.useQuery.mockReturnValueOnce([]).mockReturnValueOnce({
      status: "failed",
      ragStatus: "failed",
      isActive: false,
      requiresReconnect: false,
      canRetry: true,
    });

    const html = renderToStaticMarkup(
      createElement(IndexingStatus, {
        repositoryId: "paused-repository-id" as Id<"repositories">,
        repositoryName: "owner/paused-repo",
      }),
    );

    expect(html).toContain("home.indexing.pausedTitle");
    expect(html).toContain("home.indexing.pausedDescription");
    expect(html).toContain("home.indexing.pausedTip");
    expect(html).not.toContain("home.indexing.connectionFailed");
    expect(html).not.toContain("home.indexing.failedTip");
  });

  it("prioritizes an installation reconnect CTA over revoked access", () => {
    mocks.useQuery.mockReturnValueOnce([]).mockReturnValueOnce({
      status: "failed",
      ragStatus: "failed",
      isActive: false,
      githubAccessRevoked: true,
      requiresReconnect: true,
      canReconnect: true,
      canRestoreGithubAccess: false,
      canRetry: false,
    });

    const html = renderToStaticMarkup(
      createElement(IndexingStatus, {
        repositoryId: "orphaned-installation-id" as Id<"repositories">,
        repositoryName: "owner/orphaned-installation",
      }),
    );

    expect(html).toContain("home.indexing.reconnectTitle");
    expect(html).toContain("home.indexing.reconnectDescription");
    expect(html).toContain("home.indexing.reconnectButton");
    expect(html).not.toContain("home.indexing.accessRevokedTitle");
    expect(html).not.toContain("home.indexing.accessRevokedDescription");
  });
});
