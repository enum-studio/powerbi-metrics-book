// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, StrictMode, type ReactElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { createAppRouter } from "../router";
import { formatDate } from "../shell/time";
import { signInConfigQuery, type SignInConfig } from "./api";
import { mount } from "./form-test-support";
import { captureFragmentToken } from "./fragment-token";
import { Invite } from "./invite";
import { AuthLayout } from "./parts";
import { SetPassword } from "./set-password";

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));

const CONFIG: SignInConfig = {
  providers: [{ id: "microsoft", name: "Microsoft", kind: "microsoft" }],
  passkeys: false,
  email_password: true,
  dev_sign_in: false,
  sample_data: true,
  demo: false,
  setup_pending: false,
  brand: {
    name: "Sample company",
    company: "Sample",
    logo_url: null,
    custom: true,
  },
  invite_only: true,
};

/** The page as the root route draws it: inside the auth column, with the config answered or still on its way. */
function inLayout(page: ReactElement, config: SignInConfig | null) {
  captureFragmentToken();
  const client = new QueryClient();
  if (config === null)
    void client.query({
      queryKey: signInConfigQuery.queryKey,
      queryFn: () => new Promise<never>(() => undefined),
    });
  else client.setQueryData(signInConfigQuery.queryKey, config);
  return createElement(
    QueryClientProvider,
    { client },
    createElement(
      StrictMode,
      null,
      createElement(AuthLayout, { pageTitle: "Sign in", children: page }),
    ),
  );
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
});
afterEach(() => vi.unstubAllGlobals());

it.each([
  ["/invite", createElement(Invite)],
  ["/set-password?kind=invite", createElement(SetPassword, { kind: "invite" })],
])(
  "takes the token out of %s without a new history entry or a lost state",
  async (path, page) => {
    window.history.replaceState({ sample: true }, "", `${path}#token=sample`);
    const entries = window.history.length;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => undefined)),
    );
    const mounted = await mount(inLayout(page, null));
    try {
      expect(window.location.hash).toBe("");
      expect(window.location.href).not.toContain("sample");
      expect(window.history.length).toBe(entries);
      expect(window.history.state).toEqual({ sample: true });
    } finally {
      mounted.close();
    }
  },
);

it("explains an expired invite without offering providers", async () => {
  const DateTimeFormat = Intl.DateTimeFormat;
  const formatter = vi
    .spyOn(Intl, "DateTimeFormat")
    .mockImplementation(function (locale, options) {
      return new DateTimeFormat(locale ?? "en-GB", {
        ...options,
        timeZone: options?.timeZone ?? "America/Los_Angeles",
      });
    });
  window.history.replaceState({}, "", "/invite#token=sample-invite");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        state: "expired",
        inviter_name: "Sample admin",
        expires_at: "2026-11-01T00:30:00Z",
      }),
    ),
  );
  const page = await mount(inLayout(createElement(Invite), CONFIG));
  try {
    await vi.waitFor(() => {
      expect(page.host.textContent).toContain(
        "This invite expired on 31 Oct 2026. Ask Sample admin to send a new one.",
      );
    });
    expect(page.host.textContent).not.toContain("Continue with");
    expect(page.host.querySelector('a[href="/sign-in"]')).not.toBeNull();
  } finally {
    page.close();
    formatter.mockRestore();
  }
});

it.each(["invalid", "missing"])(
  "refuses a %s token without providers",
  async (state) => {
    window.history.replaceState(
      {},
      "",
      state === "missing" ? "/invite" : "/invite#token=sample",
    );
    const request = vi
      .fn()
      .mockResolvedValue(Response.json({ state: "invalid" }));
    vi.stubGlobal("fetch", request);
    const page = await mount(inLayout(createElement(Invite), CONFIG));
    try {
      await vi.waitFor(() => {
        expect(page.host.textContent).toContain(
          "This invite is no longer valid. Sign in, or ask an admin for a new one.",
        );
      });
      expect(page.host.textContent).not.toContain("Continue with");
      expect(page.host.querySelector('a[href="/sign-in"]')).not.toBeNull();
      if (state === "missing") expect(request).not.toHaveBeenCalled();
      else
        expect(request).toHaveBeenCalledWith(
          "/api/auth/invites/lookup",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({ token: "sample" }),
          }),
        );
    } finally {
      page.close();
    }
  },
);

