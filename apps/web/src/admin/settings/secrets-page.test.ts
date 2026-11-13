import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode, Suspense } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import { AdminError } from "../layout/admin-layout";
import { Loading } from "../../shell/states";
import { type Secret, secretsQuery } from "./api";
import { SecretsPage } from "./secrets-page";

afterEach(() => {
  vi.restoreAllMocks();
});

const SET: Secret = {
  name: "powerbi_app_client_secret",
  readers: ["api"],
  set: true,
  needs_reentry_for: [],
  hint: "cret",
  set_by: "admin@sample.example",
  set_at: "2026-10-26T10:00:00Z",
  expires_at: null,
  checked_at: null,
  check_status: null,
  check_message: null,
};

function page(
  client: QueryClient,
  node: ReactNode = createElement(SecretsPage),
) {
  return renderToString(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        Suspense,
        { fallback: createElement(Loading, { what: "the page" }) },
        node,
      ),
    ),
  );
}

describe("the Secrets page", () => {
  it("says it is loading while the api has not answered", () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise(() => undefined));
    const html = page(new QueryClient()).replaceAll("<!-- -->", "");
    expect(html).toContain("Loading the page");
    expect(html).not.toContain("Secrets</h1>");
  });

  it("says no secrets are set when the list is empty", () => {
    const client = new QueryClient();
    client.setQueryData(secretsQuery.queryKey, []);
    expect(page(client)).toContain("No secrets yet");
  });

  it("shows each secret by its last four characters and the name of who set it", () => {
    const client = new QueryClient();
    client.setQueryData(secretsQuery.queryKey, [SET]);
    const html = page(client);
    expect(html).toContain("powerbi_app_client_secret");
    expect(html).toContain("cret");
    expect(html).toContain("admin@sample.example");
    expect(html).toContain("Replace");
  });
});

describe("a page's failure", () => {
  it("says the section is for admins when the api refuses", () => {
    const html = renderToString(
      createElement(AdminError, {
        error: new ApiError(403, "refused", "Your role does not allow it."),
      }),
    );
    expect(html).toContain("The admin section is for admins");
    expect(html).not.toContain("Your role does not allow it.");
  });

  it("says what went wrong, in the api's own sentence, for any other failure", () => {
    const html = renderToString(
      createElement(AdminError, {
        error: new ApiError(502, "upstream", "Power BI did not answer."),
      }),
    );
    expect(html).toContain("Something went wrong");
    expect(html).toContain("Power BI did not answer.");
  });
});
