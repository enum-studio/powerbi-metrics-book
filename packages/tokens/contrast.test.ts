/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const TEXT_FLOOR = 4.5;
const CONTROL_FLOOR = 3;

const GROUNDS = ["--bg", "--surface", "--raised", "--canvas", "--accent-soft"];
const CONTROL_GROUNDS = ["--bg", "--surface", "--raised", "--canvas"];
const TEXT_ON_GROUNDS = ["--ink", "--ink-2", "--ink-3", "--accent", "--out"];

const ICON_COLORS = [
  "gray",
  "green",
  "teal",
  "blue",
  "violet",
  "red",
  "amber",
  "ink",
];

type Theme = Map<string, string>;
type Pair = { fg: string; bg: string; floor: number };

const PAIRS: Pair[] = [
  ...TEXT_ON_GROUNDS.flatMap((fg) =>
    GROUNDS.map((bg) => ({ fg, bg, floor: TEXT_FLOOR })),
  ),
  { fg: "--on-accent", bg: "--accent", floor: TEXT_FLOOR },
  { fg: "--on-accent", bg: "--accent-hover", floor: TEXT_FLOOR },
  ...ICON_COLORS.map((fg) => ({
    fg: `--icon-${fg}`,
    bg: "--surface",
    floor: CONTROL_FLOOR,
  })),
  ...CONTROL_GROUNDS.map((bg) => ({
    fg: "--line-control",
    bg,
    floor: CONTROL_FLOOR,
  })),
];

const css = readFileSync(
  new URL("./tokens.css", import.meta.url),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

function declarations(selector: string): Theme {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`tokens.css has no block for ${selector}`);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  return new Map(
    [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [
      m[1],
      m[2].replace(/\s+/g, " ").trim(),
    ]),
  );
}

const DARK_QUERY = "(prefers-color-scheme: dark)";
const DARK_BY_MEDIA = ':root:not([data-theme="light"])';
const DARK_BY_ATTRIBUTE = ':root[data-theme="dark"]';

const light = declarations(":root");
const darkByMedia = declarations(DARK_BY_MEDIA);
const darkByAttribute = declarations(DARK_BY_ATTRIBUTE);

function mediaBlocks(source: string) {
  return [...source.matchAll(/@media\s*([^{]+)\{/g)].map((opening) => {
    const bodyStart = opening.index + opening[0].length;
    let depth = 1;
    let end = bodyStart;
    while (depth > 0 && end < source.length) {
      const char = source[end++];
      if (char === "{") depth++;
      else if (char === "}") depth--;
    }
    return {
      query: opening[1].replace(/\s+/g, " ").trim(),
      body: source.slice(bodyStart, end - 1),
      text: source.slice(opening.index, end),
    };
  });
}

const isColour = (value: string) =>
  value.includes("#") || value.includes("rgba(");

function rgb(value: string, name: string): number[] {
  if (!/^#[0-9a-f]{6}$/i.test(value))
    throw new Error(`${name} is ${value}, not a six-digit hex`);
  const n = Number.parseInt(value.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

function luminance(value: string, name: string): number {
  const [r, g, b] = rgb(value, name).map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(theme: Theme, fg: string, bg: string): number {
  const colours = [fg, bg].map((name) => {
    const value = theme.get(name);
    if (value === undefined)
      throw new Error(`${name} is not defined in this theme`);
    return luminance(value, name);
  });
  return (Math.max(...colours) + 0.05) / (Math.min(...colours) + 0.05);
}

function failingPairs(theme: Theme, pairs: Pair[]): string[] {
  return pairs.flatMap(({ fg, bg, floor }) => {
    const measured = ratio(theme, fg, bg);
    return measured >= floor
      ? []
      : [
          `${fg} on ${bg}: ${measured.toFixed(2)}:1, needs ${floor.toFixed(1)}:1`,
        ];
  });
}

describe("contrast", () => {
  const themes: [string, Theme][] = [
    ["light", light],
    ["dark by prefers-color-scheme", new Map([...light, ...darkByMedia])],
    ["dark by data-theme", new Map([...light, ...darkByAttribute])],
  ];

  it.each(themes)("every text pair holds in %s", (_name, theme) => {
    expect(failingPairs(theme, PAIRS)).toEqual([]);
  });

  it("names the pair and the ratio of a low-contrast pair", () => {
    const lowContrast: Pair = {
      fg: "--line",
      bg: "--surface",
      floor: TEXT_FLOOR,
    };
    expect(failingPairs(light, [lowContrast])).toEqual([
      "--line on --surface: 1.35:1, needs 4.5:1",
    ]);
  });
});

describe("dark selectors", () => {
  const blocks = mediaBlocks(css);
  const topLevel = blocks.reduce(
    (rest, { text }) => rest.replace(text, ""),
    css,
  );

  it("has one media query, and it asks for a dark system theme", () => {
    expect(blocks.map(({ query }) => query)).toEqual([DARK_QUERY]);
  });

  it("puts the guarded :root block inside that query and nowhere else", () => {
    expect(blocks[0]?.body).toContain(`${DARK_BY_MEDIA} {`);
    expect(topLevel).not.toContain(DARK_BY_MEDIA);
  });

  it("keeps the data-theme dark block outside the query", () => {
    expect(topLevel).toContain(`${DARK_BY_ATTRIBUTE} {`);
    expect(blocks[0]?.body).not.toContain(DARK_BY_ATTRIBUTE);
  });
});

describe("dark values", () => {
  it("are the same in the media query and under data-theme", () => {
    expect(Object.fromEntries(darkByMedia)).toEqual(
      Object.fromEntries(darkByAttribute),
    );
  });

  it("cover every colour token and add no token of their own", () => {
    const colourTokens = [...light]
      .filter(([, value]) => isColour(value))
      .map(([name]) => name);
    expect(colourTokens.filter((name) => !darkByMedia.has(name))).toEqual([]);
    expect(
      [...darkByMedia.keys()].filter((name) => !colourTokens.includes(name)),
    ).toEqual([]);
  });
});
