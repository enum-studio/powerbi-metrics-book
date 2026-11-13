import { asc, gt, max } from "drizzle-orm";
import type { Db } from "../src/context.js";
import { event } from "../src/db/schema/events.js";

/**
 * The events a test's transaction writes from now on: those above the highest
 * id it sees now. A file has its own database and runs one test at a time, so
 * no other session writes an event meanwhile.
 */
export async function eventsSince(tx: Db) {
  const [highest] = await tx.select({ id: max(event.id) }).from(event);
  const after = highest?.id ?? 0;
  return {
    /** The highest event id the transaction saw. */
    after,
    read: () =>
      tx.select().from(event).where(gt(event.id, after)).orderBy(asc(event.id)),
  };
}
