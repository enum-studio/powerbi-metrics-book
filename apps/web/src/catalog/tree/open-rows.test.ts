import { describe, expect, it } from "vitest";
import { NOTHING_HANDLED, openRows, reopenTrail, toggleRow } from "./open-rows";

const sorted = (rows: Set<string>) => [...rows].sort();

describe("which rows of a tree are open", () => {
  it("opens the way to the page on screen and nothing else", () => {
    expect(sorted(openRows(["w:1", "d:1"], NOTHING_HANDLED))).toEqual([
      "d:1",
      "w:1",
    ]);
  });

  it("holds a row a person opened as they move to another page", () => {
    let handled = toggleRow(
      "w:2",
      openRows([], NOTHING_HANDLED),
      NOTHING_HANDLED,
    );
    expect(sorted(openRows([], handled))).toEqual(["w:2"]);
    handled = reopenTrail(["w:1"], handled);
    expect(sorted(openRows(["w:1"], handled))).toEqual(["w:1", "w:2"]);
  });

  it("holds a row on the way a person closed, until they come to a page again", () => {
    const trail = ["w:1", "d:1"];
    const handled = toggleRow(
      "w:1",
      openRows(trail, NOTHING_HANDLED),
      NOTHING_HANDLED,
    );
    expect(sorted(openRows(trail, handled))).toEqual(["d:1"]);
    expect(sorted(openRows(trail, reopenTrail(trail, handled)))).toEqual([
      "d:1",
      "w:1",
    ]);
  });

  it("closes a row opened by hand when it is toggled again", () => {
    const once = toggleRow("w:2", new Set(), NOTHING_HANDLED);
    const twice = toggleRow("w:2", openRows([], once), once);
    expect(sorted(openRows([], twice))).toEqual([]);
    expect(twice).toEqual({ opened: [], closed: ["w:2"] });
  });
});
