// The stack on its one VM, and one question's path through it. The
// containers stand on a grid on the VM; Power BI's datasets, the embedding
// provider and the agent are outside it. The traces run on the VM's top
// between the containers' centres. A shape's `data-step` names the steps of
// StackStage.astro that light it up.
import {
  box,
  el,
  grid,
  onFace,
  onTop,
  path,
  point,
  text,
  type Box,
  type Point,
} from "./iso";

const SX = 360;
const SY = 264;
const SLAB = 16;

interface Part {
  name: string;
  note: string;
  box: Box;
  step: string;
  public?: boolean;
}

// A place on the VM's grid, 120 apart.
const at = (col: number, row: number, h: number): Box => ({
  x: 24 + col * 120,
  y: 24 + row * 120,
  z: SLAB,
  w: 76,
  d: 62,
  h,
});

const PARTS = {
  cerbos: {
    name: "Cerbos",
    note: "policy checks",
    box: at(1, 0, 16),
    step: "3",
  },
  worker: {
    name: "worker",
    note: "sync, no port",
    box: at(2, 0, 28),
    step: "1",
  },
  proxy: { name: "proxy", note: "Caddy, TLS", box: at(0, 1, 12), step: "2" },
  api: {
    name: "api",
    note: "MCP, REST, web",
    box: at(1, 1, 34),
    step: "2 3 4 5",
    public: true,
  },
  postgres: {
    name: "Postgres",
    note: "book, results",
    box: at(2, 1, 20),
    step: "1 5",
  },
} satisfies Record<string, Part>;

const TILE = { x: 402, w: 84, d: 28, h: 5 };
const DATASETS = [
  { name: "Sales", y: 22 },
  { name: "Finance", y: 58 },
  { name: "Marketing", y: 94 },
];
const EMBED: Box = { x: 252, y: -74, w: 112, d: 30, z: 0, h: 5 };
const AGENT = { x: 14, y: SY + 110, w: 104, h: 74 };

type Spot = readonly [number, number, number];

const centre = ({ box: b }: Part): Spot => [b.x + b.w / 2, b.y + b.d / 2, SLAB];
const LANE = 115; // between the two rows of containers
const agentX = AGENT.x + AGENT.w / 2;

const TRACES: { step: string; spots: Spot[] }[] = [
  {
    step: "1",
    spots: [centre(PARTS.worker), [SX, 55, SLAB], [TILE.x, 72, 0]],
  },
  {
    step: "1",
    spots: [
      [318, 55, SLAB],
      [318, 0, SLAB],
      [318, EMBED.y + EMBED.d, 0],
    ],
  },
  { step: "1", spots: [centre(PARTS.worker), centre(PARTS.postgres)] },
  {
    step: "2",
    spots: [
      [agentX, AGENT.y, 0],
      [agentX, SY, SLAB],
      centre(PARTS.proxy),
      centre(PARTS.api),
    ],
  },
  { step: "3", spots: [centre(PARTS.api), centre(PARTS.cerbos)] },
  {
    step: "4",
    spots: [
      centre(PARTS.api),
      [182, LANE, SLAB],
      [SX, LANE, SLAB],
      [TILE.x, 108, 0],
    ],
  },
  { step: "5", spots: [centre(PARTS.api), [302, 175, SLAB]] },
];

const step = (on: string) => ` data-step="${on}"`;

// On the VM, or on the ground beyond it.
const onVm = ([, , z]: Spot) => z === SLAB;

// A narrow drawing keeps only the VM: each trace stops at its edge.
function traces(narrow: boolean): string {
  return TRACES.map(({ step: on, spots: all }) => {
    const spots = narrow ? all.filter(onVm) : all;
    const d = path(spots.map(([x, y, z]) => point(x, y, z)));
    const ends = [spots[0], spots[spots.length - 1]].map(([x, y, z]) => {
      const [cx, cy] = point(x, y, z);
      return el("circle", { class: "end", cx, cy, r: 2.6 });
    });
    return `<g class="trace"${step(on)}>${el("path", { class: "under", d })}${el("path", { class: "over", d })}${ends.join("")}</g>`;
  }).join("");
}

function parts(): string {
  return Object.values(PARTS)
    .map((part: Part) => {
      const b = part.box;
      const lid = `<g transform="${onTop(b.z + b.h)}">${text(b.x + 9, b.y + 25, part.name, "name", 13)}${text(b.x + 9, b.y + 42, part.note, "note", 9.5)}</g>`;
      return `<g class="part${part.public ? " public" : ""}"${step(part.step)}>${box(b, "t", "l", "r")}${lid}</g>`;
    })
    .join("");
}

