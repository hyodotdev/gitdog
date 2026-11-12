import path from "node:path";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import en from "../../src/i18n/locales/en.json";
import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = {
  localize: false,
  useQuery: vi.fn(),
  mutate: vi.fn(async () => undefined),
  act: vi.fn(async () => ({ success: true, message: "Sync started" })),
  teamSection: vi.fn(),
};

vi.mock("convex/react", () => ({
  useQuery: mocks.useQuery,
  useMutation: () => mocks.mutate,
  useAction: () => mocks.act,
}));

vi.mock("react-router", () => ({
  useParams: () => ({ owner: "owner", repo: "repo" }),
  useNavigate: () => vi.fn(),
}));

vi.mock("react-helmet-async", () => ({
  Helmet: ({ children }: { children: ReactNode }) =>
    createElement(Fragment, null, children),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (!mocks.localize) return key;
      const value = key
        .split(".")
        .reduce<unknown>(
          (v, k) =>
            v && typeof v === "object"
              ? (v as Record<string, unknown>)[k]
              : undefined,
          en,
        );
      return typeof value === "string" ? value : key;
    },
  }),
}));

vi.mock("../../src/components/Layout", () => ({
  Layout: ({ children }: { children: ReactNode }) =>
    createElement("main", null, children),
}));

vi.mock("../../src/components/TeamSection", () => ({
  TeamSection: (props: { invitationUnavailableReason?: string }) => {
    mocks.teamSection(props);
    return createElement("div", {
      "data-testid": "team-section",
      "data-invitation-availability":
        props.invitationUnavailableReason ?? "available",
    });
  },
}));

vi.mock("../../src/components/uis/Accordion", () => ({
  Accordion: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));

let RepositorySettingsPage: typeof import("../../src/pages/repositories/[owner]/[repo]").RepositorySettingsPage;

const originalLocalStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalDocument = Object.getOwnPropertyDescriptor(
  globalThis,
  "document",
);

beforeAll(async () => {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      matchMedia: () => ({
        matches: false,
        addEventListener: () => undefined,
      }),
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      documentElement: {
        classList: {
          add: () => undefined,
          remove: () => undefined,
        },
      },
    },
  });

  ({ RepositorySettingsPage } =
    await import("../../src/pages/repositories/[owner]/[repo]"));
});

afterAll(() => {
  for (const [key, descriptor] of [
    ["localStorage", originalLocalStorage],
    ["window", originalWindow],
    ["document", originalDocument],
  ] as const) {
    if (descriptor) {
      Object.defineProperty(globalThis, key, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, key);
    }
  }
});

const sharedRepository = {
  _id: "repository-id",
  userId: "owner-id",
  installationId: 123,
  githubRepositoryId: 456,
  githubRepo: "owner/repo",
  name: "repo",
  githubUrl: "https://github.com/owner/repo",
  isActive: true,
  indexStatus: "completed",
  ragStatus: "completed",
  userRole: "viewer",
  settings: {
    issueAssistantEnabled: true,
    autoFormatIssue: true,
    autoAnswerQuestions: true,
    tagMaintainersForCodeChanges: true,
    requireApproval: false,
    discussionAssistantEnabled: true,
    autoFormatDiscussion: true,
    autoAnswerDiscussionQuestions: true,
    tagMaintainersForDiscussionCodeChanges: true,
    requireApprovalForDiscussions: false,
  },
  monthlyActions: 0,
  lastResetAt: 1,
  createdAt: 1,
  updatedAt: 1,
};

beforeEach(() => {
  mocks.useQuery.mockReset();
  mocks.teamSection.mockReset();
  mocks.useQuery.mockImplementation(
    (_reference: unknown, args: Record<string, unknown> | "skip") =>
      args !== "skip" && "owner" in args ? sharedRepository : 0,
  );
});

