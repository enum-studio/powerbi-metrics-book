import {
  type AnyColumn,
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  type SQL,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import pg from "pg";
import type { Db, Resource, ServiceContext } from "../../context.js";
import { ServiceError } from "../../errors.js";
import { user } from "../../db/schema/auth.js";
import {
  powerbiColumn,
  powerbiDataset,
  powerbiMeasure,
  powerbiTable,
} from "../../db/schema/mirror.js";
import {
  foldSql,
  PII_RULE_KINDS,
  type PiiRuleKind,
  piiRule,
} from "../../db/schema/pii.js";
import { audited, requireAdmin } from "../admin/guard.js";
import { recordBookChange } from "../book/changes.js";
import { byIdOrName, looksLikeId } from "../mirror/read.js";
import { suspectedPii } from "./heuristic.js";

export type { PiiRuleKind };
export type PiiRule = {
  id: string;
  kind: PiiRuleKind;
  table_name: string;
  name: string | null;
  pii: boolean;
  note: string | null;
  set_by_kind: string;
  set_by_id: string;
  set_via: string;
  set_at: string;
  version: string;
};

export const PII: Resource = { kind: "pii", id: "pii", attr: {} };

const asked = new WeakMap<ServiceContext, Promise<boolean>>();

/** Whether the caller may see PII: Cerbos pii:read, asked once per context. */
export function readsPii(context: ServiceContext): Promise<boolean> {
  let answer = asked.get(context);
  if (answer === undefined) {
    answer = context.access.check(context.principal, PII, "read");
    asked.set(context, answer);
    // A failed ask is not remembered.
    answer.catch(() => asked.delete(context));
  }
  return answer;
}

export { foldSql };

const sameName = (a: SQL | AnyColumn, b: SQL | AnyColumn) =>
  sql`${foldSql(a)} = ${foldSql(b)}`;

/*
 * What the rules say of a name: true when any says PII, so PII wins should two
 * fold alike, false when only rules that clear it match, null when none does.
 * Each rule is folded once per statement and the name probes a hash, never
 * `pii_rule_name_idx` by the fold: after a glibc or Postgres upgrade a stale one
 * would miss the rule and show the name. The scan may use the index for `kind`
 * alone, which reads every rule of that kind whatever their folds.
 */
const ruleNamed = (
  kind: PiiRuleKind,
  table: SQL | AnyColumn,
  name?: SQL | AnyColumn,
) => {
  const key =
    name === undefined
      ? foldSql(table)
      : sql`(${foldSql(table)}, ${foldSql(name)})`;
  const folded =
    name === undefined
      ? foldSql(piiRule.table_name)
      : sql`${foldSql(piiRule.table_name)}, ${foldSql(piiRule.name)}`;
  const rules = (pii: boolean) => sql`
    select ${folded} from ${piiRule}
    where ${piiRule.kind} = ${kind} and ${piiRule.pii} = ${pii}`;
  return sql`case
    when ${key} in (${rules(true)}) then true
    when ${key} in (${rules(false)}) then false
  end`;
};

/** True when a `pii = true` table rule names the table. */
export function piiTableNamed(table: SQL | AnyColumn): SQL<boolean> {
  return sql<boolean>`coalesce((${ruleNamed("table", table)}), false)`;
}

/**
 * True when the rules alone say a column is PII: its column rule, else its
 * table rule, else not. It needs no synced row, so a name the mirror has not
 * seen is judged too.
 */
export function piiColumnNamed(
  table: SQL | AnyColumn,
  column: SQL | AnyColumn,
): SQL<boolean> {
  return sql<boolean>`coalesce(
    (${ruleNamed("column", table, column)}),
    (${ruleNamed("table", table)}),
    false)`;
}

/** True when the column is PII: its column rule, else its table rule, else not. */
export function piiColumn(
  column: typeof powerbiColumn,
  table: typeof powerbiTable,
): SQL<boolean> {
  return piiColumnNamed(table.name, column.name);
}

const ruledMeasure = alias(powerbiMeasure, "ruled_measure");
const ruledTable = alias(powerbiTable, "ruled_table");

/*
 * From the rules to the measures. A read of one measure finds it by its key and
 * folds one name. A read of many is usually a join that folds each name once;
 * asked per row, as `dataset_count` in `listMetrics` is, it folds the rules for
 * each row (`docs/decisions/book.md` has the cost). Any rule that says PII marks
 * the measure, so PII wins here too. Nothing reads by the fold, on purpose:
 * after a Postgres or glibc upgrade a stale index would let a measure out of
 * its rule, and into search and the embedding provider. So a measure's fold has
 * no index, and `offset 0` keeps the join out of `pii_rule_name_idx`, which may
 * still serve `kind` alone: that reads every measure rule whatever its fold.
 */
const ruledMeasures = sql`
  select ${ruledMeasure.id} from (
    select ${foldSql(piiRule.table_name)} as table_key, ${foldSql(piiRule.name)} as name_key
    from ${piiRule}
    where ${piiRule.kind} = 'measure' and ${piiRule.pii}
    offset 0
  ) as rule
  inner join ${powerbiMeasure} as ${ruledMeasure} on ${foldSql(ruledMeasure.name)} = rule.name_key
  inner join ${powerbiTable} as ${ruledTable} on ${ruledTable.id} = ${ruledMeasure.table_id}
    and ${foldSql(ruledTable.name)} = rule.table_key`;

/** True when a measure rule marks the measure. A table rule never covers a measure. */
export function piiMeasure(measure: typeof powerbiMeasure): SQL<boolean> {
  // Nested: a select from one table strips the table from columns at the top of its fields.
  const sameMeasure = sql`${ruledMeasure.id} = ${measure.id}`;
  return sql<boolean>`exists (${ruledMeasures} where ${sameMeasure})`;
}

/** Folds names as `foldSql` does, by asking the database; the order is kept. */
export async function foldNames(db: Db, names: string[]): Promise<string[]> {
  const { rows } = await db.execute<{ folded: string }>(sql`
    select ${foldSql(sql`n`)} as folded
    from unnest(${sql.param(names)}::text[]) with ordinality as given(n, i)
    order by i`);
  return rows.map(({ folded }) => folded);
}

/** Folded table to the folded names in it. */
export type NamesByTable = Map<string, Set<string>>;

const add = (names: NamesByTable, table: string, name: string) => {
  const inTable = names.get(table) ?? new Set<string>();
  names.set(table, inTable.add(name));
};

export type PiiNames = {
  columns: NamesByTable;
  bare: Set<string>;
  measures: NamesByTable;
  tables: Set<string>;
  ruleColumns: NamesByTable;
  ruleMeasures: NamesByTable;
  ruleTables: NamesByTable;
  knownMeasures: NamesByTable;
};

/**
 * The PII names of each dataset, every key folded by `foldSql` (fold DAX names
 * with `foldNames` before looking them up). Each holds what the mirror has
 * synced, and what the rules say whether or not the mirror has it: `ruleTables`
 * maps each `pii = true` table rule's table to the names its `pii = false`
 * column rules clear. `only`, folded names, leaves the rest of the mirror
 * unread.
 */
async function readPiiNames(
  db: Db,
  dataset_ids: string[],
  only?: string[],
): Promise<Map<string, PiiNames>> {
  const named = (name: AnyColumn) =>
    only === undefined
      ? undefined
      : sql`${foldSql(name)} = any(${sql.param(only)}::text[])`;
  const [columns, measures, rules] = await db.transaction(
    async (tx) => [
      await tx
        .select({
          dataset_id: powerbiColumn.dataset_id,
          table: foldSql(powerbiTable.name),
          name: foldSql(powerbiColumn.name),
        })
        .from(powerbiColumn)
        .innerJoin(powerbiTable, eq(powerbiTable.id, powerbiColumn.table_id))
        .where(
          and(
            inArray(powerbiColumn.dataset_id, dataset_ids),
            isNull(powerbiColumn.removed_at),
            isNull(powerbiTable.removed_at),
            named(powerbiColumn.name),
            piiColumn(powerbiColumn, powerbiTable),
          ),
        ),
      await tx
        .select({
          dataset_id: powerbiMeasure.dataset_id,
          table: foldSql(powerbiTable.name),
          name: foldSql(powerbiMeasure.name),
          pii: piiMeasure(powerbiMeasure),
        })
        .from(powerbiMeasure)
        .innerJoin(powerbiTable, eq(powerbiTable.id, powerbiMeasure.table_id))
        .where(
          and(
            inArray(powerbiMeasure.dataset_id, dataset_ids),
            isNull(powerbiMeasure.removed_at),
            isNull(powerbiTable.removed_at),
            named(powerbiMeasure.name),
          ),
        ),
      await tx
        .select({
          kind: piiRule.kind,
          table: foldSql(piiRule.table_name),
          name: foldSql(sql`coalesce(${piiRule.name}, '')`),
          pii: piiRule.pii,
        })
        .from(piiRule)
        // Table rules first, so a clearing column rule finds its table.
        .orderBy(desc(sql`${piiRule.kind} = 'table'`)),
    ],
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
  return new Map(
    dataset_ids.map((id) => {
      const found: PiiNames = {
        columns: new Map(),
        bare: new Set(),
        measures: new Map(),
        tables: new Set(),
        ruleColumns: new Map(),
        ruleMeasures: new Map(),
        ruleTables: new Map(),
        knownMeasures: new Map(),
      };
      for (const { table, name } of columns.filter(
        (row) => row.dataset_id === id,
      )) {
        add(found.columns, table, name);
        found.bare.add(name);
        found.tables.add(table);
      }
      for (const { table, name, pii } of measures.filter(
        (row) => row.dataset_id === id,
      )) {
        add(found.knownMeasures, table, name);
        if (pii) {
          add(found.measures, table, name);
          found.bare.add(name);
        }
      }
      for (const { kind, table, name, pii } of rules) {
        if (kind === "table" && pii) {
          found.tables.add(table);
          found.ruleTables.set(table, new Set());
        } else if (kind === "column" && pii) {
          add(found.ruleColumns, table, name);
          found.bare.add(name);
          found.tables.add(table);
        } else if (kind === "measure" && pii) {
          add(found.ruleMeasures, table, name);
          found.bare.add(name);
        } else if (kind === "column") found.ruleTables.get(table)?.add(name);
      }
      return [id, found];
    }),
  );
}

/** The PII names of one dataset whole, for the query check. */
export async function piiNamesOf(
  db: Db,
  dataset_id: string,
): Promise<PiiNames> {
  const found = (await readPiiNames(db, [dataset_id])).get(dataset_id);
  if (found === undefined)
    throw new Error("readPiiNames gave back no dataset it was asked for.");
  return found;
}

/**
 * What each dataset's PII names say about `names`, folded, with the rest of the
 * mirror unread. Its answer holds for those names only, so it has no `tables`
 * and the query check, which reads `tables`, cannot take it.
 */
export function piiNamesAmong(
  db: Db,
  dataset_ids: string[],
  names: string[],
): Promise<Map<string, Omit<PiiNames, "tables">>> {
  return readPiiNames(db, dataset_ids, names);
}

type RuleRow = typeof piiRule.$inferSelect;
const asRule = (row: RuleRow): PiiRule => ({
  ...row,
  set_at: row.set_at.toISOString(),
  version: `${row.id}:${row.set_at.toISOString()}`,
});

type MatchedElement = {
  rule_id: string;
  element_kind: "column" | "measure";
  id: string;
  dataset_id: string;
};
type RuleTarget = Pick<RuleRow, "id" | "kind" | "table_name" | "name">;

function matchedElements(reachable: SQL, rule?: RuleTarget): SQL {
  // Materialized CTEs fold each live name once, before joining rules to elements.
  return sql`with live_tables as materialized (
    select ${powerbiTable.id},
      ${foldSql(powerbiTable.name)} as table_key
    from ${powerbiTable}
    where ${powerbiTable.removed_at} is null
  ), live_elements as materialized (
    select 'column'::text as element_kind, ${powerbiColumn.id},
      ${powerbiColumn.dataset_id}, live_tables.table_key,
      ${foldSql(powerbiColumn.name)} as name_key
    from ${powerbiColumn}
    inner join live_tables on live_tables.id = ${powerbiColumn.table_id}
    inner join ${powerbiDataset} on ${powerbiDataset.id} = ${powerbiColumn.dataset_id}
    where ${powerbiColumn.removed_at} is null and ${powerbiDataset.removed_at} is null
      and ${reachable}
    union all
    select 'measure'::text as element_kind, ${powerbiMeasure.id},
      ${powerbiMeasure.dataset_id}, live_tables.table_key,
      ${foldSql(powerbiMeasure.name)} as name_key
    from ${powerbiMeasure}
    inner join live_tables on live_tables.id = ${powerbiMeasure.table_id}
    inner join ${powerbiDataset} on ${powerbiDataset.id} = ${powerbiMeasure.dataset_id}
    where ${powerbiMeasure.removed_at} is null and ${powerbiDataset.removed_at} is null
      and ${reachable}
  ), folded_rules as materialized (
    select ${piiRule.id}, ${piiRule.kind},
      ${foldSql(piiRule.table_name)} as table_key,
      ${foldSql(sql`coalesce(${piiRule.name}, '')`)} as name_key
    from ${piiRule}
  ), current_rules as (
    ${
      rule === undefined
        ? sql`select folded_rules.* from folded_rules`
        : sql`select ${rule.id}::uuid as id, ${rule.kind}::text as kind,
          ${foldSql(sql`${rule.table_name}`)} as table_key,
          ${foldSql(sql`${rule.name ?? ""}`)} as name_key`
    }
  )
  select current_rules.id as rule_id, live_elements.element_kind,
    live_elements.id, live_elements.dataset_id
  from current_rules
  inner join live_elements on live_elements.table_key = current_rules.table_key
    and ((current_rules.kind = live_elements.element_kind
      and current_rules.name_key = live_elements.name_key)
    or (current_rules.kind = 'table' and live_elements.element_kind = 'column'
      and not exists (
        select 1 from folded_rules as column_override
        where column_override.kind = 'column'
          and column_override.table_key = live_elements.table_key
          and column_override.name_key = live_elements.name_key)))`;
}

export async function listRules(
  context: ServiceContext,
  filter: { pii?: boolean },
): Promise<Array<PiiRule & { columns: number; datasets: number }>> {
  await requireAdmin(context, "manage_pii");
  const reachable = await context.access.reachableDatasets(context.principal);
  const rows = await context.db.execute<
    Omit<RuleRow, "set_at"> & {
      set_at: string;
      columns: number;
      datasets: number;
    }
  >(
    sql`with rule_matches as (${matchedElements(reachable)})
      select pii_rule.*,
        count(rule_matches.id)::int as columns,
        count(distinct rule_matches.dataset_id)::int as datasets
      from pii_rule
      left join rule_matches on rule_matches.rule_id = pii_rule.id
      where ${filter.pii === undefined ? sql`true` : sql`pii_rule.pii = ${filter.pii}`}
      group by pii_rule.id
      order by lower(pii_rule.table_name), pii_rule.kind, lower(pii_rule.name)`,
  );
  return rows.rows.map(({ columns, datasets, ...rule }) => ({
    ...asRule({ ...rule, set_at: new Date(rule.set_at) }),
    columns,
    datasets,
  }));
}

type Input = {
  expected_version?: string | null;
  kind: PiiRuleKind;
  table_name: string;
  name?: string | null;
  pii: boolean;
  note?: string | null;
};

/** Checked under the write lock, including when no matching rule exists. */
async function expectVersion(
  db: Db,
  row: RuleRow | undefined,
  expected: string | null | undefined,
): Promise<void> {
  if (expected === undefined || expected === (row ? asRule(row).version : null))
    return;
  if (row === undefined)
    throw new ServiceError(
      "conflict",
      "The rule changed since; it no longer exists.",
    );
  let who = row.set_by_id;
  if (row.set_by_kind === "person") {
    const [person] = await db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, row.set_by_id));
    who = person?.email ?? "a person whose account was removed";
  }
  const via =
    row.set_via === "browser"
      ? "in the browser"
      : row.set_via === "cli"
        ? "with the CLI"
        : row.set_via === "mcp"
          ? "through an agent"
          : "through the API";
  throw new ServiceError(
    "conflict",
    `The rule changed since; it was last set by ${who} ${via}.`,
  );
}

