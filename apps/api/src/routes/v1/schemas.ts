import { z } from "zod";
import { ICON_COLORS, ICON_GLYPHS } from "../../services/book/icon-glyphs.js";
import {
  COMPARISONS,
  ORIGINS,
  TRUST_STATES,
  VIAS,
} from "../../db/schema/book.js";
import {
  PRINCIPAL_KINDS,
  QUERY_ORIGINS,
  QUERY_STATUSES,
} from "../../db/schema/queries.js";
import {
  THREAD_ELEMENT_KINDS,
  THREAD_KINDS,
  THREAD_ACCEPTED_VIA,
  THREAD_PRINCIPAL_KINDS,
  THREAD_STATUSES,
} from "../../db/schema/threads.js";
import { ICON_KINDS } from "../../services/book/icons.js";
import { anchor, iso, stamp } from "./adapter.js";

/*
 * The response schemas the route modules share. Each named one (`.meta({ id })`)
 * is a component of the OpenAPI document, written once here.
 */

const shift = {
  period: z.string(),
  comparison: z.enum(COMPARISONS),
  comparison_period: z.string().nullable(),
  currency: z.string().nullable(),
  custom_axes: z.record(z.string(), z.unknown()),
};
export const Shift = z.object(shift).meta({ id: "Shift" });
export const Dataset = anchor("dataset").meta({ id: "Dataset" });
export const Workspace = anchor("workspace").meta({ id: "Workspace" });
export const Measure = anchor("measure").meta({ id: "Measure" });
export const Table = anchor("table").meta({ id: "Table" });
export const Category = z
  .object({
    kind: z.literal("category"),
    id: z.string(),
    key: z.string(),
    path: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    icon: z.string().nullable(),
    position: z.number(),
  })
  .meta({ id: "Category" });
type Node = z.input<typeof Category> & {
  metric_count: number;
  children: Node[];
};
/** A category with the metrics in it the caller may see, and those of the categories below it, as a tree. */
export const CategoryNode: z.ZodType<Node, Node> = Category.extend({
  metric_count: z.number(),
  get children() {
    return z.array(CategoryNode);
  },
}).meta({ id: "CategoryNode" });
/** Who accepted an answer; `unknown` for one accepted before it was kept, null while none is. */
const AcceptedBy = {
  accepted_by_role: z
    .enum(["asker", "asker_own_reply", "curator", "other", "unknown"])
    .nullable()
    .describe(
      "Who accepted: the asker, the asker on their own reply, a curator, or someone else a policy allows.",
    ),
  accepted_by_kind: z
    .enum(THREAD_PRINCIPAL_KINDS)
    .nullable()
    .describe("A person, or a service_account (an agent)."),
  accepted_by_via: z
    .enum(THREAD_ACCEPTED_VIA)
    .nullable()
    .describe(
      "Where it was accepted from: browser, mcp (an agent), api or cli.",
    ),
};
export const Questions = {
  open_questions: z.number().optional(),
  accepted_answers: z
    .array(
      z.object({
        thread_id: z.string(),
        question: z.string().nullable(),
        answer: z.string(),
        excerpt_truncated: z.literal(true).optional(),
        answered_by: z.object({
          kind: z.enum(["person", "service_account"]),
          id: z.string(),
        }),
        ...AcceptedBy,
      }),
    )
    .optional(),
};
export const Metric = z
  .object({
    ...Questions,
    kind: z.literal("metric"),
    id: z.string(),
    name: z.string(),
    label: z.string(),
    icon: z.string().nullable(),
    definition: z.string(),
    aliases: z.array(z.string()).nullable(),
    when_to_use: z.string(),
    not_the_same_as: z.string().nullable(),
    grain_and_filters: z.string(),
    unit: z.string().nullable(),
    category_id: z.string().nullable(),
    category: Category.nullable(),
    owner: z.string().nullable(),
    trust_state: z.enum(TRUST_STATES),
    verified_by: z.string().nullable(),
    verified_by_name: z
      .string()
      .nullable()
      .describe(
        "The display name of whoever verified or approved it. Never an email.",
      ),
    verified_at: stamp.nullable(),
    origin: z.enum(ORIGINS),
    name_is_generated: z.boolean(),
    touched_at: stamp.nullable(),
    dismissed_at: stamp.nullable(),
    dismissed_reason: z.string().nullable(),
    created_at: stamp,
    updated_at: stamp,
    custom: z.record(z.string(), z.unknown()),
    failing_checks: z.array(
      z.object({
        check: z.string(),
        rule: z.string().describe("The id of the rule the sentence is about."),
        message: z.string(),
        other_labels: z
          .array(z.string())
          .optional()
          .describe(
            "The ten closest of the metrics the sentence counts, closest first. `GET /metrics/{name}/checks` lists them all.",
          ),
        other_metrics: z
          .array(
            z.object({
              key: z.string(),
              label: z.string(),
              datasets: z.array(z.string()),
            }),
          )
          .optional()
          .describe(
            "The key and up to three dataset names, among those you may describe, of the metrics those labels belong to, to choose between metrics of one label.",
          ),
      }),
    ),
    base_variants: z.array(
      z.object({
        kind: z.literal("variant"),
        id: z.string(),
        dataset: Dataset,
        workspace: Workspace,
        measure: Measure,
        measure_reference: z.string(),
        reads_selection: z.boolean(),
        selection_columns: z.array(z.string()),
        format_string: z.string().nullable(),
        period: z.string(),
      }),
    ),
    other_variants: z.array(z.object({ shift: Shift, count: z.number() })),
    terms: z.array(anchor("term")),
  })
  .meta({ id: "Metric" });
