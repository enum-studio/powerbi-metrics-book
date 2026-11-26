import {
  closeColumn,
  devStackUrl,
  expect,
  openColumn,
  test,
} from "./fixtures.ts";

test.use({ signedInAs: "admin" });

test("the catalog shows filed metrics, and serves category routes", async ({
  page,
}) => {
  const csp: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      message.text().toLowerCase().includes("content security policy")
    )
      csp.push(message.text());
  });
  await page.goto("/catalog");
  await expect(page.getByRole("heading", { name: "Metrics" })).toBeVisible();
  const salesDescription =
    "What customers bought: amounts, orders and baskets, from the order lines. Before returns unless a metric says otherwise.";
  await expect(page.getByText(salesDescription)).toBeVisible();
  await expect(
    page.locator('a[href="/catalog/metrics/net_sales"]'),
  ).toBeVisible();
  await openColumn(page);
  await page.getByRole("button", { name: "Open Sales" }).click();
  await expect(
    page.getByRole("link", { name: "Orders", exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Returns", exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("link", { name: "Orders", exact: true }).first().click();
  await expect(page).toHaveURL(/\/catalog\/categories\/sales\/orders$/);
  await expect(page.getByRole("heading", { name: "Orders" })).toBeVisible();
  await expect(
    page.locator('a[href="/catalog/metrics/average_order_value"]').last(),
  ).toBeVisible();
  await openColumn(page);
  await page.getByRole("button", { name: "Close Sales" }).click();
  await expect(
    page.locator('a[href="/catalog/categories/sales/orders"]'),
  ).toBeHidden();
  await closeColumn(page);
  await page
    .locator('a[href="/catalog/metrics/average_order_value"]')
    .last()
    .click();
  await openColumn(page);
  await expect(
    page
      .getByRole("navigation", { name: "Catalog" })
      .locator('a[href="/catalog/categories/sales/orders"]'),
  ).toBeVisible();
  await expect(
    page
      .locator('a[href="/catalog/categories/sales/orders"]')
      .filter({ visible: true })
      .first(),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Metrics", exact: true }),
  ).toBeVisible();
  expect(csp).toEqual([]);
});

test("the catalog asks for one page of each list, and the tree links to what is not filed @tenant", async ({
  page,
  request,
}) => {
  const name = "unfiled_reading_test";
  const headers = { origin: devStackUrl() };
  const created = await request.post("/api/v1/metrics", {
    headers,
    data: { name, label: "Unfiled reading test" },
  });
  expect(created.status()).toBe(201);
  try {
    const asked: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/v1/metrics?")) asked.push(request.url());
    });
    await page.goto("/catalog");
    await expect(
      page.getByRole("heading", { name: /^Not filed/ }),
    ).toBeVisible();
    expect(asked.length).toBeGreaterThan(0);
    for (const url of asked) {
      expect(url).toContain("limit=50");
      expect(url).not.toContain("cursor=");
    }
    await openColumn(page);
    await page
      .getByRole("navigation", { name: "Catalog" })
      .getByRole("link", { name: /^Not filed/ })
      .click();
    await expect(page).toHaveURL(/\/catalog\?view=not-filed$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Not filed" }),
    ).toBeVisible();
    const sales = page
      .getByRole("main")
      .locator('a[href="/catalog/categories/sales"]');
    await expect(sales).toBeHidden();
    // A link to the view, opened cold, shows the same.
    await page.reload();
    await expect(
      page.getByRole("heading", { level: 1, name: "Not filed" }),
    ).toBeVisible();
    await expect(
      page.getByRole("main").locator('a[href^="/catalog/metrics/"]').first(),
    ).toBeVisible();
    await expect(sales).toBeHidden();
    // Any other view is the whole home.
    await page.goto("/catalog?view=junk");
    await expect(sales).toBeVisible();
  } finally {
    expect(
      (await request.delete(`/api/v1/metrics/${name}`, { headers })).status(),
    ).toBe(204);
  }
});

test("a failed category query shows its error under Metrics and leaves the rest of the tree", async ({
  page,
}) => {
  test.setTimeout(15_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/v1/categories**", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        error: "upstream",
        message: "The categories could not be loaded.",
      }),
    }),
  );
  await page.goto("/catalog/datasets/d1000000-0000-4000-8000-000000000005");
  const tree = page.getByRole("navigation", { name: "Catalog", exact: true });
  await tree.getByRole("button", { name: "Open Metrics" }).click();
  await expect(tree.getByRole("alert")).toContainText(
    "The categories could not be loaded.",
    { timeout: 12_000 },
  );
  await expect(tree.getByRole("link", { name: "Terms" })).toBeVisible();
  await expect(
    tree.getByRole("button", { name: "Datasets", exact: true }),
  ).toBeVisible();
});
