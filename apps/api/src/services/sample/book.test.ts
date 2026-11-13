import assert from "node:assert/strict";
import { test } from "vitest";
import { CATEGORIES, MERGES, METRICS, TERMS } from "./book.js";

const paths = new Set(CATEGORIES.map((each) => each.path));

test("every seeded metric's category path is in the seeded tree", () => {
  for (const { name, category } of METRICS)
    assert.ok(paths.has(category), `${name} is filed in ${category}`);
});

test("the category list is a valid tree, parents before their children", () => {
  const seen = new Set<string>();
  for (const { path } of CATEGORIES) {
    const parent = path.split("/").slice(0, -1).join("/");
    assert.ok(
      parent === "" || seen.has(parent),
      `${path} comes after ${parent}`,
    );
    assert.ok(!seen.has(path), `${path} is listed once`);
    seen.add(path);
  }
});

test("metric names and term names are each listed once", () => {
  for (const list of [METRICS.map((m) => m.name), TERMS.map((t) => t.name)])
    assert.equal(new Set(list).size, list.length);
});

test("every related metric is seeded", () => {
  const metricNames = new Set(METRICS.map((metric) => metric.name));
  for (const term of TERMS)
    for (const metric of term.metrics)
      assert.ok(metricNames.has(metric), `${term.name} relates to ${metric}`);
});

test("a merge frees the key a seeded metric then takes", () => {
  const seeded = new Set(METRICS.map((metric) => metric.name));
  for (const { from, into } of MERGES) {
    assert.ok(seeded.has(into), `${into} is seeded`);
    const taking = METRICS.find((metric) => metric.name === from);
    assert.ok(taking?.from !== undefined, `${from} is renamed from a draft`);
  }
});

test("Return keeps no column, so it stays a concept", () => {
  const term = TERMS.find((each) => each.name === "Return");
  assert.equal(term?.columns, undefined);
});

test("no seeded metric sets trust: the api does", () => {
  for (const metric of METRICS) assert.ok(!("trust_state" in metric));
});
