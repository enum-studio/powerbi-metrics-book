// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { buttons, mountAccess, press } from "./access-test-support";
import { type Invite, resendInvite, revokeInvite } from "./api";
import { PendingInvites } from "./pending-invites";

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  resendInvite: vi.fn(),
  revokeInvite: vi.fn(),
}));
const writeText = vi.fn<(text: string) => Promise<void>>();
beforeEach(() => {
  vi.mocked(resendInvite).mockReset();
  vi.mocked(revokeInvite).mockReset();
  writeText.mockReset().mockResolvedValue();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

const BY_EMAIL: Invite = {
  id: "44444444-4444-4444-8444-444444444444",
  email: "ada@sample.example",
  role: "curator",
  delivery: "email",
  inviter_name: "Sample Admin",
  last_sent_at: "2030-03-04T12:00:00Z",
  expires_at: "2030-03-11T12:00:00Z",
  expired: false,
};
const BY_LINK: Invite = {
  ...BY_EMAIL,
  id: "55555555-5555-4555-8555-555555555555",
  email: "grace@sample.example",
  role: "auditor",
  delivery: "link",
  expired: true,
};
const NEW_LINK = "https://pbmb.sample.example/invite#token=new";

it("shows each role as people read it, and an expired invite as Expired", async () => {
  const view = await mountAccess(PendingInvites, {
    invites: [BY_EMAIL, BY_LINK],
  });
  try {
    const [first, second] = view.host.querySelectorAll("tbody tr");
    const cell = (row: Element | undefined, label: string) =>
      row?.querySelector(`[data-label="${label}"]`)?.textContent;
    expect(cell(first, "Role")).toBe("Curator");
    expect(cell(second, "Role")).toBe("auditor");
    expect(cell(first, "Expires")).not.toBe("Expired");
    expect(cell(second, "Expires")).toBe("Expired");
  } finally {
    view.close();
  }
});

it("resends an email invite, and makes and copies a link invite's new link only on a second click", async () => {
  vi.mocked(resendInvite).mockImplementation((id) =>
    Promise.resolve({
      expires_at: "2030-03-18T12:00:00Z",
      link: id === BY_LINK.id ? NEW_LINK : null,
    }),
  );
  vi.mocked(revokeInvite).mockResolvedValue();
  const view = await mountAccess(PendingInvites, {
    invites: [BY_EMAIL, BY_LINK],
  });
  try {
    expect(buttons(view.host, "Resend")).toHaveLength(1);
    expect(buttons(view.host, "New link")).toHaveLength(1);
    await press(view.host, "Resend");
    expect(resendInvite).toHaveBeenLastCalledWith(BY_EMAIL.id);

    await press(view.host, "New link");
    expect(view.host.textContent).toContain(
      "The link you already shared stops working.",
    );
    expect(resendInvite).toHaveBeenCalledTimes(1);
    await press(view.host, "Cancel");
    expect(view.host.textContent).not.toContain("stops working");
    expect(resendInvite).toHaveBeenCalledTimes(1);

    await press(view.host, "New link");
    await press(view.host, "Copy new link");
    expect(resendInvite).toHaveBeenLastCalledWith(BY_LINK.id);
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(NEW_LINK);
    });
    expect(view.host.textContent).toContain(NEW_LINK);
    expect(view.host.textContent).not.toContain("stops working");

    await press(view.host, "Revoke", 1);
    expect(revokeInvite).toHaveBeenCalledWith(BY_LINK.id);
  } finally {
    view.close();
  }
});
