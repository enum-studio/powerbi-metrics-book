import { lt, sql } from "drizzle-orm";
import type { Db } from "../context.js";
import { requestRate } from "../db/schema/rate-limit.js";

export type RateRule = { window_seconds: number; max: number };

/** No rule's window is longer, so a count a day old limits nothing and deleteStaleCounts may drop it. */
const WINDOW_SECONDS_MAX = 24 * 60 * 60;
export type RateVerdict =
  { allowed: true } | { allowed: false; retry_after_seconds: number };

/**
 * Counts one request against key in its fixed window, in Postgres, so every
 * replica counts into the same row. A replica whose clock is a little behind
 * counts into the newer window rather than restarting the count.
 */
export async function countRequest(
  db: Db,
  key: string,
  rule: RateRule,
  now: Date,
): Promise<RateVerdict> {
  if (rule.window_seconds > WINDOW_SECONDS_MAX)
    throw new Error(
      `a rate window is at most ${String(WINDOW_SECONDS_MAX)} seconds`,
    );
  const window_ms = rule.window_seconds * 1000;
  const window_start = new Date(
    Math.floor(now.getTime() / window_ms) * window_ms,
  );
  const [counted] = await db
    .insert(requestRate)
    .values({ key, window_start, count: 1 })
    .onConflictDoUpdate({
      target: requestRate.key,
      set: {
        count: sql`case when excluded.window_start > ${requestRate.window_start} then 1 else ${requestRate.count} + 1 end`,
        window_start: sql`greatest(excluded.window_start, ${requestRate.window_start})`,
      },
    })
    .returning({
      count: requestRate.count,
      window_start: requestRate.window_start,
    });
  if (counted === undefined) throw new Error("upsert returned no row");
  if (counted.count <= rule.max) return { allowed: true };
  const frees_at = counted.window_start.getTime() + window_ms;
  return {
    allowed: false,
    retry_after_seconds: Math.ceil((frees_at - now.getTime()) / 1000),
  };
}

/**
 * Deletes the counts whose window started more than a day before `now`: one
 * row per key would otherwise stay for every address and caller ever seen.
 * Returns how many it deleted. The worker runs it.
 */
export async function deleteStaleCounts(db: Db, now: Date): Promise<number> {
  const deleted = await db
    .delete(requestRate)
    .where(
      lt(
        requestRate.window_start,
        new Date(now.getTime() - WINDOW_SECONDS_MAX * 1000),
      ),
    )
    .returning({ key: requestRate.key });
  return deleted.length;
}
