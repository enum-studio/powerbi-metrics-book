// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { signInConfigQuery } from "./api";
import { AuthLayout } from "./parts";
import { SignIn } from "./sign-in";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

function page(
  setup_pending: boolean,
  refusal: string | null = null,
  email_password = false,
  notice: string | null = null,
  branded = false,
) {
  const client = new QueryClient();
  client.setQueryData(signInConfigQuery.queryKey, {
    providers: [{ id: "microsoft", kind: "microsoft", name: "Microsoft" }],
    passkeys: true,
    dev_sign_in: true,
    sample_data: true,
    demo: false,
    setup_pending,
    email_password,
    brand: {
      name: branded ? "Sample company" : "Power BI Metrics Book",
      company: branded ? "Sample" : null,
      logo_url: branded ? "/api/branding/logo" : null,
      custom: branded,
    },
    invite_only: branded,
  });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(AuthLayout, {
        pageTitle: "Sign in",
        children: createElement(SignIn, {
          next: "/",
          oauthQuery: null,
          refusal,
          notice,
        }),
      }),
    ),
  );
}

it("offers the copyable setup command while hiding all sign-in actions", () => {
  const html = page(true);
  expect(html).toContain("This deployment is not set up yet");
  expect(html).toContain("one-time link");
  expect(html).toContain("docker compose exec api server setup-link</code>");
  expect(html).toContain('aria-label="Copy setup command"');
  for (const label of [
    "Continue with",
    "Sign in with a passkey",
    "Development sign-in",
  ])
    expect(html).not.toContain(label);
});

it("offers sign-in and explains a missing Microsoft email after setup", () => {
  const html = page(false, "email_not_found");
  expect(html).toContain("Continue with Microsoft");
  expect(html).toContain("Microsoft sent no email address");
  expect(html).toContain("Token configuration");
});

it("offers email and password only when the api enables it", () => {
  expect(page(false)).not.toContain('autoComplete="current-password"');
  const html = page(false, null, true);
  expect(html).toContain('autoComplete="current-password"');
  expect(html).toContain("Forgot password");
});

it("keeps the password-set notice inside the sign-in card", () => {
  const html = page(
    false,
    null,
    true,
    "Your password is set. Sign in with it.",
  );
  expect(html).toContain('<p role="status"');
  expect(html.indexOf('role="status"')).toBeGreaterThan(
    html.indexOf("<section"),
  );
  expect(html.indexOf('role="status"')).toBeLessThan(
    html.indexOf("</section>"),
  );
});

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
});
it("shows the brand, sample badge and invite-only footer", () => {
  const html = page(false, "not_assigned", false, null, true);
  expect(html).toContain("Sign in to Sample company");
  expect(html).toContain("Use your Sample Microsoft account.");
  expect(html).toContain('src="/api/branding/logo"');
  expect(html.indexOf("Sample data")).toBeLessThan(html.indexOf("<h1"));
  expect(html).toContain("Only people an admin invites can sign in.");
  expect(html).toContain("Powered by Power BI Metrics Book");
  expect(html).toContain("Ask an admin of Sample company to invite you.");
  expect(html).not.toContain("<header");
});
it("shows the host and remembers the last provider when storage is available", () => {
  expect(page(false)).toContain(
    `Anyone at ${window.location.host} can sign in with Microsoft.`,
  );
  expect(page(false)).not.toContain("Powered by");
  window.localStorage.setItem("pbmb:last-sign-in-provider", "microsoft");
  expect(page(false)).toContain("Last used");
});
it("offers providers even when storage is refused", () => {
  const storage = vi
    .spyOn(Storage.prototype, "getItem")
    .mockImplementation(() => {
      throw new DOMException("Storage disabled", "SecurityError");
    });
  try {
    expect(page(false)).toContain("Continue with Microsoft");
  } finally {
    storage.mockRestore();
  }
});
