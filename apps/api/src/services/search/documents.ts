import { and, eq, inArray, isNull, not, or, type SQL, sql } from "drizzle-orm";
import type { Db } from "../../context.js";
import {
  category,
  metric,
  metricVariant,
  term,
  termColumn,
} from "../../db/schema/book.js";
import {
  powerbiApp,
  powerbiAppDataset,
  powerbiColumn,
  powerbiDataset,
  powerbiMeasure,
  powerbiTable,
  powerbiWorkspace,
} from "../../db/schema/mirror.js";
import { type SearchKind, searchDocument } from "../../db/schema/search.js";
import { anyOf } from "../access/plan.js";
import { piiColumn, piiMeasure } from "../pii/rules.js";

/*
 * One search_document per searchable element, rebuilt from the book and the
 * mirror. Metrics, variants, columns and terms get a search_text built for
 * meaning (the spec's Search section) and are embedded; datasets, tables and
 * categories are found by words alone. A removed or dismissed element has no
 * document, nor has anything of a dataset that is off, nor a column or
 * measure a PII rule marks, whoever reads.
 */

type Document = Omit<
  typeof searchDocument.$inferInsert,
  "search_tsv" | "embedding" | "embedding_model" | "embedding_hash"
>;

/**
 * A provider cuts an input at 8,192 tokens, and a term's values can be long.
 * A tokenizer makes at most one token of each UTF-8 byte, so 8,000 bytes stay
 * inside that in any language, where a count of characters would not (a CJK
 * character is three bytes and about one token).
 */
export const SEARCH_TEXT_MAX_BYTES = 8000;
const WRITE_BATCH = 500;
const CONTENT = [
  "kind",
  "element_id",
  "dataset_ids",
  "workspace_ids",
  "app_ids",
  "category_id",
  "trust_state",
  "custom",
  "name",
  "label",
  "summary",
  "search_text",
] as const satisfies readonly (keyof Document)[];

/** The text cut to SEARCH_TEXT_MAX_BYTES, on a character boundary. */
function cutToBytes(text: string): string {
  if (Buffer.byteLength(text) <= SEARCH_TEXT_MAX_BYTES) return text;
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    bytes += Buffer.byteLength(character);
    if (bytes > SEARCH_TEXT_MAX_BYTES) break;
    end += character.length;
  }
  return text.slice(0, end);
}

const lines = (...parts: (string | null | undefined)[]) =>
  cutToBytes(
    parts
      .filter((part) => part !== null && part !== undefined && part !== "")
      .join("\n"),
  );
const list = (items: readonly string[] | null) =>
  items === null || items.length === 0 ? null : items.join(", ");
const labelled = (label: string, value: string | null) =>
  value === null || value === "" ? null : `${label}: ${value}`;
const spaced = (name: string) => name.replaceAll("_", " ");

/** A term's values are any JSON; every string in it is words to find it by. */
function wordsOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) return value.map(wordsOf).join(", ");
  if (typeof value === "object" && value !== null)
    return Object.entries(value)
      .map(([key, each]) => `${key}: ${wordsOf(each)}`)
      .join(", ");
  return "";
}

type Dataset = {
  id: string;
  name: string;
  workspace_id: string;
  /** Null for a personal workspace: Power BI names it after its owner, a person. */
  workspace_name: string | null;
  description: string | null;
  when_to_use: string | null;
  owner: string | null;
  freshness: string | null;
  caveats: string | null;
  custom: Record<string, unknown>;
  app_ids: string[];
};

async function liveDatasets(db: Db): Promise<Map<string, Dataset>> {
  const rows = await db
    .select({
      id: powerbiDataset.id,
      name: powerbiDataset.name,
      workspace_id: powerbiDataset.workspace_id,
      // `personal` and `personal_group`, as the mirror spells Power BI's types.
      workspace_name: sql<
        string | null
      >`case when ${powerbiWorkspace.type} like 'personal%' then null else ${powerbiWorkspace.name} end`,
      description: sql<
        string | null
      >`coalesce(${powerbiDataset.description}, ${powerbiDataset.description_pbi})`,
      when_to_use: powerbiDataset.when_to_use,
      owner: powerbiDataset.owner,
      freshness: powerbiDataset.freshness,
      caveats: powerbiDataset.caveats,
      custom: powerbiDataset.custom,
    })
    .from(powerbiDataset)
    .innerJoin(
      powerbiWorkspace,
      eq(powerbiWorkspace.id, powerbiDataset.workspace_id),
    )
    .where(and(isNull(powerbiDataset.removed_at), powerbiDataset.enabled));
  const apps = await db
    .select({
      dataset_id: powerbiAppDataset.dataset_id,
      app_id: powerbiAppDataset.app_id,
    })
    .from(powerbiAppDataset)
    .innerJoin(powerbiApp, eq(powerbiApp.id, powerbiAppDataset.app_id))
    .where(isNull(powerbiApp.removed_at));
  const datasets = new Map(
    rows.map((row) => [row.id, { ...row, app_ids: [] as string[] }]),
  );
  for (const { dataset_id, app_id } of apps)
    datasets.get(dataset_id)?.app_ids.push(app_id);
  return datasets;
}

