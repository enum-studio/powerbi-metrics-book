// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { connectionQuery, signInConfigQuery } from "./api";
import { Connections, Sessions } from "./connections";
import { mount } from "./form-test-support";

afterEach(() => vi.unstubAllGlobals());

it("lets a connected person connect another account through the existing connect round trip", () => {
  const client = new QueryClient();
  client.setQueryData(signInConfigQuery.queryKey, {
    providers: [],
    passkeys: false,
    dev_sign_in: false,
    sample_data: true,
    demo: false,
    setup_pending: false,
    email_password: false,
    brand: {
      name: "Power BI Metrics Book",
      company: null,
      logo_url: null,
      custom: false,
    },
    invite_only: false,
  });
  client.setQueryData(connectionQuery.queryKey, {
    status: "connected",
    account: "admin@sample.example",
    connected_at: null,
    last_used_at: null,
    reason: null,
  });
  const html = renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(Connections)),
  );
  expect(html).toContain("Disconnect");
  expect(html).toContain(
    'href="/api/v1/powerbi/connect?next=%2Fsettings%2Fconnections"',
  );
  expect(html).toContain("Connect another account");
  expect(html).toContain(">Sessions</button>");
  expect(html).toContain("Queries run as the account connected last.");
});

async function press(host: HTMLElement, text: string) {
  const button = [...host.querySelectorAll("button")].find(
    (each) => each.textContent === text,
  );
  if (!button) throw new Error(`Missing button: ${text}`);
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

it("signs the person out of their other sessions through Better Auth and says what stays", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ status: true }));
  vi.stubGlobal("fetch", fetch);
  const view = await mount(createElement(Sessions));
  try {
    await press(view.host, "Sign out of all other sessions");
    expect(fetch).toHaveBeenCalledWith(
      "/api/auth/revoke-other-sessions",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
    expect(view.host.textContent).toContain(
      "Signed out of every other session. You are still signed in here.",
    );
  } finally {
    view.close();
  }
});

it("shows the refusal in the api's words", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { code: "UNAUTHORIZED", message: "Sign in first." },
          { status: 401 },
        ),
      ),
  );
  const view = await mount(createElement(Sessions));
  try {
    await press(view.host, "Sign out of all other sessions");
    expect(view.host.textContent).toContain("Sign in first.");
  } finally {
    view.close();
  }
});
