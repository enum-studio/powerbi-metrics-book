import createClient from "openapi-fetch";
import type { paths } from "../src/api/schema";
import { read } from "../src/api/client";
import { folderPaths } from "../src/catalog/tree/folders";
import { expect, openColumn, test } from "./fixtures.ts";

test.use({ signedInAs: "admin" });

test("catalog fields have pages", async ({ page, baseURL }) => {
  const api = createClient<paths>({
    baseUrl: baseURL,
    fetch: async (request) => {
      const response = await page.request.get(request.url);
      return new Response(await response.text(), {
        status: response.status(),
        headers: response.headers(),
      });
    },
  });
  const find = async () => {
    const { items: datasets } = await read(
      api.GET("/api/v1/datasets", { params: { query: { limit: 200 } } }),
    );
    for (const { id } of datasets) {
      const { items: columns } = await read(
        api.GET("/api/v1/datasets/{id}/columns", {
          params: { path: { id }, query: { limit: 500 } },
        }),
      );
      const { items: measures } = await read(
        api.GET("/api/v1/datasets/{id}/measures", {
          params: { path: { id }, query: { limit: 500 } },
        }),
      );
      const nested = [...columns, ...measures].find((field) =>
        field.display_folder?.includes("\\"),
      );
      if (!nested) continue;
      for (const column of columns) {
        const context = await read(
          api.GET("/api/v1/datasets/{id}/columns/{column_id}", {
            params: { path: { id, column_id: column.id } },
          }),
        );
        if (context.relationships.length && context.used_by.length)
          return { id, nested, column };
      }
    }
    throw new Error(
      "The mock needs nested folders and a column in DAX and a relationship.",
    );
  };
  const { id, nested, column } = await find();
  await page.goto(`/catalog/datasets/${id}`);
  await openColumn(page);
  const tablePath = `/catalog/datasets/${id}/tables/${encodeURIComponent(nested.table.name)}`;
  await page
    .getByRole("navigation", { name: "Catalog" })
    .locator(`a[href="${tablePath}"]`)
    .click();
  const path =
    folderPaths(nested.display_folder).find((path) => path.length > 1) ?? [];
  await page
    .getByRole("navigation", { name: "Table" })
    .getByRole("button", {
      name: nested.kind === "measure" ? /^Measures/ : /^Columns/,
    })
    .click();
  await page
    .getByRole("table")
    .getByRole("link", { name: path.join(" / "), exact: true })
    .first()
    .click();
  await expect(page).toHaveURL(/\/folders\/.+%5C.+/);
  await page.goto(
    `/catalog/datasets/${id}/tables/${encodeURIComponent(column.table.name)}/columns/${encodeURIComponent(column.name)}`,
  );
  for (const name of [
    "Relationships",
    "Measures whose DAX names this column",
  ]) {
    await expect(
      page
        .getByRole("heading", { name, exact: true })
        .locator("..")
        .getByRole("link")
        .first(),
    ).toBeVisible();
  }
});