describe("shared repository settings", () => {
  it("keeps settings, logs, and team visible without owner-only controls", () => {
    const html = renderToStaticMarkup(createElement(RepositorySettingsPage));

    expect(html).toContain("repositories.settings.logsButton");
    expect(html).toContain("repositories.settings.issueAssistant.title");
    expect(html).toContain('data-testid="team-section"');
    expect(html).not.toContain("repositories.settings.syncButton");
    expect(html).not.toContain("repositories.settings.pauseButton");
    expect(html).not.toContain("repositories.settings.saveButton");
    expect(html).not.toContain("repositories.settings.dangerZone.title");
    expect(html.match(/disabled=""/g)).toHaveLength(13);
    expect(html.match(/readOnly=""/g)).toHaveLength(2);
  });

  it("shows removed GitHub access and disables owner sync and activation", () => {
    const revokedRepository = {
      ...sharedRepository,
      userRole: "owner",
      isActive: false,
      githubAccessRevokedAt: 123,
    };
    mocks.useQuery.mockImplementation(
      (_reference: unknown, args: Record<string, unknown> | "skip") =>
        args !== "skip" && "owner" in args ? revokedRepository : 0,
    );

    const html = renderToStaticMarkup(createElement(RepositorySettingsPage));

    expect(html).toContain("repositories.settings.githubAccessRemoved");
    expect(html).toContain(
      "repositories.settings.githubAccessRemovedDescription",
    );
    expect(html).toContain("repositories.settings.manageGithubAccess");
    expect(html).toContain(
      'href="https://github.com/settings/installations/123"',
    );
    expect(html).toContain('data-invitation-availability="revoked"');
    expect(html).toContain("repositories.settings.syncButton");
    expect(html).toContain("repositories.settings.activateButton");
    expect(html.match(/disabled=""/g)).toHaveLength(3);
  });

  it("does not expose installation management to a shared viewer", () => {
    const revokedRepository = {
      ...sharedRepository,
      githubAccessRevokedAt: 123,
    };
    mocks.useQuery.mockImplementation(
      (_reference: unknown, args: Record<string, unknown> | "skip") =>
        args !== "skip" && "owner" in args ? revokedRepository : 0,
    );

    const html = renderToStaticMarkup(createElement(RepositorySettingsPage));

    expect(html).toContain(
      "repositories.settings.githubAccessRemovedDescription",
    );
    expect(html).not.toContain("repositories.settings.manageGithubAccess");
    expect(html).not.toContain("github.com/settings/installations/123");
  });

  it("prioritizes explicit installation reconnect over the revoked-access UI", () => {
    const reconnectRepository = {
      ...sharedRepository,
      userRole: "owner",
      isActive: false,
      githubAccessRevokedAt: 123,
      githubInstallationReconnectRequired: true,
      indexStatus: "failed",
      ragStatus: "failed",
    };
    mocks.useQuery.mockImplementation(
      (_reference: unknown, args: Record<string, unknown> | "skip") =>
        args !== "skip" && "owner" in args ? reconnectRepository : 0,
    );

    const html = renderToStaticMarkup(createElement(RepositorySettingsPage));

    expect(html).toContain("repositories.settings.reconnectRequired");
    expect(html).toContain("repositories.settings.reconnectDescription");
    expect(html).not.toContain("repositories.settings.manageGithubAccess");
    expect(html).not.toContain("github.com/settings/installations/123");
  });

  it("keeps invitations available when only automation is paused", () => {
    const pausedRepository = {
      ...sharedRepository,
      userRole: "owner",
      isActive: false,
    };
    mocks.useQuery.mockImplementation(
      (_reference: unknown, args: Record<string, unknown> | "skip") =>
        args !== "skip" && "owner" in args ? pausedRepository : 0,
    );

    const html = renderToStaticMarkup(createElement(RepositorySettingsPage));

    expect(html).toContain('data-invitation-availability="available"');
    expect(mocks.teamSection).toHaveBeenCalledWith(
      expect.objectContaining({ invitationUnavailableReason: undefined }),
    );
  });

  it("uses the backend installation reconciliation reason for invitations", () => {
    const reconcilingRepository = {
      ...sharedRepository,
      userRole: "owner",
      invitationUnavailableReason: "syncing" as const,
    };
    mocks.useQuery.mockImplementation(
      (_reference: unknown, args: Record<string, unknown> | "skip") =>
        args !== "skip" && "owner" in args ? reconcilingRepository : 0,
    );

    const html = renderToStaticMarkup(createElement(RepositorySettingsPage));

    expect(html).toContain('data-invitation-availability="syncing"');
    expect(mocks.teamSection).toHaveBeenCalledWith(
      expect.objectContaining({ invitationUnavailableReason: "syncing" }),
    );
  });
});

it("offers owner PR controls with safe defaults", () => {
  const repository = { ...sharedRepository, userRole: "owner" };
  mocks.useQuery.mockImplementation(
    (_reference: unknown, args: Record<string, unknown> | "skip") =>
      args !== "skip" && "owner" in args ? repository : 0,
  );
  const html = renderToStaticMarkup(createElement(RepositorySettingsPage));
  expect(html).toContain("repositories.settings.pullRequests.enabled");
  expect(html).toContain("repositories.settings.pullRequests.suggestions");
  expect(html).toContain("repositories.settings.pullRequests.approval");
  expect(html.match(/type="checkbox"/g)).toHaveLength(13);
  const output = process.env.GITDOG_PR_QA_DIR;
  if (output) {
    if (!path.isAbsolute(output))
      throw new Error("GITDOG_PR_QA_DIR must be an absolute path");
    const css = readFileSync(process.env.GITDOG_PR_QA_CSS!, "utf8");
    mocks.localize = true;
    try {
      const markup = renderToStaticMarkup(
        createElement(RepositorySettingsPage),
      );
      mkdirSync(output, { recursive: true });
      for (const theme of ["light", "dark"])
        writeFileSync(
          `${output}/${theme}.html`,
          `<!doctype html><html class="${theme === "dark" ? "dark" : ""}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{font-family:Inter,Arial,sans-serif;background:${theme === "dark" ? "#161616" : "#ffffff"};color:${theme === "dark" ? "#fff" : "#111"}}</style></head><body>${markup}</body></html>`,
        );
    } finally {
      mocks.localize = false;
    }
  }
});
