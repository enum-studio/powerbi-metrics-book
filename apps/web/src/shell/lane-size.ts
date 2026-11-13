import { typingIn } from "./keys";
import { type StorageHost, unlessRefused } from "./storage";

/** The shell widths the first lane's size is worked out from, in pixels, read from the tokens. */
export type LaneTokens = {
  width: number;
  min: number;
  max: number;
  pageMin: number;
  secondLane: number;
};

/** How narrow and how wide the first lane may be dragged at this window's width. */
export type LaneBounds = { min: number; max: number };

/** What a person chose for the first lane in this browser. A width of null is the token's own. */
export type LaneChoice = { width: number | null; hidden: boolean };

const TOKENS = {
  width: "--tree-width",
  min: "--tree-width-min",
  max: "--tree-width-max",
  pageMin: "--page-min",
  secondLane: "--rail-width",
} as const satisfies Record<keyof LaneTokens, string>;

/** Reads the shell widths from the root's computed style. A token that is missing or not in pixels is a bug in the tokens, and throws. */
export function readLaneTokens(
  style: Pick<CSSStyleDeclaration, "getPropertyValue">,
): LaneTokens {
  const pixels = (name: string) => {
    const value = style.getPropertyValue(name).trim();
    const match = /^(\d+)px$/.exec(value);
    if (match === null)
      throw new Error(`The token ${name} is "${value}", not a width in px.`);
    return Number(match[1]);
  };
  return {
    width: pixels(TOKENS.width),
    min: pixels(TOKENS.min),
    max: pixels(TOKENS.max),
    pageMin: pixels(TOKENS.pageMin),
    secondLane: pixels(TOKENS.secondLane),
  };
}

/** The tokens' limits, with the widest narrowed so the page keeps --page-min beside the lanes; never under the narrowest. */
export function laneBounds(
  tokens: LaneTokens,
  viewport: number,
  secondLane: boolean,
): LaneBounds {
  const room = viewport - tokens.pageMin - (secondLane ? tokens.secondLane : 0);
  return {
    min: tokens.min,
    max: Math.max(tokens.min, Math.min(tokens.max, room)),
  };
}

export function clampWidth(width: number, bounds: LaneBounds): number {
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, width)));
}

/** Where a drag of the lane's edge leaves it. Let go under half the narrowest width and the lane hides, as Secoda's does. */
export function draggedTo(
  width: number,
  bounds: LaneBounds,
): { hidden: true } | { hidden: false; width: number } {
  if (width < bounds.min / 2) return { hidden: true };
  return { hidden: false, width: clampWidth(width, bounds) };
}

/** One arrow key's step, on the 4px grid. */
export const KEY_STEP = 16;

/** The width a key on the lane's edge moves it to, as a window splitter's keys do; null for any other key. */
export function keyedTo(
  key: string,
  width: number,
  bounds: LaneBounds,
): number | null {
  switch (key) {
    case "ArrowLeft":
      return clampWidth(width - KEY_STEP, bounds);
    case "ArrowRight":
      return clampWidth(width + KEY_STEP, bounds);
    case "Home":
      return bounds.min;
    case "End":
      return bounds.max;
    default:
      return null;
  }
}

/**
 * The shortcut that hides and shows the lane: `[`, as in Secoda and Linear.
 * Cmd+[ and Ctrl+[ stay the browser's, and a key typed in a field is text.
 * On a Danish or German Windows keyboard `[` is typed with AltGr, which the
 * browser reports as Ctrl+Alt, so Ctrl with Alt is still the shortcut.
 */
export const LANE_SHORTCUT = "[";

export function isLaneShortcut(
  event: Pick<
    KeyboardEvent,
    "key" | "metaKey" | "ctrlKey" | "altKey" | "target"
  >,
): boolean {
  const altGr = event.ctrlKey && event.altKey;
  return (
    event.key === LANE_SHORTCUT &&
    !event.metaKey &&
    (!event.ctrlKey || altGr) &&
    !typingIn(event.target)
  );
}

/** Kept per browser rather than per person: the width suits the screen, not the account. */
const WIDTH_KEY = "pbmb.sidebar.width";
const HIDDEN_KEY = "pbmb.sidebar.hidden";

/** The choice kept in this browser; with storage refused, or nothing kept, the lane shows at the token's width. */
export function restoreLane(host: StorageHost): LaneChoice {
  const width = unlessRefused(() => host.storage().getItem(WIDTH_KEY));
  const hidden = unlessRefused(() => host.storage().getItem(HIDDEN_KEY));
  const pixels = width === null ? NaN : Number(width);
  return {
    width: Number.isInteger(pixels) && pixels > 0 ? pixels : null,
    hidden: hidden === "true",
  };
}

/** Keeps the choice for the next page load; where storage is refused it lasts for this page. */
export function keepLane(host: StorageHost, choice: LaneChoice): void {
  unlessRefused(() => {
    const storage = host.storage();
    if (choice.width !== null) storage.setItem(WIDTH_KEY, String(choice.width));
    storage.setItem(HIDDEN_KEY, String(choice.hidden));
  });
}
