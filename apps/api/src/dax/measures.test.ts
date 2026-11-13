import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type MeasureMap,
  expandMeasures,
  fingerprint,
  measureMap,
  readsSelection,
  referencedMeasures,
} from "./index.js";

const measures = (entries: Record<string, string>): MeasureMap =>
  measureMap(
    Object.entries(entries).map(([name, expression]) => ({
      name,
      expression,
      table: "Sales",
    })),
  );

const expanded = (name: string, dataset: MeasureMap): string => {
  const result = expandMeasures(name, dataset);
  if (!("expanded" in result))
    throw new Error(`Unexpected ${JSON.stringify(result)}`);
  return result.expanded;
};

describe("fingerprint of an expanded measure", () => {
  const printOf = (entries: Record<string, string>, name: string) =>
    fingerprint(expanded(name, measures(entries)));

  it("is one for two spellings of one calculation, and for what is built on them", () => {
    const plain = {
      Orders: "DISTINCTCOUNT(Sales[Order id])",
      Twice: "[Orders] * 2",
    };
    const spelled = {
      Orders: "VAR Result = DISTINCTCOUNT( 'Sales'[Order id] ) RETURN Result",
      Twice: "VAR Count = [Orders] RETURN ( Count * 2 )",
    };
    expect(printOf(plain, "Orders")).toBe(printOf(spelled, "Orders"));
    expect(printOf(plain, "Twice")).toBe(printOf(spelled, "Twice"));
  });

  it("reads a reference as the CALCULATE it means, so a bracket that binds is no reference", () => {
    const reference = printOf(
      { Net: "SUM(Sales[A]) - SUM(Sales[C])", Each: "SUMX(Sales, [Net] * 2)" },
      "Each",
    );
    expect(reference).not.toBe(
      printOf(
        { Each: "SUMX(Sales, (SUM(Sales[A]) - SUM(Sales[C])) * 2)" },
        "Each",
      ),
    );
    expect(reference).toBe(
      printOf(
        { Each: "SUMX(Sales, CALCULATE(SUM(Sales[A]) - SUM(Sales[C])) * 2)" },
        "Each",
      ),
    );
  });

  it("is another for a measure in an iterator and its DAX written out, as only the first transitions", () => {
    const base = { Net: "SUM(Sales[Amount])" };
    expect(printOf({ ...base, Each: "SUMX(Sales, [Net])" }, "Each")).not.toBe(
      printOf({ ...base, Each: "SUMX(Sales, SUM(Sales[Amount]))" }, "Each"),
    );
  });
});

describe("expandMeasures", () => {
  const dataset = measures({
    "Net Sales": "SUM('Sales'[Amount])",
    "Total Cost": "SUM('Sales'[Cost])",
    Margin: "[Net Sales] - [total cost]",
    "Margin Share": "DIVIDE([Margin], 'Sales'[Net Sales])",
  });

  it("replaces nested and qualified measure references with their expressions under CALCULATE", () => {
    expect(expanded("Margin Share", dataset)).toBe(
      "DIVIDE(CALCULATE(CALCULATE(SUM(sales[amount]))-CALCULATE(SUM(sales[cost]))),CALCULATE(SUM(sales[amount])))",
    );
  });

  it("leaves a column that is not a measure as it is", () => {
    expect(expanded("Total Cost", dataset)).toBe("SUM(sales[cost])");
  });

  it.each([
    ["SUM(Returns[Units])", "SUM(returns[units])"],
    ["SUM('Stock'[Units])", "SUM(stock[units])"],
    ["SUM(Returns \t\n [Units])", "SUM(returns[units])"],
    ["SUM('Stock' \t\r\n [Units])", "SUM(stock[units])"],
    ["SUM(Returns /* units */ [Units])", "SUM(returns[units])"],
    ["'Stock'[Units]", "stock[units]"],
    ["Sales[Units]", "CALCULATE(SUM(sales[quantity]))"],
    ["'sAlEs' \t [Units]", "CALCULATE(SUM(sales[quantity]))"],
    ["[Units] * 2", "CALCULATE(SUM(sales[quantity]))*2"],
  ])("resolves measures by their home table in %s", (expression, expected) => {
    const collision = measures({
      Units: "SUM(Sales[Quantity])",
      Result: expression,
    });
    expect(expanded("Result", collision)).toBe(expected);
  });

  it.each([
    ["the first measure of a cycle of three", "A", ["A", "B", "C"]],
    ["the second measure of a cycle of three", "b", ["b", "C", "A"]],
    ["a measure that leads into a cycle", "Entry", ["A", "B", "C"]],
    ["a measure that references itself", "Itself", ["Itself"]],
  ])("returns the cycle's names in order from %s", (_, name, cycle) => {
    const cyclic = measures({
      A: "[B] + 1",
      B: "[C] * 2",
      C: "'Sales'[A] - 1",
      Entry: "[A] / 2",
      Itself: "[Itself] + 1",
    });
    expect(expandMeasures(name, cyclic)).toEqual({ cycle });
  });

  it("throws on a name the dataset does not hold", () => {
    expect(() => expandMeasures("Missing", dataset)).toThrow(/Missing/);
  });
});

