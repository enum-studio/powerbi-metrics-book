import { existsSync, readFileSync } from "node:fs";
import { asc, desc, eq, TransactionRollbackError } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
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
  toCompanyPart,
  validateConventions,
} from "./store.js";

import { companyPartSchema, PRESET_NAMES } from "./schema.js";

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
    [{ off: ["metric_name_shape"] }, "off.0"],
    [
      {
        exceptions: [
          { rule: "metric_name_form", metric: "orders", reason: "A check." },
        ],
      },
      "exceptions.0.rule",
    ],
    [
      {
        exceptions: [
          { rule: "naming.kinds", term: "channel", reason: "A term." },
        ],
      },
      "exceptions.0",
    ],
    [
      {
        exceptions: [
          {
            rule: "naming.kinds",
            metric: "orders",
            term: "channel",
            reason: "Two.",
          },
        ],
      },
      "exceptions.0",
    ],
    [
      { exceptions: [{ rule: "naming.kinds", reason: "None." }] },
      "exceptions.0",
    ],
    [
      { exceptions: [{ rule: "naming.kinds", metric: "orders", reason: "" }] },
      "exceptions.0.reason",
    ],
    [
      {
        exceptions: [
          { rule: "naming.kinds", metric: "orders", reason: "x".repeat(201) },
        ],
      },
      "exceptions.0.reason",
    ],
    [
      {
        exceptions: [
          { rule: "naming.kinds", metric: "orders", reason: "One.\nTwo." },
        ],
      },
      "exceptions.0.reason",
    ],
    [
      {
        exceptions: [
          { rule: "naming.kinds", metric: "orders", reason: "One." },
          { rule: "naming.kinds", metric: "orders", reason: "Two." },
        ],
      },
      "exceptions",
    ],
    [{ naming: { kinds: ["total"] } }, "naming.kinds.0"],
    [{ naming: { qualifier_order: ["vat", "channel"] } }, "naming.qualifiers"],
    [
      {
        drafting: { dismiss: [{ prefix: "_", name: "Test", reason: "Both" }] },
      },
      "drafting.dismiss.0",
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

  it("reads a company part as the document it overlays, and refuses a format other than 1", () => {
    const part = { format: 1, naming: { kinds: ["total_"] } };
    expect(resolve(part)).toEqual(resolve({ naming: { kinds: ["total_"] } }));
    expect(resolve(part)).not.toHaveProperty("format");
    expect(validateConventions({ format: 2 })).toEqual([
      {
        path: "format",
        message:
          "This release reads format 1 of the conventions. It says how to read the rest.",
      },
    ]);
    expect(
      validateConventions({ format: 1, namng: {}, naming: { case: "camel" } })
        .map((problem) => problem.path)
        .sort(),
    ).toEqual(["naming.case", "namng"]);
  });
});

describe("toCompanyPart", () => {
  it("keeps the preset and only what differs from it, key by key and arrays whole", () => {
    expect(toCompanyPart(resolve({}))).toEqual({
      format: 1,
      preset: "metrics_book",
    });
    expect(toCompanyPart(resolve({ preset: "minimal" }))).toEqual({
      format: 1,
      preset: "minimal",
    });
    const preset = resolve({});
    const [group = "", words = []] =
      Object.entries(preset.naming.qualifiers)[0] ?? [];
    const changed = resolve({
      naming: {
        kinds: [...preset.naming.kinds, "_share"],
        money_qualifier: { values: ["excl_vat"] },
        qualifiers: { [group]: [...words, "extra_word"] },
      },
      metric_fields: { when_to_use: preset.metric_fields.when_to_use },
    });
    expect(toCompanyPart(changed)).toEqual({
      format: 1,
      preset: "metrics_book",
      naming: {
        kinds: [...preset.naming.kinds, "_share"],
        money_qualifier: { values: ["excl_vat"] },
        qualifiers: { [group]: [...words, "extra_word"] },
      },
    });
    expect(resolve(toCompanyPart(changed))).toEqual(changed);
  });
});

