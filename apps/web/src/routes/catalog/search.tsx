import { createRoute, redirect } from "@tanstack/react-router";
import type { SearchKind } from "../../catalog/search/model";
import { catalogRoute } from "./index";

const isKind = (kind: unknown): kind is SearchKind =>
  kind === "metric" || kind === "term" || kind === "dataset";

/** The old search page: Home is the search now, so old links and bookmarks land there with their words and kind. */
export const searchRoute = createRoute({
  getParentRoute: () => catalogRoute,
  path: "/search",
  validateSearch: (
    search: Record<string, unknown>,
  ): { q: string; kind: SearchKind | undefined } => ({
    q: typeof search.q === "string" ? search.q : "",
    kind: isKind(search.kind) ? search.kind : undefined,
  }),
  beforeLoad: ({ search }) => {
    redirect({
      to: "/",
      search: { q: search.q || undefined, kind: search.kind },
      replace: true,
      throw: true,
    });
  },
});
