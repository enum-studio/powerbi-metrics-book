import type { Db, ServiceContext } from "../../context.js";
import { bookChange } from "../../db/schema/book.js";
import type { Principal } from "../../principal.js";
import { enqueueUnlessQueued } from "../jobs/queue.js";

export type BookChange = {
  /** Null for the sync, which has no principal: it is recorded as the system's "sync". */
  principal: Principal | null;
  element_kind: string;
  element_id: string;
  action: string;
  /** The element as it was; null for a creation. */
  before: unknown;
  /** The element as it became; null for a deletion. */
  after: unknown;
};

/** Runs in the transaction of the change it describes, so both stand or neither does. */
export async function recordBookChange(
  tx: Db,
  change: BookChange,
): Promise<void> {
  const { principal } = change;
  await tx.insert(bookChange).values({
    principal_kind: principal?.kind ?? "system",
    principal_id: principal?.id ?? "sync",
    via: principal?.via ?? null,
    element_kind: change.element_kind,
    element_id: change.element_id,
    action: change.action,
    before: change.before ?? null,
    after: change.after ?? null,
  });
  // The book's search documents are now stale. One queued request covers a
  // burst of changes (the drafter's hundreds), and it stands or falls with
  // this change. "schedule": the stack queued it, nobody asked for a job.
  // The embed job reads `changes_only` to look only at what changed since its
  // cursor (services/search/embed-job.ts).
  await enqueueUnlessQueued(tx, {
    job: "embed",
    runner: "worker",
    args: { changes_only: true },
    trigger: "schedule",
  });
}

/** The one resource the policy rules on the book (curate, verify, approve, edit_conventions) are asked about. */
export const BOOK = { kind: "book", id: "book", attr: {} } as const;

export function requireCurator(context: ServiceContext): Promise<void> {
  return context.access.require(context.principal, BOOK, "curate");
}
