import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  appReader,
  asPerson,
  id,
  outsider,
  rolledBack,
  useMirror,
} from "../../../test/mirror-fixtures.js";
import { piiRule } from "../../db/schema/pii.js";
import { NO_SUCH_DATASET } from "../../errors.js";
import * as mirror from "./read.js";

useMirror();

it("hides PII relationship ends and column names, and counts the omitted joins", () =>
  rolledBack(async (tx) => {
    await tx.insert(piiRule).values({
      kind: "column",
      table_name: "Sales",
      name: "Order date",
      pii: true,
      set_by_kind: "person",
      set_by_id: "x",
      set_via: "api",
    });
    const context = asPerson(appReader, { db: tx });
    expect(
      await mirror.listRelationships(context, { dataset: id.sales }),
    ).toMatchObject({ items: [], total: 0, pii_hidden: 1, next_cursor: null });
    const detail = await mirror.getDataset(context, id.sales);
    expect(detail.tables.find((t) => t.name === "Sales")?.column_names).toEqual(
      ["Channel"],
    );
    expect(detail.date_tables).toEqual([]);
    const reader = asPerson(
      { ...appReader, roles: ["pii_reader"] },
      { db: tx },
    );
    const shown = await mirror.listRelationships(reader, { dataset: id.sales });
    expect(shown.items).toHaveLength(1);
    expect(shown.pii_hidden).toBeUndefined();
    expect(
      (await mirror.getDataset(reader, id.sales)).tables.find(
        (t) => t.name === "Sales",
      )?.column_names,
    ).toContain("Order date");
  }));

it("answers a refused dataset exactly like a missing one and getDataset", async () => {
  for (const dataset of [id.sales, "Sales", randomUUID()]) {
    for (const lookup of [
      () => mirror.listRelationships(asPerson(outsider), { dataset }),
      () => mirror.getDataset(asPerson(outsider), dataset),
    ]) {
      await expect(lookup()).rejects.toMatchObject({
        kind: "not_found",
        message: NO_SUCH_DATASET,
      });
    }
  }
});
