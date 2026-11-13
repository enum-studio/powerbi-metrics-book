import { createHash } from "node:crypto";
import { simplify } from "./simplify.js";
import {
  type DaxToken,
  type SourceToken,
  isColumnShape,
  lex,
  normalize,
  render,
} from "./tokens.js";

/** Lower-cased measure name to its expression and normalised home table, for one dataset. */
export type MeasureMap = ReadonlyMap<
  string,
  { name: string; expression: string; table: string }
>;

export function measureMap<T extends { name: string; table: string }>(
  measures: readonly T[],
): ReadonlyMap<string, Omit<T, "table"> & { table: string }> {
  // Measures share tables: each table's name is read, and held, once.
  const tables = new Map<string, string>();
  const tableOf = (name: string) => {
    const table =
      tables.get(name) ?? normalize(`'${name.replaceAll("'", "''")}'`);
    tables.set(name, table);
    return table;
  };
  return new Map(
    measures.map((measure) => [
      measure.name.toLowerCase(),
      { ...measure, table: tableOf(measure.table) },
    ]),
  );
}

export type MeasureRef = { key: string; label: string; length: number };

/** A measure's expansion: its own tokens and the expansions of what it references, by reference, not yet copied. */
type Written = { parts: (DaxToken | Written)[]; chars: number };

const CALCULATE: DaxToken = { kind: "function", text: "CALCULATE" };
const OPEN: DaxToken = { kind: "open", text: "(" };
const CLOSE: DaxToken = { kind: "close", text: ")" };
// A tenant's DAX is untrusted: references that fan out grow a measure twofold a
// level, and a long literal read many times grows faster, in memory no catch can
// recover. What a measure may hold or write out to, in characters because a
// token can be any length, and how deep its references may go, which also bounds
// the recursion over them.
const MAX_DAX_CHARS = 500_000;
const MAX_EXPANSION_DEPTH = 200;
const TOO_LONG = `Its DAX writes out to more than ${String(MAX_DAX_CHARS)} characters.`;
const REFERENCE_CHARS = "CALCULATE()".length;

/** The sentence that says the DAX is too long to read, or null when it may be read. */
export function tooLongToRead(expression: string): string | null {
  return expression.length > MAX_DAX_CHARS ? TOO_LONG : null;
}

export function expressionOf(measures: MeasureMap, name: string): string {
  const measure = measures.get(name.toLowerCase());
  if (measure === undefined)
    throw new Error(`No measure named "${name}" in this dataset`);
  return measure.expression;
}

// A measure reached from many others is read once for its dataset's map, while
// the tokens kept fit the worker's memory. Past that it is read again when reached.
const MAX_KEPT_TOKENS = 500_000;
type Readings = { kept: number; read: Map<string, readonly SourceToken[]> };
const readings = new WeakMap<MeasureMap, Readings>();

/** The measure's own tokens, in the one spelling that fingerprints and variant shapes read. */
export function tokensOf(
  measures: MeasureMap,
  name: string,
): readonly SourceToken[] {
  const known: Readings = readings.get(measures) ?? {
    kept: 0,
    read: new Map<string, readonly SourceToken[]>(),
  };
  readings.set(measures, known);
  const key = name.toLowerCase();
  const kept = known.read.get(key);
  if (kept !== undefined) return kept;
  const read = simplify(lex(expressionOf(measures, name)));
  if (known.kept + read.length <= MAX_KEPT_TOKENS) {
    known.kept += read.length;
    known.read.set(key, read);
  }
  return read;
}

/**
 * The measure reference starting at `from`: `[X]` or `'T'[X]` where X is a
 * measure of the dataset on table T. `key` is X lower-cased, `label` is X as written, and
 * `length` is how many tokens it takes.
 * For drafting, fingerprints and the query log; the PII query check deliberately
 * treats any T[X] as possibly measure X and must not use this function.
 */
