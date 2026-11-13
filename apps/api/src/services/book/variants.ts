import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { SelectedFields } from "drizzle-orm/pg-core";
import type { Db, ServiceContext } from "../../context.js";
import {
  type COMPARISONS,
  metric,
  metricVariant,
} from "../../db/schema/book.js";
import {
  powerbiDataset,
  powerbiMeasure,
  powerbiTable,
  powerbiWorkspace,
} from "../../db/schema/mirror.js";
import { ServiceError } from "../../errors.js";
import { type Conventions, currencyCode } from "../conventions/schema.js";
import { withEvents } from "../events/feed.js";
import {
  afterCursor,
  byIdOrName,
  inWorkspace,
  looksLikeId,
  pageBy,
  ref,
  sizeOf,
  unlessPii,
} from "../mirror/read.js";
import { readsPii } from "../pii/rules.js";
import { recordBookChange, requireCurator } from "./changes.js";
import {
  datasetsOf,
  liveMeasure,
  lockMetric,
  openChange,
  refuseClashes,
  resolveMetric,
  settle,
  toDataset,
  toMeasure,
  variantAnchor,
  withoutPiiSelection,
} from "./metrics.js";

/*
 * Curation of variants. A variant is reached through its measure's dataset,
 * so one in a dataset the caller may not describe answers like a missing one.
 * A curator's move or shift is a curator's filing, which the drafter never
 * moves again.
 */

type Variant = typeof metricVariant.$inferSelect;
type Comparison = (typeof COMPARISONS)[number];

const missing = () => new ServiceError("not_found", "No such variant.");
const invalid = (message: string) => new ServiceError("invalid", message);

/** Variants with their measure, dataset and workspace, and the columns `more` adds. */
export const selectVariants = <T extends SelectedFields>(db: Db, more: T) =>
  db
    .select({
      ...more,
      id: metricVariant.id,
      measure: { id: powerbiMeasure.id, name: powerbiMeasure.name },
      dataset: { id: powerbiDataset.id, name: powerbiDataset.name },
      workspace: { id: powerbiWorkspace.id, name: powerbiWorkspace.name },
      shift: {
        period: metricVariant.period,
        comparison: metricVariant.comparison,
        comparison_period: metricVariant.comparison_period,
        currency: metricVariant.currency,
        custom_axes: metricVariant.custom_axes,
        shift_note: metricVariant.shift_note,
      },
      reads_selection: metricVariant.reads_selection,
      selection_columns: metricVariant.selection_columns,
    })
    .from(metricVariant)
    .innerJoin(powerbiMeasure, toMeasure)
    .innerJoin(powerbiTable, eq(powerbiTable.id, powerbiMeasure.table_id))
    .innerJoin(powerbiDataset, toDataset)
    .innerJoin(
      powerbiWorkspace,
      eq(powerbiWorkspace.id, powerbiDataset.workspace_id),
    );

/** A variant's id, or its measure (id or name) in a dataset (id or name). */
export type VariantReference = string | { dataset: string; measure: string };

export async function getVariant(
  context: ServiceContext,
  reference: VariantReference,
) {
  const allowed = await context.access.describableDatasets(context.principal);
  if (typeof reference === "string" && !looksLikeId(reference)) {
    throw missing();
  }
  const rows = await selectVariants(context.db, {
    metric: { id: metric.id, name: metric.name, label: metric.label },
    table: { id: powerbiTable.id, name: powerbiTable.name },
    expression: powerbiMeasure.expression,
    normalized_expression: powerbiMeasure.normalized_expression,
    format_string: powerbiMeasure.format_string,
    display_folder: powerbiMeasure.display_folder,
    description: powerbiMeasure.description,
    description_pbi: powerbiMeasure.description_pbi,
    assigned_by: metricVariant.assigned_by,
    assigned_at: metricVariant.assigned_at,
    removed: sql<boolean>`(${powerbiMeasure.removed_at} is not null or ${powerbiDataset.removed_at} is not null)`,
  })
    .innerJoin(metric, eq(metric.id, metricVariant.metric_id))
    .where(
      and(
        allowed,
        unlessPii(!(await readsPii(context))),
        typeof reference === "string"
          ? eq(metricVariant.id, reference)
          : and(
              byIdOrName(powerbiDataset, reference.dataset),
              byIdOrName(powerbiMeasure, reference.measure),
            ),
      ),
    )
    .limit(6);
  const [found, ...others] = rows;
  if (found === undefined) throw missing();
  if (others.length > 0) {
    // A measure's name is unique in its dataset, so only a dataset's name matches twice.
    const ids = rows.map((row) => row.dataset.id).join(", ");
    throw invalid(`Several datasets go by that name. Use one of ${ids}.`);
  }
  const [shown] = await withoutPiiSelection(context, [found]);
  if (shown === undefined)
    throw new Error("withoutPiiSelection gave back no variant.");
  const { metric: filed, table, ...variant } = shown;
  return {
    ...variant,
    ...variantAnchor(variant),
    metric: { ...ref("metric", filed.id, filed.name), label: filed.label },
    table: ref("table", table.id, table.name),
  };
}

