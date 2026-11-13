import { z } from "zod";
import { ServiceError } from "../errors.js";

/*
 * The one place that reads what Microsoft answers when something fails.
 * Identity writes { error, error_description }; Power BI and Graph write
 * { error: { code, message } }, and a DAX failure nests Power BI's sentence
 * under pbi.error's details.
 * https://learn.microsoft.com/en-us/entra/identity-platform/reference-error-codes
 * https://learn.microsoft.com/en-us/rest/api/power-bi/datasets/execute-queries
 * https://learn.microsoft.com/en-us/graph/errors
 */

const identityError = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});
const detailsMessage = z.object({
  code: z.string(),
  detail: z.object({ value: z.string() }),
});
const apiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string().optional(),
    "pbi.error": z.object({ details: z.array(detailsMessage) }).optional(),
  }),
});

export type MicrosoftError = { code: string; message: string | null };

/** The code and the sentence of an error answer, or null when the body has neither shape. */
export function readMicrosoftError(body: unknown): MicrosoftError | null {
  const api = apiError.safeParse(body);
  if (api.success) {
    const { code, message, "pbi.error": pbi } = api.data.error;
    const details = pbi?.details.find((d) => d.code === "DetailsMessage");
    return { code, message: details?.detail.value ?? message ?? null };
  }
  const identity = identityError.safeParse(body);
  if (!identity.success) return null;
  // The first line is the sentence; trace and correlation ids follow it.
  const [first] = (identity.data.error_description ?? "").split(/\r?\n/);
  return { code: identity.data.error, message: first || null };
}

/** Text as JSON, or null when it is not JSON (a gateway's HTML page), a shape no schema here accepts. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function readJson(response: Response): Promise<unknown> {
  return parseJson(await response.text());
}

/**
 * A successful answer read into its schema; any other shape is Microsoft's change, not ours to guess at.
 * An issue path may hold a record key, which is data; do not log paths from schemas that validate record contents.
 */
export function parseAnswer<S extends z.ZodType>(
  schema: S,
  body: unknown,
  what: string,
  extra: Record<string, unknown> = {},
): z.output<S> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  throw new ServiceError(
    "upstream",
    `${what} answered in a shape this version cannot read.`,
    {
      issues: parsed.error.issues.slice(0, 3).map((issue) => issue.path),
      ...extra,
    },
  );
}

/** "Power BI answered 500: <its sentence>." */
export function upstreamFailure(
  what: string,
  status: number,
  error: MicrosoftError | null,
  extra: Record<string, unknown> = {},
): ServiceError {
  const said = error?.message ?? error?.code;
  const sentence = said === undefined ? "" : `: ${said.replace(/\.$/, "")}`;
  return new ServiceError(
    "upstream",
    `${what} answered ${String(status)}${sentence}.`,
    { status, ...error, ...extra },
  );
}

/** Seconds from a Retry-After header, which Power BI writes in seconds; null when there is none. */
export function retryAfterSeconds(response: Response): number | null {
  const header = response.headers.get("retry-after")?.trim();
  return header !== undefined && /^\d+$/.test(header) ? Number(header) : null;
}
