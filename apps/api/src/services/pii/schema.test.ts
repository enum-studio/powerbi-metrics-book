import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { inRollback } from "../../../test/database.js";
import { closeTestPools, testPool } from "../../../test/deps.js";

afterAll(closeTestPools);

/*
 * The table's CHECKs and unique index, hit with inserts as the api's own
 * role. Each insert runs in a transaction that is rolled back.
 */
const sfx = randomUUID().slice(0, 8);
const table_name = `Cust_${sfx}`;
const insert = `insert into pii_rule (kind, table_name, name, pii, note, set_by_kind, set_by_id, set_via)
  values ($1, $2, $3, true, $4, 'person', 'x', 'api')`;
const row = (
  kind: string,
  table: string,
  name: string | null,
  note: string | null = null,
) => [kind, table, name, note];

describe("the pii_rule table", () => {
  it.each([
    ["a column rule", row("column", table_name, "Email")],
    [
      "a measure rule with the longest note",
      row("measure", table_name, "Email", "x".repeat(500)),
    ],
    ["a table rule", row("table", table_name, null)],
    ["the longest names", row("column", "t".repeat(200), "n".repeat(200))],
  ])("accepts %s", (_, values) =>
    inRollback(testPool("api_rw"), async (client) => {
      const inserted = await client.query(insert, values);
      expect(inserted.rowCount).toBe(1);
    }),
  );

  it.each([
    ["pii_rule_kind", row("dataset", table_name, "Email")],
    ["pii_rule_name", row("table", table_name, "Email")],
    ["pii_rule_name", row("column", table_name, null)],
    ["pii_rule_table_name_length", row("column", "t".repeat(201), "Email")],
    ["pii_rule_name_length", row("column", table_name, "n".repeat(201))],
    [
      "pii_rule_note_length",
      row("column", table_name, "Email", "x".repeat(501)),
    ],
  ])("refuses a row that breaks %s", (constraint, values) =>
    inRollback(testPool("api_rw"), (client) =>
      expect(client.query(insert, values)).rejects.toThrow(
        `constraint "${constraint}"`,
      ),
    ),
  );

  it.each([
    ["case", table_name, "Email", table_name.toUpperCase(), "EMAIL"],
    ["width", table_name, "Country", table_name, "Ｃｏｕｎｔｒｙ"],
    ["the sharp s", `Straße_${sfx}`, "City", `STRASSE_${sfx}`, "City"],
  ])(
    "refuses a second rule that differs only in %s",
    (_, table, name, otherTable, otherName) =>
      inRollback(testPool("api_rw"), async (client) => {
        await client.query(insert, row("column", table, name));
        await expect(
          client.query(insert, row("column", otherTable, otherName)),
        ).rejects.toThrow('constraint "pii_rule_name_idx"');
      }),
  );

  it("allows the same name under another kind", () =>
    inRollback(testPool("api_rw"), async (client) => {
      await client.query(insert, row("column", table_name, "Email"));
      const second = await client.query(
        insert,
        row("measure", table_name.toUpperCase(), "EMAIL"),
      );
      expect(second.rowCount).toBe(1);
    }));
});
