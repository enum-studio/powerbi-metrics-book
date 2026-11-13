import { describe, expect, it } from "vitest";
import { DaxSyntaxError, normalize, tokenize } from "./index.js";

describe("tokenize", () => {
  it("classifies each token and normalises its text", () => {
    const tokens = tokenize(`VAR total = Sum('Net Sales'[Amount]) // note
      RETURN IF(NOT ISBLANK(total) && total >= 1.50, "Big ""one""", Sales[Cost] - 2)`);
    expect(tokens.map(({ kind, text }) => `${kind} ${text}`)).toEqual([
      "keyword VAR",
      "identifier total",
      "operator =",
      "function SUM",
      "open (",
      "table 'net sales'",
      "column [amount]",
      "close )",
      "keyword RETURN",
      "function IF",
      "open (",
      "keyword NOT",
      "function ISBLANK",
      "open (",
      "identifier total",
      "close )",
      "operator &&",
      "identifier total",
      "operator >=",
      "number 1.5",
      "comma ,",
      'string "Big ""one"""',
      "comma ,",
      "table sales",
      "column [cost]",
      "operator -",
      "number 2",
      "close )",
    ]);
  });

  it("unescapes a doubled quote in a table name and a doubled bracket in a column name", () => {
    expect(tokenize("'Bob''s Sales'[Net [EUR]]]")).toEqual([
      { kind: "table", text: "'bob''s sales'" },
      { kind: "column", text: "[net [eur]]]" },
    ]);
  });

  it.each([
    ["an unterminated string", `IF([Units] > 1, "many`],
    ["an unterminated quoted table", "SUM('Sales[Amount])"],
    ["an unterminated bracket", "SUM('Sales'[Amount)"],
    ["an unterminated comment", "SUM('Sales'[Amount]) /* note"],
    ["a character DAX does not use", "SUM('Sales'[Amount]) # note"],
  ])("throws DaxSyntaxError on %s", (_, dax) => {
    expect(() => tokenize(dax)).toThrow(DaxSyntaxError);
  });
});

describe("normalize", () => {
  it("writes one canonical text", () => {
    expect(normalize("var X = Sum( 'Sales'[Amount] ) return x * 1.0")).toBe(
      "VAR x=SUM(sales[amount])RETURN x*1",
    );
  });

  it.each([
    ["function case", "SUM('Sales'[Amount])", "sum('Sales'[Amount])"],
    ["name case", "SUM('Sales'[Amount])", "SUM('SALES'[amount])"],
    ["keyword case", "VAR x = 1 RETURN x", "var X = 1 return X"],
    [
      "a quoted and an unquoted table",
      "SUM('Sales'[Amount])",
      "SUM(Sales[Amount])",
    ],
    [
      "a quoted table and a bare table reference",
      "COUNTROWS('Sales')",
      "COUNTROWS(Sales)",
    ],
    [
      "whitespace",
      "SUM('Sales'[Amount])",
      "  SUM (\n\t'Sales' [Amount]\r\n)  ",
    ],
    [
      "a line comment",
      "SUM('Sales'[Amount])",
      "SUM('Sales'[Amount]) // the total",
    ],
    [
      "a dash comment",
      "SUM('Sales'[Amount])",
      "-- the total\nSUM('Sales'[Amount])",
    ],
    [
      "a block comment",
      "SUM('Sales'[Amount])",
      "SUM(/* the total */'Sales'[Amount])",
    ],
    ["1.0 and 1", "[Units] * 1.0", "[Units] * 1"],
    ["0.50 and .5", "[Units] * 0.50", "[Units] * .5"],
    ["leading zeros", "[Units] * 010", "[Units] * 10"],
    ["an exponent", "[Units] * 1.5e2", "[Units] * 150"],
    ["a negative exponent", "[Units] * 25E-3", "[Units] * 0.025"],
  ])("gives one text for %s", (_, first, second) => {
    expect(normalize(first)).toBe(normalize(second));
  });

  it.each([
    ["a changed column", "SUM('Sales'[Amount])", "SUM('Sales'[Quantity])"],
    ["a changed table", "SUM('Sales'[Amount])", "SUM('Returns'[Amount])"],
    ["a changed function", "SUM('Sales'[Amount])", "AVERAGE('Sales'[Amount])"],
    ["a changed string's case", `[Color] = "Red"`, `[Color] = "red"`],
    ["a moved decimal point", "[Units] * 1.5", "[Units] * 15"],
    ["a changed fraction", "[Units] * 0.1", "[Units] * 0.01"],
    [
      "two digits past a double's precision",
      "[Units] * 12345678901234567890",
      "[Units] * 12345678901234567891",
    ],
    ["strict and loose equality", "[Units] = 1", "[Units] == 1"],
  ])("keeps %s apart", (_, first, second) => {
    expect(normalize(first)).not.toBe(normalize(second));
  });

  it.each([
    "1 - -1",
    "[Units] < -1 && [Units] <> 2",
    "'Net Sales'[Amount] + 'VAR'[x] + 'True'[y] + '2025'[z]",
    `"a" & "b"`,
    "[Units] * 1e60 + 0.5e-50",
    "VAR x = 1 RETURN (x)",
    "COUNTROWS(Ventes_été)",
  ])("is stable when applied twice: %s", (dax) => {
    expect(normalize(normalize(dax))).toBe(normalize(dax));
  });
});
