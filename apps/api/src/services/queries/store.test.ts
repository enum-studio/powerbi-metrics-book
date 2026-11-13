import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTestDeps, principals } from "../../../test/deps.js";
import { id, useMirror } from "../../../test/mirror-fixtures.js";
import { accessFrom, MemorySecrets } from "../../../test/doubles.js";
import { SETTINGS } from "../settings/registry.js";
import { createResultStore } from "./store.js";

const deps = createTestDeps({
  access: accessFrom(() => true),
  secrets: new MemorySecrets([["result_link_key", "test-result-link-key"]]),
});
const store = createResultStore(deps);
const owner = { ...principals.viewer, id: `owner-${randomUUID()}` };

useMirror();

const saved = (rows: unknown[][]) =>
  store.save(
    {
      query_id: randomUUID(),
      owner,
      dataset: { id: id.sales, name: "Sales" },
      columns: [{ name: "Note[Text]", type: "string" }],
      truncation_note: null,
      preview_rows: 20,
    },
    rows,
  );

const big = ["x".repeat(20 * 1024)];
const overOffset = (offset: number) =>
  `The row at offset ${String(offset)} is over 16 KiB alone, so it is left out here: download the result as CSV from csv_url, or get_result_csv_link.`;

describe("the result store", () => {
  it("never answers more than 16 KiB: a row over it alone is left out, and reading moves past it", async () => {
    const first = await saved([big, ["after"]]);
    expect(first).toMatchObject({
      preview: [],
      preview_note: overOffset(0),
      next_offset: 1,
    });
    const anchor = await saved([["before"], big, ["after"]]);
    expect(anchor).toMatchObject({
      preview: [["before"]],
      preview_note:
        "Stopped at 1 rows to stay under 16 KiB; read on from next_offset.",
      next_offset: 1,
    });
    const read = (offset: number) =>
      store.read(owner, anchor.result_id, { offset, limit: 500 });
    await expect(read(1)).resolves.toMatchObject({
      rows: [],
      note: overOffset(1),
      next_offset: 2,
    });
    await expect(read(2)).resolves.toMatchObject({
      rows: [["after"]],
      note: null,
      next_offset: null,
    });
  });

  it("reads at most 500 rows a page, the most results.page_rows_max may say", () => {
    const { schema } = SETTINGS["results.page_rows_max"];
    expect(schema.safeParse(500).success).toBe(true);
    expect(schema.safeParse(501).success).toBe(false);
  });

  it("refuses a result whose dataset row does not exist, as it does a missing result", async () => {
    const anchor = await store.save(
      {
        query_id: randomUUID(),
        owner,
        dataset: { id: randomUUID(), name: "Sales" },
        columns: [{ name: "Note[Text]", type: "string" }],
        truncation_note: null,
        preview_rows: 20,
      },
      [["a"]],
    );
    await expect(
      store.read(owner, anchor.result_id, { offset: 0, limit: 10 }),
    ).rejects.toMatchObject({ kind: "not_found", message: "No such result." });
  });

  it("deletes only the owner's result", async () => {
    const anchor = await saved([["private"]]);
    const read = () =>
      store.read(owner, anchor.result_id, { offset: 0, limit: 10 });
    await store.delete({ ...owner, id: `${owner.id}-other` }, anchor.result_id);
    await expect(read()).resolves.toMatchObject({ rows: [["private"]] });
    await store.delete(owner, anchor.result_id);
    await expect(read()).rejects.toMatchObject({ kind: "not_found" });
  });
});