/** The datasets, their workspaces and their apps, each once and sorted: a list that followed the database's order would change a document, and its hash, for nothing. */
function reach(datasets: Dataset[], custom: Record<string, unknown>) {
  const unique = (ids: string[]) => [...new Set(ids)].sort();
  return {
    dataset_ids: unique(datasets.map((d) => d.id)),
    workspace_ids: unique(datasets.map((d) => d.workspace_id)),
    app_ids: unique(datasets.flatMap((d) => d.app_ids)),
    custom,
  };
}

/** The category's path by names, root first, from every category held in memory. */
async function categoryPaths(db: Db) {
  const all = await db.select().from(category);
  const byId = new Map(all.map((row) => [row.id, row]));
  const path = (id: string | null): string[] => {
    const row = id === null ? undefined : byId.get(id);
    return row === undefined ? [] : [...path(row.parent_id), row.name];
  };
  return { all, path };
}

type Shift = {
  period: string;
  comparison: string;
  comparison_period: string | null;
  currency: string | null;
  shift_note: string | null;
};

function shiftInWords(v: Shift): string {
  const parts = [v.period === "current" ? "current period" : spaced(v.period)];
  if (v.comparison !== "none")
    parts.push(
      `${spaced(v.comparison)} against ${spaced(v.comparison_period ?? "another period")}`,
    );
  if (v.currency !== null) parts.push(`in ${v.currency}`);
  if (v.shift_note !== null && v.shift_note !== "") parts.push(v.shift_note);
  return parts.join(", ");
}

/**
 * The book's own documents refer to each other (a category's name is in its
 * metrics' text, a metric's label in its variants'), and they are few, so
 * every run compares them all. `element_ids` narrows the mirror's.
 */
const BOOK_KINDS = [
  "metric",
  "variant",
  "term",
  "category",
] as const satisfies readonly SearchKind[];

/** The documents a run with `element_ids` looks at; undefined without them. */
export function inScope(ids: readonly string[] | undefined): SQL | undefined {
  return ids === undefined
    ? undefined
    : or(
        inArray(searchDocument.kind, BOOK_KINDS),
        anyOf(searchDocument.element_id, ids),
      );
}

/**
 * Every document the book and the mirror call for now, or the book's own and
 * those of the given mirror elements. Columns and tables, the biggest sets,
 * are narrowed in the query.
 */
