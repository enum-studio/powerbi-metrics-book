import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

const titles = (page: Page) => page.locator("summary span span:first-child");

test.describe("a viewer", () => {
  test.use({ signedInAs: "viewer" });

  test("is asked only for what a viewer can do", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /Finish setup/ }).click();
    await expect(
      page.getByRole("dialog", { name: "Finish setup" }),
    ).toBeVisible();
    await expect(
      titles(page).filter({ hasText: "Ask your agent" }),
    ).toBeVisible();
    await expect(titles(page).filter({ hasText: "drafts" })).toHaveCount(0);
    await expect(titles(page).filter({ hasText: "colleagues" })).toHaveCount(0);
    await expect(page.getByText("When you want more")).toHaveCount(0);
  });

  test("finds the steps to connect an agent, and they name this stack", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /Finish setup/ }).click();
    const steps = page.locator("details").filter({
      has: page.getByRole("tablist", {
        name: "Your agent",
        includeHidden: true,
      }),
    });
    // Unfolded or not depends on whether this person has connected Power BI yet.
    await steps.evaluate((details: HTMLDetailsElement) => {
      details.open = true;
    });
    await steps.getByRole("tab", { name: "Command line" }).click();
    await expect(
      steps.getByText(`pbmb login --url ${new URL(page.url()).origin}`),
    ).toBeVisible();
  });
});

test.describe("a curator", () => {
  test.use({ signedInAs: "curator" });

  test("is also asked to structure the drafts, in words that name no metric", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /Finish setup/ }).click();
    await titles(page)
      .filter({ hasText: /structuring your drafts/ })
      .click();
    await expect(
      page.getByText("Run pbmb curate and follow what it prints."),
    ).toBeVisible();
    await expect(titles(page).filter({ hasText: "colleagues" })).toHaveCount(0);
  });
});

test.describe("an admin", () => {
  test.use({ signedInAs: "admin" });

  test("is also asked to invite colleagues, and offered the optional settings", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /Finish setup/ }).click();
    await expect(
      titles(page).filter({ hasText: "Invite your colleagues" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Authentication" }),
    ).toHaveAttribute("href", "/admin/sign-in");
  });
});

test.describe("search on Home", () => {
  test.use({ signedInAs: "admin" });

  // Once: it sets its own width, and each run spends the admin's search budget, which every size and theme shares.
  test("shows a best match and sections, narrows by type, and opens a column hit @once", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    const box = page.getByRole("searchbox", { name: "Search the catalog" });
    await box.fill("sales");
    await expect(page).toHaveURL(/q=sales/);
    await expect(
      page.getByRole("heading", { name: "Best match" }),
    ).toBeVisible();
    await expect(
      page.locator("summary").filter({ hasText: /^Metrics \(\d+\)/ }),
    ).toBeVisible();

    await page.getByLabel("Type").selectOption("column");
    await expect(page).toHaveURL(/kind=column/);
    await expect(
      page.locator("summary").filter({ hasText: /^Metrics/ }),
    ).toHaveCount(0);
    await page.locator("[data-search-row]").first().click();
    await expect(page).toHaveURL(/\/catalog\/datasets\/.+\/tables\/.+/);
  });
});
