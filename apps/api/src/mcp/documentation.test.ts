import { expect, it } from "vitest";
import {
  checkInAnswer,
  documentationChunk,
  documentationRevision,
  metricDocument,
} from "./documentation.js";

it("pages Unicode and escaped text without losing a character or exceeding the answer budget", () => {
  const source = ('A😀漢字"\\\n\t' + String.fromCharCode(0)).repeat(10_000);
  let offset: number | null = 0;
  let assembled = "";
  while (offset !== null) {
    const chunk = documentationChunk(source, offset);
    expect(Buffer.byteLength(JSON.stringify(chunk.text))).toBeLessThanOrEqual(
      12_000,
    );
    expect(chunk.text.length).toBeGreaterThan(0);
    assembled += chunk.text;
    offset = chunk.next_offset;
  }
  expect(assembled).toBe(source);
  expect(documentationRevision(assembled)).toBe(documentationRevision(source));
  expect(documentationRevision(source + "changed")).not.toBe(
    documentationRevision(source),
  );
});

const metric = {
  kind: "metric",
  id: "metric-id",
  name: "sales",
  label: "Sales",
  icon: null,
  definition: "Sales",
  aliases: [],
  tier: "driver",
  importance: "high",
  direction: "higher_is_better",
  importance_why: "",
  use_for: "",
  dont_use_for: "",
  caveats: "",
  decisions: "",
  actions: "",
  owner_team: "",
  primary_dimensions: [],
  building_block: false,
  owner_person: {
    id: "person-id",
    name: "Current name",
    title: "Current title",
    left: false,
  },
  following: true,
  who_may_see: "",
  moves_with: [],
  edges: [],
  when_to_use: "",
  not_the_same_as: null,
  grain_and_filters: "",
  unit: null,
  category_id: null,
  category: null,
  owner: null,
  trust_state: "draft",
  verified_by: null,
  verified_by_name: null,
  verified_at: null,
  origin: "curator",
  name_is_generated: false,
  touched_at: null,
  dismissed_at: null,
  dismissed_reason: null,
  created_at: new Date(0),
  updated_at: new Date(0),
  custom: {},
  failing_checks: [],
  base_variants: [],
  other_variants: [],
  terms: [],
  owner_person_name: "Stale name",
  owner_person_title: "Stale title",
};

it("projects check-in and read documents before revisioning, without owner snapshots", () => {
  const projected = metricDocument(metric);
  const answer = checkInAnswer({
    items: [{ ...metric, page: "/metric", note: null, values: [] }],
    next_cursor: null,
  });
  expect(answer.items[0]).toMatchObject(projected);
  expect(JSON.stringify(answer)).not.toMatch(
    /Stale|owner_person_name|owner_person_title/,
  );
  expect(documentationRevision(JSON.stringify(projected))).toBe(
    documentationRevision(
      JSON.stringify(
        metricDocument({ ...metric, owner_person_name: "Changed snapshot" }),
      ),
    ),
  );
});

it("keeps an oversized check-in valid JSON with stored result references and a continuation", () => {
  const large = "漢字".repeat(250);
  const result = {
    result_id: "result-id",
    query_id: "query-id",
    preview: [["x".repeat(50_000)]],
  };
  const page = checkInAnswer({
    items: [
      {
        ...metric,
        name: large,
        tier: large,
        direction: large,
        page: "https://metrics.example/" + large,
        note: null,
        definition: "x".repeat(40_000),
        values: [
          { period: large, result },
          { period: large, result },
        ],
      },
    ],
    next_cursor: large,
  });
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(16 * 1024);
  expect(page.next_cursor).toBe(large);
  expect(page.items[0]?.values[0]).toMatchObject({
    result_id: "result-id",
    preview: [],
  });
  expect(page.items[0]).toHaveProperty("documentation_next_offset");
});
