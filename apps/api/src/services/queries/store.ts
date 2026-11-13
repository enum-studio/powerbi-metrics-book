import { randomUUID } from "node:crypto";
import { and, asc, between, eq, lte } from "drizzle-orm";
import type { AppDeps, ServiceContext } from "../../context.js";
import {
  queryLog,
  queryResult,
  queryResultPage,
} from "../../db/schema/queries.js";
import { powerbiDataset } from "../../db/schema/mirror.js";
import { serviceAccount } from "../../db/schema/service-accounts.js";
import { ServiceError } from "../../errors.js";
import type { QueryColumn } from "../../powerbi/execute.js";
import type { Principal } from "../../principal.js";
import { looksLikeId } from "../mirror/read.js";
import { csvLink, type ResultOwner } from "./links.js";

/*
 * Results in Postgres, in pages of 500 rows, so reading a page is one row.
 * Only the owner reads a result: the owner is compared in the query itself,
 * whatever a policy allows, because the rows were read under the owner's
 * row-level security. One implementation; object storage would go behind
 * the same interface.
 */

const PAGE_ROWS = 500;
/** What a preview or a page holds at most, so a result never floods an agent's context. */
const ANSWER_BYTES_MAX = 16 * 1024;
export const PREVIEW_ROWS_MAX = 100;
const HOUR_MS = 60 * 60_000;
/** Pages per insert statement, well under Postgres's limit on parameters. */
const PAGES_PER_INSERT = 20;

export type NewResult = {
  query_id: string;
  owner: ResultOwner;
  dataset: { id: string; name: string };
  columns: QueryColumn[];
  /** Power BI's sentence when it cut the rows off at a limit, else null. */
  truncation_note: string | null;
  preview_rows: number;
};

export type ResultAnchor = {
  result_id: string;
  query_id: string;
  dataset: { id: string; name: string };
  columns: QueryColumn[];
  row_count: number;
  bytes: number;
  truncated: boolean;
  truncation_note: string | null;
  preview: unknown[][];
  /** Says why the preview stopped before preview_rows, else null. */
  preview_note: string | null;
  next_offset: number | null;
  csv_url: string;
  csv_url_expires_at: string;
  expires_at: string;
};

export type ResultPage = {
  result_id: string;
  query_id: string;
  columns: QueryColumn[];
  row_count: number;
  offset: number;
  rows: unknown[][];
  next_offset: number | null;
  /** Says why the page stopped before the limit, else null. */
  note: string | null;
};

export interface ResultStore {
  /** Rows as they arrive, or all at once. */
  save(
    input: NewResult,
    rows: AsyncIterable<unknown[]> | Iterable<unknown[]>,
  ): Promise<ResultAnchor>;
  read(
    principal: Principal,
    resultId: string,
    range: { offset: number; limit: number },
  ): Promise<ResultPage>;
  stream(principal: Principal, resultId: string): AsyncIterable<unknown[]>;
  delete(principal: Principal, resultId: string): Promise<void>;
  deleteExpired(now: Date): Promise<number>;
}

const bytesOf = (row: unknown[]) => Buffer.byteLength(JSON.stringify(row));

/**
 * The rows from `offset` that fit in `limit` and 16 KiB of JSON, and how
 * many rows they move the reader on. A row over 16 KiB alone is left out
 * and passed over, so reading on still moves forward, and the note says
 * where to get it.
 */
function fitting(rows: unknown[][], limit: number, offset: number) {
  const kept: unknown[][] = [];
  // The array's brackets; each row adds a comma or the closing bracket.
  let bytes = 1;
  for (const row of rows.slice(0, limit)) {
    bytes += bytesOf(row) + 1;
    if (bytes <= ANSWER_BYTES_MAX) {
      kept.push(row);
      continue;
    }
    if (kept.length > 0)
      return {
        rows: kept,
        moved: kept.length,
        note: `Stopped at ${String(kept.length)} rows to stay under 16 KiB; read on from next_offset.`,
      };
    return {
      rows: kept,
      moved: 1,
      note: `The row at offset ${String(offset)} is over 16 KiB alone, so it is left out here: download the result as CSV from csv_url, or get_result_csv_link.`,
    };
  }
  return { rows: kept, moved: kept.length, note: null };
}

