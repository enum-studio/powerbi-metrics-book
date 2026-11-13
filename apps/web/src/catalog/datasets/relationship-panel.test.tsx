// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RelationshipPanel } from "./relationship-panel";

let mounted: { host: HTMLElement; root: Root } | undefined;
afterEach(() => {
  if (mounted === undefined) return;
  act(() => mounted?.root.unmount());
  mounted.host.remove();
  mounted = undefined;
});

describe("RelationshipPanel", () => {
  it("words API cardinality and names the one side as the filtering table", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = { host, root };
    act(() => {
      root.render(
        createElement(RelationshipPanel, {
          relationship: {
            from_table: "Region",
            from_column: "Id",
            to_table: "Orders",
            to_column: "RegionId",
            cardinality: "one_to_many",
            filters: "one_way",
            is_active: true,
          },
          onClose: () => undefined,
          onTable: () => undefined,
        }),
      );
    });
    expect(host.textContent).toContain("One to many");
    expect(host.textContent).toContain("Region filters Orders");
  });
});
