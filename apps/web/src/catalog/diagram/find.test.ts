import { describe, expect, it } from "vitest";
import { findTables, HITS_SHOWN, matchesTerm } from "./find";

const names = [
  "Sales",
  "Date",
  "Customer",
  "Order lines",
  "Returned orders",
  "Sales target",
  "Wholesale",
];

describe("findTables", () => {
  it("finds the names that hold the term in any case: a name's start first, then a word's start, then anywhere", () => {
    expect(findTables(names, "SALE")).toEqual([
      "Sales",
      "Sales target",
      "Wholesale",
    ]);
    expect(findTables(names, "order")).toEqual([
      "Order lines",
      "Returned orders",
    ]);
  });

  it("finds nothing for an empty or blank term, and ignores the spaces around one", () => {
    expect(findTables(names, "")).toEqual([]);
    expect(findTables(names, "   ")).toEqual([]);
    expect(findTables(names, " date ")).toEqual(["Date"]);
  });

  it("lists at most the hits that fit under the box, numbers in their order", () => {
    const many = Array.from({ length: 20 }, (_, i) => `Fact ${String(i + 1)}`);
    const found = findTables(many, "fact");
    expect(found).toHaveLength(HITS_SHOWN);
    expect(found.slice(0, 3)).toEqual(["Fact 1", "Fact 2", "Fact 3"]);
  });
});

describe("matchesTerm", () => {
  it("matches every table while the box is empty, and a name holding the term otherwise", () => {
    expect(matchesTerm("Customer", "")).toBe(true);
    expect(matchesTerm("Customer", "TOM")).toBe(true);
    expect(matchesTerm("Customer", "date")).toBe(false);
  });
});
