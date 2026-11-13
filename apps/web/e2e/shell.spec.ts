import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import {
  closeColumn,
  contextAs,
  devStackUrl,
  expect,
  grantRole,
  openColumn,
  openSettings,
  PEOPLE,
  signInAs,
  test,
} from "./fixtures.ts";

test.use({ signedInAs: "admin" });

/** Below Tailwind's sm, where the breadcrumb is one link back. */
const onPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 640;

const pastTheScreen = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test("the shell renders for a signed-in person", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: "Power BI Metrics Book" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Search" })).toBeVisible();
  await expect(
    page.getByRole("searchbox", { name: "Search the catalog" }),
  ).toBeVisible();
  await openColumn(page);
  const main = page.getByRole("navigation", { name: "Main" });
  // Metrics, Terms and Datasets sit at the root beside Home, with no Catalog row above them, and Settings for everyone below.
  for (const place of ["Home", "Metrics", "Terms"])
    await expect(
      main.getByRole("link", { name: place, exact: true }),
    ).toBeVisible();
  // A link beside the page; in the drawer, a row that folds Settings' pages out.
  await expect(main.getByText("Settings", { exact: true })).toBeVisible();
  await expect(
    main.getByRole("button", { name: "Datasets", exact: true }),
  ).toBeVisible();
  await expect(main.getByText("Catalog", { exact: true })).toHaveCount(0);
  await expect(main.getByText("Connections", { exact: true })).toHaveCount(0);
  const account = page.getByRole("region", { name: "Your account" });
  await expect(account.getByText(PEOPLE.admin)).toBeVisible();
  await expect(account.getByRole("button", { name: "Sign out" })).toBeVisible();
});

test("Home is the first row of the first lane, search is a button in its header, and / and Ctrl+K open the dialog off Home", async ({
  page,
}) => {
  await page.goto("/");
  await openColumn(page);
  const main = page.getByRole("navigation", { name: "Main" });
  await expect(main.getByRole("link").nth(0)).toHaveText("Home");
  await expect(main.getByRole("link", { name: "Search" })).toHaveCount(0);
  // On Home the box takes the keys, not the dialog.
  await page.keyboard.press("/");
  await expect(page.getByRole("dialog", { name: "Search" })).toHaveCount(0);
  await closeColumn(page);
  await page.goto("/catalog/terms");
  const opener = page.getByRole("button", { name: "Search the catalog" });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Search" });
  const box = dialog.getByRole("combobox", { name: "Search the catalog" });
  await expect(box).toBeFocused();
  await page.keyboard.type("gmv");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/\?q=gmv/);
  await page.goto("/catalog/terms");
  await expect(opener).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(box).toBeFocused();
  await page.keyboard.press("Escape");
  await page.goto("/catalog/search?q=gmv&kind=metric");
  await expect(page).toHaveURL(/\/\?q=gmv&kind=metric/);
});

test("an admin has Status in the first lane and a viewer has not; both reach Connections under Settings", async ({
  browser,
  page,
}) => {
  await page.goto("/settings/connections");
  await openColumn(page);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Status", exact: true })
    .click();
  await expect(page).toHaveURL(/\/admin$/);
  const viewer = await (await contextAs(browser, "viewer")).newPage();
  await viewer.goto("/");
  await openColumn(viewer);
  await expect(
    viewer
      .getByRole("region", { name: "Your account" })
      .getByText(PEOPLE.viewer),
  ).toBeVisible();
  const main = viewer.getByRole("navigation", { name: "Main" });
  await expect(main.getByText("Status", { exact: true })).toHaveCount(0);
  await openSettings(viewer);
  const pages = viewer.getByRole("navigation", { name: "Settings pages" });
  await pages.getByRole("link", { name: "Connections" }).click();
  await expect(viewer).toHaveURL(/\/settings\/connections$/);
  await expect(
    viewer.getByRole("heading", { name: "Connections", level: 1 }),
  ).toBeVisible();
  // A viewer's Settings hold their own page and none of the admin's.
  await openColumn(viewer);
  await expect(pages.getByRole("link")).toHaveText(["Connections"]);
  await expect(pages.locator('[aria-current="page"]')).toHaveText(
    "Connections",
  );
  await viewer.context().close();
});

