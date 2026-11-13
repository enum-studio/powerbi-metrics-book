import { createHash } from "node:crypto";
import {
  type MeasureMap,
  type MeasureRef,
  expandMeasures,
  expressionOf,
  isColumnRef,
  measureRef,
  measureRefAt,
  tokensOf,
} from "./measures.js";
import {
  DaxSyntaxError,
  type SourceToken,
  call,
  lex,
  render,
} from "./tokens.js";

export type Period =
  | "current"
  | "previous_year"
  | "previous_quarter"
  | "previous_month"
  | "previous_week"
  | "previous_day"
  | "year_to_date"
  | "quarter_to_date"
  | "month_to_date"
  | "previous_year_to_date"
  | "rolling_12_months"
  | "other";
export type Comparison = "none" | "difference" | "growth_rate" | "ratio";
export type Shift = {
  period: Period;
  comparison: Comparison;
  comparison_period: Period | null;
};

/** The words that say a period in a name, in a company's own language. */
export type PeriodWords = {
  previous_year: readonly string[];
  previous_quarter: readonly string[];
  previous_month: readonly string[];
  previous_week: readonly string[];
  previous_day: readonly string[];
};
/** What the conventions say about shapes that are a shift only by their reading. */
export type VariantRules = {
  period_words: PeriodWords;
  recognise_blank_as_zero: boolean;
};
export type RecognisedVariant = {
  base: string;
  shift: Shift;
  /** It shows 0 where the calculation is blank. */
  blank_as_zero?: true;
};

type PeriodVariant = {
  base: Pick<MeasureRef, "key" | "label">;
  period: Period;
  blank_as_zero?: true;
};
type Reading = {
  measures: MeasureMap;
  rules: VariantRules;
  /** What each measure is, once read: a slicer's IF reads its shift twice. */
  periods: Map<string, PeriodVariant | null>;
  /** The filter each shift applies, once read. */
  filters: Map<string, string>;
};

const TOTAL_TO_DATE: Readonly<Record<string, Period>> = {
  TOTALYTD: "year_to_date",
  TOTALQTD: "quarter_to_date",
  TOTALMTD: "month_to_date",
};
const DATES_TO_DATE: Readonly<Record<string, Period>> = {
  DATESYTD: "year_to_date",
  DATESQTD: "quarter_to_date",
  DATESMTD: "month_to_date",
};
/**
 * Functions that read another period than the one selected, or more of it.
 * LASTDATE, ENDOFYEAR, CLOSINGBALANCEYEAR and their like are left out: they pick
 * a date inside the selection, which a stock's closing figure is.
 */
const PERIOD_SHIFTS = new Set([
  ...Object.keys(TOTAL_TO_DATE),
  ...Object.keys(DATES_TO_DATE),
  "TOTALWTD",
  "DATESWTD",
  "DATEADD",
  "DATESBETWEEN",
  "DATESINPERIOD",
  "PARALLELPERIOD",
  "SAMEPERIODLASTYEAR",
  "PREVIOUSDAY",
  "PREVIOUSWEEK",
  "PREVIOUSMONTH",
  "PREVIOUSQUARTER",
  "PREVIOUSYEAR",
  "NEXTDAY",
  "NEXTWEEK",
  "NEXTMONTH",
  "NEXTQUARTER",
  "NEXTYEAR",
  "OPENINGBALANCEMONTH",
  "OPENINGBALANCEQUARTER",
  "OPENINGBALANCEYEAR",
]);
const DATEADD_BACK: readonly [by: string, unit: string, period: Period][] = [
  ["1", "year", "previous_year"],
  ["1", "quarter", "previous_quarter"],
  ["1", "month", "previous_month"],
  ["1", "week", "previous_week"],
  ["7", "day", "previous_week"],
  ["1", "day", "previous_day"],
];
/**
 * What may sit between the measures of a composed shift, and literals besides.
 * A filter around these reaches every measure in them. A slash stays out: a blank
 * over a blank is blank, and 0 / 0 is NaN.
 */
