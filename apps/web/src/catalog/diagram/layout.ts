import dagre from "@dagrejs/dagre";
import { plural } from "../../shell/plural";
import type { Density, DiagramModel, DiagramTable } from "./model";

export const WIDTH = 232;
export const HEAD = 40;
export const ROW = 24;
export const FOOT = 26;
/** The table box's own border, top and bottom. */
const BORDER = 2;
const GRID_COLUMNS = 3;
const GRID_GAP = 40;
const GRID_MARGIN = 24;
const PANE_PADDING = 32;

export type Row = {
  name: string;
  type: string | null;
  key: boolean;
  hidden: boolean;
};
export type Placed = {
  table: DiagramTable;
  rows: Row[];
  /** "N more columns, M measures" and its variants; null when there is neither. */
  foot: string | null;
  x: number;
  y: number;
  height: number;
};
export type Rect = { x: number; y: number; width: number; height: number };
export type View = { x: number; y: number; zoom: number };

/** The columns at either end of a relationship, per table. */
export function keysOf(model: DiagramModel): Map<string, Set<string>> {
  const keys = new Map<string, Set<string>>();
  const add = (table: string, column: string) => {
    const set = keys.get(table) ?? new Set<string>();
    keys.set(table, set.add(column));
  };
  for (const r of model.relationships) {
    add(r.from_table, r.from_column);
    add(r.to_table, r.to_column);
  }
  return keys;
}

export function rowsFor(
  table: DiagramTable,
  keys: ReadonlySet<string>,
  density: Density,
): { rows: Row[]; foot: string | null } {
  const all = table.columns.map((c) => ({
    name: c.name,
    type: c.type,
    key: keys.has(c.name),
    hidden: c.hidden,
  }));
  const rows = density === "all" ? all : all.filter((r) => r.key);
  const more = all.length - rows.length;
  const parts: string[] = [];
  if (more > 0)
    parts.push(plural(more, rows.length > 0 ? "more column" : "column"));
  if (table.measures.length > 0)
    parts.push(plural(table.measures.length, "measure"));
  if (table.columns.length === 0 && table.measures.length > 0)
    parts.push("no columns");
  return { rows, foot: parts.length > 0 ? parts.join(", ") : null };
}

function heightOf(rows: number, foot: string | null): number {
  return HEAD + rows * ROW + (foot === null ? 0 : FOOT) + BORDER;
}

function size(
  table: DiagramTable,
  keys: ReadonlySet<string>,
  density: Density,
) {
  const { rows, foot } = rowsFor(table, keys, density);
  return { table, rows, foot, height: heightOf(rows.length, foot) };
}

/** Facts on the left, the tables they look up to their right, as dagre ranks a many to one graph. */
export function layout(model: DiagramModel, density: Density): Placed[] {
  const keys = keysOf(model);
  const sized = model.tables.map((t) =>
    size(t, keys.get(t.name) ?? new Set(), density),
  );
  const joins = (name: string) =>
    model.relationships.filter(
      (r) => r.from_table === name || r.to_table === name,
    ).length;

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: "LR",
    nodesep: 28,
    ranksep: 120,
    marginx: 24,
    marginy: 24,
  });
  const mostJoinedFirst = [...sized].sort(
    (a, b) => joins(b.table.name) - joins(a.table.name),
  );
  for (const s of mostJoinedFirst)
    g.setNode(s.table.name, { width: WIDTH, height: s.height });
  for (const r of model.relationships) g.setEdge(r.from_table, r.to_table);
  dagre.layout(g);

  const placed = sized.map((s) => {
    const at = g.node(s.table.name);
    return { ...s, x: at.x - WIDTH / 2, y: at.y - s.height / 2 };
  });
  // Reading order, which is the order the tables take focus in: by rank, then down the rank.
  return placed.sort((a, b) => a.x - b.x || a.y - b.y);
}

/** No relationships to rank by: the tables in a grid, in the model's order, so none looks joined. */
export function grid(model: DiagramModel, density: Density): Placed[] {
  const sized = model.tables.map((t) => size(t, new Set(), density));
  const placed: Placed[] = [];
  let y = GRID_MARGIN;
  for (let start = 0; start < sized.length; start += GRID_COLUMNS) {
    const line = sized.slice(start, start + GRID_COLUMNS);
    line.forEach((s, i) => {
      placed.push({ ...s, x: GRID_MARGIN + i * (WIDTH + GRID_GAP), y });
    });
    y += Math.max(...line.map((s) => s.height)) + GRID_MARGIN;
  }
  return placed;
}

