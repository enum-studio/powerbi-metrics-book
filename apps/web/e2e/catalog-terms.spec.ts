import { expect, test } from "./fixtures.ts";

test.use({ signedInAs: "admin" });

test("the terms list opens Channel and its dataset diagram", async ({
  page,
}) => {
  await page.goto("/catalog/terms");
  await expect(page.getByRole("heading", { name: "Terms" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Channel/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Region/ })).toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: "Return" }),
  ).toBeVisible();
  await page.goto("/catalog/terms/Channel");
  await expect(
    page.getByText("'Channel'[Channel]", { exact: true }),
  ).toHaveCount(2);
  await expect(page.getByRole("heading", { name: "Columns 2" })).toBeVisible();
  await page
    .getByRole("listitem")
    .filter({ hasText: "Sales" })
    .getByRole("link", { name: "Show in the diagram" })
    .click();
  await expect(page).toHaveURL(
    /\/catalog\/datasets\/[^?]+\?tab=diagram&table=Channel/,
  );
  await expect(page.getByRole("heading", { name: "Sales" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Channel" })).toBeVisible();
  await page.goto("/catalog/terms/Channel");
  await expect(
    page
      .getByRole("region", { name: "Metrics 2" })
      .getByRole("link", { name: "Net sales", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Metrics 2" })
      .getByRole("link", { name: "Orders", exact: true }),
  ).toBeVisible();
});
