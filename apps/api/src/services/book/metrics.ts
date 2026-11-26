import { metricVisibility } from "./visibility.js";
import { documentationError } from "./documentation-errors.js";
import { relationsForMetric } from "./relations.js";
import { ownerOf } from "./ownership.js";
import { isDeepStrictEqual } from "node:util";
import { lockAsAdmin } from "../admin/people.js";
import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  exists,
  inArray,
  isNull,
  ne,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import type { Db, ServiceContext } from "../../context.js";
import {
  bookChange,
  metric,
  metricVariant,
  metricEdge,
  metricLink,
  type ORIGINS,
  term,
  termMetric,
  TRUST_STATES,
} from "../../db/schema/book.js";
import type { EventKind } from "../../db/schema/events.js";
import {
  powerbiDataset,
  powerbiMeasure,
  powerbiWorkspace,
} from "../../db/schema/mirror.js";
import { ServiceError } from "../../errors.js";
import { excerpt } from "../text.js";
import type { Conventions } from "../conventions/schema.js";
import { currentConventions } from "../conventions/store.js";
import { namesOf, REMOVED_PERSON, whoKey } from "../auth/people.js";
import { type NewEvent, withEvents } from "../events/feed.js";
import {
  afterCursor,
  containsName,
  aliasContainsName,
  byIdOrName,
  appsSeen,
  inApp,
  inWorkspace,
  looksLikeId,
  pageOf,
  ref,
  sizeOf,
  startsWith,
  unlessPii,
  visibleMetric,
} from "../mirror/read.js";
import { lex } from "../../dax/tokens.js";
import { foldNames, piiNamesAmong, readsPii } from "../pii/rules.js";
import { openQuestionsFor } from "../threads/open-questions.js";
import { loadTree, type Tree } from "./categories.js";
import { BOOK, recordBookChange, requireCurator } from "./changes.js";
import {
  checkCustom,
  checkMetric,
  type CheckResult,
  exceptionIndex,
  LABELS_NAMED,
  wordsComparedWithOtherLabels,
} from "./checks.js";
import { axesKey, baseVariant, standsAlone } from "./drafter.js";

/*
 * Curation of metrics. A metric is found by key, alias or id among those the
 * caller may see. Every change locks the metric's row, records a book_change
 * and an event, and settles the metric's trust in `settle`.
 */

export type MetricRow = typeof metric.$inferSelect;
type TrustState = (typeof TRUST_STATES)[number];

const invalid = (message: string, detail?: Record<string, unknown>) =>
  new ServiceError("invalid", message, detail);
const conflict = (message: string, detail?: Record<string, unknown>) =>
  new ServiceError("conflict", message, detail);

/** The measure is in Power BI and its dataset is enabled. */
export const liveMeasure = and(
  isNull(powerbiMeasure.removed_at),
  isNull(powerbiDataset.removed_at),
  eq(powerbiDataset.enabled, true),
);

/**
 * A live variant of this metric in a dataset this caller may describe, and not
 * on a PII measure when the caller may not read PII. Its query joins the
 * variant's measure and dataset.
 */
export const variantVisibleTo = (
  metricId: string | SQLWrapper,
  allowed: SQL,
  hidesPii: boolean,
) =>
  and(
    eq(metricVariant.metric_id, metricId),
    allowed,
    liveMeasure,
    unlessPii(hidesPii),
  );

/**
 * The datasets a metric's variants are in now. A metric event records them,
 * so the change feed can still tell who could see the metric once it is gone;
 * no dataset at all means everyone could, as visibleMetric has it.
 */
export async function datasetsOf(db: Db, metricId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: powerbiMeasure.dataset_id })
    .from(metricVariant)
    .innerJoin(powerbiMeasure, eq(powerbiMeasure.id, metricVariant.measure_id))
    .where(eq(metricVariant.metric_id, metricId))
    .orderBy(asc(powerbiMeasure.dataset_id));
  return rows.map((row) => row.id);
}

/**
 * The variants with the PII columns left out of their `selection_columns`,
 * for a caller who may not read PII. A column is written `[C]` or `'T'[C]` and
 * is judged as the query check judges a reference, in the variant's dataset.
 */
export async function withoutPiiSelection<
  V extends { dataset: { id: string }; selection_columns: string[] },
>(context: ServiceContext, variants: V[]): Promise<V[]> {
  if (await readsPii(context)) return variants;
  const { db } = context;
  const written = variants.flatMap((variant) =>
    variant.selection_columns.map((source) => {
      const [first, second] = lex(source);
      return second === undefined
        ? { table: "", column: first?.name ?? "" }
        : { table: first?.name ?? "", column: second.name };
    }),
  );
  if (written.length === 0) return variants;
  const tables = await foldNames(
    db,
    written.map((one) => one.table),
  );
  const columns = await foldNames(
    db,
    written.map((one) => one.column),
  );
  const names = await piiNamesAmong(
    db,
    [...new Set(variants.map((variant) => variant.dataset.id))],
    columns,
  );
  let at = 0;
  return variants.map((variant) => {
    const pii = names.get(variant.dataset.id);
    return {
      ...variant,
      selection_columns: variant.selection_columns.filter(() => {
        const table = tables[at] ?? "";
        const column = columns[at++] ?? "";
        if (pii === undefined) return true;
        if (table === "") return !pii.bare.has(column);
        const cleared = pii.ruleTables.get(table);
        return !(
          pii.columns.get(table)?.has(column) ||
          pii.ruleColumns.get(table)?.has(column) ||
          pii.measures.get(table)?.has(column) ||
          pii.ruleMeasures.get(table)?.has(column) ||
          (cleared !== undefined &&
            !cleared.has(column) &&
            !pii.knownMeasures.get(table)?.has(column))
        );
      }),
    };
  });
}

/** How a variant reaches its measure, and the measure its dataset. */
export const toMeasure = eq(powerbiMeasure.id, metricVariant.measure_id);
export const toDataset = eq(powerbiDataset.id, powerbiMeasure.dataset_id);

type Named = { id: string; name: string };