describe("diffConventions", () => {
  it("lists each changed path with its before and after", () => {
    const current = resolve({});
    const proposed = resolve({
      naming: { kinds: ["total_"] },
      off: ["metric_base_variant"],
    });
    expect(diffConventions(current, proposed)).toEqual([
      { path: "naming.kinds", before: current.naming.kinds, after: ["total_"] },
      { path: "off", before: [], after: ["metric_base_variant"] },
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
        off: ["metric_base_variant"],
      });
      expect(saved.changes.map((change) => change.path)).toEqual(["off"]);
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

  it("stores the company's part: a complete document as what differs from its preset, a part as given", () =>
    rolledBack(async (tx) => {
      const stored = async () =>
        (
          await tx.select().from(conventions).orderBy(desc(conventions.version))
        )[0]?.document;
      const set = (document: unknown) =>
        setConventions({ db: tx }, principals.admin, document);
      // The preset turns metric_name_form off, so a company that sets its case turns it on.
      const complete = resolve({
        preset: "minimal",
        naming: { case: "snake_case" },
        off: [],
      });
      await set(complete);
      expect(await stored()).toEqual({
        format: 1,
        preset: "minimal",
        naming: { case: "snake_case" },
        off: [],
      });
      expect(await currentConventions(tx)).toEqual(complete);
      // A part may set a value equal to the preset's: the company holds it.
      const part = { format: 1, naming: { case: "none", kinds: [] } };
      const saved = await set(part);
      expect(await stored()).toEqual(part);
      expect(saved.conventions).toEqual(
        resolve({
          preset: "metrics_book",
          naming: { case: "none", kinds: [] },
        }),
      );
      expect((await listVersions(tx))[0]?.document).toEqual(saved.conventions);
    }));

  it("keeps every version, records each change and announces it", () =>
    rolledBack(async (tx) => {
      const before = await currentConventions(tx);
      expect(before).toEqual(resolve({ preset: "metrics_book" }));
      const set = (document: unknown) =>
        setConventions({ db: tx }, principals.admin, document);
      const first = await set({ preset: "minimal" });
      const second = await set({ preset: "minimal", off: [] });
      expect([first.version, second.version]).toEqual([1, 2]);
      expect(second.changes.map((change) => change.path)).toEqual(["off"]);
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
        { version: 2, paths: ["off"] },
      ]);
    }));
});

describe("what a company part may say", () => {
  it.each([
    [{ format: 1, pii: { columns: [] } }, "pii"],
    [{ format: 2 }, "format"],
    [{ format: 1, trust: { states: ["draft"] } }, "trust.states"],
    [{ format: 1, off: ["keys.unique"] }, "keys.unique"],
    [
      {
        format: 1,
        exceptions: [
          { rule: "variants.base", metric: "orders", reason: "No." },
        ],
      },
      "variants.base",
    ],
  ])("refuses %o, which changes the fixed rule %s", (document, rule) => {
    expect(() => resolve(document)).toThrow(
      expect.objectContaining({
        kind: "invalid",
        detail: expect.objectContaining({
          code: "conventions.fixed",
          rule,
        }) as unknown,
      }),
    );
  });

  it("names an entry of off that is neither a rule nor a check", () => {
    expect(
      validateConventions({ off: ["naming.kinds", "naming.shape"] }),
    ).toEqual([
      {
        path: "off.1",
        message: "naming.shape is neither a rule id nor a check name.",
      },
    ]);
  });

  it("refuses format in off or as an exception's rule as the fixed rule it is", () => {
    for (const document of [
      { format: 1, off: ["format"] },
      {
        format: 1,
        exceptions: [{ rule: "format", metric: "orders", reason: "No." }],
      },
    ])
      expect(() => resolve(document)).toThrow(
        expect.objectContaining({
          message: expect.stringContaining(
            "format stays fixed. It says how to read the rest.",
          ) as unknown,
          detail: expect.objectContaining({
            code: "conventions.fixed",
            rule: "format",
          }) as unknown,
        }),
      );
  });

  it.each([
    [{ format: 1, naming: { kinds: ["total_"] }, off: ["naming.kinds"] }],
    [{ format: 1, naming: { kinds: ["total_"] }, off: ["metric_name_form"] }],
  ])("refuses %o, which sets a rule it turns off", (part) =>
    rolledBack(async (tx) => {
      const saving = setConventions({ db: tx }, principals.admin, part);
      await expect(saving).rejects.toMatchObject({
        kind: "invalid",
        detail: { code: "conventions.off_and_set" },
      });
      await expect(saving).rejects.toThrow(/naming\.(kinds|case)/);
      expect(await listVersions(tx)).toEqual([]);
    }),
  );

  it("takes a value for a rule only its preset turns off", () =>
    rolledBack(async (tx) => {
      // minimal turns metric_name_form off; the part's own off is empty.
      const part = { format: 1, preset: "minimal", naming: { case: "none" } };
      await setConventions({ db: tx }, principals.admin, part);
      expect((await currentConventions(tx)).naming.case).toBe("none");
    }));

  it("takes a value and off for different rules of one check", () =>
    rolledBack(async (tx) => {
      await setConventions({ db: tx }, principals.admin, {
        format: 1,
        naming: { kinds: ["total_"] },
        off: ["naming.case"],
      });
      expect((await currentConventions(tx)).off).toEqual(["naming.case"]);
    }));
});

