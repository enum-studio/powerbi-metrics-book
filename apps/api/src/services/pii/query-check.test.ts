import { afterAll, describe, expect, it } from "vitest";
import { closeTestPools, createTestDeps } from "../../../test/deps.js";
import type { Db } from "../../context.js";
import { lex } from "../../dax/tokens.js";
import {
  checkQuery,
  checkResultColumns,
  type FoldedToken,
  type PiiNames,
  piiKeys,
  piiReferences,
  UNCHECKABLE,
} from "./query-check.js";
import { foldNames } from "./rules.js";

/*
 * The pure walk runs on names a test folds by hand (lower case), so each rule
 * is read off the sets alone. The last tests fold through the database.
 */

const sets = (entries: Record<string, string[]> = {}) =>
  new Map(Object.entries(entries).map(([t, c]) => [t, new Set(c)]));
const namesWith = (found: Partial<PiiNames> = {}): PiiNames => ({
  columns: sets(),
  bare: new Set(),
  measures: sets(),
  tables: new Set(),
  ruleColumns: sets(),
  ruleMeasures: sets(),
  ruleTables: sets(),
  knownMeasures: sets(),
  ...found,
});
// Customer[Email] is a PII column; Customer[Country] is not.
const email = namesWith({
  columns: sets({ customer: ["email"] }),
  bare: new Set(["email"]),
  tables: new Set(["customer"]),
});

const folded = (dax: string): FoldedToken[] =>
  lex(dax).map((token) => ({ ...token, folded: token.name.toLowerCase() }));
const knownTables = new Set(["customer", "orders", "order", "b"]);
const refs = (dax: string, names: PiiNames) =>
  piiReferences(folded(dax), names, knownTables);
const checked = (
  db: Parameters<typeof checkQuery>[0],
  dax: string,
  names: PiiNames,
) => checkQuery(db, dax, names, knownTables);

