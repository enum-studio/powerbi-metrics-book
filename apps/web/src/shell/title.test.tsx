// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { expect, it } from "vitest";
import { mount } from "../access/form-test-support";
import { signInConfigQuery } from "../access/api";
import { configWith } from "./brand-test-support";
import { useDocumentTitle } from "./title";

it.each(["Users and roles", undefined])(
  "titles the page %s with the brand",
  async (page) => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity } },
    });
    client.setQueryData(
      signInConfigQuery.queryKey,
      configWith({
        name: "Acme Metrics",
        company: null,
        logo_url: null,
        custom: false,
      }),
    );
    function Page() {
      useDocumentTitle(page);
      return null;
    }
    const mounted = await mount(
      createElement(QueryClientProvider, { client }, createElement(Page)),
    );
    try {
      expect(document.title).toBe(
        page ? "Users and roles · Acme Metrics" : "Acme Metrics",
      );
    } finally {
      mounted.close();
      client.clear();
    }
  },
);
