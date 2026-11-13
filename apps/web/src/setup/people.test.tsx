// @vitest-environment jsdom
import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { invitePeople, invitesQuery } from "../admin/access/api";
import { putSetting, settingQuery } from "../admin/settings/api";
import { click, mount, PUBLIC_BASE_URL } from "./screen-test-support";

vi.mock("../admin/settings/api", async (original) => ({
  ...(await original<typeof import("../admin/settings/api")>()),
  putSetting: vi.fn(),
}));
vi.mock("../admin/access/api", async (original) => ({
  ...(await original<typeof import("../admin/access/api")>()),
  invitePeople: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(putSetting).mockReset();
  vi.mocked(invitePeople).mockReset();
});

const changeTo = (
  field: HTMLInputElement | HTMLSelectElement,
  value: string,
) => {
  const proto =
    field instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, value);
  field.dispatchEvent(
    new Event(field instanceof HTMLSelectElement ? "change" : "input", {
      bubbles: true,
    }),
  );
};

it("leads with only people I invite, then everyone as Viewer, then as Curator", async () => {
  const view = await mount("people");
  try {
    const options = [...view.host.querySelectorAll("select")][0]?.options;
    expect(
      [...(options ?? [])].map((option) => [option.value, option.text]),
    ).toEqual([
      ["none", "Only people I invite"],
      ["viewer", "Everyone at the company as Viewer"],
      ["curator", "Everyone at the company as Curator"],
    ]);
  } finally {
    view.close();
  }
});

it("saves the role everyone signs in as only when a person presses Continue", async () => {
  const view = await mount("people");
  try {
    const select = view.host.querySelector("select");
    if (select === null) throw new Error("Missing the default role");
    expect(select.value).toBe("none");
    await act(async () => {
      changeTo(select, "viewer");
      await Promise.resolve();
    });
    expect(putSetting).not.toHaveBeenCalled();
    expect(view.host.textContent).toContain(
      "Not saved yet. Continue saves it.",
    );
    await click(view.host, "Continue: connect your agent");
    expect(vi.mocked(putSetting).mock.calls).toEqual([
      ["access.default_role", "viewer", false],
    ]);
    await vi.waitFor(() => {
      expect(view.router.state.location.search.step).toBe("agent");
    });
  } finally {
    view.close();
  }
});

it("saves nothing when the role did not change, and goes on", async () => {
  const view = await mount("people");
  try {
    await click(view.host, "Continue: connect your agent");
    expect(putSetting).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(view.router.state.location.search.step).toBe("agent");
    });
  } finally {
    view.close();
  }
});

it("shows a role saved elsewhere since the page opened, and writes nothing back over it", async () => {
  const view = await mount("people");
  try {
    act(() => {
      view.client.setQueryData(
        settingQuery("access.default_role").queryKey,
        (before) => before && { ...before, value: "curator" },
      );
    });
    await vi.waitFor(() => {
      expect(view.host.querySelector("select")?.value).toBe("curator");
    });
    await click(view.host, "Continue: connect your agent");
    expect(putSetting).not.toHaveBeenCalled();
  } finally {
    view.close();
  }
});

it("stays and says why when the role cannot be saved", async () => {
  vi.mocked(putSetting).mockRejectedValue(new Error("The api refused it."));
  const view = await mount("people");
  try {
    const select = view.host.querySelector("select");
    if (select === null) throw new Error("Missing the default role");
    await act(async () => {
      changeTo(select, "viewer");
      await Promise.resolve();
    });
    await click(view.host, "Continue: connect your agent");
    await vi.waitFor(() => {
      expect(view.host.textContent).toContain("The api refused it.");
    });
    expect(view.router.state.location.search.step).toBe("people");
  } finally {
    view.close();
  }
});

it("invites a named person by email, and the message names the checked address", async () => {
  vi.mocked(invitePeople).mockResolvedValue({ invites: [] });
  const view = await mount("people");
  try {
    expect(view.host.textContent).toContain(
      `work account at ${PUBLIC_BASE_URL}.`,
    );
    expect(view.host.textContent).not.toContain(window.location.origin);
    act(() => {
      view.client.setQueryData(invitesQuery.queryKey, {
        invites: [],
        email_ready: true,
      });
    });
    const form = view.host.querySelector("form");
    const email = form?.querySelector("input");
    const role = form?.querySelector("select");
    if (!form || !email || !role) throw new Error("Missing the role form");
    await act(async () => {
      changeTo(email, "curator@sample.example");
      changeTo(role, "admin");
      await Promise.resolve();
    });
    await act(async () => {
      form.requestSubmit();
      await Promise.resolve();
    });
    expect(vi.mocked(invitePeople).mock.calls[0]?.[0]).toEqual({
      role: "admin",
      emails: ["curator@sample.example"],
      delivery: "email",
    });
  } finally {
    view.close();
  }
});

it("offers Viewer first and invites a viewer during setup", async () => {
  vi.mocked(invitePeople).mockResolvedValue({ invites: [] });
  const view = await mount("people");
  try {
    act(() => {
      view.client.setQueryData(invitesQuery.queryKey, {
        invites: [],
        email_ready: true,
      });
    });
    const form = view.host.querySelector("form");
    const email = form?.querySelector("input");
    const role = form?.querySelector("select");
    if (!form || !email || !role) throw new Error("Missing the invite form");
    expect([...role.options].map((option) => option.text)).toEqual([
      "Viewer",
      "Curator",
      "Admin",
    ]);
    act(() => {
      changeTo(email, "viewer@sample.example");
      changeTo(role, "viewer");
    });
    await act(async () => {
      form.requestSubmit();
      await Promise.resolve();
    });
    expect(invitePeople).toHaveBeenCalledWith({
      emails: ["viewer@sample.example"],
      role: "viewer",
      delivery: "email",
    });
  } finally {
    view.close();
  }
});