test("an admin's Settings list their own Connections first, then the admin's sections", async ({
  page,
}) => {
  await page.goto("/settings/connections");
  await openColumn(page);
  const pages = page.getByRole("navigation", { name: "Settings pages" });
  // The section labels, under the lane's own Settings title beside the page.
  await expect(
    pages.getByRole("paragraph").filter({ hasNotText: /^Settings$/ }),
  ).toHaveText(["Account", "Data", "Access", "System"]);
  await expect(pages.getByRole("link").first()).toHaveText("Connections");
  await pages.getByRole("link", { name: "Power BI", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/powerbi$/);
});

test("the connections tabs show no scrollbar, and the Agents tab gives the install and login lines with one Copy button each", async ({
  context,
  page,
}) => {
  const email = `shell-${randomUUID()}@sample.example`;
  await grantRole(page.request, email, "viewer");
  const signed = await page.request.post("/api/auth/dev/sign-in", {
    headers: { origin: devStackUrl() },
    data: { email },
  });
  expect(signed.status()).toBe(200);
  await page.goto("/settings/connections");
  const tabs = page.getByRole("tablist");
  expect(await tabs.evaluate((el) => el.scrollHeight - el.clientHeight)).toBe(
    0,
  );
  await page.getByRole("tab", { name: "Agents and the CLI" }).click();
  const panel = page.locator("#panel-agents");
  await expect(
    panel.getByText("Waiting for your agent to sign in."),
  ).toBeVisible();
  await panel.getByRole("tab", { name: "Command line" }).click();
  await expect(
    panel.getByText("uv tool install powerbi-metrics-book"),
  ).toBeVisible();
  const login = `pbmb login --url ${new URL(page.url()).origin}`;
  await expect(panel.getByText(login, { exact: true })).toBeVisible();
  const copies = panel.getByRole("button", { name: /^Copy / });
  await expect(copies).toHaveCount(3);
  for (const copy of await copies.all())
    await expect(copy).toContainText("Copy");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await panel.getByRole("button", { name: "Copy Sign it in" }).click();
  await expect(panel.getByRole("button", { name: "Copied" })).toContainText(
    "Copied",
  );
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(login);
});

test("the theme toggle switches the theme and keeps it", async ({ page }) => {
  await page.goto("/");
  const root = page.locator("html");
  const system = await page.evaluate(() =>
    matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );
  const other = system === "dark" ? "light" : "dark";
  await expect(root).not.toHaveAttribute("data-theme");

  await openColumn(page);
  await page
    .getByRole("button", { name: `Switch to the ${other} theme` })
    .click();
  await expect(root).toHaveAttribute("data-theme", other);
  const ground = await page.evaluate(
    () => getComputedStyle(document.body).backgroundColor,
  );
  expect(ground).toBe(
    other === "dark" ? "rgb(11, 13, 15)" : "rgb(246, 246, 244)",
  );

  await page.reload();
  await expect(root).toHaveAttribute("data-theme", other);
  await openColumn(page);
  await expect(
    page.getByRole("button", { name: `Switch to the ${system} theme` }),
  ).toBeVisible();
});

test("Metrics folds at the root of the first lane: its arrow folds the categories, and its name opens the metrics", async ({
  page,
}) => {
  await page.goto("/");
  await openColumn(page);
  const tree = page.getByRole("navigation", { name: "Catalog", exact: true });
  const sales = tree.getByRole("link", { name: "Sales", exact: true });
  await expect(sales).toHaveCount(0);
  await tree.getByRole("button", { name: "Open Metrics" }).click();
  await expect(sales).toBeVisible();
  await tree.getByRole("button", { name: "Close Metrics" }).click();
  await expect(sales).toHaveCount(0);
  await tree.getByRole("link", { name: "Metrics", exact: true }).click();
  await expect(page).toHaveURL(/\/catalog$/);
  await openColumn(page);
  await expect(sales).toBeVisible();
});

test("below 1024 pixels the first lane is a drawer that a link, Escape or a tap beside it closes", async ({
  page,
}) => {
  await page.goto("/catalog");
  const main = page.getByRole("navigation", { name: "Main" });
  if ((page.viewportSize()?.width ?? 0) >= 1024) {
    await expect(main).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Open the menu" }),
    ).toBeHidden();
    return;
  }
  await expect(main).toBeHidden();
  await openColumn(page);
  await expect(main).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(main).toBeHidden();
  await openColumn(page);
  await page.getByRole("button", { name: "Close the menu" }).click();
  await expect(main).toBeHidden();
  await openColumn(page);
  await main.getByRole("link", { name: "Terms", exact: true }).click();
  await expect(page).toHaveURL(/\/catalog\/terms$/);
  await expect(main).toBeHidden();
  // The link to the page already open changes no address, and still closes it.
  await openColumn(page);
  await main.getByRole("link", { name: "Terms", exact: true }).click();
  await expect(main).toBeHidden();
  // What the reader folded is still folded when the drawer opens again.
  await openColumn(page);
  await page.getByRole("button", { name: "Close Metrics" }).click();
  await page.keyboard.press("Escape");
  await expect(main).toBeHidden();
  await openColumn(page);
  await expect(
    page.getByRole("button", { name: "Open Metrics" }),
  ).toBeVisible();
});