/** A variant as every answer names it: where its measure is, and what it reads of the selection. */
export const variantAnchor = (variant: {
  id: string;
  measure: Named;
  dataset: Named;
  workspace: Named;
  reads_selection: boolean;
  selection_columns: string[];
}) => ({
  kind: "variant" as const,
  id: variant.id,
  dataset: ref("dataset", variant.dataset.id, variant.dataset.name),
  workspace: ref("workspace", variant.workspace.id, variant.workspace.name),
  measure: ref("measure", variant.measure.id, variant.measure.name),
  // How DAX names the measure: in brackets, a closing bracket doubled.
  measure_reference: `[${variant.measure.name.replaceAll("]", "]]")}]`,
  reads_selection: variant.reads_selection,
  selection_columns: variant.selection_columns,
});

/**
 * The metric by key, alias or id among those `allowed` lets the caller see; a
 * key or id wins over an alias. Each step finds its rows before it asks whether
 * they are visible: asked of a condition the planner cannot size, visibility is
 * planned for every metric, and reads every variant to answer for one.
 */
export async function resolveMetric(
  db: Db,
  allowed: SQL,
  hidesPii: boolean,
  reference: string,
): Promise<MetricRow> {
  const visible = visibleMetric(db, allowed, hidesPii);
  const [named] = await db
    .select()
    .from(metric)
    .where(
      and(
        or(
          eq(metric.name, reference),
          looksLikeId(reference) ? eq(metric.id, reference) : undefined,
        ),
        visible,
      ),
    )
    .orderBy(asc(metric.name))
    .limit(1);
  if (named !== undefined) return named;
  const aliased = await db
    .select({ id: metric.id })
    .from(metric)
    .where(
      sql`exists (select 1 from unnest(${metric.aliases}) as alias where lower(alias) = lower(${reference}))`,
    );
  const rows = await db
    .select()
    .from(metric)
    .where(
      and(
        inArray(
          metric.id,
          aliased.map(({ id }) => id),
        ),
        visible,
      ),
    )
    .orderBy(asc(metric.name))
    .limit(6);
  const [first, ...others] = rows;
  if (first === undefined) {
    throw new ServiceError(
      "not_found",
      `No metric goes by "${reference}". search finds a metric by a word, and list_metrics lists the metrics by key.`,
    );
  }
  if (others.length === 0) return first;
  const names = rows.map(({ name }) => name).join(", ");
  throw invalid(
    `Several metrics have the alias "${reference}": ${names}. Use the key of one of them.`,
  );
}

/** Locks the metric's row until the transaction ends, and reads it as it is now. */
export async function lockMetric(tx: Db, id: string): Promise<MetricRow> {
  const [row] = await tx
    .select()
    .from(metric)
    .where(eq(metric.id, id))
    .for("update");
  if (row === undefined) throw new ServiceError("not_found", "No such metric.");
  return row;
}

/**
 * Only the labels of metrics the caller may see, since a check's answer names
 * them. A page reads only the ones that may hold a word the check compares: the
 * filter may keep too many, and the check decides, since `ilike` also matches
 * inside a word, and `_` stands for ς because JavaScript lowers a final Σ to ς
 * and Postgres to σ. It can also miss a letter the database does not lower as
 * Node does. That costs a page a warning, and must not pass a verification, so
 * anything else reads every label.
 */
async function checksOf(
  db: Db,
  row: MetricRow,
  conventions: Conventions,
  allowed: SQL,
  hidesPii: boolean,
  labels: "every" | "for_a_page" = "every",
  advise = true,
): Promise<CheckResult[]> {
  const words = wordsComparedWithOtherLabels(row, conventions);
  const others =
    words.length === 0
      ? []
      : await db
          .select({ label: metric.label })
          .from(metric)
          .where(
            and(
              ne(metric.id, row.id),
              isNull(metric.dismissed_at),
              labels === "every"
                ? undefined
                : sql`${metric.label} ilike any(${sql.param(words.map((word) => `%${word.replaceAll("ς", "_")}%`))}::text[])`,
              visibleMetric(db, allowed, hidesPii),
            ),
          )
          .orderBy(asc(metric.label));
  const [bases] = await liveVariants(db, eq(metric.id, row.id));
  const termNames = row.primary_dimensions.length
    ? await db.select({ name: term.name }).from(term)
    : [];
  return checkMetric(row, {
    term_names: new Set(termNames.map((t) => t.name)),
    conventions,
    exceptions: exceptionIndex(conventions),
    other_labels: others.map((other) => other.label),
    live_base_variants: (bases?.live ?? 0) - (bases?.other ?? 0),
    live_other_variants: bases?.other ?? 0,
    advise,
  });
}

/** For each metric `which` picks that has any, how many live variants it has at its base or filed `other`, and how many of them are `other`. */
export const liveVariants = (db: Db, which: SQL | undefined) =>
  db
    .select({
      metric_id: metricVariant.metric_id,
      live: count(),
      other:
        sql<number>`count(*) filter (where ${metricVariant.period} = 'other')`.mapWith(
          Number,
        ),
    })
    .from(metricVariant)
    .innerJoin(metric, eq(metric.id, metricVariant.metric_id))
    .innerJoin(powerbiMeasure, toMeasure)
    .innerJoin(powerbiDataset, toDataset)
    .where(
      and(
        which,
        or(baseVariant, eq(metricVariant.period, "other")),
        liveMeasure,
      ),
    )
    .groupBy(metricVariant.metric_id);

/** How many metrics, and how many datasets of each, a page of one metric names; its checks list every label. */
const METRICS_NAMED = 5;
const DATASETS_NAMED = 3;

/**
 * The key and datasets of the metrics a check's labels name, as far as the
 * caller may see them: a metric whose every dataset is out of reach is not
 * here, and a dataset out of reach is not named. Dismissed metrics are left out.
 */
async function metricsSharing(
  db: Db,
  row: MetricRow,
  labels: string[],
  allowed: SQL,
  hides: boolean,
) {
  if (labels.length === 0) return [];
  const datasets = db
    .selectDistinct({ name: powerbiDataset.name })
    .from(metricVariant)
    .innerJoin(powerbiMeasure, toMeasure)
    .innerJoin(powerbiDataset, toDataset)
    .where(variantVisibleTo(metric.id, allowed, hides))
    .orderBy(asc(powerbiDataset.name))
    .limit(DATASETS_NAMED);
  return db
    .select({
      key: metric.name,
      label: metric.label,
      datasets: sql<string[]>`array(${datasets})`,
    })
    .from(metric)
    .where(
      and(
        ne(metric.id, row.id),
        inArray(metric.label, labels),
        isNull(metric.dismissed_at),
        visibleMetric(db, allowed, hides),
      ),
    )
    .orderBy(
      sql`array_position(${sql.param(labels)}::text[], ${metric.label})`,
      asc(metric.name),
    )
    .limit(METRICS_NAMED);
}

