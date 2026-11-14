import {
  and,
  asc,
  count,
  eq,
  exists,
  getTableColumns,
  inArray,
  isNull,
  not,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { Db, ServiceContext } from "../../context.js";
import {
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
  powerbiRelationship,
  powerbiTable,
  powerbiWorkspace,
} from "../../db/schema/mirror.js";
import { NO_SUCH_DATASET, ServiceError } from "../../errors.js";
import type { Principal } from "../../principal.js";
import { anyOf } from "../access/plan.js";
import {
  piiColumn,
  piiColumnNamed,
  piiMeasure,
  piiTableNamed,
  readsPii,
} from "../pii/rules.js";
import { openQuestionsFor } from "../threads/open-questions.js";
import { ensureModelDetails, withListed } from "./info-views.js";

/*
 * What agents read of the mirror. Every list and every lookup puts the
 * caller's describable datasets in its WHERE, so a dataset the caller may not
 * describe is absent from a list and answers a lookup like a missing one.
 * Removed items (the sync saw them go) are left out unless `removed` is true.
 */

export type Ref = {
  kind: "workspace" | "app" | "dataset" | "table";
  id: string;
  name: string;
};
/** How a caller reaches a dataset; a share names the dataset itself. */
export type Reach = {
  kind: "workspace" | "app" | "share";
  id: string;
  name: string;
};

export const ref = <K extends string>(kind: K, id: string, name: string) => ({
  kind,
  id,
  name,
});
export type Page<T> = {
  items: T[];
  next_cursor: string | null;
  total?: number;
};
/** `cursor` is the `next_cursor` of the page before. */
type Paging = { cursor?: string; limit?: number; removed?: boolean };

const PAGE_SIZE = 100;
const PAGE_MAX = 500;

export const looksLikeId = (text: string) => z.guid().safeParse(text).success;

/** A reference is an id, or else a name. */
export const byIdOrName = (
  target: { id: PgColumn; name: PgColumn },
  reference: string,
): SQL =>
  looksLikeId(reference)
    ? eq(target.id, reference)
    : eq(target.name, reference);

const live = (
  target: { removed_at: PgColumn },
  removed: boolean | undefined,
) => (removed === true ? undefined : isNull(target.removed_at));

export const startsWith = (column: PgColumn, prefix: string | undefined) =>
  prefix === undefined
    ? undefined
    : sql`starts_with(lower(${column}), ${prefix.toLowerCase()})`;

export const containsName = (
  column: SQL | PgColumn,
  value: string | undefined,
) =>
  value === undefined
    ? undefined
    : sql`replace(${column}, '_', ' ') ilike ${`%${escapeLike(value.replaceAll("_", " "))}%`}`;

export const aliasContainsName = (
  aliases: PgColumn,
  value: string | undefined,
) =>
  value === undefined
    ? undefined
    : sql`exists (select 1 from unnest(${aliases}) alias where ${containsName(sql`alias`, value)})`;

/** Leaves out a measure that is PII, for a caller who may not read PII. */
export const unlessPii = (hides: boolean) =>
  hides ? not(piiMeasure(powerbiMeasure)) : undefined;

/**
 * A metric is visible when one of its variants is on a measure in a dataset the
 * caller may describe (and, for a caller who may not read PII, not PII), or
 * when it has none.
 */
export function visibleMetric(db: Db, allowed: SQL, hidesPii: boolean): SQL {
  const variants = db
    .select({ one: sql`1` })
    .from(metricVariant)
    .where(eq(metricVariant.metric_id, metric.id));
  const reachable = db
    .select({ one: sql`1` })
    .from(metricVariant)
    .innerJoin(powerbiMeasure, eq(powerbiMeasure.id, metricVariant.measure_id))
    .innerJoin(powerbiDataset, eq(powerbiDataset.id, powerbiMeasure.dataset_id))
    .where(
      and(eq(metricVariant.metric_id, metric.id), allowed, unlessPii(hidesPii)),
    );
  return sql`(${notExists(variants)} or ${exists(reachable)})`;
}

/** Our description wins over Power BI's where both exist. */
const described = (ours: string | null, powerbi: string | null) =>
  ours ?? powerbi;

/**
 * Lists run in the order of their name columns and then id, or the reverse
 * with `descending`. The cursor is the keyset of the last item given, so the
 * next page is a comparison against those values and no lookup: it answers alike for a
 * row that is hidden, gone or never was. A name is text unless `name` says
 * what else a list's key is (a timestamp), so a forged cursor is refused
 * here and never reaches the comparison.
 */
const textName = z.string().refine((name) => !name.includes("\0"));

export type Keyset = { descending?: boolean; name?: z.ZodType<string> };

const encodeCursor = (last: { names: string[]; id: string }) =>
  Buffer.from(JSON.stringify([...last.names, last.id])).toString("base64url");

/** `name` may be several columns, for a list ordered by each in turn before its id. */
export function afterCursor(
  source: { name: PgColumn | PgColumn[]; id: PgColumn },
  cursor: string | undefined,
  keyset: Keyset = {},
): SQL | undefined {
  if (cursor === undefined) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  const columns = Array.isArray(source.name) ? source.name : [source.name];
  const name = keyset.name ?? textName;
  const key = z
    .array(z.unknown())
    .length(columns.length + 1)
    .safeParse(decoded);
  const names = key.success
    ? key.data.slice(0, -1).map((part) => name.safeParse(part))
    : [];
  const id = z.guid().safeParse(key.data?.at(-1));
  if (!key.success || !id.success || names.some((part) => !part.success)) {
    throw new ServiceError(
      "invalid",
      "That cursor is not one a list gave. Ask again without it.",
    );
  }
  const after = keyset.descending === true ? sql`<` : sql`>`;
  const values = names.map((part) => sql`${part.data}`);
  return sql`(${sql.join([...columns, source.id], sql`, `)}) ${after} (${sql.join(values, sql`, `)}, ${id.data}::uuid)`;
}

export const sizeOf = (limit: number | undefined) =>
  Math.min(Math.max(limit ?? PAGE_SIZE, 1), PAGE_MAX);

/** `rows` was read one longer than `limit`: the extra one only says there is more. */
export function pageOf<T extends { id: string; name: string }>(
  rows: T[],
  limit: number,
): Page<T> {
  return pageBy(rows, limit, (row) => row.name);
}

/** The same for a list ordered by something else: `nameOf` gives the key `afterCursor` compares. */
export function pageBy<T extends { id: string }>(
  rows: T[],
  limit: number,
  nameOf: (row: T) => string | string[],
): Page<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    next_cursor:
      rows.length > limit && last !== undefined
        ? encodeCursor({ names: [nameOf(last)].flat(), id: last.id })
        : null,
  };
}

