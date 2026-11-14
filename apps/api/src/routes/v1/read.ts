import { Hono } from "hono";
import { describeRoute, validator } from "hono-openapi";
import { z } from "zod";
import type { AppEnv } from "../../app.js";
import type { AppDeps } from "../../context.js";
import { COMPARISONS, ORIGINS, TRUST_STATES } from "../../db/schema/book.js";
import { COLUMN_TYPES, RELATIONSHIPS_SOURCES } from "../../db/schema/mirror.js";
import { categoryTree } from "../../services/book/categories.js";
import { getDocs } from "../../services/book/docs.js";
import { iconChoices } from "../../services/book/icons.js";
import {
  getMetric,
  listMetrics,
  summarizeBook,
} from "../../services/book/metrics.js";
import { getTerm, listTerms } from "../../services/book/terms.js";
import { getVariant, listVariants } from "../../services/book/variants.js";
import { conventionsSchema } from "../../services/conventions/schema.js";
import { getConventionsForAgents } from "../../services/conventions/service.js";
import {
  SEARCH_CUSTOM,
  SEARCH_QUERY_KINDS,
  search,
} from "../../services/search/query.js";
import {
  getColumnDetail,
  getDataset,
  listApps,
  listColumns,
  listDatasets,
  listMeasures,
  listWorkspaces,
} from "../../services/mirror/read.js";
import { SEARCH_KINDS } from "../../db/schema/search.js";
import {
  anchor,
  commaList,
  credential,
  documented,
  guid,
  noNul,
  refuse,
  serviceContext,
  stamp,
  text,
} from "./adapter.js";
import {
  Category,
  CategoryNode,
  Docs,
  IconChoices,
  Metric,
  Questions,
  Shift,
  Term,
  Variant,
} from "./schemas.js";

/*
 * The caps match the connector's (mcp/tools/inputs.ts): a name or reference
 * 500 characters, an id a GUID. A page is at most 500 here and 100 there, since
 * only the connector's answers are bounded at 16 KiB. A query string carries only
 * text, so a list of trust states is comma-separated and the custom fields
 * are custom.KEY=VALUE parameters.
 */

const name = z.object({ name: text });
const id = z.object({ id: guid });
const paging = {
  cursor: text.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
};
const flag = z.enum(["true", "false"]).transform((value) => value === "true");
const trustStates = commaList(TRUST_STATES);
// A custom-field key, shaped as the conventions shape one.
const CUSTOM_PARAMETER = /^custom\.([a-z][a-z0-9_]*)$/;
const customNote = (most: number) =>
  `Filter on custom fields with query parameters of the form custom.KEY=VALUE, such as custom.owner_team=finance. At most ${String(most)}.`;
const LIST_CUSTOM = { most: 20, value_max: 500 };

/**
 * A list's query with its custom.KEY=VALUE parameters collected into one
 * `custom` object. A key of any other shape stays in the query, which the
 * strict object then refuses.
 */
const withCustom = <S extends z.ZodRawShape>(shape: S) =>
  z
    .record(z.string().max(600), z.string().max(500))
    .transform((query): unknown => {
      const rest: Record<string, string> = {};
      const custom: Record<string, string> = {};
      for (const [key, value] of Object.entries(query)) {
        const field = CUSTOM_PARAMETER.exec(key)?.[1];
        if (field === undefined) rest[key] = value;
        else custom[field] = value;
      }
      return Object.keys(custom).length === 0 ? rest : { ...rest, custom };
    })
    .pipe(
      z.strictObject({
        ...shape,
        custom: z
          .record(text, text)
          .refine(
            (fields) => Object.keys(fields).length <= 20,
            "At most 20 custom fields.",
          )
          .optional(),
      }),
    );
const bookFilters = {
  workspace: text.optional(),
  app: text.optional(),
  dataset: text.optional(),
  trust_states: trustStates.optional(),
};
const metricQuery = {
  ...bookFilters,
  category: text.optional(),
  not_filed: flag.optional(),
  unit: text.optional(),
  ...paging,
};
const termQuery = { ...bookFilters, ...paging };
const searchQuery = {
  query: text,
  kinds: commaList(SEARCH_QUERY_KINDS).optional(),
  ...bookFilters,
  category: text.optional(),
  unit: text.optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
};

