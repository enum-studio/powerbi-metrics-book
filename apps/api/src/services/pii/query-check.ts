import { and, DrizzleQueryError, eq, isNull } from "drizzle-orm";
import pg from "pg";
import type { Db } from "../../context.js";
import { lex, type SourceToken } from "../../dax/tokens.js";
import { powerbiDataset, powerbiTable } from "../../db/schema/mirror.js";
import { foldNames, type NamesByTable, type piiNamesOf } from "./rules.js";

/*
 * The refusal rule of a query for a person without pii_reader. The walk over
 * tokens is pure and takes names already folded; `checkQuery` and
 * `checkResultColumns` fold them in one `foldNames` call, so the database's
 * fold is the only one.
 */

export type PiiNames = Awaited<ReturnType<typeof piiNamesOf>>;
export type KnownTables = {
  trustworthy: boolean;
  names: ReadonlySet<string> | null;
};
/** A table, identifier, keyword or column token with its name folded. */
export type FoldedToken = SourceToken & { folded: string };
/** A result column key split at one `[`, both parts folded; a bare key `[name]` has an empty table. */
type ResultKey = { key: string; table: string; column: string };

/** Named when a name could not be folded: the query is refused, never allowed. */
export const UNCHECKABLE = "a name the check could not read";

const inTable = (found: NamesByTable, table: string, name: string) =>
  found.get(table)?.has(name) === true;

const onAnyTable = (found: NamesByTable, name: string) =>
  [...found.values()].some((names) => names.has(name));

/**
 * `t[c]` is PII when a rule or the mirror says so, when a table rule covers
 * `t` and `c` is neither cleared nor a synced measure, or when `c` is the name
 * of a PII measure on another table: Power BI resolves `Orders[Margin]` to
 * that measure. The mirror does not list non-PII columns, so only a synced
 * measure of `t` clears that last case.
 */
function qualifiedIsPii(names: PiiNames, table: string, column: string) {
  if (
    inTable(names.columns, table, column) ||
    inTable(names.ruleColumns, table, column) ||
    inTable(names.measures, table, column) ||
    inTable(names.ruleMeasures, table, column)
  )
    return true;
  const known = inTable(names.knownMeasures, table, column);
  if (
    onAnyTable(names.measures, column) ||
    onAnyTable(names.ruleMeasures, column)
  )
    return true;
  const cleared = names.ruleTables.get(table);
  return cleared !== undefined && !cleared.has(column) && !known;
}

/** Nothing to hide in this dataset: the walk would find nothing. */
export const hidesNothing = (names: PiiNames) =>
  names.columns.size === 0 &&
  names.bare.size === 0 &&
  names.measures.size === 0 &&
  names.tables.size === 0 &&
  names.ruleColumns.size === 0 &&
  names.ruleMeasures.size === 0 &&
  names.ruleTables.size === 0;

// A bare word is a table when `EVALUATE Customer` uses it whole; the lexer calls it an identifier.
const isTable = (token: { kind: string } | undefined): boolean =>
  token?.kind === "table" || token?.kind === "identifier";

/** Functions that read every column's values or expressions without naming one. */
function isModelWide(token: SourceToken): boolean {
  const name = token.source.normalize("NFKC").toUpperCase();
  return (
    name === "COLUMNSTATISTICS" ||
    name === "DETAILROWS" ||
    name === "EXTERNALMEASURE" ||
    name.startsWith("INFO.") ||
    /[^\x00-\x7f]/u.test(token.source)
  );
}

// `Order` is a keyword the lexer cannot tell from a table: it is one where an operand is expected.
const startsOperand = (token: SourceToken | undefined) =>
  token?.kind === "open" ||
  token?.kind === "comma" ||
  token?.kind === "operator" ||
  (token?.kind === "keyword" &&
    ["EVALUATE", "RETURN", "IN"].includes(token.text));

/** The PII references in the tokens, each as written, once, in order of first appearance. */
export function piiReferences(
  tokens: readonly FoldedToken[],
  names: PiiNames,
  knownTables: ReadonlySet<string>,
): string[] {
  const found = new Set<string>();
  const nothing = hidesNothing(names);
  tokens.forEach((token, index) => {
    const next = tokens[index + 1];
    const previous = tokens[index - 1];
    const nextIsOpen = next?.kind === "open";
    if (
      !nothing &&
      ((token.kind === "function" && isModelWide(token)) ||
        (nextIsOpen && (token.kind === "table" || token.kind === "column")) ||
        (token.source.normalize("NFKC").toUpperCase().startsWith("INFO") &&
          token.source.trimEnd().endsWith(".")) ||
        (nextIsOpen && /[^\x00-\x7f]/u.test(token.source)))
    )
      found.add(`the function ${token.source}`);
    if (
      token.kind !== "function" &&
      (isTable(token) || token.kind === "keyword")
    ) {
      // The body of a definition can name an unsynced column of its table bare.
      if (
        (token.text === "MEASURE" || token.text === "COLUMN") &&
        tokens[index + 2]?.kind === "column" &&
        (next?.kind === "table" || next?.kind === "keyword") &&
        names.ruleTables.has(next.folded)
      )
        found.add(`a definition on the table ${next.source}`);
      if (next?.kind === "column") {
        const unknownTable = !knownTables.has(token.folded);
        const bareIsPii =
          unknownTable &&
          (names.bare.has(next.folded) ||
            ([...names.ruleTables.values()].some(
              (cleared) => !cleared.has(next.folded),
            ) &&
              !onAnyTable(names.knownMeasures, next.folded)));
        if (bareIsPii) found.add(next.source);
        else if (qualifiedIsPii(names, token.folded, next.folded))
          found.add(token.source + next.source);
      } else if (
        (isTable(token) || startsOperand(previous)) &&
        names.tables.has(token.folded)
      )
        found.add(`the table ${token.source}`);
    } else if (
      token.kind === "column" &&
      !isTable(previous) &&
      names.bare.has(token.folded)
    )
      found.add(token.source);
  });
  return [...found];
}

