import type { ServiceContext } from "../../context.js";
import { writeAudit } from "../audit/write.js";
import { createResultStore } from "./store.js";

/*
 * A result as RFC 4180 CSV, UTF-8, with a header row, streamed from its
 * pages so a large result never sits whole in memory. Only its owner gets
 * it, and each download is audited.
 */

const NEEDS_QUOTES = /[",\r\n]/;
/** What a spreadsheet reads as the start of a formula (docs/decisions/queries.md). */
const FORMULA_START = /^[=+\-@\t\r]/;

const quoted = (text: string) => `"${text.replaceAll('"', '""')}"`;

/** Rows come from JSON, so a value is a string, a number, a boolean, null, or an array or object. */
function field(value: unknown): string {
  if (value === null) return "";
  if (typeof value === "string" && FORMULA_START.test(value))
    return quoted(`'${value}`);
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return NEEDS_QUOTES.test(text) ? quoted(text) : text;
}

const line = (values: readonly unknown[]) =>
  `${values.map(field).join(",")}\r\n`;

/** How a download was authorised, written to the audit: a link's holder is told apart from a credential's, with the address it came from. */
export type CsvAccess =
  { by: "credential" } | { by: "csv_link"; address: string | null };

export async function* resultCsv(
  context: ServiceContext,
  resultId: string,
  access: CsvAccess = { by: "credential" },
): AsyncIterable<string> {
  const store = createResultStore(context);
  // No rows: the owner's check, and the columns for the header.
  const head = await store.read(context.principal, resultId, {
    offset: 0,
    limit: 0,
  });
  await writeAudit(context, {
    principal: context.principal,
    action: "result.download",
    resource: { kind: "result", id: resultId },
    decision: "allow",
    detail: { ...access, query_id: head.query_id, row_count: head.row_count },
  });
  yield line(head.columns.map((column) => column.name));
  for await (const row of store.stream(context.principal, resultId))
    yield line(row);
}
