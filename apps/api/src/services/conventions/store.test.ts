import { existsSync } from "node:fs";
import { asc, eq, TransactionRollbackError } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeTestPools, principals, testPool } from "../../../test/deps.js";
import type { Db } from "../../context.js";
import { createDb } from "../../db/client.js";
import { bookChange, conventions } from "../../db/schema/book.js";
import { waitingOn } from "../../../test/locks.js";
import { event } from "../../db/schema/events.js";
import {
  CONVENTIONS_LOCK,
  currentConventions,
  diffConventions,
  listVersions,
  presetsFolder,
  resolve,
  setConventions,
  validateConventions,
} from "./store.js";

afterAll(closeTestPools);

describe("resolve", () => {
  it("merges the preset under the document: objects key by key, arrays whole", () => {
    const conventions = resolve({
      naming: {
        kinds: ["total_"],
        money_qualifier: { values: ["net_of_vat"] },
      },
    });
    expect(conventions.preset).toBe("metrics_book");
    expect(conventions.naming.kinds).toEqual(["total_"]);
    expect(conventions.naming.case).toBe("snake_case");
    expect(conventions.naming.money_qualifier).toEqual({
      required: true,
      values: ["net_of_vat"],
      units: ["money"],
    });
  });

  it("starts from the preset the document names", () => {
    const conventions = resolve({
      preset: "minimal",
      metric_fields: { when_to_use: { required: true } },
    });
    expect(conventions.naming.case).toBe("none");
    expect(conventions.metric_fields.when_to_use.required).toBe(true);
    expect(conventions.metric_fields.aliases.required).toBe(false);
  });

  it.each(["metrics_book", "minimal"])(
    "accepts, from %s, a shorter qualifier_order with its own qualifiers",
    (preset) => {
      const naming = {
        qualifier_order: ["per", "vat"],
        qualifiers: { per: ["per"], vat: ["excl_vat", "incl_vat"] },
      };
      expect(validateConventions({ preset, naming })).toEqual([]);
    },
  );

  it("finds the presets from src in a checkout and from dist in the image", () => {
    const fromSource = presetsFolder(new URL("./store.ts", import.meta.url));
    expect(existsSync(new URL("metrics_book.yml", fromSource))).toBe(true);
    const inImage = "file:///app/apps/api/dist/services/conventions/store.js";
    expect(presetsFolder(new URL(inImage)).pathname).toBe(
      "/app/conventions/presets/",
    );
  });

  it.each([
    [{ naming: { case: "camel_case" } }, "naming.case"],
    [{ namng: { case: "none" } }, "namng"],
    [{ preset: "strict" }, "preset"],
    [JSON.parse('{"__proto__": {"checks": {"off": []}}}'), "__proto__"],
    [{ checks: { off: ["metric_name_shape"] } }, "checks.off.0"],
    [{ naming: { kinds: ["total"] } }, "naming.kinds.0"],
    [{ naming: { qualifier_order: ["vat", "channel"] } }, "naming.qualifiers"],
    [
      { drafting: { dismiss: [{ name_pattern: "(", reason: "Broken" }] } },
      "drafting.dismiss.0.name_pattern",
    ],
    [
      {
        metric_fields: {
          custom: [{ key: "source", label: "Source", type: "choice" }],
        },
      },
      "metric_fields.custom.0.values",
    ],
  ])("refuses %o at %s", (document, path) => {
    expect(
      validateConventions(document).map((problem) => problem.path),
    ).toContain(path);
  });

  it("refuses a document that is not a mapping", () => {
    expect(validateConventions("naming: none")).toEqual([
      { path: "", message: "The conventions are a mapping of keys." },
    ]);
  });
});

describe("diffConventions", () => {
  it("lists each changed path with its before and after", () => {
    const current = resolve({});
    const proposed = resolve({
      naming: { kinds: ["total_"] },
      checks: { off: ["metric_base_variant"] },
    });
    expect(diffConventions(current, proposed)).toEqual([
      { path: "naming.kinds", before: current.naming.kinds, after: ["total_"] },
      { path: "checks.off", before: [], after: ["metric_base_variant"] },
    ]);
    expect(diffConventions(current, current)).toEqual([]);
  });
});

/**
 * setConventions opens its own transaction, which inside this one is a
 * savepoint, so nothing it writes outlives the test.
 */
const rolledBack = (work: (tx: Db) => Promise<void>) =>
  expect(
    createDb(testPool("api_rw")).transaction(async (tx) => {
      await work(tx);
      tx.rollback();
    }),
  ).rejects.toThrow(TransactionRollbackError);