/** One change to the book, in its transaction, under the conventions in force. */
export type Change = {
  context: ServiceContext;
  tx: Db;
  emit: (event: NewEvent) => void;
  conventions: Conventions;
  /** The datasets the caller may describe, as a condition on powerbi_dataset. */
  allowed: SQL;
  /** Whether the caller may not read PII. */
  hidesPii: boolean;
  now: Date;
};

export const changeVisibility = async (context: ServiceContext) => ({
  allowed: await context.access.describableDatasets(context.principal),
  hidesPii: !(await readsPii(context)),
});

export const openChange = async (
  context: ServiceContext,
  tx: Db,
  emit: Change["emit"],
  visibility: Pick<Change, "allowed" | "hidesPii">,
): Promise<Change> => ({
  context,
  tx,
  emit,
  conventions: await currentConventions(tx),
  ...visibility,
  now: context.clock(),
});

/** The failing checks among those trust.agent_verify_requires names. */
async function verificationFailures(
  change: Change,
  row: MetricRow,
): Promise<CheckResult[]> {
  const { tx, conventions, allowed, hidesPii } = change;
  const required = conventions.trust.agent_verify_requires;
  const needed = required === "all_checks" ? null : new Set<string>(required);
  return (await checksOf(tx, row, conventions, allowed, hidesPii)).filter(
    (result) => !result.passed && (needed === null || needed.has(result.check)),
  );
}

const EVENTS: Record<string, EventKind> = {
  create: "metric.created",
  verify: "metric.verified",
  approve: "metric.approved",
};

async function record(
  change: Change,
  action: string,
  before: MetricRow | null,
  after: MetricRow | null,
  data: Record<string, unknown>,
): Promise<void> {
  const subject = after ?? before;
  if (subject === null) throw new Error("A change has a before or an after.");
  const { principal } = change.context;
  const renamed = before && after && before.name !== after.name;
  const [variants, datasets] = await Promise.all([
    change.tx
      .select({ id: metricVariant.measure_id })
      .from(metricVariant)
      .where(eq(metricVariant.metric_id, subject.id)),
    datasetsOf(change.tx, subject.id),
  ]);
  change.emit({
    kind: EVENTS[action] ?? "metric.changed",
    element_kind: "metric",
    element_id: subject.id,
    principal,
    data: {
      action,
      name: subject.name,
      ...(renamed ? { previous_name: before.name } : {}),
      trust_state: after?.trust_state ?? null,
      dataset_ids: datasets,
      measure_ids: variants.map(({ id }) => id),
      ...data,
    },
  });
  await recordBookChange(change.tx, {
    principal,
    element_kind: "metric",
    element_id: subject.id,
    action,
    before,
    after,
  });
}

/**
 * What a token's change leaves of the metric's trust: an agent's verification
 * is taken back, and a person's approval becomes an agent's while the checks
 * still pass. A change from a browser, as on the review page, keeps it.
 */
async function trustAfter(change: Change, row: MetricRow) {
  const { principal } = change.context;
  if (principal.via === "browser" || row.trust_state === "draft") return {};
  const passes =
    row.trust_state === "human_verified" &&
    (await verificationFailures(change, row)).length === 0;
  return passes
    ? {
        trust_state: "agent_verified" as const,
        verified_by: principal.id,
        verified_at: change.now,
      }
    : { trust_state: "draft" as const, verified_by: null, verified_at: null };
}

/**
 * Finishes a change to the metric `before` was: the first change touches it,
 * so the sync no longer regroups it, the trust is settled, and the change is
 * recorded. A row nobody changed is left alone unless `changed` says the
 * change was to its variants.
 */
export async function settle(
  change: Change,
  before: MetricRow,
  action: string,
  data: Record<string, unknown> = {},
  changed = false,
): Promise<void> {
  const { tx, now } = change;
  const [current] = await tx
    .select()
    .from(metric)
    .where(eq(metric.id, before.id));
  if (current === undefined) {
    await record(change, action, before, null, data);
    return;
  }
  if (!changed && isDeepStrictEqual(current, before)) return;
  const set = {
    touched_at: current.touched_at ?? now,
    updated_at: now,
    ...(await trustAfter(change, current)),
  };
  await tx.update(metric).set(set).where(eq(metric.id, before.id));
  await record(change, action, before, { ...current, ...set }, data);
}

