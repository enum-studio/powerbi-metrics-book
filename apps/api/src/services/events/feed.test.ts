import { randomUUID } from "node:crypto";
import { asc, sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { inRolledBack } from "../../../test/db-roles.js";
import { closeTestPools, principals, testPool } from "../../../test/deps.js";
import { eventsSince } from "../../../test/events.js";
import type { Db } from "../../context.js";
import { createDb } from "../../db/client.js";
import { event, type EventKind } from "../../db/schema/events.js";
import {
  deleteOldEvents,
  EVENT_LOCK_NAME,
  EVENT_PAGE_MAX,
  readEvents,
  type NewEvent,
  withEvents,
} from "./feed.js";

afterAll(closeTestPools);

/** Marks the events a test commits, so the next test finds none of them and the worker can remove them. */
const RUN = randomUUID();
afterEach(() =>
  testPool("worker_rw").query("delete from event where data->>'run' = $1", [
    RUN,
  ]),
);

const emitted = (
  kind: EventKind,
  elementId: string | null,
  extra: Partial<NewEvent> = {},
): NewEvent => ({
  kind,
  element_kind: "metric",
  element_id: elementId,
  principal: principals.curator,
  data: { run: RUN },
  ...extra,
});

const committed = (db: Db) =>
  db
    .select()
    .from(event)
    .where(sql`${event.data}->>'run' = ${RUN}`)
    .orderBy(asc(event.id));

/** A row for readEvents to find, in the transaction a test rolls back. */
const seed = (tx: Db, kind: EventKind, elementId: string) =>
  tx.insert(event).values({ kind, element_id: elementId });

async function until(condition: () => Promise<boolean>): Promise<void> {
  for (let tries = 0; tries < 500; tries += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the condition did not come true in 5 s");
}

const WAITING_ON_NAME = `select from pg_locks
      where locktype = 'advisory' and not granted and pid = $2
        and ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`;
const WAITING_ON_NUMBER = `select from pg_locks
      where locktype = 'advisory' and not granted and pid = $2
        and ((classid::bigint << 32) | objid::bigint) = $1::bigint`;

/**
 * Is the session with this backend pid waiting for the advisory lock on this
 * key? Asked of one session, so other test files' sessions queued on the same
 * lock cannot answer for it.
 */
const waitingOn = async (
  key: string | number,
  pid: number,
): Promise<boolean> => {
  const { rowCount } = await testPool("api_rw").query(
    typeof key === "string" ? WAITING_ON_NAME : WAITING_ON_NUMBER,
    [key, pid],
  );
  return rowCount === 1;
};

const backendPid = async (tx: Db): Promise<number> => {
  const { rows } = await tx.execute(sql`select pg_backend_pid() as pid`);
  return Number(rows[0]?.pid);
};

describe("withEvents", () => {
  it("writes more events than one statement can bind, in the order they were emitted", async () => {
    const db = createDb(testPool("api_rw"));
    // Six parameters an event: 66,000 pass the 65,535 a statement may carry.
    const ids = Array.from({ length: 11_000 }, () => randomUUID());
    await withEvents(db, (_tx, emit) => {
      for (const id of ids) emit(emitted("metric.verified", id));
      return Promise.resolve();
    });
    const rows = await committed(db);
    expect(rows.map((row) => row.element_id)).toEqual(ids);
  });

  it("writes the emitted events after the work, with who caused them", async () => {
    const db = createDb(testPool("api_rw"));
    const id = randomUUID();
    const result = await withEvents(db, (_tx, emit) => {
      emit(emitted("metric.verified", id, { data: { run: RUN, v: 1 } }));
      emit(
        emitted("sync.finished", null, {
          element_kind: null,
          principal: null,
        }),
      );
      return Promise.resolve("done");
    });
    expect(result).toBe("done");
    const rows = await committed(db);
    expect(rows).toMatchObject([
      {
        kind: "metric.verified",
        element_kind: "metric",
        element_id: id,
        principal_kind: "person",
        principal_id: "test-curator",
        data: { run: RUN, v: 1 },
      },
      {
        kind: "sync.finished",
        element_kind: null,
        principal_kind: null,
        principal_id: null,
      },
    ]);
    expect(rows[0]?.id).toBeLessThan(rows[1]?.id ?? 0);
  });

  it("writes nothing when the work fails after it emitted", async () => {
    const db = createDb(testPool("api_rw"));
    await expect(
      withEvents(db, (_tx, emit) => {
        emit(emitted("metric.created", randomUUID()));
        return Promise.reject(new Error("the change failed"));
      }),
    ).rejects.toThrow("the change failed");
    expect(await committed(db)).toEqual([]);
  });

  it("waits for the event lock before it inserts, so ids become visible in order", async () => {
    const pool = testPool("api_rw");
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        [EVENT_LOCK_NAME],
      );
      let written = false;
      let writer: number | undefined;
      const writing = withEvents(createDb(pool), async (tx, emit) => {
        writer = await backendPid(tx);
        emit(emitted("metric.created", randomUUID()));
      }).then(() => {
        written = true;
      });
      await until(async () =>
        writer === undefined ? false : waitingOn(EVENT_LOCK_NAME, writer),
      );
      expect(written).toBe(false);
      await holder.query("rollback");
      await writing;
      expect(written).toBe(true);
    } finally {
      await holder.query("rollback");
      holder.release();
    }
  });

  it("does not deadlock with a transaction that locks a row first and emits last", async () => {
    // A row both transactions update, as an advisory lock so that no row has to be committed.
    const row = Math.floor(Math.random() * 2 ** 31);
    const db = createDb(testPool("api_rw"));
    const lockRow = (tx: Db) =>
      tx.execute(sql`select pg_advisory_xact_lock(${row})`);
    let rowHeld = () => {};
    const bHoldsRow = new Promise<void>((resolve) => {
      rowHeld = resolve;
    });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const b = withEvents(db, async (tx, emit) => {
      await lockRow(tx);
      rowHeld();
      await gate;
      emit(emitted("metric.changed", "b"));
    });
    await bHoldsRow;
    // A emits first, then needs the row B holds; B emits only once A is waiting.
    let aPid: number | undefined;
    const a = withEvents(db, async (tx, emit) => {
      aPid = await backendPid(tx);
      emit(emitted("metric.created", "a"));
      await lockRow(tx);
    });
    await until(async () =>
      aPid === undefined ? false : waitingOn(row, aPid),
    );
    release();

    await Promise.all([a, b]);
    expect((await committed(db)).map((row) => row.element_id)).toEqual([
      "b",
      "a",
    ]);
  });
});