/** The parameters withCustom accepts, for the OpenAPI document: the named filters from the shape, and custom.KEY. */
function queryDocs(
  shape: z.ZodRawShape,
  caps: { most: number; value_max: number } = LIST_CUSTOM,
) {
  // A query string is text, whatever the filter parses it to.
  const plain = { type: "string" as const };
  return describeRoute({
    description: customNote(caps.most),
    parameters: [
      ...Object.keys(shape).map((name) => ({
        name,
        in: "query" as const,
        required: false,
        schema: plain,
      })),
      {
        name: "custom.KEY",
        in: "query" as const,
        required: false,
        description: customNote(caps.most),
        schema: { type: "string" as const, maxLength: caps.value_max },
      },
    ],
  });
}

const page = <I extends z.ZodType>(item: I) =>
  z.object({ items: z.array(item), next_cursor: z.string().nullable() });
/** Present only when the caller reads PII and a rule covers the item. */
const piiTag = { pii: z.literal(true).optional() };
/** Present only when the caller may not read PII and the answer left some out. */
const piiHidden = { pii_hidden: z.number().optional() };
const reach = z.object({
  kind: z.enum(["workspace", "app", "share"]),
  id: z.string(),
  name: z.string(),
});
const labelled = (kind: "metric") => anchor(kind).extend({ label: z.string() });
const custom = z.record(z.string(), z.unknown());
const described = {
  description: z.string().nullable(),
  description_pbi: z.string().nullable(),
};

