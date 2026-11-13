export const ERROR_KINDS = [
  "unauthenticated",
  "refused",
  "not_found",
  "invalid",
  "conflict",
  "rate_limited",
  "needs_connection",
  "upstream",
  "unavailable",
] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

/** The one answer for a dataset that is missing and for one the caller may not describe, with the next step. */
export const NO_SUCH_DATASET =
  "No such dataset. list_datasets names the datasets you may use; list_measures lists what one holds.";

/**
 * An error a caller is meant to read. The message is the sentence a person or
 * an agent acts on ("Your Power BI connection expired. Reconnect at ..."), so
 * it names what to do, never an internal detail. A refused dataset is thrown
 * as not_found, so it answers exactly like a missing one.
 */
export class ServiceError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ServiceError";
  }
}
