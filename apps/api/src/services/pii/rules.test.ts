import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeTestPools,
  createTestDeps,
  principals,
  testPool,
} from "../../../test/deps.js";
import {
  asPerson,
  reaching,
  rolledBack,
} from "../../../test/mirror-fixtures.js";
import type { Db, ServiceContext } from "../../context.js";
import { createDb } from "../../db/client.js";
import { user } from "../../db/schema/auth.js";
import { auditEvent } from "../../db/schema/audit.js";
import { bookChange } from "../../db/schema/book.js";
import {
  powerbiColumn,
  powerbiDataset,
  powerbiMeasure,
  powerbiTable,
  powerbiWorkspace,
} from "../../db/schema/mirror.js";
import { piiRule } from "../../db/schema/pii.js";
import {
  listRules,
  PII,
  piiColumn,
  piiMeasure,
  foldNames,
  piiNamesAmong,
  piiNamesOf,
  readsPii,
  removeRule,
  setRule,
  suggest,
} from "./rules.js";

/*
 * Two datasets copy a Cust table. Names carry a per-run suffix because rules
 * are global by name and other test files share the database. The mirror goes
 * in as the worker, which may write it; each test's rules run in a
 * transaction that is rolled back.
 */
const sfx = randomUUID().slice(0, 8);
const cust = `Cust_${sfx}`;
const ids = {
  workspace: randomUUID(),
  a: randomUUID(),
  b: randomUUID(),
  gone: randomUUID(),
};
const names = { a: `Alpha ${sfx}`, b: `Beta ${sfx}` };
const worker = createDb(testPool("worker_rw"));
const ofColumn: Record<string, string> = {};
const ofMeasure: Record<string, string> = {};

beforeAll(async () => {
  await worker
    .insert(powerbiWorkspace)
    .values({ id: ids.workspace, name: `W ${sfx}` });
  await worker.insert(powerbiDataset).values([
    { id: ids.a, workspace_id: ids.workspace, name: names.a, enabled: false },
    { id: ids.b, workspace_id: ids.workspace, name: names.b },
  ]);
  const tables = await worker
    .insert(powerbiTable)
    .values([
      { dataset_id: ids.a, name: cust },
      { dataset_id: ids.b, name: cust },
      { dataset_id: ids.b, name: `Straße_${sfx}` },
      { dataset_id: ids.a, name: `Empty_${sfx}` },
    ])
    .returning();
  const tableOf = (dataset: string, name = cust) =>
    tables.find((t) => t.dataset_id === dataset && t.name === name)?.id ?? "";
  const columns = [
    ...["Email", "Country", "City"].map((name) => ({
      dataset_id: ids.a,
      table_id: tableOf(ids.a),
      name,
    })),
    { dataset_id: ids.b, table_id: tableOf(ids.b), name: "Email" },
    // Spelled apart from the rules that must still match them.
    ...["Ｅｍａｉｌ", "Re\u0301sume\u0301", "ΟΔΟΣ"].map((name) => ({
      dataset_id: ids.b,
      table_id: tableOf(ids.b, `Straße_${sfx}`),
      name,
    })),
    {
      dataset_id: ids.a,
      table_id: tableOf(ids.a),
      name: "Old email",
      removed_at: new Date(),
    },
  ];
  for (const row of await worker
    .insert(powerbiColumn)
    .values(columns)
    .returning())
    ofColumn[`${row.dataset_id === ids.a ? "a" : "b"}.${row.name}`] = row.id;
  for (const row of await worker
    .insert(powerbiMeasure)
    .values([
      { dataset_id: ids.a, table_id: tableOf(ids.a), name: "Email count" },
    ])
    .returning())
    ofMeasure[row.name] = row.id;
});
afterAll(async () => {
  await worker
    .delete(powerbiWorkspace)
    .where(eq(powerbiWorkspace.id, ids.workspace));
  await closeTestPools();
});

const by = { set_by_kind: "person", set_by_id: "x", set_via: "api" };
const admin = (tx: Db) => asPerson(principals.admin, { db: tx });
const adminReaching = (tx: Db, datasetIds: string[]) =>
  asPerson(reaching({ powerbi_dataset_ids: datasetIds }, "admin"), { db: tx });
