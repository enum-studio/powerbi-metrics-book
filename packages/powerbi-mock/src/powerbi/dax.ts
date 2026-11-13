import type { Column, Dataset, Table } from "../tenant.js";
import { guidFrom } from "./wire.js";

export type Row = Record<string, unknown>;
export type Evaluation = { rows: Row[] } | { failure: string };

const TABLE_REFERENCE = /^(?:'((?:[^']|'')+)'|([A-Za-z_]\w*))$/;
const INFO_VIEW_COLUMNS = {
  RELATIONSHIPS:
    "FromTable,FromColumn,FromCardinality,ToTable,ToColumn,ToCardinality,CrossFilteringBehavior,IsActive".split(
      ",",
    ),
  MEASURES: ["Name", "DisplayFolder"],
  COLUMNS: ["Table", "Name", "DisplayFolder"],
};

function squash(dax: string): string {
  return dax.replace(/\s+/g, " ").trim();
}

/** Comments become spaces, so an offset in the result is an offset in the query. */
function blankComments(query: string): string {
  return query.replace(/\/\*[\s\S]*?\*\/|(?:\/\/|--)[^\n]*/g, (comment) =>
    comment.replace(/[^\n]/g, " "),
  );
}

/** Power BI's "Query (line, column) message" form, 1-based. */
function failure(text: string, offset: number, message: string): Evaluation {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - before.lastIndexOf("\n");
  return { failure: `Query (${String(line)}, ${String(column)}) ${message}` };
}

/** The hidden RowNumber-<guid> column the engine adds to every table. */
export function isRowNumber(column: Column): boolean {
  return column.name.startsWith("RowNumber-");
}

/**
 * A table's rows as executeQueries keys them: Table[Column], blank as null.
 * EVALUATE of a table never returns its RowNumber column.
 */
function tableRows(table: Table): Row[] {
  const columns = table.columns.filter((column) => !isRowNumber(column));
  return table.rows.map((row) =>
    Object.fromEntries(
      columns.map((column) => [
        `${table.name}[${column.name}]`,
        row[column.name] ?? null,
      ]),
    ),
  );
}

/**
 * Column names as DAX returns them, in square brackets.
 * https://learn.microsoft.com/en-us/dax/info-view-relationships-function-dax
 */
function relationshipRows(dataset: Dataset): Row[] {
  return dataset.relationships.map((relationship, index) => ({
    "[ID]": index + 1,
    "[Name]": guidFrom(`${dataset.id}/relationship/${String(index)}`),
    "[Relationship]": `${relationship.from_table}[${relationship.from_column}] -> ${relationship.to_table}[${relationship.to_column}]`,
    "[Model]": dataset.id,
    "[IsActive]": relationship.is_active,
    "[CrossFilteringBehavior]": relationship.cross_filtering_behavior,
    "[RelyOnReferentialIntegrity]": false,
    "[FromTable]": relationship.from_table,
    "[FromColumn]": relationship.from_column,
    "[FromCardinality]": relationship.from_cardinality,
    "[ToTable]": relationship.to_table,
    "[ToColumn]": relationship.to_column,
    "[ToCardinality]": relationship.to_cardinality,
    "[State]": "Ready",
    "[SecurityFilteringBehavior]": "OneDirection",
  }));
}

/**
 * [Expression], [DetailRowsDefinition] and [FormatStringDefinition] are
 * shown "only ... when run by users with write permission on the semantic
 * model"; the mock writes null for anyone else. The tenant model has no
 * detail rows or dynamic format strings, so the last two are null always.
 * https://learn.microsoft.com/en-us/dax/info-view-measures-function-dax
 */
function measureRows(dataset: Dataset, shows_definitions: boolean): Row[] {
  return dataset.tables
    .flatMap((table) => table.measures.map((measure) => ({ table, measure })))
    .map(({ table, measure }, index) => ({
      "[ID]": index + 1,
      "[Name]": measure.name,
      "[Table]": table.name,
      "[Description]": measure.description,
      "[DataType]": "Variant",
      "[Expression]": shows_definitions ? measure.expression : null,
      "[FormatString]": measure.format_string,
      "[IsHidden]": measure.hidden,
      "[State]": "Ready",
      "[KPIID]": null,
      "[IsSimpleMeasure]": false,
      "[DisplayFolder]": measure.display_folder,
      "[DetailRowsDefinition]": null,
      "[DataCategory]": null,
      "[FormatStringDefinition]": null,
      "[LineageTag]": guidFrom(`${dataset.id}/${table.name}/${measure.name}`),
    }));
}

/** https://learn.microsoft.com/en-us/dax/info-view-columns-function-dax */
function columnRows(dataset: Dataset): Row[] {
  return dataset.tables.flatMap((table) =>
    table.columns.map((column) => ({
      "[Table]": table.name,
      "[Name]": column.name,
      "[ExplicitName]": column.name,
      "[DataType]": column.data_type,
      "[IsHidden]": column.hidden,
      "[Expression]": column.expression ?? null,
      "[DisplayFolder]": column.display_folder ?? null,
    })),
  );
}

