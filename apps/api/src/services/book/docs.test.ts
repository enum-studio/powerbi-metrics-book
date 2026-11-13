import { NO_SUCH_DATASET } from "../../errors.js";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  appReader,
  asPerson,
  id,
  outsider,
  reaching,
  rolledBack,
  useMirror,
} from "../../../test/mirror-fixtures.js";
import type { Db } from "../../context.js";
import { bookChange } from "../../db/schema/book.js";
import { powerbiDataset } from "../../db/schema/mirror.js";
import { piiRule } from "../../db/schema/pii.js";
import type { Principal } from "../../principal.js";
import { setConventionsAsAdmin } from "../conventions/service.js";
import { getDocs, setDocs } from "./docs.js";

useMirror();

const curator = reaching({ powerbi_app_ids: [id.sales_app] }, "curator");
const as = (tx: Db, principal: Principal = curator) =>
  asPerson(principal, { db: tx });

/** What appReader reaches, one element of each kind, and what it does not. */
const shown = {
  workspace: id.sales_workspace,
  app: id.sales_app,
  dataset: id.sales,
  table: id.sales_table,
  column: id.channel,
  measure: id.net_sales,
};
const hidden = {
  workspace: id.finance_workspace,
  app: id.leadership_app,
  dataset: id.finance,
  table: id.finance_table,
  column: id.margin,
  measure: id.profit,
};

describe("getDocs", () => {
  it("gives our description beside Power BI's, who wrote ours and the custom fields", async () => {
    const context = asPerson(appReader);
    expect(await getDocs(context, { kind: "dataset", id: id.sales })).toEqual({
      element: { kind: "dataset", id: id.sales, name: "Sales" },
      description: "Every order line since 2024.",
      description_pbi: "Orders and revenue.",
      described_by: null,
      described_at: null,
      custom: { tier: "gold" },
    });
    expect(
      await getDocs(context, { kind: "column", id: id.order_date }),
    ).toMatchObject({
      description: null,
      description_pbi: "When the order was placed.",
    });
    expect(
      await getDocs(context, { kind: "workspace", id: id.sales_workspace }),
    ).toMatchObject({ description: null, description_pbi: null });
  });

  it("answers an element the caller may not describe exactly like one that does not exist", async () => {
    const answer = (principal: Principal, kind: string, element: string) =>
      getDocs(asPerson(principal), { kind, id: element }).catch(
        (error: unknown) => error,
      );
    for (const [kind, element] of Object.entries(hidden)) {
      const missing = await answer(appReader, kind, randomUUID());
      expect(missing).toMatchObject({
        kind: "not_found",
        message: kind === "dataset" ? NO_SUCH_DATASET : `No such ${kind}.`,
      });
      expect(await answer(appReader, kind, element)).toEqual(missing);
    }
    for (const [kind, element] of Object.entries(shown)) {
      expect(await answer(outsider, kind, element)).toMatchObject({
        kind: "not_found",
      });
    }
  });

  it("refuses a kind that has no documentation", async () => {
    await expect(
      getDocs(asPerson(appReader), { kind: "relationship", id: id.sales }),
    ).rejects.toMatchObject({ kind: "invalid" });
  });
});