const BookSummary = z.object({
  datasets: z.number(),
  metrics: z.object({
    draft: z.number(),
    agent_verified: z.number(),
    human_verified: z.number(),
  }),
  not_filed: z.number(),
});
const MetricItem = z.object({
  kind: z.literal("metric"),
  id: z.string(),
  name: z.string(),
  label: z.string(),
  icon: z.string().nullable(),
  summary: z.string(),
  summary_truncated: z.literal(true).optional(),
  aliases: z.array(z.string()),
  dataset_count: z.number(),
  unit: z.string().nullable(),
  category: Category.nullable(),
  trust_state: z.enum(TRUST_STATES),
  origin: z.enum(ORIGINS),
  custom,
  dismissed: z.boolean(),
});
const VariantItem = Variant.pick({
  kind: true,
  id: true,
  dataset: true,
  workspace: true,
  measure: true,
  measure_reference: true,
  reads_selection: true,
  selection_columns: true,
  shift: true,
}).extend({ metric: anchor("metric") });
const TermItem = z.object({
  kind: z.literal("term"),
  id: z.string(),
  name: z.string(),
  icon: z.string().nullable(),
  type: z.enum(["dimension", "concept"]),
  summary: z.string(),
  summary_truncated: z.literal(true).optional(),
  column_count: z.number(),
  aliases: z.array(z.string()).nullable(),
  owner: z.string().nullable(),
  trust_state: z.enum(TRUST_STATES),
  custom,
});
const Ref = z.object({
  kind: z.enum(["workspace", "app", "dataset", "table"]),
  id: z.string(),
  name: z.string(),
});
const WorkspaceItem = z.object({
  kind: z.literal("workspace"),
  id: z.string(),
  name: z.string(),
  icon: z.string().nullable(),
  description: z.string().nullable(),
  dataset_count: z.number(),
});
const AppItem = z.object({
  kind: z.literal("app"),
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  workspace: anchor("workspace"),
  datasets: z.array(anchor("dataset")),
});
const DatasetItem = z.object({
  kind: z.literal("dataset"),
  id: z.string(),
  name: z.string(),
  icon: z.string().nullable(),
  description: z.string().nullable(),
  workspace: Ref,
  reached_through: z.array(reach),
  has_row_level_security: z.boolean(),
  removed: z.boolean(),
});
const RelationshipItem = z.object({
  from_table: z.string(),
  from_column: z.string(),
  to_table: z.string(),
  to_column: z.string(),
  cardinality: z.string().nullable(),
  cross_filtering_behavior: z.string().nullable(),
  is_active: z.boolean(),
});
const DatasetDetail = z.object({
  ...Questions,
  kind: z.literal("dataset"),
  id: z.string(),
  name: z.string(),
  icon: z.string().nullable(),
  ...described,
  workspace: anchor("workspace"),
  apps: z.array(reach),
  reached_through: z.array(reach),
  configured_by: z.string().nullable(),
  target_storage_mode: z.string().nullable(),
  has_row_level_security: z.boolean(),
  endorsement: z.string().nullable(),
  sensitivity_label: z.string().nullable(),
  schema_error: z.string().nullable(),
  schema_changed_at: stamp.nullable(),
  created_date: stamp.nullable(),
  synced_at: stamp,
  described_by: z.string().nullable(),
  described_at: stamp.nullable(),
  custom,
  relationships_source: z.enum(RELATIONSHIPS_SOURCES).nullable(),
  relationships_read_at: stamp.nullable(),
  relationships_note: z.string().nullable(),
  relationships: z.array(RelationshipItem),
  tables: z.array(
    z.object({
      kind: z.literal("table"),
      id: z.string(),
      name: z.string(),
      is_hidden: z.boolean(),
      ...described,
      column_count: z.number(),
      measure_count: z.number(),
      custom,
      ...piiTag,
    }),
  ),
  ...piiHidden,
});
const ColumnItem = z.object({
  kind: z.literal("column"),
  id: z.string(),
  name: z.string(),
  table: anchor("table"),
  data_type: z.string().nullable(),
  column_type: z.enum(COLUMN_TYPES).nullable(),
  is_hidden: z.boolean(),
  ...described,
  display_folder: z.string().nullable(),
  terms: z.array(z.object({ id: z.string(), name: z.string() })),
  removed: z.boolean(),
  ...piiTag,
});
const ColumnDetail = z.object({
  column: ColumnItem.extend({
    expression: z.string().nullable(),
    format_string: z.string().nullable(),
  }),
  table: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
  }),
  terms: z.array(z.object({ name: z.string(), definition: z.string() })),
  relationships: z.array(RelationshipItem),
  used_by: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      table: z.string(),
      display_folder: z.string().nullable(),
      metric: z
        .object({
          name: z.string(),
          label: z.string(),
          trust_state: z.enum(TRUST_STATES),
        })
        .nullable(),
    }),
  ),
});
const MeasureItem = z.object({
  kind: z.literal("measure"),
  id: z.string(),
  name: z.string(),
  table: anchor("table"),
  display_folder: z.string().nullable(),
  format_string: z.string().nullable(),
  is_hidden: z.boolean(),
  ...described,
  metric: labelled("metric").nullable(),
  shift: Shift.extend({ shift_note: z.string().nullable() })
    .partial()
    .nullable(),
  removed: z.boolean(),
  ...piiTag,
});
const SearchAnswer = z.object({
  items: z.array(
    z.object({
      kind: z.enum(SEARCH_KINDS),
      id: z.string(),
      name: z.string(),
      key: z.string().nullable(),
      label: z.string(),
      summary: z.string(),
      summary_truncated: z.literal(true).optional(),
      dataset: Ref.nullable(),
      trust_state: z.enum(TRUST_STATES).nullable(),
      score: z.number(),
      match: z.enum(["exact", "words", "meaning"]),
      path: z.array(
        z.object({
          kind: z.enum(["workspace", "dataset", "table", "folder", "category"]),
          id: z.string(),
          name: z.string(),
          key: z.string().nullable(),
        }),
      ),
      icon: z.string().nullable(),
      metric: z.object({ name: z.string(), label: z.string() }).nullable(),
    }),
  ),
  counts: z.partialRecord(z.enum(SEARCH_KINDS), z.number().int()),
  search_id: z.string().nullable(),
  search_mode: z.enum(["hybrid", "words_only"]),
  note: z.string().nullable(),
});
const Conventions = z.object({
  preset: conventionsSchema.shape.preset,
  guide: z.string(),
  summary: z.array(z.string()),
  rules: conventionsSchema.omit({ guide: true }),
});

