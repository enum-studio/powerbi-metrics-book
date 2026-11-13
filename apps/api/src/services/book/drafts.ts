import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  sql,
} from "drizzle-orm";
import { alias, type PgColumn } from "drizzle-orm/pg-core";
import type { ServiceContext } from "../../context.js";
import { metric, metricVariant } from "../../db/schema/book.js";
import { powerbiDataset, powerbiMeasure } from "../../db/schema/mirror.js";
import { currentConventions } from "../conventions/store.js";
import { byIdOrName, unlessPii, visibleMetric } from "../mirror/read.js";
import { requireCurator } from "./changes.js";
import { readsPii } from "../pii/rules.js";
import {
  liveMeasure,
  toDataset,
  toMeasure,
  variantAnchor,
  withoutPiiSelection,
} from "./metrics.js";
import {
  type MergeSuggestion,
  suggestMerges,
  suggestSameNames,
} from "./suggestions.js";
import { selectVariants } from "./variants.js";

/*
 * The drafts queue: the drafts nobody has touched, the most widely held
 * first and then the largest, each with what an agent needs to structure it. A draft is named only
 * through its variants in datasets the caller may describe; the rest are
 * counted.
 */

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
/** How many of the closest metrics each draft names. */
const CLOSEST = 5;

export async function nextDrafts(
  context: ServiceContext,
  options: { dataset?: string; limit?: number } = {},
) {
  await requireCurator(context);
  const { db } = context;
  const hides = !(await readsPii(context));
  const allowed = await context.access.describableDatasets(context.principal);
  const limit = Math.min(
    Math.max(options.limit ?? DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );
  // A draft the caller may work on: a live variant in a dataset it may describe, and the one asked for.
  const workable = db
    .select({ id: powerbiDataset.id })
    .from(powerbiDataset)
    .where(
      and(
        allowed,
        options.dataset === undefined
          ? undefined
          : byIdOrName(powerbiDataset, options.dataset),
      ),
    );
  const held = countDistinct(powerbiDataset.id);
  const drafts = await db
    .select({
      id: metric.id,
      name: metric.name,
      label: metric.label,
      // Every dataset and variant, those the caller may not describe too: they are counted, never named.
      dataset_count: held,
      variant_count: count(metricVariant.id),
    })
    .from(metric)
    .innerJoin(metricVariant, eq(metricVariant.metric_id, metric.id))
    .innerJoin(powerbiMeasure, toMeasure)
    .innerJoin(powerbiDataset, toDataset)
    .where(
      and(
        isNull(metric.touched_at),
        isNull(metric.dismissed_at),
        liveMeasure,
        unlessPii(hides),
      ),
    )
    .groupBy(metric.id)
    .having(sql`bool_or(${inArray(powerbiDataset.id, workable)})`)
    .orderBy(
      desc(held),
      desc(count(metricVariant.id)),
      asc(metric.name),
      asc(metric.id),
    )
    .limit(limit);
  if (drafts.length === 0) return [];
  const ids = drafts.map((d) => d.id);

  const variants = await withoutPiiSelection(
    context,
    await selectVariants(db, {
      metric_id: metricVariant.metric_id,
      expression: powerbiMeasure.expression,
      format_string: powerbiMeasure.format_string,
    })
      .where(
        and(
          inArray(metricVariant.metric_id, ids),
          liveMeasure,
          unlessPii(hides),
          allowed,
        ),
      )
      .orderBy(asc(powerbiDataset.name), asc(powerbiMeasure.name)),
  );

  const conventions = await currentConventions(db);
  const describes = and(allowed, unlessPii(hides)) ?? allowed;
  const { suggestions, cut } = await suggestMerges(
    db,
    ids,
    conventions,
    describes,
  );
  const sameNames = await suggestSameNames(db, ids, describes);
  const named = [
    ...new Set(
      [...suggestions, ...sameNames].flatMap((s) => [
        ...s.measure_ids,
        ...s.into_measure_ids,
      ]),
    ),
  ];
  const seen = await db
    .select({ id: powerbiMeasure.id, dataset_id: powerbiMeasure.dataset_id })
    .from(powerbiMeasure)
    .innerJoin(powerbiDataset, toDataset)
    .where(and(inArray(powerbiMeasure.id, named), allowed, unlessPii(hides)));
  const describable = new Map(seen.map((row) => [row.id, row.dataset_id]));
  // Field by field, because measure_ids holds measures the caller may not describe.
  const merge = (s: MergeSuggestion) => ({
    metric_id: s.metric_id,
    measure: s.measure,
    into_metric_id: s.into_metric_id,
    into_measure: s.into_measure,
    word: s.word,
    axis: s.axis,
    dataset_count: new Set(
      s.measure_ids.flatMap((id) => describable.get(id) ?? []),
    ).size,
  });

  const draft = alias(metric, "draft");
  const score = (other: { name: PgColumn; label: PgColumn }) =>
    sql<number>`greatest(similarity(${other.name}, ${draft.name}), similarity(${other.label}, ${draft.label}))`;
  const close = db
    .select({
      id: metric.id,
      name: metric.name,
      label: metric.label,
      trust_state: metric.trust_state,
    })
    .from(metric)
    .where(
      and(
        ne(metric.id, draft.id),
        isNull(metric.dismissed_at),
        visibleMetric(db, allowed, hides),
        // pg_trgm's own threshold (pg_trgm.similarity_threshold) decides what is close.
        sql`(${metric.name} % ${draft.name} or ${metric.label} % ${draft.label})`,
      ),
    )
    .orderBy(desc(score(metric)), asc(metric.name))
    .limit(CLOSEST)
    .as("close");
  const closest = await db
    .select({
      draft_id: draft.id,
      metric: {
        id: close.id,
        name: close.name,
        label: close.label,
        trust_state: close.trust_state,
        similarity: score(close),
      },
    })
    .from(draft)
    .crossJoinLateral(close)
    .where(inArray(draft.id, ids))
    .orderBy(desc(score(close)), asc(close.name));

  const next = [];
  for (const { variant_count, ...queued } of drafts) {
    const own = variants
      .filter((v) => v.metric_id === queued.id)
      .map((v) => ({
        ...variantAnchor(v),
        shift: v.shift,
        expression: v.expression,
        format_string: v.format_string,
      }));
    const datasets = new Map(own.map((v) => [v.dataset.id, v.dataset]));
    const concerned = suggestions.filter(
      (s) => s.metric_id === queued.id || s.into_metric_id === queued.id,
    );
    const shown = concerned.filter(
      (s) =>
        s.measure_ids.some((id) => describable.has(id)) &&
        s.into_measure_ids.some((id) => describable.has(id)),
    );
    next.push({
      kind: "metric" as const,
      ...queued,
      datasets: [...datasets.values()],
      variants: own,
      hidden_variants: variant_count - own.length,
      closest_metrics: closest
        .filter((row) => row.draft_id === queued.id)
        .map((row) => ({ kind: "metric" as const, ...row.metric })),
      suggested_merges: [
        ...shown,
        ...sameNames.filter(
          (s) => s.metric_id === queued.id || s.into_metric_id === queued.id,
        ),
      ].map(merge),
      hidden_suggested_merges: concerned.length - shown.length,
      suggested_merges_truncated: cut.has(queued.id),
    });
  }
  return next;
}