describe("setDocs", () => {
  it("writes our description on each kind, leaves Power BI's, and records who and what changed", () =>
    rolledBack(async (tx) => {
      const context = as(tx);
      for (const [kind, element] of Object.entries(shown)) {
        const before = await getDocs(context, { kind, id: element });
        const after = await setDocs(
          context,
          { kind, id: element },
          { description: `  Our ${kind}.  ` },
        );
        expect(after).toMatchObject({
          description: `Our ${kind}.`,
          description_pbi: before.description_pbi,
          described_by: "test-curator",
          custom: before.custom,
        });
        expect(after.described_at).toBeInstanceOf(Date);
        expect(await getDocs(context, { kind, id: element })).toEqual(after);
      }
      const changes = await tx
        .select()
        .from(bookChange)
        .where(
          and(
            eq(bookChange.action, "docs"),
            inArray(bookChange.element_id, Object.values(shown)),
          ),
        )
        .orderBy(asc(bookChange.id));
      expect(changes.map((row) => row.element_kind)).toEqual(
        Object.keys(shown),
      );
      expect(changes[2]).toMatchObject({
        element_id: id.sales,
        before: { description: "Every order line since 2024." },
        after: { description: "Our dataset.", described_by: "test-curator" },
      });
    }));

  it("clears a description with a blank, and writes nothing when nothing changes", () =>
    rolledBack(async (tx) => {
      const context = as(tx);
      const element = { kind: "dataset", id: id.sales };
      expect(
        await setDocs(context, element, { description: " " }),
      ).toMatchObject({ description: null });
      await setDocs(context, element, { description: null });
      await setDocs(context, element, {});
      const changes = await tx
        .select()
        .from(bookChange)
        .where(
          and(
            eq(bookChange.action, "docs"),
            eq(bookChange.element_id, id.sales),
          ),
        );
      expect(changes).toHaveLength(1);
    }));

  it("refuses a viewer, who may describe the dataset, and answers a curator who may not like a missing one", () =>
    rolledBack(async (tx) => {
      const element = { kind: "dataset", id: id.sales };
      await expect(
        setDocs(
          as(tx, reaching({ powerbi_app_ids: [id.sales_app] })),
          element,
          {
            description: "Mine.",
          },
        ),
      ).rejects.toMatchObject({ kind: "refused" });
      await expect(
        setDocs(as(tx, reaching({}, "curator")), element, {
          description: "Mine.",
        }),
      ).rejects.toMatchObject({
        kind: "not_found",
        message: NO_SUCH_DATASET,
      });
      const [row] = await tx
        .select({ description: powerbiDataset.description })
        .from(powerbiDataset)
        .where(eq(powerbiDataset.id, id.sales));
      expect(row?.description).toBe("Every order line since 2024.");
    }));

  it("checks the custom fields against element_fields, and replaces them whole", () =>
    rolledBack(async (tx) => {
      const admin = as(
        tx,
        reaching({ powerbi_app_ids: [id.sales_app] }, "admin"),
      );
      await setConventionsAsAdmin(admin, {
        element_fields: {
          custom: [
            {
              key: "tier",
              label: "Tier",
              type: "choice",
              values: ["gold", "silver"],
            },
            {
              key: "owner_team",
              label: "Owner team",
              type: "text",
              required: true,
            },
          ],
        },
      });
      const context = as(tx);
      const element = { kind: "dataset", id: id.sales };
      await expect(
        setDocs(context, element, { custom: { tier: "bronze" } }),
      ).rejects.toThrow("Tier (tier) must be one of gold, silver.");
      await expect(
        setDocs(context, element, { custom: { tier: "gold", mood: "calm" } }),
      ).rejects.toThrow("mood is not a custom field the conventions name.");
      // The required owner_team is for the checks to report, not a reason to refuse.
      const written = await setDocs(context, element, {
        custom: { tier: "silver" },
      });
      expect(written.custom).toEqual({ tier: "silver" });
      expect(
        (await setDocs(context, element, { custom: { owner_team: "Finance" } }))
          .custom,
      ).toEqual({ owner_team: "Finance" });
    }));
});

describe("docs of PII elements", () => {
  const by = { set_by_kind: "person", set_by_id: "x", set_via: "api" };
  const rules = (tx: Db) =>
    tx.insert(piiRule).values([
      {
        kind: "column",
        table_name: "sales",
        name: "CHANNEL",
        pii: true,
        ...by,
      },
      {
        kind: "measure",
        table_name: "Sales",
        name: "net sales",
        pii: true,
        ...by,
      },
    ]);
  const reader = { ...curator, roles: [...curator.roles, "pii_reader"] };

  it("answers a PII column or measure like a missing one, for reads and writes", () =>
    rolledBack(async (tx) => {
      await rules(tx);
      for (const element of [
        { kind: "column", id: id.channel },
        { kind: "measure", id: id.net_sales },
      ]) {
        await expect(getDocs(as(tx), element)).rejects.toMatchObject({
          kind: "not_found",
        });
        await expect(
          setDocs(as(tx), element, { description: "x" }),
        ).rejects.toMatchObject({ kind: "not_found" });
      }
      expect(
        await getDocs(as(tx), { kind: "column", id: id.order_date }),
      ).toMatchObject({ element: { name: "Order date" } });
    }));

  it("answers a person with pii_reader as before", () =>
    rolledBack(async (tx) => {
      await rules(tx);
      expect(
        await getDocs(as(tx, reader), { kind: "column", id: id.channel }),
      ).toMatchObject({ element: { name: "Channel" } });
      expect(
        await getDocs(as(tx, reader), { kind: "measure", id: id.net_sales }),
      ).toMatchObject({ element: { name: "Net sales" } });
    }));
});
