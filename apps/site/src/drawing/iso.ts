// Isometric drawing in SVG: a point on the plane at height z lands at
// ((x - y) * COS, (x + y) * SIN - z) on screen. Every shape carries a class
// and no colour, so the page's CSS colours it from the tokens.

export const COS = 0.8660254;
export const SIN = 0.5;

export type Point = readonly [number, number];

const round = (n: number) => Math.round(n * 10) / 10;

export const point = (x: number, y: number, z: number): Point => [
  round((x - y) * COS),
  round((x + y) * SIN - z),
];

const points = (list: readonly Point[]) =>
  list.map((p) => p.join(",")).join(" ");

export const polygon = (list: readonly Point[], cls: string) =>
  `<polygon class="${cls}" points="${points(list)}"/>`;

export const polyline = (list: readonly Point[], cls: string) =>
  `<polyline class="${cls}" points="${points(list)}"/>`;

// One element: its attributes, and what it holds if anything.
export function el(
  tag: string,
  attributes: Record<string, string | number>,
  inner = "",
): string {
  const list = Object.entries(attributes)
    .map(([name, value]) => `${name}="${String(value)}"`)
    .join(" ");
  return inner ? `<${tag} ${list}>${inner}</${tag}>` : `<${tag} ${list}/>`;
}

const matrix = (...values: number[]) => `matrix(${values.join(",")})`;

export const path = (list: readonly Point[]) =>
  `M${list.map((p) => p.join(" ")).join(" L")}`;

export const group = (cls: string, parts: readonly string[], attrs = "") =>
  `<g class="${cls}"${attrs}>${parts.join("")}</g>`;

export interface Box {
  x: number;
  y: number;
  w: number;
  d: number;
  z: number;
  h: number;
}

// A box seen from the front: its face at x + w (the right side), its face at
// y + d (the left side) and its top.
export function box(b: Box, top: string, left: string, right = left): string {
  const { x, y, w, d, z, h } = b;
  return [
    polygon(
      [
        point(x + w, y, z + h),
        point(x + w, y + d, z + h),
        point(x + w, y + d, z),
        point(x + w, y, z),
      ],
      right,
    ),
    polygon(
      [
        point(x + w, y + d, z + h),
        point(x, y + d, z + h),
        point(x, y + d, z),
        point(x + w, y + d, z),
      ],
      left,
    ),
    polygon(
      [
        point(x, y, z + h),
        point(x + w, y, z + h),
        point(x + w, y + d, z + h),
        point(x, y + d, z + h),
      ],
      top,
    ),
  ].join("");
}

// A transform that lays local (u, v) on the top face at height z: u runs
// along x, v along y.
export const onTop = (z: number) => matrix(COS, SIN, -COS, SIN, 0, -z);

// A transform that stands local (u, v) on the face at y = y0: u runs along x
// from x0, v runs down from height z.
export const onFace = (x0: number, y0: number, z: number) =>
  matrix(COS, SIN, 0, 1, round((x0 - y0) * COS), round((x0 + y0) * SIN - z));

// A transform that stands local (u, v) on the face at x = x0: u runs back
// along y from y0, v runs down from height z.
export const onSide = (x0: number, y0: number, z: number) =>
  matrix(COS, -SIN, 0, 1, round((x0 - y0) * COS), round((x0 + y0) * SIN - z));

export const text = (
  x: number,
  y: number,
  value: string,
  cls: string,
  size: number,
) => el("text", { class: cls, x, y, "font-size": size }, value);

export const rect = (x: number, y: number, w: number, h: number, cls: string) =>
  el("rect", { class: cls, x, y, width: w, height: h });

// Lines along x and y on the plane at height z, every `step`: a ground that
// may bleed past the viewBox.
export function grid(
  [x0, x1]: readonly [number, number],
  [y0, y1]: readonly [number, number],
  step: number,
  cls: string,
): string {
  const lines: string[] = [];
  for (let x = x0; x <= x1; x += step) {
    lines.push(path([point(x, y0, 0), point(x, y1, 0)]));
  }
  for (let y = y0; y <= y1; y += step) {
    lines.push(path([point(x0, y, 0), point(x1, y, 0)]));
  }
  return el("path", { class: cls, d: lines.join(" ") });
}