test("on a landscape phone the whole lane scrolls, and the drawer opens again on the current row", async ({
  page,
}) => {
  const dataset = "/catalog/datasets/d1000000-0000-4000-8000-000000000001";
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto(dataset);
  await openColumn(page);
  const lane = page.getByRole("navigation", { name: "Main", exact: true });
  const tree = page.getByRole("navigation", { name: "Catalog", exact: true });
  // The dataset's own row; its tables' rows below it link to the same page.
  const current = tree.locator(`a[href="${dataset}?tab=diagram"]`);
  await expect(current).toBeInViewport({ ratio: 1 });
  await tree.getByRole("button", { name: "Open Metrics" }).click();
  // The tree has its full height rather than a sliver of its own to scroll in,
  // measured in one read once the categories it just opened have drawn.
  await expect(
    tree.locator('a[href="/catalog/categories/sales"]'),
  ).toBeVisible();
  const spare = await tree.evaluate((element) => {
    const room = element.parentElement?.getBoundingClientRect().height ?? 0;
    return room - element.getBoundingClientRect().height;
  });
  expect(spare).toBeGreaterThanOrEqual(0);
  // Shut with the row scrolled away, it comes back into view as the drawer opens.
  await lane.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(current).not.toBeInViewport({ ratio: 1 });
  await page.keyboard.press("Escape");
  await openColumn(page);
  await expect(current).toBeInViewport({ ratio: 1 });
  await tree.getByRole("link", { name: "Terms" }).click();
  await expect(page).toHaveURL(/\/catalog\/terms$/);
});

