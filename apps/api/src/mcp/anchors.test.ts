import { describe, expect, it } from "vitest";
import * as anchors from "./anchors.js";

const id = "00000000-0000-4000-8000-000000000001";
const name = "n".repeat(40);
const parent = { kind: "dataset", id, name };
const long = "word ".repeat(4000);
const baseShift = {
  period: "current",
  comparison: "none",
  comparison_period: "previous_year",
  currency: null,
  custom_axes: {},
  shift_note: "",
};
const aliases = Array.from({ length: 6 }, () => "a".repeat(16));
const filled = (keys: string, value: unknown) =>
  Object.fromEntries(keys.split(" ").map((key) => [key, value]));
const row = {
  ...filled(
    "name label display_folder path title author_name from_table from_column to_table to_column",
    name,
  ),
  ...filled(
    "summary description description_pbi when_to_use blank_means excerpt question missing purpose dax error",
    long,
  ),
  ...filled("dataset measure table workspace metric", parent),
  ...filled(
    "is_hidden removed pii reads_selection has_row_level_security upvoted",
    false,
  ),
  ...filled(
    "dataset_count column_count metric_count reply_count row_count duration_ms",
    1,
  ),
  ...filled("upvote_count unread_replies", 0),
  id,
  kind: "metric",
  unit: "money",
  category: { path: name },
  trust_state: "human_verified",
  aliases,
  measure_reference: `[${name}]`,
  data_type: "String",
  column_type: "data",
  terms: [parent],
  shift: baseShift,
  reached_through: [
    { kind: "workspace", id, name },
    { kind: "share", id, name },
  ],
  datasets: [parent],
  type: "dimension",
  children: [],
  match: "words",
  status: "succeeded",
  element: { kind: "metric", id },
  created_at: "2026-11-14T00:00:00.000Z",
  at: "2026-11-14T00:00:00.000Z",
  principal: { kind: "person", id },
  via: "mcp",
  outcome: "answered",
  gaps: ["other"],
  elements: [{ kind: "metric", id }],
  result_id: id,
  metric_ids: [id],
  cardinality: "many_to_one",
  cross_filtering_behavior: "one_direction",
  is_active: true,
  selection_columns: [],
  unlisted: "must never escape",
};
// prettier-ignore
const cases = [
  ["metricAnchor", "id name label summary summary_truncated unit category trust_state dataset_count aliases aliases_truncated", 650],
  ["variantAnchor", "id dataset measure measure_reference", 700],
  ["columnAnchor", "id name table data_type display_folder description description_truncated description_pbi description_pbi_truncated unit blank_means blank_means_truncated terms", 1050],
  ["measureAnchor", "id name table display_folder description description_truncated description_pbi description_pbi_truncated metric", 1000],
  ["datasetAnchor", "id name workspace reached_through description description_truncated when_to_use when_to_use_truncated", 600],
  ["workspaceAnchor", "id name dataset_count description description_truncated", 300],
  ["appAnchor", "id name workspace description description_truncated datasets", 450],
  ["termAnchor", "id name type summary summary_truncated trust_state column_count aliases aliases_truncated", 550],
  ["categoryAnchor", "path name metric_count description description_truncated", 400],
  ["searchAnchor", "kind id name label summary summary_truncated dataset trust_state match category aliases aliases_truncated", 750],
  ["threadAnchor", "id kind title status excerpt excerpt_truncated element author_name created_at reply_count", 650],
  ["requestAnchor", "id at principal via question question_truncated outcome gaps missing missing_truncated elements", 800],
  ["queryAnchor", "id at principal via dataset status purpose purpose_truncated dax dax_truncated error error_truncated row_count duration_ms result_id metric_ids", 1350],
  ["relationshipAnchor", "from_table from_column to_table to_column cardinality", 350],
] as const;

