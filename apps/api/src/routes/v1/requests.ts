import { Hono } from "hono";
import { validator } from "hono-openapi";
import { z } from "zod";
import type { AppEnv } from "../../app.js";
import type { AppDeps } from "../../context.js";
import { VIAS } from "../../db/schema/book.js";
import { PRINCIPAL_KINDS, QUERY_STATUSES } from "../../db/schema/queries.js";
import { THREAD_ELEMENT_KINDS } from "../../db/schema/threads.js";
import { GAP_KINDS, REQUEST_OUTCOMES } from "../../db/schema/usage.js";
import {
  deleteRequest,
  getRequest,
  listRequests,
  recordRequest,
} from "../../services/usage/requests.js";
import {
  credential,
  documented,
  guid,
  iso,
  refuse,
  removed,
  serviceContext,
  text,
} from "./adapter.js";

const id = z.object({ id: guid });
const Element = z.object({ kind: z.enum(THREAD_ELEMENT_KINDS), id: text });
const NewRequest = z.strictObject({
  question: z.string().min(1).max(2000),
  outcome: z.enum(REQUEST_OUTCOMES),
  gaps: z.array(z.enum(GAP_KINDS)).max(GAP_KINDS.length).optional(),
  missing: z.string().max(2000).optional(),
  elements: z.array(Element.strict()).max(20).optional(),
  query_ids: z.array(text).max(20).optional(),
  search_ids: z.array(text).max(20).optional(),
});
const RequestFilters = z.strictObject({
  mine: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  outcome: z.enum(REQUEST_OUTCOMES).optional(),
  gap: z.enum(GAP_KINDS).optional(),
  since: z.iso
    .datetime({ offset: true })
    .max(40)
    .transform((value) => new Date(value))
    .optional(),
  text: text.optional(),
  cursor: text.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const Recorded = z
  .union([
    z.object({ recorded: z.literal(true), id: z.string(), kept_until: iso }),
    z.object({ recorded: z.literal(false), note: z.string() }),
  ])
  .meta({ id: "RecordedRequest" });
const fields = {
  id: z.string(),
  at: iso,
  principal: z.object({ kind: z.enum(PRINCIPAL_KINDS), id: z.string() }),
  via: z.enum(VIAS),
  question: z.string(),
  outcome: z.enum(REQUEST_OUTCOMES),
  gaps: z.array(z.enum(GAP_KINDS)),
  missing: z.string().nullable(),
  elements: z.array(Element),
  query_ids: z.array(z.string()),
  search_ids: z.array(z.string()),
};
const Request = z.object(fields).meta({ id: "Request" });
const RequestDetail = z
  .object({
    ...fields,
    queries: z.array(
      z.object({
        id: z.string(),
        dataset: z
          .object({
            kind: z.literal("dataset"),
            id: z.string(),
            name: z.string().nullable(),
          })
          .nullable(),
        status: z.enum(QUERY_STATUSES),
        metric_ids: z.array(z.string()),
      }),
    ),
    searches: z.array(
      z.object({ id: z.string(), query: z.string(), hit_count: z.number() }),
    ),
  })
  .meta({ id: "RequestDetail" });

/** Requests an agent records for a person's question, read back by their principal and curators. */
export function requestsRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const as = serviceContext(deps);

  const record = documented(
    "Record a question a person asked, its outcome and what was missing",
    Recorded,
    { status: 201, errors: [400, 429] },
  );
  routes.post(
    "/requests",
    record.doc,
    credential,
    validator("json", NewRequest, refuse),
    async (c) =>
      record.answer(c, await recordRequest(as(c), c.req.valid("json"))),
  );

  const list = documented(
    "List the requests the caller may read, newest first",
    z.object({ items: z.array(Request), next_cursor: z.string().nullable() }),
    { errors: [400] },
  );
  routes.get(
    "/requests",
    list.doc,
    credential,
    validator("query", RequestFilters, refuse),
    async (c) =>
      list.answer(c, await listRequests(as(c), c.req.valid("query"))),
  );

  const one = documented(
    "One request, with the queries and searches it links that the caller may read",
    RequestDetail,
    { errors: [400, 404] },
  );
  routes.get(
    "/requests/:id",
    one.doc,
    credential,
    validator("param", id, refuse),
    async (c) =>
      one.answer(c, await getRequest(as(c), c.req.valid("param").id)),
  );

  const remove = removed(
    "Delete a request: your own, or any as an admin",
    [400, 404],
  );
  routes.delete(
    "/requests/:id",
    remove.doc,
    credential,
    validator("param", id, refuse),
    async (c) => {
      await deleteRequest(as(c), c.req.valid("param").id);
      return remove.answer(c);
    },
  );
  return routes;
}