describe("readEvents", () => {
  it("pages by id, oldest first, and a page ends where the next begins", async () => {
    const ids = await inRolledBack("api_rw", async (tx) => {
      const { after } = await eventsSince(tx);
      for (const name of ["0", "1", "2"])
        await seed(tx, "metric.changed", name);
      const first = await readEvents(tx, { after, limit: 2 });
      const next = await readEvents(tx, { after: first[1]?.id, limit: 2 });
      const none = await readEvents(tx, { after: next[0]?.id });
      return [first, next, none].map((page) => page.map((e) => e.element_id));
    });
    expect(ids).toEqual([["0", "1"], ["2"], []]);
  });

  it("reads only the kinds asked for, and none for an empty list", async () => {
    const kinds = await inRolledBack("api_rw", async (tx) => {
      const { after } = await eventsSince(tx);
      await seed(tx, "metric.created", "a");
      await seed(tx, "variant.moved", "b");
      await seed(tx, "metric.changed", "c");
      const asked = await readEvents(tx, {
        after,
        kinds: ["variant.moved", "metric.changed"],
      });
      const empty = await readEvents(tx, { after, kinds: [] });
      return [asked.map((e) => e.element_id), empty];
    });
    expect(kinds).toEqual([["b", "c"], []]);
  });

  it("never returns more than a page, whatever limit is asked", async () => {
    const lengths = await inRolledBack("api_rw", async (tx) => {
      const { after } = await eventsSince(tx);
      await tx.execute(
        `insert into event (kind) select 'sync.finished' from generate_series(1, ${String(EVENT_PAGE_MAX + 1)})`,
      );
      return [
        (await readEvents(tx, { after })).length,
        (await readEvents(tx, { after, limit: 10_000 })).length,
        (await readEvents(tx, { after, limit: 3 })).length,
      ];
    });
    expect(lengths).toEqual([EVENT_PAGE_MAX, EVENT_PAGE_MAX, 3]);
  });
});

describe("deleteOldEvents", () => {
  it("deletes what is older than 90 days as the worker, and keeps the rest", async () => {
    const now = new Date("2026-10-25T12:00:00Z");
    const day = 24 * 60 * 60 * 1000;
    const result = await inRolledBack("worker_rw", async (tx) => {
      const { after } = await eventsSince(tx);
      await tx.insert(event).values(
        [91, 89, 0].map((age) => ({
          kind: "metric.changed" as const,
          element_id: `${String(age)} days old`,
          at: new Date(now.getTime() - age * day),
        })),
      );
      const deleted = await deleteOldEvents(tx, now);
      const kept = await readEvents(tx, { after });
      return { deleted, kept: kept.map((e) => e.element_id) };
    });
    expect(result).toEqual({
      deleted: 1,
      kept: ["89 days old", "0 days old"],
    });
  });
});