/** The book and the mirror read: any principal, as far as it may describe. */
export function readRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const as = serviceContext(deps);

  const found = documented(
    "Search the book by meaning and by words, among what the caller may describe",
    SearchAnswer,
    { errors: [400, 429] },
  );
  routes.get(
    "/search",
    found.doc,
    queryDocs(searchQuery, SEARCH_CUSTOM),
    credential,
    validator("query", withCustom(searchQuery), refuse),
    async (c) => found.answer(c, await search(as(c), c.req.valid("query"))),
  );

  const conventions = documented(
    "The company's conventions: the guide in words and the rules as data",
    Conventions,
  );
  routes.get("/conventions", conventions.doc, credential, async (c) =>
    conventions.answer(c, await getConventionsForAgents(as(c))),
  );

  const summary = documented(
    "How much of the book the caller can see, for the home page",
    BookSummary,
  );
  routes.get("/book/summary", summary.doc, credential, async (c) =>
    summary.answer(c, await summarizeBook(as(c))),
  );

  const metrics = documented(
    "The metrics, A to Z, as small anchors",
    page(MetricItem).extend({ total: z.number().optional() }),
    { errors: [400] },
  );
  routes.get(
    "/metrics",
    metrics.doc,
    queryDocs(metricQuery),
    credential,
    validator("query", withCustom(metricQuery), refuse),
    async (c) =>
      metrics.answer(c, await listMetrics(as(c), c.req.valid("query"))),
  );

  const metric = documented(
    "One metric: its definition and the measure in each dataset",
    Metric,
    { errors: [400, 404] },
  );
  routes.get(
    "/metrics/:name",
    metric.doc,
    credential,
    validator("param", name, refuse),
    async (c) =>
      metric.answer(c, await getMetric(as(c), c.req.valid("param").name)),
  );

  const variants = documented(
    "A metric's variants, with their shifts and no DAX",
    page(VariantItem),
    { errors: [400, 404] },
  );
  routes.get(
    "/metrics/:name/variants",
    variants.doc,
    credential,
    validator("param", name, refuse),
    validator(
      "query",
      z.strictObject({
        dataset: text.optional(),
        workspace: text.optional(),
        period: text.optional(),
        comparison: z.enum(COMPARISONS).optional(),
        // An empty currency is the dataset's own.
        currency: z
          .string()
          .max(500)
          .refine(noNul, "A NUL character is not allowed.")
          .transform((value) => (value === "" ? null : value))
          .optional(),
        ...paging,
      }),
      refuse,
    ),
    async (c) =>
      variants.answer(
        c,
        await listVariants(
          as(c),
          c.req.valid("param").name,
          c.req.valid("query"),
        ),
      ),
  );

  const variant = documented("One variant in full, with its DAX", Variant, {
    errors: [400, 404],
  });
  routes.get(
    "/variants/:id",
    variant.doc,
    credential,
    validator("param", id, refuse),
    async (c) =>
      variant.answer(c, await getVariant(as(c), c.req.valid("param").id)),
  );

  const tree = documented(
    "The categories as a tree, with the metrics in each that the caller may see",
    z.array(CategoryNode),
    { errors: [400, 404] },
  );
  routes.get(
    "/categories",
    tree.doc,
    credential,
    validator("query", z.strictObject({ parent: text.optional() }), refuse),
    async (c) =>
      tree.answer(c, await categoryTree(as(c), c.req.valid("query").parent)),
  );

  const terms = documented(
    "The glossary terms, A to Z, as small anchors",
    page(TermItem),
    { errors: [400] },
  );
  routes.get(
    "/terms",
    terms.doc,
    queryDocs(termQuery),
    credential,
    validator("query", withCustom(termQuery), refuse),
    async (c) => terms.answer(c, await listTerms(as(c), c.req.valid("query"))),
  );

  const termOne = documented(
    "One term: its definition, values, backing columns and related metrics",
    Term,
    { errors: [400, 404] },
  );
  routes.get(
    "/terms/:name",
    termOne.doc,
    credential,
    validator("param", name, refuse),
    async (c) =>
      termOne.answer(c, await getTerm(as(c), c.req.valid("param").name)),
  );

  const workspaces = documented(
    "The workspaces the caller can see, with their dataset counts",
    z.array(WorkspaceItem),
  );
  routes.get("/workspaces", workspaces.doc, credential, async (c) =>
    workspaces.answer(c, await listWorkspaces(as(c))),
  );

  const apps = documented(
    "The Power BI apps the caller can see, with the datasets behind them",
    z.array(AppItem),
  );
  routes.get("/apps", apps.doc, credential, async (c) =>
    apps.answer(c, await listApps(as(c))),
  );

  const datasets = documented(
    "The datasets the caller may describe, A to Z",
    page(DatasetItem),
    { errors: [400] },
  );
  routes.get(
    "/datasets",
    datasets.doc,
    credential,
    validator(
      "query",
      z.strictObject({
        workspace: text.optional(),
        app: text.optional(),
        name_prefix: text.optional(),
        ...paging,
      }),
      refuse,
    ),
    async (c) =>
      datasets.answer(c, await listDatasets(as(c), c.req.valid("query"))),
  );

  const dataset = documented(
    "One dataset described: its tables, relationships and descriptions",
    DatasetDetail,
    { errors: [400, 404] },
  );
  routes.get(
    "/datasets/:id",
    dataset.doc,
    credential,
    validator("param", id, refuse),
    async (c) =>
      dataset.answer(c, await getDataset(as(c), c.req.valid("param").id)),
  );

  const columns = documented(
    "A dataset's columns, A to Z",
    page(ColumnItem).extend(piiHidden),
    {
      errors: [400, 404],
    },
  );
  routes.get(
    "/datasets/:id/columns",
    columns.doc,
    credential,
    validator("param", id, refuse),
    validator(
      "query",
      z.strictObject({
        table: text.optional(),
        name_prefix: text.optional(),
        ...paging,
      }),
      refuse,
    ),
    async (c) =>
      columns.answer(
        c,
        await listColumns(as(c), {
          ...c.req.valid("query"),
          dataset: c.req.valid("param").id,
        }),
      ),
  );

  const column = documented(
    "One column: its table, terms, relationships and the measures that name it",
    ColumnDetail,
    { errors: [400, 404] },
  );
  routes.get(
    "/datasets/:id/columns/:column_id",
    column.doc,
    credential,
    validator("param", z.object({ id: guid, column_id: guid }), refuse),
    async (c) => {
      const { id: dataset, column_id } = c.req.valid("param");
      return column.answer(c, await getColumnDetail(as(c), dataset, column_id));
    },
  );

  const measures = documented(
    "A dataset's measures, A to Z, with the metric that covers each",
    page(MeasureItem).extend(piiHidden),
    { errors: [400, 404] },
  );
  routes.get(
    "/datasets/:id/measures",
    measures.doc,
    credential,
    validator("param", id, refuse),
    validator(
      "query",
      z.strictObject({
        table: text.optional(),
        unfiled: flag.optional(),
        ...paging,
      }),
      refuse,
    ),
    async (c) =>
      measures.answer(
        c,
        await listMeasures(as(c), {
          ...c.req.valid("query"),
          dataset: c.req.valid("param").id,
        }),
      ),
  );

  const docs = documented("An element's description and custom fields", Docs, {
    errors: [400, 404],
  });
  routes.get(
    "/elements/:kind/:id/docs",
    docs.doc,
    credential,
    validator("param", z.object({ kind: text, id: guid }), refuse),
    async (c) => docs.answer(c, await getDocs(as(c), c.req.valid("param"))),
  );

  const icons = documented(
    "The glyph names and colors an icon may use",
    IconChoices,
  );
  routes.get("/icons", icons.doc, credential, async (c) => {
    const { glyphs, colors } = await iconChoices();
    return icons.answer(c, { glyphs: [...glyphs], colors: [...colors] });
  });

  return routes;
}
