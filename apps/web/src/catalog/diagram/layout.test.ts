import { describe, expect, it } from "vitest";
import {
  FOOT,
  HEAD,
  ROW,
  WIDTH,
  cardinalityLabel,
  ends,
  FOCUS_ZOOM,
  filteringTable,
  focusOn,
  grid,
  keepVisible,
  keysOf,
  layout,
  rowsFor,
  viewport,
} from "./layout";
import type { DiagramModel, DiagramTable } from "./model";

function table(name: string, columns: string[], measures = 0): DiagramTable {
  return {
    name,
    description: null,
    columns: columns.map((c, i) => ({
      name: c,
      type: "Int64",
      hidden: i === 1,
    })),
    measures: Array.from({ length: measures }, (_, i) => ({
      name: `M${String(i)}`,
      folder: null,
    })),
  };
}

const model: DiagramModel = {
  tables: [
    table("Sales", ["Id", "ProductKey", "Qty", "DateKey"], 2),
    table("Product", ["ProductKey", "Name"], 1),
    table("Date", ["DateKey", "Year"]),
    table("Lonely", ["A"], 3),
  ],
  relationships: [
    {
      from_table: "Sales",
      from_column: "ProductKey",
      to_table: "Product",
      to_column: "ProductKey",
      cardinality: "Many:One",
      filters: "one_way",
      is_active: true,
    },
    {
      from_table: "Sales",
      from_column: "DateKey",
      to_table: "Date",
      to_column: "DateKey",
      cardinality: "Many:One",
      filters: "both_ways",
      is_active: false,
    },
  ],
  unknown: null,
};

const pane = { width: 1000, height: 600 };

describe("viewport", () => {
  it("starts a tall model 32px from the top at a zoom of at least 0.6, never above 1", () => {
    const view = viewport({ x: 24, y: 24, width: 800, height: 3000 }, pane);
    expect(view.zoom).toBeGreaterThanOrEqual(0.6);
    expect(view.zoom).toBeLessThanOrEqual(1);
    expect(24 * view.zoom + view.y).toBeCloseTo(32);
    expect(view.x + (24 + 400) * view.zoom).toBeCloseTo(500);
  });

  it("centres a model that fits, at a zoom of 1", () => {
    const view = viewport({ x: 24, y: 24, width: 400, height: 200 }, pane);
    expect(view.zoom).toBe(1);
    expect(view.x + (24 + 200)).toBeCloseTo(500);
    expect(view.y + (24 + 100)).toBeCloseTo(300);
  });

  it("stays at 60% and aligns a model wider than the pane to its left edge", () => {
    const view = viewport({ x: 0, y: 0, width: 2000, height: 300 }, pane);
    expect(view.zoom).toBe(0.6);
    expect(view.x).toBe(32);
  });

  it("puts the arrival table's middle in the pane's middle, both ways", () => {
    const bounds = { x: 24, y: 24, width: 800, height: 3000 };
    const arrival = { x: 24, y: 2000, width: 232, height: 120 };
    const view = viewport(bounds, pane, arrival);
    expect(view.x + (arrival.x + arrival.width / 2) * view.zoom).toBeCloseTo(
      500,
    );
    expect(view.y + (arrival.y + arrival.height / 2) * view.zoom).toBeCloseTo(
      300,
    );
  });

  it("puts the arrival table's middle in the pane's middle for a model that fits", () => {
    const bounds = { x: 24, y: 24, width: 400, height: 200 };
    const arrival = { x: 200, y: 100, width: 232, height: 120 };
    const view = viewport(bounds, pane, arrival);
    expect(view.x + (arrival.x + arrival.width / 2) * view.zoom).toBeCloseTo(
      500,
    );
    expect(view.y + (arrival.y + arrival.height / 2) * view.zoom).toBeCloseTo(
      300,
    );
  });
});

describe("keepVisible", () => {
  it("pans only enough to show the selected table and keeps the zoom", () => {
    const view = { x: -180, y: -900, zoom: 0.75 };
    const rect = { x: 200, y: 1100, width: WIDTH, height: 120 };
    const next = keepVisible(view, rect, pane);
    expect(next).toEqual({ x: -118, y: -793, zoom: 0.75 });
    expect(next.zoom).toBe(view.zoom);
  });

  it("leaves an already visible table and viewport untouched", () => {
    const view = { x: 100, y: 100, zoom: 0.8 };
    expect(
      keepVisible(view, { x: 100, y: 100, width: WIDTH, height: 120 }, pane),
    ).toEqual(view);
  });
});