test("a page deeper than a lane's top has its breadcrumb, with every part but the last a link", async ({
  page,
}) => {
  const crumb = page.getByRole("navigation", { name: "Breadcrumb" });
  const main = page.getByRole("main");
  for (const [path, parts, links] of [
    ["/admin/pii", ["Settings", "PII"], ["Settings"]],
    ["/admin/powerbi", ["Settings", "Power BI"], ["Settings"]],
    // Settings opens on Connections, so there it would be a link to the page itself.
    ["/settings/connections", ["Settings", "Connections"], []],
    ["/catalog/terms/Channel", ["Terms", "Channel"], ["Terms"]],
    [
      "/catalog/categories/sales/orders",
      ["Metrics", "Sales", "Orders"],
      ["Metrics", "Sales"],
    ],
    [
      "/catalog/metrics/net_sales",
      ["Metrics", "Sales", "Net sales"],
      ["Metrics", "Sales"],
    ],
    ["/catalog?view=not-filed", ["Metrics", "Not filed"], ["Metrics"]],
    // Datasets are listed in the tree alone, so that part has no page to link to.
    [
      "/catalog/datasets/d1000000-0000-4000-8000-000000000005",
      ["Datasets", "Retail"],
      [],
    ],
  ] as const) {
    await page.goto(path);
    if (onPhone(page)) {
      // On a phone the breadcrumb is one link back to the nearest page above, and nothing when no page above is a link.
      await expect(crumb.getByRole("link")).toHaveText(links.slice(-1));
      await expect(crumb.getByRole("listitem")).toHaveCount(0);
      continue;
    }
    await expect(crumb.getByRole("listitem")).toHaveText([...parts]);
    await expect(crumb.getByRole("link")).toHaveText([...links]);
    await expect(crumb.locator('[aria-current="page"]')).toHaveText(
      parts.at(-1) ?? "",
    );
  }
  // A row of the first lane is a lane's top: Home, Metrics, Terms and Status.
  for (const path of ["/", "/catalog", "/catalog/terms", "/admin"]) {
    await page.goto(path);
    await expect(main.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await expect(crumb).toHaveCount(0);
  }
});

test("a long name in the breadcrumb gives way on one line, and shows whole on hover", async ({
  page,
}) => {
  const long = `Net sales ${"excluding returns and shipping ".repeat(8).trim()}`;
  await page.route("**/api/v1/metrics/net_sales", async (route) => {
    const answer = await route.fetch();
    await route.fulfill({
      response: answer,
      json: { ...((await answer.json()) as object), label: long },
    });
  });
  await page.goto("/catalog/metrics/net_sales");
  const crumb = page.getByRole("navigation", { name: "Breadcrumb" });
  if (onPhone(page)) {
    // The page's own name is the heading below; the breadcrumb is the link back, whole on its line.
    const back = crumb.getByRole("link");
    await expect(back).toHaveText(["Sales"]);
    expect(
      await back.evaluate((link) => link.scrollWidth > link.clientWidth),
    ).toBe(false);
    expect(await pastTheScreen(page)).toBe(0);
    return;
  }
  const here = crumb.locator('[aria-current="page"]');
  await expect(here).toHaveAttribute("title", long);
  const line = await crumb
    .getByRole("link", { name: "Metrics", exact: true })
    .boundingBox();
  const box = await crumb.boundingBox();
  expect(box?.height).toBeLessThanOrEqual((line?.height ?? 0) + 1);
  expect(
    await here.evaluate((part) => part.scrollWidth > part.clientWidth),
  ).toBe(true);
  // Only the page's own name gives way: the parts above it read whole.
  for (const part of await crumb.getByRole("link").all())
    expect(
      await part.evaluate((link) => link.scrollWidth > link.clientWidth),
    ).toBe(false);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBe(0);
});

test("a long category in the breadcrumb gives way after the page's own name, and the fixed words never do", async ({
  page,
}) => {
  const long = `Sales ${"excluding returns and shipping ".repeat(8).trim()}`;
  await page.route("**/api/v1/categories", async (route) => {
    const answer = await route.fetch();
    await route.fulfill({
      response: answer,
      json: JSON.parse(await answer.text(), (key, value: unknown) =>
        key === "name" ? long : value,
      ) as unknown,
    });
  });
  await page.route("**/api/v1/metrics/net_sales", async (route) => {
    const answer = await route.fetch();
    await route.fulfill({
      response: answer,
      json: { ...((await answer.json()) as object), label: long },
    });
  });
  await page.goto("/catalog/metrics/net_sales");
  const crumb = page.getByRole("navigation", { name: "Breadcrumb" });
  const category = crumb.getByRole("link", { name: long });
  await expect(category).toHaveAttribute("title", long);
  if (onPhone(page)) {
    // The one link back gives way on its line, and the page stays on the screen.
    const box = await category.boundingBox();
    const name = category.locator(":scope > span");
    expect(
      await name.evaluate((part) => part.scrollWidth > part.clientWidth),
    ).toBe(true);
    expect(box?.height).toBeLessThanOrEqual(24);
    expect(await pastTheScreen(page)).toBe(0);
    return;
  }
  const word = crumb.getByRole("link", { name: "Metrics", exact: true });
  const line = await word.boundingBox();
  const box = await crumb.boundingBox();
  expect(box?.height).toBeLessThanOrEqual((line?.height ?? 0) + 1);
  expect(
    await category.evaluate((link) => link.scrollWidth > link.clientWidth),
  ).toBe(true);
  expect(
    await word.evaluate((link) => link.scrollWidth > link.clientWidth),
  ).toBe(false);
  const here = await crumb.locator('[aria-current="page"]').boundingBox();
  expect(here?.width).toBeGreaterThanOrEqual(80);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBe(0);
});

test("a breadcrumb link shows the keyboard ring, with nothing around it clipping the ring", async ({
  page,
}) => {
  await page.goto("/catalog/metrics/net_sales");
  const crumb = page.getByRole("navigation", { name: "Breadcrumb" });
  const link = crumb.getByRole("link", { name: "Sales", exact: true });
  if (onPhone(page)) {
    // The phone's one link back: reached from the control before it, so the ring is the keyboard's.
    await link.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
  } else {
    await crumb.getByRole("link", { name: "Metrics", exact: true }).focus();
    await page.keyboard.press("Tab");
  }
  await expect(link).toBeFocused();
  const ring = await link.evaluate((element) => {
    const style = getComputedStyle(element);
    const clips: string[] = [];
    for (
      let around = element.parentElement;
      around !== null && around.tagName !== "NAV";
      around = around.parentElement
    )
      if (getComputedStyle(around).overflowX !== "visible")
        clips.push(around.tagName);
    return {
      shown: element.matches(":focus-visible"),
      style: style.outlineStyle,
      width: parseFloat(style.outlineWidth),
      clips,
    };
  });
  expect(ring).toEqual({ shown: true, style: "solid", width: 2, clips: [] });
});

test("a screen with one job has the plain header and no left lanes", async ({
  page,
}) => {
  await page.goto("/device");
  await expect(page.getByRole("banner").getByText(PEOPLE.admin)).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open the menu" })).toHaveCount(
    0,
  );
});

