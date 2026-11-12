import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = {
  useQuery: vi.fn(),
};
const teamSectionSource = readFileSync(
  new URL("../../src/components/TeamSection.tsx", import.meta.url),
  "utf8",
);

vi.mock("convex/react", () => ({
  useQuery: mocks.useQuery,
  useMutation: () => vi.fn(),
}));

vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../src/components/InviteMemberModal", () => ({
  InviteMemberModal: () => null,
}));

vi.mock("../../src/components/uis/Modal", () => ({
  Modal: () => null,
}));

let TeamSection: typeof import("../../src/components/TeamSection").TeamSection;

beforeAll(async () => {
  ({ TeamSection } = await import("../../src/components/TeamSection"));
});

beforeEach(() => {
  mocks.useQuery.mockReset();
  mocks.useQuery
    .mockReturnValueOnce([])
    .mockReturnValueOnce([])
    .mockReturnValue({
      plan: "pro",
      status: "active",
      periodEnd: Date.now() + 60_000,
    });
});

describe("team invitation availability", () => {
  it("disables and explains invitations while reconnect is required", () => {
    const html = renderToStaticMarkup(
      createElement(TeamSection, {
        repositoryId: "repository-id" as never,
        isOwner: true,
        invitationUnavailableReason: "reconnect",
      }),
    );

    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-describedby="team-invitation-unavailable"');
    expect(html).toContain("team.inviteUnavailable.reconnect");
  });

  it("keeps invitations enabled during a manual automation pause", () => {
    const html = renderToStaticMarkup(
      createElement(TeamSection, {
        repositoryId: "repository-id" as never,
        isOwner: true,
      }),
    );

    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain("team.inviteUnavailable.");
  });

  it("disables and explains invitations during installation reconciliation", () => {
    const html = renderToStaticMarkup(
      createElement(TeamSection, {
        repositoryId: "repository-id" as never,
        isOwner: true,
        invitationUnavailableReason: "syncing",
      }),
    );

    expect(html).toContain('disabled=""');
    expect(html).toContain("team.inviteUnavailable.syncing");
  });

  it("uses the server-resolved plan without importing server access control", () => {
    expect(teamSectionSource).toContain(
      'const isPro = subscription?.plan === "pro";',
    );
    expect(teamSectionSource).not.toContain("convex/_utils/accessControl");
  });

  it("renders without a Node process global", () => {
    const processDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "process",
    );
    let renderError: unknown;
    let html = "";

    Object.defineProperty(globalThis, "process", {
      configurable: true,
      value: undefined,
    });
    try {
      html = renderToStaticMarkup(
        createElement(TeamSection, {
          repositoryId: "repository-id" as never,
          isOwner: true,
        }),
      );
    } catch (error) {
      renderError = error;
    } finally {
      if (processDescriptor) {
        Object.defineProperty(globalThis, "process", processDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "process");
      }
    }

    expect(renderError).toBeUndefined();
    expect(html).toContain("team.inviteMember");
  });
});
