import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { folderLevels, folderParam } from "../tree/folders";
import { FieldList, fieldsAt, type Field } from "./field-list";

const fields: Field[] = [
  { kind: "Column", name: "Year", display_folder: "Dates\\Fiscal" },
  { kind: "Column", name: "Amount", display_folder: null },
  { kind: "Measure", name: "Sales", display_folder: null },
  { kind: "Measure", name: "Profit", display_folder: "KPIs;Dates\\Fiscal" },
];

it("lists folders before measures before columns and folds columns through every level", () => {
  expect(fieldsAt(fields, []).map((field) => field.name)).toEqual([
    "Dates",
    "KPIs",
    "Sales",
    "Amount",
  ]);
  expect(fieldsAt(fields, ["Dates"]).map((field) => field.name)).toEqual([
    "Fiscal",
  ]);
  expect(
    fieldsAt(fields, ["Dates", "Fiscal"]).map((field) => field.name),
  ).toEqual(["Profit", "Year"]);
  expect(fieldsAt(fields, ["KPIs"]).map((field) => field.name)).toEqual([
    "Profit",
  ]);
});

it("keeps a folder path in one segment: slash, percent and dot levels round trip through the real router", async () => {
  const levels = ["In/Out", "Q1 % sales", "..", "Dates"];
  const root = createRootRoute({
    component: () => (
      <FieldList
        id="d1"
        table="Sales"
        path={["Dates"]}
        fields={[
          { kind: "Column", name: "Year", display_folder: "Dates\\Fiscal" },
          { kind: "Column", name: "Flow", display_folder: "Dates\\In/Out" },
          { kind: "Column", name: "Up", display_folder: "Dates\\.." },
        ]}
      />
    ),
  });
  const folder = createRoute({
    getParentRoute: () => root,
    path: "/catalog/datasets/$id/tables/$table/folders/$folder",
  });
  const prefix = "/catalog/datasets/d1/tables/Sales/folders/";
  const router = createRouter({
    routeTree: root.addChildren([folder]),
    history: createMemoryHistory({ initialEntries: [`${prefix}Dates`] }),
  });
  await router.load();
  const html = renderToStaticMarkup(<RouterProvider router={router} />);
  expect(html).toContain(`href="${prefix}Dates%5CFiscal"`);
  expect(html).toContain(`href="${prefix}Dates%5CIn%2FOut"`);
  expect(html).not.toContain("Dates%5C..");

  const { href } = router.buildLocation({
    to: "/catalog/datasets/$id/tables/$table/folders/$folder",
    params: { id: "d1", table: "Sales", folder: folderParam(levels) },
  });
  expect(href).toBe(`${prefix}In%2FOut%5CQ1%20%25%20sales%5C..%5CDates`);
  expect(href.slice(prefix.length)).not.toContain("/");
  const reopened = createRouter({
    routeTree: root.addChildren([folder]),
    history: createMemoryHistory({ initialEntries: [href] }),
  });
  await reopened.load();
  const params = reopened.state.matches.at(-1)?.params;
  expect(
    folderLevels(params && "folder" in params ? params.folder : ""),
  ).toEqual(levels);
});

it("shows a folder named .. as text, not a link", () => {
  const html = renderToStaticMarkup(
    <FieldList
      id="d1"
      table="Sales"
      path={[]}
      fields={[{ kind: "Measure", name: "Up", display_folder: "..\\admin" }]}
    />,
  );
  expect(html).not.toContain("href=");
  expect(html).toContain("..");
});

it("shows a column named .. as text, not a link", () => {
  const html = renderToStaticMarkup(
    <FieldList
      id="d1"
      table="Sales"
      path={[]}
      fields={[{ kind: "Column", name: "..", display_folder: null }]}
    />,
  );
  expect(html).not.toContain("href=");
  expect(html).toContain("..");
});