const listOf = (principal: Principal, name: string): string[] => {
  const list = principal.attributes[name];
  if (list === undefined) {
    throw new Error(`${principal.kind} ${principal.id} has no ${name}`);
  }
  return list;
};

/**
 * How this caller reaches the dataset, from its own Power BI lists: the
 * workspace when it is in one, each app that shows the dataset when it is in
 * its audience, a direct share when it holds one. Empty when only the
 * visibility setting (everyone, policy) lets it see the dataset. A service
 * account holds what its admin gave it, so a share in its lists counts for
 * nothing.
 */
function reachedThrough(
  principal: Principal,
  dataset: { id: string; name: string },
  workspace: Reach,
  apps: Reach[],
): Reach[] {
  const shared =
    principal.kind === "person" &&
    listOf(principal, "powerbi_dataset_ids").includes(dataset.id);
  return [
    ...(listOf(principal, "powerbi_workspace_ids").includes(workspace.id)
      ? [workspace]
      : []),
    ...apps.filter((app) =>
      listOf(principal, "powerbi_app_ids").includes(app.id),
    ),
    ...(shared ? [ref("share", dataset.id, dataset.name)] : []),
  ];
}

function groupedBy<K, V>(rows: { key: K; value: V }[]): Map<K, V[]> {
  const groups = new Map<K, V[]>();
  for (const { key, value } of rows) {
    groups.set(key, [...(groups.get(key) ?? []), value]);
  }
  return groups;
}

/** The apps showing each dataset, among those the caller sees (appsSeen). */
async function appsShowing(
  context: ServiceContext,
  datasetIds: string[],
): Promise<Map<string, Reach[]>> {
  if (datasetIds.length === 0) return new Map();
  const allowed = await context.access.describableDatasets(context.principal);
  const rows = await context.db
    .select({
      dataset_id: powerbiAppDataset.dataset_id,
      id: powerbiApp.id,
      name: powerbiApp.name,
    })
    .from(powerbiAppDataset)
    .innerJoin(powerbiApp, eq(powerbiApp.id, powerbiAppDataset.app_id))
    .where(
      and(
        inArray(powerbiAppDataset.dataset_id, datasetIds),
        isNull(powerbiApp.removed_at),
        await appsSeen(context, allowed),
      ),
    )
    .orderBy(asc(powerbiApp.name), asc(powerbiApp.id));
  return groupedBy(
    rows.map((row) => ({
      key: row.dataset_id,
      value: ref("app", row.id, row.name),
    })),
  );
}

export type DatasetAnchor = {
  kind: "dataset";
  id: string;
  name: string;
  icon: string | null;
  description: string | null;
  workspace: Ref;
  reached_through: Reach[];
  has_row_level_security: boolean;
  removed: boolean;
};

export type DatasetFilters = {
  /** An id or a name. */
  workspace?: string;
  app?: string;
  name_prefix?: string;
  name_contains?: string;
} & Paging;

/** The datasets in a workspace, by its id or name. */
export const inWorkspace = (db: Db, workspace: string): SQL =>
  inArray(
    powerbiDataset.workspace_id,
    db
      .select({ id: powerbiWorkspace.id })
      .from(powerbiWorkspace)
      .where(byIdOrName(powerbiWorkspace, workspace)),
  );

/**
 * The datasets a live app shows, by its id or name. `seen` is the caller's
 * view of apps (appsSeen), so an app hidden from the caller answers exactly
 * like a missing one; undefined (under `everyone`) counts every live app.
 */
export const inApp = (db: Db, app: string, seen: SQL | undefined): SQL =>
  inArray(
    powerbiDataset.id,
    db
      .select({ id: powerbiAppDataset.dataset_id })
      .from(powerbiAppDataset)
      .innerJoin(powerbiApp, eq(powerbiApp.id, powerbiAppDataset.app_id))
      .where(
        and(byIdOrName(powerbiApp, app), isNull(powerbiApp.removed_at), seen),
      ),
  );

