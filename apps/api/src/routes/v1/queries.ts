import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import type { AppEnv } from "../../app.js";
import type { AppDeps } from "../../context.js";
import { QUERY_STATUSES } from "../../db/schema/queries.js";
import { ServiceError } from "../../errors.js";
import { peerOf } from "../../http/peer.js";
import { apiConfig } from "../../services/auth/better-auth.js";
import { clientAddress } from "../../services/auth/client-address.js";
import { requirePrincipal } from "../../services/auth/principal.js";
import { downloadCsv } from "../../services/queries/csv-access.js";
import { executeDax } from "../../services/queries/execute.js";
import { getQuery, searchQueryLog } from "../../services/queries/log.js";
import { readResult, resultCsvLink } from "../../services/queries/store.js";
import {
  credential,
  documented,
  failures,
  guid,
  refuse,
  serviceContext,
  text,
} from "./adapter.js";
import { Anchor, Entry, Link, ResultPage } from "./schemas.js";

const id = z.object({ id: guid });
const flag = z.enum(["true", "false"]).transform((value) => value === "true");
const when = z.iso
  .datetime()
  .max(40)
  .transform((value) => new Date(value));

const NewQuery = z.strictObject({
  dataset: text,
  dax: z.string().min(1).max(102_400),
  purpose: z.string().max(2000).nullable().optional(),
  preview_rows: z.number().int().min(0).max(100).optional(),
});
const QueryFilters = z.strictObject({
  text: text.optional(),
  dataset: text.optional(),
  workspace: text.optional(),
  metric: text.optional(),
  principal: text.optional(),
  mine: flag.optional(),
  status: z.enum(QUERY_STATUSES).optional(),
  since: when.optional(),
  until: when.optional(),
  cursor: text.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const Page = z.strictObject({
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  limit: z.coerce.number().int().min(0).max(100_000).optional(),
});
const SignedLink = z.object({
  expires: z.string().max(20).optional(),
  signature: z.string().max(200).optional(),
});

/** Queries and their results: run DAX, search the log, page a result, take it as CSV. */
export function queriesRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const as = serviceContext(deps);

  const run = documented(
    "Run DAX on a dataset as the caller; answers a preview and the result's anchor",
    Anchor,
    { status: 201, errors: [400, 404, 409, 429, 502] },
  );
  routes.post(
    "/queries",
    run.doc,
    credential,
    validator("json", NewQuery, refuse),
    async (c) => run.answer(c, await executeDax(as(c), c.req.valid("json"))),
  );

  const search = documented(
    "Search the query log, newest first",
    z.object({ items: z.array(Entry), next_cursor: z.string().nullable() }),
    { errors: [400] },
  );
  routes.get(
    "/queries",
    search.doc,
    credential,
    validator("query", QueryFilters, refuse),
    async (c) =>
      search.answer(c, await searchQueryLog(as(c), c.req.valid("query"))),
  );

  const one = documented("One query with its whole DAX and purpose", Entry, {
    errors: [400, 404],
  });
  routes.get(
    "/queries/:id",
    one.doc,
    credential,
    validator("param", id, refuse),
    async (c) => one.answer(c, await getQuery(as(c), c.req.valid("param").id)),
  );

  const page = documented("A page of a result, for its owner", ResultPage, {
    errors: [400, 404],
  });
  routes.get(
    "/results/:id",
    page.doc,
    credential,
    validator("param", id, refuse),
    validator("query", Page, refuse),
    async (c) =>
      page.answer(
        c,
        await readResult(as(c), c.req.valid("param").id, c.req.valid("query")),
      ),
  );

  const mint = documented(
    "A fresh signed link to a result's CSV, for its owner",
    Link,
    {
      errors: [400, 404],
    },
  );
  routes.post(
    "/results/:id/csv-link",
    mint.doc,
    credential,
    validator("param", id, refuse),
    async (c) => {
      const link = await resultCsvLink(as(c), c.req.valid("param").id);
      return mint.answer(c, {
        csv_url: link.url,
        csv_url_expires_at: link.expires_at,
      });
    },
  );

  // Public for GET (http/public-paths.ts): the signed form carries no
  // credential, so services/queries/csv-access.ts judges the link or the
  // caller. It is the one route that does not run `credential` first.
  routes.get(
    "/results/:id/csv",
    describeRoute({
      summary:
        "A result as CSV, with a signed link (expires, signature) or the owner's own credential",
      responses: {
        200: {
          description: "RFC 4180 CSV, UTF-8, with a header row.",
          content: { "text/csv": { schema: resolver(z.string()) } },
        },
        ...failures([400, 404, 429]),
      },
    }),
    validator("param", id, refuse),
    validator("query", SignedLink, refuse),
    async (c) => {
      const result = c.req.valid("param").id;
      const caller = c.get("principal");
      const link = c.req.valid("query");
      // A token the api did not take, with no link beside it, is refused as
      // on every other path: 401, and the challenge that says to sign in.
      if (
        c.get("bearer_refusal") !== undefined &&
        link.expires === undefined &&
        link.signature === undefined
      )
        throw new ServiceError(
          "unauthenticated",
          "This token is not valid here. Sign in again, or use a signed CSV link.",
        );
      const body = await downloadCsv(deps, {
        result,
        link,
        credential: caller === undefined ? undefined : requirePrincipal(c),
        address: clientAddress(
          peerOf(c.env),
          c.req.raw.headers,
          apiConfig(deps.config),
        ),
      });
      return c.body(body, 200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="result-${result}.csv"`,
        "Cache-Control": "no-store",
      });
    },
  );

  return routes;
}