function check(input: Input): void {
  if (!PII_RULE_KINDS.includes(input.kind))
    throw new ServiceError(
      "invalid",
      `A rule's kind is one of ${PII_RULE_KINDS.join(", ")}.`,
    );
  const name = input.name ?? null;
  if (input.kind === "table" && name !== null)
    throw new ServiceError(
      "invalid",
      "A table rule covers the whole table and takes no name.",
    );
  if (input.kind !== "table" && (name === null || name === ""))
    throw new ServiceError("invalid", `A ${input.kind} rule needs a name.`);
  if (input.table_name === "")
    throw new ServiceError("invalid", "A rule needs a table name.");
  const fields = [
    ["table_name", input.table_name, 200],
    ["name", name, 200],
    ["note", input.note ?? null, 500],
  ] as const;
  for (const [field, value] of fields.slice(0, 2))
    if (value !== null && value !== value.trim())
      throw new ServiceError(
        "invalid",
        `The ${field} has leading or trailing whitespace.`,
      );
  for (const [field, value, max] of fields)
    if (value !== null && (value.length > max || value.includes("\0")))
      throw new ServiceError(
        "invalid",
        `The ${field} is at most ${String(max)} characters, with no null characters.`,
      );
}

/** The live columns and measures a rule decides, in any dataset. */
async function covered(tx: Db, rule: RuleTarget, reachable: SQL) {
  const rows = await tx.execute<MatchedElement>(
    matchedElements(reachable, rule),
  );
  const columns = rows.rows.filter(
    ({ element_kind }) => element_kind === "column",
  );
  const measures = rows.rows.filter(
    ({ element_kind }) => element_kind === "measure",
  );
  return {
    columns,
    measures,
    datasets: new Set(rows.rows.map(({ dataset_id }) => dataset_id)).size,
  };
}

