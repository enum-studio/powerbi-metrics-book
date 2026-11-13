import { Hono } from "hono";
import { validator } from "hono-openapi";
import { z } from "zod";
import type { AppEnv } from "../../app.js";
import type { AppDeps } from "../../context.js";
import { TRUST_STATES } from "../../db/schema/book.js";
import { PRINCIPAL_KINDS } from "../../db/schema/queries.js";
import { SEARCH_KINDS } from "../../db/schema/search.js";
import { THREAD_ELEMENT_KINDS } from "../../db/schema/threads.js";
import { GAP_KINDS, REQUEST_OUTCOMES } from "../../db/schema/usage.js";
import { usageReport } from "../../services/usage/report.js";
import {
  anchor,
  credential,
  documented,
  iso,
  refuse,
  serviceContext,
  text,
} from "./adapter.js";

const count = { count: z.number(), people: z.number(), last_at: iso };
const dataset = anchor("dataset");
const Report = z
  .object({
    since: iso,
    until: iso,
    totals: z.object({
      searches: z.number(),
      searches_with_no_hits: z.number(),
      requests: z.number(),
      requests_by_outcome: z.record(z.enum(REQUEST_OUTCOMES), z.number()),
      queries: z.number(),
      queries_without_metric: z.number(),
    }),
    not_covered: z.object({
      searches_with_no_hits: z.array(z.object({ ...count, query: z.string() })),
      searches_without_metric: z.array(
        z.object({
          ...count,
          query: z.string(),
          top_kinds: z.array(z.enum(SEARCH_KINDS)),
        }),
      ),
      unanswered_requests: z.array(
        z.object({
          id: z.string(),
          at: iso,
          principal: z.object({
            kind: z.enum(PRINCIPAL_KINDS),
            id: z.string(),
          }),
          question: z.string(),
          outcome: z.enum(REQUEST_OUTCOMES),
          gaps: z.array(z.enum(GAP_KINDS)),
          missing: z.string().nullable(),
        }),
      ),
      queries_without_metric: z.array(
        z.object({
          ...count,
          dataset,
          dax_hash: z.string(),
          latest_query_id: z.string(),
          latest_purpose: z.string().nullable(),
        }),
      ),
    }),
    badly_structured: z.object({
      measures_without_metric: z.array(
        z.object({ ...count, dataset, measure: z.string() }),
      ),
      measures_without_description: z.array(
        z.object({
          ...count,
          dataset,
          measure: z.string(),
          has_book_description: z.boolean(),
        }),
      ),
      flagged_elements: z.array(
        z.object({
          element: z.object({
            kind: z.enum(THREAD_ELEMENT_KINDS),
            id: z.string(),
            name: z.string(),
          }),
          gaps: z.partialRecord(z.enum(GAP_KINDS), z.number()),
          requests: z.number(),
        }),
      ),
      used_unverified_metrics: z.array(
        z.object({
          ...count,
          metric: z.object({
            key: z.string(),
            label: z.string(),
            trust_state: z.enum(TRUST_STATES),
          }),
        }),
      ),
      failed_queries: z.array(
        z.object({
          dataset,
          failed: z.number(),
          refused: z.number(),
          last_at: iso,
        }),
      ),
    }),
    hidden: z.number(),
    truncated_lists: z.array(z.string()),
  })
  .meta({ id: "UsageReport" });

const stamp = z.iso
  .datetime({ offset: true })
  .max(40)
  .transform((value) => new Date(value));

export function usageRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const report = documented(
    "Report gaps in coverage and structure, for curators and admins",
    Report,
    { errors: [400, 404] },
  );
  routes.get(
    "/usage/report",
    report.doc,
    credential,
    validator(
      "query",
      z.strictObject({
        since: stamp,
        until: stamp.optional(),
        dataset: text.optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
      refuse,
    ),
    async (c) =>
      report.answer(
        c,
        await usageReport(serviceContext(deps)(c), c.req.valid("query")),
      ),
  );
  return routes;
}