describe("focusOn", () => {
  it("brings a table to the middle of the pane at the search zoom", () => {
    const rect = { x: 800, y: 400, width: WIDTH, height: 120 };
    const next = focusOn({ x: 0, y: 0, zoom: 0.5 }, rect, pane);
    expect(next.zoom).toBe(FOCUS_ZOOM);
    expect(next.x + (rect.x + rect.width / 2) * next.zoom).toBe(pane.width / 2);
    expect(next.y + (rect.y + rect.height / 2) * next.zoom).toBe(
      pane.height / 2,
    );
  });

  it("keeps a closer zoom the person chose", () => {
    const rect = { x: 0, y: 0, width: WIDTH, height: 120 };
    expect(focusOn({ x: 0, y: 0, zoom: 1.4 }, rect, pane).zoom).toBe(1.4);
  });

  it("shows a table too tall for the pane from its head", () => {
    const rect = { x: 0, y: 300, width: WIDTH, height: pane.height * 2 };
    const next = focusOn({ x: 0, y: 0, zoom: 0.5 }, rect, pane);
    expect(next.y + rect.y * next.zoom).toBe(32);
  });
});

describe("rowsFor", () => {
  const sales = model.tables[0] as DiagramTable;
  const keys = keysOf(model).get("Sales") ?? new Set<string>();

  it("keys only: the columns at the end of a relationship, in the table's order", () => {
    const { rows, foot } = rowsFor(sales, keys, "keys");
    expect(rows.map((r) => r.name)).toEqual(["ProductKey", "DateKey"]);
    expect(rows.every((r) => r.key)).toBe(true);
    expect(rows[0]?.hidden).toBe(true);
    expect(foot).toBe("2 more columns, 2 measures");
  });

  it("all: every column, the key ones marked", () => {
    const { rows, foot } = rowsFor(sales, keys, "all");
    expect(rows.map((r) => [r.name, r.key])).toEqual([
      ["Id", false],
      ["ProductKey", true],
      ["Qty", false],
      ["DateKey", true],
    ]);
    expect(foot).toBe("2 measures");
  });

  it("words the foot for the other cases", () => {
    const none = new Set<string>();
    expect(rowsFor(table("T", ["A", "B"], 1), none, "keys").foot).toBe(
      "2 columns, 1 measure",
    );
    expect(rowsFor(table("T", ["A", "B"]), new Set(["A"]), "keys").foot).toBe(
      "1 more column",
    );
    expect(rowsFor(table("T", [], 3), none, "all").foot).toBe(
      "3 measures, no columns",
    );
    expect(rowsFor(table("T", []), none, "all").foot).toBeNull();
    expect(rowsFor(table("T", ["A"]), none, "all").foot).toBeNull();
  });
});

describe("layout", () => {
  it("gives the same positions when laid out twice", () => {
    const first = layout(model, "keys").map((p) => [p.table.name, p.x, p.y]);
    const second = layout(model, "keys").map((p) => [p.table.name, p.x, p.y]);
    expect(second).toEqual(first);
  });

  it("puts the facts left of the tables they look up", () => {
    const at = new Map(layout(model, "keys").map((p) => [p.table.name, p]));
    expect(at.get("Sales")?.x).toBeLessThan(at.get("Product")?.x ?? 0);
    expect(at.get("Sales")?.x).toBeLessThan(at.get("Date")?.x ?? 0);
  });

  it("lists the tables in reading order", () => {
    const placed = layout(model, "keys");
    const order = placed.map((p) => [p.x, p.y]);
    expect(order).toEqual(
      [...order].sort(
        (a, b) => (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0),
      ),
    );
  });

  it("sizes a table from its header, rows and foot", () => {
    const sales = layout(model, "keys").find((p) => p.table.name === "Sales");
    expect(sales?.height).toBe(HEAD + 2 * ROW + FOOT + 2);
    const date = layout(
      { tables: [table("D", ["A"])], relationships: [], unknown: null },
      "all",
    )[0];
    expect(date?.height).toBe(HEAD + ROW + 2);
  });
});

describe("grid", () => {
  it("places 5 tables in 2 rows of 3 and 2", () => {
    const tables = ["A", "B", "C", "D", "E"].map((n) =>
      table(n, ["X", "Y"], 1),
    );
    const placed = grid(
      { tables, relationships: [], unknown: "Not known." },
      "all",
    );
    expect(new Set(placed.map((p) => p.y)).size).toBe(2);
    expect(placed.filter((p) => p.y === placed[0]?.y)).toHaveLength(3);
    expect(placed[1]?.x).toBe((placed[0]?.x ?? 0) + WIDTH + 40);
    const tallest = Math.max(...placed.slice(0, 3).map((p) => p.height));
    expect(placed[3]?.y).toBe((placed[0]?.y ?? 0) + tallest + 24);
  });
});

describe("ends", () => {
  it("reads each API cardinality spelling", () => {
    expect(ends("many_to_one")).toEqual(["many", "one"]);
    expect(ends("one_to_many")).toEqual(["one", "many"]);
    expect(ends("one_to_one")).toEqual(["one", "one"]);
    expect(ends("many_to_many")).toEqual(["many", "many"]);
    expect(ends(null)).toEqual(["one", "one"]);
  });

  it("words cardinality and identifies the one side as the filtering table", () => {
    expect(cardinalityLabel("one_to_many")).toBe("One to many");
    expect(filteringTable("Dimension", "Fact", "one_to_many")).toEqual([
      "Dimension",
      "Fact",
    ]);
    expect(filteringTable("Fact", "Dimension", "many_to_one")).toEqual([
      "Dimension",
      "Fact",
    ]);
  });
});
