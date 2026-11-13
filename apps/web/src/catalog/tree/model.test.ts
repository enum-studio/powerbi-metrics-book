import { describe, expect, it } from "vitest";
import { categoryCounts, categoryNamesById, categoryTrail } from "./model";
import type { Category } from "./model";

const category = (
  path: string,
  name: string,
  metric_count: number,
  children: Category[] = [],
): Category => ({
  kind: "category",
  id: path,
  key: path,
  path,
  name,
  description: null,
  icon: null,
  position: 0,
  metric_count,
  children,
});

const categories: Category[] = [
  category("sales", "Sales", 1, [
    category("sales/orders", "Orders", 1, [
      category("sales/orders/online", "Online", 1),
    ]),
  ]),
];

describe("catalog tree model", () => {
  it("counts a category's own metrics and those of its subcategories", () => {
    expect(categoryCounts(categories)).toEqual(
      new Map([
        ["sales", 3],
        ["sales/orders", 2],
        ["sales/orders/online", 1],
      ]),
    );
  });
  it("opens the category path to a metric two levels down", () => {
    expect(categoryTrail(categories, "sales/orders/online")).toEqual([
      "sales",
      "sales/orders",
      "sales/orders/online",
    ]);
  });
  it("names a category by its id, from the top down, and nothing for an id not listed", () => {
    expect(categoryNamesById(categories, "sales/orders/online")).toBe(
      "Sales / Orders / Online",
    );
    expect(categoryNamesById(categories, "gone")).toBeUndefined();
  });
});
