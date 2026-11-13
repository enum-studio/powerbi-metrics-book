import { Hono } from "hono";
import { validator } from "hono-openapi";
import { z } from "zod";
import type { AppEnv } from "../../app.js";
import type { AppDeps } from "../../context.js";
import { COMPARISONS, TRUST_STATES } from "../../db/schema/book.js";
import * as categories from "../../services/book/categories.js";
import { setDocs } from "../../services/book/docs.js";
import { ICON_KINDS, setIcon } from "../../services/book/icons.js";
import { nextDrafts } from "../../services/book/drafts.js";
import * as metrics from "../../services/book/metrics.js";
import * as terms from "../../services/book/terms.js";
import { moveVariant } from "../../services/book/variants.js";
import {
  anchor,
  credential,
  custom,
  documented,
  free,
  guid,
  refuse,
  removed,
  serviceContext,
  stamp,
  text,
} from "./adapter.js";
import {
  Category,
  Dataset,
  Docs,
  IconSet,
  Metric,
  Shift,
  Term,
  Variant,
} from "./schemas.js";

const orNull = text.nullable();
const freeOrNull = free.nullable();
const fields = z.strictObject({
  label: text,
  definition: free,
  aliases: z.array(text).max(100).nullable(),
  when_to_use: free,
  not_the_same_as: freeOrNull,
  grain_and_filters: free,
  unit: orNull,
  category: orNull,
  owner: orNull,
  custom,
});
const NewMetric = fields.partial().extend({ name: text, label: text });
// A rename and an update are two changes, so one request makes one of them.
const MetricChange = z.union([
  z.strictObject({ name: text }),
  fields.partial(),
]);
const Move = z.strictObject({
  to_metric: text,
  period: text,
  comparison: z.enum(COMPARISONS),
  comparison_period: orNull,
  currency: orNull,
  custom_axes: z
    .record(text, text)
    .refine((axes) => Object.keys(axes).length <= 20, "At most 20 axes."),
  note: freeOrNull,
});
const CategoryChange = z.union([
  z.strictObject({
    parent: orNull,
    position: z.number().int().min(0).max(100_000).optional(),
  }),
  z.strictObject({
    name: text.optional(),
    key: text.optional(),
    description: freeOrNull.optional(),
  }),
]);
const termFields = z.strictObject({
  definition: free,
  aliases: z.array(text).max(100).nullable(),
  not_the_same_as: freeOrNull,
  // A list of values, or a map from each value to what it means.
  values: z
    .union([
      z.array(text).max(500),
      z
        .record(text, free)
        .refine((meanings) => Object.keys(meanings).length <= 500),
    ])
    .nullable(),
  owner: orNull,
  custom,
});
const name = z.object({ name: text });
const column = z.object({ name: text, column_id: guid });
const relation = z.object({ name: text, metric: text });
const Draft = z.object({
  kind: z.literal("metric"),
  id: z.string(),
  name: z.string(),
  label: z.string(),
  dataset_count: z.number(),
  datasets: z.array(Dataset),
  variants: z.array(
    Variant.pick({
      kind: true,
      id: true,
      dataset: true,
      workspace: true,
      measure: true,
      measure_reference: true,
      reads_selection: true,
      selection_columns: true,
      expression: true,
      format_string: true,
    }).extend({ shift: Shift.extend({ shift_note: z.string().nullable() }) }),
  ),
  hidden_variants: z.number(),
  closest_metrics: z.array(
    anchor("metric").extend({
      label: z.string(),
      trust_state: z.enum(TRUST_STATES),
      similarity: z.number(),
    }),
  ),
  suggested_merges: z
    .array(
      z.object({
        metric_id: z.string(),
        measure: z.string(),
        into_metric_id: z.string(),
        into_measure: z.string(),
        word: z.string().nullable(),
        axis: z.enum(["period", "currency", "name", "calculation"]),
        dataset_count: z
          .number()
          .describe(
            "How many datasets the caller may describe hold `measure` under `metric_id`. It counts this one name: merging the two metrics moves every variant of `metric_id`.",
          ),
      }),
    )
    .describe(
      "Likely merges: `measure` is `into_measure` plus `word`, or the same name when `axis` is `name`, from names alone. When `axis` is `calculation`, both metrics hold a base measure with the same DAX once normalised and its measure references written out, usually under two names. That says nothing of the rows in each model, so check both. One entry for the two names under the two metrics, however many datasets hold them. Both metrics' variants name the measures.",
    ),
  hidden_suggested_merges: z
    .number()
    .describe(
      "Entries from a period or currency word left out because a measure on one side is out of the caller's reach or PII. They are counted, never named.",
    ),
  suggested_merges_truncated: z
    .boolean()
    .describe(
      "True when a measure name of this draft that the caller may describe was not looked up for period or currency pairs, because the draft's names, with all the others on the page, passed the limit on what one read of likely merges builds. Pairs from that name may be missing. It is false when only names out of the caller's reach were left out.",
    ),
});
const History = z.array(
  z.object({
    id: z.number(),
    at: stamp,
    principal_kind: z.enum(["person", "service_account", "system"]),
    principal_id: z.string(),
    principal_name: z
      .string()
      .describe(
        "The display name of the person or service account, or the system. Never an email.",
      ),
    via: z.enum(["browser", "mcp", "api", "cli"]).nullable(),
    element_kind: z.string(),
    element_id: z.string(),
    action: z.string(),
    before: z.unknown(),
    after: z.unknown(),
  }),
);
const Checks = z.object({
  checks: z.array(
    z.object({
      check: z.string(),
      passed: z.boolean(),
      message: z.string(),
      other_labels: z
        .array(z.string())
        .optional()
        .describe("The metrics the sentence counts, closest first."),
    }),
  ),
});

