import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  and,
  asc,
  count,
  eq,
  exists,
  inArray,
  isNull,
  ne,
  not,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import type { Db, ServiceContext } from "../../context.js";
import {
  metric,
  term,
  termColumn,
  termMetric,
  type TRUST_STATES,
} from "../../db/schema/book.js";
import {
  powerbiColumn,
  powerbiDataset,
  powerbiTable,
  powerbiWorkspace,
} from "../../db/schema/mirror.js";
import { ServiceError } from "../../errors.js";
import type { Principal } from "../../principal.js";
import { currentConventions } from "../conventions/store.js";
import { type NewEvent, withEvents } from "../events/feed.js";
import {
  afterCursor,
  byIdOrName,
  appsSeen,
  inApp,
  inWorkspace,
  looksLikeId,
  type Page,
  pageOf,
  ref,
  sizeOf,
  visibleMetric,
} from "../mirror/read.js";
import { piiColumn, readsPii } from "../pii/rules.js";
import { openQuestionsFor } from "../threads/open-questions.js";
import { recordBookChange, requireCurator } from "./changes.js";
import { checkCustom } from "./checks.js";

/*
 * Terms are the book's business words. A term backed by columns is a
 * dimension term; one with none is a concept term. A term is visible to
 * everyone signed in, and what hangs on it is filtered by what the caller may
 * describe: its columns by their dataset, its related metrics by theirs.
 * Names and aliases are one vocabulary, compared without regard to case, so a
 * word names at most one term and getTerm never has to guess.
 */

const LOCK_NAME = "powerbi_metrics_book.term";

export type TermInput = {
  name: string;
  definition?: string;
  /** Null until reviewed; an empty list says there are none. */
  aliases?: string[] | null;
  not_the_same_as?: string | null;
  /** A list, or a map from each value to what it means; null for none. */
  values?: unknown;
  owner?: string | null;
  /** Replaces the term's custom fields whole. */
  custom?: Record<string, unknown>;
};

type TermRow = typeof term.$inferSelect;
type TermState = TermRow & { columns: string[]; metrics: string[] };
type TrustState = (typeof TRUST_STATES)[number];

const invalid = (message: string) => new ServiceError("invalid", message);
const lower = (words: string[]) => words.map((word) => word.toLowerCase());
/** The term by id, name or alias. */
export async function resolveTerm(db: Db, reference: string): Promise<TermRow> {
  const rows = await db
    .select()
    .from(term)
    .where(
      or(
        looksLikeId(reference) ? eq(term.id, reference) : undefined,
        sql`lower(${term.name}) = lower(${reference})`,
        sql`exists (select 1 from unnest(${term.aliases}) as alias where lower(alias) = lower(${reference}))`,
      ),
    )
    .limit(6);
  const [found, ...others] = rows;
  if (found === undefined) {
    throw new ServiceError("not_found", `No term goes by "${reference}".`);
  }
  if (others.length > 0) {
    const names = rows.map((row) => `${row.name} (${row.id})`).join(", ");
    throw invalid(
      `Several terms go by "${reference}": ${names}. Use the id of one of them.`,
    );
  }
  return found;
}

async function withLinks(db: Db, row: TermRow): Promise<TermState> {
  // One after the other: a transaction has one connection.
  const columns = await db
    .select({ id: termColumn.column_id })
    .from(termColumn)
    .where(eq(termColumn.term_id, row.id))
    .orderBy(asc(termColumn.column_id));
  const metrics = await db
    .select({ id: termMetric.metric_id })
    .from(termMetric)
    .where(eq(termMetric.term_id, row.id))
    .orderBy(asc(termMetric.metric_id));
  return {
    ...row,
    columns: columns.map((link) => link.id),
    metrics: metrics.map((link) => link.id),
  };
}

async function reload(db: Db, termId: string): Promise<TermState | null> {
  const [row] = await db.select().from(term).where(eq(term.id, termId));
  return row === undefined ? null : withLinks(db, row);
}