describe("piiReferences", () => {
  it("refuses a table with a PII column used whole", () => {
    expect(refs("EVALUATE Customer", email)).toEqual(["the table Customer"]);
    expect(refs("EVALUATE FILTER('Customer', 1 = 1)", email)).toEqual([
      "the table 'Customer'",
    ]);
  });

  it("refuses a qualified PII column and lets its table's other columns pass", () => {
    expect(refs('EVALUATE ROW("x", MAX(Customer[Email]))', email)).toEqual([
      "Customer[Email]",
    ]);
    expect(refs("EVALUATE VALUES(Customer[Country])", email)).toEqual([]);
  });

  it("checks a qualified name as bare when its qualifier is not mirrored", () => {
    const names = namesWith({ bare: new Set(["email"]) });
    const knownTables = new Set(["customer", "orders"]);
    const withTables = (dax: string) =>
      piiReferences(folded(dax), names, knownTables);
    expect([
      withTables("EVALUATE VALUES(Orders[Email])"),
      withTables("EVALUATE VALUES(Customer.[Email])"),
      withTables("EVALUATE VALUES('Customer '[Email])"),
    ]).toEqual([[], ["[Email]"], ["[Email]"]]);
  });

  it("checks an unknown qualifier against unsynced columns covered by a table rule", () => {
    const names = namesWith({ ruleTables: sets({ customer: [] }) });
    const tokens = folded("EVALUATE VALUES(Customer.[Secret])");
    const known = new Set(["customer", "orders"]);
    expect(piiReferences(tokens, names, known)).toEqual(["[Secret]"]);
    names.ruleTables = sets({ customer: ["secret"] });
    expect(piiReferences(tokens, names, known)).toEqual([]);
    names.ruleTables = sets({ customer: [] });
    names.knownMeasures = sets({ customer: ["secret"] });
    expect(piiReferences(tokens, names, known)).toEqual([]);
  });

  it("refuses a bare PII name, in a DEFINE block too", () => {
    expect(refs('EVALUATE ROW("x", [Email])', email)).toEqual(["[Email]"]);
    expect(
      refs(
        'DEFINE MEASURE Orders[Mine] = MAX(Customer[Email]) EVALUATE ROW("x", [Mine])',
        email,
      ),
    ).toEqual(["Customer[Email]"]);
    expect(
      refs('DEFINE MEASURE Customer[Email] = 1 EVALUATE ROW("x", 1)', email),
    ).toEqual(["Customer[Email]"]);
  });

  it("allows a qualified column of the same name as a bare PII name in another table", () => {
    expect(refs("EVALUATE VALUES(Orders[Email])", email)).toEqual([]);
    expect(refs("EVALUATE VALUES([Email])", email)).toEqual(["[Email]"]);
  });

  it("does not match a name inside a string literal or a comment", () => {
    expect(
      refs(
        'EVALUATE ROW("Customer[Email] [Email]", 1) // [Email] Customer',
        email,
      ),
    ).toEqual([]);
  });

  it("lists each reference as written, once, in order of first appearance", () => {
    expect(
      refs(
        'EVALUATE ROW("a", [Email], MAX(Customer[Email]), [EMAIL], Customer, [Email])',
        email,
      ),
    ).toEqual(["[Email]", "Customer[Email]", "[EMAIL]", "the table Customer"]);
  });

  it("reads quoted tables and escaped names", () => {
    const odd = namesWith({
      columns: sets({ "cust 'x'": ["em]ail"] }),
      tables: new Set(["cust 'x'"]),
    });
    expect(refs("EVALUATE VALUES('Cust ''x'''[Em]]ail])", odd)).toEqual([
      "'Cust ''x'''[Em]]ail]",
    ]);
  });

  it("refuses a rule's measure by its bare name even when it is not synced", () => {
    const sales = namesWith({
      ruleMeasures: sets({ customer: ["sales"] }),
      bare: new Set(["sales"]),
    });
    expect(refs('EVALUATE ROW("x", [Sales])', sales)).toEqual(["[Sales]"]);
    expect(refs('EVALUATE ROW("x", Customer[Sales])', sales)).toEqual([
      "Customer[Sales]",
    ]);
  });

  it("refuses a column added to a ruled table since the last sync, and a cleared one passes", () => {
    const ruled = namesWith({
      tables: new Set(["customer"]),
      ruleTables: sets({ customer: ["country"] }),
      knownMeasures: sets({ customer: ["count"] }),
    });
    expect(refs("EVALUATE VALUES(Customer[Fresh])", ruled)).toEqual([
      "Customer[Fresh]",
    ]);
    expect(refs("EVALUATE VALUES(Customer[Country])", ruled)).toEqual([]);
    // A measure of the covered table passes as the table's own measure.
    expect(refs('EVALUATE ROW("n", Customer[Count])', ruled)).toEqual([]);
    // A table rule does not cover a bare name; the table is the way in.
    expect(refs('EVALUATE ROW("n", [Fresh])', ruled)).toEqual([]);
  });

  it("refuses a table added since the last sync under a table rule as a whole table", () => {
    const ruled = namesWith({
      tables: new Set(["newtable"]),
      ruleTables: sets({ newtable: [] }),
    });
    expect(refs("EVALUATE NewTable", ruled)).toEqual(["the table NewTable"]);
  });

  it("refuses the functions that read every column without naming one", () => {
    for (const dax of [
      "EVALUATE COLUMNSTATISTICS()",
      "EVALUATE columnstatistics()",
      "EVALUATE DETAILROWS([Count])",
      "EVALUATE EXTERNALMEASURE(1)",
      "EVALUATE INFO.VIEW.COLUMNS()",
      "EVALUATE info.tables()",
    ])
      expect(refs(dax, email)).toHaveLength(1);
    expect(refs("EVALUATE COLUMNSTATISTICS()", email)).toEqual([
      "the function COLUMNSTATISTICS",
    ]);
    // Nothing to hide in the dataset, nothing to refuse.
    expect(refs("EVALUATE COLUMNSTATISTICS()", namesWith())).toEqual([]);
    expect(refs('EVALUATE ROW("x", SUM(Orders[Amount]))', email)).toEqual([]);
  });

  it("refuses alternate tokens and spellings of model-wide functions", () => {
    for (const dax of [
      "EVALUATE 'INFO.VIEW.COLUMNS'()",
      "EVALUATE [INFO.VIEW.COLUMNS]()",
      "EVALUATE INFO. VIEW.COLUMNS()",
      "EVALUATE İNFO.VIEW.COLUMNS()",
    ])
      expect(refs(dax, email)).toHaveLength(1);
  });

  it("reads a keyword before a column as a table, and a keyword alone as a whole table", () => {
    const orders = namesWith({
      columns: sets({ order: ["phone"] }),
      bare: new Set(["phone"]),
      tables: new Set(["order"]),
    });
    expect(refs("EVALUATE Order", orders)).toEqual(["the table Order"]);
    expect(refs("EVALUATE FILTER(Order, 1 = 1)", orders)).toEqual([
      "the table Order",
    ]);
    expect(refs("EVALUATE VALUES(Order[Phone])", orders)).toEqual([
      "Order[Phone]",
      "[Phone]",
    ]);
    const ruled = namesWith({
      tables: new Set(["order"]),
      ruleTables: sets({ order: [] }),
    });
    expect(refs("EVALUATE VALUES(Order[Fresh])", ruled)).toEqual([
      "Order[Fresh]",
    ]);
    // ORDER BY is not a table, and a bare name after it is still checked.
    expect(
      refs("EVALUATE Customer ORDER BY Customer[Country]", orders),
    ).toEqual([]);
    expect(
      refs("EVALUATE VALUES(Customer[Country]) ORDER BY [Phone]", orders),
    ).toEqual(["[Phone]"]);
  });

  it("refuses a DEFINE of a measure or column on a covered table", () => {
    const ruled = namesWith({
      tables: new Set(["customer", "orders"]),
      ruleTables: sets({ customer: [] }),
      knownMeasures: sets({ customer: ["count"] }),
    });
    expect(
      refs(
        'DEFINE MEASURE Customer[Count] = MAX([Fresh]) EVALUATE ROW("x", [Count])',
        ruled,
      ),
    ).toEqual(["a definition on the table Customer"]);
    expect(
      refs('DEFINE COLUMN Customer[Mine] = 1 EVALUATE ROW("x", 1)', ruled),
    ).toEqual(["a definition on the table Customer", "Customer[Mine]"]);
    expect(
      refs('DEFINE MEASURE Orders[Mine] = 1 EVALUATE ROW("x", [Mine])', ruled),
    ).toEqual([]);
  });

  it("refuses the name of a PII measure written on another table", () => {
    const measure = namesWith({
      measures: sets({ customer: ["piimeasure"] }),
      bare: new Set(["piimeasure"]),
      knownMeasures: sets({ customer: ["piimeasure"], orders: ["mine"] }),
    });
    expect(refs('EVALUATE ROW("x", Orders[PiiMeasure])', measure)).toEqual([
      "Orders[PiiMeasure]",
    ]);
    expect(refs('EVALUATE ROW("x", Orders[Mine])', measure)).toEqual([]);
  });

  it("matches a measure rule by name across tables in one model", () => {
    const measure = namesWith({
      ruleMeasures: sets({ a: ["sales"] }),
      bare: new Set(["sales"]),
      knownMeasures: sets({ b: ["sales"] }),
    });
    expect(refs('EVALUATE ROW("x", B[Sales])', measure)).toEqual(["B[Sales]"]);
  });

  it("does not let a cleared name override a synced PII column", () => {
    const both = namesWith({
      columns: sets({ customer: ["email"] }),
      ruleTables: sets({ customer: ["email"] }),
    });
    expect(refs("EVALUATE VALUES(Customer[Email])", both)).toEqual([
      "Customer[Email]",
    ]);
  });
});