/** Lets `work` change the metric in a transaction with its row locked, then settles the change. */
export async function amendMetric(
  context: ServiceContext,
  reference: string,
  action: string,
  work: (change: Change, before: MetricRow) => Promise<void>,
): Promise<string> {
  await requireCurator(context);
  const fallback =
    action === "owner"
      ? await context.settings.get("access.default_role")
      : undefined;
  const visibility = await changeVisibility(context);
  return withEvents(context.db, async (tx, emit) => {
    if (fallback !== undefined) await lockAsAdmin(context, tx, fallback);
    if (action === "delete")
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('metric_relations'))`,
      );
    const change = await openChange(context, tx, emit, visibility);
    const found = await resolveMetric(
      tx,
      change.allowed,
      change.hidesPii,
      reference,
    );
    const before = await lockMetric(tx, found.id);
    await work(change, before);
    await settle(change, before, action);
    return before.id;
  }).catch(documentationError);
}

/** Writes only what differs, so a change that changes nothing records nothing. */
async function apply(
  tx: Db,
  before: MetricRow,
  set: Partial<MetricRow>,
): Promise<void> {
  const current: Record<string, unknown> = before;
  // Drizzle skips an undefined value, so a field the caller left out is no change.
  const entries: [string, unknown][] = Object.entries(set);
  const differs = entries.some(
    ([key, value]) =>
      value !== undefined && !isDeepStrictEqual(current[key], value),
  );
  if (differs) await tx.update(metric).set(set).where(eq(metric.id, before.id));
}

type MetricFields = {
  label?: string;
  definition?: string;
  /** Null until reviewed; an empty list says there are none. */
  aliases?: string[] | null;
  tier?: string;
  importance?: string;
  direction?: string;
  importance_why?: string;
  use_for?: string;
  dont_use_for?: string;
  caveats?: string;
  decisions?: string;
  actions?: string;
  owner_team?: string;
  primary_dimensions?: string[];
  building_block?: boolean;
  when_to_use?: string;
  not_the_same_as?: string | null;
  grain_and_filters?: string;
  unit?: string | null;
  /** The category's key path (sales/orders); null files it in none. */
  category?: string | null;
  owner?: string | null;
  /** Replaces the metric's custom fields whole. */
  custom?: Record<string, unknown>;
};

/**
 * A reference finds a key before an alias, so an alias on another metric's key
 * would either never answer or, on a draft the sync named, take the key from it.
 * Says no more than a rename to that key does.
 */
async function refuseAliasesOnKeys(tx: Db, aliases: string[], own?: string) {
  const [held] = await tx
    .select({ word: sql<string>`lower(${metric.name})` })
    .from(metric)
    .where(
      and(
        // Folded by Postgres, as a reference is: JavaScript folds some letters otherwise.
        sql`lower(${metric.name}) = any(select lower(word) from unnest(${sql.param(aliases)}::text[]) as word)`,
        own === undefined ? undefined : ne(metric.id, own),
      ),
    )
    .limit(1);
  if (held !== undefined) throw taken(held.word);
}

/** The columns the fields set, refused where the conventions do not allow them. `own` is the metric they are for, once it exists. */
async function columnsOf(
  { tx, conventions }: Change,
  fields: MetricFields,
  own?: string,
) {
  const label = fields.label?.trim();
  if (label === "") throw invalid("Give the metric a label.");
  const aliases =
    fields.aliases === null ? null : fields.aliases?.map((a) => a.trim());
  if (aliases?.includes("")) throw invalid("An alias cannot be blank.");
  if (aliases !== null && aliases !== undefined)
    await refuseAliasesOnKeys(tx, aliases, own);
  for (const field of ["tier", "importance", "direction"] as const) {
    const value = fields[field];
    const values = conventions.metric_fields[field].values;
    if (value && !values.includes(value))
      throw invalid(`Choose ${field} from ${values.join(", ")}.`);
  }
  if (fields.primary_dimensions) {
    const names = new Set(
      (await tx.select({ name: term.name }).from(term)).map((t) => t.name),
    );
    for (const name of fields.primary_dimensions)
      if (!names.has(name))
        throw invalid(
          `Create the term ${name}, or choose a term already in the book.`,
        );
  }
  const { unit, custom } = fields;
  const units = conventions.metric_fields.unit.values;
  if (unit !== undefined && unit !== null && !units.includes(unit)) {
    throw invalid(
      `The unit ${unit} is not one the conventions name: ${units.join(", ")}.`,
    );
  }
  if (custom !== undefined)
    checkCustom(conventions.metric_fields.custom, custom);
  const category_id =
    fields.category === undefined || fields.category === null
      ? fields.category
      : (await loadTree(tx)).get(fields.category).id;
  return {
    label,
    definition: fields.definition,
    aliases,
    tier: fields.tier,
    importance: fields.importance,
    direction: fields.direction,
    importance_why: fields.importance_why,
    use_for: fields.use_for,
    dont_use_for: fields.dont_use_for,
    caveats: fields.caveats,
    decisions: fields.decisions,
    actions: fields.actions,
    owner_team: fields.owner_team,
    primary_dimensions: fields.primary_dimensions,
    building_block: fields.building_block,
    when_to_use: fields.when_to_use,
    not_the_same_as: fields.not_the_same_as,
    grain_and_filters: fields.grain_and_filters,
    unit,
    category_id,
    owner: fields.owner,
    custom,
  };
}

const keyOf = (name: string) => {
  const key = name.trim();
  if (key === "") throw invalid("Give the metric a key.");
  return key;
};
const taken = (name: string) =>
  conflict(
    `A metric already has the key ${name}. Pick another, or merge into that one.`,
  );

/**
 * A reference finds a key before an alias, so a key on another metric's alias
 * would take that word from it, and a reader of both would get the wrong metric.
 * The refusal says only that a word the caller supplied is someone's alias.
 */
async function refuseKeyOnAliases(tx: Db, name: string, own?: string) {
  const [held] = await tx
    .select({ id: metric.id })
    .from(metric)
    .where(
      and(
        sql`exists (select from unnest(${metric.aliases}) as alias where lower(alias) = lower(${name}))`,
        own === undefined ? undefined : ne(metric.id, own),
      ),
    )
    .limit(1);
  if (held !== undefined)
    throw conflict(
      `Another metric already has the alias ${name}. Pick another key, or merge into that one.`,
    );
}

export async function createMetric(
  context: ServiceContext,
  input: MetricFields & { name: string; label: string },
) {
  await requireCurator(context);
  const name = keyOf(input.name);
  const visibility = await changeVisibility(context);
  const id = await withEvents(context.db, async (tx, emit) => {
    const change = await openChange(context, tx, emit, visibility);
    const columns = await columnsOf(change, input);
    await refuseKeyOnAliases(tx, name);
    const [created] = await tx
      .insert(metric)
      .values({
        ...columns,
        name,
        label: input.label.trim(),
        origin: "curator",
        touched_at: change.now,
      })
      .onConflictDoNothing({ target: metric.name })
      .returning();
    if (created === undefined) throw taken(name);
    await record(change, "create", null, created, {});
    return created.id;
  }).catch(documentationError);
  return getMetric(context, id);
}

export async function updateMetric(
  context: ServiceContext,
  reference: string,
  fields: MetricFields,
) {
  const id = await amendMetric(
    context,
    reference,
    "update",
    async (change, before) => {
      await apply(
        change.tx,
        before,
        await columnsOf(change, fields, before.id),
      );
    },
  );
  return getMetric(context, id);
}

/** A new key, or the same one, which confirms a key the sync generated. */
export async function renameMetric(
  context: ServiceContext,
  reference: string,
  newName: string,
) {
  const name = keyOf(newName);
  const id = await amendMetric(
    context,
    reference,
    "rename",
    async ({ tx }, before) => {
      if (name !== before.name) {
        const [other] = await tx
          .select({ id: metric.id })
          .from(metric)
          .where(eq(metric.name, name));
        if (other !== undefined) throw taken(name);
        await refuseKeyOnAliases(tx, name, before.id);
      }
      await apply(tx, before, { name, name_is_generated: false });
    },
  );
  return getMetric(context, id);
}

/** Not a metric at all: it leaves lists and search, and the sync does not draft its measures again. */
export async function dismissMetric(
  context: ServiceContext,
  reference: string,
  reason: string,
) {
  const why = reason.trim();
  if (why === "") throw invalid("Say why the metric is dismissed.");
  const id = await amendMetric(
    context,
    reference,
    "dismiss",
    async (change, before) => {
      await apply(change.tx, before, {
        dismissed_at: before.dismissed_at ?? change.now,
        dismissed_reason: why,
      });
    },
  );
  return getMetric(context, id);
}

export async function deleteMetric(
  context: ServiceContext,
  reference: string,
): Promise<void> {
  await amendMetric(
    context,
    reference,
    "delete",
    async ({ tx, allowed, hidesPii }, before) => {
      const [held] = await tx
        .select({
          total: count(),
          visible:
            sql<number>`count(*) filter (where ${and(allowed, unlessPii(hidesPii))})`.mapWith(
              Number,
            ),
        })
        .from(metricVariant)
        .innerJoin(powerbiMeasure, toMeasure)
        .innerJoin(powerbiDataset, toDataset)
        .where(eq(metricVariant.metric_id, before.id));
      if (held === undefined) throw new Error("count returned no row");
      const { total, visible } = held;
      if (total > 0) {
        // Only the variants the caller may describe are counted; the rest are said to exist.
        const holds = [];
        if (visible > 0)
          holds.push(
            `${String(visible)} ${visible === 1 ? "variant" : "variants"}`,
          );
        if (total > visible) holds.push("some you cannot see");
        throw conflict(
          `${before.name} still has ${holds.join(", and ")}. Merge it into another metric, or move its variants, before you delete it.`,
        );
      }
      await refuseRelatedDeletion(tx, before.id);
      await tx.delete(metric).where(eq(metric.id, before.id));
    },
  );
}

/** A variant with its measure and dataset, and whether the caller may see it: its dataset described, and its measure not PII to one who may not read PII. */
export type Filed = {
  variant: typeof metricVariant.$inferSelect;
  measure: string;
  dataset_id: string;
  dataset: string;
  describable: boolean;
};

/** The metric's variants, locked until the transaction ends so that what was read is what moves. */
export const filedUnder = (
  { tx, allowed, hidesPii }: Change,
  metricId: string,
): Promise<Filed[]> =>
  tx
    .select({
      variant: metricVariant,
      measure: powerbiMeasure.name,
      dataset_id: powerbiDataset.id,
      dataset: powerbiDataset.name,
      describable: sql<boolean>`${and(allowed, unlessPii(hidesPii))}`,
    })
    .from(metricVariant)
    .innerJoin(powerbiMeasure, toMeasure)
    .innerJoin(powerbiDataset, toDataset)
    .where(eq(metricVariant.metric_id, metricId))
    .for("update", { of: metricVariant });

const shiftKey = ({ dataset_id, variant }: Filed) =>
  JSON.stringify([
    dataset_id,
    variant.period,
    variant.comparison,
    variant.comparison_period,
    axesKey(variant),
  ]);

/**
 * A metric holds one variant per shift in each dataset, so a second one
 * moving in is refused. The refusal names the clashes in datasets the caller
 * may describe and counts the rest.
 */
export async function refuseClashes(
  change: Change,
  into: MetricRow,
  moving: Filed[],
): Promise<void> {
  const ids = new Set(moving.map((filed) => filed.variant.id));
  const held = new Map(
    (await filedUnder(change, into.id))
      .filter((filed) => !ids.has(filed.variant.id))
      .map((filed) => [shiftKey(filed), filed]),
  );
  const clashes = moving.flatMap((filed) => {
    const other = held.get(shiftKey(filed));
    return other === undefined ? [] : [{ filed, other }];
  });
  if (clashes.length === 0) return;
  // Both variants are in one dataset, but one may be PII: a clash is named only when the caller sees both.
  const named = clashes
    .filter(({ filed, other }) => filed.describable && other.describable)
    .map(
      ({ filed, other }) =>
        `${filed.measure} and ${other.measure} in ${filed.dataset}`,
    );
  const hidden = clashes.length - named.length;
  const unseen =
    hidden === 0
      ? ""
      : `${named.length > 0 ? ", and " : ""}${String(hidden)} ${named.length > 0 ? "more " : ""}${hidden === 1 ? "clash" : "clashes"} you cannot see`;
  throw conflict(
    `${into.name} already holds a variant with the same shift in the same dataset: ${named.join("; ")}${unseen}. Give one of each pair another shift or file it under another metric first.`,
    { clashes: named, hidden },
  );
}

/** Moves every variant of `from` under `into` and deletes `from`; refused when their units differ. */
export async function mergeMetrics(
  context: ServiceContext,
  { from, into }: { from: string; into: string },
) {
  await requireCurator(context);
  const visibility = await changeVisibility(context);
  const id = await withEvents(context.db, async (tx, emit) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('metric_relations'))`,
    );
    const change = await openChange(context, tx, emit, visibility);
    const source = await resolveMetric(
      tx,
      change.allowed,
      change.hidesPii,
      from,
    );
    const target = await resolveMetric(
      tx,
      change.allowed,
      change.hidesPii,
      into,
    );
    if (source.id === target.id) {
      throw invalid(`${source.name} cannot be merged into itself.`);
    }
    // In id order, so two merges of the same pair wait rather than deadlock.
    const sourceFirst = source.id < target.id;
    const first = await lockMetric(tx, sourceFirst ? source.id : target.id);
    const second = await lockMetric(tx, sourceFirst ? target.id : source.id);
    const [gone, kept] = sourceFirst ? [first, second] : [second, first];
    if (gone.unit !== kept.unit) {
      const unitOf = (row: MetricRow) => row.unit ?? "no unit";
      throw conflict(
        `${gone.name} is in ${unitOf(gone)} and ${kept.name} in ${unitOf(kept)}. A metric with no unit has not been said to be the same one, and a wrong merge is worse than a missed one: if they are one metric, set the same unit on both first.`,
      );
    }
    const moving = await filedUnder(change, gone.id);
    await refuseClashes(change, kept, moving);
    // Read before the variants move: the merged-away metric's event keeps this scope.
    const goneDatasets = await datasetsOf(tx, gone.id);
    const goneMeasureIds = moving.map(({ variant }) => variant.measure_id);
    // assigned_by stays: a merge moves a variant without choosing its period, and a
    // sync's `other` that became a curator's would stop gathering later copies.
    // The kept metric is touched, so the sync still does not move what it holds.
    const moved = { metric_id: kept.id, assigned_at: change.now };
    await tx
      .update(metricVariant)
      .set(moved)
      .where(eq(metricVariant.metric_id, gone.id));
    for (const { variant, dataset_id } of moving) {
      await recordBookChange(tx, {
        principal: context.principal,
        element_kind: "variant",
        element_id: variant.id,
        action: "merge",
        before: variant,
        after: { ...variant, ...moved },
      });
      emit({
        kind: "variant.moved",
        element_kind: "variant",
        element_id: variant.id,
        principal: context.principal,
        data: {
          measure_id: variant.measure_id,
          from_metric_id: gone.id,
          to_metric_id: kept.id,
          dataset_id,
        },
      });
    }
    await refuseRelatedDeletion(tx, gone.id);
    await tx.delete(metric).where(eq(metric.id, gone.id));
    // Events carry ids, never another element's name: a reader may see one metric and not the other.
    await settle(change, gone, "merge", {
      into_metric_id: kept.id,
      dataset_ids: goneDatasets,
      measure_ids: goneMeasureIds,
    });
    await settle(change, kept, "merge", { from_metric_id: gone.id }, true);
    return kept.id;
  });
  return getMetric(context, id);
}

