import { createHash } from "node:crypto";
import type { Context } from "hono";

export type RefusalStatus = 400 | 401 | 403 | 404 | 429;

/**
 * Power BI's error body: `{ error: { code, message } }`.
 * https://raw.githubusercontent.com/microsoft/PowerBI-CSharp/master/sdk/swaggers/swagger.json
 * (PowerBIApiErrorResponseDetail)
 */
export function powerBiError(
  c: Context,
  status: RefusalStatus,
  code: string,
  message: string,
): Response {
  return c.json({ error: { code, message } }, status);
}

/**
 * A DAX failure answers 400 with the sentence nested under the error's
 * details, as the swagger's DatasetExecuteQueriesError says ("if not present
 * here, this information may also be found in details object nested under the
 * error object").
 * https://learn.microsoft.com/en-us/rest/api/power-bi/datasets/execute-queries
 */
export function daxError(c: Context, message: string): Response {
  const code = "DatasetExecuteQueriesError";
  return c.json(
    {
      error: {
        code,
        "pbi.error": {
          code,
          parameters: {},
          details: [
            { code: "DetailsMessage", detail: { type: 1, value: message } },
          ],
        },
      },
    },
    400,
  );
}

/** Power BI leaves out what is null on its admin APIs. */
export function compact(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value != null),
  );
}

export function flag(value: string | undefined): boolean {
  return value?.toLowerCase() === "true";
}

/** A stable GUID for things the model has no id for (a relationship's name, a measure's lineage tag). */
export function guidFrom(seed: string): string {
  const hex = createHash("sha1").update(seed).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