export async function listDatasets(
  context: ServiceContext,
  filters: DatasetFilters = {},
): Promise<Page<DatasetAnchor>> {
  const allowed = await context.access.describableDatasets(context.principal);
  const { db } = context;
  const limit = sizeOf(filters.limit);
  const matching = and(
    allowed,
    live(powerbiDataset, filters.removed),
    filters.workspace === undefined
      ? undefined
      : inWorkspace(db, filters.workspace),
    filters.app === undefined
      ? undefined
      : inApp(db, filters.app, await appsSeen(context, allowed)),
    startsWith(powerbiDataset.name, filters.name_prefix),
    containsName(powerbiDataset.name, filters.name_contains),
  );
  const rows = await db
    .select({
      id: powerbiDataset.id,
      name: powerbiDataset.name,
      icon: powerbiDataset.icon,
      description: powerbiDataset.description,
      description_pbi: powerbiDataset.description_pbi,
      has_row_level_security: powerbiDataset.has_row_level_security,
      removed_at: powerbiDataset.removed_at,
      workspace_id: powerbiWorkspace.id,
      workspace_name: powerbiWorkspace.name,
    })
    .from(powerbiDataset)
    .innerJoin(
      powerbiWorkspace,
      eq(powerbiWorkspace.id, powerbiDataset.workspace_id),
    )
    .where(and(matching, afterCursor(powerbiDataset, filters.cursor)))
    .orderBy(asc(powerbiDataset.name), asc(powerbiDataset.id))
    .limit(limit + 1);
  const page = pageOf(rows, limit);
  const [counted] =
    filters.cursor === undefined
      ? await context.db
          .select({ total: count() })
          .from(powerbiDataset)
          .where(matching)
      : [];
  const apps = await appsShowing(
    context,
    page.items.map((row) => row.id),
  );
  return {
    ...counted,
    items: page.items.map((row) => {
      const workspace = ref("workspace", row.workspace_id, row.workspace_name);
      return {
        kind: "dataset",
        id: row.id,
        name: row.name,
        icon: row.icon,
        description: described(row.description, row.description_pbi),
        workspace,
        reached_through: reachedThrough(
          context.principal,
          row,
          workspace,
          apps.get(row.id) ?? [],
        ),
        has_row_level_security: row.has_row_level_security,
        removed: row.removed_at !== null,
      };
    }),
    next_cursor: page.next_cursor,
  };
}

/** The dataset by id or name, among those the caller may describe. */
async function resolveDataset(
  context: ServiceContext,
  reference: string,
  removed?: boolean,
) {
  const allowed = await context.access.describableDatasets(context.principal);
  const rows = await context.db
    .select({ dataset: powerbiDataset, workspace: powerbiWorkspace })
    .from(powerbiDataset)
    .innerJoin(
      powerbiWorkspace,
      eq(powerbiWorkspace.id, powerbiDataset.workspace_id),
    )
    .where(
      and(
        allowed,
        byIdOrName(powerbiDataset, reference),
        live(powerbiDataset, removed),
      ),
    )
    .limit(6);
  const [found, ...others] = rows;
  // The same sentence access.require gives for a dataset the caller may not describe.
  if (found === undefined) throw new ServiceError("not_found", NO_SUCH_DATASET);
  if (others.length > 0) {
    const ids = rows
      .map((row) => `${row.dataset.id} (workspace ${row.workspace.name})`)
      .join(", ");
    throw new ServiceError(
      "invalid",
      `Several datasets are named "${reference}". Use the id of one of them: ${ids}.`,
    );
  }
  return found;
}

