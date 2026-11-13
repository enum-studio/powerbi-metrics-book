// The hero's drawing: Power BI at the bottom, the book in the middle, the
// agents and internal tools on top. Three measures rise into one metric; the
// agents ask it and download the result as a CSV file, and an internal tool
// queries through the same API. `data-step` on a shape names the steps
// of the example run (HeroStack.astro) that light it up.
import {
  box,
  el,
  group,
  onFace,
  onSide,
  onTop,
  path,
  point,
  polyline,
  rect,
  text,
  type Point,
} from "./iso";
import { STOCK_ON_HAND } from "../stock-on-hand";

const SIZE = 260;
const Z = { powerbi: 0, book: 170, agents: 400 };
const BOOK_TOP = Z.book + 24;

const DATASETS = [
  {
    name: "Sales",
    measure: "Net sales",
    u: 10,
    v: 180,
    bars: [12, 18, 9, 22],
    step: "2 3",
  },
  {
    name: "Finance",
    measure: "Revenue",
    u: 96,
    v: 180,
    bars: [16, 10, 20, 13],
    step: "",
  },
  {
    name: "Marketing",
    measure: "Net Sales",
    u: 180,
    v: 96,
    bars: [8, 14, 19, 11],
    step: "",
  },
];
const METRIC = { x: 14, y: 98, w: 146, d: 54 };
const SHEET = { x: 166, y: 26, w: 90, d: 100 };
// The top layer: the agents lie on it as tiles, and the windows stand at its
// back, Claude Code's run on the right edge and an internal tool on the left.
const AGENTS_TOP = Z.agents + 10;
const CHIPS = [
  { name: "Claude Code", x: 4, step: "1 2 3 4" },
  { name: "Codex", x: 89 },
  { name: "Cursor", x: 174 },
];
const CHIP = { y: 196, w: 82, d: 42, h: 7 };
const WINDOW = { x: 44, y: 19, w: 150, d: 5, h: 118 };
const TOOL = { x: 19, y: 32, w: 5, d: 150, h: 118 };
const VIEW = { y: -530, h: 820 };

const step = (on: string | undefined) => (on ? ` data-step="${on}"` : "");

function defs(id: string): string {
  return `<defs>
<pattern id="${id}-grid" patternUnits="userSpaceOnUse" width="34.64" height="20"><path class="grid-line" d="M0 0 L34.64 20 M0 20 L34.64 0"/></pattern>
<pattern id="${id}-hatch" patternUnits="userSpaceOnUse" width="4" height="4" patternTransform="rotate(45)"><rect class="hatch-ground" width="4" height="4"/><line class="hatch-line" x1="0" y1="0" x2="0" y2="4"/></pattern>
<radialGradient id="${id}-glow"><stop offset="0" class="glow-in"/><stop offset="1" class="glow-out"/></radialGradient>
<radialGradient id="${id}-fade" cx="0.42" cy="0.55" r="0.6"><stop offset="0.35" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
<mask id="${id}-mask"><rect x="-240" y="${String(VIEW.y)}" width="780" height="${String(VIEW.h)}" fill="url(#${id}-fade)"/></mask>
</defs>`;
}

