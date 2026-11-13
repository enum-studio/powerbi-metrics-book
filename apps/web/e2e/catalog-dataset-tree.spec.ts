import type { Locator, Page } from "@playwright/test";
import { expect, openColumn, test } from "./fixtures.ts";

test.use({ signedInAs: "admin" });

const SALES = "d1000000-0000-4000-8000-000000000001";
const RETAIL = "d1000000-0000-4000-8000-000000000005";

const tree = (page: Page) =>
  page.getByRole("navigation", { name: "Catalog", exact: true });

/** A field's row in the dataset page's tabs, by its name; the row ends with its format or type. */
const field = (within: Locator, name: string) =>
  within.locator(`a[title="${name}"]`);

/** A folding row of the tree by its name and count, as a reader sees it. */
const foldRow = (page: Page, name: string, count: number) =>
  tree(page).getByRole("button", {
    name: new RegExp(`^${name}\\s*${String(count)}$`),
  });

test("the Datasets tree folds each level, workspace, dataset, table and display folder, and asks for each only when it opens", async ({
  page,
}) => {
  const fields: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (/\/api\/v1\/datasets\/[^/]+\/(measures|columns)$/.test(url.pathname))
      fields.push(url.search);
  });
  await page.goto("/");
  await openColumn(page);
  await tree(page)
    .getByRole("button", { name: "Datasets", exact: true })
    .click();
  // A workspace with one dataset still has its row.
  await expect(foldRow(page, "Finance", 1)).toBeVisible();
  await foldRow(page, "Sales", 2).click();
  await expect(
    tree(page).getByRole("link", { name: "Retail", exact: true }),
  ).toBeVisible();
  await tree(page).getByRole("button", { name: "Open Sales" }).click();
  // The dataset's tables, each with its count of measures and columns.
  await expect(
    tree(page).getByRole("link", { name: "Customer", exact: true }),
  ).toBeVisible();
  expect(fields).toEqual([]);
  await tree(page).getByRole("button", { name: "Open Sales" }).click();
  const folder = tree(page).getByRole("button", {
    name: "Open Time intelligence",
  });
  await expect(folder).toHaveAttribute("aria-expanded", "false");
  await expect(
    tree(page).getByRole("link", { name: "Units per order", exact: true }),
  ).toBeVisible();
  await expect(
    tree(page).getByRole("link", { name: "Is returned", exact: true }),
  ).toBeVisible();
  expect(fields.every((query) => query.includes("table=Sales"))).toBe(true);
  expect(fields.length).toBeGreaterThan(0);
  const measure = tree(page).getByRole("link", {
    name: "Net sales LY",
    exact: true,
  });
  await expect(measure).toHaveCount(0);
  await folder.click();
  await expect(measure).toBeVisible();
  // A field's row opens its table's panel with the field marked.
  await measure.click();
  await expect(page).toHaveURL(
    new RegExp(
      `/catalog/datasets/${SALES}\\?.*field=Net(\\+|%20)sales(\\+|%20)LY`,
    ),
  );
  await expect(
    page.getByRole("main").locator('[aria-current="true"]'),
  ).toHaveText("Net sales LY");
  await openColumn(page);
  await expect(measure).toHaveAttribute("data-status", "active");
});

test("only the way to the dataset on screen opens, and what a person opens holds as they move", async ({
  page,
}) => {
  await page.goto(`/catalog/datasets/${RETAIL}`);
  await openColumn(page);
  // Retail sits in the Sales workspace, which opens with Retail and its tables.
  await expect(foldRow(page, "Sales", 2)).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(
    tree(page).getByRole("button", { name: "Close Retail" }),
  ).toBeVisible();
  const finance = foldRow(page, "Finance", 1);
  await expect(finance).toHaveAttribute("aria-expanded", "false");
  await finance.click();
  await tree(page).getByRole("link", { name: "Terms", exact: true }).click();
  await expect(page).toHaveURL(/\/catalog\/terms$/);
  await openColumn(page);
  await expect(foldRow(page, "Finance", 1)).toHaveAttribute(
    "aria-expanded",
    "true",
  );
});

test("the dataset page's Tables and Measures tabs are the same tree", async ({
  page,
}) => {
  await page.goto(`/catalog/datasets/${SALES}?tab=tables`);
  const main = page.getByRole("main");
  await main.getByRole("button", { name: "Open Sales" }).click();
  const folder = main.getByRole("button", { name: "Open Time intelligence" });
  await expect(folder).toBeVisible();
  await expect(field(main, "Is returned")).toBeVisible();
  await folder.click();
  await expect(field(main, "Net sales LY")).toBeVisible();
  // The measures tab opens every table that holds a measure, and shows no columns.
  await page.goto(`/catalog/datasets/${SALES}?tab=measures`);
  await expect(main.getByRole("button", { name: "Close Sales" })).toBeVisible();
  await expect(
    main.getByRole("button", { name: "Open Time intelligence" }),
  ).toBeVisible();
  await expect(field(main, "Is returned")).toHaveCount(0);
  // A table's name opens it in the diagram.
  await main.getByTitle("Show Sales in the diagram").click();
  await expect(page).toHaveURL(/tab=diagram/);
});
