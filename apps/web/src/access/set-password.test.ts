// @vitest-environment jsdom
import { createElement, StrictMode } from "react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { captureFragmentToken } from "./fragment-token";
import { SetPassword } from "./set-password";
import { fill, mount, navigate, submit } from "./form-test-support";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
beforeEach(() => {
  window.history.replaceState(
    { sample: true },
    "",
    "/set-password?kind=invite#token=sample-link",
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  navigate.mockReset();
});
it.each(["invite", "reset"])(
  "uses the %s endpoint and destination",
  async (kind) => {
    window.history.replaceState(
      window.history.state,
      "",
      `/set-password?kind=${kind}#token=sample-link`,
    );
    const request = vi.fn().mockResolvedValue(Response.json({}));
    vi.stubGlobal("fetch", request);
    captureFragmentToken();
    const page = await mount(
      createElement(StrictMode, null, createElement(SetPassword, { kind })),
    );
    try {
      expect(window.location.hash).toBe("");
      expect(window.location.search).toBe(`?kind=${kind}`);
      expect(window.history.state).toEqual({ sample: true });
      await fill(page.host, "password", "sample password long enough");
      await fill(page.host, "confirm", "sample password long enough");
      await submit(page.host);
      expect(request).toHaveBeenCalledWith(
        kind === "invite"
          ? "/api/auth/invites/accept"
          : "/api/auth/reset-password",
        expect.objectContaining({
          body: JSON.stringify(
            kind === "invite"
              ? {
                  token: "sample-link",
                  password: "sample password long enough",
                }
              : {
                  token: "sample-link",
                  newPassword: "sample password long enough",
                },
          ),
        }),
      );
      await vi.waitFor(() => {
        expect(navigate).toHaveBeenCalledWith({
          href: kind === "invite" ? "/" : "/sign-in?password=set",
        });
      });
    } finally {
      page.close();
    }
  },
);
it.each([undefined, "other"])("refuses an unknown kind: %s", async (kind) => {
  captureFragmentToken();
  const page = await mount(createElement(SetPassword, { kind }));
  try {
    expect(page.host.querySelector("form")).toBeNull();
    expect(
      page.host.querySelector('a[href="/forgot-password"]'),
    ).not.toBeNull();
  } finally {
    page.close();
  }
});
it("shows the api's expired-link sentence and recovery link", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { code: "INVALID_TOKEN", message: "Request a new invitation." },
          { status: 400 },
        ),
      ),
  );
  captureFragmentToken();
  const page = await mount(createElement(SetPassword, { kind: "invite" }));
  try {
    await fill(page.host, "password", "sample password long enough");
    await fill(page.host, "confirm", "sample password long enough");
    await submit(page.host);
    await vi.waitFor(() => {
      expect(page.host.textContent).toContain("Request a new invitation.");
    });
    expect(page.host.querySelector("form")).toBeNull();
    expect(
      page.host.querySelector('a[href="/forgot-password"]'),
    ).not.toBeNull();
  } finally {
    page.close();
  }
});

it("requires matching passwords before sending a request", async () => {
  const request = vi.fn();
  vi.stubGlobal("fetch", request);
  captureFragmentToken();
  const page = await mount(createElement(SetPassword, { kind: "invite" }));
  try {
    expect(
      page.host
        .querySelector('input[name="password"]')
        ?.getAttribute("minlength"),
    ).toBe("12");
    await fill(page.host, "password", "sample password long enough");
    await fill(page.host, "confirm", "a different sample password");
    await submit(page.host);
    expect(request).not.toHaveBeenCalled();
    expect(page.host.textContent).toContain("The passwords do not match.");
  } finally {
    page.close();
  }
});

it.each([
  ["PASSWORD_TOO_SHORT", "Password is too short", true],
  ["INVALID_TOKEN", "Invalid token", false],
  [
    "INVALID_PASSWORD",
    "This invite is invalid or has expired; ask an admin for another.",
    true,
  ],
])(
  "handles %s without hiding a correctable password",
  async (code, message, editable) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(Response.json({ code, message }, { status: 400 })),
    );
    captureFragmentToken();
    const page = await mount(createElement(SetPassword, { kind: "reset" }));
    try {
      await fill(page.host, "password", "sample password long enough");
      await fill(page.host, "confirm", "sample password long enough");
      await submit(page.host);
      await vi.waitFor(() => {
        expect(page.host.textContent).toContain(message);
      });
      expect(page.host.querySelector("form") !== null).toBe(editable);
    } finally {
      page.close();
    }
  },
);
