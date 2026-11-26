import { queryOptions } from "@tanstack/react-query";
import { api, read } from "../../api/client";
export const guideQuery = queryOptions({
  queryKey: ["guide"],
  queryFn: () => read(api.GET("/api/v1/guide")),
});
export const exportsQuery = queryOptions({
  queryKey: ["book-exports"],
  queryFn: () => read(api.GET("/api/v1/book/exports")),
});