export async function getDataset(context: ServiceContext, reference: string) {
  const found = await resolveDataset(context, reference);
  const { workspace } = found;
  // Read after the lookup, so only a dataset the caller may describe is ever read.
  const details = await ensureModelDetails(context, found.dataset.id);
  const dataset = {
    ...found.dataset,
    relationships_source: details.relationships_source,
    relationships_read_at: details.relationships_read_at,
    relationships_note: details.relationships_note,
  };
  const { db } = context;
  const hides = !(await readsPii(context));
  const countIn = (source: typeof powerbiColumn | typeof powerbiMeasure) =>
    // Drizzle leaves the table off a column in a single-table select, which here would read the inner table's own id.
    sql<number>`(select count(*) from ${source} s where s.table_id = ${powerbiTable}.id and s.removed_at is null)::int`;
  const [
    tables,
    relationships,
    apps,
    questions,
    piiByTable,
    piiMeasures,
    columns,
  ] = await Promise.all([
    db
      .select({
        ...getTableColumns(powerbiTable),
        column_count: countIn(powerbiColumn),
        measure_count: countIn(powerbiMeasure),
        // A table rule marks the table; a person who may not read PII is shown no tag.
        pii: piiTableNamed(sql`${powerbiTable}.name`),
      })
      .from(powerbiTable)
      .where(
        and(
          eq(powerbiTable.dataset_id, dataset.id),
          isNull(powerbiTable.removed_at),
        ),
      )
      .orderBy(asc(powerbiTable.name)),
    db
      .select()
      .from(powerbiRelationship)
      .where(
        and(
          eq(powerbiRelationship.dataset_id, dataset.id),
          isNull(powerbiRelationship.removed_at),
          hides ? leavesOutPiiEnds() : undefined,
        ),
      )
      .orderBy(
        asc(powerbiRelationship.from_table),
        asc(powerbiRelationship.from_column),
      ),
    appsShowing(context, [dataset.id]),
    openQuestionsFor(context, { kind: "dataset", id: dataset.id }),
    // The live PII columns and measures of each table, to leave out of its counts.
    hides
      ? db
          .select({ table_id: powerbiColumn.table_id, hidden: count() })
          .from(powerbiColumn)
          .innerJoin(powerbiTable, eq(powerbiTable.id, powerbiColumn.table_id))
          .where(
            and(
              eq(powerbiColumn.dataset_id, dataset.id),
              isNull(powerbiColumn.removed_at),
              isNull(powerbiTable.removed_at),
              piiColumn(powerbiColumn, powerbiTable),
            ),
          )
          .groupBy(powerbiColumn.table_id)
      : [],
    hides
      ? db
          .select({ table_id: powerbiMeasure.table_id, hidden: count() })
          .from(powerbiMeasure)
          .innerJoin(powerbiTable, eq(powerbiTable.id, powerbiMeasure.table_id))
          .where(
            and(
              eq(powerbiMeasure.dataset_id, dataset.id),
              isNull(powerbiMeasure.removed_at),
              isNull(powerbiTable.removed_at),
              piiMeasure(powerbiMeasure),
            ),
          )
          .groupBy(powerbiMeasure.table_id)
      : [],
    db
      .select({
        table_id: powerbiColumn.table_id,
        table: powerbiTable.name,
        name: powerbiColumn.name,
        data_type: powerbiColumn.data_type,
        is_hidden: powerbiColumn.is_hidden,
      })
      .from(powerbiColumn)
      .innerJoin(powerbiTable, eq(powerbiTable.id, powerbiColumn.table_id))
      .where(
        and(
          eq(powerbiColumn.dataset_id, dataset.id),
          isNull(powerbiColumn.removed_at),
          isNull(powerbiTable.removed_at),
          hides ? not(piiColumn(powerbiColumn, powerbiTable)) : undefined,
        ),
      )
      .orderBy(asc(powerbiColumn.name)),
  ]);
  const many = new Set<string>();
  const one = new Set<string>();
  const joined = new Map<
    string,
    { table: string; column: string; joined_by: number }
  >();
  const ends = new Set<string>();
  const columnKey = (table: string, column: string) =>
    JSON.stringify([table, column]);
  const dateColumns = new Set(
    columns
      .filter((c) => c.data_type === "DateTime" || c.data_type === "Date")
      .map((c) => columnKey(c.table, c.name)),
  );
  for (const r of relationships) {
    for (const side of ["from", "to"] as const) {
      const table = r[`${side}_table`];
      const column = r[`${side}_column`];
      const key = columnKey(table, column);
      ends.add(key);
      const isOne =
        r.cardinality === "one_to_one" ||
        r.cardinality === (side === "from" ? "one_to_many" : "many_to_one");
      const isMany =
        r.cardinality === "many_to_many" ||
        r.cardinality === (side === "from" ? "many_to_one" : "one_to_many");
      if (isMany) many.add(table);
      if (!isOne) continue;
      one.add(table);
      if (!r.is_active || !dateColumns.has(key)) continue;
      const entry = joined.get(key) ?? { table, column, joined_by: 0 };
      entry.joined_by++;
      joined.set(key, entry);
    }
  }
  const dateTables = [...joined.values()].sort(
    (a, b) =>
      b.joined_by - a.joined_by ||
      a.table.localeCompare(b.table) ||
      a.column.localeCompare(b.column),
  );
  const tableKind = (table: {
    name: string;
    column_count: number;
    measure_count: number;
  }) => {
    if (table.column_count === 0 && table.measure_count > 0)
      return "measures" as const;
    if (dateTables.some((d) => d.table === table.name)) return "date" as const;
    if (many.has(table.name)) return "fact" as const;
    return one.has(table.name)
      ? ("dimension" as const)
      : ("standalone" as const);
  };
  const hiddenIn = new Map(piiByTable.map((row) => [row.table_id, row.hidden]));
  const hiddenMeasuresIn = new Map(
    piiMeasures.map((row) => [row.table_id, row.hidden]),
  );
  const piiHidden = piiByTable.reduce((sum, row) => sum + row.hidden, 0);
  const workspaceRef = ref("workspace", workspace.id, workspace.name);
  const shownIn = apps.get(dataset.id) ?? [];
  return {
    kind: "dataset" as const,
    ...dataset,
    workspace: workspaceRef,
    apps: shownIn,
    reached_through: reachedThrough(
      context.principal,
      dataset,
      workspaceRef,
      shownIn,
    ),
    tables: tables.map(({ pii, ...table }) => {
      // Counted after personal data is left out, so the kind agrees with the counts shown.
      const shown = {
        column_count: table.column_count - (hiddenIn.get(table.id) ?? 0),
        measure_count:
          table.measure_count - (hiddenMeasuresIn.get(table.id) ?? 0),
      };
      return {
        ...table,
        kind: tableKind({ name: table.name, ...shown }),
        column_names: columns
          .filter((c) => c.table_id === table.id && !c.is_hidden)
          .sort(
            (a, b) =>
              Number(ends.has(columnKey(b.table, b.name))) -
                Number(ends.has(columnKey(a.table, a.name))) ||
              a.name.localeCompare(b.name),
          )
          .slice(0, 5)
          .map((c) => c.name),
        ...(!hides && pii && { pii: true as const }),
        ...shown,
      };
    }),
    ...(piiHidden > 0 && { pii_hidden: piiHidden }),
    ...questions,
    date_tables: dateTables,
    // Last: an answer over 16 KiB is cut at its end, so it loses these before it loses a table.
    relationships,
    relationships_note: withListed(
      dataset.relationships_note,
      relationships.length,
    ),
  };
}

