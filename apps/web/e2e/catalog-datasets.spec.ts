import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

test.use({ signedInAs: "curator" });

const retail = "/catalog/datasets/d1000000-0000-4000-8000-000000000005";
const marketing = "/catalog/datasets/d1000000-0000-4000-8000-000000000003";
const archive = "/catalog/datasets/d1000000-0000-4000-8000-000000000004";

test("Retail draws 16 tables", async ({ page }) => {
  await page.goto(`${retail}?tab=diagram`);
  await expect(page.getByRole("heading", { name: "Retail" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Tables 16" })).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(16);
});

const accentOf = (page: Page) =>
  page.locator("html").evaluate((element) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--accent)";
    element.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });

test("hovering a relationship line changes its path stroke to the accent", async ({
  page,
}) => {
  await page.goto(`${retail}?tab=diagram`);
  await expect(page.locator(".react-flow__edge-path").first()).toBeVisible();
  // A point on a line where that line, not a table or a crossing line, is what
  // the pointer lands on.
  const lineUnderPointer = () =>
    page.evaluate(() => {
      for (const edge of document.querySelectorAll(".react-flow__edge")) {
        const interaction = edge.querySelector<SVGPathElement>(
          ".react-flow__edge-interaction",
        );
        const matrix = interaction?.getScreenCTM() ?? null;
        const id = edge.getAttribute("data-id");
        if (interaction === null || matrix === null || id === null) continue;
        const length = interaction.getTotalLength();
        for (let step = 1; step < 10; step++) {
          const at = interaction.getPointAtLength((length * step) / 10);
          const point = new DOMPoint(at.x, at.y).matrixTransform(matrix);
          const topmost = document.elementFromPoint(point.x, point.y);
          if (topmost !== null && edge.contains(topmost))
            return { id, x: point.x, y: point.y };
        }
      }
      return null;
    });
  const accent = await accentOf(page);
  // The diagram fits its viewport once the pane has its size, which can move
  // the lines after a point was measured: measure, hover and read again until
  // the hovered line is the one read.
  await expect(async () => {
    await page.mouse.move(0, 0);
    const target = await lineUnderPointer();
    if (target === null) throw new Error("No line is reachable by the pointer");
    await page.mouse.move(target.x, target.y);
    const path = page
      .locator(`.react-flow__edge[data-id="${target.id}"]`)
      .locator(".react-flow__edge-path");
    await expect
      .poll(
        () => path.evaluate((element) => getComputedStyle(element).stroke),
        { timeout: 1_000 },
      )
      .toBe(accent);
  }).toPass({ timeout: 15_000 });
});

test("hovering a connected table changes its relationship lines to the accent", async ({
  page,
}) => {
  await page.goto(`${retail}?tab=diagram`);
  const lines = page.locator(".react-flow__edge-path");
  await expect(lines.first()).toBeVisible();
  const accent = await accentOf(page);
  // As with the line above, the diagram fitting its viewport can move the table
  // from under the pointer: hover and read again.
  await expect(async () => {
    await page.mouse.move(0, 0);
    await page.locator('.react-flow__node[data-id="Budget"]').hover();
    await expect
      .poll(
        () =>
          lines.evaluateAll(
            (paths, accentColor) =>
              paths.filter(
                (path) => getComputedStyle(path).stroke === accentColor,
              ).length,
            accent,
          ),
        { timeout: 1_000 },
      )
      .toBeGreaterThan(0);
  }).toPass({ timeout: 15_000 });
});

test('clicking a relationship opens its "Many to one" panel', async ({
  page,
}) => {
  await page.goto(`${retail}?tab=diagram`);
  await page
    .locator(".react-flow__edge")
    .first()
    .locator(".react-flow__edge-interaction")
    .click();
  await expect(
    page.getByRole("heading", { name: "Relationship" }),
  ).toBeVisible();
  await expect(page.getByText("Many to one", { exact: true })).toBeVisible();
});

test("clicking Order lines lists its relationships in the panel", async ({
  page,
}) => {
  await page.goto(`${retail}?tab=diagram`);
  await page.locator('.react-flow__node[data-id="Order lines"]').click();
  await expect(
    page.getByRole("heading", { name: "Order lines" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /^Relationships \d+$/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: / to / }).first(),
  ).toBeVisible();
});

test("?table=Order lines selects the table and keeps it in the viewport", async ({
  page,
}) => {
  await page.goto(`${retail}?tab=diagram&table=Order%20lines`);
  await expect(
    page.getByRole("heading", { name: "Order lines" }),
  ).toBeVisible();
  const node = page.locator('.react-flow__node[data-id="Order lines"]');
  await expect(node).toBeVisible();
  const pane = page.locator(".react-flow__pane");
  const [nodeBox, paneBox] = await Promise.all([
    node.boundingBox(),
    pane.boundingBox(),
  ]);
  expect(nodeBox).not.toBeNull();
  expect(paneBox).not.toBeNull();
  if (nodeBox === null || paneBox === null)
    throw new Error("Diagram geometry was unavailable");
  expect(nodeBox.x + nodeBox.width).toBeGreaterThan(paneBox.x);
  expect(nodeBox.x).toBeLessThan(paneBox.x + paneBox.width);
  expect(nodeBox.y + nodeBox.height).toBeGreaterThan(paneBox.y);
  expect(nodeBox.y).toBeLessThan(paneBox.y + paneBox.height);
});

test("Marketing renders the unknown relationships state", async ({ page }) => {
  await page.goto(`${marketing}?tab=diagram`);
  await expect(page.getByRole("heading", { name: "Marketing" })).toBeVisible();
  await expect(page.getByText("No lines drawn.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Relationships unknown" }),
  ).toBeVisible();
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
});

