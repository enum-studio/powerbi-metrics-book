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
      when_to_use: null,
      owner: null,
      freshness: null,
      caveats: null,
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

  it("checks the custom fields against dataset_fields, and replaces them whole", () =>
    rolledBack(async (tx) => {
      const admin = as(
        tx,
        reaching({ powerbi_app_ids: [id.sales_app] }, "admin"),
      );
      await setConventionsAsAdmin(admin, {
        dataset_fields: {
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

describe("the built-in fields", () => {
  it("are written per kind, trimmed, cleared by a blank, recorded, and carried by the answer of their kind only", () =>
    rolledBack(async (tx) => {
      const context = as(tx);
      const dataset = await setDocs(
        context,
        { kind: "dataset", id: id.sales },
        { when_to_use: "  For sales  ", owner: "Sales Operations" },
      );
      expect(dataset).toMatchObject({
        when_to_use: "For sales",
        owner: "Sales Operations",
        freshness: null,
        caveats: null,
        described_by: "test-curator",
      });
      expect(dataset).not.toHaveProperty("unit");
      const table = await setDocs(
        context,
        { kind: "table", id: id.sales_table },
        { grain_and_filters: "One row per order line", caveats: "No returns" },
      );
      expect(table).toMatchObject({
        grain_and_filters: "One row per order line",
      });
      expect(table).not.toHaveProperty("owner");
      const column = await setDocs(
        context,
        { kind: "column", id: id.channel },
        { unit: "money", blank_means: "Not priced" },
      );
      expect(column).toMatchObject({
        unit: "money",
        blank_means: "Not priced",
      });
      expect(
        await getDocs(context, { kind: "measure", id: id.net_sales }),
      ).not.toHaveProperty("unit");
      const cleared = await setDocs(
        context,
        { kind: "dataset", id: id.sales },
        { owner: "  " },
      );
      expect(cleared).toMatchObject({ owner: null, when_to_use: "For sales" });
      const [change] = await tx
        .select()
        .from(bookChange)
        .where(
          and(
            eq(bookChange.action, "docs"),
            eq(bookChange.element_id, id.sales),
          ),
        )
        .orderBy(asc(bookChange.id));
      expect(change).toMatchObject({
        before: { when_to_use: null },
        after: { when_to_use: "For sales" },
      });
    }));

  it("are refused on a kind that lacks them, naming the field and the kind", () =>
    rolledBack(async (tx) => {
      const context = as(tx);
      for (const [kind, element, field] of [
        ["dataset", id.sales, "unit"],
        ["column", id.channel, "owner"],
        ["measure", id.net_sales, "caveats"],
        ["table", id.sales_table, "when_to_use"],
      ] as const)
        await expect(
          setDocs(context, { kind, id: element }, { [field]: "x" }),
        ).rejects.toMatchObject({
          kind: "invalid",
          message: `${field} is not a field of a ${kind}. ${
            kind === "dataset"
              ? "A dataset has when_to_use, owner, freshness, caveats."
              : kind === "column"
                ? "A column has unit, blank_means."
                : kind === "table"
                  ? "A table has grain_and_filters, caveats."
                  : "A measure has no built-in fields."
          }`,
          detail: { code: "docs.field_not_on_kind", field, kind },
        });
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

it("validates column units against their own convention and gives the allowed units", () =>
  rolledBack(async (tx) => {
    const context = as(tx);
    await expect(
      setDocs(context, { kind: "column", id: id.channel }, { unit: "USD" }),
    ).rejects.toMatchObject({
      detail: {
        code: "docs.unit_not_allowed",
        values: ["money", "count", "quantity", "rate", "ratio", "duration"],
      },
    });
    expect(
      (
        await setDocs(
          context,
          { kind: "column", id: id.channel },
          { unit: "count" },
        )
      ).unit,
    ).toBe("count");
  }));
