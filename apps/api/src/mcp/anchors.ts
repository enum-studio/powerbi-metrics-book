import { excerpt } from "../services/text.js";

type Row = Record<string, unknown>;
type Input = { table?: string; dataset?: string; workspace?: string };
const object = (value: unknown): Row =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
const rows = (value: unknown): Row[] =>
  Array.isArray(value) ? value.map(object) : [];
const named = (value: unknown) =>
  typeof value === "string" ? value : object(value).name;
const dataset = (value: unknown) => keep(object(value), "id name");

/** Only named fields may reach an answer. Empty values and default flags carry no information. */
function keep(
  row: Row,
  fields: string,
  limits: Record<string, number> = {},
  emptyLists: string[] = [],
): Row {
  const answer: Row = {};
  for (const field of fields.split(" ")) {
    let value = row[field];
    if (
      [
        "is_hidden",
        "removed",
        "pii",
        "reads_selection",
        "has_row_level_security",
        "upvoted",
      ].includes(field) &&
      value !== true
    )
      continue;
    if (field === "is_active" && value !== false) continue;
    if (field === "column_type" && value === "data") continue;
    if (["upvote_count", "unread_replies"].includes(field) && value === 0)
      continue;
    if (
      Array.isArray(value) &&
      value.length === 0 &&
      emptyLists.includes(field)
    ) {
      answer[field] = value;
      continue;
    }
    if (
      value === undefined ||
      value === null ||
      value === "" ||
      (Array.isArray(value) && value.length === 0) ||
      (typeof value === "object" &&
        !(value instanceof Date) &&
        Object.keys(value).length === 0)
    )
      continue;
    const limit = limits[field];
    const cut =
      typeof value === "string" && limit !== undefined
        ? excerpt(value, limit)
        : null;
    if (cut !== null) value = cut.text;
    if (field === "aliases" && Array.isArray(value)) value = value.slice(0, 5);
    answer[field] = value;
    if (
      cut?.truncated === true ||
      row[`${field}_truncated`] === true ||
      row[`${field}_cut`] === true ||
      (field === "aliases" &&
        Array.isArray(row.aliases) &&
        row.aliases.length > 5)
    )
      answer[`${field}_truncated`] = true;
  }
  return answer;
}
const descriptions = { description: 160, description_pbi: 160 };
const parents = (row: Row, input: Input = {}) => ({
  ...row,
  dataset: input.dataset === undefined ? dataset(row.dataset) : undefined,
  workspace: input.workspace === undefined ? named(row.workspace) : undefined,
  table: input.table === undefined ? named(row.table) : undefined,
  measure: named(row.measure),
  metric: named(row.metric),
  category:
    typeof row.category === "string" ? row.category : object(row.category).path,
  shift: shift(row.shift),
  terms: rows(row.terms).map(named),
  datasets: rows(row.datasets).map(dataset),
  reached_through: rows(row.reached_through).map((reach) =>
    reach.kind === "app" ? `app: ${String(reach.name)}` : reach.kind,
  ),
});

function shift(value: unknown): Row {
  const row = object(value);
  return keep(
    {
      ...row,
      period: row.period === "current" ? undefined : row.period,
      comparison: row.comparison === "none" ? undefined : row.comparison,
      comparison_period:
        row.comparison === "none" ? undefined : row.comparison_period,
    },
    "period comparison comparison_period currency custom_axes shift_note",
    { shift_note: 160 },
  );
}
export const metricAnchor = (row: Row): Row =>
  keep(
    parents(row),
    "id name label summary unit category trust_state dataset_count aliases",
    { summary: 240 },
  );
export const variantAnchor = (row: Row, input: Input = {}): Row =>
  keep(
    parents(row, input),
    "id dataset measure measure_reference shift reads_selection selection_columns",
  );
export const columnAnchor = (row: Row, input: Input = {}): Row =>
  keep(
    parents(row, input),
    "id name table data_type column_type is_hidden display_folder description description_pbi terms pii",
    descriptions,
  );
export const measureAnchor = (row: Row, input: Input = {}): Row =>
  keep(
    parents(row, input),
    "id name table display_folder is_hidden description description_pbi metric shift pii",
    descriptions,
  );
export const datasetAnchor = (row: Row, input: Input = {}): Row =>
  keep(
    parents(row, input),
    "id name workspace reached_through has_row_level_security description removed",
    descriptions,
  );
export const workspaceAnchor = (row: Row): Row =>
  keep(row, "id name dataset_count description", descriptions);
