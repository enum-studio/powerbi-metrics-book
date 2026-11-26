import { readFile } from "node:fs/promises";
import { expect, test } from "./fixtures.ts";

test.use({ signedInAs: "admin" });

test("the sample guide reads on screen and exports the documented book", async ({
  page,
}, info) => {
  await page.goto("/catalog/guide");
  await expect(
    page.getByRole("heading", { name: "How the business works" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "One sum behind every number" }),
  ).toBeVisible();
  await expect(
    page.getByText("One metric up close", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "The glossary" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);

  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export Markdown", exact: true })
    .click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("metrics-guide.md");
  const path = info.outputPath("metrics-guide.md");
  await download.saveAs(path);
  const markdown = await readFile(path, "utf8");
  expect(markdown).toContain("Net sales");
  expect(markdown).toContain("profit");
  expect(markdown).toContain("Stock snapshot");
});

test("printing expands the guide in a light theme and restores the reading state", async ({
  page,
}, info) => {
  await page.goto("/catalog/guide");
  await expect(
    page.getByRole("heading", { name: "The glossary" }),
  ).toBeVisible();
  const initial = await page.evaluate(() => ({
    theme: document.documentElement.getAttribute("data-theme"),
    closed: document.querySelectorAll(".metrics-guide details:not([open])")
      .length,
  }));
  expect(initial.closed).toBeGreaterThan(0);
  await page.emulateMedia({ media: "print" });
  await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator(".metrics-guide details:not([open])")).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Export PDF", exact: true }),
  ).toBeHidden();
  await expect(
    page.getByRole("navigation", { name: "Main", exact: true }),
  ).toBeHidden();
  await page.screenshot({
    path: info.outputPath("guide-print.png"),
    fullPage: true,
  });
  await page.pdf({
    path: info.outputPath("guide.pdf"),
    format: "A4",
    printBackground: true,
  });
  // Restore explicitly as well: browsers differ on when afterprint fires for a saved PDF.
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await page.emulateMedia({ media: "screen" });
  expect(await page.locator("html").getAttribute("data-theme")).toBe(
    initial.theme,
  );
  await expect(page.locator(".metrics-guide details:not([open])")).toHaveCount(
    initial.closed,
  );
});
