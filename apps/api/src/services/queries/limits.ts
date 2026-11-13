import { randomUUID } from "node:crypto";
import { and, count, eq, gt, lte, sql } from "drizzle-orm";
import type { ServiceContext } from "../../context.js";
import { queryLog, queryReservation } from "../../db/schema/queries.js";
import { ServiceError } from "../../errors.js";
import { countRequest } from "../rate-limit.js";

/*
 * Queries a minute, and rows a day counted from the query log, so an agent
 * in a loop cannot copy a model out row by row. A query in flight holds
 * Power BI's most rows against the day's budget until its log row is
 * written, so queries run in parallel cannot pass the budget together.
 */

/** The most rows Power BI returns to one query. */
const ROWS_PER_QUERY_MAX = 100_000;
const IN_FLIGHT_MAX = 4;
/** Longer than a query may run (300 s) and its rows take to store: only a crashed api's reservation lapses. */
const RESERVATION_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** Counted before anything else about a query, so a refused query counts too. */
export async function countQuery(
  context: ServiceContext,
  now: Date,
): Promise<void> {
  const { principal } = context;
  const max = await context.settings.get("queries.rate_per_minute");
  // Apart from the per-request limit on service_account:<name>.
  const verdict = await countRequest(
    context.db,
    `queries:${principal.kind}:${principal.id}`,
    { window_seconds: 60, max },
    now,
  );
  if (!verdict.allowed)
    throw new ServiceError(
      "rate_limited",
      `You ran ${String(max)} queries in the last minute. Try again in ${String(verdict.retry_after_seconds)} seconds.`,
      { retry_after_seconds: verdict.retry_after_seconds },
    );
}

/**
 * Holds the most rows a query can return against the principal's budget,
 * under a lock per principal, so each query sees the others in flight.
 * Refused when the rows returned in the last 24 hours and those held reach
 * the budget, or when four queries are in flight. releaseRows ends it.
 */
export async function reserveRows(
  context: ServiceContext,
  now: Date,
): Promise<string> {
  const { principal } = context;
  const budget = await context.settings.get("results.daily_row_budget");
  const id = randomUUID();
  await context.db.transaction(async (tx) => {
    const lock = `powerbi_metrics_book.query_reservation:${principal.kind}:${principal.id}`;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${lock}, 0))`,
    );
    const theirs = and(
      eq(queryReservation.principal_kind, principal.kind),
      eq(queryReservation.principal_id, principal.id),
    );
    await tx
      .delete(queryReservation)
      .where(and(theirs, lte(queryReservation.expires_at, now)));
    const [held] = await tx
      .select({
        queries: count(),
        rows: sql<string>`coalesce(sum(${queryReservation.rows}), 0)`,
      })
      .from(queryReservation)
      .where(theirs);
    if (held === undefined) throw new Error("an aggregate returned no row");
    if (held.queries >= IN_FLIGHT_MAX)
      throw new ServiceError(
        "rate_limited",
        `You have ${String(IN_FLIGHT_MAX)} queries running, the most at once. Run this one when one of them ends.`,
      );

    const mine = and(
      eq(queryLog.principal_kind, principal.kind),
      eq(queryLog.principal_id, principal.id),
      gt(queryLog.at, new Date(now.getTime() - DAY_MS)),
    );
    const [spent] = await tx
      .select({ rows: sql<string>`coalesce(sum(${queryLog.row_count}), 0)` })
      .from(queryLog)
      .where(mine);
    const returned = Number(spent?.rows);
    const reserved = Number(held.rows);
    if (returned >= budget) {
      // It frees up a day after the query whose rows, once they age out, bring the total under the budget.
      const running = tx
        .select({
          at: queryLog.at,
          before:
            sql<string>`sum(${queryLog.row_count}) over (order by ${queryLog.at}, ${queryLog.id})`.as(
              "before",
            ),
        })
        .from(queryLog)
        .where(mine)
        .as("running");
      const [oldest] = await tx
        .select({ at: sql`min(${running.at})`.mapWith(queryLog.at) })
        .from(running)
        .where(sql`${returned} - ${running.before} < ${budget}`);
      if (oldest?.at == null)
        throw new Error("the row budget is spent by no query");
      const frees_at = new Date(oldest.at.getTime() + DAY_MS);
      throw new ServiceError(
        "rate_limited",
        `Your queries returned ${String(returned)} rows in the last 24 hours, past the budget of ${String(budget)}. It frees up at ${frees_at.toISOString()}.`,
        {
          frees_at: frees_at.toISOString(),
          retry_after_seconds: Math.ceil(
            (frees_at.getTime() - now.getTime()) / 1000,
          ),
        },
      );
    }
    if (returned + reserved >= budget)
      throw new ServiceError(
        "rate_limited",
        `Your running queries may return ${String(reserved)} rows, which with the ${String(returned)} returned in the last 24 hours reach the budget of ${String(budget)}. Run this one when one of them ends.`,
      );
    await tx.insert(queryReservation).values({
      id,
      principal_kind: principal.kind,
      principal_id: principal.id,
      rows: ROWS_PER_QUERY_MAX,
      expires_at: new Date(now.getTime() + RESERVATION_MS),
    });
  });
  return id;
}

export async function releaseRows(
  context: ServiceContext,
  reservation: string,
): Promise<void> {
  await context.db
    .delete(queryReservation)
    .where(eq(queryReservation.id, reservation));
}