const ARITHMETIC = new Set(["+", "-", "*", "(", ")", ",", "DIVIDE"]);
// A composed shift, what it reads and its base are short, so a measure longer
// than this, or whose variables write it out longer, is never read as one. All
// of a dataset's measures are read to find a base, and a tenant's DAX is
// untrusted, so a digest of each is held and not its text.
const MAX_COMPOSED_CHARS = 4_000;
type Calculations = {
  /** A digest of what each measure read so far writes, or null when it is not arithmetic. */
  written: Map<string, string | null>;
  /** The first measure by name to write each calculation, by its digest. */
  bases: Map<string, PeriodVariant["base"]>;
};
const calculations = new WeakMap<MeasureMap, Calculations>();

/** A name's words in lower case, split where a letter or digit ends. */
export const wordsOf = (name: string): string[] =>
  name
    .toLowerCase()
    .split(/[^\p{L}\p{N}%]+/u)
    .filter((word) => word !== "");

/** Whether the name says any of these, by whole words. */
export function saysAny(name: string, list: readonly string[]): boolean {
  const spaced = ` ${wordsOf(name).join(" ")} `;
  return list.some((word) => spaced.includes(` ${wordsOf(word).join(" ")} `));
}

/** The periods this name says, by whole words. */
function periodsIn(name: string, words: PeriodWords): Period[] {
  const says = (list: readonly string[]) => saysAny(name, list);
  return (
    [
      ["previous_year", words.previous_year],
      ["previous_quarter", words.previous_quarter],
      ["previous_month", words.previous_month],
      ["previous_week", words.previous_week],
      ["previous_day", words.previous_day],
    ] as const
  ).flatMap(([period, list]) => (says(list) ? [period] : []));
}

/** Whether the name says a period, and not this one. */
function contradicts(
  name: string,
  period: Period,
  words: PeriodWords,
): boolean {
  const named = periodsIn(name, words);
  return named.length > 0 && !named.includes(period);
}

/**
 * The base measure and shift when the measure's own expression, before
 * expansion and in its simplified spelling, is exactly one of the known
 * variant shapes around another measure. Anything more in it (another filter,
 * a FILTER, a KEEPFILTERS) is a different calculation and gives null, as does
 * a measure on a reference cycle. The base is named as the expression writes
 * it, or for a composed shift, which writes no base, as the dataset does.
 */
export function recogniseVariant(
  name: string,
  measures: MeasureMap,
  rules: VariantRules,
): RecognisedVariant | null {
  // Only an expansion that ends bounds the recursion below: acyclic, and not too deep.
  if (!("expanded" in expandMeasures(name, measures))) return null;
  const reading = { measures, rules, periods: new Map(), filters: new Map() };
  const tokens = tokensOf(measures, name);
  const comparison = matchComparison(tokens, reading);
  if (comparison) return comparison;
  const variant = matchPeriod(tokens, name, reading);
  if (!variant) return null;
  return {
    base: variant.base.label,
    shift: {
      period: variant.period,
      comparison: "none",
      comparison_period: null,
    },
    ...(variant.blank_as_zero && { blank_as_zero: true }),
  };
}

/** Whether the DAX, with its measures written out, calls a function that shifts a period. */
export const shiftsPeriod = (expanded: string): boolean =>
  lex(expanded).some(
    ({ kind, text }) => kind === "function" && PERIOD_SHIFTS.has(text),
  );

function wholeCall(tokens: readonly SourceToken[]): ReturnType<typeof call> {
  const found = call(tokens, 0);
  return found?.end === tokens.length ? found : null;
}

function isMinus(tokens: readonly SourceToken[], number: string): boolean {
  return (
    tokens.length === 2 &&
    tokens[0]?.kind === "operator" &&
    tokens[0].text === "-" &&
    tokens[1]?.kind === "number" &&
    tokens[1].text === number
  );
}

function isWord(tokens: readonly SourceToken[], word: string): boolean {
  return (
    tokens.length === 1 &&
    tokens[0]?.kind === "identifier" &&
    tokens[0].text === word
  );
}

const isZero = (tokens: readonly SourceToken[]): boolean =>
  tokens.length === 1 && tokens[0]?.kind === "number" && tokens[0].text === "0";