export const Variant = z
  .object({
    kind: z.literal("variant"),
    id: z.string(),
    metric: anchor("metric").extend({ label: z.string() }),
    table: Table,
    dataset: Dataset,
    workspace: Workspace,
    measure: Measure,
    measure_reference: z.string(),
    reads_selection: z.boolean(),
    selection_columns: z.array(z.string()),
    expression: z.string().nullable(),
    normalized_expression: z.string().nullable(),
    format_string: z.string().nullable(),
    display_folder: z.string().nullable(),
    description: z.string().nullable(),
    description_pbi: z.string().nullable(),
    assigned_by: z.enum(["sync", "curator"]),
    assigned_at: stamp,
    removed: z.boolean(),
    shift: Shift.extend({ shift_note: z.string().nullable() }),
  })
  .meta({ id: "Variant" });
export const Term = z
  .object({
    ...Questions,
    kind: z.literal("term"),
    id: z.string(),
    name: z.string(),
    icon: z.string().nullable(),
    type: z.enum(["dimension", "concept"]),
    definition: z.string(),
    aliases: z.array(z.string()).nullable(),
    not_the_same_as: z.string().nullable(),
    values: z.unknown(),
    owner: z.string().nullable(),
    trust_state: z.enum(TRUST_STATES),
    custom: z.record(z.string(), z.unknown()),
    columns: z.array(
      anchor("column").extend({
        data_type: z.string().nullable(),
        table: Table,
        dataset: Dataset,
        workspace: Workspace,
      }),
    ),
    metrics: z.array(
      anchor("metric").extend({
        label: z.string(),
        summary: z.string(),
        summary_truncated: z.literal(true).optional(),
        trust_state: z.enum(TRUST_STATES),
      }),
    ),
  })
  .meta({ id: "Term" });
export const IconSet = z
  .object({
    kind: z.enum(ICON_KINDS),
    id: z.string(),
    icon: z.string().nullable(),
  })
  .meta({ id: "IconSet" });
export const IconChoices = z
  .object({
    glyphs: z.array(z.enum(ICON_GLYPHS)).describe("The glyph names, Lucide's."),
    colors: z.array(z.enum(ICON_COLORS)),
  })
  .meta({ id: "IconChoices" });
