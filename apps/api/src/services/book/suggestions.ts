import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { SelectedFields } from "drizzle-orm/pg-core";
import type { Db } from "../../context.js";
import { metric, metricVariant } from "../../db/schema/book.js";
import { powerbiDataset, powerbiMeasure } from "../../db/schema/mirror.js";
import { wordsOf } from "../../dax/index.js";
import type { Conventions } from "../conventions/schema.js";
import { standsAlone } from "./drafter.js";
import { liveMeasure } from "./metrics.js";

/** How many other metrics one draft is offered for holding a measure of its name. */
const SAME_NAME_LIMIT = 10;
/** How many likely merges from a word one asked metric is offered, and as many more with a side the caller may not describe. */
const WORD_ENTRY_LIMIT = 25;
/**
 * How many characters of names one asked metric may have a likely merge look
 * for, counted in the strings built: about a hundred names of seven words
 * each, under the default hints.
 */
export const PAIRING_CHARACTERS = 2_000_000;
/**
 * How many strings, and how many characters in them, all the asked metrics
 * together may have a likely merge look for, counted as they are built. A full
 * page of the queue (50 drafts of 15 names of 15 long words, under 36 hints)
 * builds about 430,000 strings of 69,000,000 characters, so it is not cut.
 */
export const PAIRING_ROWS = 1_000_000;
export const PAIRING_TOTAL_CHARACTERS = 96_000_000;
/** How many names a read of likely merges shows the planner, which then finds them by the index. */
const PRICED_NAMES = 5_000;

export type MergeSuggestion = {
  /** The metric whose measure's name carries the word. */
  metric_id: string;
  measure: string;
  /** Every measure of that name under that metric. */
  measure_ids: string[];
  /** The metric whose measure's name is the same without it. */
  into_metric_id: string;
  into_measure: string;
  /** Every measure of that name under that metric. */
  into_measure_ids: string[];
  /** The name hint that differs, as the conventions write it; none when the name is no clue or the same. */
  word: string | null;
  axis: "period" | "currency" | "name" | "calculation";
};

/**
 * A measure's name as `wordsOf` joins them, in SQL; `book.sql` indexes it. It
 * only narrows what the suggestions read: `wordsOf` still compares what comes
 * back, so a name Postgres folds apart from JavaScript can change which
 * suggestions come back, and never which measures the caller may see.
 */
const nameWords = sql`btrim(regexp_replace(lower(${powerbiMeasure.name}), '[^[:alnum:]%]+', ' ', 'g'))`;

const liveHeld = <T extends SelectedFields>(
  db: Db,
  more: T,
  condition: SQL | undefined,
) =>
  db
    .select({
      ...more,
      metric_id: metricVariant.metric_id,
      name: powerbiMeasure.name,
    })
    .from(metricVariant)
    .innerJoin(metric, eq(metric.id, metricVariant.metric_id))
    .innerJoin(powerbiMeasure, eq(powerbiMeasure.id, metricVariant.measure_id))
    .innerJoin(powerbiDataset, eq(powerbiDataset.id, powerbiMeasure.dataset_id))
    .where(and(isNull(metric.dismissed_at), liveMeasure, condition));

const measuresWhere = (db: Db, condition: SQL | undefined) =>
  liveHeld(
    db,
    {
      measure_id: powerbiMeasure.id,
      fingerprint: powerbiMeasure.fingerprint,
      base: sql<boolean>`${standsAlone}`,
    },
    condition,
  ).orderBy(asc(powerbiMeasure.name), asc(powerbiMeasure.id));

/**
 * The measures of one exact name under one metric, as one holder: two names
 * under two metrics are one suggestion however many datasets hold them, since
 * pairing the measures would only multiply the datasets by each other and leave
 * the same thing to decide. Holders order by what they are and not by a
 * measure's id, or a measure the caller may not see could move an entry.
 */
