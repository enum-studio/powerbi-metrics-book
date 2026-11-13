import { Hono } from "hono";
import { validator } from "hono-openapi";
import { z } from "zod";
import type { AppEnv } from "../../app.js";
import type { AppDeps } from "../../context.js";
import { EVENT_KINDS } from "../../db/schema/events.js";
import {
  EVENT_PAGE_MAX,
  readVisibleEvents,
} from "../../services/events/feed.js";
import {
  commaList,
  credential,
  documented,
  refuse,
  serviceContext,
  stamp,
} from "./adapter.js";

const Query = z.strictObject({
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  kinds: commaList(EVENT_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(EVENT_PAGE_MAX).optional(),
});
const Events = z.array(
  z.object({
    id: z.number(),
    at: stamp,
    kind: z.enum(EVENT_KINDS),
    element: z.object({ kind: z.string(), id: z.string() }).nullable(),
    principal: z
      .object({
        kind: z.enum(["person", "service_account"]),
        id: z.string(),
      })
      .nullable(),
    data: z.record(z.string(), z.unknown()),
  }),
);

/** The change feed: oldest first, read by id, for what the caller may describe. */
export function eventsRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const as = serviceContext(deps);

  const feed = documented(
    "The events after an id, oldest first, that the caller may see",
    Events,
    { errors: [400] },
  );
  routes.get(
    "/events",
    feed.doc,
    credential,
    validator("query", Query, refuse),
    async (c) => {
      const rows = await readVisibleEvents(as(c), c.req.valid("query"));
      return feed.answer(
        c,
        rows.map((row) => ({
          id: row.id,
          at: row.at,
          kind: row.kind,
          element:
            row.element_kind === null || row.element_id === null
              ? null
              : { kind: row.element_kind, id: row.element_id },
          principal:
            row.principal_kind === null || row.principal_id === null
              ? null
              : { kind: row.principal_kind, id: row.principal_id },
          data: row.data,
        })),
      );
    },
  );

  return routes;
}
