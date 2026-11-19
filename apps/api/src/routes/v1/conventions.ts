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
  diffAsAdmin,
  getCompanyPartAsAdmin,
  listRules,
  listVersionsAsAdmin,
  setConventionsAsAdmin,
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
 * PUT /conventions, GET /conventions/company, /conventions/versions and POST
 * /conventions/diff for `book:edit_conventions`.
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

  return routes;
}
