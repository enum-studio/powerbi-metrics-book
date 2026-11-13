import { queryOptions } from "@tanstack/react-query";
import { api, read } from "../api/client";
import type { components } from "../api/schema";

export type Metric = components["schemas"]["Metric"];
type Variant = components["schemas"]["Variant"];
/** What the variant list gives of each variant; its DAX is a call of its own. */
export type VariantAnchor = Pick<
  Variant,
  "id" | "dataset" | "workspace" | "measure" | "measure_reference" | "shift"
>;

/** Each answer is a fact about this metric now, so a failed call is not retried: a 404 shows at once. */
const ONCE = { retry: false } as const;

export const metricQuery = (name: string) =>
  queryOptions({
    queryKey: ["metric", name],
    queryFn: () =>
      read(api.GET("/api/v1/metrics/{name}", { params: { path: { name } } })),
    ...ONCE,
  });

export const variantsQuery = (name: string) =>
  queryOptions({
    queryKey: ["metric", name, "variants"],
    queryFn: async () =>
      (
        await read(
          api.GET("/api/v1/metrics/{name}/variants", {
            params: { path: { name }, query: { limit: 500 } },
          }),
        )
      ).items,
    ...ONCE,
  });

/** One variant in full. Its DAX is null for a person Power BI does not let read it. */
export const variantQuery = (id: string) =>
  queryOptions({
    queryKey: ["variant", id],
    queryFn: () =>
      read(api.GET("/api/v1/variants/{id}", { params: { path: { id } } })),
    ...ONCE,
  });

export const checksQuery = (name: string) =>
  queryOptions({
    queryKey: ["metric", name, "checks"],
    queryFn: async () =>
      (
        await read(
          api.GET("/api/v1/metrics/{name}/checks", {
            params: { path: { name } },
          }),
        )
      ).checks,
    ...ONCE,
  });

export const historyQuery = (name: string) =>
  queryOptions({
    queryKey: ["metric", name, "history"],
    queryFn: () =>
      read(
        api.GET("/api/v1/metrics/{name}/history", {
          params: { path: { name } },
        }),
      ),
    ...ONCE,
  });

export const questionsQuery = (metricId: string) =>
  queryOptions({
    queryKey: ["metric-questions", metricId],
    queryFn: async () =>
      (
        await read(
          api.GET("/api/v1/threads", {
            params: {
              query: {
                kind: "question",
                element_kind: "metric",
                element_id: metricId,
                status: "open",
                limit: 100,
              },
            },
          }),
        )
      ).items,
    ...ONCE,
  });

export const approve = (name: string) =>
  read(
    api.POST("/api/v1/metrics/{name}/approve", { params: { path: { name } } }),
  );
