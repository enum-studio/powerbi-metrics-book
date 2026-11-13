import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTestDeps, principals } from "../../../test/deps.js";
import { id, useMirror } from "../../../test/mirror-fixtures.js";
import { accessFrom, MemorySecrets } from "../../../test/doubles.js";
import { resultCsv } from "./csv.js";
import { createResultStore } from "./store.js";

const deps = createTestDeps({
  access: accessFrom(() => true),
  secrets: new MemorySecrets([["result_link_key", "test-result-link-key"]]),
});
const owner = { ...principals.viewer, id: `owner-${randomUUID()}` };

useMirror();

describe("resultCsv", () => {
  it("defuses a cell or a header a spreadsheet would read as a formula", async () => {
    const anchor = await createResultStore(deps).save(
      {
        query_id: randomUUID(),
        owner,
        dataset: { id: id.sales, name: "Sales" },
        columns: [
          { name: "=Sales[Cell]", type: "string" },
          { name: "Sales[Amount]", type: "number" },
        ],
        truncation_note: null,
        preview_rows: 20,
      },
      [
        ['=HYPERLINK("https://example.com")', -12.5],
        ["+1", -1],
        ["-1", 0],
        ["@SUM(A1)", 1],
        ["\tTab", 2],
        ["\rReturn", 3],
        ["Plain, with a comma", 4],
      ],
    );
    let csv = "";
    for await (const line of resultCsv(
      { ...deps, principal: owner },
      anchor.result_id,
    ))
      csv += line;
    expect(csv).toBe(
      [
        `"'=Sales[Cell]",Sales[Amount]`,
        `"'=HYPERLINK(""https://example.com"")",-12.5`,
        `"'+1",-1`,
        `"'-1",0`,
        `"'@SUM(A1)",1`,
        `"'\tTab",2`,
        `"'\rReturn",3`,
        `"Plain, with a comma",4`,
        "",
      ].join("\r\n"),
    );
  });
});
