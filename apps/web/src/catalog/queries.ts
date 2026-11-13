import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { api, read } from "../api/client";

export async function allPages<T>(
  fetchPage: (
    cursor?: string,
  ) => Promise<{ items: T[]; next_cursor: string | null }>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    cursor = page.next_cursor ?? undefined;
  } while (cursor !== undefined);
  return items;
}

export const categoriesQuery = queryOptions({
  queryKey: ["catalog", "categories"],
  queryFn: () => read(api.GET("/api/v1/categories")),
});
export const bookSummaryQuery = queryOptions({
  queryKey: ["catalog", "summary"],
  queryFn: () => read(api.GET("/api/v1/book/summary")),
});
export type MetricFilter = { category: string } | { not_filed: "true" };
export const metricPagesQuery = (filter: MetricFilter) =>
  infiniteQueryOptions({
    queryKey: ["catalog", "metrics", filter],
    queryFn: ({ pageParam }) =>
      read(
        api.GET("/api/v1/metrics", {
          params: {
            query: {
              limit: "50",
              ...filter,
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
            },
          },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
export const datasetsQuery = queryOptions({
  queryKey: ["catalog", "datasets"],
  queryFn: () =>
    allPages((cursor) =>
      read(
        api.GET("/api/v1/datasets", {
          params: {
            query: { limit: 200, ...(cursor === undefined ? {} : { cursor }) },
          },
        }),
      ),
    ),
});
export const workspacesQuery = queryOptions({
  queryKey: ["catalog", "workspaces"],
  queryFn: () => read(api.GET("/api/v1/workspaces")),
});
export const termQuery = (name: string) =>
  queryOptions({
    queryKey: ["catalog", "term", name],
    queryFn: () =>
      read(api.GET("/api/v1/terms/{name}", { params: { path: { name } } })),
    retry: false,
  });
export const termsQuery = queryOptions({
  queryKey: ["catalog", "terms"],
  queryFn: () =>
    allPages((cursor) =>
      read(
        api.GET("/api/v1/terms", {
          params: {
            query: {
              limit: "200",
              ...(cursor === undefined ? {} : { cursor }),
            },
          },
        }),
      ),
    ),
});

/** One dataset described, with its tables and how many columns and measures each holds; the tree asks for it once the dataset is opened. */
export const datasetQuery = (id: string) =>
  queryOptions({
    queryKey: ["catalog", "dataset", id],
    queryFn: () =>
      read(api.GET("/api/v1/datasets/{id}", { params: { path: { id } } })),
  });

/** The most rows the api gives in one page of a dataset's columns or measures. */
const FIELD_PAGE = 500;

/** One table's measures and columns, asked for once the table is opened, so a dataset of hundreds of measures loads a table at a time. */
export const tableFieldsQuery = (id: string, table: string) =>
  queryOptions({
    queryKey: ["catalog", "dataset", id, "table", table],
    queryFn: async () => {
      const page = (cursor?: string) => ({
        path: { id },
        query: {
          table,
          limit: FIELD_PAGE,
          ...(cursor === undefined ? {} : { cursor }),
        },
      });
      const [measures, columns] = await Promise.all([
        allPages((cursor) =>
          read(
            api.GET("/api/v1/datasets/{id}/measures", {
              params: page(cursor),
            }),
          ),
        ),
        allPages((cursor) =>
          read(
            api.GET("/api/v1/datasets/{id}/columns", {
              params: page(cursor),
            }),
          ),
        ),
      ]);
      return { measures, columns };
    },
  });
