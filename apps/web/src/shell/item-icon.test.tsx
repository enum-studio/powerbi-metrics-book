// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { CircleOff, Table2 } from "lucide-react";
import { expect, it } from "vitest";
import { GLYPH_NAMES, glyphComponent, ItemIcon } from "./item-icon";

function draw(icon: string | null, fallback = Table2) {
  const host = document.createElement("div");
  act(() => {
    createRoot(host).render(<ItemIcon icon={icon} fallback={fallback} />);
  });
  return host;
}

it("draws a glyph as an svg in its colour token", () => {
  const svg = draw("glyph:chart-line:green").querySelector("svg");
  expect(svg?.getAttribute("class")).toContain("lucide-chart-line");
  expect(svg?.getAttribute("style")).toContain("var(--icon-green)");
});

it("draws an emoji as its character", () => {
  expect(draw("emoji:📈").textContent).toBe("📈");
});

it("draws the fallback with no icon or a glyph it cannot resolve", () => {
  for (const icon of [
    null,
    "glyph:no-such-glyph:red",
    "glyph:icon:red",
    "glyph:chart-line:pink",
    "nonsense",
  ])
    expect(draw(icon).querySelector("svg")?.getAttribute("class")).toContain(
      "lucide-table-2",
    );
});

it("draws every glyph in the map as its own icon", () => {
  for (const name of GLYPH_NAMES) {
    expect(glyphComponent(name)).toBeDefined();
    expect(
      draw(`glyph:${name}:gray`, CircleOff)
        .querySelector("svg")
        ?.getAttribute("class"),
    ).not.toContain("lucide-circle-off");
  }
});