/**
 * human_verified means a person checked the metric, so only a person
 * approves, and from a browser session unless the conventions say
 * trust.human_verify_from: any. A policy cannot see how the caller signed
 * in, so this rule is code; approval_browser_only_security_test holds it.
 */
function refuseUnlessPerson(change: Change, reference: string): void {
  const { principal, config } = change.context;
  if (principal.kind !== "person") {
    throw new ServiceError(
      "refused",
      "Only a person approves a metric. Ask a curator to review it.",
    );
  }
  if (
    principal.via === "browser" ||
    change.conventions.trust.human_verify_from === "any"
  ) {
    return;
  }
  const page = new URL(
    `/catalog/metrics/${encodeURIComponent(reference)}`,
    config.public_base_url,
  );
  throw new ServiceError(
    "refused",
    `A person approves a metric in a browser, on its review page: ${page.href}. Ask for the review with pbmb metrics request-review ${reference}.`,
  );
}

/** Sets a trust state the checks must allow; a metric already there, or above, stays. */
async function promote(
  context: ServiceContext,
  reference: string,
  to: "agent_verified" | "human_verified",
): Promise<string> {
  const action = to === "agent_verified" ? "verify" : "approve";
  const visibility = await changeVisibility(context);
  return withEvents(context.db, async (tx, emit) => {
    const change = await openChange(context, tx, emit, visibility);
    if (to === "human_verified") refuseUnlessPerson(change, reference);
    const found = await resolveMetric(
      tx,
      change.allowed,
      change.hidesPii,
      reference,
    );
    const before = await lockMetric(tx, found.id);
    const failures = await verificationFailures(change, before);
    if (failures.length > 0) {
      const problems = failures.map((f) => `${f.rule}: ${f.message}`);
      throw invalid(
        `${before.name} cannot be ${action === "verify" ? "verified" : "approved"} while a check fails. ${problems.join(" ")}`,
        { failures },
      );
    }
    const rank = (state: TrustState) => TRUST_STATES.indexOf(state);
    if (rank(before.trust_state) >= rank(to)) return before.id;
    const set = {
      trust_state: to,
      verified_by: context.principal.id,
      verified_at: change.now,
      touched_at: before.touched_at ?? change.now,
      updated_at: change.now,
    };
    await tx.update(metric).set(set).where(eq(metric.id, before.id));
    await record(change, action, before, { ...before, ...set }, {});
    return before.id;
  });
}

