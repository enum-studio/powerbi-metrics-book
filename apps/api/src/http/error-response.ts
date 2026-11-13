import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ErrorKind, ServiceError } from "../errors.js";

export const ERROR_STATUS: Record<ErrorKind, ContentfulStatusCode> = {
  unauthenticated: 401,
  refused: 403,
  not_found: 404,
  invalid: 400,
  conflict: 409,
  rate_limited: 429,
  // The caller can fix it by connecting Power BI, as with a conflict.
  needs_connection: 409,
  upstream: 502,
  // Not yet: the demo answers it until its person is seeded.
  unavailable: 503,
};

/**
 * What of a refusal's detail a client may branch on: a value that failed its
 * check and may be saved anyway says so, with the key and the check's own
 * sentence (which checks.ts screens against the value).
 */
function saveAnyway(error: ServiceError) {
  const { key, check, save_failing_allowed } = error.detail;
  if (
    error.kind !== "invalid" ||
    save_failing_allowed !== true ||
    typeof key !== "string" ||
    typeof check !== "object" ||
    check === null ||
    !("message" in check)
  )
    return {};
  return {
    save_failing_allowed: true,
    check: { name: key, message: check.message },
  };
}

/** The REST answer to a ServiceError: its kind and its message, and the one machine-readable refusal above; never the rest of its detail. */
export function errorResponse(c: Context, error: ServiceError): Response {
  return c.json(
    { error: error.kind, message: error.message, ...saveAnyway(error) },
    ERROR_STATUS[error.kind],
  );
}