function powerbi(): string {
  const tiles = DATASETS.map(
    (set) =>
      `${box({ ...TILE, y: set.y, z: 0 }, "t", "l", "r")}<g transform="${onTop(TILE.h)}">${text(TILE.x + 9, set.y + 18, set.name, "tile-name", 10.5)}</g>`,
  );
  const label = `<g transform="${onTop(0)}">${text(TILE.x, 142, "your Power BI", "label", 10)}</g>`;
  return `<g class="part outside"${step("1 4")}>${tiles.join("")}${label}</g>`;
}

function embed(): string {
  const name = text(
    EMBED.x + 9,
    EMBED.y + 20,
    "OpenAI or Gemini",
    "tile-name",
    10.5,
  );
  const label = text(EMBED.x, EMBED.y - 9, "embeddings, optional", "label", 10);
  return `<g class="part outside"${step("1")}>${box(EMBED, "t", "l", "r")}<g transform="${onTop(EMBED.h)}">${name}</g><g transform="${onTop(0)}">${label}</g></g>`;
}

function agent(): string {
  const { x, y, w, h } = AGENT;
  const outline = [
    point(x, y, 0),
    point(x + w, y, 0),
    point(x + w, y, h),
    point(x, y, h),
  ];
  const face = [
    el("circle", { class: "dot", cx: x + 9, cy: 9, r: 2 }),
    el("circle", { class: "dot", cx: x + 16, cy: 9, r: 2 }),
    text(x + 24, 12.5, "your agent", "note", 9.5),
    el("line", { class: "rule", x1: x, y1: 18, x2: x + w, y2: 18 }),
    text(x + 9, 36, "Net sales by", "say", 11.5),
    text(x + 9, 50, "month, 2025?", "say", 11.5),
    el("rect", {
      class: "bar-line",
      x: x + 9,
      y: 58,
      width: 64,
      height: 3.5,
      rx: 1.75,
    }),
    el("rect", {
      class: "bar-line",
      x: x + 9,
      y: 65,
      width: 44,
      height: 3.5,
      rx: 1.75,
    }),
  ];
  return `<g class="part outside"${step("2")}><polygon class="panel" points="${outline.map((p) => p.join(",")).join(" ")}"/><g transform="${onFace(0, y, h)}">${face.join("")}</g></g>`;
}

// The viewBox around the drawing's outermost points, with a margin.
function fit(list: readonly Point[], pad: number): string {
  const xs = list.map((p) => p[0]);
  const ys = list.map((p) => p[1]);
  const x0 = Math.floor(Math.min(...xs) - pad);
  const y0 = Math.floor(Math.min(...ys) - pad);
  return [
    x0,
    y0,
    Math.ceil(Math.max(...xs) + pad - x0),
    Math.ceil(Math.max(...ys) + pad - y0),
  ].join(" ");
}

const TITLE =
  "One VM runs the stack: a proxy in front of the api, the worker, Postgres and Cerbos. The worker syncs your Power BI into Postgres and embeds it for search. Your agent asks the api through the proxy, Cerbos decides, and the api queries Power BI as the person asking and keeps the result in Postgres.";

// The wide drawing has everything; the narrow one, for a phone, only the VM
// and its containers, so their names stay readable.
export function drawStack(narrow = false): string {
  const vm = [
    point(0, 0, SLAB),
    point(SX, 0, SLAB),
    point(SX, SY, 0),
    point(0, SY, 0),
  ];
  const viewBox = narrow
    ? fit([...vm, point(144, 24, SLAB + 30)], 6)
    : fit(
        [
          ...vm,
          point(TILE.x + TILE.w, DATASETS[0].y, TILE.h),
          point(TILE.x, 142, 0),
          point(EMBED.x + EMBED.w, EMBED.y, EMBED.h),
          point(EMBED.x, EMBED.y - 20, 0),
          point(AGENT.x, AGENT.y, AGENT.h),
          point(AGENT.x + AGENT.w, AGENT.y, 0),
        ],
        12,
      );
  const ground = grid([-96, SX + 168], [-120, SY + 168], 24, "ground");
  const slab = `<g class="server">${box({ x: 0, y: 0, z: 0, w: SX, d: SY, h: SLAB }, "t", "l", "r")}</g>`;
  const slabLabel = `<g transform="${onFace(0, SY, SLAB)}">${text(112, 11.5, "One VM, one Docker Compose app", "label", 9.5)}</g>`;
  const inside = `${slab}${slabLabel}${traces(narrow)}`;
  const body = narrow
    ? `${inside}${parts()}`
    : `${ground}${embed()}${inside}${powerbi()}${agent()}${parts()}`;
  return `<svg class="iso${narrow ? " narrow" : " wide"}" viewBox="${viewBox}" role="img" aria-label="${TITLE}">${body}</svg>`;
}