export async function listWorkspaces(context: ServiceContext) {
  const allowed = await context.access.describableDatasets(context.principal);
  // A workspace is seen through the datasets in it the caller may describe.
  const rows = await context.db
    .select({
      id: powerbiWorkspace.id,
      name: powerbiWorkspace.name,
      icon: powerbiWorkspace.icon,
      description: powerbiWorkspace.description,
      dataset_count: count(powerbiDataset.id),
    })
    .from(powerbiWorkspace)
    .innerJoin(
      powerbiDataset,
      eq(powerbiDataset.workspace_id, powerbiWorkspace.id),
    )
    .where(
      and(
        allowed,
        isNull(powerbiWorkspace.removed_at),
        isNull(powerbiDataset.removed_at),
      ),
    )
    .groupBy(powerbiWorkspace.id)
    .orderBy(asc(powerbiWorkspace.name), asc(powerbiWorkspace.id));
  return rows.map((row) => ({ kind: "workspace" as const, ...row }));
}

/**
 * Which apps the caller sees, as the visibility mode shows datasets; an app
 * has no Cerbos resource of its own. Under everyone, every app. Under
 * powerbi, those whose audience or workspace the caller's lists name:
 * showing a describable dataset is not enough, as that would name an app
 * the caller has no place in. Under policy, those whose workspace holds, or
 * which show, a dataset the deployment's policy lets the caller describe. A
 * service account sees its grant's apps in every mode, as its datasets.
 */
export async function appsSeen(
  context: ServiceContext,
  allowed: SQL,
): Promise<SQL | undefined> {
  const { principal, db } = context;
  const mode =
    principal.kind === "service_account"
      ? "powerbi"
      : await context.settings.get("access.metadata_visibility");
  if (mode === "everyone") return undefined;
  if (mode === "powerbi")
    return or(
      anyOf(powerbiApp.id, listOf(principal, "powerbi_app_ids")),
      anyOf(
        powerbiApp.workspace_id,
        listOf(principal, "powerbi_workspace_ids"),
      ),
    );
  const shown = db
    .select({ id: powerbiAppDataset.dataset_id })
    .from(powerbiAppDataset)
    .where(eq(powerbiAppDataset.app_id, powerbiApp.id));
  return exists(
    db
      .select({ one: sql`1` })
      .from(powerbiDataset)
      .where(
        and(
          allowed,
          isNull(powerbiDataset.removed_at),
          or(
            eq(powerbiDataset.workspace_id, powerbiApp.workspace_id),
            inArray(powerbiDataset.id, shown),
          ),
        ),
      ),
  );
}

/** The apps the caller sees, each with the datasets behind it the caller may describe. */
export async function listApps(context: ServiceContext) {
  const allowed = await context.access.describableDatasets(context.principal);
  const rows = await context.db
    .select({
      id: powerbiApp.id,
      name: powerbiApp.name,
      description: powerbiApp.description,
      description_pbi: powerbiApp.description_pbi,
      workspace_id: powerbiWorkspace.id,
      workspace_name: powerbiWorkspace.name,
      dataset_id: powerbiDataset.id,
      dataset_name: powerbiDataset.name,
    })
    .from(powerbiApp)
    .innerJoin(
      powerbiWorkspace,
      eq(powerbiWorkspace.id, powerbiApp.workspace_id),
    )
    .leftJoin(powerbiAppDataset, eq(powerbiAppDataset.app_id, powerbiApp.id))
    .leftJoin(
      powerbiDataset,
      and(
        eq(powerbiDataset.id, powerbiAppDataset.dataset_id),
        allowed,
        isNull(powerbiDataset.removed_at),
      ),
    )
    .where(and(await appsSeen(context, allowed), isNull(powerbiApp.removed_at)))
    .orderBy(
      asc(powerbiApp.name),
      asc(powerbiApp.id),
      asc(powerbiDataset.name),
    );
  const datasets = groupedBy(
    rows.flatMap((row) =>
      row.dataset_id === null || row.dataset_name === null
        ? []
        : [
            {
              key: row.id,
              value: ref("dataset", row.dataset_id, row.dataset_name),
            },
          ],
    ),
  );
  // One entry per app, in the order the rows came.
  const apps = new Map(rows.map((row) => [row.id, row]));
  return [...apps.values()].map((app) => ({
    kind: "app" as const,
    id: app.id,
    name: app.name,
    description: described(app.description, app.description_pbi),
    workspace: ref("workspace", app.workspace_id, app.workspace_name),
    datasets: datasets.get(app.id) ?? [],
  }));
}

export type RelationshipItem = typeof powerbiRelationship.$inferSelect;

