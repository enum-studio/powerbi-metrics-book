import { isColumnShape, lex, render } from "./tokens.js";

// Each returns something different on a report page with a slicer set than in a plain query.
const SELECTION_FUNCTIONS = new Set([
  "SELECTEDVALUE",
  "HASONEVALUE",
  "ISFILTERED",
  "ISCROSSFILTERED",
  "ISINSCOPE",
]);

/**
 * Whether the expression reads the selection, and the columns those calls
 * name, as written and each once. A table argument (`ISFILTERED('Date')`)
 * reads the selection but names no column.
 */
export function readsSelection(expression: string): {
  reads: boolean;
  columns: string[];
} {
  const tokens = lex(expression);
  let reads = false;
  const columns = new Map<string, string>();
  for (const [at, token] of tokens.entries()) {
    if (token.kind !== "function" || !SELECTION_FUNCTIONS.has(token.text))
      continue;
    reads = true;
    // Only the first argument is the column read; SELECTEDVALUE's second is its
    // fallback value. Read from the tokens where it must be, so that calls nested
    // in calls cost no walk over the rest of the DAX.
    const end = tokens[at + 3]?.kind === "column" ? at + 4 : at + 3;
    const column = tokens.slice(at + 2, end);
    const after = tokens[end]?.kind;
    if (!isColumnShape(column) || (after !== "comma" && after !== "close"))
      continue;
    const key = render(column);
    if (!columns.has(key))
      columns.set(key, column.map((part) => part.source).join(""));
  }
  return { reads, columns: [...columns.values()] };
}