export function boundsOf(placed: readonly Placed[]): Rect {
  const minX = Math.min(...placed.map((p) => p.x));
  const minY = Math.min(...placed.map((p) => p.y));
  const maxX = Math.max(...placed.map((p) => p.x + WIDTH));
  const maxY = Math.max(...placed.map((p) => p.y + p.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

type End = "many" | "one";

/** Cardinalities name the from end, then the to end, as the API sends them. */
export function ends(cardinality: string | null): [End, End] {
  const match = /^(one|many)_to_(one|many)$/.exec(cardinality ?? "");
  return [
    match?.[1] === "many" ? "many" : "one",
    match?.[2] === "many" ? "many" : "one",
  ];
}

export function cardinalityLabel(cardinality: string | null): string {
  const [from, to] = ends(cardinality);
  return `${from === "many" ? "Many" : "One"} to ${to === "many" ? "many" : "one"}`;
}

export function filteringTable(
  fromTable: string,
  toTable: string,
  cardinality: string | null,
): [filtering: string, filtered: string] {
  const [from, to] = ends(cardinality);
  // The one side filters the many side. For equal cardinalities, preserve
  // Power BI's from-to direction as the useful default.
  return from === "one" && to === "many"
    ? [fromTable, toTable]
    : [toTable, fromTable];
}

/** Whether the model, fitted to the pane, is taller than the pane. */
export function overflows(
  bounds: Rect,
  pane: { width: number; height: number },
): boolean {
  return bounds.height * fit(bounds, pane) + 2 * PANE_PADDING > pane.height;
}

function fit(bounds: Rect, pane: { width: number; height: number }): number {
  const pad = 2 * PANE_PADDING;
  return Math.max(
    0.6,
    Math.min(
      1,
      (pane.width - pad) / bounds.width,
      (pane.height - pad) / bounds.height,
    ),
  );
}

/**
 * Read like a page: as wide as the pane allows, never above 100%, and no
 * smaller than 60% (the [0.6, 1] bounds). With an arrival table, that table's
 * middle is in the pane's middle, both ways. Without one, a model that fits
 * is centred and a taller one starts at the top.
 */
export function viewport(
  bounds: Rect,
  pane: { width: number; height: number },
  arrival?: Rect,
): View {
  const zoom = fit(bounds, pane);
  if (arrival !== undefined) {
    if (bounds.width * zoom + 2 * PANE_PADDING > pane.width) {
      const leftAligned = {
        x: PANE_PADDING - bounds.x * zoom,
        y: overflows(bounds, pane)
          ? PANE_PADDING - bounds.y * zoom
          : (pane.height - bounds.height * zoom) / 2 - bounds.y * zoom,
        zoom,
      };
      return keepVisible(leftAligned, arrival, pane);
    }
    return {
      x: pane.width / 2 - (arrival.x + arrival.width / 2) * zoom,
      y: pane.height / 2 - (arrival.y + arrival.height / 2) * zoom,
      zoom,
    };
  }
  const x =
    bounds.width * zoom + 2 * PANE_PADDING > pane.width
      ? PANE_PADDING - bounds.x * zoom
      : (pane.width - bounds.width * zoom) / 2 - bounds.x * zoom;
  const y = overflows(bounds, pane)
    ? PANE_PADDING - bounds.y * zoom
    : (pane.height - bounds.height * zoom) / 2 - bounds.y * zoom;
  return { x, y, zoom };
}

/** Pan only enough to leave a selected table inside the pane's padded bounds. */
export function keepVisible(
  view: View,
  rect: Rect,
  pane: { width: number; height: number },
): View {
  const padding = PANE_PADDING;
  const left = view.x + rect.x * view.zoom;
  const right = left + rect.width * view.zoom;
  const top = view.y + rect.y * view.zoom;
  const bottom = top + rect.height * view.zoom;
  const x =
    left < padding
      ? view.x + padding - left
      : right > pane.width - padding
        ? view.x - (right - pane.width + padding)
        : view.x;
  const y =
    top < padding
      ? view.y + padding - top
      : bottom > pane.height - padding
        ? view.y - (bottom - pane.height + padding)
        : view.y;
  return { x, y, zoom: view.zoom };
}

/** The zoom a table found by search is shown at, unless the view is already closer. */
export const FOCUS_ZOOM = 1;

/**
 * Bring a table found by search to the middle of the pane, at FOCUS_ZOOM or
 * closer. A table too tall to fit shows from its head.
 */
export function focusOn(
  view: View,
  rect: Rect,
  pane: { width: number; height: number },
): View {
  const zoom = Math.max(view.zoom, FOCUS_ZOOM);
  const x = pane.width / 2 - (rect.x + rect.width / 2) * zoom;
  const y =
    rect.height * zoom + 2 * PANE_PADDING > pane.height
      ? PANE_PADDING - rect.y * zoom
      : pane.height / 2 - (rect.y + rect.height / 2) * zoom;
  return { x, y, zoom };
}