it.each([true, false])(
  "shows the invited identity, and Set a password only when allowed: %s",
  async (password_allowed) => {
    window.history.replaceState({}, "", "/invite#token=sample");
    const request = vi.fn().mockResolvedValue(
      Response.json({
        state: "open",
        email: "reader@sample.example",
        role: "curator",
        inviter_name: "Sample admin",
        expires_at: "2026-11-15T12:00:00Z",
        password_allowed,
      }),
    );
    vi.stubGlobal("fetch", request);
    const page = await mount(inLayout(createElement(Invite), CONFIG));
    try {
      await vi.waitFor(() => {
        expect(page.host.textContent).toContain("Continue with Microsoft");
      });
      expect(page.host.textContent).toContain(
        "Sample admin invited you to Sample company",
      );
      expect(page.host.textContent).toContain("You will join as a Curator.");
      expect(page.host.textContent).toContain(
        "Sign in as reader@sample.example.",
      );
      expect(page.host.textContent).toContain(
        `This invite expires on ${formatDate("2026-11-15T12:00:00Z")}.`,
      );
      expect(page.host.textContent.includes("Set a password")).toBe(
        password_allowed,
      );
      const storage = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(() => {
          throw new DOMException("Storage disabled", "SecurityError");
        });
      request.mockResolvedValue(
        Response.json(
          {
            code: "deactivated",
            message:
              "An admin has deactivated your account. Ask an admin to reactivate it.",
          },
          { status: 403 },
        ),
      );
      try {
        act(() => {
          [...page.host.querySelectorAll("button")]
            .find((button) => button.textContent.includes("Microsoft"))
            ?.click();
        });
        await vi.waitFor(() => {
          expect(page.host.textContent).toContain(
            "An admin has deactivated your account.",
          );
        });
        expect(request).toHaveBeenCalledWith(
          "/api/auth/sign-in/social",
          expect.objectContaining({ method: "POST" }),
        );
      } finally {
        storage.mockRestore();
      }
    } finally {
      page.close();
    }
  },
);

it("removes the invite fragment before /me refuses access", async () => {
  window.history.replaceState({ sample: true }, "", "/invite#token=abc");
  const entries = window.history.length;
  const replace = vi.spyOn(window.history, "replaceState");
  const request = vi.spyOn(api, "GET").mockResolvedValue({
    error: { error: "forbidden", message: "Access refused." },
    response: new Response(null, { status: 403 }),
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createAppRouter(client);
  await router.load();
  try {
    expect(request).toHaveBeenCalledWith("/api/v1/me");
    expect(router.state.matches[0]?.error).toEqual(
      expect.objectContaining({ status: 403 }),
    );
    expect(router.state.matches[0]?.status).toBe("error");
    expect(window.location.pathname).toBe("/invite");
    expect(window.location.hash).toBe("");
    expect(window.history.length).toBe(entries);
    expect(replace).toHaveBeenNthCalledWith(1, { sample: true }, "", "/invite");
  } finally {
    replace.mockRestore();
    request.mockRestore();
    client.clear();
  }
});

it("keeps a custom role label as written", async () => {
  window.history.replaceState({}, "", "/invite#token=sample");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        state: "open",
        email: "reader@sample.example",
        role: "data_reviewer",
        inviter_name: "Sample admin",
        expires_at: "2026-11-15T12:00:00Z",
        password_allowed: false,
      }),
    ),
  );
  const page = await mount(inLayout(createElement(Invite), CONFIG));
  try {
    await vi.waitFor(() => {
      expect(page.host.textContent).toContain(
        "You will join as a data_reviewer.",
      );
    });
  } finally {
    page.close();
  }
});
