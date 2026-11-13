// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { buttons, mountAccess, press, type } from "./access-test-support";
import { InvitePerson } from "./invite-person";

const answered = () =>
  vi
    .spyOn(api, "POST")
    .mockResolvedValue({ data: { invites: [] }, response: new Response() });

it("posts comma-separated emails with the chosen shipped role", async () => {
  const post = answered();
  const view = await mountAccess(InvitePerson, { email_ready: true });
  try {
    const input = view.host.querySelector("input");
    if (!input) throw new Error("Missing email field");
    type(input, "a@x.com, b@x.com");
    act(() => {
      view.host
        .querySelector<HTMLInputElement>('input[value="curator"]')
        ?.click();
    });
    expect(buttons(view.host, "Send invites")).toHaveLength(1);
    await act(async () => {
      view.host
        .querySelector("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      await Promise.resolve();
    });
    expect(post).toHaveBeenCalledWith("/api/v1/admin/people/invites", {
      body: {
        emails: ["a@x.com", "b@x.com"],
        role: "curator",
        delivery: "email",
      },
    });
  } finally {
    view.close();
  }
});

it("offers only an invite link, and says where to set up email, when the api cannot email", async () => {
  const post = answered();
  const view = await mountAccess(InvitePerson, { email_ready: false });
  try {
    expect(buttons(view.host, "Send invites")).toEqual([]);
    expect(buttons(view.host, "Create invite link instead")).toEqual([]);
    expect(view.host.textContent).toContain(
      "Email is not set up, so you send the link yourself. Set up email in Authentication.",
    );
    const input = view.host.querySelector("input");
    if (!input) throw new Error("Missing email field");
    type(input, "a@x.com");
    await press(view.host, "Create invite link");
    expect(post).toHaveBeenCalledWith("/api/v1/admin/people/invites", {
      body: { emails: ["a@x.com"], role: "viewer", delivery: "link" },
    });
  } finally {
    view.close();
  }
});