/** The result column keys that are PII; a key listed once per split is named once. */
export function piiKeys(keys: readonly ResultKey[], names: PiiNames): string[] {
  return [
    ...new Set(
      keys
        .filter(({ table, column }) =>
          table === ""
            ? names.bare.has(column)
            : qualifiedIsPii(names, table, column),
        )
        .map(({ key }) => key),
    ),
  ];
}

/**
 * Folds the names with the database, in order. A missing row or a null is
 * `null`, and the caller refuses. So is a Postgres data error (SQLSTATE class
 * 22: a NUL, a bad encoding): the name cannot be read, and an error never
 * allows. Any other error is rethrown, so an outage surfaces as an outage.
 */
async function fold(db: Db, names: string[]): Promise<string[] | null> {
  let folded: readonly (string | null | undefined)[];
  try {
    folded = await foldNames(db, names);
  } catch (error) {
    const cause = error instanceof DrizzleQueryError ? error.cause : error;
    if (cause instanceof pg.DatabaseError && cause.code?.startsWith("22"))
      return null;
    throw error;
  }
  if (folded.length !== names.length) return null;
  const all: string[] = [];
  for (const name of folded) {
    if (typeof name !== "string") return null;
    all.push(name);
  }
  return all;
}

/** The PII references of a DAX query, empty when it is clean. `dax` has passed `checkDax`. */
export async function checkQuery(
  db: Db,
  dax: string,
  names: PiiNames,
  knownTables: ReadonlySet<string>,
): Promise<string[]> {
  if (hidesNothing(names)) return [];
  const tokens = lex(dax);
  const named = tokens.filter(
    (t) => isTable(t) || t.kind === "column" || t.kind === "keyword",
  );
  const folded = await fold(
    db,
    named.map((token) => token.name),
  );
  if (folded === null) return [UNCHECKABLE];
  const at = new Map(named.map((token, index) => [token, folded[index] ?? ""]));
  return piiReferences(
    tokens.map((token) => ({ ...token, folded: at.get(token) ?? "" })),
    names,
    knownTables,
  );
}

export async function knownTablesOf(
  db: Db,
  dataset_id: string,
): Promise<KnownTables> {
  const rows = await db
    .select({
      name: powerbiTable.name,
      schema_error: powerbiDataset.schema_error,
    })
    .from(powerbiDataset)
    .leftJoin(
      powerbiTable,
      and(
        eq(powerbiTable.dataset_id, powerbiDataset.id),
        isNull(powerbiTable.removed_at),
      ),
    )
    .where(eq(powerbiDataset.id, dataset_id));
  const tables = rows.flatMap((row) => (row.name === null ? [] : [row.name]));
  const folded = await fold(db, tables);
  return {
    trustworthy: rows[0]?.schema_error === null && tables.length > 0,
    names: folded === null ? null : new Set(folded),
  };
}

export function hasPiiInDataset(
  names: PiiNames,
  knownTables: ReadonlySet<string>,
): boolean {
  return [
    names.ruleTables,
    names.ruleColumns,
    names.ruleMeasures,
    names.columns,
    names.measures,
  ].some((group) => [...group.keys()].some((table) => knownTables.has(table)));
}

/** Every way to read a key `table[column]`: the table may itself hold a `[`. A key `[name]` has an empty table. */
function splits(key: string): ResultKey[] {
  if (!key.endsWith("]")) return [];
  if (key.startsWith("["))
    return [{ key, table: "", column: key.slice(1, -1) }];
  const found: ResultKey[] = [];
  for (let at = key.indexOf("["); at > 0; at = key.indexOf("[", at + 1))
    found.push({ key, table: key.slice(0, at), column: key.slice(at + 1, -1) });
  return found;
}

/** The result column keys that are PII, for the backstop after Power BI answers. */
export async function checkResultColumns(
  db: Db,
  columns: readonly { name: string }[],
  names: PiiNames,
): Promise<string[]> {
  if (hidesNothing(names)) return [];
  const keys = columns.flatMap((column) => splits(column.name));
  const folded = await fold(
    db,
    keys.flatMap(({ table, column }) => [table, column]),
  );
  if (folded === null) return [UNCHECKABLE];
  return piiKeys(
    keys.map((key, index) => ({
      key: key.key,
      table: key.table === "" ? "" : (folded[2 * index] ?? ""),
      column: folded[2 * index + 1] ?? "",
    })),
    names,
  );
}
