import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../../context.js";
import { powerbiRelationship } from "../../db/schema/mirror.js";
import { foldSql } from "../../db/schema/pii.js";
import { hidesNothing, type PiiNames } from "./query-check.js";
import type { NamesByTable } from "./rules.js";

/*
 * A column joined by a relationship to a PII column carries the same values,
 * and so does an auto date table built on one. The ends are added to the names
 * the query check reads, to a fixed point; the search index and the metadata
 * surfaces keep the names `piiNamesOf` returns.
 */

const copy = (found: NamesByTable): NamesByTable =>
  new Map([...found].map(([table, names]) => [table, new Set(names)]));

const add = (found: NamesByTable, table: string, name: string) =>
  found.set(table, (found.get(table) ?? new Set<string>()).add(name));

/** The names with the other ends of every relationship that touches a PII end. */
export async function withRelatedEnds(
  db: Db,
  dataset_id: string,
  names: PiiNames,
): Promise<PiiNames> {
  const out: PiiNames = {
    columns: copy(names.columns),
    bare: new Set(names.bare),
    measures: copy(names.measures),
    tables: new Set(names.tables),
    ruleColumns: copy(names.ruleColumns),
    ruleMeasures: copy(names.ruleMeasures),
    ruleTables: copy(names.ruleTables),
    knownMeasures: copy(names.knownMeasures),
  };
  if (hidesNothing(names)) return out;
  const relationships = await db
    .select({
      from_table: foldSql(powerbiRelationship.from_table),
      from_column: foldSql(powerbiRelationship.from_column),
      to_table: foldSql(powerbiRelationship.to_table),
      to_column: foldSql(powerbiRelationship.to_column),
      cardinality: powerbiRelationship.cardinality,
    })
    .from(powerbiRelationship)
    .where(
      and(
        eq(powerbiRelationship.dataset_id, dataset_id),
        isNull(powerbiRelationship.removed_at),
      ),
    );

  // A column of a table under a rule is PII unless a column rule cleared it.
  const isPii = (table: string, column: string) =>
    out.columns.get(table)?.has(column) === true ||
    out.ruleColumns.get(table)?.has(column) === true ||
    out.ruleTables.get(table)?.has(column) === false;
  const wholeTable = (table: string) => {
    if (out.ruleTables.get(table)?.size === 0) return false;
    out.tables.add(table);
    out.ruleTables.set(table, new Set());
    return true;
  };
  // A foreign key is PII because of the relationship that named it, which must not read it back as a PII `from` end.
  const derivedBy = new Map<string, number>();
  const foreignKey = (table: string, column: string, by: number) => {
    if (isPii(table, column)) return false;
    add(out.columns, table, column);
    out.bare.add(column);
    out.tables.add(table);
    derivedBy.set(`${table}[${column}]`, by);
    return true;
  };

  for (let changed = true; changed;) {
    changed = false;
    for (const [at, end] of relationships.entries()) {
      // One to one and many to many have no many side: the other table is PII whole.
      const sameGrain =
        end.cardinality === "one_to_one" || end.cardinality === "many_to_many";
      const fromIsMany = end.cardinality !== "one_to_many";
      const manyTable = fromIsMany ? end.from_table : end.to_table;
      const manyColumn = fromIsMany ? end.from_column : end.to_column;
      const oneTable = fromIsMany ? end.to_table : end.from_table;
      const oneColumn = fromIsMany ? end.to_column : end.from_column;
      if (
        isPii(manyTable, manyColumn) &&
        derivedBy.get(`${manyTable}[${manyColumn}]`) !== at
      )
        changed = wholeTable(oneTable) || changed;
      if (isPii(oneTable, oneColumn))
        changed =
          (sameGrain
            ? wholeTable(manyTable)
            : foreignKey(manyTable, manyColumn, at)) || changed;
    }
  }
  return out;
}
