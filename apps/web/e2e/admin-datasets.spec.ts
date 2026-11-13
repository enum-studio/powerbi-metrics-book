import {
  contextAs,
  devStackUrl,
  expect,
  openColumn,
  openDatasets,
  openSettings,
  test,
} from "./fixtures.ts";

test.use({ signedInAs: "admin" });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      document.documentElement.dataset.cspViolation = event.violatedDirective;
    });
  });
});
test.afterEach(async ({ page }) => {
  await expect(page.locator("html")).not.toHaveAttribute("data-csp-violation");
});

test("datasets show their workspace, counts, sync time and accessible controls", async ({
  page,
}) => {
  await page.goto("/admin/datasets");
  await expect(
    page.getByRole("heading", { name: "Datasets", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Sample data", { exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Marketing" })).toBeChecked();
  if (page.viewportSize()?.width === 390) {
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  }
  // On a phone the counts and the sync time give way, so the switch stays on the screen.
  const narrow = page.viewportSize()?.width === 390;
  for (const name of narrow
    ? ["Dataset"]
    : ["Dataset", "Tables", "Columns", "Measures", "Synced"])
    await expect(
      page.getByRole("columnheader", { name, exact: true }),
    ).toBeVisible();
  await expect(page.getByText(/workspace$/).first()).toBeVisible();
  await page.getByRole("textbox", { name: "Find a dataset" }).fill("Marketing");
  await expect(page.getByRole("switch")).toHaveCount(1);
  await expect(
    page.getByRole("link", { name: "Marketing", exact: true }),
  ).toBeVisible();
  await expect(page.locator("time").first()).toContainText(
    /\d{4}.*(UTC|GMT|[A-Z]{3,5})/,
  );
});

test("a viewer opening Datasets gets the admin section's refusal", async ({
  browser,
}) => {
  const context = await contextAs(browser, "viewer");
  try {
    const viewer = await context.newPage();
    await viewer.goto("/admin/datasets");
    await expect(
      viewer.getByRole("heading", { name: "The admin section is for admins" }),
    ).toBeVisible();
    // On a phone the pages are in the drawer, so it is the open drawer that must not list them: a viewer's Settings hold only their own.
    await openColumn(viewer);
    await expect(
      viewer
        .getByRole("navigation", { name: "Settings pages" })
        .getByRole("link"),
    ).toHaveText(["Connections"]);
    await expect(viewer.getByRole("switch")).toHaveCount(0);
    await expect(
      viewer.getByRole("textbox", { name: "Find a dataset" }),
    ).toHaveCount(0);
    expect((await viewer.request.get("/api/v1/admin/datasets")).status()).toBe(
      403,
    );
  } finally {
    await context.close();
  }
});

