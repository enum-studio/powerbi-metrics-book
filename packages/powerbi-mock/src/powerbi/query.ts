import { Hono, type Context } from "hono";
import { isRecord, readJsonObject, type MockState } from "../entra/context.js";
import { mayQuery, mayWrite } from "./access.js";
import { authenticate } from "./caller.js";
import { evaluate, type Row } from "./dax.js";
import { MINUTE_MS, refuseWhenThrottled, type Runtime } from "./limits.js";
import { daxError, powerBiError } from "./wire.js";

/**
 * The limits of executeQueries: 100,000 rows or 1,000,000 values per query
 * (whichever is hit first), 15 MB, 120 requests a minute per user.
 * https://learn.microsoft.com/en-us/rest/api/power-bi/datasets/execute-queries
 */
const MAX_ROWS = 100_000;
const MAX_VALUES = 1_000_000;
const MAX_BYTES = 15 * 1024 * 1024;
const REQUESTS_PER_MINUTE = 120;
const QUERY_SCOPES = ["Dataset.Read.All", "Dataset.ReadWrite.All"];

type Limited = { rows: Row[]; error?: { code: string; message: string } };

/**
 * Over a limit Power BI answers 200 with the rows it had and an error beside
 * them, and a row that crosses the byte limit is still written whole.
 */
function limitRows(rows: Row[], include_nulls: boolean): Limited {
  const width = Math.max(1, Object.keys(rows[0] ?? {}).length);
  const allowed = Math.min(MAX_ROWS, Math.floor(MAX_VALUES / width));
  const code = "DatasetExecuteQueriesError";
  let kept = rows
    .slice(0, allowed)
    .map((row) =>
      include_nulls
        ? row
        : Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null)),
    );
  if (rows.length > allowed) {
    return {
      rows: kept,
      error: {
        code,
        message: `More than ${String(allowed)} rows in a query result`,
      },
    };
  }
  let bytes = 0;
  for (const [index, row] of kept.entries()) {
    bytes += Buffer.byteLength(JSON.stringify(row));
    if (bytes > MAX_BYTES) {
      kept = kept.slice(0, index + 1);
      return {
        rows: kept,
        error: { code, message: "More than 15 MB of data in a query result" },
      };
    }
  }
  return { rows: kept };
}

/** The one query of the request and its serializer setting, or the sentence for a 400. */
function parseRequest(
  body: Record<string, unknown> | null,
): { query: string; include_nulls: boolean } | string {
  const queries = body?.queries;
  if (!Array.isArray(queries) || queries.length !== 1) {
    return "queries must hold exactly one query: Power BI runs one query per call.";
  }
  const first: unknown = queries[0];
  if (!isRecord(first) || typeof first.query !== "string") {
    return "Each entry of queries needs a query string.";
  }
  const settings = body?.serializerSettings;
  return {
    query: first.query,
    include_nulls: isRecord(settings) && settings.includeNulls === true,
  };
}

export function queryRoutes(state: MockState, runtime: Runtime): Hono {
  const app = new Hono();

  async function executeQueries(c: Context): Promise<Response> {
    const caller = await authenticate(state, c);
    if (caller instanceof Response) return caller;
    if (
      caller.kind === "person" &&
      !QUERY_SCOPES.some((scope) => caller.scopes.includes(scope))
    ) {
      return powerBiError(
        c,
        403,
        "Forbidden",
        "The token needs the Dataset.Read.All or Dataset.ReadWrite.All scope.",
      );
    }
    const throttled = refuseWhenThrottled(c, runtime, {
      bucket: `executeQueries:${caller.id}`,
      max: REQUESTS_PER_MINUTE,
      window_ms: MINUTE_MS,
    });
    if (throttled) return throttled;
    if (!state.tenant.settings.execute_queries) {
      return powerBiError(
        c,
        403,
        "Forbidden",
        "The tenant setting Dataset Execute Queries REST API is not enabled.",
      );
    }

    const group_id = c.req.param("group_id");
    const dataset = state.tenant.datasets.find(
      (candidate) => candidate.id === c.req.param("dataset_id"),
    );
    if (
      !dataset ||
      (group_id !== undefined && group_id !== dataset.workspace_id)
    ) {
      return powerBiError(
        c,
        404,
        "PowerBIEntityNotFound",
        "Dataset not found.",
      );
    }
    const refusal = (message: string) =>
      powerBiError(c, 403, "Forbidden", message);
    if (!mayQuery(state.tenant, caller, dataset, group_id !== undefined)) {
      return refusal("The caller may not query this dataset on this path.");
    }
    if (caller.kind === "service_principal" && dataset.has_row_level_security) {
      return refusal(
        "Service principals cannot query a dataset with row-level security.",
      );
    }

    const request = parseRequest(await readJsonObject(c));
    if (typeof request === "string") {
      return powerBiError(c, 400, "InvalidRequest", request);
    }
    const evaluation = evaluate(dataset, request.query, {
      shows_definitions: mayWrite(state.tenant, caller, dataset),
    });
    if ("failure" in evaluation) return daxError(c, evaluation.failure);

    const { rows, error } = limitRows(evaluation.rows, request.include_nulls);
    return c.json({
      results: [{ tables: [error ? { rows, error } : { rows }] }],
    });
  }

  app.post("/v1.0/myorg/datasets/:dataset_id/executeQueries", executeQueries);
  app.post(
    "/v1.0/myorg/groups/:group_id/datasets/:dataset_id/executeQueries",
    executeQueries,
  );
  return app;
}