const piiOf = async (tx: Db) =>
  Object.fromEntries(
    (
      await tx
        .select({
          name: powerbiColumn.name,
          pii: piiColumn(powerbiColumn, powerbiTable),
        })
        .from(powerbiColumn)
        .innerJoin(powerbiTable, eq(powerbiTable.id, powerbiColumn.table_id))
        .where(and(eq(powerbiColumn.dataset_id, ids.a)))
    ).map((row) => [row.name, row.pii]),
  );
const changes = (tx: Db) =>
  tx
    .select()
    .from(bookChange)
    .where(
      and(
        inArray(bookChange.element_id, [
          ...Object.values(ofColumn),
          ...Object.values(ofMeasure),
        ]),
        eq(bookChange.action, "pii_changed"),
      ),
    );

describe("which columns and measures a rule marks", () => {
  it("marks Cust[Email] under a table rule and not Cust[Country] when a column rule clears it", () =>
    rolledBack(async (tx) => {
      await tx.insert(piiRule).values([
        {
          kind: "table",
          table_name: cust.toUpperCase(),
          name: null,
          pii: true,
          ...by,
        },
        {
          kind: "column",
          table_name: cust,
          name: "COUNTRY",
          pii: false,
          ...by,
        },
      ]);
      expect(await piiOf(tx)).toMatchObject({
        Email: true,
        Country: false,
        City: true,
      });
    }));

  it("marks nothing without a rule", () =>
    rolledBack(async (tx) => {
      expect(await piiOf(tx)).toMatchObject({ Email: false, Country: false });
    }));

  it("does not let a table rule cover a measure, and matches a measure rule without case", () =>
    rolledBack(async (tx) => {
      const marked = () =>
        tx
          .select({ pii: piiMeasure(powerbiMeasure) })
          .from(powerbiMeasure)
          .innerJoin(powerbiTable, eq(powerbiTable.id, powerbiMeasure.table_id))
          .where(eq(powerbiMeasure.dataset_id, ids.a));
      await tx.insert(piiRule).values({
        kind: "table",
        table_name: cust,
        name: null,
        pii: true,
        ...by,
      });
      expect(await marked()).toEqual([{ pii: false }]);
      await tx.insert(piiRule).values({
        kind: "measure",
        table_name: cust,
        name: "EMAIL COUNT",
        pii: true,
        ...by,
      });
      expect(await marked()).toEqual([{ pii: true }]);
    }));

  it("marks a measure only by a rule that says PII, of its own table", () =>
    rolledBack(async (tx) => {
      const marked = () =>
        tx
          .select({ pii: piiMeasure(powerbiMeasure) })
          .from(powerbiMeasure)
          .where(eq(powerbiMeasure.dataset_id, ids.a));
      await tx.insert(piiRule).values([
        {
          kind: "measure",
          table_name: `Other_${sfx}`,
          name: "Email count",
          pii: true,
          ...by,
        },
        {
          kind: "measure",
          table_name: cust,
          name: "Email count",
          pii: false,
          ...by,
        },
      ]);
      expect(await marked()).toEqual([{ pii: false }]);
    }));

  it("reads the same answer for the names asked of piiNamesAmong as piiNamesOf gives whole", () =>
    rolledBack(async (tx) => {
      await tx.insert(piiRule).values([
        { kind: "column", table_name: cust, name: "Email", pii: true, ...by },
        {
          kind: "measure",
          table_name: cust,
          name: "Email count",
          pii: true,
          ...by,
        },
      ]);
      const whole = await piiNamesOf(tx, ids.a);
      const found = await piiNamesAmong(
        tx,
        [ids.a],
        ["email", "email count", "nowhere"],
      );
      const asked = found.get(ids.a);
      expect(asked?.columns).toEqual(whole.columns);
      expect(asked?.measures).toEqual(whole.measures);
      expect(asked?.bare).toEqual(whole.bare);
      expect(asked?.ruleTables).toEqual(whole.ruleTables);
      expect(asked?.knownMeasures).toEqual(whole.knownMeasures);
    }));

  it("gives piiNamesOf the synced and the ruled names of a dataset, folded, live columns only", () =>
    rolledBack(async (tx) => {
      await tx.insert(piiRule).values([
        { kind: "column", table_name: cust, name: "Email", pii: true, ...by },
        {
          kind: "measure",
          table_name: cust,
          name: "Email count",
          pii: true,
          ...by,
        },
        // Neither is in the mirror, so [Email2], [Sales] and the table
        // Other must be refused all the same.
        {
          kind: "column",
          table_name: `Other_${sfx}`,
          name: "Email2",
          pii: true,
          ...by,
        },
        { kind: "measure", table_name: cust, name: "Sales", pii: true, ...by },
      ]);
      const lower = cust.toLowerCase();
      const other = `other_${sfx}`;
      const names = await piiNamesOf(tx, ids.a);
      expect(names.columns).toEqual(new Map([[lower, new Set(["email"])]]));
      expect(names.measures).toEqual(
        new Map([[lower, new Set(["email count"])]]),
      );
      expect(names.tables).toEqual(new Set([lower, other]));
      expect(names.bare).toEqual(
        new Set(["email", "email count", "email2", "sales"]),
      );
      expect(names.ruleColumns).toEqual(
        new Map([
          [lower, new Set(["email"])],
          [other, new Set(["email2"])],
        ]),
      );
      expect(names.ruleMeasures).toEqual(
        new Map([[lower, new Set(["email count", "sales"])]]),
      );
    }));

  it("maps a table rule's table to the names cleared in it, and knows the table's measures", () =>
    rolledBack(async (tx) => {
      const lower = cust.toLowerCase();
      await tx.insert(piiRule).values([
        { kind: "table", table_name: cust, name: null, pii: true, ...by },
        // Cleared names come from the rules, synced or not.
        {
          kind: "column",
          table_name: cust,
          name: "COUNTRY",
          pii: false,
          ...by,
        },
        { kind: "column", table_name: cust, name: "Zip", pii: false, ...by },
      ]);
      const names = await piiNamesOf(tx, ids.a);
      expect(names.ruleTables).toEqual(
        new Map([[lower, new Set(["country", "zip"])]]),
      );
      expect(names.tables).toEqual(new Set([lower]));
      expect(names.measures).toEqual(new Map());
      expect(names.knownMeasures).toEqual(
        new Map([[lower, new Set(["email count"])]]),
      );
    }));

  it("takes a table rule's table whether or not the mirror has it or any of its columns", () =>
    rolledBack(async (tx) => {
      const table = { kind: "table", name: null, ...by } as const;
      await tx.insert(piiRule).values([
        { ...table, table_name: cust, pii: false },
        { ...table, table_name: `Other_${sfx}`, pii: true },
        { ...table, table_name: `Empty_${sfx}`, pii: true },
      ]);
      const names = await piiNamesOf(tx, ids.a);
      const ruled = [`other_${sfx}`, `empty_${sfx}`];
      expect(names.ruleTables).toEqual(
        new Map(ruled.map((table) => [table, new Set()])),
      );
      expect(names.tables).toEqual(new Set(ruled));
    }));

  it.each([
    ["width", "Email", "email"],
    ["composition", "R\u00e9sum\u00e9", "r\u00e9sum\u00e9"],
    ["the final sigma", "οδος", "οδοσ"],
  ])(
    "hides a mirror column spelled apart from its rule in %s",
    (_, name, folded) =>
      rolledBack(async (tx) => {
        // The rule says Strasse and the mirror Straße.
        await tx.insert(piiRule).values({
          kind: "column",
          table_name: `Strasse_${sfx}`,
          name,
          pii: true,
          ...by,
        });
        const names = await piiNamesOf(tx, ids.b);
        expect(names.columns).toEqual(
          new Map([[`strasse_${sfx}`, new Set([folded])]]),
        );
        expect(names.bare).toEqual(new Set([folded]));
      }),
  );

  it("folds names in the database, in the order given", () =>
    rolledBack(async (tx) => {
      expect(
        await foldNames(tx, [
          "Ｅｍａｉｌ",
          "Straße",
          "ſtraſſe",
          "ı",
          "ΟΔΟς",
          "Re\u0301sume\u0301",
        ]),
      ).toEqual([
        "email",
        "strasse",
        "strasse",
        "i",
        "οδοσ",
        "r\u00e9sum\u00e9",
      ]);
      expect(await foldNames(tx, [])).toEqual([]);
    }));
});