/** Curation: the routes that change the book, for `book:curate` and `book:verify`. */
export function curationRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const as = serviceContext(deps);

  const next = documented("The next drafts to structure", z.array(Draft), {
    errors: [400],
  });
  routes.get(
    "/drafts/next",
    next.doc,
    credential,
    validator(
      "query",
      z.object({
        dataset: text.optional(),
        limit: z.coerce.number().int().min(1).max(50).optional(),
      }),
      refuse,
    ),
    async (c) => next.answer(c, await nextDrafts(as(c), c.req.valid("query"))),
  );

  const create = documented("Create a metric", Metric, {
    status: 201,
    errors: [400, 409],
  });
  routes.post(
    "/metrics",
    create.doc,
    credential,
    validator("json", NewMetric, refuse),
    async (c) =>
      create.answer(c, await metrics.createMetric(as(c), c.req.valid("json"))),
  );

  const change = documented(
    "Rename a metric (name), or change its fields",
    Metric,
    { errors: [400, 404, 409] },
  );
  routes.patch(
    "/metrics/:name",
    change.doc,
    credential,
    validator("param", name, refuse),
    validator("json", MetricChange, refuse),
    async (c) => {
      const body = c.req.valid("json");
      const key = c.req.valid("param").name;
      return change.answer(
        c,
        "name" in body
          ? await metrics.renameMetric(as(c), key, body.name)
          : await metrics.updateMetric(as(c), key, body),
      );
    },
  );

  const merge = documented(
    "Move the variants of `from` under this metric",
    Metric,
    { errors: [400, 404, 409] },
  );
  routes.post(
    "/metrics/:name/merge",
    merge.doc,
    credential,
    validator("param", name, refuse),
    validator("json", z.strictObject({ from: text }), refuse),
    async (c) =>
      merge.answer(
        c,
        await metrics.mergeMetrics(as(c), {
          from: c.req.valid("json").from,
          into: c.req.valid("param").name,
        }),
      ),
  );

  const verify = documented("Mark a metric agent_verified", Metric, {
    errors: [400, 404],
  });
  routes.post(
    "/metrics/:name/verify",
    verify.doc,
    credential,
    validator("param", name, refuse),
    async (c) =>
      verify.answer(
        c,
        await metrics.verifyMetric(as(c), c.req.valid("param").name),
      ),
  );

  const dismiss = documented("Dismiss a draft", Metric, {
    errors: [400, 404],
  });
  routes.post(
    "/metrics/:name/dismiss",
    dismiss.doc,
    credential,
    validator("param", name, refuse),
    validator("json", z.strictObject({ reason: text }), refuse),
    async (c) =>
      dismiss.answer(
        c,
        await metrics.dismissMetric(
          as(c),
          c.req.valid("param").name,
          c.req.valid("json").reason,
        ),
      ),
  );

  const drop = removed("Delete a metric with no variants", [400, 404, 409]);
  routes.delete(
    "/metrics/:name",
    drop.doc,
    credential,
    validator("param", name, refuse),
    async (c) => {
      await metrics.deleteMetric(as(c), c.req.valid("param").name);
      return drop.answer(c);
    },
  );

  const checks = documented(
    "Every check on a metric, passing and failing",
    Checks,
    { errors: [400, 404] },
  );
  routes.get(
    "/metrics/:name/checks",
    checks.doc,
    credential,
    validator("param", name, refuse),
    async (c) =>
      checks.answer(c, {
        checks: await metrics.metricChecks(as(c), c.req.valid("param").name),
      }),
  );

  const history = documented("The changes made to a metric", History, {
    errors: [400, 404],
  });
  routes.get(
    "/metrics/:name/history",
    history.doc,
    credential,
    validator("param", name, refuse),
    async (c) =>
      history.answer(
        c,
        await metrics.metricHistory(as(c), c.req.valid("param").name),
      ),
  );

  const move = documented(
    "Move a variant to another metric, or change its shift",
    Variant,
    { errors: [400, 404, 409] },
  );
  routes.patch(
    "/variants/:id",
    move.doc,
    credential,
    validator("param", z.object({ id: guid }), refuse),
    validator("json", Move.partial(), refuse),
    async (c) =>
      move.answer(
        c,
        await moveVariant(as(c), c.req.valid("param").id, c.req.valid("json")),
      ),
  );

  // A category's path has slashes (sales/orders), so it takes the rest of the URL.
  const path = z.object({ path: text });
  const addCategory = documented("Create a category", Category, {
    status: 201,
    errors: [400, 404, 409],
  });
  routes.post(
    "/categories/:path{.+}",
    addCategory.doc,
    credential,
    validator("param", path, refuse),
    validator(
      "json",
      z.strictObject({ name: text, description: freeOrNull.optional() }),
      refuse,
    ),
    async (c) =>
      addCategory.answer(
        c,
        await categories.createCategory(
          as(c),
          c.req.valid("param").path,
          c.req.valid("json"),
        ),
      ),
  );

  const changeCategory = documented(
    "Rename a category (name, key), or move it (parent)",
    Category,
    { errors: [400, 404, 409] },
  );
  routes.patch(
    "/categories/:path{.+}",
    changeCategory.doc,
    credential,
    validator("param", path, refuse),
    validator("json", CategoryChange, refuse),
    async (c) => {
      const body = c.req.valid("json");
      const at = c.req.valid("param").path;
      return changeCategory.answer(
        c,
        "parent" in body
          ? await categories.moveCategory(as(c), at, body)
          : await categories.renameCategory(as(c), at, body),
      );
    },
  );

  const dropCategory = removed("Delete an empty category", [400, 404, 409]);
  routes.delete(
    "/categories/:path{.+}",
    dropCategory.doc,
    credential,
    validator("param", path, refuse),
    async (c) => {
      await categories.deleteCategory(as(c), c.req.valid("param").path);
      return dropCategory.answer(c);
    },
  );

  const addTerm = documented("Create a term", Term, {
    status: 201,
    errors: [400, 409],
  });
  routes.post(
    "/terms/:name",
    addTerm.doc,
    credential,
    validator("param", name, refuse),
    validator("json", termFields.partial(), refuse),
    async (c) =>
      addTerm.answer(
        c,
        await terms.createTerm(as(c), {
          ...c.req.valid("json"),
          name: c.req.valid("param").name,
        }),
      ),
  );

  const changeTerm = documented(
    "Change a term, renaming it when name is sent",
    Term,
    { errors: [400, 404, 409] },
  );
  routes.patch(
    "/terms/:name",
    changeTerm.doc,
    credential,
    validator("param", name, refuse),
    validator("json", termFields.extend({ name: text }).partial(), refuse),
    async (c) =>
      changeTerm.answer(
        c,
        await terms.updateTerm(
          as(c),
          c.req.valid("param").name,
          c.req.valid("json"),
        ),
      ),
  );

  const dropTerm = removed("Delete a term", [400, 404, 409]);
  routes.delete(
    "/terms/:name",
    dropTerm.doc,
    credential,
    validator("param", name, refuse),
    async (c) => {
      await terms.deleteTerm(as(c), c.req.valid("param").name);
      return dropTerm.answer(c);
    },
  );

  const link = documented("Link a column to a term", Term, {
    errors: [400, 404, 409],
  });
  routes.put(
    "/terms/:name/columns/:column_id",
    link.doc,
    credential,
    validator("param", column, refuse),
    async (c) => {
      const { name: term, column_id } = c.req.valid("param");
      return link.answer(c, await terms.linkColumn(as(c), term, column_id));
    },
  );

  const unlink = documented("Unlink a column from a term", Term, {
    errors: [400, 404],
  });
  routes.delete(
    "/terms/:name/columns/:column_id",
    unlink.doc,
    credential,
    validator("param", column, refuse),
    async (c) => {
      const { name: term, column_id } = c.req.valid("param");
      return unlink.answer(c, await terms.unlinkColumn(as(c), term, column_id));
    },
  );

  const relate = documented("Relate a term to a metric", Term, {
    errors: [400, 404],
  });
  routes.put(
    "/terms/:name/metrics/:metric",
    relate.doc,
    credential,
    validator("param", relation, refuse),
    async (c) => {
      const { name: term, metric } = c.req.valid("param");
      return relate.answer(c, await terms.relateMetric(as(c), term, metric));
    },
  );

  const unrelate = documented("Unrelate a term from a metric", Term, {
    errors: [400, 404],
  });
  routes.delete(
    "/terms/:name/metrics/:metric",
    unrelate.doc,
    credential,
    validator("param", relation, refuse),
    async (c) => {
      const { name: term, metric } = c.req.valid("param");
      return unrelate.answer(
        c,
        await terms.unrelateMetric(as(c), term, metric),
      );
    },
  );

  const docs = documented(
    "Set an element's description and custom fields",
    Docs,
    {
      errors: [400, 404],
    },
  );
  routes.put(
    "/elements/:kind/:id/docs",
    docs.doc,
    credential,
    validator("param", z.object({ kind: text, id: guid }), refuse),
    validator(
      "json",
      z.strictObject({ description: freeOrNull, custom }).partial(),
      refuse,
    ),
    async (c) =>
      docs.answer(
        c,
        await setDocs(as(c), c.req.valid("param"), c.req.valid("json")),
      ),
  );

  const iconParams = z.object({ kind: z.enum(ICON_KINDS), id: guid });
  const icon = documented(
    "Set a metric's, category's, term's, workspace's or dataset's icon",
    IconSet,
    { errors: [400, 404] },
  );
  routes.put(
    "/elements/:kind/:id/icon",
    icon.doc,
    credential,
    validator("param", iconParams, refuse),
    validator("json", z.strictObject({ icon: text }), refuse),
    async (c) =>
      icon.answer(
        c,
        await setIcon(as(c), c.req.valid("param"), c.req.valid("json").icon),
      ),
  );
  const iconCleared = documented("Clear an element's icon", IconSet, {
    errors: [400, 404],
  });
  routes.delete(
    "/elements/:kind/:id/icon",
    iconCleared.doc,
    credential,
    validator("param", iconParams, refuse),
    async (c) =>
      iconCleared.answer(c, await setIcon(as(c), c.req.valid("param"), null)),
  );

  return routes;
}
