import { z } from "zod";
import { NO_SUCH_DATASET, ServiceError } from "../errors.js";
import {
  parseAnswer,
  readJson,
  readMicrosoftError,
  retryAfterSeconds,
  upstreamFailure,
} from "./errors.js";
import { endpoint, type PowerBiDeps } from "./identity.js";

/** Power BI stops at 15 MB of data; the JSON around it repeats every column name on every row. */
const MAX_ANSWER_BYTES = 32 * 1024 * 1024;

const queryError = z.object({
  code: z.string(),
  message: z.string().optional(),
});
const table = z.object({
  rows: z.array(z.record(z.string(), z.unknown())),
  error: queryError.optional(),
});
const answerSchema = z.object({
  results: z.tuple([
    z.object({
      tables: z.array(table).optional(),
      error: queryError.optional(),
    }),
  ]),
});

export type ColumnType = "number" | "boolean" | "datetime" | "string" | "null";
export type QueryColumn = { name: string; type: ColumnType };
export type QueryAnswer = { columns: QueryColumn[]; rows: unknown[][] } & (
  { truncated: false } | { truncated: true; note: string }
);

const DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/;

function typeOf(value: unknown): ColumnType {
  if (value === null) return "null";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string" && DATE_TIME.test(value)) return "datetime";
  return "string";
}

/** The one type of a column's values; DAX allows a column of mixed types, which is read as text. */
function columnType(values: unknown[]): ColumnType {
  const types = new Set(values.map(typeOf));
  types.delete("null");
  const [only = "null"] = types;
  return types.size > 1 ? "string" : only;
}

/** Rows as arrays, in the order Power BI named the columns. */
function tabulate(objects: Record<string, unknown>[]) {
  const names = [...new Set(objects.flatMap((row) => Object.keys(row)))];
  // includeNulls asks for every column on every row; one left out is blank all the same.
  const rows = objects.map((row) => names.map((name) => row[name] ?? null));
  const columns = names.map((name, index) => ({
    name,
    type: columnType(rows.map((row) => row[index])),
  }));
  return { columns, rows };
}

/**
 * Executes the DAX on the dataset path without /groups/{id}: a person who
 * reaches the dataset through an app, with Build but no workspace role, may
 * query it there and not on the workspace path.
 *
 * A 401 means Power BI no longer accepts the token (stale or revoked) and
 * throws needs_connection. The query service refreshes once and retries; a
 * second 401 answers not_found, and a refresh that answers invalid_grant
 * answers needs_connection. 403 and 404 answer not_found, as a missing
 * dataset does.
 * https://learn.microsoft.com/en-us/rest/api/power-bi/datasets/execute-queries
 */
export async function executeQuery(
  deps: Pick<PowerBiDeps, "fetcher" | "settings">,
  input: { token: string; dataset_id: string; dax: string; timeout_ms: number },
): Promise<QueryAnswer> {
  const path = `/v1.0/myorg/datasets/${encodeURIComponent(input.dataset_id)}/executeQueries`;
  const response = await deps.fetcher.fetchFixed(
    await endpoint(deps, "powerbi.api_url", path),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        queries: [{ query: input.dax }],
        serializerSettings: { includeNulls: true },
      }),
      timeout_ms: input.timeout_ms,
      max_bytes: MAX_ANSWER_BYTES,
    },
  );
  const body = await readJson(response);
  if (!response.ok) throw refusal(response, body);

  const [result] = parseAnswer(answerSchema, body, "Power BI").results;
  const first = result.tables?.[0];
  if (first === undefined) {
    if (result.error === undefined) {
      throw new ServiceError("upstream", "Power BI answered without a table.");
    }
    throw new ServiceError(
      "invalid",
      result.error.message ?? result.error.code,
    );
  }
  const { columns, rows } = tabulate(first.rows);
  // Over a limit Power BI answers 200 with the rows it had and an error beside
  // them, on the table or on the result; either way the rows are cut off.
  const cutOff = first.error ?? result.error;
  if (cutOff === undefined) return { columns, rows, truncated: false };
  const note = cutOff.message ?? cutOff.code;
  return { columns, rows, truncated: true, note };
}

function refusal(response: Response, body: unknown): ServiceError {
  const error = readMicrosoftError(body);
  const detail = { status: response.status, ...error };
  if (response.status === 400) {
    const said = error?.message ?? "Power BI could not run the query.";
    return new ServiceError("invalid", said, detail);
  }
  if (response.status === 401) {
    return new ServiceError(
      "needs_connection",
      "Power BI no longer accepts your connection's token. Connect Power BI again.",
      detail,
    );
  }
  if (response.status === 403 || response.status === 404) {
    return new ServiceError("not_found", NO_SUCH_DATASET, detail);
  }
  if (response.status !== 429) {
    return upstreamFailure("Power BI", response.status, error);
  }
  // Power BI counts queries per minute, so a 429 without Retry-After waits one.
  const seconds = retryAfterSeconds(response) ?? 60;
  return new ServiceError(
    "rate_limited",
    `Power BI is refusing more queries for now. Try again in ${String(seconds)} seconds.`,
    { ...detail, retry_after_seconds: seconds },
  );
}