test("the sample data band shows on the mock tenant", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Sample data", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Move to your own tenant" }),
  ).toHaveAttribute(
    "href",
    "/docs/start/sample-tenant/#move-to-your-own-tenant",
  );
});

test("the saved sessions are a curator and a viewer with their roles", async ({
  browser,
}) => {
  for (const role of ["curator", "viewer"] as const) {
    const email = PEOPLE[role];
    const page = await (await contextAs(browser, role)).newPage();
    const me = await page.request.get("/api/v1/me");
    expect(await me.json()).toMatchObject({
      email,
      roles: expect.arrayContaining([role]),
    });
    await page.context().close();
  }
});

test.describe("signed out", () => {
  test.use({ signedInAs: null });
  test("the sign-in page carries the sample data band, and says who the dev sign-in lets in", async ({
    page,
  }) => {
    await page.goto("/sign-in");
    await expect(page.getByText("Sample data", { exact: true })).toBeVisible();
    await expect(
      page.getByText("needs Microsoft sign-in", { exact: false }),
    ).toBeVisible();
  });
});

test.describe(() => {
  // Its own session: signing out ends it, and the saved one stays for the rest.
  test.use({ signedInAs: null });
  test("signing out ends the session @once", async ({ page }) => {
    await signInAs(page, PEOPLE.admin);
    await page.goto("/");
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    // The sign-in page has no app header (docs/specs/2026-11-07-users-invites-and-branding.md).
    await expect(
      page.getByRole("heading", { name: "Sign in to Power BI Metrics Book" }),
    ).toBeVisible();
    await expect(page.getByRole("banner")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
    await expect(page.getByText(PEOPLE.admin)).toHaveCount(0);
    expect((await page.request.get("/api/v1/me")).status()).toBe(401);
  });
});