const node = (id: string, [cx, cy]: Point, on?: string) =>
  `<g class="node"${step(on)}>${el("circle", { class: "glow", cx, cy, r: 9, fill: `url(#${id}-glow)` })}${el("circle", { class: "dot", cx, cy, r: 2.2 })}</g>`;

// A dotted connector with a pulse that runs along it.
function wire(
  from: Point,
  to: Point,
  cls: string,
  delay: number,
  on?: string,
): string {
  const d = path([from, to]);
  const motion = el("animateMotion", {
    dur: "2.6s",
    begin: `${delay.toFixed(1)}s`,
    repeatCount: "indefinite",
    path: d,
  });
  return `<g class="wire ${cls}"${step(on)}><path class="wire-line" d="${d}"/>${el("circle", { class: "pulse", r: 2.4 }, motion)}</g>`;
}

function powerbi(): string {
  const parts = [
    box({ x: 0, y: 0, w: SIZE, d: SIZE, z: Z.powerbi, h: 10 }, "plane", "side"),
  ];
  parts.push(
    `<g transform="${onFace(0, SIZE, Z.powerbi + 10)}">${text(12, 8, "POWER BI", "face-label", 9.5)}</g>`,
  );
  for (const set of DATASETS) {
    const z = Z.powerbi + 18;
    const tile = [
      box(
        { x: set.u, y: set.v, w: 82, d: 60, z: Z.powerbi + 10, h: 8 },
        "tile-top",
        "tile-side",
      ),
    ];
    tile.push(
      `<g transform="${onTop(z)}">${text(set.u + 8, set.v + 40, set.name, "tile-name", 12)}${text(set.u + 8, set.v + 53, set.measure, "mono", 10.5)}</g>`,
    );
    set.bars.forEach((height, i) => {
      tile.push(
        box(
          { x: set.u + 10 + i * 15, y: set.v + 8, w: 9, d: 9, z, h: height },
          i === 3 ? "bar-top on-bar" : "bar-top",
          i === 3 ? "bar-side on-bar" : "bar-side",
          i === 3 ? "bar-right on-bar" : "bar-right",
        ),
      );
    });
    parts.push(group("tile", tile, step(set.step)));
  }
  return group("layer", parts, ` style="--i:0" data-layer="powerbi"`);
}

function book(): string {
  const parts = [
    box(
      { x: 0, y: 0, w: SIZE, d: SIZE, z: Z.book, h: 24 },
      "book-top",
      "book-left",
      "book-right",
    ),
    polyline(
      [
        point(0, SIZE, BOOK_TOP),
        point(SIZE, SIZE, BOOK_TOP),
        point(SIZE, 0, BOOK_TOP),
      ],
      "book-edge",
    ),
    `<g transform="${onFace(0, SIZE, BOOK_TOP)}">${text(14, 16, "POWER BI METRICS BOOK", "book-label", 11)}</g>`,
  ];

  const m = METRIC;
  const metric = [box({ ...m, z: BOOK_TOP, h: 8 }, "chip-top", "chip-side")];
  metric.push(
    `<g transform="${onTop(BOOK_TOP + 8)}">${text(m.x + 10, m.y + 21, "net_sales", "chip-name", 13)}${text(m.x + 10, m.y + 36, "3 measures, 11 variants", "mono", 10)}</g>`,
  );
  parts.push(group("metric", metric, step("1 2")));

  const s = SHEET;
  const sheet = [box({ ...s, z: BOOK_TOP, h: 3 }, "sheet-top", "sheet-side")];
  const cells = [
    text(s.x + 8, s.y + 14, "CSV", "sheet-kind", 9),
    text(s.x + 8, s.y + 27, "net_sales_by_", "sheet-name", 9),
    text(s.x + 8, s.y + 37, "month_2025.csv", "sheet-name", 9),
    rect(s.x + 8, s.y + 45, 74, 5, "cell-head"),
  ];
  for (let row = 0; row < 6; row++) {
    const y = s.y + 54 + row * 7;
    cells.push(
      rect(s.x + 8, y, 18, 4, "cell"),
      rect(s.x + 30, y, 22 + ((row * 7) % 20), 4, "cell"),
    );
  }
  sheet.push(`<g transform="${onTop(BOOK_TOP + 3)}">${cells.join("")}</g>`);
  parts.push(group("sheet", sheet, step("4")));

  return group("layer", parts, ` style="--i:1" data-layer="book"`);
}

const windowBar = (w: number) =>
  `${rect(0, 0, w, 11, "panel-bar")}<circle class="panel-dot" cx="6" cy="5.5" r="1.5"/><circle class="panel-dot" cx="11" cy="5.5" r="1.5"/><circle class="panel-dot" cx="16" cy="5.5" r="1.5"/>`;

// The agent's window: the question and the tools it calls.
function claudeWindow(): string {
  const { x, y, w, d, h } = WINDOW;
  const face = [
    windowBar(w),
    text(8, 31, "Claude Code", "panel-name", 14),
    text(8, 50, "Net sales by month?", "panel-ask", 11.5),
    text(8, 68, "search", "panel-tool", 10.5),
    text(8, 82, "get_metric", "panel-tool", 10.5),
    text(8, 96, "execute_dax", "panel-tool", 10.5),
    rect(8, 105, 70, 4, "panel-line"),
  ];
  return group(
    "panel",
    [
      box(
        { x, y, w, d, z: AGENTS_TOP, h },
        "panel-top",
        "panel-face",
        "panel-side",
      ),
      `<g transform="${onFace(x, y + d, AGENTS_TOP + h)}">${face.join("")}</g>`,
    ],
    step("1 2 3 4"),
  );
}

// An internal tool: a reorder list on the sample tenant's stock, the five
// products with the fewest units on hand, each with its order button.
function reorderList(): string {
  const { x, y, w, d, h } = TOOL;
  const face = [
    windowBar(d),
    text(8, 29, "reorder-list", "mono", 11),
    el(
      "text",
      { class: "mono", x: 84, y: 42, "font-size": 7.5, "text-anchor": "end" },
      "on hand",
    ),
  ];
  STOCK_ON_HAND.forEach(([sku, units], i) => {
    const row = 56 + i * 13;
    const first = i === 0;
    face.push(
      text(8, row, sku, "tool-sku", 9.5),
      el(
        "text",
        {
          class: "tool-units",
          x: 84,
          y: row,
          "font-size": 9.5,
          "text-anchor": "end",
        },
        String(units),
      ),
      rect(92, row - 8, 36, 10.5, first ? "tool-btn on-btn" : "tool-btn"),
      text(
        99,
        row - 0.5,
        "order",
        first ? "tool-btn-text on-btn" : "tool-btn-text",
        8,
      ),
    );
  });
  return group("panel tool", [
    box(
      { x, y, w, d, z: AGENTS_TOP, h },
      "panel-top",
      "panel-side",
      "panel-face",
    ),
    `<g transform="${onSide(x + w, y + d, AGENTS_TOP + h)}">${face.join("")}</g>`,
  ]);
}

function agents(): string {
  const parts = [
    box({ x: 0, y: 0, w: SIZE, d: SIZE, z: Z.agents, h: 10 }, "plane", "side"),
    `<g transform="${onFace(0, SIZE, AGENTS_TOP)}">${text(12, 8, "AGENTS AND INTERNAL TOOLS", "face-label", 9.5)}</g>`,
    reorderList(),
    claudeWindow(),
  ];
  for (const chip of CHIPS) {
    const tile = [
      box(
        {
          x: chip.x,
          y: CHIP.y,
          w: CHIP.w,
          d: CHIP.d,
          z: AGENTS_TOP,
          h: CHIP.h,
        },
        "tile-top",
        "tile-side",
      ),
      `<g transform="${onTop(AGENTS_TOP + CHIP.h)}">${text(chip.x + 8, CHIP.y + 26, chip.name, "tile-name", 11)}</g>`,
    ];
    parts.push(group("tile", tile, step(chip.step)));
  }
  return group("layer", parts, ` style="--i:2" data-layer="agents"`);
}

// The wires under the book, drawn before the book covers their far end, and
// the wires up from it, drawn over the top layer to the shapes they reach.
function wires(id: string): { below: string; above: string } {
  const metricBack = point(METRIC.x + METRIC.w / 2, METRIC.y, BOOK_TOP + 8);
  const below = DATASETS.map((set) => {
    const from = point(set.u + 73, set.v + 14, Z.powerbi + 18);
    const to = point(METRIC.x + METRIC.w / 2, METRIC.y + METRIC.d / 2, Z.book);
    return `${wire(from, to, "rise", 0.4 * DATASETS.indexOf(set), set.step)}${node(id, from, set.step)}`;
  });
  const above = CHIPS.map((chip, i) => {
    const to = point(
      chip.x + CHIP.w - 10,
      CHIP.y + CHIP.d - 8,
      AGENTS_TOP + CHIP.h,
    );
    return `${wire(metricBack, to, "ask", 1.2 + 0.3 * i, chip.step ? "1 2 3" : undefined)}${node(id, to, chip.step)}`;
  });
  const tool = point(TOOL.x + TOOL.w, TOOL.y + TOOL.d - 10, AGENTS_TOP);
  above.push(`${wire(metricBack, tool, "api", 2.1)}${node(id, tool)}`);
  const sheetBack = point(SHEET.x + 40, SHEET.y, BOOK_TOP + 3);
  const windowFoot = point(WINDOW.x + 60, WINDOW.y + WINDOW.d, AGENTS_TOP);
  const download = wire(sheetBack, windowFoot, "download", 2, "4");
  return {
    below: below.join(""),
    above: `${above.join("")}${download}${node(id, metricBack, "1 2")}${node(id, sheetBack, "4")}`,
  };
}

export interface Callout {
  name: string;
  rows: readonly (readonly [string, string])[];
}

export const CALLOUTS: readonly Callout[] = [
  {
    name: "Agents and internal tools",
    rows: [
      ["agents", "ask in plain words, as you"],
      ["tools", "the same DAX, with an API key"],
    ],
  },
  {
    name: "Power BI Metrics Book",
    rows: [
      ["metric", "net_sales, from 3 measures"],
      ["result", "a CSV file, every row"],
    ],
  },
  {
    name: "Power BI",
    rows: [
      ["datasets", "Sales, Finance, Marketing"],
      ["access", "read, never changed"],
    ],
  },
];

// The agents' callout is the example run's card (HeroStack.astro), so the
// drawing only leads a line to where the card sits.
function callouts(): string {
  const heights = [Z.agents, Z.book + 12, Z.powerbi + 5];
  const [cx, cy] = point(SIZE, 0, Z.agents);
  const card = el("line", {
    class: "leader callout card-leader",
    style: "--i:3",
    x1: cx + 6,
    y1: cy,
    x2: cx + 30,
    y2: cy,
  });
  return (
    card +
    CALLOUTS.slice(1)
      .map((callout, index) => {
        const i = index + 1;
        const [x, y] = point(SIZE, 0, heights[i]);
        const rows = callout.rows.map(
          ([key, value], j) =>
            el(
              "text",
              { class: "co-key", x: x + 46, y: y + 23 + j * 18 },
              key,
            ) +
            el(
              "text",
              { class: "co-value", x: x + 116, y: y + 23 + j * 18 },
              value,
            ),
        );
        return group(
          "callout",
          [
            el("line", {
              class: "leader",
              x1: x + 6,
              y1: y,
              x2: x + 38,
              y2: y,
            }),
            el(
              "text",
              { class: "co-title", x: x + 46, y: y + 4 },
              callout.name,
            ),
            ...rows,
          ],
          ` style="--i:${String(3 + i)}"`,
        );
      })
      .join("")
  );
}

const TITLE =
  "Three Power BI measures, Net sales, Revenue and Net Sales, rise into one metric, net_sales, in Power BI Metrics Book. Claude Code, Codex and Cursor ask that metric and download a big result as a CSV file, and an internal reorder list queries stock through the same API.";

export function drawHero(id: string, withCallouts: boolean): string {
  const width = withCallouts ? 780 : 480;
  const viewBox = `-240 ${String(VIEW.y)} ${String(width)} ${String(VIEW.h)}`;
  const { below, above } = wires(id);
  return `<svg class="iso" viewBox="${viewBox}" role="img" aria-label="${TITLE}" style="--hatch:url(#${id}-hatch)">${defs(id)}<rect class="ground" x="-240" y="${String(VIEW.y)}" width="780" height="${String(VIEW.h)}" fill="url(#${id}-grid)" mask="url(#${id}-mask)"/>${powerbi()}${below}${book()}${agents()}${above}${withCallouts ? callouts() : ""}</svg>`;
}
