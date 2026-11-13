import { DrizzleQueryError } from "drizzle-orm";
import pg from "pg";
import type { Logger } from "../log.js";

type Fields = NonNullable<Parameters<Logger["error"]>[1]>;

/**
 * Logs an error no ServiceError answered, for whoever runs the api: its
 * name, message and stack beside the caller's fields, the request id first.
 * The one exception is a failed query: drizzle puts the query and its
 * parameters in the message, and a parameter can be token or secret
 * ciphertext, a PKCE verifier or a key digest. Such an error is logged as
 * Postgres's own (its message, code and constraint), with the frames where
 * the query ran.
 */
export function logError(
  logger: Logger,
  message: string,
  error: unknown,
  fields: Fields & { request_id: string | null },
): void {
  logger.error(message, { ...fields, ...describe(error) });
}

/**
 * An error as a sentence to keep: of a failed query, Postgres's own message,
 * since drizzle's holds the query and every parameter. Postgres's can still
 * quote the one value it could not read as its column's type, which can be a
 * parameter, so only admins and the logs get this sentence.
 */
export function errorSentence(error: unknown): string {
  const cause = error instanceof DrizzleQueryError ? error.cause : error;
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Text from outside, as Postgres can keep it: a text column refuses a NUL and
 * jsonb a lone surrogate, and the failure to record a failure leaves a run
 * looking unfinished and stops the worker.
 */
export function storable(text: string, max_characters: number): string {
  return text
    .replace(/\p{Cc}+/gu, " ")
    .slice(0, max_characters)
    .toWellFormed();
}

function describe(error: unknown): Fields {
  if (error instanceof DrizzleQueryError) {
    const { cause, stack = "" } = error;
    const database = cause instanceof pg.DatabaseError ? cause : null;
    // The stack opens with the message, query and parameters included.
    const header = `${error.name}: ${error.message}\n`;
    return {
      error: cause instanceof Error ? cause.constructor.name : typeof cause,
      message: cause instanceof Error ? cause.message : null,
      code: database?.code,
      constraint: database?.constraint,
      stack: stack.startsWith(header) ? stack.slice(header.length) : null,
    };
  }
  if (error instanceof Error)
    return { error: error.name, message: error.message, stack: error.stack };
  return { error: typeof error };
}
