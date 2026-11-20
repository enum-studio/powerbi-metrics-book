import { queryOptions } from "@tanstack/react-query";
import { api, read } from "../../api/client";

export const columnQuery = (id: string, columnId: string | undefined) =>
  queryOptions({
    queryKey: ["catalog", "dataset", id, "column", columnId],
    enabled: columnId !== undefined,
    retry: false,
    queryFn: () => {
      if (columnId === undefined) throw new Error("A column id is required.");
      return read(
        api.GET("/api/v1/datasets/{id}/columns/{column_id}", {
          params: { path: { id, column_id: columnId } },
        }),
      );
    },
  });

/** What the book holds about a dataset, table or column: its descriptions and custom fields. */
export const elementDocsQuery = (
  kind: "dataset" | "table" | "column",
  id: string,
) =>
  queryOptions({
    queryKey: ["catalog", "docs", kind, id],
    retry: false,
    queryFn: () =>
      read(
        api.GET("/api/v1/elements/{kind}/{id}/docs", {
          params: { path: { kind, id } },
        }),
      ),
  });

/** How many of a table's columns the reader may not see, which the api counts on any page of them. */
export const piiHiddenQuery = (id: string, table: string) =>
  queryOptions({
    queryKey: ["catalog", "pii-hidden", id, table],
    queryFn: async () =>
      (
        await read(
          api.GET("/api/v1/datasets/{id}/columns", {
            params: { path: { id }, query: { table, limit: 1 } },
          }),
        )
      ).pii_hidden ?? 0,
    retry: false,
  });