/** Queues the embed job for exactly the elements whose PII status the change touches. */
async function recordChanges(
  context: ServiceContext,
  tx: Db,
  matched: Awaited<ReturnType<typeof covered>>,
  before: boolean | null,
  after: boolean | null,
): Promise<void> {
  const elements = [
    ...matched.columns.map(({ id }) => ({ element_kind: "column", id })),
    ...matched.measures.map(({ id }) => ({ element_kind: "measure", id })),
  ];
  for (const { element_kind, id } of elements)
    await recordBookChange(tx, {
      principal: context.principal,
      element_kind,
      element_id: id,
      action: "pii_changed",
      before: { rule_pii: before },
      after: { rule_pii: after },
    });
}

const detail = (rule: PiiRule | null) =>
  rule === null
    ? null
    : {
        kind: rule.kind,
        table_name: rule.table_name,
        name: rule.name,
        pii: rule.pii,
        note: rule.note,
      };

type Saved = {
  rule: PiiRule;
  before: PiiRule | null;
  columns: number;
  measures: number;
  datasets: number;
};

function ruleWriteError(error: unknown): never {
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof pg.DatabaseError && cause.code === "55P03")
    throw new ServiceError(
      "conflict",
      "Another PII change is in progress; try again.",
    );
  throw error;
}

