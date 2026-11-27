// Build fixed sample replies for the context guide. No deployment or credentials required.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { metricAnchor, metricDetail } from "../../api/src/mcp/anchors.ts";
import { toolAnswer } from "../../api/src/mcp/result.ts";
import { METRICS } from "../../api/src/services/sample/book.ts";
import { readingContent } from "../../api/src/services/sample/reading-content.ts";
import { excerpt } from "../../api/src/services/text.ts";
import { salesRows } from "../../../packages/powerbi-mock/src/sample/rows.ts";

// A live catalog assigns random UUIDs. Use stable values so counts can be repeated.
function id(name) {
  const hex = createHash("sha256").update(name).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    "4" + hex.slice(13, 16),
    "8" + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join("-");
}

function reply(payload) {
  const blocks = toolAnswer(payload).content;
  assert.equal(blocks.length, 1);
  assert.deepEqual(JSON.parse(blocks[0].text), payload);
  return blocks[0].text;
}

const dataset = { id: id("Sales"), name: "Sales" };
const records = METRICS.filter((m) => m.category.split("/")[0] === "sales")
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((m) => {
    const notes = readingContent(["Sales", m.label]);
    const summary = excerpt(m.definition, 240);
    return {
      ...m,
      ...notes,
      category: m.category,
      id: id(m.name),
      summary: summary.text,
      summary_truncated: summary.truncated,
      dataset_count: 1,
      trust_state: "draft",
      base_variants: [
        {
          id: id(m.name + "/base"),
          dataset,
          measure: m.label,
          measure_reference: "[" + m.label + "]",
        },
      ],
    };
  });
const page = (items) => ({ total: items.length, items, next_cursor: null });
const selected = records.find((m) => m.name === "net_sales");
assert.ok(selected);
const metrics = {
  count: records.length,
  full_list: reply(page(records.map(metricDetail))),
  short_list: reply(page(records.map(metricAnchor))),
  one_detail: reply(metricDetail(selected)),
};

const columns = [
  { name: "Order id", type: "number" },
  { name: "Order line", type: "number" },
  { name: "Date", type: "datetime" },
  { name: "Quantity", type: "number" },
  { name: "Net amount", type: "number" },
];
const sales = salesRows().map((row) => columns.map(({ name }) => row[name]));
const resultId = id("result");
const signature = createHash("sha256")
  .update("sample link")
  .digest("base64url");
function queryResult(count) {
  const rows = sales.slice(0, count);
  const bytes = rows.reduce(
    (sum, row) => sum + Buffer.byteLength(JSON.stringify(row)),
    0,
  );
  // Same fields as the result store. Fixed timestamps and an inert, signed-length URL.
  function envelope(limit) {
    return {
      result_id: resultId,
      query_id: id("query"),
      dataset,
      columns,
      row_count: rows.length,
      bytes,
      truncated: false,
      truncation_note: null,
      preview: rows.slice(0, limit),
      preview_note: null,
      next_offset: limit < rows.length ? limit : null,
      csv_url:
        "https://sample.invalid/api/v1/results/" +
        resultId +
        "/csv?expires=1790000900&signature=" +
        signature,
      csv_url_expires_at: "2026-09-21T14:28:20.000Z",
      expires_at: "2026-09-22T14:13:20.000Z",
    };
  }
  return {
    count,
    inline: JSON.stringify(envelope(count)),
    preview: reply(envelope(20)),
    download_only: reply(envelope(0)),
  };
}
assert.ok(sales.length > 1000);
console.log(
  JSON.stringify({
    metrics,
    results: [100, 1000, sales.length].map(queryResult),
  }),
);
