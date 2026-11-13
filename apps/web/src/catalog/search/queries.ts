import { queryOptions } from "@tanstack/react-query";
import { api, read } from "../../api/client";
import type { SearchFilters } from "./model";

export const searchQuery = (
  query: string,
  {
    kind,
    trust,
    workspace,
    dataset,
    category,
    limit,
  }: SearchFilters & { limit?: number } = {},
) =>
  queryOptions({
    queryKey: [
      "catalog",
      "search",
      query,
      kind,
      trust,
      workspace,
      dataset,
      category,
      limit,
    ],
    queryFn: () =>
      read(
        api.GET("/api/v1/search", {
          params: {
            query: {
              query,
              kinds:
                kind ?? "metric,measure,term,category,dataset,table,column",
              trust_states: trust?.join(","),
              workspace,
              dataset,
              category,
              ...(limit === undefined ? {} : { limit: String(limit) }),
            },
          },
        }),
      ),
    enabled: query.length >= 2,
  });