export async function collectDocuments(
  db: Db,
  options: { element_ids?: readonly string[] } = {},
): Promise<Document[]> {
  const ids = options.element_ids;
  const only = (column: Parameters<typeof anyOf>[0]): SQL | undefined =>
    ids === undefined ? undefined : anyOf(column, ids);
  const datasets = await liveDatasets(db);
  const documents: Document[] = [];
  const wanted = ids === undefined ? null : new Set(ids);
  const emit = (doc: Document) => {
    if (
      wanted === null ||
      wanted.has(doc.element_id) ||
      (BOOK_KINDS as readonly string[]).includes(doc.kind)
    )
      documents.push(doc);
  };

  for (const d of datasets.values())
    emit({
      id: `dataset:${d.id}`,
      kind: "dataset",
      element_id: d.id,
      ...reach([d], d.custom),
      name: d.name,
      label: d.name,
      summary: d.description ?? "",
      search_text: lines(
        d.name,
        labelled("Workspace", d.workspace_name),
        d.description,
        d.when_to_use,
        d.owner,
        d.freshness,
        d.caveats,
      ),
    });

  const tables = await db
    .select()
    .from(powerbiTable)
    .where(and(isNull(powerbiTable.removed_at), only(powerbiTable.id)));
  for (const t of tables) {
    const dataset = datasets.get(t.dataset_id);
    if (dataset === undefined) continue;
    const description = t.description ?? t.description_pbi;
    emit({
      id: `table:${t.id}`,
      kind: "table",
      element_id: t.id,
      ...reach([dataset], t.custom),
      name: t.name,
      label: t.name,
      summary: description ?? "",
      search_text: lines(
        t.name,
        `Dataset: ${dataset.name}`,
        t.description,
        t.description_pbi,
        t.grain_and_filters,
        t.caveats,
      ),
    });
  }

  const { all: categories, path } = await categoryPaths(db);
  for (const c of categories)
    emit({
      id: `category:${c.id}`,
      kind: "category",
      element_id: c.id,
      ...reach([], {}),
      name: c.name,
      label: c.name,
      summary: c.description ?? "",
      search_text: lines(path(c.id).join(" / "), c.key, c.description),
    });

  const links = await db
    .select({
      term_id: termColumn.term_id,
      term_name: term.name,
      column_id: powerbiColumn.id,
      dataset_id: powerbiColumn.dataset_id,
    })
    .from(termColumn)
    .innerJoin(term, eq(term.id, termColumn.term_id))
    .innerJoin(powerbiColumn, eq(powerbiColumn.id, termColumn.column_id))
    .where(isNull(powerbiColumn.removed_at));
  const termsOfColumn = new Map<string, string[]>();
  const datasetsOfTerm = new Map<string, Dataset[]>();
  for (const link of links) {
    termsOfColumn.set(link.column_id, [
      ...(termsOfColumn.get(link.column_id) ?? []),
      link.term_name,
    ]);
    const dataset = datasets.get(link.dataset_id);
    if (dataset !== undefined)
      datasetsOfTerm.set(link.term_id, [
        ...(datasetsOfTerm.get(link.term_id) ?? []),
        dataset,
      ]);
  }

  const columns = await db
    .select({ column: powerbiColumn, table_name: powerbiTable.name })
    .from(powerbiColumn)
    .innerJoin(powerbiTable, eq(powerbiTable.id, powerbiColumn.table_id))
    .where(
      and(
        isNull(powerbiColumn.removed_at),
        not(piiColumn(powerbiColumn, powerbiTable)),
        only(powerbiColumn.id),
      ),
    );
  for (const { column: c, table_name } of columns) {
    const dataset = datasets.get(c.dataset_id);
    if (dataset === undefined) continue;
    const name = `${table_name}[${c.name}]`;
    emit({
      id: `column:${c.id}`,
      kind: "column",
      element_id: c.id,
      ...reach([dataset], c.custom),
      name,
      label: name,
      summary: c.description ?? c.description_pbi ?? "",
      search_text: lines(
        name,
        `Dataset: ${dataset.name}`,
        labelled("Data type", c.data_type),
        c.description,
        c.description_pbi,
        c.unit,
        c.blank_means,
        labelled("Term", list(termsOfColumn.get(c.id)?.sort() ?? null)),
      ),
    });
  }

  for (const t of await db.select().from(term))
    emit({
      id: `term:${t.id}`,
      kind: "term",
      element_id: t.id,
      ...reach(datasetsOfTerm.get(t.id) ?? [], t.custom),
      trust_state: t.trust_state,
      name: t.name,
      label: t.name,
      summary: t.definition,
      search_text: lines(
        t.name,
        labelled("Also called", list(t.aliases)),
        t.definition,
        labelled("Values", wordsOf(t.values)),
      ),
    });

  const metrics = await db
    .select()
    .from(metric)
    .where(isNull(metric.dismissed_at));
  const variants = await db
    .select({
      variant: metricVariant,
      measure: powerbiMeasure,
      table_name: powerbiTable.name,
      pii: piiMeasure(powerbiMeasure),
    })
    .from(metricVariant)
    .innerJoin(powerbiMeasure, eq(powerbiMeasure.id, metricVariant.measure_id))
    .innerJoin(powerbiTable, eq(powerbiTable.id, powerbiMeasure.table_id));
  const liveMetrics = new Map(metrics.map((m) => [m.id, m]));
  // A variant is live while its measure and its dataset are, and no PII rule
  // marks the measure.
  const liveVariants = new Map<string, typeof variants>();
  const withVariants = new Set<string>();
  for (const row of variants) {
    const id = row.variant.metric_id;
    withVariants.add(id);
    if (
      row.pii ||
      row.measure.removed_at !== null ||
      !datasets.has(row.measure.dataset_id)
    )
      continue;
    liveVariants.set(id, [...(liveVariants.get(id) ?? []), row]);
  }

  for (const m of metrics) {
    const held = liveVariants.get(m.id) ?? [];
    // A metric whose variants are all gone has nothing a reader could reach,
    // and a document with no datasets would pass every dataset filter.
    if (held.length === 0 && withVariants.has(m.id)) continue;
    const reached = held.flatMap((row) => {
      const dataset = datasets.get(row.measure.dataset_id);
      return dataset === undefined ? [] : [dataset];
    });
    emit({
      id: `metric:${m.id}`,
      kind: "metric",
      element_id: m.id,
      ...reach(reached, m.custom),
      category_id: m.category_id,
      trust_state: m.trust_state,
      name: m.name,
      label: m.label,
      summary: m.definition,
      search_text: lines(
        m.label,
        m.name,
        m.definition,
        labelled("Also called", list(m.aliases)),
        labelled("When to use", m.when_to_use),
        labelled("Grain and filters", m.grain_and_filters),
        labelled("Category", path(m.category_id).join(" / ")),
      ),
    });
  }

  for (const { variant: v, measure, table_name } of [
    ...liveVariants.values(),
  ].flat()) {
    const parent = liveMetrics.get(v.metric_id);
    const dataset = datasets.get(measure.dataset_id);
    if (parent === undefined || dataset === undefined) continue;
    const shift = shiftInWords(v);
    emit({
      id: `variant:${v.id}`,
      kind: "variant",
      element_id: v.id,
      ...reach([dataset], measure.custom),
      category_id: parent.category_id,
      trust_state: parent.trust_state,
      name: measure.name,
      label: parent.label,
      summary: shift,
      search_text: lines(
        measure.name,
        `Dataset: ${dataset.name}${dataset.workspace_name === null ? "" : ` (workspace ${dataset.workspace_name})`}`,
        `Table: ${table_name}`,
        labelled("Display folder", measure.display_folder),
        measure.description,
        measure.description_pbi,
        `Metric: ${parent.label}`,
        `Shift: ${shift}`,
      ),
    });
  }
  return documents;
}