/** What COALESCE(<x>, 0) wraps, when the conventions read it as <x> showing 0 for a blank. */
function insideBlankAsZero(
  outer: NonNullable<ReturnType<typeof call>>,
  rules: VariantRules,
): SourceToken[] | null {
  const [inner, zero, ...rest] = outer.argumentList;
  return rules.recognise_blank_as_zero &&
    inner &&
    zero &&
    rest.length === 0 &&
    isZero(zero)
    ? inner
    : null;
}

function periodOfMeasure(
  ref: MeasureRef,
  reading: Reading,
): PeriodVariant | null {
  const known = reading.periods.get(ref.key);
  if (known !== undefined) return known;
  const found = matchPeriod(
    tokensOf(reading.measures, ref.key),
    ref.label,
    reading,
  );
  reading.periods.set(ref.key, found);
  return found;
}

// COALESCE(<a shift>, 0), or the shift itself.
function matchPeriod(
  tokens: readonly SourceToken[],
  name: string,
  reading: Reading,
): PeriodVariant | null {
  const outer = wholeCall(tokens);
  if (outer?.name !== "COALESCE") return matchSelected(tokens, name, reading);
  const inner = insideBlankAsZero(outer, reading.rules);
  const found = inner && matchSelected(inner, name, reading);
  return found ? { ...found, blank_as_zero: true } : null;
}

/** `SELECTEDVALUE(c) = "x"`, with or without a fallback that is a string. */
function isSlicerTest(
  tokens: readonly SourceToken[],
  measures: MeasureMap,
): boolean {
  const selected = call(tokens, 0);
  const [column, fallback, ...extra] = selected?.argumentList ?? [];
  if (
    selected?.name !== "SELECTEDVALUE" ||
    !column ||
    !isColumnRef(column, measures) ||
    extra.length > 0 ||
    (fallback && (fallback.length !== 1 || fallback[0]?.kind !== "string"))
  )
    return false;
  const [equals, value, ...rest] = tokens.slice(selected.end);
  return equals?.text === "=" && value?.kind === "string" && rest.length === 0;
}

// IF(<a slicer's value>, <a shift>, <a shift>): the slicer picks which date to
// shift along, and either way it is the same shift of the same measure.
function matchSelected(
  tokens: readonly SourceToken[],
  name: string,
  reading: Reading,
): PeriodVariant | null {
  const outer = wholeCall(tokens);
  if (outer?.name !== "IF")
    return (
      matchShift(tokens, name, reading) ?? matchComposed(tokens, name, reading)
    );
  const [test, one, other, ...rest] = outer.argumentList;
  if (
    !test ||
    !one ||
    !other ||
    rest.length > 0 ||
    !isSlicerTest(test, reading.measures)
  )
    return null;
  const first = matchShift(one, name, reading);
  const second = matchShift(other, name, reading);
  if (first?.base.key !== second?.base.key || first?.period !== second?.period)
    return null;
  return second?.blank_as_zero ? second : first;
}

function periodOfDateAdd(
  by: readonly SourceToken[],
  unit: readonly SourceToken[],
): Period | null {
  const back = DATEADD_BACK.find(
    ([count, word]) => isMinus(by, count) && isWord(unit, word),
  );
  return back ? back[2] : null;
}

/** The table a filter names, by a column of it or as the whole table. */
function tableOf(tokens: readonly SourceToken[]): string | null {
  const [first, second, ...rest] = tokens;
  if (first === undefined || rest.length > 0) return null;
  if (second === undefined)
    return first.kind === "table" || first.kind === "identifier"
      ? first.text
      : null;
  return first.kind === "table" && second.kind === "column" ? first.text : null;
}

/** The column in MIN(c) and MAX(c), when they read one column of this table. */
function boundedBy(
  low: readonly SourceToken[],
  high: readonly SourceToken[],
  table: string,
  measures: MeasureMap,
): readonly SourceToken[] | null {
  const lowest = wholeCall(low);
  const highest = wholeCall(high);
  const [column, ...moreLow] = lowest?.argumentList ?? [];
  const [same, ...moreHigh] = highest?.argumentList ?? [];
  return lowest?.name === "MIN" &&
    highest?.name === "MAX" &&
    column &&
    same &&
    moreLow.length === 0 &&
    moreHigh.length === 0 &&
    render(column) === render(same) &&
    tableOf(column) === table &&
    isColumnRef(column, measures)
    ? column
    : null;
}