/** One of the words is already a name or alias of another term. */
async function refuseTakenWords(db: Db, words: string[], termId?: string) {
  const wanted = lower(words);
  const taken = await db
    .select({ name: term.name, aliases: term.aliases })
    .from(term)
    .where(
      and(
        termId === undefined ? undefined : ne(term.id, termId),
        or(
          inArray(sql`lower(${term.name})`, wanted),
          sql`exists (select 1 from unnest(${term.aliases}) as alias where lower(alias) in ${wanted})`,
        ),
      ),
    )
    .limit(1);
  const [other] = taken;
  if (other === undefined) return;
  const theirs = lower([other.name, ...(other.aliases ?? [])]);
  const shared = words
    .filter((word) => theirs.includes(word.toLowerCase()))
    .map((word) => `"${word}"`);
  throw new ServiceError(
    "conflict",
    `The term "${other.name}" already goes by ${shared.join(" and ")}. Use that term, or pick another word.`,
  );
}

/** Refuses a concept word only when it names a visible column backing a dimension term. */
async function refuseConceptOnColumn(
  context: ServiceContext,
  db: Db,
  words: string[],
) {
  const allowed = await context.access.describableDatasets(context.principal);
  const hides = !(await readsPii(context));
  const [match] = await db
    .select({ column: powerbiColumn.name, term: term.name })
    .from(termColumn)
    .innerJoin(powerbiColumn, eq(powerbiColumn.id, termColumn.column_id))
    .innerJoin(powerbiTable, eq(powerbiTable.id, powerbiColumn.table_id))
    .innerJoin(powerbiDataset, eq(powerbiDataset.id, powerbiColumn.dataset_id))
    .innerJoin(term, eq(term.id, termColumn.term_id))
    .where(
      and(
        columnVisibleTo(term.id, allowed, hides),
        inArray(sql`lower(${powerbiColumn.name})`, lower(words)),
      ),
    )
    .limit(1);
  if (match === undefined) return;
  throw new ServiceError(
    "conflict",
    `"${match.column}" is the name of a column that already backs the term "${match.term}", and a concept term has no column behind it. Define the word on "${match.term}": add it as an alias or extend its definition.`,
  );
}

/** What the caller may write into a term, with the text trimmed and the shapes checked. */
function cleaned(input: Partial<TermInput>) {
  const name = input.name?.trim();
  if (name === "") throw invalid("Give the term a name.");
  const aliases =
    input.aliases === null ? null : input.aliases?.map((alias) => alias.trim());
  if (aliases?.includes("")) throw invalid("An alias cannot be blank.");
  const { values } = input;
  if (values !== undefined && values !== null && typeof values !== "object") {
    throw invalid(
      "A term's values are a list, or a map from each value to what it means.",
    );
  }
  return { name, aliases };
}

const record = (
  tx: Db,
  emit: (event: NewEvent) => void,
  principal: Principal,
  action: string,
  subject: { id: string; name: string },
  before: TermState | null,
  after: TermState | null,
) => {
  emit({
    kind: "term.changed",
    element_kind: "term",
    element_id: subject.id,
    principal,
    data: { action, name: subject.name },
  });
  return recordBookChange(tx, {
    principal,
    element_kind: "term",
    element_id: subject.id,
    action,
    before,
    after,
  });
};