export async function listRelationships(
  context: ServiceContext,
  input: {
    dataset: string;
    table?: string;
    active_only?: boolean;
    cursor?: string;
    limit?: number;
  },
): Promise<Page<RelationshipItem> & { total?: number; pii_hidden?: number }> {
  const { dataset } = await resolveDataset(context, input.dataset);
  await ensureModelDetails(context, dataset.id);
  const hides = !(await readsPii(context));
  const r = powerbiRelationship;
  let tableName = input.table;
  if (tableName !== undefined && looksLikeId(tableName)) {
    const [table] = await context.db
      .select({ name: powerbiTable.name })
      .from(powerbiTable)
      .where(
        and(
          eq(powerbiTable.id, tableName),
          eq(powerbiTable.dataset_id, dataset.id),
          isNull(powerbiTable.removed_at),
        ),
      );
    tableName = table?.name;
    if (tableName === undefined)
      return {
        items: [],
        next_cursor: null,
        ...(input.cursor === undefined && { total: 0 }),
      };
  }
  const ofDataset = and(eq(r.dataset_id, dataset.id), isNull(r.removed_at));
  const scope = and(
    ofDataset,
    tableName === undefined
      ? undefined
      : or(eq(r.from_table, tableName), eq(r.to_table, tableName)),
  );
  const visible = and(
    scope,
    input.active_only === true ? eq(r.is_active, true) : undefined,
    hides ? leavesOutPiiEnds() : undefined,
  );
  const order = [r.from_table, r.from_column, r.to_table, r.to_column];
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
  const [rows, totals, hidden] = await Promise.all([
    context.db
      .select()
      .from(r)
      .where(and(visible, afterCursor({ name: order, id: r.id }, input.cursor)))
      .orderBy(...order.map((c) => asc(c)), asc(r.id))
      .limit(limit + 1),
    input.cursor === undefined
      ? context.db.select({ value: count() }).from(r).where(visible)
      : [],
    hides
      ? context.db
          .select({ value: count() })
          .from(r)
          // Over the whole dataset, so a table filter cannot tell which tables a hidden relationship joins.
          .where(and(ofDataset, sql`not (${leavesOutPiiEnds()})`))
      : [],
  ]);
  return {
    ...pageBy(rows, limit, (row) => [
      row.from_table,
      row.from_column,
      row.to_table,
      row.to_column,
    ]),
    ...(input.cursor === undefined && { total: totals[0]?.value ?? 0 }),
    ...((hidden[0]?.value ?? 0) > 0 && { pii_hidden: hidden[0]?.value }),
  };
}

/** A relationship either of whose ends is a PII column is not shown to a person who may not read PII. */
const leavesOutPiiEnds = () =>
  and(
    not(
      piiColumnNamed(
        powerbiRelationship.from_table,
        powerbiRelationship.from_column,
      ),
    ),
    not(
      piiColumnNamed(
        powerbiRelationship.to_table,
        powerbiRelationship.to_column,
      ),
    ),
  );

async function termsBacking(db: Db, columnIds: string[]) {
  if (columnIds.length === 0)
    return new Map<string, { id: string; name: string }[]>();
  const rows = await db
    .select({ column_id: termColumn.column_id, id: term.id, name: term.name })
    .from(termColumn)
    .innerJoin(term, eq(term.id, termColumn.term_id))
    .where(inArray(termColumn.column_id, columnIds))
    .orderBy(asc(term.name));
  return groupedBy(
    rows.map((row) => ({
      key: row.column_id,
      value: { id: row.id, name: row.name },
    })),
  );
}

const NO_SUCH_COLUMN =
  "No such column. list_columns names the columns of a dataset you may use.";

export type ColumnFilters = {
  /** The dataset's id or name. */
  dataset: string;
  /** A table's id or name. */
  table?: string;
  name_prefix?: string;
  name_contains?: string;
} & Paging;

export async function listColumns(
  context: ServiceContext,
  filters: ColumnFilters,
) {
  const { dataset } = await resolveDataset(
    context,
    filters.dataset,
    filters.removed,
  );
  const limit = sizeOf(filters.limit);
  const hides = !(await readsPii(context));
  const pii = piiColumn(powerbiColumn, powerbiTable);
  // What `pii_hidden` counts leaves the name filter out, so it cannot be used to spell a hidden name.
  const ofDataset = and(
    eq(powerbiColumn.dataset_id, dataset.id),
    live(powerbiColumn, filters.removed),
    filters.table === undefined
      ? undefined
      : byIdOrName(powerbiTable, filters.table),
  );
  const inScope = and(
    ofDataset,
    startsWith(powerbiColumn.name, filters.name_prefix),
    containsName(powerbiColumn.name, filters.name_contains),
  );
  const rows = await context.db
    .select({
      id: powerbiColumn.id,
      name: powerbiColumn.name,
      data_type: powerbiColumn.data_type,
      column_type: powerbiColumn.column_type,
      is_hidden: powerbiColumn.is_hidden,
      description: powerbiColumn.description,
      description_pbi: powerbiColumn.description_pbi,
      display_folder: powerbiColumn.display_folder,
      removed_at: powerbiColumn.removed_at,
      table_id: powerbiTable.id,
      table_name: powerbiTable.name,
      pii,
    })
    .from(powerbiColumn)
    .innerJoin(powerbiTable, eq(powerbiTable.id, powerbiColumn.table_id))
    .where(
      and(
        inScope,
        hides ? not(pii) : undefined,
        afterCursor(powerbiColumn, filters.cursor),
      ),
    )
    .orderBy(asc(powerbiColumn.name), asc(powerbiColumn.id))
    .limit(limit + 1);
  const page = pageOf(rows, limit);
  const [counted] =
    filters.cursor === undefined
      ? await context.db
          .select({ total: count() })
          .from(powerbiColumn)
          .innerJoin(powerbiTable, eq(powerbiTable.id, powerbiColumn.table_id))
          .where(and(inScope, hides ? not(pii) : undefined))
      : [];
  const terms = await termsBacking(
    context.db,
    page.items.map((row) => row.id),
  );
  const [hiddenRow] = hides
    ? await context.db
        .select({ n: count() })
        .from(powerbiColumn)
        .innerJoin(powerbiTable, eq(powerbiTable.id, powerbiColumn.table_id))
        .where(and(ofDataset, pii))
    : [];
  const hidden = hiddenRow?.n ?? 0;
  return {
    ...counted,
    items: page.items.map((row) => columnItem(row, terms.get(row.id) ?? [])),
    next_cursor: page.next_cursor,
    ...(hidden > 0 && { pii_hidden: hidden }),
  };
}