/** Whether the measure's expansion names the table, as a column's table or on its own. */
function namesTable(key: string, table: string, measures: MeasureMap): boolean {
  const expanded = expandMeasures(key, measures);
  return (
    !("expanded" in expanded) ||
    lex(expanded.expanded).some(
      (token) =>
        (token.kind === "table" || token.kind === "identifier") &&
        token.text === table,
    )
  );
}

/**
 * CALCULATE([B], <date filters>): every filter is on one table and nothing
 * else narrows the measure. How far back comes from a DATEADD, or from a
 * DATESBETWEEN between the first and last of another column, whose name says
 * the period in the conventions' words. Both may be there, on one column and
 * saying one period: they then intersect to that period, as long as the column
 * holds what its name says, which reading it alone trusts as well. A clear
 * beyond the shifted column is sound only on a calendar, which only a period
 * read from its columns shows. A table holding the measure is no calendar, and
 * nor is one the base names, as the clear would drop what the base reads.
 */
function matchDateFilters(
  base: MeasureRef,
  filters: readonly SourceToken[][],
  name: string,
  { measures, rules }: Reading,
): PeriodVariant | null {
  let table: string | null = null;
  let readsCalendar = false;
  const periods = new Set<Period>();
  const shifted = new Set<string>();
  const cleared: string[] = [];
  for (const filter of filters) {
    const found = wholeCall(filter);
    const [column, second, third, ...extra] = found?.argumentList ?? [];
    if (!found || !column || extra.length > 0) return null;
    const on = tableOf(column);
    if (on === null || (table !== null && on !== table)) return null;
    table = on;
    const isColumn = isColumnRef(column, measures);
    if (found.name === "REMOVEFILTERS" || found.name === "ALL") {
      // A column, or a whole table: a measure named as a table's column is neither.
      if (second || (column.length > 1 && !isColumn)) return null;
      cleared.push(isColumn ? render(column) : on);
    } else if (!isColumn || !second || !third) {
      return null;
    } else if (found.name === "DATEADD") {
      const period = periodOfDateAdd(second, third);
      if (!period) return null;
      periods.add(period);
      shifted.add(render(column));
    } else if (found.name === "DATESBETWEEN") {
      const calendar = boundedBy(second, third, on, measures);
      // Between the first and last of itself is no step back.
      if (!calendar || render(calendar) === render(column)) return null;
      const [period, ...others] = periodsIn(
        calendar.at(-1)?.name ?? "",
        rules.period_words,
      );
      if (!period || others.length > 0) return null;
      periods.add(period);
      shifted.add(render(column));
      readsCalendar = true;
    } else {
      return null;
    }
  }
  const [period, ...others] = periods;
  if (!period || others.length > 0 || shifted.size > 1) return null;
  if (cleared.some((clear) => !shifted.has(clear))) {
    const isHome = (key: string) => measures.get(key)?.table === table;
    if (
      !readsCalendar ||
      isHome(base.key) ||
      isHome(name.toLowerCase()) ||
      table === null ||
      namesTable(base.key, table, measures)
    )
      return null;
  }
  if (readsCalendar && contradicts(name, period, rules.period_words))
    return null;
  return { base, period };
}

