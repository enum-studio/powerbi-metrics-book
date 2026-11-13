import { expect, test } from "./fixtures.ts";

test.use({ signedInAs: "admin" });

test("search opens by slash, and goes to a hit by arrow keys", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/catalog");
  const search = page.getByRole("combobox", { name: "Search the catalog" });
  await expect(search).toBeHidden();
  await page.getByRole("heading", { name: "Metrics" }).click();
  await page.keyboard.press("/");
  await expect(search).toBeFocused();
  await search.fill("net sales");

  const listbox = page.getByRole("listbox", { name: "Catalog search results" });
  const metrics = listbox.getByRole("group", { name: "Metrics" });
  await expect(metrics.getByRole("option").first()).toContainText("Net sales");
  // The first row is what was typed; the best hit is the one below it.
  await expect(listbox.getByRole("option").first()).toContainText(
    "net sales in all results",
  );
  await search.press("ArrowDown");
  await search.press("Enter");
  await expect(page).toHaveURL(/\/catalog\/metrics\/net_sales$/);
  await expect(search).toBeHidden();
  // The slash only opens search once the new page has drawn.
  await expect(
    page.getByRole("heading", { level: 1, name: "Net sales" }),
  ).toBeVisible();

  await page.keyboard.press("/");
  await expect(search).toBeFocused();
  await search.press("Escape");
  await expect(search).toBeHidden();
});

test("Home is the search: a kind narrows it, Show all lists one kind, and the address is the search", async ({
  page,
}) => {
  await page.goto("/?q=sales");
  const main = page.getByRole("main");
  await expect(
    main.getByRole("heading", { name: /^Best match/ }),
  ).toBeVisible();
  await expect(
    main.locator("summary").filter({ hasText: /^Metrics \(/ }),
  ).toBeVisible();

  await main
    .getByRole("button", { name: /^Show all/ })
    .first()
    .click();
  await expect(main.locator("[data-search-row]").nth(5)).toBeVisible();
  await main.getByLabel("Type").selectOption("dataset");
  await expect(page).toHaveURL(/kind=dataset/);
  await expect(
    main.locator("summary").filter({ hasText: /^Datasets \(/ }),
  ).toBeVisible();
  await expect(
    main.locator("summary").filter({ hasText: /^Metrics \(/ }),
  ).toHaveCount(0);

  // The address is the search: opened cold, it shows the same.
  await page.reload();
  await expect(
    main.locator("summary").filter({ hasText: /^Datasets \(/ }),
  ).toBeVisible();

  await main.locator("[data-search-row]").first().click();
  await expect(page).toHaveURL(/\/catalog\/datasets\//);
});

test("the results say so when nothing matches", async ({ page }) => {
  await page.goto("/?q=zzzzqqqq");
  await expect(
    page.getByRole("heading", { name: "Nothing matches" }),
  ).toBeVisible();
});

test("typing on Home keeps every letter", async ({ page }) => {
  await page.goto("/");
  const field = page
    .getByRole("main")
    .getByRole("searchbox", { name: "Search the catalog" });
  // Slower than the wait before the address changes, so each letter lands as the last one is sent.
  await field.pressSequentially("net sales", { delay: 210 });
  await expect(field).toHaveValue("net sales");
  await expect(page).toHaveURL(/q=net(\+|%20)sales/);
});

test("the old search address goes to Home with the same search", async ({
  page,
}) => {
  await page.goto("/catalog/search?q=sales&kind=dataset");
  await expect(page).toHaveURL(/\/\?q=sales&kind=dataset$/);
  await expect(
    page
      .getByRole("main")
      .getByRole("searchbox", { name: "Search the catalog" }),
  ).toHaveValue("sales");
});