export function measureRefAt(
  tokens: readonly SourceToken[],
  from: number,
  measures: ReadonlyMap<string, { table: string }>,
): MeasureRef | null {
  if (tokens[from - 1]?.kind === "table") return null;
  const first = tokens[from];
  const column = first?.kind === "table" ? tokens[from + 1] : first;
  if (column?.kind !== "column") return null;
  const key = column.name.toLowerCase();
  const measure = measures.get(key);
  if (measure === undefined) return null;
  if (first?.kind === "table" && first.text !== measure.table) return null;
  return { key, label: column.name, length: column === first ? 1 : 2 };
}

/** The measure these tokens are, when they are exactly one measure reference. */
export function measureRef(
  tokens: readonly SourceToken[],
  measures: MeasureMap,
): MeasureRef | null {
  const ref = measureRefAt(tokens, 0, measures);
  return ref?.length === tokens.length ? ref : null;
}

/** True when these tokens are exactly one column reference that is not a measure. */
export function isColumnRef(
  tokens: readonly SourceToken[],
  measures: MeasureMap,
): boolean {
  return isColumnShape(tokens) && measureRef(tokens, measures) === null;
}

/**
 * The measure's expression with every measure reference replaced, recursively,
 * by `CALCULATE(` its own simplified expression `)`, normalised. That is what
 * a reference means: inside an iterator it transitions the context, and a
 * bracket around the written-out DAX does not. A reference cycle gives the
 * names on it in order, starting from the first one reached. A measure past the
 * limits gives the sentence that says so.
 */
export function expandMeasures(
  name: string,
  measures: MeasureMap,
): { expanded: string } | { cycle: string[] } | { too_large: string } {
  // Measures reached twice (a diamond) are expanded once, and only what passes
  // the limit is ever written out flat.
  const expanded = new Map<string, Written>();
  const path: { key: string; label: string }[] = [];

  const visit = (
    key: string,
    label: string,
  ): Written | { cycle: string[] } | { too_large: string } => {
    const open = path.findIndex((step) => step.key === key);
    if (open >= 0) return { cycle: path.slice(open).map((step) => step.label) };
    const known = expanded.get(key);
    if (known) return known;
    if (path.length >= MAX_EXPANSION_DEPTH)
      return {
        too_large: `Its measure references go more than ${String(MAX_EXPANSION_DEPTH)} levels deep.`,
      };

    path.push({ key, label });
    if (tooLongToRead(expressionOf(measures, label)) !== null)
      return { too_large: TOO_LONG };
    const tokens = tokensOf(measures, label);
    const written: Written = { parts: [], chars: 0 };
    let skip = 0;
    for (const [at, token] of tokens.entries()) {
      if (at < skip) continue;
      const ref = measureRefAt(tokens, at, measures);
      if (ref) {
        const inner = visit(ref.key, ref.label);
        if (!("parts" in inner)) return inner;
        written.parts.push(CALCULATE, OPEN, inner, CLOSE);
        written.chars += REFERENCE_CHARS + inner.chars;
        skip = at + ref.length;
      } else {
        written.parts.push(token);
        written.chars += token.text.length;
      }
      if (written.chars > MAX_DAX_CHARS) return { too_large: TOO_LONG };
    }
    path.pop();
    expanded.set(key, written);
    return written;
  };

  const result = visit(name.toLowerCase(), name);
  return "parts" in result
    ? { expanded: render(writtenOut(result, [])) }
    : result;
}

function writtenOut(written: Written, out: DaxToken[]): DaxToken[] {
  for (const part of written.parts) {
    if ("parts" in part) writtenOut(part, out);
    else out.push(part);
  }
  return out;
}

/** SHA-256 hex of the normalised, expanded expression. */
export function fingerprint(expanded: string): string {
  return createHash("sha256").update(normalize(expanded)).digest("hex");
}

/**
 * The measures the DAX references, as named in `measures` (matched
 * case-insensitively), in order of first use. Throws DaxSyntaxError when the
 * DAX does not tokenise.
 */
export function referencedMeasures(
  dax: string,
  measures: ReadonlyMap<string, { name: string; table: string }>,
): string[] {
  const found = new Set<string>();
  const tokens = lex(dax);
  for (const [at] of tokens.entries()) {
    const ref = measureRefAt(tokens, at, measures);
    const measure = ref === null ? undefined : measures.get(ref.key);
    if (measure !== undefined) found.add(measure.name);
  }
  return [...found];
}