// TOTALYTD([B], d), or CALCULATE([B], <one period filter>), or CALCULATE([B], <date filters>).
function matchShift(
  tokens: readonly SourceToken[],
  name: string,
  reading: Reading,
): PeriodVariant | null {
  const { measures } = reading;
  const outer = wholeCall(tokens);
  const [measure, filter, ...rest] = outer?.argumentList ?? [];
  if (!outer || !measure || !filter) return null;
  const base = measureRef(measure, measures);
  if (!base) return null;
  if (rest.length > 0)
    return outer.name === "CALCULATE"
      ? matchDateFilters(base, [filter, ...rest], name, reading)
      : null;

  const toDate = TOTAL_TO_DATE[outer.name];
  if (toDate)
    return isColumnRef(filter, measures) ? { base, period: toDate } : null;
  if (outer.name !== "CALCULATE") return null;

  const shift = wholeCall(filter);
  if (!shift) return null;
  if (shift.name === "DATESBETWEEN")
    return matchDateFilters(base, [filter], name, reading);
  const [column, by, unit, ...extra] = shift.argumentList;
  if (!column || extra.length > 0) return null;
  const onColumn = isColumnRef(column, measures);

  if (shift.name === "SAMEPERIODLASTYEAR" && onColumn && !by) {
    // The previous year of a year-to-date measure is the previous year to date of its base.
    const inner = periodOfMeasure(base, reading);
    if (inner?.period === "year_to_date")
      return { ...inner, period: "previous_year_to_date" };
    return { base, period: "previous_year" };
  }
  if (shift.name === "DATEADD" && onColumn && by && unit) {
    const period = periodOfDateAdd(by, unit);
    return period ? { base, period } : null;
  }
  if (shift.name === "PARALLELPERIOD" && onColumn && by && unit) {
    const yearBack =
      (isMinus(by, "12") && isWord(unit, "month")) ||
      (isMinus(by, "1") && isWord(unit, "year"));
    return yearBack ? { base, period: "previous_year" } : null;
  }

  const datesToDate = DATES_TO_DATE[shift.name];
  if (!datesToDate || by) return null;
  if (onColumn) return { base, period: datesToDate };
  const lastYear = wholeCall(column);
  const [lastYearColumn, ...lastYearRest] = lastYear?.argumentList ?? [];
  if (
    shift.name === "DATESYTD" &&
    lastYear?.name === "SAMEPERIODLASTYEAR" &&
    lastYearColumn &&
    lastYearRest.length === 0 &&
    isColumnRef(lastYearColumn, measures)
  ) {
    return { base, period: "previous_year_to_date" };
  }
  return null;
}

/**
 * A digest of the calculation these tokens write, with each measure named by
 * `nameOf`, when nothing but arithmetic on measures and literals is there. Null
 * when something else is, when `nameOf` refuses a measure, or when it writes out
 * too long.
 */
function calculationOf(
  tokens: readonly SourceToken[],
  measures: MeasureMap,
  nameOf: (ref: MeasureRef) => string | null,
): string | null {
  const digest = createHash("sha256");
  let chars = 0;
  let skip = 0;
  for (const [at, token] of tokens.entries()) {
    if (at < skip) continue;
    const ref = measureRefAt(tokens, at, measures);
    let part: string;
    if (ref) {
      const name = nameOf(ref);
      if (name === null) return null;
      part = `[${name.replaceAll("]", "]]")}] `;
      skip = at + ref.length;
    } else if (token.kind === "number" || ARITHMETIC.has(token.text)) {
      part = `${token.text} `;
    } else {
      return null;
    }
    chars += part.length;
    if (chars > MAX_COMPOSED_CHARS) return null;
    digest.update(part);
  }
  return digest.digest("hex");
}

function calculationsIn(measures: MeasureMap): Calculations {
  const known = calculations.get(measures) ?? {
    written: new Map<string, string | null>(),
    bases: new Map<string, PeriodVariant["base"]>(),
  };
  calculations.set(measures, known);
  return known;
}

function writtenBy(name: string, measures: MeasureMap): string | null {
  if (expressionOf(measures, name).length > MAX_COMPOSED_CHARS) return null;
  try {
    const tokens = tokensOf(measures, name);
    return calculationOf(tokens, measures, (ref) => ref.key);
  } catch (error) {
    // Its own analysis reports that it does not parse, and it is no one's base.
    if (error instanceof DaxSyntaxError) return null;
    throw error;
  }
}

/**
 * Reads what one measure writes, once. A composed shift looks for its base among
 * all of a dataset's measures, so a caller that must keep its event loop turning
 * reads them first, one at a time. Whatever is unread is read when a base is
 * looked for.
 */
