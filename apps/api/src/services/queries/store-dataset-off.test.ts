import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  cerbosAccess,
  createTestDeps,
  principals,
} from "../../../test/deps.js";
import { MemorySecrets, MemorySettings } from "../../../test/doubles.js";
import { id, rolledBack, useMirror } from "../../../test/mirror-fixtures.js";
import type { Db } from "../../context.js";
import { setEnabled } from "../admin/datasets.js";
import { createResultStore } from "./store.js";

useMirror();

const owner = { ...principals.viewer, id: `owner-${randomUUID()}` };

function inSales(db: Db) {
  const deps = createTestDeps({
    db,
    access: cerbosAccess(new MemorySettings()),
    secrets: new MemorySecrets([["result_link_key", "test-result-link-key"]]),
  });
  const store = createResultStore(deps);
  const saved = () =>
    store.save(
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
  const switchTo = (enabled: boolean) =>
    setEnabled({ ...deps, principal: principals.admin }, id.sales, enabled);
  return { store, saved, switchTo };
}

describe("a stored result of a dataset that is turned off", () => {
  it("is not readable by its owner, and is again once the dataset is on", async () => {
    await rolledBack(async (tx) => {
      const { store, saved, switchTo } = inSales(tx);
      const anchor = await saved();
      const range = { offset: 0, limit: 10 };
      await expect(
        store.read(owner, anchor.result_id, range),
      ).resolves.toMatchObject({ row_count: 2 });

      await switchTo(false);
      await expect(
        store.read(owner, anchor.result_id, range),
      ).rejects.toMatchObject({
        kind: "not_found",
        message: "No such result.",
      });

      await switchTo(true);
      await expect(
        store.read(owner, anchor.result_id, range),
      ).resolves.toMatchObject({ rows: [[2025], [2026]] });
    });
  });
});