export const Docs = z.object({
  element: z.object({ kind: z.string(), id: z.string(), name: z.string() }),
  when_to_use: z.string().nullable().optional(),
  owner: z.string().nullable().optional(),
  freshness: z.string().nullable().optional(),
  caveats: z.string().nullable().optional(),
  grain_and_filters: z.string().nullable().optional(),
  unit: z.string().nullable().optional(),
  blank_means: z.string().nullable().optional(),
  description: z.string().nullable(),
  description_pbi: z.string().nullable(),
  described_by: z.string().nullable(),
  described_at: stamp.nullable(),
  custom: z.record(z.string(), z.unknown()),
});
const columnTypes = [
  "number",
  "boolean",
  "datetime",
  "string",
  "null",
] as const;
const Columns = z.array(
  z.object({ name: z.string(), type: z.enum(columnTypes) }),
);
const Rows = z.array(z.array(z.unknown()));
export const Anchor = z
  .object({
    result_id: z.string(),
    query_id: z.string(),
    dataset: z.object({ id: z.string(), name: z.string() }),
    columns: Columns,
    row_count: z.number(),
    bytes: z.number(),
    truncated: z.boolean(),
    truncation_note: z.string().nullable(),
    preview: Rows,
    preview_note: z.string().nullable(),
    next_offset: z.number().nullable(),
    csv_url: z.string(),
    csv_url_expires_at: iso,
    expires_at: iso,
  })
  .meta({ id: "Anchor" });
export const Entry = z
  .object({
    kind: z.literal("query"),
    origin: z.enum(QUERY_ORIGINS),
    id: z.string(),
    at: iso,
    principal: z.object({
      kind: z.enum(PRINCIPAL_KINDS),
      id: z.string(),
    }),
    via: z.enum(VIAS),
    client_id: z.string().nullable(),
    dataset: z
      .object({
        kind: z.literal("dataset"),
        id: z.string(),
        name: z.string().nullable(),
      })
      .nullable(),
    workspace_id: z.string().nullable(),
    status: z.enum(QUERY_STATUSES),
    dax: z.string(),
    dax_cut: z.boolean(),
    purpose: z.string().nullable(),
    purpose_cut: z.boolean(),
    error: z.string().nullable(),
    row_count: z.number().nullable(),
    column_count: z.number().nullable(),
    duration_ms: z.number(),
    result_id: z.string().nullable(),
    measure_names: z.array(z.string()),
    metric_ids: z.array(z.string()),
  })
  .meta({ id: "Entry" });
export const ResultPage = z
  .object({
    result_id: z.string(),
    query_id: z.string(),
    columns: Columns,
    row_count: z.number(),
    offset: z.number(),
    rows: Rows,
    next_offset: z.number().nullable(),
    note: z.string().nullable(),
  })
  .meta({ id: "ResultPage" });
export const Link = z
  .object({ csv_url: z.string(), csv_url_expires_at: iso })
  .meta({ id: "Link" });
const Element = z.object({
  kind: z.enum(THREAD_ELEMENT_KINDS),
  id: z.string(),
});
const Author = z.object({
  kind: z.enum(THREAD_PRINCIPAL_KINDS),
  id: z.string(),
});
export const Thread = z
  .object({
    id: z.string(),
    kind: z.enum(THREAD_KINDS),
    title: z.string().nullable(),
    body: z.string(),
    status: z.enum(THREAD_STATUSES),
    accepted_reply_id: z.string().nullable(),
    ...AcceptedBy,
    created_at: stamp,
    updated_at: stamp,
    reply_count: z.number(),
    unread_replies: z.number(),
    upvote_count: z.number(),
    upvoted: z.boolean(),
    element: Element,
    author: Author,
  })
  .meta({ id: "Thread" });
export const Reply = z
  .object({
    id: z.string(),
    thread_id: z.string(),
    author: Author,
    body: z.string(),
    created_at: stamp,
    edited_at: stamp.nullable(),
  })
  .meta({ id: "Reply" });