async function lockRules(tx: Db): Promise<void> {
  const { rows } = await tx.execute<{ value: string }>(
    sql`select current_setting('lock_timeout') as value`,
  );
  const old = rows[0];
  if (old === undefined) throw new Error("Missing lock timeout.");
  await tx.execute(sql`set local lock_timeout = '5s'`);
  await tx.execute(sql`lock table pii_rule in share row exclusive mode`);
  await tx.execute(sql`select set_config('lock_timeout', ${old.value}, true)`);
}

/**
 * Upserts on the unique key and queues the embed job, with no access check and
 * no audit line: for a caller that has checked, and audits after its own
 * transaction commits. The counts are the live columns, measures and datasets
 * the rule now decides.
 */
export async function saveRule(
  context: ServiceContext,
  input: Input,
): Promise<Saved> {
  // Composed first, so the length checked is the length stored.
  const name = input.name?.normalize("NFC") ?? null;
  const table_name = input.table_name.normalize("NFC");
  check({ ...input, name, table_name });
  const { principal } = context;
  const changed = await context.db
    .transaction(async (tx) => {
      // Serialize rule writes, including absent keys, under the database's name matching.
      await lockRules(tx);
      const [existing] = await tx
        .select()
        .from(piiRule)
        .where(
          and(
            eq(piiRule.kind, input.kind),
            sameName(piiRule.table_name, sql`${table_name}`),
            sameName(sql`coalesce(${piiRule.name}, '')`, sql`${name ?? ""}`),
          ),
        );
      await expectVersion(tx, existing, input.expected_version);
      const values = {
        kind: input.kind,
        table_name,
        name,
        pii: input.pii,
        note: input.note ?? null,
        set_by_kind: principal.kind,
        set_by_id: principal.id,
        set_via: principal.via,
        // Millisecond precision survives JSON and advances even within one clock tick.
        set_at: new Date(
          Math.max(Date.now(), (existing?.set_at.getTime() ?? 0) + 1),
        ),
      };
      const [row] =
        existing === undefined
          ? await tx.insert(piiRule).values(values).returning()
          : await tx
              .update(piiRule)
              .set(values)
              .where(eq(piiRule.id, existing.id))
              .returning();
      if (row === undefined) throw new Error("The rule was not saved.");
      const matched = await covered(tx, row, sql`true`);
      await recordChanges(context, tx, matched, existing?.pii ?? null, row.pii);
      return { existing, row, matched };
    })
    .catch(ruleWriteError);
  return {
    rule: asRule(changed.row),
    before: changed.existing ? asRule(changed.existing) : null,
    columns: changed.matched.columns.length,
    measures: changed.matched.measures.length,
    datasets: changed.matched.datasets,
  };
}

