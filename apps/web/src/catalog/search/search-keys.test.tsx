// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { mount } from "../../access/form-test-support";
import { CatalogSearch } from "./search";

let pathname = "/";
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useLocation: ({
    select,
  }: {
    select: (location: { pathname: string }) => unknown;
  }) => select({ pathname }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

async function press(key: string, init: KeyboardEventInit = {}) {
  const onOpen = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
  const view = await mount(
    createElement(CatalogSearch, {
      open: false,
      onOpen,
      onClose: vi.fn(),
    }),
  );
  document.body.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, ...init }),
  );
  view.close();
  return onOpen;
}

it("leaves / and Ctrl+K to Home's own box on Home", async () => {
  pathname = "/";
  expect(await press("/")).not.toHaveBeenCalled();
  expect(await press("k", { ctrlKey: true })).not.toHaveBeenCalled();
});

it("opens on / and Ctrl+K off Home", async () => {
  pathname = "/catalog/terms";
  expect(await press("/")).toHaveBeenCalled();
  expect(await press("k", { ctrlKey: true })).toHaveBeenCalled();
});
