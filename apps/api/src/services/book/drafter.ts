import { setImmediate as nextTurn } from "node:timers/promises";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  not,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { AppDeps, Db } from "../../context.js";
import * as dax from "../../dax/index.js";
import { metric, metricVariant } from "../../db/schema/book.js";
import type { EventKind } from "../../db/schema/events.js";
import {
  powerbiDataset,
  powerbiMeasure,
  powerbiTable,
} from "../../db/schema/mirror.js";
import { logError } from "../../http/error-log.js";
import type { DraftingRules } from "../conventions/schema.js";
import { currentConventions } from "../conventions/store.js";
import { anyOf } from "../access/plan.js";
import { type NewEvent, withEvents } from "../events/feed.js";
import { piiMeasure } from "../pii/rules.js";
import { recordBookChange } from "./changes.js";

/*
 * The drafter: after a sync, the measures of each dataset that changed or is on
 * are fingerprinted and filed as variants of draft metrics, one transaction per dataset. It
 * groups two measures only when it can prove they compute the same thing,
 * and it moves only what it filed itself under a draft nobody touched.
 */

export type DraftCounts = {
  created: number;
  filed: number;
  regrouped: number;
  dismissed: number;
  deleted: number;
  renamed: number;
  /** Datasets left as they were, because drafting them threw. The log says why. */
  failed: number;
};

type Measure = typeof powerbiMeasure.$inferSelect & {
  table_name: string;
  pii: boolean;
};
type Variant = typeof metricVariant.$inferSelect;
type Metric = typeof metric.$inferSelect;
/** A variant's place on every axis, and its note. */
type Shift = Pick<
  Variant,
  | "period"
  | "comparison"
  | "comparison_period"
  | "currency"
  | "custom_axes"
  | "shift_note"
>;
type Analysis = {
  normalized: string | null;
  fingerprint: string | null;
  error: string | null;
  selection: { reads: boolean; columns: string[] };
  variantOf: { base: string; shift: Shift } | null;
  /** The DAX or the name says the period moved, and no pattern proves how. */
  unproven: boolean;
};
type Item = {
  measure: Measure;
  analysis: Analysis;
  filing: { variant: Variant; metric: Metric } | undefined;
  movable: boolean;
};
/** A metric's id and the shift to file under it; null files the measure nowhere. */
type Target = { metric: string; shift: Shift } | null;
type Run = {
  tx: Db;
  emit: (event: NewEvent) => void;
  now: Date;
  datasetId: string;
  counts: DraftCounts;
  /** Read once a run: an alias added since is picked up by the tidy at its end. */
  aliased: Set<string>;
  /** The first suffix not yet tried for a key, so k names sharing it cost k probes, not k squared. */
  nextSuffix: Map<string, number>;
  /** Whether the conventions name the period for a shift nobody could prove. */
  filesOther: boolean;
};

const BASE: Shift = {
  period: "current",
  comparison: "none",
  comparison_period: null,
  currency: null,
  custom_axes: {},
  shift_note: null,
};
const OTHER_PERIOD = "other";
/** Time-shifted, and no pattern proves which shift: it is not the current period. */
const UNPROVEN: Shift = { ...BASE, period: OTHER_PERIOD };
const BLANK_AS_ZERO_NOTE = "Shows 0 where the calculation is blank.";
export const baseVariant = and(
  eq(metricVariant.period, "current"),
  eq(metricVariant.comparison, "none"),
  isNull(metricVariant.currency),
);
/**
 * What the sync files as no proven shift, whichever of the two periods it reads,
 * so `other` moves no fold. A curator's `other` is a shift a person chose, and
 * no base, as it always was.
 */
export const standsAlone = and(
  or(
    eq(metricVariant.period, "current"),
    and(
      eq(metricVariant.period, OTHER_PERIOD),
      eq(metricVariant.assigned_by, "sync"),
    ),
  ),
  eq(metricVariant.comparison, "none"),
  isNull(metricVariant.currency),
);
const LOCK_NAME = "powerbi_metrics_book.drafter";
const NAMES_PER_PROBE = 16;