/** agent_verified, when every check trust.agent_verify_requires names passes. */
export async function verifyMetric(context: ServiceContext, reference: string) {
  await context.access.require(context.principal, BOOK, "verify");
  return getMetric(
    context,
    await promote(context, reference, "agent_verified"),
  );
}

/** human_verified, when the checks pass; see refuseUnlessPerson for who may. */
export async function approveMetric(
  context: ServiceContext,
  reference: string,
) {
  await context.access.require(context.principal, BOOK, "approve");
  return getMetric(
    context,
    await promote(context, reference, "human_verified"),
  );
}

export async function metricHistory(
  context: ServiceContext,
  reference: string,
) {
  await requireCurator(context);
  const allowed = await context.access.describableDatasets(context.principal);
  const hides = !(await readsPii(context));
  const found = await resolveMetric(context.db, allowed, hides, reference);
  const changes = await context.db
    .select()
    .from(bookChange)
    .where(
      and(
        eq(bookChange.element_kind, "metric"),
        eq(bookChange.element_id, found.id),
      ),
    )
    .orderBy(asc(bookChange.id));
  const names = await namesOf(
    context.db,
    changes.flatMap(({ principal_kind: kind, principal_id: id }) =>
      kind === "system" ? [] : [{ kind, id }],
    ),
    "name",
  );
  return changes.map((change) => ({
    ...change,
    principal_name:
      change.principal_kind === "system"
        ? "the system"
        : (names.get(
            whoKey({ kind: change.principal_kind, id: change.principal_id }),
          ) ?? REMOVED_PERSON),
  }));
}

/** Every check the conventions leave on, passing and failing, for a metric the caller may see. */
export async function metricChecks(
  context: ServiceContext,
  reference: string,
): Promise<CheckResult[]> {
  await requireCurator(context);
  const allowed = await context.access.describableDatasets(context.principal);
  const hides = !(await readsPii(context));
  const found = await resolveMetric(context.db, allowed, hides, reference);
  return checksOf(
    context.db,
    found,
    await currentConventions(context.db),
    allowed,
    hides,
  );
}

const categoryOf = (tree: Tree, id: string | null) => {
  const found = tree.rows.find((row) => row.id === id);
  return found === undefined ? null : tree.anchor(found);
};