/** The audit line of a saved rule; `extra` rides in its detail. */
export const auditRuleSet = (
  context: ServiceContext,
  { rule, before }: Saved,
  extra: Record<string, unknown> = {},
) =>
  audited(
    context,
    "pii_rule.set",
    { kind: "pii_rule", id: rule.id },
    { before: detail(before), after: detail(rule), ...extra },
  );

/** Checks the caller, saves the rule, then audits it. */
export async function setRule(
  context: ServiceContext,
  input: Input,
): Promise<Saved> {
  await requireAdmin(context, "manage_pii");
  const saved = await saveRule(context, input);
  await auditRuleSet(context, saved);
  const reachable = await context.access.reachableDatasets(context.principal);
  const counts = await covered(context.db, saved.rule, reachable);
  return {
    rule: saved.rule,
    before: saved.before,
    columns: counts.columns.length,
    measures: counts.measures.length,
    datasets: counts.datasets,
  };
}

/** Records what the rule matched before removal, so those elements' search documents come back. */
export async function removeRule(
  context: ServiceContext,
  id: string,
  expectedVersion?: string,
): Promise<void> {
  await requireAdmin(context, "manage_pii");
  const notFound = new ServiceError("not_found", "No PII rule has that id.");
  if (!looksLikeId(id)) throw notFound;
  const removed = await context.db
    .transaction(async (tx) => {
      await lockRules(tx);
      const [existing] = await tx
        .select()
        .from(piiRule)
        .where(eq(piiRule.id, id));
      await expectVersion(tx, existing, expectedVersion);
      const [row] = await tx
        .delete(piiRule)
        .where(eq(piiRule.id, id))
        .returning();
      if (row === undefined) return null;
      // Deleted in this transaction, so the table rule's exclusion of columns with their own rule still holds.
      await recordChanges(
        context,
        tx,
        await covered(tx, row, sql`true`),
        row.pii,
        null,
      );
      return row;
    })
    .catch(ruleWriteError);
  if (removed === null) throw notFound;
  await audited(
    context,
    "pii_rule.remove",
    { kind: "pii_rule", id },
    {
      before: detail(asRule(removed)),
    },
  );
}