describe("fingerprint", () => {
  const north = measures({
    Revenue: "SUM(Sales[Amount])",
    "Revenue Per Unit": "DIVIDE([Revenue], SUM(Sales[Quantity]))",
  });
  const south = measures({
    "Total Revenue": "sum ( 'Sales'[AMOUNT] )",
    "Average Price":
      "divide([Total Revenue], SUM('Sales'[Quantity])) // per unit",
  });

  it("is the SHA-256 hex of the normalised expression", () => {
    const expected = createHash("sha256")
      .update("SUM(sales[amount])")
      .digest("hex");
    expect(fingerprint(" sum ( 'Sales'[Amount] ) -- total")).toBe(expected);
  });

  it("is the same for one calculation spelled and named differently in two datasets", () => {
    expect(fingerprint(expanded("Average Price", south))).toBe(
      fingerprint(expanded("Revenue Per Unit", north)),
    );
  });

  it("differs when a referenced measure reads another column", () => {
    const changed = measures({
      Revenue: "SUM(Sales[Net])",
      "Revenue Per Unit": "DIVIDE([Revenue], SUM(Sales[Quantity]))",
    });
    expect(fingerprint(expanded("Revenue Per Unit", changed))).not.toBe(
      fingerprint(expanded("Revenue Per Unit", north)),
    );
  });
});

describe("referencedMeasures", () => {
  const homes = measureMap(
    ["Net Sales", "Units", "Margin"].map((name) => ({ name, table: "Sales" })),
  );

  it("lists referenced measures once each, as named, in order of use", () => {
    const dax = `EVALUATE SUMMARIZECOLUMNS('Date'[Year], "Units", 'Sales'[units], "Sales", [NET SALES], "Again", [Units])`;
    expect(referencedMeasures(dax, homes)).toEqual(["Units", "Net Sales"]);
    expect(referencedMeasures("SUM(Returns[Units])", homes)).toEqual([]);
  });

  it("ignores a measure name inside a string", () => {
    expect(referencedMeasures(`ROW("[Net Sales]", 1)`, homes)).toEqual([]);
  });
});

describe("readsSelection", () => {
  it.each([
    [`SELECTEDVALUE('Currency'[Code], "EUR")`, true, ["'Currency'[Code]"]],
    [`IF(HASONEVALUE('Date'[Year]), [Units], BLANK())`, true, ["'Date'[Year]"]],
    ["ISFILTERED('Date')", true, []],
    [
      "ISINSCOPE('Product'[Category]) + ISCROSSFILTERED(product[CATEGORY])",
      true,
      ["'Product'[Category]"],
    ],
    ["SELECTEDVALUE([Code])", true, ["[Code]"]],
    [
      "SELECTEDVALUE('Currency'[Code], MAX('Rates'[Default]))",
      true,
      ["'Currency'[Code]"],
    ],
    ["SUM('Sales'[Amount])", false, []],
    [`"SELECTEDVALUE('Currency'[Code])"`, false, []],
  ])("%s", (expression, reads, columns) => {
    expect(readsSelection(expression)).toEqual({ reads, columns });
  });
});