describe("connector anchors", () => {
  it.each(cases)("%s keeps only its fields in order", (key, fields) => {
    const input =
      key === "searchAnchor"
        ? { ...row, path: [{ kind: "category", key: name, name }] }
        : row;
    expect(Object.keys(anchors[key](input))).toEqual(fields.split(" "));
  });
  it.each(cases)("%s omits empty values and default flags", (key) => {
    expect(
      anchors[key]({
        ...filled(
          "is_hidden removed pii reads_selection has_row_level_security upvoted",
          false,
        ),
        is_active: true,
        column_type: "data",
        column_count: 0,
        summary: null,
        description: "",
        aliases: [],
        custom: {},
      }),
    ).toEqual({});
  });
  it.each(cases)(
    "%s matches its fixed ASCII row size rounded up to 50 bytes",
    (key, _fields, target) => {
      const fixed = {
        ...row,
        ...filled(
          "is_hidden removed pii reads_selection has_row_level_security upvoted",
          true,
        ),
        is_active: false,
        column_type: "calculated",
        cross_filtering_behavior: "both_directions",
        selection_columns: [name],
        upvote_count: 1,
        unread_replies: 1,
        shift: {
          period: "previous_year",
          comparison: "ratio",
          comparison_period: "previous_year",
          currency: "EUR",
          custom_axes: { channel: "online" },
          shift_note: "s".repeat(160),
        },
        summary: "s".repeat(240),
        description: "d".repeat(key === "categoryAnchor" ? 240 : 160),
        description_pbi: "d".repeat(160),
        unit: key === "columnAnchor" ? "u".repeat(160) : "money",
        when_to_use: "w".repeat(160),
        blank_means: "b".repeat(160),
        excerpt: "e".repeat(240),
        question: "q".repeat(240),
        missing: "m".repeat(240),
        purpose: "p".repeat(240),
        error: "e".repeat(240),
        dax: "x".repeat(400),
        aliases: row.aliases.slice(0, 5),
        path:
          key === "searchAnchor"
            ? [{ kind: "category", key: name, name }]
            : name,
      };
      const bytes = Buffer.byteLength(
        JSON.stringify(anchors[key](fixed)),
        "utf8",
      );
      expect(Math.ceil(bytes / 50) * 50).toBe(target);
    },
  );
  it("cuts a long unit, blank_means and when_to_use in list answers", () => {
    const cut = anchors.columnAnchor({ unit: long, blank_means: long });
    expect(cut).toMatchObject({
      unit_truncated: true,
      blank_means_truncated: true,
    });
    expect((cut.unit as string).length).toBeLessThan(200);
    expect((cut.blank_means as string).length).toBeLessThan(200);
    const dataset = anchors.datasetAnchor({ when_to_use: long });
    expect(dataset.when_to_use_truncated).toBe(true);
    expect((dataset.when_to_use as string).length).toBeLessThan(200);
  });
  it("keeps the full category path on nested metric and category hits", () => {
    const sales = { kind: "category", key: "sales", name: "Sales" };
    const orders = { kind: "category", key: "orders", name: "Orders" };
    expect(
      anchors.searchAnchor({ kind: "metric", path: [sales, orders] }),
    ).toEqual({ kind: "metric", category: "sales/orders" });
    expect(
      anchors.searchAnchor({ kind: "category", key: "orders", path: [sales] }),
    ).toEqual({ kind: "category", category: "sales/orders" });
  });
  it("keeps nonempty dataset custom fields", () => {
    expect(
      anchors.datasetDetail({ custom: { owner_team: "finance" } }),
    ).toEqual({
      custom: { owner_team: "finance" },
      tables: [],
      relationships: [],
    });
  });
  it("leaves out variant fields the service never returns", () => {
    expect(
      anchors.variantDetail({
        is_hidden: true,
        period: "previous_year",
        comparison: "ratio",
        comparison_period: "previous_year",
        currency: "EUR",
        custom_axes: { channel: "online" },
        shift_note: long,
        pii: true,
      }),
    ).toEqual({});
  });
  it("keeps service truncation and each nondefault flag", () => {
    expect(
      anchors.metricAnchor({ summary: "short", summary_truncated: true }),
    ).toEqual({ summary: "short", summary_truncated: true });
    expect(
      anchors.columnAnchor({
        is_hidden: true,
        pii: true,
        column_type: "calculated",
      }),
    ).toEqual({ column_type: "calculated", is_hidden: true, pii: true });
    expect(
      anchors.relationshipAnchor({
        is_active: false,
        cross_filtering_behavior: "both_directions",
      }),
    ).toEqual({
      cross_filtering_behavior: "both_directions",
      is_active: false,
    });
  });
  it.each([
    [anchors.columnAnchor, "table"],
    [anchors.measureAnchor, "table"],
    [anchors.variantAnchor, "dataset"],
    [anchors.datasetAnchor, "workspace"],
  ] as const)("omits the filtered parent %s", (anchor, field) => {
    expect(anchor(row, { [field]: name })).not.toHaveProperty(field);
    expect(anchors.variantAnchor(row)).not.toHaveProperty("metric");
  });
  it("keeps only shifts away from the base and cuts notes", () => {
    const shiftNote: unknown = expect.any(String);
    expect(anchors.variantAnchor(row)).not.toHaveProperty("shift");
    expect(
      anchors.variantAnchor({
        shift: {
          ...row.shift,
          period: "previous_year",
          comparison: "ratio",
          custom_axes: { channel: "online" },
          shift_note: long,
        },
      }),
    ).toEqual({
      shift: {
        period: "previous_year",
        comparison: "ratio",
        comparison_period: "previous_year",
        custom_axes: { channel: "online" },
        shift_note: shiftNote,
        shift_note_truncated: true,
      },
    });
  });
  it("shortens parents and reach without shortening names", () => {
    expect(anchors.datasetAnchor(row)).toMatchObject({
      workspace: name,
      reached_through: ["workspace", "share"],
    });
    expect(anchors.variantAnchor(row)).toMatchObject({
      dataset: { id, name },
      measure: name,
    });
    expect(anchors.columnAnchor({ name: long })).toEqual({ name: long });
  });
  it.each(["tables", "relationships"])(
    "keeps empty %s in dataset details",
    (field) => {
      const answer = anchors.datasetDetail({
        id,
        tables: [],
        relationships: [],
        apps: [],
        date_tables: [],
      });
      expect(answer[field]).toEqual([]);
      expect(Object.keys(answer)).toEqual(["id", "tables", "relationships"]);
    },
  );
  it("keeps empty base_variants in metric details", () => {
    const answer = anchors.metricDetail({
      id,
      base_variants: [],
      other_variants: [],
      failing_checks: [],
      aliases: [],
    });
    expect(answer).toEqual({ id, base_variants: [] });
    expect(Object.keys(answer)).toEqual(["id", "base_variants"]);
  });
  it("shapes dataset details and keeps relationships last", () => {
    const answer = anchors.datasetDetail({
      ...row,
      apps: [parent],
      freshness: name,
      caveats: name,
      tables: [
        {
          ...row,
          kind: "fact",
          grain_and_filters: name,
          column_names: [name],
        },
      ],
      relationships: [row],
      date_tables: [{ table: name, column: name, joined_by: 1 }],
      custom: {},
    });
    expect(Object.keys(answer)).toEqual(
      "id name workspace apps description description_pbi when_to_use freshness caveats date_tables tables relationships".split(
        " ",
      ),
    );
    expect(answer.tables).toEqual([
      {
        ...anchors.columnAnchor({
          name,
          description: long,
          description_pbi: long,
        }),
        kind: "fact",
        grain_and_filters: name,
        column_count: 1,
        column_names: [name],
      },
    ]);
  });
  it("shapes metric, variant and term details with measures before text", () => {
    const metric = anchors.metricDetail({
      ...row,
      definition: long,
      base_variants: [row],
      other_variants: [],
      failing_checks: [],
      created_at: row.at,
    });
    expect(Object.keys(metric).slice(0, 5)).toEqual(
      "id name label trust_state base_variants".split(" "),
    );
    expect(metric.definition).toBe(long);
    expect(metric).not.toHaveProperty("created_at");
    const variant = anchors.variantDetail({
      ...row,
      expression: long,
      normalized_expression: long,
      assigned_by: "sync",
    });
    expect(variant.expression).toBe(long);
    expect(variant).not.toHaveProperty("normalized_expression");
    expect(variant).not.toHaveProperty("assigned_by");
    expect(anchors.termDetail({ ...row, definition: long })).toMatchObject({
      definition: long,
      aliases_truncated: true,
    });
    expect(anchors.termDetail({ custom: {}, values: [], owner: null })).toEqual(
      {},
    );
  });
});
