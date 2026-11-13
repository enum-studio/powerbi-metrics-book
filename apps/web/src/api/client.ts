import createClient from "openapi-fetch";
import type { paths } from "./schema";

/**
 * A failed call, with the sentence a person reads. kind is the api's own
 * (not_found, refused, ...), "unknown" when the answer was not the api's
 * error, and "unreachable" when no answer came.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly kind: string,
    message: string,
    options?: ErrorOptions & { saveAnyway?: SaveAnyway },
  ) {
    super(message, options);
    this.name = "ApiError";
    this.saveAnyway = options?.saveAnyway ?? null;
  }

  /** Set when the api refused a value because its check failed and may be saved anyway: the check's name and its own sentence. */
  readonly saveAnyway: SaveAnyway | null;
}

export type SaveAnyway = { check: string; message: string };

/** The api's own origin, with the session cookie, typed from apps/api/openapi.json. */
export function createApi(options: {
  baseUrl: string;
  fetch?: (request: Request) => Promise<Response>;
}) {
  return createClient<paths>({ ...options, credentials: "include" });
}

export const api = createApi({ baseUrl: "" });

type Answer<T> = { data?: T; error?: unknown; response: Response };

/** The data of a call that succeeded, or an ApiError that says what went wrong. */
export async function read<T>(request: Promise<Answer<T>>): Promise<T> {
  let answer: Answer<T>;
  try {
    answer = await request;
  } catch (error) {
    // fetch rejects with a TypeError only when no answer arrived.
    if (!(error instanceof TypeError)) throw error;
    throw new ApiError(
      0,
      "unreachable",
      "Power BI Metrics Book could not be reached. Check your connection, then reload the page.",
      { cause: error },
    );
  }
  const { data, error, response } = answer;
  if (response.ok && data !== undefined) return data;
  throw failed(response.status, error);
}

/** Ends the browser session (Better Auth's route, outside /api/v1). */
export async function signOut(): Promise<void> {
  const response = await fetch("/api/auth/sign-out", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  // Better Auth's error body is not the api's, so its status is what is said.
  if (!response.ok) throw failed(response.status, null);
}

export function failed(status: number, body: unknown): ApiError {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    "message" in body &&
    typeof body.error === "string" &&
    typeof body.message === "string"
  )
    return new ApiError(status, body.error, body.message, {
      saveAnyway: saveAnyway(body),
    });
  return new ApiError(
    status,
    "unknown",
    `The server answered ${String(status)} without saying why. Reload the page; if it happens again, the api's log has the reason.`,
  );
}

/** The api's refusal of a failing value, which says in fields that "save_failing" would keep it. */
function saveAnyway(body: object): SaveAnyway | undefined {
  if (!("save_failing_allowed" in body) || body.save_failing_allowed !== true)
    return undefined;
  const check = "check" in body ? body.check : undefined;
  if (
    typeof check === "object" &&
    check !== null &&
    "name" in check &&
    "message" in check &&
    typeof check.name === "string" &&
    typeof check.message === "string"
  )
    return { check: check.name, message: check.message };
  return undefined;
}