export async function draftDatasets(
  deps: AppDeps,
  datasetIds: string[],
): Promise<DraftCounts & { failed_datasets: string[] }> {
  const { drafting: rules, variants } = await currentConventions(deps.db);
  const filesOther = variants.axes.period.values.includes(OTHER_PERIOD);
  const aliased = await aliasedWords(deps.db);
  const counts = {
    created: 0,
    filed: 0,
    regrouped: 0,
    dismissed: 0,
    deleted: 0,
    renamed: 0,
    failed: 0,
  };
  const failed_datasets: string[] = [];
  // Grouping reads every dataset's drafts: two runs at once would each make the same draft.
  const lock = (tx: Db) =>
    tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${LOCK_NAME}, 0))`,
    );
  // Each sync drafts every dataset, so one that throws must not stop the others
  // on every sync. Its transaction rolls back, and so do its counts.
  for (const datasetId of datasetIds) {
    const before = { ...counts };
    try {
      await withEvents(deps.db, async (tx, emit) => {
        await lock(tx);
        await draftDataset(
          {
            tx,
            emit,
            now: deps.clock(),
            datasetId,
            counts,
            aliased,
            nextSuffix: new Map(),
            filesOther,
          },
          rules,
        );
      });
    } catch (error) {
      Object.assign(counts, before, { failed: before.failed + 1 });
      failed_datasets.push(datasetId);
      logError(deps.logger, "A dataset could not be drafted.", error, {
        request_id: null,
        dataset_id: datasetId,
      });
    }
  }
  await deps.db.transaction(async (tx) => {
    await lock(tx);
    counts.renamed += await tidyDraftNames(tx);
  });
  return { ...counts, failed_datasets };
}

/**
 * Variants of measures gone from Power BI that should leave their draft. A metric
 * is seen through any of its variants, so one would keep the draft's name in front
 * of a reader of its dataset. It stays, to come back under its own variant, where
 * that dataset holds a measure of the draft's name, gone or not, that is not PII.
 * What a person touched and what a rule dismissed keep what they hold.
 */
async function strandedVariants(db: Db, datasets: SQL) {
  const rows = await db
    .select({
      variant: metricVariant,
      dataset_id: powerbiMeasure.dataset_id,
      name: powerbiMeasure.name,
      removed_at: powerbiMeasure.removed_at,
      pii: piiMeasure(powerbiMeasure),
      label: metric.label,
      touched_at: metric.touched_at,
      dismissed_at: metric.dismissed_at,
    })
    .from(metricVariant)
    .innerJoin(metric, eq(metric.id, metricVariant.metric_id))
    .innerJoin(powerbiMeasure, eq(powerbiMeasure.id, metricVariant.measure_id))
    .where(datasets);
  const place = ({ variant, dataset_id }: (typeof rows)[number]) =>
    JSON.stringify([variant.metric_id, dataset_id]);
  const named = new Set(
    rows
      .filter((row) => !row.pii && snakeCase(row.name) === snakeCase(row.label))
      .map(place),
  );
  return rows.filter(
    (row) =>
      row.removed_at !== null &&
      row.variant.assigned_by === "sync" &&
      row.touched_at === null &&
      row.dismissed_at === null &&
      !named.has(place(row)),
  );
}

/**
 * Removed datasets with a variant that should leave its draft. A dataset is drafted
 * in the run that removes it, so these come from a book older than that rule, or a
 * run that failed. A reader of its workspace would otherwise keep the draft's name.
 */
export async function removedDatasetsInDrafts(db: Db): Promise<string[]> {
  const stranded = await strandedVariants(
    db,
    inArray(
      powerbiMeasure.dataset_id,
      db
        .select({ id: powerbiDataset.id })
        .from(powerbiDataset)
        .where(isNotNull(powerbiDataset.removed_at)),
    ),
  );
  return [...new Set(stranded.map((row) => row.dataset_id))];
}

async function draftDataset(run: Run, rules: DraftingRules): Promise<void> {
  const { tx, datasetId } = run;
  const measures = (
    await tx
      .select({
        measure: powerbiMeasure,
        table_name: powerbiTable.name,
        pii: piiMeasure(powerbiMeasure),
      })
      .from(powerbiMeasure)
      .innerJoin(powerbiTable, eq(powerbiTable.id, powerbiMeasure.table_id))
      .where(
        and(
          eq(powerbiMeasure.dataset_id, datasetId),
          isNull(powerbiMeasure.removed_at),
        ),
      )
      .orderBy(asc(powerbiMeasure.name))
  ).map((row) => ({
    ...row.measure,
    table_name: row.table_name,
    pii: row.pii,
  }));
  const analyse = await analyser(measures, rules, run.filesOther);
  const analyses = new Map<string, Analysis>();
  for (const measure of measures) {
    analyses.set(measure.id, analyse(measure));
    // A tenant may publish many long measures: the worker's heartbeat runs between them.
    await nextTurn();
  }
  const prints = [...analyses.values()].flatMap((a) => a.fingerprint ?? []);
  // Locked until this run commits: a curator's change to these rows either
  // committed before and is read here, or waits and lands on what it writes.
  // The metrics first, in id order, then the variants, as a curator's move
  // takes them, so the two wait for each other rather than deadlock. They
  // are the drafts its measures sit in and the metrics that may prove a group.
  const ofDataset = inArray(
    metricVariant.measure_id,
    tx
      .select({ id: powerbiMeasure.id })
      .from(powerbiMeasure)
      .where(eq(powerbiMeasure.dataset_id, datasetId)),
  );
  const touched = await tx
    .selectDistinct({ id: metricVariant.metric_id })
    .from(metricVariant)
    .innerJoin(powerbiMeasure, eq(powerbiMeasure.id, metricVariant.measure_id))
    .where(
      rules.group_by_fingerprint
        ? or(ofDataset, anyOf(powerbiMeasure.fingerprint, prints))
        : ofDataset,
    );
  const metrics = new Map<string, Metric>();
  const lock = async (ids: string[]) => {
    for (const row of await lockMetrics(tx, ids)) metrics.set(row.id, row);
  };
  await lock(touched.map((row) => row.id));
  // Without a join: a row a curator moved would drop out of a join on the
  // metric it had.
  const variants = await tx
    .select()
    .from(metricVariant)
    .where(ofDataset)
    .orderBy(asc(metricVariant.id))
    .for("update");
  // A curator's move that committed since the read above filed a variant
  // under a metric not locked yet; it is locked last, out of order, only then.
  await lock([
    ...new Set(
      variants.flatMap((v) => (metrics.has(v.metric_id) ? [] : [v.metric_id])),
    ),
  ]);
  const filings = new Map(
    variants.map((variant) => {
      const draft = metrics.get(variant.metric_id);
      if (draft === undefined)
        throw new Error(`No metric ${variant.metric_id}`);
      return [variant.measure_id, { variant, metric: draft }];
    }),
  );
  const items = measures.map((measure): Item => {
    const filing = filings.get(measure.id);
    const movable = isMovable(measure, filing);
    const analysis = analyses.get(measure.id);
    if (analysis === undefined)
      throw new Error(`${measure.name} was not analysed`);
    return { measure, analysis, filing, movable };
  });

  for (const { measure, analysis } of items) {
    const { normalized, fingerprint, error } = analysis;
    const same =
      measure.normalized_expression === normalized &&
      measure.fingerprint === fingerprint &&
      measure.fingerprint_error === error;
    if (same) continue;
    await tx
      .update(powerbiMeasure)
      .set({
        normalized_expression: normalized,
        fingerprint,
        fingerprint_error: error,
      })
      .where(eq(powerbiMeasure.id, measure.id));
  }

  const targets = await decide(run, rules, items, new Set(metrics.keys()));
  for (const item of items) {
    const { filing, analysis } = item;
    const target = targets.get(item.measure.id);
    if (item.movable) {
      if (target === undefined)
        throw new Error(`${item.measure.name} has no target`);
      await place(run, item, target);
    } else if (filing !== undefined && analysis.error === null) {
      // A curator's filing stays; what the DAX reads is still the sync's to say.
      await place(run, item, {
        metric: filing.metric.id,
        shift: filing.variant,
      });
    }
  }
  for (const { variant } of await strandedVariants(
    tx,
    eq(powerbiMeasure.dataset_id, datasetId),
  ))
    await unfile(run, variant);
  await deleteEmptyDrafts(run);
}

type OwnSelection = Analysis["selection"] & { uses: string[] };

/** What the measure reads of the selection, itself or through any measure its expansion reaches. */
function selectionOf(
  name: string,
  map: dax.MeasureMap,
  own: Map<string, OwnSelection>,
): Analysis["selection"] {
  const reached = new Set([name.toLowerCase()]);
  const columns = new Set<string>();
  let reads = false;
  // A Set visits what is added to it while it is walked.
  for (const key of reached) {
    const measure = map.get(key);
    if (measure === undefined) continue;
    const { expression } = measure;
    // An unread variable can reach this with no trace in the expansion, and
    // what cannot be read may read the selection.
    if (dax.tooLongToRead(expression) !== null) {
      reads = true;
      continue;
    }
    const found = own.get(key) ?? {
      ...dax.readsSelection(expression),
      uses: dax.referencedMeasures(expression, map),
    };
    own.set(key, found);
    reads ||= found.reads;
    for (const column of found.columns) columns.add(column);
    for (const used of found.uses) reached.add(used.toLowerCase());
  }
  return { reads, columns: [...columns] };
}

function shiftOf(found: dax.RecognisedVariant | null): Analysis["variantOf"] {
  if (found === null) return null;
  const shift_note = found.blank_as_zero ? BLANK_AS_ZERO_NOTE : null;
  return { base: found.base, shift: { ...BASE, ...found.shift, shift_note } };
}

/** Analyses a measure against the other measures of its dataset. */
async function analyser(
  measures: Measure[],
  rules: DraftingRules,
  filesOther: boolean,
) {
  const map = dax.measureMap(
    measures.flatMap((m) =>
      m.expression === null
        ? []
        : [{ name: m.name, expression: m.expression, table: m.table_name }],
    ),
  );
  const unread = dax.measureMap(
    measures.flatMap((m) =>
      m.expression === null ? [{ name: m.name, table: m.table_name }] : [],
    ),
  );
  // A shift of a calculation looks for it among all the measures, so they are
  // read first, with the worker's heartbeat running between them.
  if (rules.recognise_time_intelligence) {
    for (const { name } of map.values()) {
      dax.readCalculation(name, map);
      await nextTurn();
    }
  }
  const selections = new Map<string, OwnSelection>();
  const periodHints = [
    ...rules.name_hints.period,
    ...Object.values(rules.period_words).flat(),
  ];
  const failed = (normalized: string | null, error: string): Analysis => ({
    normalized,
    fingerprint: null,
    error,
    selection: { reads: false, columns: [] },
    variantOf: null,
    unproven: false,
  });

  return (measure: Measure): Analysis => {
    if (measure.expression === null)
      return failed(null, "Power BI gave no expression.");
    const tooLong = dax.tooLongToRead(measure.expression);
    if (tooLong !== null) return failed(null, tooLong);
    let normalized: string | null = null;
    try {
      normalized = dax.normalize(measure.expression);
      const expanded = dax.expandMeasures(measure.name, map);
      if ("cycle" in expanded) {
        const cycle = [...expanded.cycle, expanded.cycle[0]].join(" -> ");
        return failed(normalized, `Reference cycle: ${cycle}`);
      }
      if ("too_large" in expanded)
        return failed(normalized, expanded.too_large);
      // Without their DAX, two such measures could match while computing different things.
      const blind = dax.referencedMeasures(expanded.expanded, unread);
      if (blind.length > 0) {
        return failed(
          normalized,
          `Uses measures with no expression: ${blind.join(", ")}`,
        );
      }
      const variantOf = rules.recognise_time_intelligence
        ? shiftOf(dax.recogniseVariant(measure.name, map, rules))
        : null;
      return {
        normalized,
        fingerprint: dax.fingerprint(expanded.expanded),
        error: null,
        selection: selectionOf(measure.name, map, selections),
        variantOf,
        unproven:
          filesOther &&
          rules.recognise_time_intelligence &&
          variantOf === null &&
          (dax.shiftsPeriod(expanded.expanded) ||
            dax.saysAny(measure.name, periodHints)),
      };
    } catch (error) {
      if (!(error instanceof dax.DaxSyntaxError)) throw error;
      return failed(normalized, `The DAX does not parse: ${error.message}`);
    }
  };
}

function isMovable(measure: Measure, filing: Item["filing"]): boolean {
  if (filing === undefined) return true;
  const { variant, metric: draft } = filing;
  if (variant.assigned_by !== "sync" || draft.touched_at !== null) return false;
  // A dismissed draft keeps its measure until the measure's expression changes.
  const changed = measure.expression_changed_at;
  return (
    draft.dismissed_at === null ||
    (changed !== null && changed > draft.dismissed_at)
  );
}

/**
 * A filing a shift of the measure can go beside. A currency or a custom axis
 * only a curator gives is no shift in time, so a shift of the measure takes
 * them along (`axesOf`).
 */
// Unlike `standsAlone` and `baseVariant`, which want no currency, so a copy of a curated EUR base in another dataset stays a draft.
function isBaseFiling(variant: Variant): boolean {
  return (
    (variant.period === "current" ||
      (variant.period === OTHER_PERIOD && variant.assigned_by === "sync")) &&
    variant.comparison === "none"
  );
}

/** The currency and custom axes, in a form two of them compare by. */
export const axesKey = ({
  currency,
  custom_axes,
}: Pick<Variant, "currency" | "custom_axes">) =>
  JSON.stringify([
    currency,
    Object.entries(custom_axes).sort(([a], [b]) => a.localeCompare(b)),
  ]);

/** The shift of a measure filed under no base. */
const unshifted = ({ analysis }: Item): Shift =>
  analysis.unproven ? UNPROVEN : BASE;

function isSkipped(measure: Measure, skip: DraftingRules["skip"]): boolean {
  const folder = measure.display_folder;
  return (
    (skip.hidden_measures && measure.is_hidden) ||
    (folder !== null && skip.display_folders.includes(folder)) ||
    skip.tables.includes(measure.table_name) ||
    skip.name_prefixes.some((prefix) =>
      measure.name.toLowerCase().startsWith(prefix.toLowerCase()),
    ) ||
    skip.names.some((name) => measure.name.toLowerCase() === name.toLowerCase())
  );
}

/** Where each movable measure goes, by measure id. Drafts it needs are made here. */
async function decide(
  run: Run,
  rules: DraftingRules,
  items: Item[],
  locked: ReadonlySet<string>,
): Promise<Map<string, Target>> {
  const targets = new Map<string, Target>();
  const movable = items.filter((item) => item.movable);
  const movableIds = new Set(movable.map((item) => item.measure.id));
  const byName = new Map(
    items.map((item) => [item.measure.name.toLowerCase(), item]),
  );

  type Grouped = { item: Item; key: string };
  const dismissed: { item: Item; reason: string }[] = [];
  const variants: (Grouped & { base: string; shift: Shift })[] = [];
  const bases: Grouped[] = [];
  for (const item of movable) {
    const { fingerprint, variantOf } = item.analysis;
    if (fingerprint === null || isSkipped(item.measure, rules.skip)) {
      targets.set(item.measure.id, null);
      continue;
    }
    const key = rules.group_by_fingerprint ? fingerprint : item.measure.id;
    const name = item.measure.name.toLowerCase();
    const rule = rules.dismiss.find((rule) =>
      "prefix" in rule
        ? name.startsWith(rule.prefix.toLowerCase())
        : name === rule.name.toLowerCase(),
    );
    if (rule !== undefined) dismissed.push({ item, reason: rule.reason });
    else if (variantOf !== null) variants.push({ item, key, ...variantOf });
    else bases.push({ item, key });
  }
  const groups = new Map<string, Item[]>();
  const proven = new Map<string, string | undefined>();
  const addToGroup = ({ item, key }: Grouped) => {
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [item]);
    else group.push(item);
    // A new member can change what the group is called, and so what proves it.
    proven.delete(key);
  };
  bases.forEach(addToGroup);
  // A metric holding a live base measure this run does not decide, of the same
  // fingerprint and the same name. Whoever can see a variant reads the metric's
  // key and label, so a measure of another name stays apart until a person who
  // sees both merges them. A key nobody confirmed must be that name too. What a
  // person wrote reaches the new reader, so it takes a measure readers may see:
  // in a dataset that is on, and not PII.
  const held = new Map<string, string>();
  const heldKey = (fingerprint: string, name: string) =>
    JSON.stringify([fingerprint, name]);
  if (rules.group_by_fingerprint && movable.length > 0) {
    const found = await run.tx
      .select({
        fingerprint: powerbiMeasure.fingerprint,
        metric_id: metric.id,
        metric_name: metric.name,
        metric_label: metric.label,
        measure_name: powerbiMeasure.name,
        generated: metric.name_is_generated,
        touched_at: metric.touched_at,
        seen: sql<boolean>`${powerbiDataset.enabled} and not ${piiMeasure(powerbiMeasure)}`,
      })
      .from(metricVariant)
      .innerJoin(metric, eq(metric.id, metricVariant.metric_id))
      .innerJoin(
        powerbiMeasure,
        eq(powerbiMeasure.id, metricVariant.measure_id),
      )
      .innerJoin(
        powerbiDataset,
        eq(powerbiDataset.id, powerbiMeasure.dataset_id),
      )
      .where(
        and(
          anyOf(powerbiMeasure.fingerprint, [
            ...new Set(movable.flatMap((i) => i.analysis.fingerprint ?? [])),
          ]),
          isNull(powerbiMeasure.removed_at),
          isNull(metric.dismissed_at),
          standsAlone,
          not(anyOf(metricVariant.measure_id, [...movableIds])),
        ),
      )
      // A curated metric first, so drafts of the same calculation gather under it.
      .orderBy(
        sql`${metric.touched_at} is null`,
        asc(metric.created_at),
        asc(metric.id),
      );
    for (const row of found) {
      const { fingerprint, metric_id, metric_name, generated } = row;
      // Only a metric the run locked: one filed since would be locked out of order.
      if (fingerprint === null || !locked.has(metric_id)) continue;
      const name = snakeCase(row.measure_name);
      const curated = row.touched_at !== null || !generated;
      // A number in a measure's own name is no `_2`: `zeta_2` from `Zeta 2` is not `Zeta`'s.
      const named =
        metric_name === name ||
        (isKeyOf(metric_name, name) && snakeCase(row.metric_label) === name);
      if ((curated && !row.seen) || (generated && !named)) continue;
      const key = heldKey(fingerprint, name);
      if (!held.has(key)) held.set(key, metric_id);
    }
  }
  const provenFor = (key: string): string | undefined => {
    const group = groups.get(key);
    const print = group?.[0]?.analysis.fingerprint;
    if (group === undefined || print === null || print === undefined)
      return undefined;
    if (!proven.has(key))
      proven.set(key, held.get(heldKey(print, draftName(group).key)));
    return proven.get(key);
  };
  // What holds each shift of a metric in this dataset, by fingerprint.
  const slots = new Map<string, string | null>();
  const slotOf = (where: string, shift: Shift) =>
    JSON.stringify([
      where,
      shift.period,
      shift.comparison,
      shift.comparison_period,
      axesKey(shift),
    ]);
  for (const { movable: moves, filing, analysis } of items) {
    if (moves || filing === undefined) continue;
    slots.set(slotOf(filing.metric.id, filing.variant), analysis.fingerprint);
  }
  // A variant goes under its base's metric when its base is filed as a base: by
  // this run, or for good, and when no other calculation holds that shift there.
  // What holds a shift now keeps it, so a new measure never takes it away, nor
  // does a new copy of its base, which has no filing yet; among the rest, one
  // that shows 0 for a blank gives way to one that does not.
  const plain = new Map(bases.map(({ item, key }) => [item, key]));
  const filedUnder: { item: Item; base: Item; shift: Shift }[] = [];
  const baseOn = new Map<string, Set<string>>();
  for (const { filing, analysis } of items) {
    if (
      analysis.fingerprint === null ||
      filing === undefined ||
      !isBaseFiling(filing.variant) ||
      filing.metric.dismissed_at !== null
    )
      continue;
    const on = baseOn.get(analysis.fingerprint) ?? new Set<string>();
    baseOn.set(analysis.fingerprint, on.add(filing.metric.id));
  }
  const claimOn = ({ item, base, shift }: (typeof variants)[number]) => {
    const now = item.filing;
    const print = byName.get(base.toLowerCase())?.analysis.fingerprint ?? null;
    const holds =
      now !== undefined &&
      print !== null &&
      baseOn.get(print)?.has(now.metric.id) === true &&
      now.variant.period === shift.period &&
      now.variant.comparison === shift.comparison &&
      now.variant.comparison_period === shift.comparison_period;
    if (holds) return 0;
    return shift.shift_note === null ? 1 : 2;
  };
  // Where a base goes: where it stays for good, or where this run files it.
  const stays = ({ movable, filing }: Item) =>
    !movable &&
    filing !== undefined &&
    isBaseFiling(filing.variant) &&
    filing.metric.dismissed_at === null
      ? filing
      : undefined;
  const whereOf = (item: Item) => stays(item)?.metric.id ?? plain.get(item);
  // A shift's currency and custom axes are its base's: a curator's for a base
  // that stays, none for one this run files.
  const axesOf = (item: Item): Pick<Shift, "currency" | "custom_axes"> => {
    const variant = stays(item)?.variant ?? BASE;
    return { currency: variant.currency, custom_axes: variant.custom_axes };
  };
  // A copy that is not PII first: a variant that is not PII takes no name from one that is.
  const placed = new Map<string, Item>();
  for (const item of items.toSorted(
    (a, b) => Number(a.measure.pii) - Number(b.measure.pii),
  )) {
    const { fingerprint } = item.analysis;
    if (
      fingerprint !== null &&
      !placed.has(fingerprint) &&
      whereOf(item) !== undefined
    )
      placed.set(fingerprint, item);
  }
  // The measure a variant names, or a copy of it when a rule keeps that one out.
  const baseOf = (name: string) => {
    const named = byName.get(name.toLowerCase());
    if (named === undefined || whereOf(named) !== undefined) return named;
    const { fingerprint } = named.analysis;
    return fingerprint === null ? undefined : placed.get(fingerprint);
  };
  for (const variant of variants.toSorted((a, b) => claimOn(a) - claimOn(b))) {
    const base = baseOf(variant.base);
    const where = base && whereOf(base);
    // A PII base does not exist for a reader of a variant that is not PII, so
    // the variant takes no name from it.
    const unseenBase = base?.measure.pii === true && !variant.item.measure.pii;
    if (base === undefined || where === undefined || unseenBase) {
      addToGroup(variant);
      continue;
    }
    const shift = { ...variant.shift, ...axesOf(base) };
    const slot = slotOf(provenFor(where) ?? where, shift);
    const print = variant.item.analysis.fingerprint;
    const holder = slots.get(slot);
    if (holder !== undefined && holder !== print) {
      addToGroup(variant);
      continue;
    }
    slots.set(slot, print);
    filedUnder.push({ item: variant.item, base, shift });
  }

  // Who is in the drafts the movable measures sit in now, removed measures too.
  const current = [
    ...new Set(movable.flatMap((item) => item.filing?.metric.id ?? [])),
  ];
  const members =
    current.length === 0
      ? []
      : await run.tx
          .select({
            metric_id: metricVariant.metric_id,
            measure_id: metricVariant.measure_id,
            removed_at: powerbiMeasure.removed_at,
          })
          .from(metricVariant)
          .innerJoin(
            powerbiMeasure,
            eq(powerbiMeasure.id, metricVariant.measure_id),
          )
          .where(anyOf(metricVariant.metric_id, current));
  const memberships = Map.groupBy(members, (m) => m.metric_id);
  const membersOf = (id: string) => memberships.get(id) ?? [];
  const claimed = new Set<string>();

  for (const { item, reason } of dismissed) {
    const draft = item.filing?.metric;
    // Its own draft keeps it; a draft it shares would take the others down with it.
    const own =
      draft !== undefined &&
      snakeCase(draft.label) === snakeCase(item.measure.name) &&
      membersOf(draft.id).every((m) => m.measure_id === item.measure.id);
    let id: string;
    if (draft !== undefined && own) {
      if (draft.dismissed_at === null) await dismiss(run, draft, reason);
      id = draft.id;
    } else {
      id = await createDraft(run, [item], reason);
    }
    claimed.add(id);
    targets.set(item.measure.id, { metric: id, shift: unshifted(item) });
  }

  // Else a draft holding no live measure this run does not decide keeps a
  // group: first the group filed there as a base whose fingerprint its measures
  // had before this run, so that of two measures sharing a draft the changed one
  // moves; then any, the groups filed as a base first, so that a shift that lost
  // its place never takes the draft from the base it was filed under.
  const stored = new Map(
    movable.map((i) => [i.measure.id, i.measure.fingerprint]),
  );
  const filedAsBase = ({ filing }: Item) =>
    filing !== undefined && isBaseFiling(filing.variant);
  const ordered = [...groups].sort(
    ([a, one], [b, other]) =>
      Number(other.some(filedAsBase)) - Number(one.some(filedAsBase)) ||
      (a < b ? -1 : 1),
  );
  const decided = new Set<string>();
  for (const matching of [true, false]) {
    for (const [key, group] of ordered) {
      if (decided.has(key)) continue;
      const print = group[0]?.analysis.fingerprint;
      const name = draftName(group).key;
      const [kept] = group
        .filter((item) => !matching || filedAsBase(item))
        .flatMap((item) => item.filing?.metric ?? [])
        .filter((draft) => {
          const members = membersOf(draft.id);
          return (
            draft.dismissed_at === null &&
            snakeCase(draft.label) === name &&
            !claimed.has(draft.id) &&
            members.every(
              (m) => m.removed_at !== null || movableIds.has(m.measure_id),
            ) &&
            (!matching ||
              members.some((m) => stored.get(m.measure_id) === print))
          );
        })
        .sort(
          (a, b) =>
            a.created_at.getTime() - b.created_at.getTime() ||
            (a.id < b.id ? -1 : 1),
        );
      const id =
        provenFor(key) ??
        kept?.id ??
        (matching ? undefined : await createDraft(run, group, null));
      if (id === undefined) continue;
      decided.add(key);
      claimed.add(id);
      for (const item of group) {
        targets.set(item.measure.id, { metric: id, shift: unshifted(item) });
      }
    }
  }

  for (const { item, base, shift } of filedUnder) {
    const id = base.movable
      ? targets.get(base.measure.id)?.metric
      : base.filing?.metric.id;
    if (id === undefined)
      throw new Error(`The base of ${item.measure.name} has no metric`);
    targets.set(item.measure.id, { metric: id, shift });
  }
  return targets;
}

/** Records a change by the sync, and announces it when the feed carries its kind. */
function record(
  run: Run,
  element: { kind: "metric"; id: string },
  action: string,
  change: { before: unknown; after: unknown },
  announce?: {
    kind: EventKind;
    data: Record<string, unknown> & { measure_ids: string[] };
  },
): Promise<void>;
function record(
  run: Run,
  element: { kind: "variant"; id: string },
  action: string,
  change: { before: unknown; after: unknown },
  announce?: { kind: EventKind; data: Record<string, unknown> },
): Promise<void>;
async function record(
  run: Run,
  element: { kind: "metric" | "variant"; id: string },
  action: string,
  change: { before: unknown; after: unknown },
  announce?: { kind: EventKind; data: Record<string, unknown> },
): Promise<void> {
  await recordBookChange(run.tx, {
    principal: null,
    element_kind: element.kind,
    element_id: element.id,
    action,
    ...change,
  });
  if (announce === undefined) return;
  run.emit({
    ...announce,
    element_kind: element.kind,
    element_id: element.id,
    principal: null,
    // A variant's event records its dataset; a metric's, the datasets it is in.
    data: {
      ...announce.data,
      ...(element.kind === "variant"
        ? { dataset_id: run.datasetId }
        : { dataset_ids: [run.datasetId] }),
    },
  });
}

async function unfile(run: Run, variant: Variant): Promise<void> {
  await run.tx.delete(metricVariant).where(eq(metricVariant.id, variant.id));
  await record(
    run,
    { kind: "variant", id: variant.id },
    "delete",
    { before: variant, after: null },
    {
      kind: "variant.moved",
      data: {
        measure_id: variant.measure_id,
        from_metric_id: variant.metric_id,
        to_metric_id: null,
      },
    },
  );
  run.counts.regrouped += 1;
}

/** Files, moves, refreshes or unfiles the measure's variant to match the target. */
async function place(run: Run, item: Item, target: Target): Promise<void> {
  const { tx, counts } = run;
  const { measure, filing, analysis } = item;
  const moved = (from: string | null, to: string | null) => ({
    kind: "variant.moved" as const,
    data: { measure_id: measure.id, from_metric_id: from, to_metric_id: to },
  });

  if (target === null) {
    if (filing !== undefined) await unfile(run, filing.variant);
    return;
  }
  const { period, comparison, comparison_period, shift_note } = target.shift;
  const values = {
    metric_id: target.metric,
    period,
    comparison,
    comparison_period,
    currency: target.shift.currency,
    custom_axes: target.shift.custom_axes,
    shift_note,
    reads_selection: analysis.selection.reads,
    selection_columns: analysis.selection.columns,
  };
  if (filing === undefined) {
    const [row] = await tx
      .insert(metricVariant)
      .values({ ...values, measure_id: measure.id, assigned_by: "sync" })
      .onConflictDoNothing({ target: metricVariant.measure_id })
      .returning();
    // A curator filed it after this run read the variants; that filing stands.
    if (row === undefined) return;
    const element = { kind: "variant" as const, id: row.id };
    await record(
      run,
      element,
      "file",
      { before: null, after: row },
      moved(null, row.metric_id),
    );
    counts.filed += 1;
    return;
  }
  const before = filing.variant;
  const isMove = before.metric_id !== target.metric;
  const isShift =
    before.period !== period ||
    before.comparison !== comparison ||
    before.comparison_period !== comparison_period ||
    axesKey(before) !== axesKey(target.shift) ||
    before.shift_note !== shift_note;
  const isFlag =
    before.reads_selection !== values.reads_selection ||
    before.selection_columns.join("\n") !== values.selection_columns.join("\n");
  if (!isMove && !isShift && !isFlag) return;
  const [row] = await tx
    .update(metricVariant)
    .set(isMove ? { ...values, assigned_at: run.now } : values)
    .where(eq(metricVariant.id, before.id))
    .returning();
  if (row === undefined) throw new Error(`${measure.name} was not moved`);
  const element = { kind: "variant" as const, id: row.id };
  const announce = isMove ? moved(before.metric_id, row.metric_id) : undefined;
  await record(
    run,
    element,
    isMove ? "move" : "update",
    { before, after: row },
    announce,
  );
  if (isMove || isShift) counts.regrouped += 1;
}

/** The metrics' rows, locked in id order. */
const lockMetrics = (tx: Db, ids: string[]): Promise<Metric[]> =>
  ids.length === 0
    ? Promise.resolve([])
    : tx
        .select()
        .from(metric)
        .where(anyOf(metric.id, ids))
        .orderBy(asc(metric.id))
        .for("update");

async function createDraft(
  run: Run,
  group: Item[],
  dismissedReason: string | null,
): Promise<string> {
  const { key, label } = draftName(group);
  const [row] = await run.tx
    .insert(metric)
    .values({
      name: await uniqueName(run.tx, key, run.aliased, run.nextSuffix),
      label,
      origin: "sync",
      trust_state: "draft",
      name_is_generated: true,
      dismissed_at: dismissedReason === null ? null : run.now,
      dismissed_reason: dismissedReason,
    })
    .returning();
  if (row === undefined) throw new Error(`The draft ${key} was not made`);
  await record(
    run,
    { kind: "metric", id: row.id },
    "create",
    { before: null, after: row },
    {
      kind: "draft.created",
      data: {
        name: row.name,
        dismissed_reason: dismissedReason,
        measure_ids: group.map(({ measure }) => measure.id),
      },
    },
  );
  run.counts.created += 1;
  if (dismissedReason !== null) run.counts.dismissed += 1;
  return row.id;
}

async function dismiss(run: Run, draft: Metric, reason: string): Promise<void> {
  const [row] = await run.tx
    .update(metric)
    .set({ dismissed_at: run.now, dismissed_reason: reason })
    .where(eq(metric.id, draft.id))
    .returning();
  await record(run, { kind: "metric", id: draft.id }, "dismiss", {
    before: draft,
    after: row,
  });
  run.counts.dismissed += 1;
}

/**
 * Drafts the sync made, nobody touched, that hold no live measure any more, in
 * any dataset: this run emptied them, or a measure left Power BI.
 */
async function deleteEmptyDrafts(run: Run): Promise<void> {
  const live = sql`exists (select from ${metricVariant}
    join ${powerbiMeasure} on ${powerbiMeasure.id} = ${metricVariant.measure_id}
    where ${metricVariant.metric_id} = ${metric.id} and ${powerbiMeasure.removed_at} is null)`;
  // A draft a curator holds is being changed: waiting for it out of order could
  // deadlock, and a later run deletes it if it is still empty and untouched.
  const empty = await run.tx
    .select({ id: metric.id })
    .from(metric)
    .where(and(eq(metric.origin, "sync"), isNull(metric.touched_at), not(live)))
    .for("update", { skipLocked: true });
  const deleted = await run.tx
    .delete(metric)
    .where(
      anyOf(
        metric.id,
        empty.map((row) => row.id),
      ),
    )
    .returning();
  for (const row of deleted) {
    await record(run, { kind: "metric", id: row.id }, "delete", {
      before: row,
      after: null,
    });
    run.counts.deleted += 1;
  }
}

/**
 * Every word a curated alias holds, in lower case. A reference finds a key
 * before an alias, so a generated key on one of these would take the word from
 * the metric a person gave it to. A curator cannot give an alias a key already
 * holds (`columnsOf`), so a key here predates its alias or raced it.
 */
async function aliasedWords(tx: Db): Promise<Set<string>> {
  const { rows } = await tx.execute<{ word: string }>(
    sql`select distinct lower(alias) as word from ${metric}, unnest(${metric.aliases}) as alias`,
  );
  return new Set(rows.map((row) => row.word));
}

/**
 * Gives a generated draft name the `_2` it took because another draft held the
 * name, once that draft is gone: folding empties the others. A generated key an
 * alias holds gives way to it. A draft a curator touched keeps its name, and
 * so does one a curator holds right now.
 */
async function tidyDraftNames(tx: Db): Promise<number> {
  const aliased = await aliasedWords(tx);
  const drafts = await tx
    .select()
    .from(metric)
    .where(
      and(
        eq(metric.origin, "sync"),
        eq(metric.name_is_generated, true),
        isNull(metric.touched_at),
        or(
          sql`${metric.name} ~ '_[0-9]+$'`,
          sql`${metric.name} = any(${sql.param([...aliased])}::text[])`,
        ),
      ),
    )
    .orderBy(asc(metric.created_at), asc(metric.id))
    .for("update", { skipLocked: true });
  const wanted = (row: Metric) => {
    const name = snakeCase(row.label);
    return row.name !== name && isKeyOf(row.name, name) ? name : null;
  };
  const names = [...new Set(drafts.flatMap((row) => wanted(row) ?? []))];
  const held = await tx
    .select({ name: metric.name })
    .from(metric)
    .where(anyOf(metric.name, names));
  const taken = new Set([...aliased, ...held.map((row) => row.name)]);
  const nextSuffix = new Map<string, number>();
  let renamed = 0;
  for (const before of drafts) {
    const free = wanted(before);
    let name: string | null = null;
    if (aliased.has(before.name))
      name = await uniqueName(tx, snakeCase(before.label), aliased, nextSuffix);
    else if (free !== null && !taken.has(free)) name = free;
    if (name === null) continue;
    taken.add(name);
    const [after] = await tx
      .update(metric)
      .set({ name })
      .where(eq(metric.id, before.id))
      .returning();
    await recordBookChange(tx, {
      principal: null,
      element_kind: "metric",
      element_id: before.id,
      action: "rename",
      before,
      after,
    });
    renamed += 1;
  }
  return renamed;
}

/** A generated key is a name in snake_case, with `_2`, `_3`, ... when another held it. */
const isKeyOf = (key: string, name: string) =>
  key.startsWith(name) && /^(_[0-9]+)?$/u.test(key.slice(name.length));

/** `Net Sales` becomes `net_sales`; a percent sign becomes the word. */
function snakeCase(name: string): string {
  const words = name
    .replaceAll("%", " percent ")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u);
  return words.filter((word) => word !== "").join("_") || "unnamed_measure";
}

/**
 * What a group is called: a name its readers may see, and the one its draft has
 * if it can. A group holds one dataset's measures, so they share their readers,
 * and only a PII measure is hidden from any of them. Another dataset's measures
 * join the draft only under this same name.
 */
function draftName(group: Item[]): { key: string; label: string } {
  const mostCommon = (values: string[]) => {
    const tally = new Map<string, number>();
    for (const value of values) tally.set(value, (tally.get(value) ?? 0) + 1);
    return [...tally].sort(
      ([a, x], [b, y]) => y - x || (a < b ? -1 : 1),
    )[0]?.[0];
  };
  const seen = group.filter(({ measure }) => !measure.pii);
  const names = (seen.length > 0 ? seen : group).map((i) => i.measure.name);
  const keys = names.map(snakeCase);
  const allowed = new Set(keys);
  const key =
    group
      .flatMap(({ filing }) => (filing ? snakeCase(filing.metric.label) : []))
      .find((current) => allowed.has(current)) ?? mostCommon(keys);
  const label = mostCommon(names.filter((name) => snakeCase(name) === key));
  if (key === undefined || label === undefined)
    throw new Error("A draft needs a measure");
  return { key, label };
}

/** The key, or the key with the first free `_2`, `_3`, ... */
async function uniqueName(
  tx: Db,
  key: string,
  aliased: Set<string>,
  nextSuffix: Map<string, number>,
): Promise<string> {
  // Exact names, which the unique index answers. A pattern reads every metric,
  // and a dataset's first draft asks once per draft.
  for (let from = nextSuffix.get(key) ?? 1; ; from += NAMES_PER_PROBE) {
    const names = Array.from({ length: NAMES_PER_PROBE }, (_, at) =>
      from + at === 1 ? key : `${key}_${String(from + at)}`,
    );
    const rows = await tx
      .select({ name: metric.name })
      .from(metric)
      .where(anyOf(metric.name, names));
    const taken = new Set(rows.map((row) => row.name));
    const free = names.find((n) => !taken.has(n) && !aliased.has(n));
    if (free !== undefined) {
      // Taken from here on in this run, so the next draft of the key starts after it.
      nextSuffix.set(key, from + names.indexOf(free) + 1);
      return free;
    }
  }
}
