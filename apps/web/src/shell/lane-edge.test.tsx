// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { LaneEdge } from "./lane-edge";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

afterEach(() => {
  document.body.replaceChildren();
});

function renderEdge(
  width: number,
  options: { chosen?: number | null; max?: number } = {},
) {
  const onChange = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  // The lane starts at the window's left edge, so a pointer's x is the lane's width.
  const lane = createRef<HTMLElement>();
  act(() => {
    createRoot(container).render(
      <aside ref={lane}>
        <LaneEdge
          lane={lane}
          controls="lane"
          width={width}
          chosen={options.chosen ?? width}
          bounds={{ min: 240, max: options.max ?? 480 }}
          onChange={onChange}
        />
      </aside>,
    );
  });
  const edge = container.querySelector("hr");
  if (edge === null) throw new Error("The lane's edge did not render.");
  return { edge, onChange };
}

it("is a vertical separator a keyboard reaches, with its width and limits", () => {
  const { edge } = renderEdge(300);
  expect(edge.getAttribute("aria-orientation")).toBe("vertical");
  expect(edge.getAttribute("aria-label")).toBe("Resize the sidebar");
  expect(edge.getAttribute("aria-controls")).toBe("lane");
  expect(edge.getAttribute("aria-valuenow")).toBe("300");
  expect(edge.getAttribute("aria-valuemin")).toBe("240");
  expect(edge.getAttribute("aria-valuemax")).toBe("480");
  expect(edge.tabIndex).toBe(0);
});

it("moves with the arrow keys and keeps each width it moves to", () => {
  const { edge, onChange } = renderEdge(300);
  const right = new KeyboardEvent("keydown", {
    key: "ArrowRight",
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    edge.dispatchEvent(right);
  });
  expect(onChange).toHaveBeenLastCalledWith(
    { width: 316, hidden: false },
    true,
  );
  expect(right.defaultPrevented).toBe(true);
  act(() => {
    edge.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
    );
  });
  expect(onChange).toHaveBeenLastCalledWith(
    { width: 240, hidden: false },
    true,
  );
});

it("lets Tab and every other key through", () => {
  const { edge, onChange } = renderEdge(300);
  const tab = new KeyboardEvent("keydown", {
    key: "Tab",
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    edge.dispatchEvent(tab);
  });
  expect(onChange).not.toHaveBeenCalled();
  expect(tab.defaultPrevented).toBe(false);
});

/** jsdom has no pointer capture, which the edge asks for as a drag starts. */
function pointer(edge: HTMLElement, type: string, clientX: number) {
  edge.setPointerCapture = vi.fn();
  act(() => {
    edge.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, clientX }),
    );
  });
}

it("saves nothing on a press that does not move, so a narrow window's width never replaces the one chosen", () => {
  // Chosen at 480; this window shows it at 324.
  const { edge, onChange } = renderEdge(324, { chosen: 480, max: 324 });
  pointer(edge, "pointerdown", 324);
  pointer(edge, "pointerup", 324);
  expect(onChange).not.toHaveBeenCalled();
});

it("hides the lane with the width chosen when a drag lets go under half the narrowest", () => {
  const { edge, onChange } = renderEdge(324, { chosen: 480, max: 324 });
  pointer(edge, "pointerdown", 324);
  pointer(edge, "pointermove", 200);
  pointer(edge, "pointermove", 40);
  pointer(edge, "pointerup", 40);
  expect(onChange).toHaveBeenLastCalledWith({ width: 480, hidden: true }, true);
});

it("follows a drag and keeps the width it lets go at", () => {
  const { edge, onChange } = renderEdge(300);
  pointer(edge, "pointerdown", 300);
  pointer(edge, "pointermove", 360);
  expect(onChange).toHaveBeenLastCalledWith(
    { width: 360, hidden: false },
    false,
  );
  pointer(edge, "pointerup", 360);
  expect(onChange).toHaveBeenLastCalledWith(
    { width: 360, hidden: false },
    true,
  );
});
