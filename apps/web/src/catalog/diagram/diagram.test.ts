// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Diagram } from "./diagram";
import type { DiagramModel } from "./model";

const table = (name: string) => ({
  name,
  description: null,
  columns: [{ name: "DateKey", type: "Int64", hidden: false }],
  measures: [],
});

const model: DiagramModel = {
  tables: [table("Sales"), table("Date")],
  relationships: [
    {
      from_table: "Sales",
      from_column: "DateKey",
      to_table: "Date",
      to_column: "DateKey",
      cardinality: "Many:One",
      filters: "one_way",
      is_active: false,
    },
  ],
  unknown: null,
};

/** jsdom has no layout engine; React Flow only needs these to exist. */
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
class DOMMatrixReadOnlyStub {
  m22 = 1;
}

beforeAll(() => {
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: ResizeObserverStub,
    DOMMatrixReadOnly: DOMMatrixReadOnlyStub,
  });
  Object.assign(SVGElement.prototype, {
    getBBox: () => ({ x: 0, y: 0, width: 40, height: 14 }),
  });
});

let mounted: { host: HTMLElement; root: Root } | undefined;
afterEach(() => {
  if (mounted === undefined) return;
  const { host, root } = mounted;
  act(() => {
    root.unmount();
  });
  host.remove();
  mounted = undefined;
});

function render(next: DiagramModel, term?: string): HTMLElement {
  const page = document.createElement("div");
  document.body.append(page);
  const root = createRoot(page);
  mounted = { host: page, root };
  act(() => {
    root.render(
      createElement(Diagram, {
        model: next,
        density: "keys",
        selection: null,
        onSelect: () => undefined,
        term,
      }),
    );
  });
  return page;
}

describe("Diagram", () => {
  it("draws an inactive relationship as a dashed line labelled inactive", () => {
    const page = render(model);
    const path = page.querySelector(".react-flow__edge-path");
    expect(path?.getAttribute("style")).toContain("stroke-dasharray: 4 4");
    expect(page.textContent).toContain("inactive");
  });

  it("fades the tables whose names do not hold the search term, and the lines to them", () => {
    const box = (page: HTMLElement, name: string) =>
      page.querySelector(`.react-flow__node[data-id="${name}"] > div`);
    const page = render(model, "DAT");
    expect(box(page, "Sales")?.className).toContain("opacity-45");
    expect(box(page, "Date")?.className).not.toContain("opacity-45");
    expect(
      page.querySelector(".react-flow__edge-path")?.getAttribute("style"),
    ).toContain("opacity: 0.25");
  });

  it("fades nothing while the search box is empty", () => {
    const page = render(model, "");
    expect(page.querySelector(".opacity-45")).toBeNull();
    expect(
      page.querySelector(".react-flow__edge-path")?.getAttribute("style"),
    ).toContain("opacity: 1");
  });

  it("draws no line when the relationships are unknown", () => {
    const page = render({ ...model, unknown: "Power BI did not say." });
    expect(page.querySelector(".react-flow__edge-path")).toBeNull();
    expect(page.querySelectorAll(".react-flow__node")).toHaveLength(2);
  });
});