type ColumnRow = {
  id: string;
  name: string;
  data_type: string | null;
  column_type: (typeof powerbiColumn.$inferSelect)["column_type"];
  is_hidden: boolean;
  description: string | null;
  description_pbi: string | null;
  display_folder: string | null;
  removed_at: Date | null;
  table_id: string;
  table_name: string;
  pii: boolean;
};

const columnItem = (row: ColumnRow, terms: { id: string; name: string }[]) => ({
  kind: "column" as const,
  id: row.id,
  name: row.name,
  table: ref("table", row.table_id, row.table_name),
  data_type: row.data_type,
  column_type: row.column_type,
  is_hidden: row.is_hidden,
  description: row.description,
  description_pbi: row.description_pbi,
  display_folder: row.display_folder,
  /** Usually none or one; a column may back several terms. */
  terms,
  removed: row.removed_at !== null,
  ...(row.pii && { pii: true as const }),
});

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A name as DAX writes it inside brackets: a closing bracket is doubled. */
const inBrackets = (name: string) => name.replaceAll("]", "]]");
export const escapeLike = (text: string) => text.replace(/[\\%_]/g, "\\$&");

/**
 * Whether a measure's DAX names the column, by its text alone: 'Table'[Column]
 * or Table[Column] (a quote in a name doubled), or a bare [Column] in a
 * measure of the same table.
 */
function namesColumn(
  expression: string,
  table: string,
  column: string,
  sameTable: boolean,
): boolean {
  const quoted = `'${escapeRegExp(table.replaceAll("'", "''"))}'`;
  const qualified = `(?:${quoted}|(?<![\\w'])${escapeRegExp(table)})\\[${escapeRegExp(inBrackets(column))}\\]`;
  const bare = sameTable
    ? `|(?<![\\w'\\]])\\[${escapeRegExp(inBrackets(column))}\\]`
    : "";
  return new RegExp(qualified + bare, "i").test(expression);
}

export async function getColumnDetail(
  context: ServiceContext,
  datasetId: string,
  columnId: string,
) {
  const { dataset } = await resolveDataset(context, datasetId);
  // A column that is no GUID is a column that is not there, as in a lookup by id elsewhere.
  if (!looksLikeId(columnId))
    throw new ServiceError("not_found", NO_SUCH_COLUMN);
  await ensureModelDetails(context, dataset.id);
  const { db } = context;
  const hides = !(await readsPii(context));
  const pii = piiColumn(powerbiColumn, powerbiTable);
  const [found] = await db
    .select({
      ...getTableColumns(powerbiColumn),
      table_name: powerbiTable.name,
      table_description: powerbiTable.description,
      table_description_pbi: powerbiTable.description_pbi,
      pii,
    })
    .from(powerbiColumn)
    .innerJoin(powerbiTable, eq(powerbiTable.id, powerbiColumn.table_id))
    .where(
      and(
        eq(powerbiColumn.id, columnId),
        eq(powerbiColumn.dataset_id, dataset.id),
        isNull(powerbiColumn.removed_at),
        hides ? not(pii) : undefined,
      ),
    );
  // A column the caller may not read answers as a missing one does.
  if (found === undefined) throw new ServiceError("not_found", NO_SUCH_COLUMN);
  const [definitions, relationships, candidates] = await Promise.all([
    db
      .select({ id: term.id, name: term.name, definition: term.definition })
      .from(termColumn)
      .innerJoin(term, eq(term.id, termColumn.term_id))
      .where(eq(termColumn.column_id, found.id))
      .orderBy(asc(term.name)),
    db
      .select()
      .from(powerbiRelationship)
      .where(
        and(
          eq(powerbiRelationship.dataset_id, dataset.id),
          isNull(powerbiRelationship.removed_at),
          or(
            and(
              eq(powerbiRelationship.from_table, found.table_name),
              eq(powerbiRelationship.from_column, found.name),
            ),
            and(
              eq(powerbiRelationship.to_table, found.table_name),
              eq(powerbiRelationship.to_column, found.name),
            ),
          ),
          hides ? leavesOutPiiEnds() : undefined,
        ),
      )
      .orderBy(
        asc(powerbiRelationship.from_table),
        asc(powerbiRelationship.from_column),
        asc(powerbiRelationship.to_table),
        asc(powerbiRelationship.to_column),
      ),
    db
      .select({
        id: powerbiMeasure.id,
        name: powerbiMeasure.name,
        expression: powerbiMeasure.expression,
        display_folder: powerbiMeasure.display_folder,
        table_id: powerbiMeasure.table_id,
        table_name: powerbiTable.name,
        metric: {
          name: metric.name,
          label: metric.label,
          trust_state: metric.trust_state,
        },
      })
      .from(powerbiMeasure)
      .innerJoin(powerbiTable, eq(powerbiTable.id, powerbiMeasure.table_id))
      .leftJoin(metricVariant, eq(metricVariant.measure_id, powerbiMeasure.id))
      .leftJoin(metric, eq(metric.id, metricVariant.metric_id))
      .where(
        and(
          eq(powerbiMeasure.dataset_id, dataset.id),
          isNull(powerbiMeasure.removed_at),
          sql`${powerbiMeasure.expression} ilike ${`%[${escapeLike(inBrackets(found.name))}]%`}`,
          hides ? not(piiMeasure(powerbiMeasure)) : undefined,
        ),
      )
      .orderBy(
        asc(powerbiTable.name),
        asc(powerbiMeasure.name),
        asc(powerbiMeasure.id),
        asc(metric.name),
      ),
  ]);
  const used = new Map<string, (typeof candidates)[number]>();
  for (const row of candidates)
    if (
      !used.has(row.id) &&
      namesColumn(
        row.expression ?? "",
        found.table_name,
        found.name,
        row.table_id === found.table_id,
      )
    )
      used.set(row.id, row);
  return {
    column: {
      ...columnItem(
        found,
        definitions.map(({ id, name }) => ({ id, name })),
      ),
      expression: found.expression,
      format_string: found.format_string,
    },
    table: {
      id: found.table_id,
      name: found.table_name,
      description: described(
        found.table_description,
        found.table_description_pbi,
      ),
    },
    terms: definitions.map(({ name, definition }) => ({ name, definition })),
    relationships,
    used_by: [...used.values()].map((row) => ({
      id: row.id,
      name: row.name,
      table: row.table_name,
      display_folder: row.display_folder,
      metric: row.metric,
    })),
  };
}