type VariantFilters = {
  /** A dataset or workspace, by id or name. */
  dataset?: string;
  workspace?: string;
  period?: string;
  comparison?: Comparison;
  /** null: the dataset's own currency. */
  currency?: string | null;
  /** `cursor` is the `next_cursor` of the page before. */
  cursor?: string;
  limit?: number;
};

/** The metric's live variants in datasets the caller may describe, by measure name, then workspace and dataset name; no DAX. */
export async function listVariants(
  context: ServiceContext,
  reference: string,
  filters: VariantFilters = {},
) {
  const allowed = await context.access.describableDatasets(context.principal);
  const { db } = context;
  const hides = !(await readsPii(context));
  const found = await resolveMetric(db, allowed, hides, reference);
  const limit = sizeOf(filters.limit);
  const { dataset, workspace, period, comparison, currency } = filters;
  const rows = await selectVariants(db, { name: powerbiMeasure.name })
    .where(
      and(
        eq(metricVariant.metric_id, found.id),
        allowed,
        liveMeasure,
        unlessPii(hides),
        dataset === undefined ? undefined : byIdOrName(powerbiDataset, dataset),
        workspace === undefined ? undefined : inWorkspace(db, workspace),
        period === undefined ? undefined : eq(metricVariant.period, period),
        comparison === undefined
          ? undefined
          : eq(metricVariant.comparison, comparison),
        currency === undefined
          ? undefined
          : currency === null
            ? isNull(metricVariant.currency)
            : eq(metricVariant.currency, currency),
        afterCursor(
          {
            name: [
              powerbiMeasure.name,
              powerbiWorkspace.name,
              powerbiDataset.name,
            ],
            id: metricVariant.id,
          },
          filters.cursor,
        ),
      ),
    )
    .orderBy(
      asc(powerbiMeasure.name),
      asc(powerbiWorkspace.name),
      asc(powerbiDataset.name),
      asc(metricVariant.id),
    )
    .limit(limit + 1);
  const page = pageBy(rows, limit, (row) => [
    row.name,
    row.workspace.name,
    row.dataset.name,
  ]);
  const items = await withoutPiiSelection(context, page.items);
  return {
    items: items.map((row) => ({
      ...variantAnchor(row),
      shift: row.shift,
      metric: ref("metric", found.id, found.name),
    })),
    next_cursor: page.next_cursor,
  };
}

export type VariantMove = {
  /** The metric's key, alias or id; left out, the variant stays under its metric. */
  to_metric?: string;
  period?: string;
  /** Given without comparison_period, the period compared against is cleared. */
  comparison?: Comparison;
  comparison_period?: string | null;
  /** An ISO 4217 code or local, as the conventions allow; null is the dataset's own. */
  currency?: string | null;
  /** Replaces the variant's custom axes whole. */
  custom_axes?: Record<string, string>;
  note?: string | null;
};

const notNamed = (what: string, value: string, values: string[]) =>
  invalid(
    `${value} is not ${what} the conventions name in variants.axes${values.length > 0 ? `: ${values.join(", ")}` : ""}.`,
  );

/** The shift the move leaves the variant with, refused where the conventions' axes do not allow it. */
function shiftAfter(
  { variants: { axes } }: Conventions,
  before: Variant,
  move: VariantMove,
) {
  const shift = {
    period: move.period ?? before.period,
    comparison: move.comparison ?? before.comparison,
    comparison_period:
      move.comparison_period !== undefined
        ? move.comparison_period
        : move.comparison === undefined
          ? before.comparison_period
          : null,
    currency: move.currency === undefined ? before.currency : move.currency,
    custom_axes: move.custom_axes ?? before.custom_axes,
    shift_note:
      move.note === undefined ? before.shift_note : move.note?.trim() || null,
  };
  const { period, comparison, comparison_period: against, currency } = shift;
  const periods = axes.period.values;
  if (!periods.includes(period)) throw notNamed("a period", period, periods);
  if (!axes.comparison.values.includes(comparison)) {
    throw notNamed("a comparison", comparison, axes.comparison.values);
  }
  if ((comparison === "none") !== (against === null)) {
    throw invalid(
      "A comparison compares against a period, given as comparison_period, and none compares against nothing. Give both or neither.",
    );
  }
  if (against !== null && !periods.includes(against)) {
    throw notNamed("a period", against, periods);
  }
  const currencies = axes.currency.values;
  if (currencies === "iso_4217_or_local") {
    if (currency !== null && !currencyCode.safeParse(currency).success) {
      throw notNamed("a currency", currency, ["an ISO 4217 code", "local"]);
    }
  } else if (currency !== null && !currencies.includes(currency)) {
    throw notNamed("a currency", currency, currencies);
  }
  const keys = axes.custom.map((custom) => custom.key);
  for (const [key, value] of Object.entries(shift.custom_axes)) {
    const axis = axes.custom.find((custom) => custom.key === key);
    if (axis === undefined) throw notNamed("an axis", key, keys);
    if (typeof value !== "string" || !axis.values.includes(value)) {
      throw notNamed(`a ${key}`, JSON.stringify(value), axis.values);
    }
  }
  return shift;
}

