import type { Context, MiddlewareHandler } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { z } from "zod";
import type { AppEnv } from "../../app.js";
import type { AppDeps, ServiceContext } from "../../context.js";
import { ERROR_KINDS, ServiceError } from "../../errors.js";
import { peerOf } from "../../http/peer.js";
import { apiConfig } from "../../services/auth/better-auth.js";
import { clientAddress } from "../../services/auth/client-address.js";
import { requirePrincipal } from "../../services/auth/principal.js";

/*
 * What every /api/v1 route module shares. A route reads
 *
 *   const as = serviceContext(deps);
 *   const made = documented("Create a thing", Thing, { status: 201, errors: [400, 409] });
 *   routes.post("/things", made.doc, credential, validator("json", Body, refuse),
 *     async (c) => made.answer(c, await createThing(as(c), c.req.valid("json"))));
 *
 * `made.doc` is what the OpenAPI document is generated from: the success
 * answer's zod schema and the errors the route can give. `made.answer` holds
 * two guarantees about the answer. At compile time its value must fit the
 * schema's input type, so tsc fails when a service's return type and the
 * schema disagree. At run time it is parsed by the schema and the parsed
 * value is sent, so a field the schema does not declare never reaches the
 * client, and a missing or wrong field is a 500 that the error log records.
 * Nothing else checks the answer. `credential` runs before the validators, so
 * a caller no role reaches is refused (403) before a bad body is described
 * (400). The query, params and body are zod schemas in `validator`, whose
 * `refuse` hook turns a bad request into an `invalid` ServiceError.
 */

type Issues = {
  success: boolean;
  error?: readonly { message: string; path?: readonly unknown[] }[];
};

/** The validators' hook: a bad request becomes an `invalid` ServiceError, answered like every other error. */
export function refuse(result: Issues): void {
  if (result.success) return;
  const problems = (result.error ?? []).map(({ message, path = [] }) =>
    path.length === 0 ? message : `${path.map(String).join(".")}: ${message}`,
  );
  throw new ServiceError(
    "invalid",
    `The request is not valid (${problems.join("; ")}).`,
  );
}

/** The deps and the caller, after the credential check every route starts with. */
export const serviceContext =
  (deps: AppDeps) =>
  (c: Context<AppEnv>): ServiceContext => ({
    ...deps,
    principal: requirePrincipal(c),
    signal: c.req.raw.signal,
    client_address: clientAddress(
      peerOf(c.env),
      c.req.raw.headers,
      apiConfig(deps.config),
    ),
  });

/** Ahead of the validators on every route: a caller with no credential, or no role, is refused before the request is read. */
export const credential: MiddlewareHandler<AppEnv> = async (c, next) => {
  requirePrincipal(c);
  await next();
};

/** What an error answers, as http/error-response.ts writes it. */
export const ErrorBody = z
  .object({ error: z.enum(ERROR_KINDS), message: z.string() })
  .meta({ id: "Error" });

const ERRORS = {
  400: "The request is not valid.",
  401: "Sign in first.",
  403: "The caller's role or credential does not allow it.",
  404: "No such thing, or none the caller may see.",
  409: "It conflicts with the book as it is.",
  429: "Too many requests.",
  502: "Power BI or another service the request needs failed.",
};
export type ErrorStatus = keyof typeof ERRORS;

/** 401 and 403 for every route, and the others a route can give. */
export function failures(extra: readonly ErrorStatus[] = []) {
  return Object.fromEntries(
    [401, 403, ...extra].map((status) => [
      status,
      {
        description: ERRORS[status as ErrorStatus],
        content: { "application/json": { schema: resolver(ErrorBody) } },
      },
    ]),
  );
}

type Documented = { status?: 200 | 201; errors?: readonly ErrorStatus[] };

/** A route's OpenAPI entry, and the one way it answers: the value must fit the schema. */
export function documented<S extends z.ZodType>(
  summary: string,
  schema: S,
  { status = 200, errors = [] }: Documented = {},
) {
  return {
    doc: describeRoute({
      summary,
      responses: {
        [status]: {
          description: summary,
          content: { "application/json": { schema: resolver(schema) } },
        },
        ...failures(errors),
      },
    }),
    answer: (c: Context<AppEnv>, value: z.input<S>) =>
      c.body(JSON.stringify(schema.parse(value)), status, {
        "Content-Type": "application/json",
      }),
  };
}

/** A route that answers 204 and no body. */
export function removed(summary: string, errors: readonly ErrorStatus[] = []) {
  return {
    doc: describeRoute({
      summary,
      responses: { 204: { description: summary }, ...failures(errors) },
    }),
    answer: (c: Context<AppEnv>) => c.body(null, 204),
  };
}

/*
 * The caps every input shares: a name or reference 500 characters, free text
 * 20,000, an id a GUID, and a record at most 20 keys.
 */
// Postgres cannot store a NUL, and would answer 500 to one.
export const noNul = (value: string) => !value.includes("\0");
export const text = z
  .string()
  .min(1)
  .max(500)
  .refine(noNul, "A NUL character is not allowed.");
export const free = z.string().max(20_000);
export const guid = z.guid();
/** A list in a query string, which carries only text: comma-separated values of one enum. */
export const commaList = <V extends readonly [string, ...string[]]>(
  values: V,
) =>
  z
    .string()
    .max(500)
    .transform((list) => list.split(","))
    .pipe(z.array(z.enum(values)).max(values.length));
export const custom = z
  .record(
    text,
    z.union([z.string().max(20_000), z.number(), z.boolean(), z.null()]),
  )
  .refine((fields) => Object.keys(fields).length <= 20, "At most 20 fields.");

/** A timestamp a service gives as a Date, and one it gives already as an ISO string. */
export const stamp = z.date().meta({ type: "string", format: "date-time" });
export const iso = z.iso.datetime({ offset: true });
/** A named thing in an answer, as the services anchor it. */
export const anchor = <K extends string>(kind: K) =>
  z.object({ kind: z.literal(kind), id: z.string(), name: z.string() });
