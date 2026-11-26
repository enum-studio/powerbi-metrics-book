import { upgradeDocumentation } from "../../services/book/upgrade-documentation.js";
import { Hono, type Context } from "hono";
import { validator } from "hono-openapi";
import { z } from "zod";
import type { AppEnv } from "../../app.js";
import type { AppDeps } from "../../context.js";
import {
  exportBook,
  exportSettings,
  getGuide,
} from "../../services/book/guide.js";
import {
  followMetric,
  setOwner,
  setTitle,
  requirePerson,
} from "../../services/book/ownership.js";
import { setRelation } from "../../services/book/relations.js";
import {
  credential,
  documented,
  free,
  refuse,
  serviceContext,
  text,
} from "./adapter.js";
import { Category, Metric, MetricDocument, Term } from "./schemas.js";
import { conventionsSchema } from "../../services/conventions/schema.js";

const Exports = z.object({
  markdown: z.boolean(),
  pdf: z.boolean(),
  guide: z.boolean(),
});
const Guide = z
  .object({
    areas: z.array(
      Category.extend({
        metrics: z.array(MetricDocument),
        headlines: z.array(MetricDocument),
      }),
    ),
    metrics: z.array(MetricDocument),
    sum: MetricDocument.nullable(),
    featured: MetricDocument.nullable(),
    glossary: z.array(
      Term.pick({
        kind: true,
        id: true,
        name: true,
        group: true,
        definition: true,
      }).extend({
        metrics: z.array(Metric.pick({ kind: true, id: true, name: true })),
      }),
    ),
    naming: conventionsSchema.shape.naming,
    exports: Exports,
  })
  .meta({ id: "Guide" });

export function documentationRoutes(deps: AppDeps) {
  const routes = new Hono<AppEnv>();
  const as = (c: Context<AppEnv>) => {
    c.header("Cache-Control", "no-store");
    return serviceContext(deps)(c);
  };
  const upgraded = documented(
    "Split legacy metric usage into reviewable drafts",
    z.object({ updated: z.array(z.string()), note: z.string() }),
  );
  routes.post("/conventions/upgrade", upgraded.doc, credential, async (c) =>
    upgraded.answer(c, await upgradeDocumentation(as(c))),
  );
  const guide = documented("Read the curated metrics guide", Guide, {
    errors: [404],
  });
  routes.get("/guide", guide.doc, credential, async (c) =>
    guide.answer(c, await getGuide(as(c))),
  );
  const settings = documented("Read available book exports", Exports);
  routes.get("/book/exports", settings.doc, credential, async (c) =>
    settings.answer(c, await exportSettings(as(c))),
  );
  const exported = documented(
    "Export visible book documentation",
    z.object({ markdown: z.string() }),
    { errors: [404] },
  );
  const format = z.object({
    format: z.enum(["markdown", "pdf"]).default("markdown"),
  });
  routes.get(
    "/guide/export",
    exported.doc,
    credential,
    validator("query", format, refuse),
    async (c) =>
      exported.answer(c, await exportBook(as(c), c.req.valid("query").format)),
  );
  routes.get(
    "/metrics/:name/export",
    exported.doc,
    credential,
    validator("param", z.object({ name: text }), refuse),
    validator("query", format, refuse),
    async (c) =>
      exported.answer(
        c,
        await exportBook(
          as(c),
          c.req.valid("query").format,
          c.req.valid("param").name,
        ),
      ),
  );
  const owned = documented("Assign the person who owns a metric", Metric, {
    errors: [400, 404],
  });
  routes.put(
    "/metrics/:name/owner",
    owned.doc,
    credential,
    validator("param", z.object({ name: text }), refuse),
    validator("json", z.strictObject({ email: z.email().nullable() }), refuse),
    async (c) =>
      owned.answer(
        c,
        await setOwner(
          as(c),
          c.req.valid("param").name,
          c.req.valid("json").email,
        ),
      ),
  );
  const followed = documented(
    "Follow or unfollow a metric as yourself",
    z.object({ following: z.boolean() }),
    { errors: [404] },
  );
  routes.put(
    "/metrics/:name/follow",
    followed.doc,
    credential,
    validator("param", z.object({ name: text }), refuse),
    validator("json", z.strictObject({ following: z.boolean() }), refuse),
    async (c) =>
      followed.answer(
        c,
        await followMetric(
          as(c),
          c.req.valid("param").name,
          c.req.valid("json").following,
        ),
      ),
  );
  const title = documented(
    "Set a person's title",
    z.object({ id: z.string(), title: z.string() }),
    { errors: [404] },
  );
  routes.put(
    "/people/:id/title",
    title.doc,
    credential,
    validator("param", z.object({ id: text }), refuse),
    validator("json", z.strictObject({ title: z.string().max(500) }), refuse),
    async (c) =>
      title.answer(
        c,
        await setTitle(
          as(c),
          c.req.valid("param").id === "me"
            ? requirePerson(as(c))
            : c.req.valid("param").id,
          c.req.valid("json").title,
        ),
      ),
  );
  const relations = documented(
    "Change a metric relationship",
    Metric.pick({ moves_with: true, edges: true }),
    { errors: [400, 404, 409] },
  );
  const pair = z.object({ name: text, other: text });
  routes.put(
    "/metrics/:name/links/:other",
    relations.doc,
    credential,
    validator("param", pair, refuse),
    validator(
      "json",
      z.strictObject({
        movement: z.enum(["same", "opposite", "depends"]),
        reason: free,
        other_reason: free.optional(),
      }),
      refuse,
    ),
    async (c) =>
      relations.answer(
        c,
        await setRelation(
          as(c),
          c.req.valid("param").name,
          c.req.valid("param").other,
          { kind: "link", value: c.req.valid("json") },
        ),
      ),
  );
  routes.put(
    "/metrics/:name/edges/:other",
    relations.doc,
    credential,
    validator("param", pair, refuse),
    validator(
      "json",
      z.strictObject({
        sign: z.union([z.literal(1), z.literal(-1)]),
        operation: z.enum(["sum", "product"]),
        note: free.nullable().optional(),
      }),
      refuse,
    ),
    async (c) =>
      relations.answer(
        c,
        await setRelation(
          as(c),
          c.req.valid("param").name,
          c.req.valid("param").other,
          { kind: "edge", value: c.req.valid("json") },
        ),
      ),
  );
  for (const [path, kind] of [
    ["links", "link"],
    ["edges", "edge"],
  ] as const)
    routes.delete(
      `/metrics/:name/${path}/:other`,
      relations.doc,
      credential,
      validator("param", pair, refuse),
      async (c) =>
        relations.answer(
          c,
          await setRelation(
            as(c),
            c.req.valid("param").name,
            c.req.valid("param").other,
            { kind, value: null },
          ),
        ),
    );
  return routes;
}