describe("setting and removing rules", () => {
  it.each([
    ["person", "mcp", "through an agent"],
    ["service_account", "api", "through the API"],
  ])("names a %s's change %s in a conflict", (kind, via, words) =>
    rolledBack(async (tx) => {
      const id = kind === "person" ? randomUUID() : "sample_agent";
      const email = "sample@example.com";
      if (kind === "person")
        await tx.insert(user).values({ id, name: "Sample person", email });
      await tx.insert(piiRule).values({
        kind: "table",
        table_name: cust,
        pii: true,
        set_by_kind: kind,
        set_by_id: id,
        set_via: via,
      });
      await expect(
        setRule(admin(tx), {
          kind: "table",
          table_name: cust,
          pii: false,
          expected_version: null,
        }),
      ).rejects.toMatchObject({
        kind: "conflict",
        message: `The rule changed since; it was last set by ${kind === "person" ? email : id} ${words}.`,
      });
    }),
  );

  it("returns the counts, writes book_change rows, an audit row and the principal's route", () =>
    rolledBack(async (tx) => {
      const context = adminReaching(tx, [ids.a, ids.b]);
      context.principal.via = "cli";
      const set = await setRule(context, {
        kind: "column",
        table_name: cust.toLowerCase(),
        name: "email",
        pii: true,
        note: "Customer contact",
      });
      expect(set).toMatchObject({ columns: 2, measures: 0, datasets: 2 });
      expect(set.rule).toMatchObject({
        set_by_kind: "person",
        set_by_id: principals.admin.id,
        set_via: "cli",
        note: "Customer contact",
      });
      const rows = await changes(tx);
      expect(rows.map((r) => r.element_id).sort()).toEqual(
        [ofColumn["a.Email"], ofColumn["b.Email"]].sort(),
      );
      expect(rows[0]).toMatchObject({
        element_kind: "column",
        action: "pii_changed",
        via: "cli",
      });

      const wider = await setRule(context, {
        kind: "table",
        table_name: cust,
        pii: true,
      });
      // Cust[Email] has its own rule, so the table rule decides only Country and City.
      expect(wider).toMatchObject({ columns: 2, measures: 0, datasets: 1 });
      const absent = await setRule(context, {
        kind: "column",
        table_name: `${cust}_missing`,
        name: "Email",
        pii: true,
      });
      const listed = await listRules(context, {});
      expect(listed.find(({ id }) => id === set.rule.id)).toMatchObject({
        columns: 2,
        datasets: 2,
      });
      expect(listed.find(({ id }) => id === wider.rule.id)).toMatchObject({
        columns: 2,
        datasets: 1,
      });
      expect(listed.find(({ id }) => id === absent.rule.id)).toMatchObject({
        columns: 0,
        datasets: 0,
      });
      const audits = await tx
        .select()
        .from(auditEvent)
        .where(eq(auditEvent.resource_id, set.rule.id));
      expect(audits.map((a) => a.action)).toContain("admin.pii_rule.set");
      expect(audits[0]?.detail).toMatchObject({
        before: null,
        after: { pii: true },
      });
    }));

  it("limits PUT and GET counts to datasets the admin can reach", () =>
    rolledBack(async (tx) => {
      const context = admin(tx);
      const saved = await setRule(context, {
        kind: "column",
        table_name: cust,
        name: "Email",
        pii: true,
      });
      expect(saved).toMatchObject({ columns: 0, measures: 0, datasets: 0 });
      expect(
        (await listRules(context, {})).find(({ id }) => id === saved.rule.id),
      ).toMatchObject({ columns: 0, datasets: 0 });
      const partial = adminReaching(tx, [ids.a]);
      expect(
        (await listRules(partial, {})).find(({ id }) => id === saved.rule.id),
      ).toMatchObject({ columns: 1, datasets: 1 });
      expect(
        await setRule(partial, {
          kind: "column",
          table_name: cust,
          name: "Email",
          pii: false,
        }),
      ).toMatchObject({ columns: 1, measures: 0, datasets: 1 });
      expect(
        (await changes(tx))
          .filter(
            ({ after }) =>
              (after as { rule_pii: boolean | null }).rule_pii === false,
          )
          .map(({ element_id }) => element_id)
          .sort(),
      ).toEqual([ofColumn["a.Email"], ofColumn["b.Email"]].sort());
      for (const [caller, count] of [
        [context, 0],
        [partial, 1],
      ] as const) {
        const measure = await setRule(caller, {
          kind: "measure",
          table_name: cust,
          name: "Email count",
          pii: true,
        });
        expect(measure).toMatchObject({
          columns: 0,
          measures: count,
          datasets: count,
        });
        expect(
          (await listRules(caller, {})).find(
            ({ id }) => id === measure.rule.id,
          ),
        ).toMatchObject({ columns: count, datasets: count });
      }
    }));

  it("updates a rule in place and audits its before and after", () =>
    rolledBack(async (tx) => {
      const context = adminReaching(tx, [ids.a, ids.b]);
      const first = await setRule(context, {
        kind: "measure",
        table_name: cust,
        name: "Email count",
        pii: true,
      });
      expect(first).toMatchObject({ columns: 0, measures: 1, datasets: 1 });
      const second = await setRule(context, {
        kind: "measure",
        table_name: cust.toUpperCase(),
        name: "email count",
        pii: false,
      });
      expect(second.rule.id).toBe(first.rule.id);
      const listed = await listRules(context, { pii: false });
      expect(listed.map((r) => r.id)).toContain(first.rule.id);
      expect(listed.find(({ id }) => id === first.rule.id)).toMatchObject({
        columns: 1,
        datasets: 1,
      });
      const audits = await tx
        .select()
        .from(auditEvent)
        .where(
          and(
            eq(auditEvent.resource_id, first.rule.id),
            eq(auditEvent.action, "admin.pii_rule.set"),
          ),
        );
      expect(
        audits.some(
          (a) =>
            (a.detail as { before?: { pii?: boolean } }).before?.pii === true,
        ),
      ).toBe(true);
    }));

  it("records the columns a removed rule matched, so their search documents come back", () =>
    rolledBack(async (tx) => {
      const context = adminReaching(tx, [ids.a]);
      const { rule } = await setRule(context, {
        kind: "table",
        table_name: cust,
        pii: true,
      });
      await removeRule(context, rule.id);
      const removed = (await changes(tx)).filter(
        (r) => (r.after as { rule_pii: boolean | null }).rule_pii === null,
      );
      expect(removed.map((r) => r.element_id).sort()).toEqual(
        [
          ofColumn["a.Email"],
          ofColumn["a.Country"],
          ofColumn["a.City"],
          ofColumn["b.Email"],
        ].sort(),
      );
      expect(await piiOf(tx)).toMatchObject({ Email: false });
      await expect(removeRule(context, rule.id)).rejects.toMatchObject({
        kind: "not_found",
      });
    }));

  it("refuses a name on a table rule, a missing name and an id that is not one", () =>
    rolledBack(async (tx) => {
      const context = admin(tx);
      await expect(
        setRule(context, {
          kind: "table",
          table_name: cust,
          name: "Email",
          pii: true,
        }),
      ).rejects.toMatchObject({ kind: "invalid" });
      await expect(
        setRule(context, { kind: "column", table_name: cust, pii: true }),
      ).rejects.toMatchObject({ kind: "invalid" });
      await expect(removeRule(context, "not-a-uuid")).rejects.toMatchObject({
        kind: "not_found",
      });
    }));

  it.each([
    ["table_name", { kind: "table", table_name: ` ${cust}` }],
    ["table_name", { kind: "table", table_name: `${cust}\t` }],
    ["name", { kind: "column", table_name: cust, name: "Email " }],
    ["name", { kind: "measure", table_name: cust, name: "\u00a0Email" }],
  ] as const)(
    "refuses a %s with leading or trailing whitespace",
    (field, input) =>
      rolledBack(async (tx) => {
        await expect(
          setRule(admin(tx), { ...input, pii: true }),
        ).rejects.toMatchObject({
          kind: "invalid",
          message: expect.stringContaining(field) as string,
        });
      }),
  );

  it("checks the length after composing, so a name that grows past 200 is invalid", () =>
    rolledBack(async (tx) => {
      // Each QA composes to two characters under NFC.
      const name = "क़".repeat(150);
      expect(name.normalize("NFC")).toHaveLength(300);
      await expect(
        setRule(admin(tx), {
          kind: "column",
          table_name: cust,
          name,
          pii: true,
        }),
      ).rejects.toMatchObject({ kind: "invalid" });
    }));

  it("stores names composed, so a decomposed spelling is the same rule", () =>
    rolledBack(async (tx) => {
      const context = admin(tx);
      const { rule } = await setRule(context, {
        kind: "column",
        table_name: `Cafe\u0301_${sfx}`,
        name: "Re\u0301sume\u0301",
        pii: true,
      });
      expect(rule.table_name).toBe(`Caf\u00e9_${sfx}`);
      expect(rule.name).toBe("R\u00e9sum\u00e9");
      const again = await setRule(context, {
        kind: "column",
        table_name: `Caf\u00e9_${sfx}`,
        name: "R\u00e9sum\u00e9",
        pii: false,
      });
      expect(again.rule.id).toBe(rule.id);
    }));

  it("refuses a curator every function", () =>
    rolledBack(async (tx) => {
      const curator = asPerson(principals.curator, { db: tx });
      await expect(
        setRule(curator, { kind: "table", table_name: cust, pii: true }),
      ).rejects.toMatchObject({ kind: "refused" });
      await expect(removeRule(curator, randomUUID())).rejects.toMatchObject({
        kind: "refused",
      });
      await expect(listRules(curator, {})).rejects.toMatchObject({
        kind: "refused",
      });
      await expect(suggest(curator, {})).rejects.toMatchObject({
        kind: "refused",
      });
      expect(
        await tx.select().from(piiRule).where(eq(piiRule.table_name, cust)),
      ).toEqual([]);
    }));
});