const lockTerms = (tx: Db) =>
  tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${LOCK_NAME}, 0))`,
  );

/**
 * Finds the term inside a transaction under the terms lock (so the checks in
 * `work` hold until it commits), lets `work` change it, and records what
 * differs. A change that changes nothing records nothing.
 */
async function amend(
  context: ServiceContext,
  reference: string,
  action: string,
  work: (tx: Db, before: TermState) => Promise<void>,
): Promise<string> {
  await requireCurator(context);
  return withEvents(context.db, async (tx, emit) => {
    await lockTerms(tx);
    const before = await withLinks(tx, await resolveTerm(tx, reference));
    await work(tx, before);
    const after = await reload(tx, before.id);
    if (after === null || !isDeepStrictEqual(after, before)) {
      await record(tx, emit, context.principal, action, before, before, after);
    }
    return before.id;
  });
}

export async function createTerm(context: ServiceContext, input: TermInput) {
  await requireCurator(context);
  const { aliases } = cleaned(input);
  const name = input.name.trim();
  const id = randomUUID();
  await withEvents(context.db, async (tx, emit) => {
    await lockTerms(tx);
    await refuseTakenWords(tx, [name, ...(aliases ?? [])]);
    await refuseConceptOnColumn(context, tx, [name, ...(aliases ?? [])]);
    if (input.custom !== undefined) {
      const { term_fields } = await currentConventions(tx);
      checkCustom(term_fields.custom, input.custom);
    }
    await tx.insert(term).values({
      id,
      name,
      definition: input.definition,
      aliases,
      not_the_same_as: input.not_the_same_as,
      values: input.values,
      owner: input.owner,
      custom: input.custom,
    });
    await record(
      tx,
      emit,
      context.principal,
      "create",
      { id, name },
      null,
      await reload(tx, id),
    );
  });
  return getTerm(context, id);
}

/** Checks renamed concept words against columns visible to the caller. */
export async function updateTerm(
  context: ServiceContext,
  reference: string,
  changes: Partial<TermInput>,
) {
  const id = await amend(context, reference, "update", async (tx, before) => {
    const { name, aliases } = cleaned(changes);
    const words = [
      name ?? before.name,
      ...((aliases === undefined ? before.aliases : aliases) ?? []),
    ];
    if (name !== undefined || aliases !== undefined) {
      await refuseTakenWords(tx, words, before.id);
      if (!(await hasVisibleColumns(context, tx, before.id)))
        await refuseConceptOnColumn(context, tx, words);
    }
    if (changes.custom !== undefined) {
      const { term_fields } = await currentConventions(tx);
      checkCustom(term_fields.custom, changes.custom);
    }
    const set = {
      ...(name !== undefined && { name }),
      ...(changes.definition !== undefined && {
        definition: changes.definition,
      }),
      ...(aliases !== undefined && { aliases }),
      ...(changes.not_the_same_as !== undefined && {
        not_the_same_as: changes.not_the_same_as,
      }),
      ...(changes.values !== undefined && { values: changes.values }),
      ...(changes.owner !== undefined && { owner: changes.owner }),
      ...(changes.custom !== undefined && { custom: changes.custom }),
    };
    if (!isDeepStrictEqual({ ...before, ...set }, before)) {
      await tx.update(term).set(set).where(eq(term.id, before.id));
    }
  });
  return getTerm(context, id);
}

export async function deleteTerm(
  context: ServiceContext,
  reference: string,
): Promise<void> {
  await amend(context, reference, "delete", async (tx, before) => {
    await tx.delete(term).where(eq(term.id, before.id));
  });
}

/**
 * The column, among those in datasets the caller may describe. A column the
 * sync saw go, or one in a dataset it saw go, is found only when `removed` is
 * set, so a link to it can still be cut.
 */
async function resolveColumn(
  context: ServiceContext,
  tx: Db,
  columnId: string,
  options: { removed: boolean },
) {
  const allowed = await context.access.describableDatasets(context.principal);
  const hides = !(await readsPii(context));
  const [found] = await tx
    .select({ id: powerbiColumn.id })
    .from(powerbiColumn)
    .innerJoin(powerbiTable, eq(powerbiTable.id, powerbiColumn.table_id))
    .where(
      and(
        eq(powerbiColumn.id, columnId),
        hides ? not(piiColumn(powerbiColumn, powerbiTable)) : undefined,
        options.removed ? undefined : isNull(powerbiColumn.removed_at),
        inArray(
          powerbiColumn.dataset_id,
          tx
            .select({ id: powerbiDataset.id })
            .from(powerbiDataset)
            .where(
              and(
                allowed,
                options.removed ? undefined : isNull(powerbiDataset.removed_at),
              ),
            ),
        ),
      ),
    );
  if (found === undefined) {
    throw new ServiceError("not_found", "No such column.");
  }
}

/** Makes the term a dimension term over this column too; linking twice does nothing. */
export async function linkColumn(
  context: ServiceContext,
  reference: string,
  columnId: string,
) {
  const id = await amend(
    context,
    reference,
    "link_column",
    async (tx, before) => {
      await resolveColumn(context, tx, columnId, { removed: false });
      await tx
        .insert(termColumn)
        .values({ term_id: before.id, column_id: columnId })
        .onConflictDoNothing();
    },
  );
  return getTerm(context, id);
}

/** Unlinking the last visible column checks the term as a concept for this caller. */
export async function unlinkColumn(
  context: ServiceContext,
  reference: string,
  columnId: string,
) {
  const id = await amend(
    context,
    reference,
    "unlink_column",
    async (tx, before) => {
      await resolveColumn(context, tx, columnId, { removed: true });
      await tx
        .delete(termColumn)
        .where(
          and(
            eq(termColumn.term_id, before.id),
            eq(termColumn.column_id, columnId),
          ),
        );
      if (
        before.columns.includes(columnId) &&
        !(await hasVisibleColumns(context, tx, before.id))
      ) {
        await refuseConceptOnColumn(context, tx, [
          before.name,
          ...(before.aliases ?? []),
        ]);
      }
    },
  );
  return getTerm(context, id);
}

/** The metric by id or key, among those the caller may see. */
async function resolveMetric(
  context: ServiceContext,
  tx: Db,
  reference: string,
): Promise<string> {
  const allowed = await context.access.describableDatasets(context.principal);
  const hides = !(await readsPii(context));
  const [found] = await tx
    .select({ id: metric.id })
    .from(metric)
    .where(
      and(byIdOrName(metric, reference), visibleMetric(tx, allowed, hides)),
    );
  if (found === undefined) {
    throw new ServiceError("not_found", `No such metric: ${reference}.`);
  }
  return found.id;
}

export async function relateMetric(
  context: ServiceContext,
  reference: string,
  metricReference: string,
) {
  const id = await amend(
    context,
    reference,
    "relate_metric",
    async (tx, before) => {
      await tx
        .insert(termMetric)
        .values({
          term_id: before.id,
          metric_id: await resolveMetric(context, tx, metricReference),
        })
        .onConflictDoNothing();
    },
  );
  return getTerm(context, id);
}

export async function unrelateMetric(
  context: ServiceContext,
  reference: string,
  metricReference: string,
) {
  const id = await amend(
    context,
    reference,
    "unrelate_metric",
    async (tx, before) => {
      await tx
        .delete(termMetric)
        .where(
          and(
            eq(termMetric.term_id, before.id),
            eq(
              termMetric.metric_id,
              await resolveMetric(context, tx, metricReference),
            ),
          ),
        );
    },
  );
  return getTerm(context, id);
}

/**
 * A live column behind this term in a dataset this caller may describe, and
 * not a PII column when the caller may not read PII: what a term shows and
 * what its list counts. Its query joins the column's table and dataset.
 */
const columnVisibleTo = (
  termId: string | SQLWrapper,
  allowed: SQL,
  hidesPii: boolean,
) =>
  and(
    eq(termColumn.term_id, termId),
    isNull(powerbiColumn.removed_at),
    isNull(powerbiDataset.removed_at),
    eq(powerbiDataset.enabled, true),
    allowed,
    hidesPii ? not(piiColumn(powerbiColumn, powerbiTable)) : undefined,
  );

/** Tests whether the caller can see a backing column in this transaction. */
async function hasVisibleColumns(context: ServiceContext, db: Db, id: string) {
  const allowed = await context.access.describableDatasets(context.principal);
  const hides = !(await readsPii(context));
  const [column] = await db
    .select({ id: powerbiColumn.id })
    .from(termColumn)
    .innerJoin(powerbiColumn, eq(powerbiColumn.id, termColumn.column_id))
    .innerJoin(powerbiTable, eq(powerbiTable.id, powerbiColumn.table_id))
    .innerJoin(powerbiDataset, eq(powerbiDataset.id, powerbiColumn.dataset_id))
    .where(columnVisibleTo(id, allowed, hides))
    .limit(1);
  return column !== undefined;
}

/** Anyone signed in may read a term; its columns and metrics are those the caller may describe. */

export async function getTerm(context: ServiceContext, reference: string) {
  const row = await resolveTerm(context.db, reference);
  const allowed = await context.access.describableDatasets(context.principal);
  const { db } = context;
  const hides = !(await readsPii(context));
  const columns = await db
    .select({
      id: powerbiColumn.id,
      name: powerbiColumn.name,
      data_type: powerbiColumn.data_type,
      table_id: powerbiTable.id,
      table_name: powerbiTable.name,
      dataset_id: powerbiDataset.id,
      dataset_name: powerbiDataset.name,
      workspace_id: powerbiWorkspace.id,
      workspace_name: powerbiWorkspace.name,
    })
    .from(termColumn)
    .innerJoin(powerbiColumn, eq(powerbiColumn.id, termColumn.column_id))
    .innerJoin(powerbiTable, eq(powerbiTable.id, powerbiColumn.table_id))
    .innerJoin(powerbiDataset, eq(powerbiDataset.id, powerbiColumn.dataset_id))
    .innerJoin(
      powerbiWorkspace,
      eq(powerbiWorkspace.id, powerbiDataset.workspace_id),
    )
    .where(columnVisibleTo(row.id, allowed, hides))
    .orderBy(
      asc(powerbiWorkspace.name),
      asc(powerbiDataset.name),
      asc(powerbiTable.name),
      asc(powerbiColumn.name),
      asc(powerbiColumn.id),
    );
  const metrics = await db
    .select({
      id: metric.id,
      name: metric.name,
      label: metric.label,
      definition: metric.definition,
      trust_state: metric.trust_state,
    })
    .from(termMetric)
    .innerJoin(metric, eq(metric.id, termMetric.metric_id))
    .where(
      and(eq(termMetric.term_id, row.id), visibleMetric(db, allowed, hides)),
    )
    .orderBy(asc(metric.name));
  const questions = await openQuestionsFor(db, { kind: "term", id: row.id });
  return {
    kind: "term" as const,
    id: row.id,
    name: row.name,
    icon: row.icon,
    type: columns.length > 0 ? ("dimension" as const) : ("concept" as const),
    definition: row.definition,
    aliases: row.aliases,
    not_the_same_as: row.not_the_same_as,
    values: row.values,
    owner: row.owner,
    trust_state: row.trust_state,
    custom: row.custom,
    columns: columns.map((column) => ({
      ...ref("column", column.id, column.name),
      data_type: column.data_type,
      table: ref("table", column.table_id, column.table_name),
      dataset: ref("dataset", column.dataset_id, column.dataset_name),
      workspace: ref("workspace", column.workspace_id, column.workspace_name),
    })),
    metrics: metrics.map((related) => ({
      ...ref("metric", related.id, related.name),
      label: related.label,
      summary: related.definition.slice(0, 240),
      trust_state: related.trust_state,
    })),
    ...questions,
  };
}

export type TermFilters = {
  /** Only terms with a backing column in this dataset, workspace or app (id or name). */
  dataset?: string;
  workspace?: string;
  app?: string;
  trust_states?: TrustState[];
  /** Custom fields to match, as text: { owner_team: "finance" }. */
  custom?: Record<string, string>;
  name_prefix?: string;
  /** `cursor` is the `next_cursor` of the page before. */
  cursor?: string;
  limit?: number;
};

/** Terms with a backing column the caller may describe in the dataset, workspace or app asked for. */
function backedWhere(
  db: Db,
  allowed: SQL,
  seen: SQL | undefined,
  filters: TermFilters,
  hidesPii: boolean,
) {
  const { dataset, workspace, app } = filters;
  if (dataset === undefined && workspace === undefined && app === undefined) {
    return undefined;
  }
  return exists(
    db
      .select({ one: sql`1` })
      .from(termColumn)
      .innerJoin(powerbiColumn, eq(powerbiColumn.id, termColumn.column_id))
      .innerJoin(powerbiTable, eq(powerbiTable.id, powerbiColumn.table_id))
      .innerJoin(
        powerbiDataset,
        eq(powerbiDataset.id, powerbiColumn.dataset_id),
      )
      .where(
        and(
          columnVisibleTo(term.id, allowed, hidesPii),
          dataset === undefined
            ? undefined
            : byIdOrName(powerbiDataset, dataset),
          workspace === undefined ? undefined : inWorkspace(db, workspace),
          app === undefined ? undefined : inApp(db, app, seen),
        ),
      ),
  );
}

export async function listTerms(
  context: ServiceContext,
  filters: TermFilters = {},
): Promise<Page<ReturnType<typeof anchorOf>>> {
  const allowed = await context.access.describableDatasets(context.principal);
  const hides = !(await readsPii(context));
  const limit = sizeOf(filters.limit);
  const prefix = filters.name_prefix?.toLowerCase();
  const rows = await context.db
    .select({
      id: term.id,
      name: term.name,
      icon: term.icon,
      definition: term.definition,
      aliases: term.aliases,
      owner: term.owner,
      trust_state: term.trust_state,
      custom: term.custom,
      column_count: context.db
        .select({ count: count().as("count") })
        .from(termColumn)
        .innerJoin(powerbiColumn, eq(powerbiColumn.id, termColumn.column_id))
        .innerJoin(powerbiTable, eq(powerbiTable.id, powerbiColumn.table_id))
        .innerJoin(
          powerbiDataset,
          eq(powerbiDataset.id, powerbiColumn.dataset_id),
        )
        .where(columnVisibleTo(term.id, allowed, hides))
        .as("column_count"),
    })
    .from(term)
    .where(
      and(
        backedWhere(
          context.db,
          allowed,
          await appsSeen(context, allowed),
          filters,
          hides,
        ),
        filters.trust_states === undefined
          ? undefined
          : inArray(term.trust_state, filters.trust_states),
        ...Object.entries(filters.custom ?? {}).map(
          ([key, value]) => sql`${term.custom} ->> ${key} = ${value}`,
        ),
        prefix === undefined
          ? undefined
          : sql`starts_with(lower(${term.name}), ${prefix})`,
        afterCursor(term, filters.cursor),
      ),
    )
    .orderBy(asc(term.name), asc(term.id))
    .limit(limit + 1);
  const page = pageOf(rows, limit);
  return { items: page.items.map(anchorOf), next_cursor: page.next_cursor };
}

function anchorOf(row: {
  id: string;
  name: string;
  icon: string | null;
  definition: string;
  aliases: string[] | null;
  owner: string | null;
  trust_state: TrustState;
  custom: Record<string, unknown>;
  column_count: number;
}) {
  return {
    kind: "term" as const,
    id: row.id,
    name: row.name,
    icon: row.icon,
    type: row.column_count > 0 ? ("dimension" as const) : ("concept" as const),
    summary: row.definition.slice(0, 240),
    aliases: row.aliases,
    owner: row.owner,
    trust_state: row.trust_state,
    column_count: row.column_count,
    custom: row.custom,
  };
}