/**
 * Files the variant under another metric, or gives it another shift, or
 * both. The variant becomes a curator's, which the drafter never moves.
 */
export async function moveVariant(
  context: ServiceContext,
  id: string,
  move: VariantMove,
) {
  await requireCurator(context);
  await withEvents(context.db, async (tx, emit) => {
    const change = await openChange(context, tx, emit);
    const [found] = looksLikeId(id)
      ? await tx
          .select({
            variant: metricVariant,
            measure: powerbiMeasure.name,
            dataset_id: powerbiDataset.id,
            dataset: powerbiDataset.name,
          })
          .from(metricVariant)
          .innerJoin(powerbiMeasure, toMeasure)
          .innerJoin(powerbiTable, eq(powerbiTable.id, powerbiMeasure.table_id))
          .innerJoin(powerbiDataset, toDataset)
          .where(
            and(
              eq(metricVariant.id, id),
              change.allowed,
              unlessPii(change.hidesPii),
            ),
          )
      : [];
    if (found === undefined) throw missing();
    const leaving = found.variant.metric_id;
    const toId =
      move.to_metric === undefined
        ? leaving
        : (
            await resolveMetric(
              tx,
              change.allowed,
              change.hidesPii,
              move.to_metric,
            )
          ).id;
    // Both metrics, in id order, before the variant, as a merge locks them:
    // two moves between the same metrics then wait for each other in turn.
    const fromFirst = leaving <= toId;
    const first = await lockMetric(tx, fromFirst ? leaving : toId);
    const second = await lockMetric(tx, fromFirst ? toId : leaving);
    const [from, into] = fromFirst ? [first, second] : [second, first];
    const [before] = await tx
      .select()
      .from(metricVariant)
      .where(eq(metricVariant.id, found.variant.id))
      .for("update");
    if (before === undefined) throw missing();
    if (before.metric_id !== leaving) {
      throw new ServiceError(
        "conflict",
        "The variant moved to another metric while this change waited. Try again.",
      );
    }

    const set = {
      ...shiftAfter(change.conventions, before, move),
      metric_id: into.id,
      assigned_by: "curator" as const,
      assigned_at: change.now,
    };
    const after: Variant = { ...before, ...set };
    // A change that changes nothing records nothing.
    const same = { ...after, assigned_at: before.assigned_at };
    if (isDeepStrictEqual(same, before)) return;
    await refuseClashes(change, into, [
      { ...found, variant: after, describable: true },
    ]);
    const moved = from.id !== into.id;
    const leavingScope = moved ? await datasetsOf(tx, from.id) : [];
    await tx
      .update(metricVariant)
      .set(set)
      .where(eq(metricVariant.id, before.id));
    const action = moved ? "move" : "update";
    const { principal } = context;
    await recordBookChange(tx, {
      principal,
      element_kind: "variant",
      element_id: before.id,
      action,
      before,
      after,
    });
    if (moved) {
      emit({
        kind: "variant.moved",
        element_kind: "variant",
        element_id: before.id,
        principal,
        data: {
          measure_id: before.measure_id,
          from_metric_id: from.id,
          to_metric_id: into.id,
          dataset_id: found.dataset_id,
        },
      });
    }
    // A change to a variant is a change to its metric. An untouched draft stays
    // one, so the drafter may still regroup what it holds. Once it holds no live
    // measure it goes now, not at the next sync: everyone reads a metric with no
    // variant, and its key came from a measure they may not see.
    if (moved && from.touched_at === null && from.origin === "sync") {
      const [live] = await tx
        .select({ id: metricVariant.id })
        .from(metricVariant)
        .innerJoin(
          powerbiMeasure,
          eq(powerbiMeasure.id, metricVariant.measure_id),
        )
        .where(
          and(
            eq(metricVariant.metric_id, from.id),
            isNull(powerbiMeasure.removed_at),
          ),
        )
        .limit(1);
      if (live === undefined) {
        await tx.delete(metric).where(eq(metric.id, from.id));
        await recordBookChange(tx, {
          principal,
          element_kind: "metric",
          element_id: from.id,
          action: "delete",
          before: from,
          after: null,
        });
      }
    }
    if (moved && from.touched_at !== null) {
      // The metric's last variant leaving would record no dataset at all, which reads as everyone.
      const scope = new Set([
        ...leavingScope,
        ...(await datasetsOf(tx, from.id)),
      ]);
      const current = await tx
        .select({ id: metricVariant.measure_id })
        .from(metricVariant)
        .where(eq(metricVariant.metric_id, from.id));
      await settle(
        change,
        from,
        action,
        {
          variant_id: before.id,
          to_metric_id: into.id,
          dataset_ids: [...scope].sort(),
          measure_ids: [
            ...new Set([before.measure_id, ...current.map(({ id }) => id)]),
          ],
        },
        true,
      );
    }
    // Events carry ids, never another element's name: a reader may see one metric and not the other.
    const data = moved ? { from_metric_id: from.id } : {};
    await settle(
      change,
      into,
      action,
      { variant_id: before.id, ...data },
      true,
    );
  });
  return getVariant(context, id);
}
