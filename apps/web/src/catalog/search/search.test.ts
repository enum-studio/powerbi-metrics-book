import { describe, expect, it, vi } from "vitest";
import { groupSearchHits, hitPage, markWords, stepPage } from "./model";
import type { SearchHit } from "./model";

const hit = (kind: "metric" | "term" | "dataset", name: string) => ({
  kind,
  id: name,
  name,
  key: null,
  label: name,
  summary: `${name} summary`,
  dataset: null,
  trust_state: null,
  score: 1,
  match: "words" as const,
  path: [],
  icon: null,
  metric: null,
});

describe("groupSearchHits", () => {
  it("groups Metrics, Terms, Datasets in that order", () => {
    expect(
      groupSearchHits([
        hit("dataset", "Sales"),
        hit("term", "Channel"),
        hit("metric", "Net sales"),
      ]).map(({ label, hits }) => [label, hits.map((item) => item.name)]),
    ).toEqual([
      ["Metrics", ["Net sales"]],
      ["Terms", ["Channel"]],
      ["Datasets", ["Sales"]],
    ]);
  });
});

describe("markWords", () => {
  it("marks each searched word wherever it appears, in any case", () => {
    expect(markWords("Net sales less returns", "SALES ret")).toEqual([
      { text: "Net ", marked: false },
      { text: "sales", marked: true },
      { text: " less ", marked: false },
      { text: "ret", marked: true },
      { text: "urns", marked: false },
    ]);
  });

  it("takes a word as text, never as a pattern", () => {
    expect(markWords("a (b) c", "(b)")).toEqual([
      { text: "a ", marked: false },
      { text: "(b)", marked: true },
      { text: " c", marked: false },
    ]);
    expect(markWords("anything", ".*")).toEqual([
      { text: "anything", marked: false },
    ]);
  });

  it("marks nothing for a word of one letter", () => {
    expect(markWords("a sale", "a")).toEqual([
      { text: "a sale", marked: false },
    ]);
  });
});

vi.mock("@tanstack/react-router", () => ({
  linkOptions: (value: unknown) => value,
}));
const full = (over: Partial<SearchHit>): SearchHit => ({
  ...hit("metric", "x"),
  ...over,
});
const dataset = {
  kind: "dataset",
  id: "ds1",
  name: "Sales",
  key: null,
} as const;
const table = { kind: "table", id: "t1", name: "Orders", key: null } as const;
const commercial = {
  kind: "category",
  id: "c1",
  name: "Commercial",
  key: "commercial",
} as const;

describe("hitPage", () => {
  it("opens each kind on its own page", () => {
    expect(hitPage(full({ kind: "metric", name: "net_sales" }))).toMatchObject({
      to: "/catalog/metrics/$name",
      params: { name: "net_sales" },
    });
    expect(
      hitPage(
        full({
          kind: "variant",
          id: "v1",
          name: "Net sales EUR",
          metric: { name: "net_sales", label: "Net sales" },
        }),
      ),
    ).toMatchObject({
      params: { name: "net_sales" },
      search: { variant: "v1" },
    });
    expect(hitPage(full({ kind: "term", name: "Churn" }))).toMatchObject({
      to: "/catalog/terms/$term",
      params: { term: "Churn" },
    });
    expect(hitPage(full({ kind: "dataset", id: "ds1" }))).toMatchObject({
      to: "/catalog/datasets/$id",
      params: { id: "ds1" },
    });
    expect(
      hitPage(full({ kind: "table", name: "Orders", path: [dataset] })),
    ).toMatchObject({
      to: "/catalog/datasets/$id/tables/$table",
      params: { id: "ds1", table: "Orders" },
    });
    expect(
      hitPage(
        full({ kind: "column", name: "Date[Year]", path: [dataset, table] }),
      ),
    ).toMatchObject({
      params: { id: "ds1", table: "Orders", column: "Date[Year]" },
    });
  });

  it("opens a category by its key path, for a hit and for a step", () => {
    const category = full({
      kind: "category",
      name: "Revenue kept",
      key: "kept",
      path: [commercial],
    });
    expect(hitPage(category)).toMatchObject({
      to: "/catalog/categories/$",
      params: { _splat: "commercial/kept" },
    });
    const metric = full({
      kind: "metric",
      path: [
        commercial,
        { ...commercial, id: "c2", name: "Kept", key: "kept" },
      ],
    });
    expect(stepPage(metric, 1)).toMatchObject({
      params: { _splat: "commercial/kept" },
    });
  });

  it("builds no link for a dot name, which a browser would resolve as a step up", () => {
    const folders = (...names: string[]) =>
      names.map(
        (name) => ({ kind: "folder", id: name, name, key: null }) as const,
      );
    const dotted = full({
      kind: "variant",
      path: [dataset, table, ...folders("..", "..", "admin")],
    });
    expect(stepPage(dotted, 2)).toBeUndefined();
    expect(stepPage(dotted, 4)).toBeUndefined();
    const tidy = full({
      kind: "variant",
      path: [dataset, table, ...folders("In/Out", "Q1")],
    });
    expect(stepPage(tidy, 3)).toMatchObject({
      params: { id: "ds1", table: "Orders", folder: "In/Out\\Q1" },
    });
    const dotTable = { ...table, name: ".." };
    expect(
      hitPage(full({ kind: "table", name: "..", path: [dataset] })),
    ).toBeUndefined();
    expect(
      hitPage(
        full({ kind: "column", name: "Year", path: [dataset, dotTable] }),
      ),
    ).toBeUndefined();
    expect(
      hitPage(full({ kind: "column", name: ".", path: [dataset, table] })),
    ).toBeUndefined();
  });

  it("gives no link when the hit does not say where it is", () => {
    expect(hitPage(full({ kind: "variant", metric: null }))).toBeUndefined();
    expect(hitPage(full({ kind: "category", key: null }))).toBeUndefined();
    expect(hitPage(full({ kind: "table", path: [] }))).toBeUndefined();
    expect(hitPage(full({ kind: "column", path: [dataset] }))).toBeUndefined();
  });
});