/**
 * What the mock can answer: a recorded query, EVALUATE of a table or of
 * TOPN(n, table), and the INFO.VIEW functions the catalog reads, each
 * after an optional DEFINE block whose definitions none of them can use.
 * The rest of DAX needs a real engine, so it answers the failure Power BI
 * gives for a query it cannot run.
 */
export function evaluate(
  dataset: Dataset,
  query: string,
  caller: { shows_definitions: boolean },
): Evaluation {
  const recorded = dataset.recorded_queries.find(
    (candidate) => squash(candidate.dax) === squash(query),
  );
  if (recorded) return { rows: recorded.rows };

  const text = blankComments(query);
  const head = /^\s*(?:DEFINE\s[\s\S]*?)?\bEVALUATE\s+/i.exec(text);
  if (!head) {
    return failure(
      text,
      Math.max(0, text.search(/\S/)),
      "A DAX query must start with EVALUATE, or with DEFINE and then EVALUATE.",
    );
  }
  const start = head[0].length;
  const body = text.slice(start).replace(/[\s;]*$/, "");
  const unsupported = failure(
    text,
    start,
    "The mock evaluates EVALUATE of a table, EVALUATE TOPN(n, table), INFO.VIEW.RELATIONSHIPS(), INFO.VIEW.MEASURES(), INFO.VIEW.COLUMNS() and the dataset's recorded queries; it cannot evaluate this query.",
  );

  const view = body.replace(/\s+/g, "").toUpperCase();
  // Microsoft's executeQueries page says INFO functions are not supported;
  // most tenants answer them, some refuse, and the fixture says which.
  // https://learn.microsoft.com/en-us/rest/api/power-bi/datasets/execute-queries
  if (/INFO\.VIEW\./i.test(body) && dataset.refuses_info_views) {
    return failure(
      text,
      start,
      "INFO functions are not supported by the executeQueries API.",
    );
  }
  if (view === "INFO.VIEW.RELATIONSHIPS()")
    return { rows: relationshipRows(dataset) };
  if (view === "INFO.VIEW.MEASURES()")
    return { rows: measureRows(dataset, caller.shows_definitions) };
  if (view === "INFO.VIEW.COLUMNS()") return { rows: columnRows(dataset) };

  const selected =
    /^SELECTCOLUMNS\s*\(\s*INFO\.VIEW\.(RELATIONSHIPS|MEASURES|COLUMNS)\s*\(\s*\)\s*,([\s\S]*)\)$/i.exec(
      body,
    );
  if (selected !== null) {
    const viewType = selected[1]?.toUpperCase();
    const columns =
      INFO_VIEW_COLUMNS[viewType as keyof typeof INFO_VIEW_COLUMNS];
    const args: { alias: string; column: string }[] = [];
    let rest = selected[2]?.trim() ?? "";
    while (rest.length > 0) {
      const pair = /^"([^"\]]+)"\s*,\s*\[([^\]]+)\]/.exec(rest);
      if (pair === null) return unsupported;
      args.push({ alias: pair[1] ?? "", column: pair[2] ?? "" });
      rest = rest.slice(pair[0].length).trimStart();
      if (rest.length > 0) {
        if (!rest.startsWith(",")) return unsupported;
        rest = rest.slice(1).trimStart();
        if (rest.length === 0) return unsupported;
      }
    }
    if (
      args.length !== columns.length ||
      args.some(
        (arg, index) =>
          arg.column !== columns[index] || arg.alias !== columns[index],
      )
    )
      return unsupported;
    const rows =
      viewType === "RELATIONSHIPS"
        ? relationshipRows(dataset)
        : viewType === "COLUMNS"
          ? columnRows(dataset)
          : measureRows(dataset, caller.shows_definitions);
    return {
      rows: rows.map((row) =>
        Object.fromEntries(
          args.map(({ alias, column }) => [
            `[${alias}]`,
            row[`[${column}]`] ?? null,
          ]),
        ),
      ),
    };
  }

  const topn = /^TOPN\s*\(\s*(\d+)\s*,\s*([\s\S]+?)\s*\)$/i.exec(body);
  const reference = topn?.[2] ?? body;
  const match = TABLE_REFERENCE.exec(reference);
  if (!match) return unsupported;

  const name = (match[1] ?? match[2] ?? "").replace(/''/g, "'");
  const table = dataset.tables.find(
    (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
  );
  if (!table) {
    return failure(
      text,
      start + body.lastIndexOf(reference),
      `Failed to resolve name '${name}'. It is not a valid table, variable, or function name.`,
    );
  }
  const rows = tableRows(table);
  return { rows: topn ? rows.slice(0, Number(topn[1])) : rows };
}
