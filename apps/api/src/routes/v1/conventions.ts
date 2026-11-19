import { Hono } from "hono";
import { validator } from "hono-openapi";
import { z } from "zod";
import type { AppEnv } from "../../app.js";
import type { AppDeps } from "../../context.js";
import { RULE_TARGETS } from "../../services/conventions/rules.js";
import {
  CHECK_NAMES,
  conventionsSchema,
  PRESET_NAMES,
} from "../../services/conventions/schema.js";
import {
  applyAsAdmin,
  diffAsAdmin,
  getCompanyPartAsAdmin,
  listRules,
  listVersionsAsAdmin,
  setConventionsAsAdmin,
  unusedExceptionsAsCurator,
} from "../../services/conventions/service.js";
import {
  credential,
  documented,
  refuse,
  serviceContext,
  stamp,
  text,
} from "./adapter.js";

// The service checks a document against the schema, so the route takes it as it comes, bounded.
const Document = z
  .record(text, z.unknown())
  .refine((document) => Object.keys(document).length <= 50);
const Change = z.object({
  path: z.string(),
  before: z.unknown(),
  after: z.unknown(),
});
const Rules = z.object({
  rules: z.array(
    z.object({
      id: z.string(),
      check: z.enum(CHECK_NAMES),
      target: z.enum(RULE_TARGETS),
      value: z.unknown(),
      source: z.enum(["preset", "company"]),
      allowed: z.array(z.union([z.string(), z.boolean()])).nullable(),
      off: z.boolean(),
      exceptions: z.number().int(),
    }),
  ),
  fixed: z.array(z.object({ id: z.string(), reason: z.string() })),
});
// What the company set, as stored: every key beside these is the company's.
const CompanyPart = z.looseObject({
  format: z.literal(1),
  preset: z.enum(PRESET_NAMES).optional(),
});

/**
 * GET /api/v1/conventions/rules for anyone signed in, as GET /conventions is;
 * PUT /conventions, GET /conventions/company, /conventions/versions, POST
 * /conventions/diff and /conventions/apply for `book:edit_conventions`; GET
 * /conventions/exceptions/unused for a curator, as a metric's checks are.
 */
export function conventionsRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const as = serviceContext(deps);

  const rules = documented(
    "Every rule by its id: its value, where the value comes from, and whether it is off",
    Rules,
  );
  routes.get("/conventions/rules", rules.doc, credential, async (c) =>
    rules.answer(c, await listRules(as(c))),
  );

  const company = documented(
    "What the company set over its preset, in the version in force",
    CompanyPart,
  );
  routes.get("/conventions/company", company.doc, credential, async (c) =>
    company.answer(c, await getCompanyPartAsAdmin(as(c))),
  );

  const save = documented(
    "Save the conventions as the next version",
    z.object({
      version: z.number(),
      conventions: conventionsSchema,
      changes: z.array(Change),
    }),
    { errors: [400] },
  );
  routes.put(
    "/conventions",
    save.doc,
    credential,
    validator("json", Document, refuse),
    async (c) =>
      save.answer(c, await setConventionsAsAdmin(as(c), c.req.valid("json"))),
  );

  const versions = documented(
    "Every saved version, newest first",
    z.object({
      versions: z.array(
        z.object({
          version: z.number(),
          document: z.record(z.string(), z.unknown()),
          set_by: z.string(),
          set_at: stamp,
        }),
      ),
    }),
  );
  routes.get("/conventions/versions", versions.doc, credential, async (c) =>
    versions.answer(c, { versions: await listVersionsAsAdmin(as(c)) }),
  );

  const diff = documented(
    "What a document would change, unsaved",
    z.object({ changes: z.array(Change) }),
    { errors: [400] },
  );
  routes.post(
    "/conventions/diff",
    diff.doc,
    credential,
    validator("json", Document, refuse),
    async (c) =>
      diff.answer(c, {
        changes: await diffAsAdmin(as(c), c.req.valid("json")),
      }),
  );

  const apply = documented(
    "Apply the company's part: the rules it changes, how many then fail each, and the save unless it is a dry run",
    z.object({
      changed_rules: z.array(z.string()),
      now_failing: z.record(z.string(), z.number().int()),
      exceptions_added: z.number().int(),
      version: z.number().int().nullable(),
    }),
    { errors: [400] },
  );
  routes.post(
    "/conventions/apply",
    apply.doc,
    credential,
    validator(
      "json",
      z.strictObject({
        conventions: Document,
        dry_run: z.boolean(),
        baseline_reason: z.string().optional(),
      }),
      refuse,
    ),
    async (c) => apply.answer(c, await applyAsAdmin(as(c), c.req.valid("json"))),
  );

  const unused = documented(
    "The exceptions nothing needs any more: their target is gone, or passes the rule without them",
    z.object({
      unused: z.array(
        z.object({
          rule: z.string(),
          target: z.object({
            metric: z.string().optional(),
            term: z.string().optional(),
            dataset: z.string().optional(),
            table: z.string().optional(),
            column: z.string().optional(),
          }),
          reason: z.string(),
          why: z.enum(["no_such_target", "passes"]),
        }),
      ),
    }),
    { errors: [400, 404] },
  );
  routes.get(
    "/conventions/exceptions/unused",
    unused.doc,
    credential,
    validator("query", z.strictObject({ metric: text.optional() }), refuse),
    async (c) =>
      unused.answer(c, {
        unused: await unusedExceptionsAsCurator(
          as(c),
          c.req.valid("query").metric,
        ),
      }),
  );

  return routes;
}