function holdersOf(
  measures: Awaited<ReturnType<typeof measuresWhere>>,
  visibleIds?: Set<string>,
) {
  const held = new Map<
    string,
    {
      metric_id: string;
      name: string;
      measure_ids: string[];
      visible: boolean;
    }
  >();
  for (const { metric_id, measure_id, name } of measures) {
    const key = JSON.stringify([metric_id, name]);
    const holder = held.get(key) ?? {
      metric_id,
      name,
      measure_ids: [],
      visible: false,
    };
    holder.measure_ids.push(measure_id);
    holder.visible ||= visibleIds?.has(measure_id) ?? true;
    held.set(key, holder);
  }
  return [...held.values()].sort(
    (a, b) =>
      a.name.localeCompare(b.name) || a.metric_id.localeCompare(b.metric_id),
  );
}

type Hint = { axis: "period" | "currency"; word: string; words: string[] };

/**
 * Every name a measure could have to pair with one of `held` by one hint: each
 * name once however many measures hold it, and up to `PAIRING_CHARACTERS` for
 * each metric, and `PAIRING_ROWS` and `PAIRING_TOTAL_CHARACTERS` for all of
 * them, counted from the strings built. A name whose strings would pass a limit
 * is left out, and a later, smaller one can still fit. `held` comes with what
 * the caller may describe first, so a measure out of its reach cannot push out
 * one in reach. `cut` names the metrics that lost a name the caller may
 * describe, and never one that lost only names it may not, so it says nothing
 * of those.
 */
export function pairingOf(
  held: { metric_id: string; name: string; visible: boolean }[],
  hints: Hint[],
): { names: string[]; cut: Set<string> } {
  const hintCharacters = hints.reduce(
    (sum, hint) => sum + hint.words.join(" ").length + 1,
    0,
  );
  const pairing = new Set<string>();
  const done = new Set<string>();
  const cut = new Set<string>();
  const spent = new Map<string, number>();
  let characters = 0;
  for (const { metric_id, name, visible } of held) {
    const words = wordsOf(name);
    const joined = words.join(" ");
    if (done.has(joined)) continue;
    // An upper bound, only so that one name cannot build more than a limit before it is counted.
    const bound =
      joined.length +
      (words.length + 1) *
        (hints.length * (joined.length + 1) + hintCharacters);
    const strings = new Set<string>([joined]);
    if (
      bound <= PAIRING_CHARACTERS &&
      1 + hints.length * 2 * (words.length + 1) <= PAIRING_ROWS
    ) {
      for (const hint of hints) {
        const spelled = hint.words.join(" ");
        for (let at = 0; at <= words.length; at += 1) {
          const before = words.slice(0, at);
          const after = words.slice(at);
          strings.add([...before, ...hint.words, ...after].join(" "));
          if (after.slice(0, hint.words.length).join(" ") === spelled)
            strings.add(
              [...before, ...after.slice(hint.words.length)].join(" "),
            );
        }
      }
    }
    let fresh = 0;
    let cost = 0;
    for (const string of strings) {
      if (pairing.has(string)) continue;
      fresh += 1;
      cost += string.length;
    }
    const total = (spent.get(metric_id) ?? 0) + cost;
    if (
      bound > PAIRING_CHARACTERS ||
      total > PAIRING_CHARACTERS ||
      characters + cost > PAIRING_TOTAL_CHARACTERS ||
      pairing.size + fresh > PAIRING_ROWS
    ) {
      if (visible) cut.add(metric_id);
      continue;
    }
    spent.set(metric_id, total);
    characters += cost;
    done.add(joined);
    for (const string of strings) pairing.add(string);
  }
  return { names: [...pairing], cut };
}

/**
 * Likely merges for the given metrics, from names alone: a measure of one
 * whose name is a measure name of another metric plus one word that marks a
 * shift, from `drafting.name_hints` or `drafting.period_words` (`Revenue USD`
 * and `Revenue`). The DAX could not prove them the same calculation, so an
 * agent checks before it merges. The asked metrics' names say which names can
 * pair with them, so only those are read and not every measure in the book.
 * `cut` names the asked metrics that lost a name the caller may describe to the
 * limits of `pairingOf`. `describable` is required: no caller means no rights.
 */