describe("piiKeys", () => {
  it("refuses a bare result key whose name is a bare PII name", () => {
    const keys = [
      { key: "[Email]", table: "", column: "email" },
      { key: "[Total]", table: "", column: "total" },
    ];
    expect(piiKeys(keys, email)).toEqual(["[Email]"]);
  });

  const key = (name: string, table: string, column: string) => ({
    key: name,
    table,
    column,
  });
  it("applies the qualified rule to a result column key", () => {
    expect(
      piiKeys(
        [
          key("Customer[Email]", "customer", "email"),
          key("Customer[Country]", "customer", "country"),
        ],
        email,
      ),
    ).toEqual(["Customer[Email]"]);
  });

  it("reads every split of a key whose table holds a bracket", () => {
    const odd = namesWith({ columns: sets({ "a]b": ["c"] }) });
    expect(piiKeys([key("a]b[c]", "a]b", "c")], odd)).toEqual(["a]b[c]"]);
  });
});

describe("with the database's fold", () => {
  afterAll(closeTestPools);

  it("refuses a full-width column name like the plain one", async () => {
    const db = createTestDeps().db;
    const names = namesWith({
      columns: sets({ customer: ["email"] }),
      bare: new Set(["email"]),
      tables: new Set(["customer"]),
    });
    await expect(
      checked(db, "EVALUATE VALUES(Customer[Ｅｍａｉｌ])", names),
    ).resolves.toEqual(["Customer[Ｅｍａｉｌ]"]);
    await expect(
      checked(db, "EVALUATE VALUES(CUSTOMER[email])", names),
    ).resolves.toEqual(["CUSTOMER[email]"]);
  });

  // A db that rejects every call: any ask fails the test.
  const asked = () => {
    return {
      execute: () => Promise.reject(new Error("the database was asked")),
      select: () => Promise.reject(new Error("the database was asked")),
      transaction: () => Promise.reject(new Error("the database was asked")),
    } as unknown as Db;
  };

  it("does not ask the database when nothing is hidden", async () => {
    await expect(
      checked(asked(), "EVALUATE Customer", namesWith()),
    ).resolves.toEqual([]);
    await expect(
      checkResultColumns(asked(), [{ name: "Customer[Email]" }], namesWith()),
    ).resolves.toEqual([]);
  });

  it("refuses a name the database cannot read, and a NUL is one", async () => {
    const db = createTestDeps().db;
    await expect(
      checked(db, "EVALUATE VALUES(Customer[Co\0untry])", email),
    ).resolves.toEqual([UNCHECKABLE]);
    await expect(
      checkResultColumns(db, [{ name: "Customer[Co\0untry]" }], email),
    ).resolves.toEqual([UNCHECKABLE]);
  });

  it("rethrows any other failure, so an outage is an outage", async () => {
    await expect(
      checked(asked(), "EVALUATE VALUES(Customer[Country])", email),
    ).rejects.toThrow("the database was asked");
    expect(await foldNames(createTestDeps().db, ["Ｅ"])).toEqual(["e"]);
  });

  it("reads a bare result key against the bare names", async () => {
    await expect(
      checkResultColumns(
        createTestDeps().db,
        [
          { name: "[Email]" },
          { name: "[Total]" },
          { name: "Customer[Country]" },
        ],
        email,
      ),
    ).resolves.toEqual(["[Email]"]);
  });
});