export function readCalculation(name: string, measures: MeasureMap): void {
  const { written, bases } = calculationsIn(measures);
  const key = name.toLowerCase();
  if (written.has(key)) return;
  const calculation = writtenBy(name, measures);
  written.set(key, calculation);
  if (calculation === null) return;
  const first = bases.get(calculation);
  if (first === undefined || key < first.key)
    bases.set(calculation, { key, label: name });
}

function calculationsOf(measures: MeasureMap): Calculations {
  const known = calculationsIn(measures);
  if (known.written.size < measures.size)
    for (const { name } of measures.values()) readCalculation(name, measures);
  return known;
}

/** Whether two measures are one, or write one calculation to the letter. */
function isOneCalculation(
  one: string,
  other: string,
  measures: MeasureMap,
): boolean {
  if (one === other) return true;
  const { written } = calculationsOf(measures);
  const calculation = written.get(one);
  return (
    calculation !== undefined &&
    calculation !== null &&
    calculation === written.get(other)
  );
}

/**
 * The filter a shift applies: its text without the measure it shifts or a zero
 * for a blank. Two with one text apply one filter, from wherever they are read,
 * and so shift by one period. A column written bare is on the measure's own
 * table, and two measures can have two.
 */
function filterOf(ref: MeasureRef, base: string, reading: Reading): string {
  const known = reading.filters.get(ref.key);
  if (known !== undefined) return known;
  const { measures } = reading;
  const tokens = tokensOf(measures, ref.key);
  const outer = wholeCall(tokens);
  const shift =
    (outer?.name === "COALESCE" ? outer.argumentList[0] : undefined) ?? tokens;
  const home = measures.get(ref.key)?.table;
  const parts: string[] = [];
  let skip = 0;
  for (const [at, token] of shift.entries()) {
    if (at < skip) continue;
    const inner = measureRefAt(shift, at, measures);
    if (inner) {
      // A year to date that the previous year shifts again is part of the filter.
      parts.push(inner.key === base ? "[]" : filterOf(inner, base, reading));
      skip = at + inner.length;
    } else {
      if (home && token.kind === "column" && shift[at - 1]?.kind !== "table")
        parts.push(home);
      parts.push(token.text);
    }
  }
  const filter = parts.join(" ");
  reading.filters.set(ref.key, filter);
  return filter;
}

/** DIVIDE(a, b, 0) as DIVIDE(a, b). */
function withoutZeroAlternate(
  tokens: readonly SourceToken[],
): readonly SourceToken[] | null {
  const outer = wholeCall(tokens);
  const [, , alternate, ...rest] = outer?.argumentList ?? [];
  return outer?.name === "DIVIDE" &&
    alternate &&
    rest.length === 0 &&
    isZero(alternate)
    ? tokens.toSpliced(-3, 2)
    : null;
}

/**
 * DIVIDE([N LY], [D LY]) as the shift of DIVIDE([N], [D]). The base is what these
 * tokens write with each measure replaced by the one it shifts, whole and to the
 * letter. A filter around arithmetic reaches each measure in it, so the base
 * under a filter and the base with each measure under that filter are one
 * calculation. It has to be one filter: two shifts of one period can cover other
 * dates, as SAMEPERIODLASTYEAR and PARALLELPERIOD do on part of a month. A
 * measure's own zero stays out from under a `*`: `+`, `-` and DIVIDE turn at most
 * a blank result into 0, but a measure can be infinite through a slash inside it,
 * and a blank times infinity is blank where 0 times infinity is NaN.
 */