/** Live columns no rule covers whose name looks like personal data. Nothing is marked by this. */
export async function suggest(
  context: ServiceContext,
  filter: { dataset?: string },
): Promise<
  Array<{
    dataset_id: string;
    dataset_name: string;
    table_name: string;
    column_name: string;
    matched: string;
  }>
> {
  await requireAdmin(context, "manage_pii");
  const reachable = await context.access.reachableDatasets(context.principal);
  let datasets: string[] | undefined;
  if (filter.dataset !== undefined) {
    datasets = (
      await context.db
        .select({ id: powerbiDataset.id })
        .from(powerbiDataset)
        .where(
          and(
            isNull(powerbiDataset.removed_at),
            reachable,
            byIdOrName(powerbiDataset, filter.dataset),
          ),
        )
    ).map(({ id }) => id);
    if (datasets.length === 0)
      throw new ServiceError("not_found", "No dataset has that id or name.");
  }
  const rows = await context.db
    .select({
      dataset_id: powerbiDataset.id,
      dataset_name: powerbiDataset.name,
      table_name: powerbiTable.name,
      column_name: powerbiColumn.name,
    })
    .from(powerbiColumn)
    .innerJoin(powerbiTable, eq(powerbiTable.id, powerbiColumn.table_id))
    .innerJoin(powerbiDataset, eq(powerbiDataset.id, powerbiColumn.dataset_id))
    .where(
      and(
        isNull(powerbiColumn.removed_at),
        isNull(powerbiTable.removed_at),
        isNull(powerbiDataset.removed_at),
        reachable,
        datasets === undefined
          ? undefined
          : inArray(powerbiDataset.id, datasets),
        sql`not exists (
          select 1 from ${piiRule}
          where ${sameName(piiRule.table_name, powerbiTable.name)}
            and (${piiRule.kind} = 'table'
              or (${piiRule.kind} = 'column'
                and ${sameName(piiRule.name, powerbiColumn.name)})))`,
      ),
    )
    .orderBy(
      asc(powerbiDataset.name),
      asc(powerbiTable.name),
      asc(powerbiColumn.name),
    );
  return rows.flatMap((row) => {
    const matched = suspectedPii(row.column_name);
    return matched === null ? [] : [{ ...row, matched }];
  });
}