export async function suggestMerges(
  db: Db,
  metricIds: string[],
  conventions: Conventions,
  describable: SQL,
): Promise<{ suggestions: MergeSuggestion[]; cut: Set<string> }> {
  const asked = new Set(metricIds);
  if (asked.size === 0) return { suggestions: [], cut: new Set() };
  const { name_hints, period_words } = conventions.drafting;
  const hintsOf = <A extends "period" | "currency">(
    axis: A,
    words: readonly string[],
  ) =>
    [...new Set(words)].map((word) => ({ axis, word, words: wordsOf(word) }));
  const hints: Hint[] = [
    ...hintsOf("period", [
      ...name_hints.period,
      ...Object.values(period_words).flat(),
    ]),
    ...hintsOf("currency", name_hints.currency),
  ];
  // `is true`, so a NULL from a policy on a nullable column is not visible and cannot sort first.
  const reach = sql<boolean>`bool_or((${describable}) is true)`;
  const held = await liveHeld(
    db,
    { visible: reach },
    inArray(metricVariant.metric_id, metricIds),
  )
    .groupBy(metricVariant.metric_id, powerbiMeasure.name)
    .orderBy(
      desc(reach),
      asc(powerbiMeasure.name),
      asc(metricVariant.metric_id),
    );
  const { names: pairing, cut } = pairingOf(held, hints);
  // The planner prices an array it can see one element at a time, which past this costs more than the read.
  // `offset 0` folds each name once: under a nested loop a planner without statistics would fold it per element.
  const measures = await measuresWhere(
    db,
    pairing.length > PRICED_NAMES
      ? sql`${powerbiMeasure.id} in (
          select folded.id
            from (select ${powerbiMeasure.id} as id, ${nameWords} as words from ${powerbiMeasure} offset 0) folded
           where folded.words in (select unnest(${sql.param(pairing)}::text[])))`
      : sql`${nameWords} = any(${sql.param(pairing)}::text[])`,
  );
  // Asked apart, so the plan of the read above does not carry the caller's rights.
  const visible = new Set(
    (
      await measuresWhere(
        db,
        and(
          sql`${powerbiMeasure.id}::text = any(${sql.param(measures.map((m) => m.measure_id))}::text[])`,
          describable,
        ),
      )
    ).map((m) => m.measure_id),
  );
  const holders = holdersOf(measures, visible);
  const byWords = new Map<string, typeof holders>();
  for (const holder of holders) {
    const key = wordsOf(holder.name).join(" ");
    const same = byWords.get(key);
    if (same === undefined) byWords.set(key, [holder]);
    else same.push(holder);
  }

  const suggestions: MergeSuggestion[] = [];
  const seen = new Set<string>();
  // A pair with a side the caller may not describe is counted apart, so it
  // cannot use up the entries of a pair the caller may see.
  const offered = new Map<string, number>();
  // Each asked metric has two counts, and once all are full no later pair can be offered.
  const full = () =>
    [...offered.values()].filter((n) => n >= WORD_ENTRY_LIMIT).length ===
    asked.size * 2;
  for (const holder of holders) {
    if (full()) break;
    const words = wordsOf(holder.name);
    for (const hint of hints) {
      for (let at = 0; at + hint.words.length <= words.length; at += 1) {
        const span = words.slice(at, at + hint.words.length);
        if (span.join(" ") !== hint.words.join(" ")) continue;
        const rest = [...words.slice(0, at), ...words.slice(at + span.length)];
        for (const into of byWords.get(rest.join(" ")) ?? []) {
          const counted = [holder.metric_id, into.metric_id]
            .filter((id) => asked.has(id))
            .map(
              (id) => `${holder.visible && into.visible ? "" : "hidden "}${id}`,
            );
          if (
            rest.length === 0 ||
            into.metric_id === holder.metric_id ||
            counted.length === 0 ||
            counted.some((key) => (offered.get(key) ?? 0) >= WORD_ENTRY_LIMIT)
          ) {
            continue;
          }
          const pair = JSON.stringify([
            holder.metric_id,
            holder.name,
            into.metric_id,
            into.name,
          ]);
          if (seen.has(pair)) continue;
          seen.add(pair);
          for (const key of counted)
            offered.set(key, (offered.get(key) ?? 0) + 1);
          suggestions.push({
            metric_id: holder.metric_id,
            measure: holder.name,
            measure_ids: holder.measure_ids,
            into_metric_id: into.metric_id,
            into_measure: into.name,
            into_measure_ids: into.measure_ids,
            word: hint.word,
            axis: hint.axis,
          });
        }
      }
    }
  }
  return { suggestions, cut };
}

