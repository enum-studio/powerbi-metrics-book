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