export type MeasureFilters = {
  dataset: string;
  table?: string;
  /** Only the measures no metric has a variant on. */
  unfiled?: boolean;
  name_contains?: string;
} & Paging;

export async function listMeasures(
  context: ServiceContext,
  filters: MeasureFilters,
) {
  const { dataset } = await resolveDataset(
    context,
    filters.dataset,
    filters.removed,
  );
  await ensureModelDetails(context, dataset.id);
  const limit = sizeOf(filters.limit);
  const hides = !(await readsPii(context));
  const pii = piiMeasure(powerbiMeasure);
  // What `pii_hidden` counts leaves the unfiled filter out, so it cannot be used to probe a hidden measure.
  const ofDataset = and(
    eq(powerbiMeasure.dataset_id, dataset.id),
    live(powerbiMeasure, filters.removed),
    filters.table === undefined
      ? undefined
      : byIdOrName(powerbiTable, filters.table),
  );
  const inScope = and(
    ofDataset,
    containsName(powerbiMeasure.name, filters.name_contains),
    filters.unfiled === true ? isNull(metricVariant.id) : undefined,
  );
  const rows = await context.db
    .select({
      id: powerbiMeasure.id,
      name: powerbiMeasure.name,
      display_folder: powerbiMeasure.display_folder,
      format_string: powerbiMeasure.format_string,
      is_hidden: powerbiMeasure.is_hidden,
      description: powerbiMeasure.description,
      description_pbi: powerbiMeasure.description_pbi,
      removed_at: powerbiMeasure.removed_at,
      table_id: powerbiTable.id,
      table_name: powerbiTable.name,
      pii,
      // Nested, so a measure no metric has a variant on gets null for each.
      metric: { id: metric.id, name: metric.name, label: metric.label },
      shift: {
        period: metricVariant.period,
        comparison: metricVariant.comparison,
        comparison_period: metricVariant.comparison_period,
        currency: metricVariant.currency,
        shift_note: metricVariant.shift_note,
        custom_axes: metricVariant.custom_axes,
      },
    })
    .from(powerbiMeasure)
    .innerJoin(powerbiTable, eq(powerbiTable.id, powerbiMeasure.table_id))
    .leftJoin(metricVariant, eq(metricVariant.measure_id, powerbiMeasure.id))
    .leftJoin(metric, eq(metric.id, metricVariant.metric_id))
    .where(
      and(
        inScope,
        hides ? not(pii) : undefined,
        afterCursor(powerbiMeasure, filters.cursor),
      ),
    )
    .orderBy(asc(powerbiMeasure.name), asc(powerbiMeasure.id))
    .limit(limit + 1);
  const page = pageOf(rows, limit);
  const [counted] =
    filters.cursor === undefined
      ? await context.db
          .select({ total: count() })
          .from(powerbiMeasure)
          .innerJoin(powerbiTable, eq(powerbiTable.id, powerbiMeasure.table_id))
          .leftJoin(
            metricVariant,
            eq(metricVariant.measure_id, powerbiMeasure.id),
          )
          .where(and(inScope, hides ? not(pii) : undefined))
      : [];
  const [hiddenRow] = hides
    ? await context.db
        .select({ n: count() })
        .from(powerbiMeasure)
        .innerJoin(powerbiTable, eq(powerbiTable.id, powerbiMeasure.table_id))
        .where(and(ofDataset, pii))
    : [];
  const hidden = hiddenRow?.n ?? 0;
  return {
    ...counted,
    items: page.items.map((row) => ({
      kind: "measure" as const,
      id: row.id,
      name: row.name,
      table: ref("table", row.table_id, row.table_name),
      display_folder: row.display_folder,
      format_string: row.format_string,
      is_hidden: row.is_hidden,
      description: row.description,
      description_pbi: row.description_pbi,
      metric: row.metric && {
        ...ref("metric", row.metric.id, row.metric.name),
        label: row.metric.label,
      },
      shift: row.shift,
      removed: row.removed_at !== null,
      ...(row.pii && { pii: true as const }),
    })),
    next_cursor: page.next_cursor,
    ...(hidden > 0 && { pii_hidden: hidden }),
  };
}
