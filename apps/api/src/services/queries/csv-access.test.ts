import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  cerbosAccess,
  createTestDeps,
  principals,
} from "../../../test/deps.js";
import { MemorySecrets, MemorySettings } from "../../../test/doubles.js";
import { id, rolledBack, useMirror } from "../../../test/mirror-fixtures.js";
import { setEnabled } from "../admin/datasets.js";
import { downloadCsv } from "./csv-access.js";
import { createResultStore } from "./store.js";

useMirror();

const owner = { ...principals.viewer, id: `owner-${randomUUID()}` };

async function textOf(stream: ReadableStream<Uint8Array>) {
  let text = "";
  for await (const chunk of stream) text += new TextDecoder().decode(chunk);
  return text;
}

describe("downloading the CSV of a result of a dataset that is turned off", () => {
  it("is refused as for a missing result, and works again once the dataset is on", async () => {
    await rolledBack(async (tx) => {
      const deps = createTestDeps({
        db: tx,
        access: cerbosAccess(new MemorySettings()),
        secrets: new MemorySecrets([
          ["result_link_key", "test-result-link-key"],
        ]),
      });
      const anchor = await createResultStore(deps).save(
        {
          query_id: randomUUID(),
          owner,
          dataset: { id: id.sales, name: "Sales" },
          columns: [{ name: "Date[Year]", type: "number" }],
          truncation_note: null,
          preview_rows: 20,
        },
        [[2025], [2026]],
      );
      const download = () =>
        downloadCsv(deps, {
          result: anchor.result_id,
          link: {},
          credential: owner,
          address: null,
        });
      const admin = { ...deps, principal: principals.admin };

      expect(await textOf(await download())).toContain("2026");

      await setEnabled(admin, id.sales, false);
      await expect(download()).rejects.toMatchObject({
        kind: "not_found",
        message: "No such result.",
      });

      await setEnabled(admin, id.sales, true);
      expect(await textOf(await download())).toContain("2026");
    });
  });
});
