import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

test.use({ signedInAs: "curator" });

const retail = "/catalog/datasets/d1000000-0000-4000-8000-000000000005";

const node = (page: Page, name: string) =>
  page.locator(`.react-flow__node[data-id="${name}"]`);

/** A table's drawn box, which carries its faded or selected look. */
const tableBox = (page: Page, name: string) =>
  node(page, name).locator(":scope > div");

/** The diagram's pan and zoom, as React Flow writes them on its viewport. */
const view = (page: Page) =>
  page.locator(".react-flow__viewport").evaluate((element) => {
    const { e, f, a } = new DOMMatrixReadOnly(
      getComputedStyle(element).transform,
    );
    return { x: e, y: f, zoom: a };
  });

/** Scrolls the diagram, which pans it, and waits for the view to move. */
async function pan(page: Page) {
  const from = await view(page);
  const pane = await page.locator(".react-flow__pane").boundingBox();
  if (pane === null) throw new Error("Diagram geometry was unavailable");
  await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
  await page.mouse.wheel(0, 240);
  await expect.poll(() => view(page)).not.toEqual(from);
}

test("finding a table by name fades the rest until the box is cleared, and picking it zooms to it, selects it and opens its panel", async ({
  page,
}) => {
  // The fade after a pick follows Stock's relationships, which the sessions setup read from Power BI.
  await page.goto(`${retail}?tab=diagram`);
  await expect(page.locator(".react-flow__edge").first()).toBeAttached();
  await expect(node(page, "Stock")).toBeVisible();
  // The view settles once the pane has its size; read it after that.
  await expect.poll(async () => (await view(page)).zoom).toBeLessThan(1);
  const before = await view(page);

  const box = page.getByRole("combobox", { name: "Find a table" });
  const hits = page.getByRole("listbox", { name: "Tables found" });
  const faded = page.locator(".react-flow__node > .opacity-45");
  await box.fill("sto");
  await expect(hits.getByRole("option").first()).toHaveText("Stock");
  // While a term is in the box, the tables without it in their names fade.
  await expect(tableBox(page, "Order lines")).toHaveClass(/opacity-45/);
  await expect(tableBox(page, "Stock")).not.toHaveClass(/opacity-45/);
  // Looked around without picking, then cleared: the view goes back to where the search began.
  await pan(page);
  await page.getByRole("button", { name: "Clear the search" }).click();
  await expect(box).toHaveValue("");
  await expect(faded).toHaveCount(0);
  await expect.poll(() => view(page)).toEqual(before);

  await box.fill("sto");
  await expect(hits.getByRole("option").first()).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await box.press("ArrowDown");
  await box.press("ArrowUp");
  await box.press("Enter");
  await expect(hits).toHaveCount(0);
  await expect(page).toHaveURL(/[?&]table=Stock(&|$)/);
  await expect(
    page.getByRole("heading", { name: "Stock", exact: true }),
  ).toBeVisible();
  await expect(tableBox(page, "Stock")).toHaveClass(/outline-accent/);

  // The view moved to the table, at the search's zoom, with the table in the pane.
  await expect.poll(async () => (await view(page)).zoom).toBe(1);
  expect(await view(page)).not.toEqual(before);
  const [nodeBox, paneBox] = await Promise.all([
    node(page, "Stock").boundingBox(),
    page.locator(".react-flow__pane").boundingBox(),
  ]);
  if (nodeBox === null || paneBox === null)
    throw new Error("Diagram geometry was unavailable");
  expect(nodeBox.x).toBeGreaterThanOrEqual(paneBox.x);
  expect(nodeBox.x + nodeBox.width).toBeLessThanOrEqual(
    paneBox.x + paneBox.width,
  );
  expect(nodeBox.y).toBeGreaterThanOrEqual(paneBox.y);
  expect(nodeBox.y).toBeLessThan(paneBox.y + paneBox.height);

  // After a pick, clearing the box ends the term's fade, leaving only the
  // selection's on the tables away from Stock, and keeps the view on it.
  const picked = await view(page);
  const fadedWithTerm = await faded.count();
  await page.getByRole("button", { name: "Clear the search" }).click();
  await expect.poll(() => faded.count()).toBeLessThan(fadedWithTerm);
  expect(await view(page)).toEqual(picked);
  await expect(
    page.getByRole("heading", { name: "Stock", exact: true }),
  ).toBeVisible();
});

test("Escape that clears the box with no table picked puts the view back", async ({
  page,
}) => {
  await page.goto(`${retail}?tab=diagram`);
  await expect.poll(async () => (await view(page)).zoom).toBeLessThan(1);
  const before = await view(page);
  const box = page.getByRole("combobox", { name: "Find a table" });
  await box.fill("cus");
  await pan(page);
  await box.press("Escape");
  await box.press("Escape");
  await expect(box).toHaveValue("");
  await expect.poll(() => view(page)).toEqual(before);
});

test("Escape closes the hits, then clears the box, and only then the selection; a click picks a hit", async ({
  page,
}) => {
  await page.goto(`${retail}?tab=diagram`);
  const box = page.getByRole("combobox", { name: "Find a table" });
  await box.fill("returns");
  await page
    .getByRole("listbox", { name: "Tables found" })
    .getByRole("option", { name: "Returns" })
    .click();
  const returns = page.getByRole("heading", { name: "Returns", exact: true });
  await expect(returns).toBeVisible();
  await expect(page).toHaveURL(/[?&]table=Returns(&|$)/);
  await box.fill("stoc");
  await expect(
    page.getByRole("listbox", { name: "Tables found" }),
  ).toBeVisible();
  await box.press("Escape");
  await expect(page.getByRole("listbox", { name: "Tables found" })).toHaveCount(
    0,
  );
  await expect(box).toHaveValue("stoc");
  await box.press("Escape");
  await expect(box).toHaveValue("");
  await expect(returns).toBeVisible();
  await box.press("Escape");
  await expect(returns).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]table=/);
});