test.describe("admin dataset visibility", () => {
  test.use({ signedInAs: "admin" });

  test("Campaign archive explains that there are no tables to draw", async ({
    page,
  }) => {
    await page.goto(`${archive}?tab=diagram`);
    await expect(
      page.getByRole("heading", { name: "No tables to draw" }),
    ).toBeVisible();
  });
});

test.describe("a dataset the reader cannot see", () => {
  test.use({ signedInAs: "viewer" });

  test("answers exactly like one that does not exist, with no breadcrumb", async ({
    page,
  }) => {
    const shown = async (address: string) => {
      await page.goto(address);
      const main = page.getByRole("main");
      await expect(
        main.getByRole("heading", { name: "Something went wrong" }),
      ).toBeVisible();
      // The tree beside the page loads on its own, and the comparison reads it too.
      await page.waitForLoadState("networkidle");
      await expect(
        page.getByRole("navigation", { name: "Breadcrumb" }),
      ).toHaveCount(0);
      return await main.innerText();
    };
    expect(await shown(marketing)).toBe(
      await shown(`/catalog/datasets/${randomUUID()}`),
    );
  });
});

test("a phone defaults to the Relationships tab", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(retail);
  await expect(
    page.getByRole("button", { name: "Relationships 20" }),
  ).toHaveClass(/border-accent/);
});

test("Escape clears the selected table", async ({ page }) => {
  await page.goto(`${retail}?tab=diagram`);
  await page.locator('.react-flow__node[data-id="Order lines"]').click();
  await expect(
    page.getByRole("heading", { name: "Order lines" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Order lines" })).toHaveCount(
    0,
  );
});

test("clicking a table puts it in the address, and drops a field of the table before", async ({
  page,
}) => {
  await page.goto(`${retail}?tab=diagram&table=Order%20lines&field=Quantity`);
  await expect(
    page.getByRole("heading", { name: "Order lines", exact: true }),
  ).toBeVisible();
  await page.locator('.react-flow__node[data-id="Stock"]').click();
  await expect(
    page.getByRole("heading", { name: "Stock", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/[?&]table=Stock(&|$)/);
  await expect(page).not.toHaveURL(/[?&]field=/);
});

test("Escape on the Tables tab leaves the table and field in the address and marked", async ({
  page,
}) => {
  await page.goto(`${retail}?tab=tables&table=Order%20lines&field=Quantity`);
  const field = page.getByRole("main").locator('a[title="Quantity"]');
  await expect(field).toHaveAttribute("data-status", "active");
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/[?&]field=Quantity(&|$)/);
  await expect(page).toHaveURL(/[?&]table=Order(\+|%20)lines(&|$)/);
  await expect(field).toHaveAttribute("data-status", "active");
});

test("Escape that closes the search dialog leaves the diagram's selection", async ({
  page,
}) => {
  await page.goto(`${retail}?tab=diagram&table=Order%20lines`);
  const panel = page.getByRole("heading", { name: "Order lines", exact: true });
  await expect(panel).toBeVisible();
  await page.keyboard.press("/");
  const search = page.getByRole("combobox", { name: "Search the catalog" });
  await expect(search).toBeFocused();
  await search.press("Escape");
  await expect(search).toBeHidden();
  await expect(panel).toBeVisible();
  await expect(page).toHaveURL(/[?&]table=Order(\+|%20)lines(&|$)/);
});

test("on a phone, Escape that closes the menu leaves the diagram's selection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${retail}?tab=diagram&table=Order%20lines`);
  const panel = page.getByRole("heading", { name: "Order lines", exact: true });
  await expect(panel).toBeVisible();
  await page.getByRole("button", { name: "Open the menu" }).click();
  await expect(
    page.getByRole("button", { name: "Close the menu" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Close the menu" }),
  ).toBeHidden();
  await expect(panel).toBeVisible();
  await expect(page).toHaveURL(/[?&]table=Order(\+|%20)lines(&|$)/);
});

test("the Relationships tab lists 20 relationships", async ({ page }) => {
  await page.goto(`${retail}?tab=relationships`);
  await expect(
    page.getByRole("button", { name: "Relationships 20" }),
  ).toBeVisible();
  await expect(
    page.getByText("'Order lines'[", { exact: false }).first(),
  ).toBeVisible();
});

test("dataset pages produce no CSP violation in the console", async ({
  page,
}) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      message.text().toLowerCase().includes("content security policy")
    )
      violations.push(message.text());
  });
  for (const path of [`${retail}?tab=diagram`, `${marketing}?tab=diagram`]) {
    await page.goto(path);
    await expect(page.locator("main")).toBeVisible();
  }
  expect(violations).toEqual([]);
});