/** The metric with its base variant in each dataset the caller may describe, and the rest counted by shift. */
/**
 * The display name of whoever last verified or approved the metric. The row
 * keeps only an id, so the kind is that of the change which set it: the
 * latest one that left `verified_by` at this id from another value. A later
 * change by a principal of the same id, as a person's edit, did not set it.
 */
async function verifierName(db: Db, row: MetricRow): Promise<string | null> {
  const verifier = row.verified_by;
  if (verifier === null) return null;
  const [setting] = await db
    .select({ kind: bookChange.principal_kind })
    .from(bookChange)
    .where(
      and(
        eq(bookChange.element_kind, "metric"),
        eq(bookChange.element_id, row.id),
        sql`${bookChange.after}->>'verified_by' = ${verifier}`,
        sql`${bookChange.before}->>'verified_by' is distinct from ${verifier}`,
      ),
    )
    .orderBy(desc(bookChange.id))
    .limit(1);
  if (setting === undefined || setting.kind === "system") return REMOVED_PERSON;
  const who = { kind: setting.kind, id: verifier };
  return (await namesOf(db, [who], "name")).get(whoKey(who)) ?? REMOVED_PERSON;
}

export async function getMetric(context: ServiceContext, reference: string) {
  const { db } = context;
  const allowed = await context.access.describableDatasets(context.principal);
  const hides = !(await readsPii(context));
  const row = await resolveMetric(db, allowed, hides, reference);
  const seen = variantVisibleTo(row.id, allowed, hides);
  const bases = await db
    .select({
      id: metricVariant.id,
      measure: { id: powerbiMeasure.id, name: powerbiMeasure.name },
      explanation: sql<
        string | null
      >`coalesce(${powerbiMeasure.description}, ${powerbiMeasure.description_pbi})`,
      format_string: powerbiMeasure.format_string,
      period: metricVariant.period,
      reads_selection: metricVariant.reads_selection,
      selection_columns: metricVariant.selection_columns,
      dataset: { id: powerbiDataset.id, name: powerbiDataset.name },
      workspace: { id: powerbiWorkspace.id, name: powerbiWorkspace.name },
    })
    .from(metricVariant)
    .innerJoin(powerbiMeasure, toMeasure)
    .innerJoin(powerbiDataset, toDataset)
    .innerJoin(
      powerbiWorkspace,
      eq(powerbiWorkspace.id, powerbiDataset.workspace_id),
    )
    .where(and(seen, standsAlone))
    .orderBy(
      asc(powerbiWorkspace.name),
      asc(powerbiDataset.name),
      asc(powerbiMeasure.name),
      asc(metricVariant.id),
    );
  const shift = {
    period: metricVariant.period,
    comparison: metricVariant.comparison,
    comparison_period: metricVariant.comparison_period,
    currency: metricVariant.currency,
    custom_axes: metricVariant.custom_axes,
  };
  const others = await db
    .select({ shift, count: count() })
    .from(metricVariant)
    .innerJoin(powerbiMeasure, toMeasure)
    .innerJoin(powerbiDataset, toDataset)
    .where(and(seen, sql`not ${standsAlone}`))
    .groupBy(...Object.values(shift))
    .orderBy(...Object.values(shift).map((column) => asc(column)));
  const terms = await db
    .select({ id: term.id, name: term.name })
    .from(termMetric)
    .innerJoin(term, eq(term.id, termMetric.term_id))
    .where(eq(termMetric.metric_id, row.id))
    .orderBy(asc(term.name));
  const conventions = await currentConventions(db);
  const checks = await checksOf(
    db,
    row,
    conventions,
    allowed,
    hides,
    "for_a_page",
    // The connector never changes the book, and a reader who cannot curate has no one to rename for.
    context.principal.via !== "mcp" &&
      (await context.access.check(context.principal, BOOK, "curate")),
  );
  const questions = await openQuestionsFor(context, {
    kind: "metric",
    id: row.id,
  });
  return {
    kind: "metric" as const,
    ...row,
    formula:
      bases
        .filter((base) => base.explanation)
        .map(
          (base) =>
            `${base.dataset.name} / ${base.measure.name}: ${base.explanation ?? ""}`,
        )
        .join("\n\n") || null,
    owner_person: await ownerOf(context, row),
    who_may_see: metricVisibility(
      await context.settings.get("access.metadata_visibility"),
      (
        await db
          .selectDistinct({ name: powerbiDataset.name })
          .from(metricVariant)
          .innerJoin(powerbiMeasure, toMeasure)
          .innerJoin(powerbiDataset, toDataset)
          .where(seen)
      ).map((dataset) => dataset.name),
    ),
    ...(await relationsForMetric(context, row.id, allowed, hides, conventions)),
    verified_by_name: await verifierName(db, row),
    category: categoryOf(await loadTree(db), row.category_id),
    failing_checks: await Promise.all(
      checks
        .filter((check) => !check.passed)
        .map(async ({ check, rule, message, other_labels }) => {
          const labels = other_labels?.slice(0, LABELS_NAMED) ?? [];
          return {
            check,
            rule,
            message,
            // Agents read this page, so each label costs them: metricChecks lists them all.
            other_labels: other_labels === undefined ? undefined : labels,
            other_metrics:
              other_labels === undefined
                ? undefined
                : await metricsSharing(db, row, labels, allowed, hides),
          };
        }),
    ),
    base_variants: (await withoutPiiSelection(context, bases)).map((base) => ({
      ...variantAnchor(base),
      format_string: base.format_string,
      // `other` is a measure the sync read as time-shifted without proof of how.
      period: base.period,
    })),
    other_variants: others,
    terms: terms.map((linked) => ref("term", linked.id, linked.name)),
    ...questions,
  };
}

type MetricFilters = {
  /** A category's key path; with include_children, the categories below it too. */
  category?: string;
  include_children?: boolean;
  /** Only metrics in no category. */
  not_filed?: boolean;
  trust_states?: TrustState[];
  unit?: string;
  origin?: (typeof ORIGINS)[number];
  /** Only metrics with a variant in this dataset, workspace or app (id or name). */
  dataset?: string;
  workspace?: string;
  app?: string;
  name_prefix?: string;
  name_contains?: string;
  /** Custom fields to match, as text: { owner_team: "finance" }. */
  custom?: Record<string, string>;
  /** Dismissed metrics are left out unless this is true. */
  dismissed?: boolean;
  /** `cursor` is the `next_cursor` of the page before. */
  cursor?: string;
  limit?: number;
};