/**
 * Brings search_document to what collectDocuments says: new and changed
 * documents written, documents of removed or dismissed elements deleted. A
 * row that is already right is not touched, so its embedding and its
 * updated_at stay. With `element_ids`, the mirror's documents are compared
 * for those elements only (see BOOK_KINDS). Returns how many documents there are, and how many were written
 * and deleted.
 */
export async function buildDocuments(
  db: Db,
  options: { element_ids?: readonly string[] } = {},
): Promise<{ documents: number; written: number; deleted: number }> {
  const documents = await collectDocuments(db, options);
  return db.transaction(async (tx) => {
    let written = 0;
    for (let at = 0; at < documents.length; at += WRITE_BATCH) {
      const changed = await tx
        .insert(searchDocument)
        .values(documents.slice(at, at + WRITE_BATCH))
        .onConflictDoUpdate({
          target: searchDocument.id,
          set: {
            ...Object.fromEntries(
              CONTENT.map((c) => [c, sql`excluded.${sql.identifier(c)}`]),
            ),
            updated_at: sql`now()`,
          },
          setWhere: sql.join(
            CONTENT.map(
              (c) =>
                sql`search_document.${sql.identifier(c)} is distinct from excluded.${sql.identifier(c)}`,
            ),
            sql` or `,
          ),
        })
        .returning({ id: searchDocument.id });
      written += changed.length;
    }
    const kept = new Set(documents.map((doc) => doc.id));
    const held = await tx
      .select({ id: searchDocument.id })
      .from(searchDocument)
      .where(inScope(options.element_ids));
    const gone = held.map((row) => row.id).filter((id) => !kept.has(id));
    for (let at = 0; at < gone.length; at += WRITE_BATCH * 2)
      await tx
        .delete(searchDocument)
        .where(anyOf(searchDocument.id, gone.slice(at, at + WRITE_BATCH * 2)));
    return { documents: documents.length, written, deleted: gone.length };
  });
}
