import { Hono } from "hono";
import { validator } from "hono-openapi";
import { z } from "zod";
import type { AppEnv } from "../../app.js";
import type { AppDeps } from "../../context.js";
import { docsChecks } from "../../services/book/docs.js";
import { RULE_TARGETS } from "../../services/conventions/rules.js";
import {
  credential,
  documented,
  refuse,
  serviceContext,
  text,
} from "./adapter.js";

export function docsChecksRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const as = serviceContext(deps);
  const checks = documented(
    "Missing required documentation on visible datasets, tables and columns; to a curator, on the first page, the element exceptions nothing needs any more",
    z.object({
      items: z.array(
        z.object({
          kind: z.enum(["dataset", "table", "column"]),
          id: z.string(),
          name: z.string(),
          dataset: z.string(),
          table: z.string().optional(),
          results: z.array(
            z.object({
              check: z.string(),
              rule: z.string(),
              passed: z.boolean(),
              message: z.string(),
              exception: z.string().optional(),
            }),
          ),
        }),
      ),
      failing: z.number().int(),
      unused_exceptions: z
        .array(
          z.object({
            rule: z.string(),
            target: z.partialRecord(z.enum(RULE_TARGETS), z.string()),
            reason: z.string(),
            why: z.enum(["no_such_target", "passes", "ambiguous"]),
          }),
        )
        .optional(),
      next_cursor: z.string().nullable(),
    }),
    { errors: [400, 404] },
  );
  routes.get(
    "/docs/checks",
    checks.doc,
    credential,
    validator(
      "query",
      z.strictObject({
        dataset: text.optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        cursor: text.optional(),
      }),
      refuse,
    ),
    async (c) =>
      checks.answer(c, await docsChecks(as(c), c.req.valid("query"))),
  );
  return routes;
}