function heldIn(
  db: Db,
  allowed: SQL,
  seen: SQL | undefined,
  filters: MetricFilters,
  hidesPii: boolean,
) {
  const { dataset, workspace, app } = filters;
  if (dataset === undefined && workspace === undefined && app === undefined) {
    return undefined;
  }
  return exists(
    db
      .select({ one: sql`1` })
      .from(metricVariant)
      .innerJoin(powerbiMeasure, toMeasure)
      .innerJoin(powerbiDataset, toDataset)
      .where(
        and(
          variantVisibleTo(metric.id, allowed, hidesPii),
          dataset === undefined
            ? undefined
            : byIdOrName(powerbiDataset, dataset),
          workspace === undefined ? undefined : inWorkspace(db, workspace),
          app === undefined ? undefined : inApp(db, app, seen),
        ),
      ),
  );
}

/** The category's id and those of every category below it. */
const andBelow = (tree: Tree, id: string): string[] => [
  id,
  ...tree.children(id).flatMap((child) => andBelow(tree, child.id)),
];

/**
 * What the home page says of the book, counted over what the caller may see,
 * as listMetrics and listDatasets show it. Counts only: a label is Power BI's
 * text, and the home page must not put it in a prompt a person pastes.
 */
export async function summarizeBook(context: ServiceContext) {
  const allowed = await context.access.describableDatasets(context.principal);
  const hides = !(await readsPii(context));
  const { db } = context;
  const states = await db
    .select({
      trust_state: metric.trust_state,
      count: count(),
      not_filed:
        sql<number>`count(*) filter (where ${isNull(metric.category_id)})`.mapWith(
          Number,
        ),
    })
    .from(metric)
    .where(and(visibleMetric(db, allowed, hides), isNull(metric.dismissed_at)))
    .groupBy(metric.trust_state);
  const [datasets] = await db
    .select({ count: count() })
    .from(powerbiDataset)
    .where(and(allowed, isNull(powerbiDataset.removed_at)));
  const countOf = (state: TrustState) =>
    states.find((row) => row.trust_state === state)?.count ?? 0;
  return {
    datasets: datasets?.count ?? 0,
    metrics: {
      draft: countOf("draft"),
      agent_verified: countOf("agent_verified"),
      human_verified: countOf("human_verified"),
    },
    not_filed: states.reduce((sum, row) => sum + row.not_filed, 0),
  };
}

export async function listMetrics(
  context: ServiceContext,
  filters: MetricFilters = {},
) {
  const allowed = await context.access.describableDatasets(context.principal);
  const hides = !(await readsPii(context));
  const { db } = context;
  const tree = await loadTree(db);
  const category =
    filters.category === undefined ? undefined : tree.get(filters.category);
  const limit = sizeOf(filters.limit);
  const matching = [
    visibleMetric(db, allowed, hides),
    filters.dismissed === true ? undefined : isNull(metric.dismissed_at),
    category === undefined
      ? undefined
      : inArray(
          metric.category_id,
          filters.include_children === true
            ? andBelow(tree, category.id)
            : [category.id],
        ),
    filters.not_filed === true ? isNull(metric.category_id) : undefined,
    filters.trust_states === undefined
      ? undefined
      : inArray(metric.trust_state, filters.trust_states),
    filters.unit === undefined ? undefined : eq(metric.unit, filters.unit),
    filters.origin === undefined
      ? undefined
      : eq(metric.origin, filters.origin),
    heldIn(db, allowed, await appsSeen(context, allowed), filters, hides),
    ...Object.entries(filters.custom ?? {}).map(
      ([key, value]) => sql`${metric.custom} ->> ${key} = ${value}`,
    ),
    startsWith(metric.name, filters.name_prefix),
    or(
      containsName(metric.name, filters.name_contains),
      containsName(metric.label, filters.name_contains),
      aliasContainsName(metric.aliases, filters.name_contains),
    ),
  ];
  const rows = await db
    .select({
      id: metric.id,
      name: metric.name,
      label: metric.label,
      icon: metric.icon,
      definition: metric.definition,
      aliases: metric.aliases,
      dataset_count: db
        .select({ count: countDistinct(powerbiDataset.id).as("count") })
        .from(metricVariant)
        .innerJoin(powerbiMeasure, toMeasure)
        .innerJoin(powerbiDataset, toDataset)
        .where(variantVisibleTo(metric.id, allowed, hides))
        .as("dataset_count"),
      unit: metric.unit,
      category_id: metric.category_id,
      trust_state: metric.trust_state,
      origin: metric.origin,
      dismissed_at: metric.dismissed_at,
      custom: metric.custom,
    })
    .from(metric)
    .where(and(...matching, afterCursor(metric, filters.cursor)))
    .orderBy(asc(metric.name), asc(metric.id))
    .limit(limit + 1);
  const page = pageOf(rows, limit);
  // The first page says how many metrics match, over what the caller may describe, as the rows are.
  const [counted] =
    filters.cursor === undefined
      ? await db
          .select({ total: count() })
          .from(metric)
          .where(and(...matching))
      : [];
  return {
    ...(counted !== undefined && { total: counted.total }),
    items: page.items.map(
      ({ definition, category_id, dismissed_at, ...row }) => {
        const summary = excerpt(definition, 240);
        return {
          kind: "metric" as const,
          ...row,
          aliases: row.aliases ?? [],
          summary: summary.text,
          ...(summary.truncated && { summary_truncated: true as const }),
          category: categoryOf(tree, category_id),
          dismissed: dismissed_at !== null,
        };
      },
    ),
    next_cursor: page.next_cursor,
  };
}

async function refuseRelatedDeletion(db: Db, id: string): Promise<void> {
  const [edge] = await db
    .select({ id: metricEdge.parent_id })
    .from(metricEdge)
    .where(or(eq(metricEdge.parent_id, id), eq(metricEdge.child_id, id)))
    .limit(1);
  const [link] = await db
    .select({ id: metricLink.metric_id })
    .from(metricLink)
    .where(or(eq(metricLink.metric_id, id), eq(metricLink.other_metric_id, id)))
    .limit(1);
  if (edge || link)
    throw conflict(
      "Remove this metric's relationships before deleting or merging it, so their changes remain in the book's history.",
    );
}