describe("suggestions", () => {
  it("returns nothing for an admin whose Power BI lists reach no datasets", () =>
    rolledBack(async (tx) => {
      const context = admin(tx);
      expect(await suggest(context, {})).toEqual([]);
      await expect(
        suggest(context, { dataset: names.a }),
      ).rejects.toMatchObject({
        kind: "not_found",
      });
    }));

  it("lists live columns in reached datasets, including off datasets", () =>
    rolledBack(async (tx) => {
      const context = adminReaching(tx, [ids.a]);
      const found = () => suggest(context, { dataset: names.a });
      expect(await found()).toEqual([
        {
          dataset_id: ids.a,
          dataset_name: names.a,
          table_name: cust,
          column_name: "Email",
          matched: "email",
        },
      ]);
      expect(await suggest(context, {})).toEqual(await found());
      expect(await suggest(context, { dataset: ids.a })).toEqual(await found());
      await expect(
        suggest(context, { dataset: names.b }),
      ).rejects.toMatchObject({
        kind: "not_found",
      });
      await setRule(context, {
        kind: "column",
        table_name: cust,
        name: "email",
        pii: false,
      });
      expect(await found()).toEqual([]);
      await expect(
        suggest(context, { dataset: `Nothing ${sfx}` }),
      ).rejects.toMatchObject({ kind: "not_found" });
      await expect(
        suggest(context, { dataset: randomUUID() }),
      ).rejects.toMatchObject({ kind: "not_found" });
    }));
});

describe("who reads PII", () => {
  it("asks Cerbos once per context", async () => {
    let asked = 0;
    const base = createTestDeps();
    const context: ServiceContext = {
      ...base,
      principal: principals.viewer,
      access: {
        ...base.access,
        check: (_principal, resource, action) => {
          asked += 1;
          expect(resource).toEqual(PII);
          expect(action).toBe("read");
          return Promise.resolve(true);
        },
      },
    };
    expect(await readsPii(context)).toBe(true);
    expect(await readsPii(context)).toBe(true);
    expect(asked).toBe(1);
  });

  it("is true for a person holding pii_reader and false for the shipped roles", async () => {
    const reader = { ...principals.viewer, roles: ["pii_reader"] };
    expect(await readsPii(asPerson(reader))).toBe(true);
    for (const principal of Object.values(principals))
      expect(await readsPii(asPerson(principal))).toBe(false);
  });
});