/**
 * Likely merges for the given metrics, of two more kinds: another metric holding
 * a base measure of the same fingerprint, usually under another name, which the
 * drafter keeps apart because a reader of one need not see the other, or a
 * measure of one of its names. Among the measures `describable` lets the caller
 * read, each pair once, proof first, and at most a few for each metric. A name
 * or a calculation no asked metric holds cannot pair, so only those are read.
 */
export async function suggestSameNames(
  db: Db,
  metricIds: string[],
  describable: SQL | undefined,
): Promise<MergeSuggestion[]> {
  const asked = new Set(metricIds);
  if (asked.size === 0) return [];
  const own = await measuresWhere(
    db,
    and(inArray(metricVariant.metric_id, metricIds), describable),
  );
  const names = new Set(own.map(({ name }) => wordsOf(name).join(" ")));
  const calculations = new Set(
    own.flatMap(({ base, fingerprint }) =>
      base && fingerprint !== null ? [fingerprint] : [],
    ),
  );
  const measures = await measuresWhere(
    db,
    and(
      or(
        sql`${nameWords} = any(${sql.param([...names])}::text[])`,
        sql`${powerbiMeasure.fingerprint} = any(${sql.param([...calculations])}::text[])`,
      ),
      describable,
    ),
  );
  // One holder a metric: a pair is of metrics, and a crafted model can put
  // thousands of names of one calculation, or spellings of one name, in one draft.
  type Holder = ReturnType<typeof holdersOf>[number];
  const add = (
    groups: Map<string, Map<string, Holder>>,
    key: string,
    holder: Holder,
  ) => {
    const same = groups.get(key) ?? new Map<string, Holder>();
    groups.set(key, same);
    if (!same.has(holder.metric_id)) same.set(holder.metric_id, holder);
  };
  const byWords = new Map<string, Map<string, Holder>>();
  for (const holder of holdersOf(measures))
    add(byWords, wordsOf(holder.name).join(" "), holder);
  const bases = new Map<string, typeof measures>();
  for (const measure of measures) {
    if (!measure.base || measure.fingerprint === null) continue;
    const same = bases.get(measure.fingerprint);
    if (same === undefined) bases.set(measure.fingerprint, [measure]);
    else same.push(measure);
  }
  const byCalculation = new Map<string, Map<string, Holder>>();
  for (const [calculation, same] of bases)
    for (const holder of holdersOf(same))
      add(byCalculation, calculation, holder);
  const offered = new Map<string, Set<string>>();
  const suggestions: MergeSuggestion[] = [];
  const kinds = [
    ["calculation", byCalculation],
    ["name", byWords],
  ] as const;
  for (const [axis, groups] of kinds)
    for (const metrics of groups.values()) {
      const same = [...metrics.values()];
      for (const holder of same) {
        if (!asked.has(holder.metric_id)) continue;
        const others = offered.get(holder.metric_id) ?? new Set<string>();
        offered.set(holder.metric_id, others);
        for (const into of same) {
          if (others.size >= SAME_NAME_LIMIT) break;
          // A pair counts on both sides: offered once, and towards both limits.
          const theirs = offered.get(into.metric_id) ?? new Set<string>();
          offered.set(into.metric_id, theirs);
          if (
            into.metric_id === holder.metric_id ||
            others.has(into.metric_id) ||
            theirs.size >= SAME_NAME_LIMIT
          )
            continue;
          others.add(into.metric_id);
          theirs.add(holder.metric_id);
          suggestions.push({
            metric_id: holder.metric_id,
            measure: holder.name,
            measure_ids: holder.measure_ids,
            into_metric_id: into.metric_id,
            into_measure: into.name,
            into_measure_ids: into.measure_ids,
            word: null,
            axis,
          });
        }
      }
    }
  return suggestions;
}
