// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { TableSearch } from "./table-search";

const NAMES = ["Sales", "Date", "Customer", "Sales target", "Wholesale"];

beforeAll(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

let mounted:
  | { host: HTMLElement; root: Root; listener: (event: KeyboardEvent) => void }
  | undefined;
afterEach(() => {
  if (mounted === undefined) return;
  const { host, root, listener } = mounted;
  act(() => {
    root.unmount();
  });
  host.remove();
  window.removeEventListener("keydown", listener);
  mounted = undefined;
});

function Harness({ onPick }: { onPick: (name: string) => void }) {
  const [term, setTerm] = useState("");
  return (
    <TableSearch names={NAMES} term={term} onTerm={setTerm} onPick={onPick} />
  );
}

function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onPick = vi.fn<(name: string) => void>();
  // As the dataset page does: an Escape the box did not use clears the selection.
  const pageKeys = vi.fn<(key: string) => void>();
  const listener = (event: KeyboardEvent) => {
    if (!event.defaultPrevented) pageKeys(event.key);
  };
  window.addEventListener("keydown", listener);
  mounted = { host, root, listener };
  act(() => {
    root.render(<Harness onPick={onPick} />);
  });
  const box = () => {
    const found = host.querySelector<HTMLInputElement>('[role="combobox"]');
    if (found === null) throw new Error("No search box");
    return found;
  };
  const type = (text: string) => {
    act(() => {
      box().focus();
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(box(), text);
      box().dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const press = (key: string) => {
    act(() => {
      box().dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
    });
  };
  const hits = () =>
    [...host.querySelectorAll('[role="option"]')].map((each) => ({
      name: each.textContent,
      active: each.getAttribute("aria-selected") === "true",
    }));
  return { host, box, type, press, hits, onPick, pageKeys };
}

it("lists the tables that hold the term as it is typed, and marks the first", () => {
  const view = mount();
  expect(view.hits()).toEqual([]);
  expect(view.box().getAttribute("aria-expanded")).toBe("false");
  view.type("sal");
  expect(view.hits()).toEqual([
    { name: "Sales", active: true },
    { name: "Sales target", active: false },
    { name: "Wholesale", active: false },
  ]);
  expect(view.box().getAttribute("aria-expanded")).toBe("true");
  expect(view.box().getAttribute("aria-activedescendant")).toBe(
    view.host.querySelector('[role="option"]')?.id,
  );
});

it("moves through the hits with the arrow keys, round from the last to the first, and picks one with Enter", () => {
  const view = mount();
  view.type("sal");
  view.press("ArrowDown");
  view.press("ArrowDown");
  expect(view.hits().find((hit) => hit.active)?.name).toBe("Wholesale");
  view.press("ArrowDown");
  expect(view.hits().find((hit) => hit.active)?.name).toBe("Sales");
  view.press("ArrowUp");
  expect(view.hits().find((hit) => hit.active)?.name).toBe("Wholesale");
  view.press("Enter");
  expect(view.onPick).toHaveBeenCalledWith("Wholesale");
  // Picking closes the list and keeps the term, so the rest stay faded.
  expect(view.hits()).toEqual([]);
  expect(view.box().value).toBe("sal");
});

it("picks a hit with a click", () => {
  const view = mount();
  view.type("cus");
  act(() => {
    view.host.querySelector<HTMLElement>('[role="option"]')?.click();
  });
  expect(view.onPick).toHaveBeenCalledWith("Customer");
});

it("closes the list with Escape, then clears the box, and only then lets the page have Escape", () => {
  const view = mount();
  view.type("dat");
  view.press("Escape");
  expect(view.hits()).toEqual([]);
  expect(view.box().value).toBe("dat");
  view.press("Escape");
  expect(view.box().value).toBe("");
  expect(view.pageKeys).not.toHaveBeenCalled();
  view.press("Escape");
  expect(view.pageKeys).toHaveBeenCalledWith("Escape");
  expect(view.onPick).not.toHaveBeenCalled();
});

it("says so when no table holds the term, and Enter picks nothing", () => {
  const view = mount();
  view.type("zzz");
  expect(view.host.querySelector('[role="status"]')?.textContent).toBe(
    "No table has that in its name.",
  );
  view.press("Enter");
  expect(view.onPick).not.toHaveBeenCalled();
});

it("clears the box with its clear button", () => {
  const view = mount();
  view.type("sales");
  act(() => {
    view.host
      .querySelector<HTMLElement>('[aria-label="Clear the search"]')
      ?.click();
  });
  expect(view.box().value).toBe("");
  expect(view.host.querySelector('[aria-label="Clear the search"]')).toBeNull();
});