export const appAnchor = (row: Row): Row =>
  keep(parents(row), "id name workspace description datasets", descriptions);
export const termAnchor = (row: Row): Row =>
  keep(
    {
      ...row,
      column_count: row.column_count === 0 ? undefined : row.column_count,
    },
    "id name type summary trust_state column_count aliases",
    { summary: 240 },
  );
export const categoryAnchor = (row: Row): Row =>
  keep(
    { ...row, children: rows(row.children).map(categoryAnchor) },
    "path name metric_count description children",
    { description: 240 },
  );
export function searchAnchor(row: Row): Row {
  const path = rows(row.path);
  return keep(
    {
      ...parents(row),
      kind: row.kind,
      category:
        row.kind === "category"
          ? row.key
          : path.filter((step) => step.kind === "category").at(-1)?.key,
      table: path.find((step) => step.kind === "table")?.name,
      display_folder: path
        .filter((step) => step.kind === "folder")
        .map((step) => step.name)
        .join("\\"),
      metric: row.kind === "variant" ? named(row.metric) : undefined,
      aliases: row.kind === "metric" ? row.aliases : undefined,
    },
    "kind id name label summary dataset trust_state match category table display_folder metric aliases",
    { summary: 240 },
  );
}
export const threadAnchor = (row: Row): Row =>
  keep(
    row,
    "id kind title status excerpt element author_name created_at reply_count upvote_count unread_replies upvoted",
    { excerpt: 240 },
  );
export const requestAnchor = (row: Row): Row =>
  keep(row, "id at principal via question outcome gaps missing elements", {
    question: 240,
    missing: 240,
  });
export const queryAnchor = (row: Row): Row =>
  keep(
    parents(row),
    "id at principal via dataset status purpose dax error row_count duration_ms result_id metric_ids",
    { purpose: 240, dax: 400, error: 240 },
  );
export const relationshipAnchor = (row: Row): Row =>
  keep(
    {
      ...row,
      cross_filtering_behavior:
        row.cross_filtering_behavior === "one_direction"
          ? undefined
          : row.cross_filtering_behavior,
    },
    "from_table from_column to_table to_column cardinality cross_filtering_behavior is_active",
  );
export const datasetDetail = (row: Row): Row =>
  keep(
    {
      ...parents(row),
      apps: rows(row.apps).map(named),
      tables: rows(row.tables).map((table) =>
        keep(
          table,
          "name kind is_hidden column_count measure_count description description_pbi pii column_names",
          descriptions,
        ),
      ),
      relationships: rows(row.relationships).map(relationshipAnchor),
    },
    "id name workspace apps has_row_level_security description description_pbi schema_error synced_at pii_hidden open_questions accepted_answers relationships_note date_tables tables relationships",
    {},
    ["tables", "relationships"],
  );
const baseVariant = (row: Row): Row =>
  keep(
    {
      ...parents(row),
      period: row.period === "current" ? undefined : row.period,
    },
    "id dataset measure measure_reference format_string reads_selection selection_columns period",
  );
export const metricDetail = (row: Row): Row =>
  keep(
    {
      ...parents(row),
      base_variants: rows(row.base_variants).map(baseVariant),
      other_variants: rows(row.other_variants).map((other) =>
        keep({ shift: shift(other.shift), count: other.count }, "shift count"),
      ),
    },
    "id name label trust_state base_variants other_variants failing_checks definition aliases when_to_use not_the_same_as grain_and_filters unit category owner verified_by_name verified_at dismissed_at dismissed_reason custom terms open_questions accepted_answers",
    {},
    ["base_variants"],
  );
export const variantDetail = (row: Row): Row =>
  keep(
    parents(row),
    "id dataset workspace measure measure_reference reads_selection selection_columns metric table expression format_string display_folder is_hidden description description_pbi period comparison comparison_period currency custom_axes shift_note shift pii",
    { shift_note: 160 },
  );
export const termDetail = (row: Row): Row =>
  keep(
    {
      ...row,
      columns: rows(row.columns).map((column) =>
        keep(parents(column), "id name data_type table dataset workspace"),
      ),
      metrics: rows(row.metrics).map(metricAnchor),
    },
    "id name icon type definition aliases not_the_same_as values owner trust_state custom columns metrics open_questions accepted_answers",
  );

/** The envelope belongs to the service, including absent first-page totals. */
export function anchorPage<T extends { items: Row[] }>(
  page: T,
  anchor: (row: Row) => Row,
) {
  return { ...page, items: page.items.map(anchor) };
}