describe("the trust part a token sends", () => {
  const token = { ...principals.admin, via: "cli" } as const;
  const stored = async (tx: Db) =>
    (await tx.select().from(conventions).orderBy(desc(conventions.version)))[0]
      ?.document;
  const pinned = { format: 1, trust: { human_verify_from: "browser" } };

  it("refuses pinning, unpinning and changing a trust key, and takes a part that leaves it alone", () =>
    rolledBack(async (tx) => {
      await expect(
        setConventions({ db: tx }, token, pinned),
      ).rejects.toMatchObject({ kind: "refused" });
      await setConventions({ db: tx }, principals.admin, pinned);
      await expect(
        setConventions({ db: tx }, token, { format: 1 }),
      ).rejects.toMatchObject({ kind: "refused" });
      await expect(
        setConventions({ db: tx }, token, {
          format: 1,
          trust: { human_verify_from: "any" },
        }),
      ).rejects.toMatchObject({ kind: "refused" });
      const kept = { ...pinned, off: ["metric_base_variant"] };
      await setConventions({ db: tx }, token, kept);
      expect(await stored(tx)).toEqual(kept);
    }));

  it("keeps the stored pin when a complete document leaves the trust rules as they are", () =>
    rolledBack(async (tx) => {
      await setConventions({ db: tx }, principals.admin, pinned);
      await setConventions(
        { db: tx },
        token,
        resolve({ naming: { case: "none" } }),
      );
      expect(await stored(tx)).toEqual({
        format: 1,
        preset: "metrics_book",
        naming: { case: "none" },
        trust: { human_verify_from: "browser" },
      });
    }));
});

describe("listVersions", () => {
  it("lists an older version that no longer resolves as it was stored, and diffs against the newest", () =>
    rolledBack(async (tx) => {
      const old = { preset: "strict", naming: { case: "none" } };
      const part = { format: 1, naming: { shape: "none" } };
      await tx.insert(conventions).values([
        { version: 1, document: old, set_by: "test-admin" },
        { version: 2, document: part, set_by: "test-admin" },
        { version: 3, document: { format: 1 }, set_by: "test-admin" },
      ]);
      expect(
        (await listVersions(tx)).map((version) => version.document),
      ).toEqual([resolve({}), part, old]);
      expect(
        diffConventions(
          await currentConventions(tx),
          resolve({ off: ["naming.case"] }),
        ),
      ).toEqual([{ path: "off", before: [], after: ["naming.case"] }]);
    }));
});

describe("conventions.schema.json", () => {
  it("ships the company part's schema as JSON Schema, which takes each preset whole", () => {
    const file = new URL("conventions.schema.json", import.meta.url);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(
      z.toJSONSchema(companyPartSchema),
    );
    for (const name of PRESET_NAMES)
      expect(
        companyPartSchema.safeParse({ format: 1, ...resolve({ preset: name }) })
          .error,
      ).toBeUndefined();
  });
});
