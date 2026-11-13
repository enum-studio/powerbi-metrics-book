// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  draggedTo,
  isLaneShortcut,
  keepLane,
  KEY_STEP,
  keyedTo,
  laneBounds,
  type LaneTokens,
  readLaneTokens,
  restoreLane,
} from "./lane-size";
import type { StorageHost } from "./storage";

const TOKENS: LaneTokens = {
  width: 268,
  min: 240,
  max: 480,
  pageMin: 480,
  secondLane: 220,
};
const BOUNDS = { min: 240, max: 480 };

function host(
  options: { refuse?: boolean; saved?: Record<string, string> } = {},
) {
  const saved = new Map(Object.entries(options.saved ?? {}));
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => void saved.set(key, value),
  };
  const lane: StorageHost = {
    storage:
      options.refuse === true
        ? () => {
            throw new DOMException(
              "The site's data is blocked.",
              "SecurityError",
            );
          }
        : () => storage,
  };
  return { lane, saved };
}

describe("the first lane's tokens", () => {
  it("reads each shell width in pixels", () => {
    const values: Record<string, string> = {
      "--tree-width": "268px",
      "--tree-width-min": " 240px",
      "--tree-width-max": "480px",
      "--page-min": "480px",
      "--rail-width": "220px",
    };
    expect(
      readLaneTokens({ getPropertyValue: (name) => values[name] ?? "" }),
    ).toEqual(TOKENS);
  });

  it("throws on a token that is missing or not in pixels, rather than guess a width", () => {
    expect(() => readLaneTokens({ getPropertyValue: () => "" })).toThrow(
      /--tree-width/,
    );
    expect(() => readLaneTokens({ getPropertyValue: () => "16rem" })).toThrow(
      /not a width in px/,
    );
  });
});

describe("how wide the first lane may be", () => {
  it("runs from the narrowest token to the widest on a wide screen", () => {
    expect(laneBounds(TOKENS, 1440, false)).toEqual({ min: 240, max: 480 });
    expect(laneBounds(TOKENS, 1440, true)).toEqual({ min: 240, max: 480 });
  });

  it("leaves the page --page-min beside the lanes on a narrow one", () => {
    expect(laneBounds(TOKENS, 1024, false)).toEqual({ min: 240, max: 480 });
    expect(laneBounds(TOKENS, 1024, true)).toEqual({ min: 240, max: 324 });
  });

  it("never narrows the widest under the narrowest", () => {
    expect(laneBounds(TOKENS, 800, true)).toEqual({ min: 240, max: 240 });
  });
});

describe("dragging the lane's edge", () => {
  it("follows the pointer between the limits, in whole pixels", () => {
    expect(draggedTo(300.6, BOUNDS)).toEqual({ hidden: false, width: 301 });
    expect(draggedTo(900, BOUNDS)).toEqual({ hidden: false, width: 480 });
    expect(draggedTo(150, BOUNDS)).toEqual({ hidden: false, width: 240 });
  });

  it("hides the lane when let go under half the narrowest width", () => {
    expect(draggedTo(120, BOUNDS)).toEqual({ hidden: false, width: 240 });
    expect(draggedTo(119, BOUNDS)).toEqual({ hidden: true });
    expect(draggedTo(-40, BOUNDS)).toEqual({ hidden: true });
  });
});

describe("the lane's edge by keyboard", () => {
  it("steps with the arrow keys and stops at the limits", () => {
    expect(keyedTo("ArrowRight", 268, BOUNDS)).toBe(268 + KEY_STEP);
    expect(keyedTo("ArrowLeft", 268, BOUNDS)).toBe(268 - KEY_STEP);
    expect(keyedTo("ArrowLeft", 248, BOUNDS)).toBe(240);
    expect(keyedTo("ArrowRight", 470, BOUNDS)).toBe(480);
  });

  it("goes to the narrowest with Home and the widest with End", () => {
    expect(keyedTo("Home", 300, BOUNDS)).toBe(240);
    expect(keyedTo("End", 300, BOUNDS)).toBe(480);
  });

  it("leaves every other key alone", () => {
    expect(keyedTo("ArrowUp", 300, BOUNDS)).toBeNull();
    expect(keyedTo("Enter", 300, BOUNDS)).toBeNull();
  });
});

describe("the shortcut that hides and shows the lane", () => {
  const press = (
    key: string,
    options: {
      metaKey?: boolean;
      ctrlKey?: boolean;
      altKey?: boolean;
      target?: EventTarget;
    } = {},
  ) =>
    isLaneShortcut({
      key,
      metaKey: options.metaKey ?? false,
      ctrlKey: options.ctrlKey ?? false,
      altKey: options.altKey ?? false,
      target: options.target ?? document.body,
    });

  it("is [ alone", () => {
    expect(press("[")).toBe(true);
    expect(press("]")).toBe(false);
    expect(press("b")).toBe(false);
  });

  it("leaves Cmd+[ and Ctrl+[ to the browser", () => {
    expect(press("[", { metaKey: true })).toBe(false);
    expect(press("[", { ctrlKey: true })).toBe(false);
  });

  it("is [ typed with AltGr, which the browser reports as Ctrl+Alt, on a Danish or German Windows keyboard", () => {
    expect(press("[", { ctrlKey: true, altKey: true })).toBe(true);
    expect(press("[", { altKey: true })).toBe(true);
    expect(press("[", { metaKey: true, altKey: true })).toBe(false);
  });

  it("is text in a field, with AltGr too", () => {
    const field = document.createElement("input");
    document.body.append(field);
    expect(press("[", { ctrlKey: true, altKey: true, target: field })).toBe(
      false,
    );
    field.remove();
  });

  it("is text in a field", () => {
    for (const tag of ["input", "textarea", "select"]) {
      const field = document.createElement(tag);
      document.body.append(field);
      expect(press("[", { target: field })).toBe(false);
      field.remove();
    }
  });
});

describe("what this browser keeps of the lane", () => {
  it("shows the lane at the token's width until a choice is kept", () => {
    expect(restoreLane(host().lane)).toEqual({ width: null, hidden: false });
  });

  it("keeps the width and whether the lane is hidden, and restores them", () => {
    const { lane, saved } = host();
    keepLane(lane, { width: 312, hidden: true });
    expect(saved).toEqual(
      new Map([
        ["pbmb.sidebar.width", "312"],
        ["pbmb.sidebar.hidden", "true"],
      ]),
    );
    expect(restoreLane(lane)).toEqual({ width: 312, hidden: true });
  });

  it("ignores a kept width that is not a whole number of pixels", () => {
    for (const width of ["wide", "-20", "0", "12.5", ""])
      expect(
        restoreLane(host({ saved: { "pbmb.sidebar.width": width } }).lane),
      ).toEqual({ width: null, hidden: false });
  });

  it("works for this page alone where the browser refuses storage", () => {
    const { lane } = host({ refuse: true });
    expect(restoreLane(lane)).toEqual({ width: null, hidden: false });
    expect(() => {
      keepLane(lane, { width: 300, hidden: true });
    }).not.toThrow();
  });

  it("throws any error from storage that is not a refusal", () => {
    const broken: StorageHost = {
      storage: () => {
        throw new TypeError("a bug");
      },
    };
    expect(() => restoreLane(broken)).toThrow(TypeError);
  });
});