describe("setConventions", () => {
  it("refuses an invalid document with the path of the problem and stores nothing", () =>
    rolledBack(async (tx) => {
      const setting = setConventions({ db: tx }, principals.admin, {
        naming: { case: "camel_case" },
      });
      await expect(setting).rejects.toThrow("naming.case: ");
      await expect(setting).rejects.toMatchObject({
        kind: "invalid",
        detail: { problems: [{ path: "naming.case" }] },
      });
      expect(await listVersions(tx)).toEqual([]);
    }));

  it("refuses a token a change to trust.* against the version in force, stores nothing, and takes the other keys", () =>
    rolledBack(async (tx) => {
      const token = { ...principals.admin, via: "cli" } as const;
      await expect(
        setConventions({ db: tx }, token, {
          trust: { human_verify_from: "any" },
        }),
      ).rejects.toMatchObject({ kind: "refused" });
      expect(await listVersions(tx)).toEqual([]);
      await setConventions({ db: tx }, principals.admin, {
        trust: { human_verify_from: "any" },
      });
      // Against the version in force this undoes the change, so it is one.
      await expect(setConventions({ db: tx }, token, {})).rejects.toMatchObject(
        { kind: "refused" },
      );
      const saved = await setConventions({ db: tx }, token, {
        trust: { human_verify_from: "any" },
        checks: { off: ["metric_base_variant"] },
      });
      expect(saved.changes.map((change) => change.path)).toEqual([
        "checks.off",
      ]);
    }));

  // The proof that the check runs under the lock: a save that read the
  // history before another committed would see no trust change and pass.
  it("refuses a token's trust change that a concurrent save made stale", async () => {
    const pool = testPool("api_rw");
    const holder = await pool.connect();
    const token = { ...principals.admin, via: "cli" } as const;
    try {
      await holder.query("begin");
      await holder.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        [CONVENTIONS_LOCK],
      );
      const { rows } = await holder.query<{ pid: number }>(
        "select pg_backend_pid() as pid",
      );
      // The defaults change no trust key against an empty history, so this
      // save is allowed until the holder's version lands.
      const saving = setConventions({ db: createDb(pool) }, token, {}).then(
        () => "saved",
        (error: unknown) => error,
      );
      await waitingOn(rows[0]?.pid ?? 0, 1);
      await holder.query(
        "insert into conventions (version, document, set_by) values (1, $1, 'holder')",
        [JSON.stringify(resolve({ trust: { human_verify_from: "any" } }))],
      );
      await holder.query("commit");
      expect(await saving).toMatchObject({ kind: "refused" });
      expect(await listVersions(createDb(pool))).toHaveLength(1);
    } finally {
      await holder.query("rollback");
      holder.release();
      await createDb(pool).delete(conventions);
    }
  });

  it("keeps every version, records each change and announces it", () =>
    rolledBack(async (tx) => {
      const before = await currentConventions(tx);
      expect(before).toEqual(resolve({ preset: "metrics_book" }));
      const set = (document: unknown) =>
        setConventions({ db: tx }, principals.admin, document);
      const first = await set({ preset: "minimal" });
      const second = await set({ preset: "minimal", checks: { off: [] } });
      expect([first.version, second.version]).toEqual([1, 2]);
      expect(second.changes.map((change) => change.path)).toEqual([
        "checks.off",
      ]);
      expect(await currentConventions(tx)).toEqual(second.conventions);

      const versions = await listVersions(tx);
      expect(
        versions.map(({ version, set_by }) => ({ version, set_by })),
      ).toEqual([
        { version: 2, set_by: "test-admin" },
        { version: 1, set_by: "test-admin" },
      ]);
      expect(versions[1]?.document).toEqual(first.conventions);

      const changes = await tx
        .select()
        .from(bookChange)
        .where(eq(bookChange.element_kind, "conventions"))
        .orderBy(asc(bookChange.id));
      expect(
        changes.map(({ element_id, action, before, after }) => ({
          element_id,
          action,
          before,
          after,
        })),
      ).toEqual([
        { element_id: "1", action: "update", before, after: first.conventions },
        {
          element_id: "2",
          action: "update",
          before: first.conventions,
          after: second.conventions,
        },
      ]);
      const events = await tx
        .select()
        .from(event)
        .where(eq(event.kind, "conventions.changed"))
        .orderBy(asc(event.id));
      expect(events.map((row) => row.data)).toEqual([
        { version: 1, paths: first.changes.map((change) => change.path) },
        { version: 2, paths: ["checks.off"] },
      ]);
    }));
});