export function createResultStore(
  deps: Pick<
    AppDeps,
    "container" | "db" | "clock" | "config" | "secrets" | "settings" | "access"
  >,
): ResultStore {
  const { db } = deps;

  /** The owner's result, or not_found: missing, someone else's, of a dataset now off, or expired (saying when, and its query). */
  async function owned(principal: Principal, resultId: string) {
    const missing = new ServiceError("not_found", "No such result.");
    if (!looksLikeId(resultId)) throw missing;
    const [result] = await db
      .select()
      .from(queryResult)
      .where(
        and(
          eq(queryResult.id, resultId),
          eq(queryResult.owner_kind, principal.kind),
          eq(queryResult.owner_id, principal.id),
        ),
      );
    const now = deps.clock();
    if (result !== undefined && result.expires_at > now) {
      // An off or missing dataset is gone for everyone, so its stored results answer as missing ones do.
      const [dataset] = await db
        .select({ enabled: powerbiDataset.enabled })
        .from(powerbiDataset)
        .where(eq(powerbiDataset.id, result.dataset_id));
      if (dataset?.enabled !== true) throw missing;
      await deps.access.require(
        principal,
        {
          kind: "result",
          id: result.id,
          attr: { owner_kind: result.owner_kind, owner_id: result.owner_id },
        },
        "read",
      );
      return result;
    }
    // Once the worker deleted it, the owner's query log entry still knows.
    const [logged] =
      result === undefined
        ? await db
            .select({
              query_id: queryLog.id,
              expires_at: queryLog.result_expires_at,
            })
            .from(queryLog)
            .where(
              and(
                eq(queryLog.result_id, resultId),
                eq(queryLog.principal_kind, principal.kind),
                eq(queryLog.principal_id, principal.id),
                lte(queryLog.result_expires_at, now),
              ),
            )
        : [result];
    if (logged?.expires_at == null) throw missing;
    const expired_at = logged.expires_at.toISOString();
    throw new ServiceError(
      "not_found",
      `This result expired at ${expired_at}. Its query is ${logged.query_id}: get_query gives its DAX to run again.`,
      { query_id: logged.query_id, expired_at },
    );
  }

  return {
    async save(input, rows) {
      const pages: unknown[][][] = [];
      let page: unknown[][] = [];
      let row_count = 0;
      let bytes = 0;
      for await (const row of rows) {
        page.push(row);
        row_count += 1;
        bytes += bytesOf(row);
        if (page.length === PAGE_ROWS) {
          pages.push(page);
          page = [];
        }
      }
      if (page.length > 0) pages.push(page);

      const id = randomUUID();
      const created_at = deps.clock();
      const ttl_hours = await deps.settings.get("results.ttl_hours");
      const expires_at = new Date(created_at.getTime() + ttl_hours * HOUR_MS);
      const truncated = input.truncation_note !== null;
      await db.transaction(async (tx) => {
        if (input.owner.kind === "service_account") {
          // Shared until this commits, so deleting the account waits for the result and then deletes it too.
          const [account] = await tx
            .select({ name: serviceAccount.name })
            .from(serviceAccount)
            .where(eq(serviceAccount.name, input.owner.id))
            .for("share");
          if (account === undefined)
            throw new ServiceError(
              "not_found",
              "This service account no longer exists, so its result is not kept.",
            );
        }
        await tx.insert(queryResult).values({
          id,
          query_id: input.query_id,
          owner_kind: input.owner.kind,
          owner_id: input.owner.id,
          dataset_id: input.dataset.id,
          columns: input.columns,
          row_count,
          truncated,
          truncation_note: input.truncation_note,
          bytes,
          page_rows: PAGE_ROWS,
          created_at,
          expires_at,
        });
        for (let first = 0; first < pages.length; first += PAGES_PER_INSERT) {
          await tx.insert(queryResultPage).values(
            pages.slice(first, first + PAGES_PER_INSERT).map((rows, index) => ({
              result_id: id,
              page_number: first + index,
              rows,
            })),
          );
        }
      });

      const preview = fitting(
        pages[0] ?? [],
        Math.min(input.preview_rows, PREVIEW_ROWS_MAX),
        0,
      );
      const link = await csvLink(deps, {
        id,
        owner_kind: input.owner.kind,
        owner_id: input.owner.id,
      });
      return {
        result_id: id,
        query_id: input.query_id,
        dataset: input.dataset,
        columns: input.columns,
        row_count,
        bytes,
        truncated,
        truncation_note: input.truncation_note,
        preview: preview.rows,
        preview_note: preview.note,
        next_offset: preview.moved < row_count ? preview.moved : null,
        ...link,
        expires_at: expires_at.toISOString(),
      };
    },

    async read(principal, resultId, { offset, limit }) {
      const result = await owned(principal, resultId);
      if (!Number.isInteger(offset) || offset < 0)
        throw new ServiceError("invalid", "offset is a whole number from 0.");
      if (!Number.isInteger(limit) || limit < 0)
        throw new ServiceError("invalid", "limit is a whole number from 0.");
      const most = Math.min(
        limit,
        await deps.settings.get("results.page_rows_max"),
        result.row_count - Math.min(offset, result.row_count),
      );
      const firstPage = Math.floor(offset / result.page_rows);
      const lastPage = Math.floor((offset + most - 1) / result.page_rows);
      const pages =
        most === 0
          ? []
          : await db
              .select({ rows: queryResultPage.rows })
              .from(queryResultPage)
              .where(
                and(
                  eq(queryResultPage.result_id, result.id),
                  between(queryResultPage.page_number, firstPage, lastPage),
                ),
              )
              .orderBy(asc(queryResultPage.page_number));
      const skip = offset - firstPage * result.page_rows;
      const page = fitting(
        pages.flatMap((p) => p.rows).slice(skip, skip + most),
        most,
        offset,
      );
      const end = offset + page.moved;
      return {
        result_id: result.id,
        query_id: result.query_id,
        columns: result.columns,
        row_count: result.row_count,
        offset,
        rows: page.rows,
        next_offset: end < result.row_count ? end : null,
        note: page.note,
      };
    },

    async *stream(principal, resultId) {
      const result = await owned(principal, resultId);
      const count = Math.ceil(result.row_count / result.page_rows);
      for (let page_number = 0; page_number < count; page_number += 1) {
        const [page] = await db
          .select({ rows: queryResultPage.rows })
          .from(queryResultPage)
          .where(
            and(
              eq(queryResultPage.result_id, result.id),
              eq(queryResultPage.page_number, page_number),
            ),
          );
        // Deleted mid-stream: a short file must not pass for the whole result.
        if (page === undefined)
          throw new ServiceError("not_found", "No such result.");
        yield* page.rows;
      }
    },

    async deleteExpired(now) {
      // Pages go with their result.
      const deleted = await db
        .delete(queryResult)
        .where(lte(queryResult.expires_at, now))
        .returning({ id: queryResult.id });
      return deleted.length;
    },

    async delete(principal, resultId) {
      await db
        .delete(queryResult)
        .where(
          and(
            eq(queryResult.id, resultId),
            eq(queryResult.owner_kind, principal.kind),
            eq(queryResult.owner_id, principal.id),
          ),
        );
    },
  };
}

/**
 * A page of the caller's own result, from `offset`. Left out, `limit` is the
 * deployment's page size (results.page_rows_max). Only the owner reads it.
 */
export async function readResult(
  context: ServiceContext,
  resultId: string,
  range: { offset?: number; limit?: number },
): Promise<ResultPage> {
  return createResultStore(context).read(context.principal, resultId, {
    offset: range.offset ?? 0,
    limit: range.limit ?? (await context.settings.get("results.page_rows_max")),
  });
}

/**
 * A download link for the caller's own result, signed for the caller alone.
 * Reading no rows is the owner's check: any other caller is told there is no
 * such result.
 */
export async function resultCsvLink(
  context: ServiceContext,
  resultId: string,
): Promise<{ url: string; expires_at: string }> {
  const { principal } = context;
  const owned = await createResultStore(context).read(principal, resultId, {
    offset: 0,
    limit: 0,
  });
  const link = await csvLink(context, {
    id: owned.result_id,
    owner_kind: principal.kind,
    owner_id: principal.id,
  });
  return { url: link.csv_url, expires_at: link.csv_url_expires_at };
}