function matchComposed(
  tokens: readonly SourceToken[],
  name: string,
  reading: Reading,
): PeriodVariant | null {
  const { measures, rules } = reading;
  if (expressionOf(measures, name).length > MAX_COMPOSED_CHARS) return null;
  const shifts: { ref: MeasureRef; variant: PeriodVariant }[] = [];
  const toBase = (ref: MeasureRef) => {
    if (expressionOf(measures, ref.key).length > MAX_COMPOSED_CHARS)
      return null;
    const variant = periodOfMeasure(ref, reading);
    if (variant === null) return null;
    shifts.push({ ref, variant });
    return variant.base.key;
  };
  const written = calculationOf(tokens, measures, toBase);
  const [first] = shifts;
  if (written === null || first === undefined) return null;
  const ownZero = shifts.some((s) => s.variant.blank_as_zero);
  if (ownZero && tokens.some((token) => token.text === "*")) return null;
  const { period } = first.variant;
  const filter = filterOf(first.ref, first.variant.base.key, reading);
  const isOneFilter = shifts.every(
    ({ ref, variant }) => filterOf(ref, variant.base.key, reading) === filter,
  );
  if (!isOneFilter) return null;
  // A period read from a column's name, as in matchDateFilters.
  if (
    filter.includes("DATESBETWEEN") &&
    contradicts(name, period, rules.period_words)
  )
    return null;

  const { bases } = calculationsOf(measures);
  const exact = bases.get(written);
  const unzeroed = rules.recognise_blank_as_zero
    ? withoutZeroAlternate(tokens)
    : null;
  const plain = unzeroed && calculationOf(unzeroed, measures, toBase);
  const base = exact ?? (plain === null ? undefined : bases.get(plain));
  if (base === undefined) return null;
  reading.filters.set(name.toLowerCase(), filter);
  const zero = exact === undefined || ownZero;
  return { base, period, ...(zero && { blank_as_zero: true }) };
}

// [B] - [B_p]: the two measure references and nothing else.
function matchDifference(
  tokens: readonly SourceToken[],
  measures: MeasureMap,
): { current: MeasureRef; against: MeasureRef } | null {
  const current = measureRefAt(tokens, 0, measures);
  if (!current) return null;
  const minus = tokens[current.length];
  if (minus?.kind !== "operator" || minus.text !== "-") return null;
  const against = measureRef(tokens.slice(current.length + 1), measures);
  return against ? { current, against } : null;
}

// COALESCE(<a comparison>, 0), or the comparison itself.
function matchComparison(
  tokens: readonly SourceToken[],
  reading: Reading,
): RecognisedVariant | null {
  const outer = wholeCall(tokens);
  if (outer?.name !== "COALESCE") return matchCompared(tokens, reading);
  const inner = insideBlankAsZero(outer, reading.rules);
  const found = inner && matchCompared(inner, reading);
  return found ? { ...found, blank_as_zero: true } : null;
}

// [B] - [B_p], DIVIDE([B] - [B_p], [B_p]), DIVIDE([B], [B_p]) - 1 and DIVIDE([B], [B_p]).
function matchCompared(
  tokens: readonly SourceToken[],
  reading: Reading,
): RecognisedVariant | null {
  const { measures, rules } = reading;
  const compare = (
    current: MeasureRef,
    against: MeasureRef,
    comparison: Comparison,
    blank_as_zero: boolean,
  ): RecognisedVariant | null => {
    const variant = periodOfMeasure(against, reading);
    if (!variant || !isOneCalculation(variant.base.key, current.key, measures))
      return null;
    return {
      base: current.label,
      shift: {
        period: "current",
        comparison,
        comparison_period: variant.period,
      },
      ...((blank_as_zero || variant.blank_as_zero) && { blank_as_zero: true }),
    };
  };

  const difference = matchDifference(tokens, measures);
  if (difference)
    return compare(difference.current, difference.against, "difference", false);

  const divide = call(tokens, 0);
  const [numerator, denominator, alternate, ...rest] =
    divide?.argumentList ?? [];
  if (
    divide?.name !== "DIVIDE" ||
    !numerator ||
    !denominator ||
    rest.length > 0 ||
    (alternate && !(rules.recognise_blank_as_zero && isZero(alternate)))
  )
    return null;
  const zero = alternate !== undefined;
  const against = measureRef(denominator, measures);
  if (!against) return null;
  const current = measureRef(numerator, measures);

  if (divide.end === tokens.length) {
    if (current) return compare(current, against, "ratio", zero);
    const growth = matchDifference(numerator, measures);
    return growth?.against.key === against.key
      ? compare(growth.current, against, "growth_rate", zero)
      : null;
  }
  // A blank less 1 is -1 as 0 less 1 is, so here the zero changes nothing.
  if (current && isMinus(tokens.slice(divide.end), "1"))
    return compare(current, against, "growth_rate", false);
  return null;
}