test("a failed switch shows the pending state, rolls back, and says the API message", async ({
  page,
}) => {
  await page.goto("/admin/datasets");
  const toggle = page.getByRole("switch", { name: "Marketing" });
  await expect(toggle).toBeChecked();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/admin/datasets/*", async (route) => {
    await held;
    await route.fulfill({
      status: 403,
      json: { error: "refused", message: "Your role cannot change datasets." },
    });
  });
  try {
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect(toggle).toBeDisabled();
  } finally {
    release();
  }
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeEnabled();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Your role cannot change datasets." }),
  ).toBeVisible();
});

// These writes change the shared tenant, so the tenant project runs them alone after every other spec.
test("turning Marketing off updates filter counts and the catalog; Undo restores it @tenant", async ({
  page,
  context,
}) => {
  let catalogReads = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/datasets") catalogReads++;
  });
  await page.goto("/catalog");
  await openDatasets(page);
  await expect(
    page
      .getByRole("navigation", { name: "Catalog", exact: true })
      .locator('a[href^="/catalog/datasets/"]')
      .filter({ hasText: /^Marketing$/ }),
  ).toBeVisible();
  await openSettings(page);
  await page
    .getByRole("navigation", { name: "Settings pages" })
    .getByRole("link", { name: "Datasets", exact: true })
    .click();
  const toggle = page.getByRole("switch", { name: "Marketing" });
  const all = page.getByRole("switch");
  const filters = page.getByRole("group", {
    name: "Dataset state",
    exact: true,
  });
  await expect(toggle).toBeChecked();
  const count = await all.count();
  const on = await page.getByRole("switch", { checked: true }).count();
  const href = await page
    .getByRole("main")
    .getByRole("link", { name: "Marketing", exact: true })
    .getAttribute("href");
  if (href === null) throw new Error("Marketing needs a catalog link");
  const id = href.split("/").at(-1)?.split("?")[0];
  if (!id) throw new Error("Marketing needs an id");
  const catalog = await context.newPage();
  try {
    await toggle.click();
    const notice = page
      .getByRole("status")
      .filter({ hasText: "Marketing is off." });
    await expect(notice).toContainText(
      "It is gone from the catalog, search and every agent, for everyone.",
    );
    await expect(
      page
        .getByRole("main")
        .getByRole("link", { name: "Marketing", exact: true }),
    ).toHaveCount(0);
    await filters
      .getByRole("button", {
        name: `Off ${String(count - on + 1)}`,
        exact: true,
      })
      .click();
    await expect(all).toHaveCount(count - on + 1);
    await filters
      .getByRole("button", { name: `On ${String(on - 1)}`, exact: true })
      .click();
    await expect(all).toHaveCount(on - 1);
    await expect(toggle).toHaveCount(0);
    await catalog.goto("/catalog");
    await openDatasets(catalog);
    const tree = catalog.getByRole("navigation", {
      name: "Catalog",
      exact: true,
    });
    await expect(
      tree.getByRole("link", { name: "Retail", exact: true }),
    ).toBeVisible();
    await expect(
      tree
        .locator('a[href^="/catalog/datasets/"]')
        .filter({ hasText: /^Marketing$/ }),
    ).toHaveCount(0);
    await notice.getByRole("button", { name: "Undo" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Marketing is on again." }),
    ).toBeVisible();
    await filters.getByRole("button", { name: "All", exact: true }).click();
    await expect(toggle).toBeChecked();
    await expect(all).toHaveCount(count);
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Metrics", exact: true })
      .click();
    await expect(
      page
        .getByRole("navigation", { name: "Catalog", exact: true })
        .locator('a[href^="/catalog/datasets/"]')
        .filter({ hasText: /^Marketing$/ }),
    ).toBeVisible();
    await expect.poll(() => catalogReads).toBeGreaterThan(1);
  } finally {
    expect(
      (
        await page.request.put(`/api/v1/admin/datasets/${id}`, {
          headers: { origin: devStackUrl() },
          data: { enabled: true },
        })
      ).ok(),
    ).toBe(true);
    await catalog.close();
  }
});

test("new datasets set to Off survives a reload and the notice expires @tenant", async ({
  page,
}) => {
  const endpoint = "/api/v1/admin/settings/powerbi.datasets.new";
  const save = (value: string) =>
    page.request.put(endpoint, {
      headers: { origin: devStackUrl() },
      data: { value },
    });
  const before = await page.request.get(endpoint);
  expect(before.ok()).toBe(true);
  const { value } = (await before.json()) as { value: string };
  try {
    expect((await save("on")).ok()).toBe(true);
    await page.goto("/admin/datasets");
    const setting = page.getByRole("group", {
      name: "New dataset state",
      exact: true,
    });
    await setting.getByRole("button", { name: "Off", exact: true }).click();
    const notice = page
      .getByRole("status")
      .filter({ hasText: "New datasets now start off." });
    await expect(notice).toBeVisible();
    await expect(notice).toBeHidden({ timeout: 8_000 });
    await page.reload();
    await expect(
      setting.getByRole("button", { name: "Off", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
  } finally {
    expect((await save(value)).ok()).toBe(true);
  }
});
