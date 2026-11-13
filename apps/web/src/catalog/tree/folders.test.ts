import { describe, expect, it } from "vitest";
import {
  folderLevels,
  folderPaths,
  folderParam,
  hasDotName,
  folderTrail,
  folderTree,
} from "./folders";

const m = (name: string, folder: string | null = null) => ({ name, folder });
const names = (items: { name: string }[]) => items.map((item) => item.name);

describe("a display folder", () => {
  it("nests on a backslash and names several folders with a semicolon", () => {
    expect(folderPaths("Sales\\Margin;KPIs")).toEqual([
      ["Sales", "Margin"],
      ["KPIs"],
    ]);
  });

  it("drops empty parts and spaces around a name, and is no folder when empty", () => {
    expect(folderPaths(" Sales \\\\ Margin\\ ")).toEqual([["Sales", "Margin"]]);
    expect(folderPaths("")).toEqual([]);
    expect(folderPaths(" ; \\ ")).toEqual([]);
    expect(folderPaths(null)).toEqual([]);
  });
});

describe("a table's measures by display folder", () => {
  it("puts folders first and the measures in no folder after them, A to Z", () => {
    const tree = folderTree([
      m("Orders"),
      m("Net sales", "Sales"),
      m("Average order value"),
      m("Gross sales", "Sales"),
    ]);
    expect(names(tree.folders)).toEqual(["Sales"]);
    expect(names(tree.folders[0]?.items ?? [])).toEqual([
      "Gross sales",
      "Net sales",
    ]);
    expect(names(tree.loose)).toEqual(["Average order value", "Orders"]);
  });

  it("nests folders, keeps each folder's path, and counts every measure below it once", () => {
    const tree = folderTree([
      m("Margin", "Sales\\Margin"),
      m("Margin %", "Sales\\Margin"),
      m("Net sales", "Sales"),
      m("Both", "Sales\\Margin;Sales"),
    ]);
    const sales = tree.folders[0];
    expect(sales?.path).toBe("Sales");
    expect(sales?.count).toBe(4);
    expect(names(sales?.items ?? [])).toEqual(["Both", "Net sales"]);
    const margin = sales?.folders[0];
    expect(margin?.path).toBe("Sales\\Margin");
    expect(margin?.count).toBe(3);
    expect(names(margin?.items ?? [])).toEqual(["Both", "Margin", "Margin %"]);
    expect(tree.loose).toEqual([]);
  });

  it("orders numbers as a person reads them", () => {
    const tree = folderTree([
      m("x", "Week 10"),
      m("y", "Week 9"),
      m("z", "week 1"),
    ]);
    expect(names(tree.folders)).toEqual(["week 1", "Week 9", "Week 10"]);
  });

  it("is empty for a table with no measures", () => {
    expect(folderTree([])).toEqual({ folders: [], loose: [] });
  });
});

describe("the way to a folder", () => {
  it("lists each folder from the top down", () => {
    expect(folderTrail("Sales\\Margin\\EUR")).toEqual([
      "Sales",
      "Sales\\Margin",
      "Sales\\Margin\\EUR",
    ]);
  });
});

it("round trips folder levels through the router's decoded param", () => {
  const levels = ["In/Out", "Q1 % sales"];
  expect(folderLevels(folderParam(levels))).toEqual(levels);
});

it("round trips nested folder levels", () => {
  expect(folderLevels(folderParam(["Dates", "Fiscal"]))).toEqual([
    "Dates",
    "Fiscal",
  ]);
});

it("reads an empty or trailing separator as no level", () => {
  expect(folderLevels("")).toEqual([]);
  expect(folderLevels("Dates\\")).toEqual(["Dates"]);
});

it("finds a dot name in any of the names an address holds", () => {
  expect(hasDotName("Sales", "..", "Dates")).toBe(true);
  expect(hasDotName(".")).toBe(true);
  expect(hasDotName("Sales", "...", "a.b", "..x")).toBe(false);
});
