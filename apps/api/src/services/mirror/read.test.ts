import { NO_SUCH_DATASET } from "../../errors.js";
import { randomUUID } from "node:crypto";
import { eq, TransactionRollbackError } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_RUNNER } from "../../../test/database.js";
import { setRole } from "../../../test/sample-mirror.js";
import { testPool } from "../../../test/deps.js";
import { createDb } from "../../db/client.js";
import {
  powerbiApp,
  powerbiColumn,
  powerbiMeasure,
  powerbiRelationship,
  powerbiTable,
} from "../../db/schema/mirror.js";
import { piiRule } from "../../db/schema/pii.js";
import {
  appReader,
  asPerson,
  everyWorkspace,
  id,
  fileUnder,
  leader,
  metricIn,
  outsider,
  reaching,
  rolledBack,
  salesMember,
  useMirror,
} from "../../../test/mirror-fixtures.js";
import type { Db, ServiceContext } from "../../context.js";
import {
  metric,
  metricVariant,
  term,
  termColumn,
} from "../../db/schema/book.js";
import type { Principal } from "../../principal.js";
import {
  getColumnDetail,
  getDataset,
  listApps,
  listColumns,
  listDatasets,
  listMeasures,
  listWorkspaces,
} from "./read.js";

import * as mirror from "./read.js";

useMirror();

const names = (items: { name: string }[]) => items.map((item) => item.name);

describe("listDatasets", () => {
  it("filters dataset, column and measure names in SQL and counts the first page", () =>
    rolledBack(async (tx) => {
      const context = asPerson(appReader, { db: tx });
      expect(
        await listDatasets(context, { name_contains: "ALES", limit: 1 }),
      ).toMatchObject({ total: 1, items: [{ name: "Sales" }] });
      for (const list of [listColumns, listMeasures]) {
        const first = await list(context, { dataset: id.sales, limit: 1 });
        expect(first).toHaveProperty("total");
        const name = first.items[0]?.name;
        if (name === undefined) throw new Error("Sample list is empty");
        const filtered = await list(context, {
          dataset: id.sales,
          name_contains: name.toUpperCase().replaceAll(" ", "_"),
          limit: 1,
        });
        expect(filtered.items[0]?.name).toBe(name);
        expect(filtered).toHaveProperty("total");
        expect(
          await list(context, { dataset: id.sales, name_contains: "%" }),
        ).toMatchObject({ total: 0, items: [] });
        if (first.next_cursor !== null)
          expect(
            await list(context, {
              dataset: id.sales,
              cursor: first.next_cursor,
            }),
          ).not.toHaveProperty("total");
      }
    }));

  it("shows the outsider no dataset under powerbi", async () => {
    const page = await listDatasets(asPerson(outsider), {});
    expect(page).toEqual({ total: 0, items: [], next_cursor: null });
  });

  it("shows the app-only viewer the Sales dataset, reached through the app alone", async () => {
    const { items } = await listDatasets(asPerson(appReader));
    expect(names(items)).toEqual(["Sales"]);
    expect(items[0]?.description).toBe("Every order line since 2024.");
    expect(items[0]?.reached_through).toEqual([
      { kind: "app", id: id.sales_app, name: "Sales app" },
    ]);
  });

  it("names how each caller reaches a dataset, and none when only the setting lets them see it", async () => {
    const reach = async (principal: Principal, mode?: "everyone") => {
      const context = asPerson(principal, { mode });
      const { items } = await listDatasets(context, {
        workspace: id.sales_workspace,
      });
      return items.map((item) => item.reached_through);
    };
    const sales = id.sales_workspace;
    const workspace = {
      kind: "workspace",
      id: sales,
      name: "Sales",
    };
    const app = {
      kind: "app",
      id: id.sales_app,
      name: "Sales app",
    };
    const share = { kind: "share", id: id.sales, name: "Sales" };
    expect(await reach(salesMember)).toEqual([[workspace]]);
    expect(await reach(reaching({ powerbi_dataset_ids: [id.sales] }))).toEqual([
      [share],
    ]);
    const member = reaching({
      powerbi_workspace_ids: [sales],
      powerbi_app_ids: [id.sales_app],
    });
    expect(await reach(member)).toEqual([[workspace, app]]);
    expect(await reach(outsider, "everyone")).toEqual([[]]);
  });

  it("leaves out a removed dataset unless asked, and filters and pages", async () => {
    const context = asPerson(everyWorkspace);
    expect(names((await listDatasets(context)).items)).toEqual([
      "Finance",
      "Sales",
    ]);
    const withRemoved = await listDatasets(context, { removed: true });
    expect(withRemoved.items.map((item) => item.removed)).toEqual([
      false,
      false,
      true,
    ]);
    const only = async (filters: object) =>
      names((await listDatasets(context, filters)).items);
    expect(await only({ workspace: "Finance" })).toEqual(["Finance"]);
    expect(await only({ app: id.sales_app })).toEqual(["Sales"]);
    expect(await only({ name_prefix: "sal" })).toEqual(["Sales"]);

    const first = await listDatasets(context, { limit: 1 });
    expect(names(first.items)).toEqual(["Finance"]);
    const second = await listDatasets(context, {
      limit: 1,
      cursor: first.next_cursor ?? "",
    });
    expect(names(second.items)).toEqual(["Sales"]);
    expect(second.next_cursor).toBeNull();
    await expect(
      listDatasets(context, { cursor: "not an id" }),
    ).rejects.toMatchObject({
      kind: "invalid",
    });
  });

  it("answers an app the caller does not see as a missing one", async () => {
    // Sales by a direct share: its app is not the caller's.
    const context = asPerson(reaching({ powerbi_dataset_ids: [id.sales] }));
    expect(names((await listDatasets(context)).items)).toEqual(["Sales"]);
    for (const app of ["Sales app", id.sales_app, "Nothing", randomUUID()])
      expect(await listDatasets(context, { app })).toEqual({
        total: 0,
        items: [],
        next_cursor: null,
      });
  });

  it("answers a removed app as a missing one", () =>
    expect(
      createDb(testPool("worker_rw")).transaction(async (tx) => {
        const context = asPerson(salesMember, { db: tx });
        const shown = async () =>
          names((await listDatasets(context, { app: id.sales_app })).items);
        expect(await shown()).toEqual(["Sales"]);
        await tx
          .update(powerbiApp)
          .set({ removed_at: new Date() })
          .where(eq(powerbiApp.id, id.sales_app));
        expect(await shown()).toEqual([]);
        tx.rollback();
      }),
    ).rejects.toThrow(TransactionRollbackError));
});

describe("getDataset", () => {
  it("puts the tables before the relationships, since a long answer is cut at its end", async () => {
    const keys = Object.keys(await getDataset(asPerson(appReader), "Sales"));
    expect(keys.indexOf("tables")).toBeGreaterThan(-1);
    expect(keys.indexOf("tables")).toBeLessThan(keys.indexOf("relationships"));
    expect(keys.at(-1)).toBe("relationships");
  });

  it("gives both descriptions, the workspace, the apps, the tables with counts and the relationships", async () => {
    const dataset = await getDataset(asPerson(appReader), "Sales");
    expect(dataset).toMatchObject({
      id: id.sales,
      description: "Every order line since 2024.",
      description_pbi: "Orders and revenue.",
      workspace: { id: id.sales_workspace },
      apps: [{ id: id.sales_app }],
      has_row_level_security: false,
      schema_error: null,
      custom: { tier: "gold" },
      relationships: [
        { from_table: "Sales", from_column: "Order date", to_table: "Date" },
      ],
    });
    expect(
      dataset.tables.map(({ name, column_count, measure_count }) => [
        name,
        column_count,
        measure_count,
      ]),
    ).toEqual([
      ["Date", 0, 1],
      ["Sales", 2, 2],
    ]);
  });

  it("reports row-level security, the schema error and where the relationships came from", async () => {
    expect(await getDataset(asPerson(leader), id.finance)).toMatchObject({
      has_row_level_security: true,
      schema_error: "The model could not be read.",
      relationships_source: "scanner",
      apps: [{ name: "Leadership app" }],
    });
  });

  it("answers a dataset the caller may not describe exactly like one that does not exist", async () => {
    const refused: [Principal, string][] = [
      [outsider, id.sales],
      [appReader, id.finance],
      [appReader, "Finance"],
      [appReader, randomUUID()],
      // A removed dataset is gone to a lookup, as it is to a list.
      [salesMember, id.old],
    ];
    for (const [principal, reference] of refused) {
      await expect(
        getDataset(asPerson(principal), reference),
      ).rejects.toMatchObject({
        kind: "not_found",
        message: NO_SUCH_DATASET,
      });
    }
  });
});

describe("a dataset the caller may not describe", () => {
  const lookups = {
    getDataset: (context: ServiceContext, dataset: string) =>
      getDataset(context, dataset),
    listColumns: (context: ServiceContext, dataset: string) =>
      listColumns(context, { dataset }),
    listMeasures: (context: ServiceContext, dataset: string) =>
      listMeasures(context, { dataset }),
  };

  it.each(Object.entries(lookups))(
    "is not_found to %s, by id and by name",
    async (_name, lookup) => {
      for (const reference of [id.sales, "Sales"]) {
        await expect(
          lookup(asPerson(outsider), reference),
        ).rejects.toMatchObject({
          kind: "not_found",
          message: NO_SUCH_DATASET,
        });
      }
    },
  );

  it("cannot be told from a missing one through any list", async () => {
    const context = asPerson(appReader);
    const forged = (name: string, dataset: string) =>
      Buffer.from(JSON.stringify([name, dataset])).toString("base64url");
    // Each takes the id of the hidden Finance dataset (or its workspace or
    // app) and, for the comparison, the id of nothing.
    const asks: [(reference: string) => Promise<unknown>, string][] = [
      [(dataset) => getDataset(context, dataset), id.finance],
      [(dataset) => listColumns(context, { dataset }), id.finance],
      [(dataset) => listMeasures(context, { dataset }), id.finance],
      [
        (workspace) => listDatasets(context, { workspace }),
        id.finance_workspace,
      ],
      [(app) => listDatasets(context, { app }), id.leadership_app],
      [(cursor) => listDatasets(context, { cursor }), id.finance],
      [
        (dataset) =>
          listDatasets(context, {
            cursor: forged("Finance", dataset),
          }),
        id.finance,
      ],
    ];
    const answer = (ask: Promise<unknown>) =>
      ask.catch((error: unknown) => error);
    for (const [ask, hidden] of asks) {
      expect(await answer(ask(hidden))).toEqual(
        await answer(ask(randomUUID())),
      );
    }
  });

  it("refuses a name two datasets share, naming both ids", async () => {
    const both = asPerson(
      reaching({ powerbi_dataset_ids: [id.twin_a, id.twin_b] }),
    );
    const lookup = getDataset(both, "Twin");
    await expect(lookup).rejects.toMatchObject({ kind: "invalid" });
    await expect(lookup).rejects.toThrow(id.twin_a);
    await expect(lookup).rejects.toThrow(id.twin_b);
  });
});

describe("getColumnDetail", () => {
  // Only the sync writes a measure's DAX, so the worker sets it, and it is cleared after.
  const worker = createDb(testPool("worker_rw"));
  const dax = {
    [id.net_sales]: "SUM('Sales'[Channel])",
    [id.net_sales_ly]: "COUNT([channel])",
    [id.days]: "COUNT([Channel]) + COUNT(Other[Channel])",
    [id.profit]: "COUNT(Sales[Channel])",
  };
  beforeAll(async () => {
    for (const [measure, expression] of Object.entries(dax))
      await worker
        .update(powerbiMeasure)
        .set({ expression })
        .where(eq(powerbiMeasure.id, measure));
  });
  afterAll(async () => {
    await worker
      .update(powerbiMeasure)
      .set({ expression: null })
      .where(eq(powerbiMeasure.dataset_id, id.sales));
  });

  it("answers the column with its table, terms, relationships and the measures that name it", () =>
    rolledBack(async (tx) => {
      const [liked] = await tx
        .insert(term)
        .values({ name: "Order day", definition: "The day of an order." })
        .returning();
      await tx
        .insert(termColumn)
        .values({ term_id: liked?.id ?? "", column_id: id.order_date });
      await tx
        .update(powerbiColumn)
        .set({ display_folder: "Dates\\Fiscal" })
        .where(eq(powerbiColumn.id, id.order_date));
      const context = asPerson(appReader, { db: tx });
      const detail = await getColumnDetail(context, id.sales, id.order_date);
      expect(detail.column).toMatchObject({
        name: "Order date",
        display_folder: "Dates\\Fiscal",
        column_type: "data",
        description_pbi: "When the order was placed.",
        expression: null,
        format_string: null,
      });
      expect(detail.table.name).toBe("Sales");
      expect(detail.terms).toEqual([
        { name: "Order day", definition: "The day of an order." },
      ]);
      expect(detail.relationships).toMatchObject([
        { from_table: "Sales", from_column: "Order date", to_table: "Date" },
      ]);
      expect(detail.used_by).toEqual([]);
      const channel = await getColumnDetail(context, id.sales, id.channel);
      expect(
        channel.used_by.map((m) => [m.name, m.table, m.display_folder]),
      ).toEqual([
        ["Net sales", "Sales", null],
        ["Net sales LY", "Sales", "Time"],
      ]);
    }));

  it("finds a measure that names a column whose name holds a closing bracket", async () => {
    // DAX writes the closing bracket of a name twice: 'Sales'[Rate [%]]]
    const rename = (name: string) =>
      worker
        .update(powerbiColumn)
        .set({ name })
        .where(eq(powerbiColumn.id, id.order_date));
    const writes = (measure: string, expression: string) =>
      worker
        .update(powerbiMeasure)
        .set({ expression })
        .where(eq(powerbiMeasure.id, measure));
    await rename("Rate [%]");
    await writes(id.days, "SUM('Sales'[Rate [%]]])");
    // The name of another column, "Rate [%", that only starts like this one.
    await writes(id.net_sales_ly, "SUM('Sales'[Rate [%]])");
    try {
      const detail = await getColumnDetail(
        asPerson(appReader),
        id.sales,
        id.order_date,
      );
      expect(detail.used_by.map((m) => m.name)).toEqual(["Days in month"]);
    } finally {
      await rename("Order date");
      for (const [measure, expression] of Object.entries(dax))
        if (measure === id.days || measure === id.net_sales_ly)
          await writes(measure, expression);
    }
  });

  it("names the metric a used-by measure backs", () =>
    rolledBack(async (tx) => {
      const metricId = await metricIn(tx, "orders", null);
      await fileUnder(tx, metricId, id.net_sales);
      const channel = await getColumnDetail(
        asPerson(appReader, { db: tx }),
        id.sales,
        id.channel,
      );
      expect(channel.used_by[0]?.metric).toMatchObject({
        name: "orders",
        trust_state: "draft",
      });
      expect(channel.used_by[1]?.metric).toBeNull();
    }));

  it("answers a missing column, one of another dataset and one that is no id alike", async () => {
    const context = asPerson(appReader);
    for (const column of [randomUUID(), id.margin, "not-an-id"])
      await expect(
        getColumnDetail(context, id.sales, column),
      ).rejects.toMatchObject({ kind: "not_found" });
  });
});

describe("listColumns", () => {
  it("lists a dataset's columns with the terms they back, and filters by table and prefix", () =>
    rolledBack(async (tx) => {
      const [channel] = await tx
        .insert(term)
        .values({ name: "Channel" })
        .returning();
      await tx
        .insert(termColumn)
        .values({ term_id: channel?.id ?? "", column_id: id.channel });
      const context = asPerson(appReader, { db: tx });
      const { items } = await listColumns(context, {
        dataset: "Sales",
      });
      expect(
        items.map((item) => [
          item.name,
          item.terms.map((backed) => backed.name),
        ]),
      ).toEqual([
        ["Channel", ["Channel"]],
        ["Order date", []],
      ]);
      expect(items[1]).toMatchObject({
        table: { name: "Sales" },
        data_type: "DateTime",
        description_pbi: "When the order was placed.",
      });
      const some = await listColumns(context, {
        dataset: id.sales,
        table: "Sales",
        name_prefix: "ORD",
      });
      expect(names(some.items)).toEqual(["Order date"]);
      const first = await listColumns(context, { dataset: id.sales, limit: 1 });
      const second = await listColumns(context, {
        dataset: id.sales,
        limit: 1,
        cursor: first.next_cursor ?? "",
      });
      expect([names(first.items), names(second.items)]).toEqual([
        ["Channel"],
        ["Order date"],
      ]);
      expect([first.next_cursor === null, second.next_cursor]).toEqual([
        false,
        null,
      ]);
    }));
});

describe("listMeasures", () => {
  beforeAll(async () => {
    await createDb(testPool("worker_rw"))
      .update(powerbiMeasure)
      .set({ format_string: "#,##0.00" })
      .where(eq(powerbiMeasure.id, id.net_sales));
  });
  afterAll(async () => {
    await createDb(testPool("worker_rw"))
      .update(powerbiMeasure)
      .set({ format_string: null })
      .where(eq(powerbiMeasure.id, id.net_sales));
  });
  it("answers Net sales with its format string", async () => {
    const { items } = await listMeasures(asPerson(appReader), {
      dataset: id.sales,
    });
    expect(items.find((item) => item.name === "Net sales")).toMatchObject({
      format_string: "#,##0.00",
    });
    expect(items.find((item) => item.name === "Days in month")).toMatchObject({
      format_string: null,
    });
  });

  it("lists a dataset's measures with their metric and shift, and only the unfiled on request", () =>
    rolledBack(async (tx) => {
      const [filed] = await tx
        .insert(metric)
        .values({
          name: "total_net_sales_excl_vat",
          label: "Total net sales excl VAT",
          origin: "curator",
        })
        .returning();
      await tx.insert(metricVariant).values({
        metric_id: filed?.id ?? "",
        measure_id: id.net_sales,
        assigned_by: "curator",
      });
      const context = asPerson(appReader, { db: tx });
      const { items } = await listMeasures(context, { dataset: id.sales });
      expect(
        items.map((item) => [
          item.name,
          item.metric?.name ?? null,
          item.shift?.period ?? null,
        ]),
      ).toEqual([
        ["Days in month", null, null],
        ["Net sales", "total_net_sales_excl_vat", "current"],
        ["Net sales LY", null, null],
      ]);
      expect(items[2]?.display_folder).toBe("Time");
      const measures = async (filters: object) =>
        names(
          (await listMeasures(context, { dataset: id.sales, ...filters }))
            .items,
        );
      expect(await measures({ unfiled: true })).toEqual([
        "Days in month",
        "Net sales LY",
      ]);
      expect(await measures({ table: "Date" })).toEqual(["Days in month"]);
      expect(await measures({ table: id.sales_table, unfiled: true })).toEqual([
        "Net sales LY",
      ]);

      const pages: string[][] = [];
      let cursor: string | undefined;
      do {
        const page = await listMeasures(context, {
          dataset: id.sales,
          limit: 1,
          cursor,
        });
        pages.push(names(page.items));
        cursor = page.next_cursor ?? undefined;
      } while (cursor !== undefined);
      expect(pages).toEqual([
        ["Days in month"],
        ["Net sales"],
        ["Net sales LY"],
      ]);
    }));
});

describe("listWorkspaces and listApps", () => {
  it("count and show only what the caller reaches through a dataset", async () => {
    expect(await listWorkspaces(asPerson(salesMember))).toMatchObject([
      { id: id.sales_workspace, dataset_count: 1 },
    ]);
    expect(await listApps(asPerson(appReader))).toMatchObject([
      {
        id: id.sales_app,
        workspace: { id: id.sales_workspace },
        datasets: [{ kind: "dataset", id: id.sales }],
      },
    ]);
    expect(await listWorkspaces(asPerson(outsider))).toEqual([]);
    expect(await listApps(asPerson(outsider))).toEqual([]);
  });
});

describe("what a person without pii_reader does not get", () => {
  const rule = (
    kind: "column" | "measure" | "table",
    table_name: string,
    name: string | null,
  ) => ({
    kind,
    table_name,
    name,
    pii: true,
    set_by_kind: "person",
    set_by_id: "x",
    set_via: "api",
  });
  /** Sales[Order date] is a column rule and Sales[Net sales] a measure rule. */
  const withRules = async (tx: Db) => {
    await tx
      .insert(piiRule)
      .values([
        rule("column", "Sales", "ORDER date"),
        rule("measure", "sales", "Net Sales"),
      ]);
  };
  const reader = { ...appReader, roles: ["pii_reader"] };
  const dataset = "Sales";

  it("leaves a PII column out of list_columns and reports pii_hidden", () =>
    rolledBack(async (tx) => {
      await withRules(tx);
      const page = await listColumns(asPerson(appReader, { db: tx }), {
        dataset,
      });
      expect(names(page.items)).toEqual(["Channel"]);
      expect(page.pii_hidden).toBe(1);
      const some = await listColumns(asPerson(appReader, { db: tx }), {
        dataset,
        name_prefix: "chan",
      });
      expect(some.pii_hidden).toBe(1);
    }));

  it("reports the same pii_hidden whatever name_prefix or unfiled is asked, so a hidden name cannot be spelled out", () =>
    rolledBack(async (tx) => {
      await withRules(tx);
      const [filed] = await tx
        .insert(metric)
        .values({ name: "pii_oracle", label: "x", origin: "curator" })
        .returning({ id: metric.id });
      await tx.insert(metricVariant).values({
        metric_id: filed?.id ?? "",
        measure_id: id.net_sales,
        assigned_by: "curator",
      });
      const context = asPerson(appReader, { db: tx });
      const hiddenBy = async (name_prefix: string) =>
        (await listColumns(context, { dataset, name_prefix })).pii_hidden;
      expect([await hiddenBy("ord"), await hiddenBy("zzz")]).toEqual([1, 1]);
      const hiddenColumn = await listColumns(context, {
        dataset,
        name_contains: "ORDER_date",
      });
      expect(hiddenColumn).toMatchObject({ items: [], total: 0 });
      const hiddenMeasure = await listMeasures(context, {
        dataset,
        name_contains: "net_sales",
      });
      expect(names(hiddenMeasure.items)).toEqual(["Net sales LY"]);
      expect(hiddenMeasure.total).toBe(1);
      const unfiled = await listMeasures(context, { dataset, unfiled: true });
      expect(names(unfiled.items)).toEqual(["Days in month", "Net sales LY"]);
      expect(unfiled.pii_hidden).toBe(1);
    }));

  it("shows the reader the PII column, tagged, and no pii_hidden", () =>
    rolledBack(async (tx) => {
      await withRules(tx);
      const page = await listColumns(asPerson(reader, { db: tx }), {
        dataset,
      });
      expect(page.items.map((item) => [item.name, "pii" in item])).toEqual([
        ["Channel", false],
        ["Order date", true],
      ]);
      expect(page.items[1]).toMatchObject({ pii: true });
      expect("pii_hidden" in page).toBe(false);
    }));

  it("leaves a PII measure out of list_measures and reports pii_hidden", () =>
    rolledBack(async (tx) => {
      await withRules(tx);
      const page = await listMeasures(asPerson(appReader, { db: tx }), {
        dataset,
      });
      expect(names(page.items)).toEqual(["Days in month", "Net sales LY"]);
      expect(page.pii_hidden).toBe(1);
    }));

  it("shows the reader the PII measure, tagged, and no pii_hidden", () =>
    rolledBack(async (tx) => {
      await withRules(tx);
      const page = await listMeasures(asPerson(reader, { db: tx }), {
        dataset,
      });
      expect(page.items.map((item) => [item.name, "pii" in item])).toEqual([
        ["Days in month", false],
        ["Net sales", true],
        ["Net sales LY", false],
      ]);
      expect("pii_hidden" in page).toBe(false);
    }));

  it("counts a table rule's columns, once, in get_dataset", () =>
    rolledBack(async (tx) => {
      await tx.insert(piiRule).values(rule("table", "Sales", null));
      const seen = await getDataset(asPerson(appReader, { db: tx }), dataset);
      expect(
        seen.tables.map(({ name, column_count }) => [name, column_count]),
      ).toEqual([
        ["Date", 0],
        ["Sales", 0],
      ]);
      expect(seen.pii_hidden).toBe(2);
      expect(seen.relationships).toEqual([]);
    }));

  it("hides a relationship with a PII column and the counts, and leaves the reader's answer unchanged", () =>
    expect(
      createDb(testPool(TEST_RUNNER)).transaction(async (tx) => {
        await setRole(tx, "api_rw");
        await withRules(tx);
        await setRole(tx, "worker_rw");
        await tx
          .update(powerbiRelationship)
          .set({ cardinality: "many_to_one" })
          .where(eq(powerbiRelationship.dataset_id, id.sales));
        await setRole(tx, "api_rw");
        const viewer = await getDataset(
          asPerson(appReader, { db: tx }),
          dataset,
        );
        expect(viewer.relationships).toEqual([]);
        expect(
          viewer.tables.map(({ name, column_count, measure_count }) => [
            name,
            column_count,
            measure_count,
          ]),
        ).toEqual([
          ["Date", 0, 1],
          ["Sales", 1, 1],
        ]);
        expect(viewer.pii_hidden).toBe(1);
        const seeing = await getDataset(asPerson(reader, { db: tx }), dataset);
        expect("pii_hidden" in seeing).toBe(false);
        expect(seeing.relationships).toHaveLength(1);
        expect(viewer.tables.map(({ name, kind }) => [name, kind])).toEqual([
          ["Date", "measures"],
          ["Sales", "standalone"],
        ]);
        expect(seeing.tables.map(({ name, kind }) => [name, kind])).toEqual([
          ["Date", "measures"],
          ["Sales", "fact"],
        ]);
        expect(seeing.tables.map((table) => table.column_count)).toEqual([
          0, 2,
        ]);
        expect(seeing.tables.map((table) => table.measure_count)).toEqual([
          1, 2,
        ]);
        tx.rollback();
      }),
    ).rejects.toThrow(TransactionRollbackError));

  it("hides a relationship by its rules alone, at either end, even for a column the mirror lacks", () =>
    rolledBack(async (tx) => {
      const relationships = async (principal: Principal) =>
        (await getDataset(asPerson(principal, { db: tx }), dataset))
          .relationships.length;
      expect(await relationships(appReader)).toBe(1);
      await tx.insert(piiRule).values(rule("column", "DATE", "date"));
      expect(await relationships(appReader)).toBe(0);
      expect(await relationships(reader)).toBe(1);
    }));

  it("hides a relationship end covered by a table rule unless a column rule clears it", () =>
    rolledBack(async (tx) => {
      await tx.insert(piiRule).values(rule("table", "Date", null));
      const relationships = async (principal: Principal) =>
        (await getDataset(asPerson(principal, { db: tx }), dataset))
          .relationships.length;
      expect(await relationships(appReader)).toBe(0);
      await tx
        .insert(piiRule)
        .values({ ...rule("column", "Date", "Date"), pii: false });
      expect(await relationships(appReader)).toBe(1);
    }));

  it("tags a table a table rule covers for the reader only", () =>
    rolledBack(async (tx) => {
      await tx.insert(piiRule).values(rule("table", "date", null));
      const tagged = async (principal: Principal) =>
        (await getDataset(asPerson(principal, { db: tx }), dataset)).tables.map(
          (table) => [table.name, "pii" in table],
        );
      expect(await tagged(reader)).toEqual([
        ["Date", true],
        ["Sales", false],
      ]);
      expect(await tagged(appReader)).toEqual([
        ["Date", false],
        ["Sales", false],
      ]);
    }));
});

describe("relationship pages and model summaries", () => {
  it("filters either end by name or id, orders every key, and pages with a first-page total", () =>
    rolledBack(async (tx) => {
      const context = asPerson(appReader, { db: tx });
      await tx.insert(powerbiRelationship).values([
        {
          dataset_id: id.sales,
          from_table: "Sales",
          from_column: "Order date",
          to_table: "Date",
          to_column: "Zulu",
          is_active: false,
        },
        {
          dataset_id: id.sales,
          from_table: "Sales",
          from_column: "Channel",
          to_table: "Sales",
          to_column: "Channel",
        },
        {
          dataset_id: id.sales,
          from_table: "Sales",
          from_column: "Order date",
          to_table: "Date",
          to_column: "Date",
        },
      ]);
      const all = await mirror.listRelationships(context, { dataset: "Sales" });
      expect(all.total).toBe(4);
      expect(all.items.map((r) => [r.from_column, r.to_column])).toEqual([
        ["Channel", "Channel"],
        ["Order date", "Date"],
        ["Order date", "Date"],
        ["Order date", "Zulu"],
      ]);
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await mirror.listRelationships(context, {
          dataset: id.sales,
          limit: 1,
          cursor,
        });
        expect(page.total).toBe(cursor === undefined ? 4 : undefined);
        seen.push(...page.items.map((r) => r.id));
        cursor = page.next_cursor ?? undefined;
      } while (cursor !== undefined);
      expect(seen).toEqual(all.items.map((r) => r.id));
      for (const table of ["Date", id.date_table]) {
        expect(
          (
            await mirror.listRelationships(context, {
              dataset: id.sales,
              table,
            })
          ).total,
        ).toBe(3);
      }
      expect(
        (
          await mirror.listRelationships(context, {
            dataset: id.sales,
            table: "absent",
          })
        ).total,
      ).toBe(0);
      expect(
        (
          await mirror.listRelationships(context, {
            dataset: id.sales,
            active_only: true,
          })
        ).total,
      ).toBe(3);
      await expect(
        mirror.listRelationships(context, {
          dataset: id.sales,
          cursor: "broken",
        }),
      ).rejects.toMatchObject({ kind: "invalid" });
    }));

  it("defaults to 25 relationships, caps pages at 100, and excludes removed joins", () =>
    rolledBack(async (tx) => {
      await tx.insert(powerbiRelationship).values(
        Array.from({ length: 101 }, (_, index) => ({
          dataset_id: id.sales,
          from_table: "Sales",
          from_column: `Key ${String(index).padStart(3, "0")}`,
          to_table: "Date",
          to_column: "Date",
          removed_at: index === 100 ? new Date() : null,
        })),
      );
      const context = asPerson(appReader, { db: tx });
      const page = await mirror.listRelationships(context, {
        dataset: id.sales,
      });
      expect(page.items).toHaveLength(25);
      expect(page.total).toBe(101);
      expect(page.next_cursor).not.toBeNull();
      expect(
        (
          await mirror.listRelationships(context, {
            dataset: id.sales,
            limit: 500,
          })
        ).items,
      ).toHaveLength(100);
    }));

  it("derives kinds and date columns from cardinality, and prioritizes visible join columns", () =>
    expect(
      createDb(testPool(TEST_RUNNER)).transaction(async (tx) => {
        await setRole(tx, "worker_rw");
        const tables = [
          "Alpha",
          "Beta",
          "Gamma",
          "Delta",
          "Empty",
          "Metrics",
          "Bridge",
          "Dimension",
          "Standalone",
        ];
        const rows = await tx
          .insert(powerbiTable)
          .values(tables.map((name) => ({ dataset_id: id.sales, name })))
          .returning();
        for (const table of rows) {
          if (["Empty", "Metrics"].includes(table.name)) continue;
          await tx.insert(powerbiColumn).values(
            ["A", "B", "C", "D", "E", "Z"].map((name) => ({
              dataset_id: id.sales,
              table_id: table.id,
              name,
              data_type:
                table.name === "Dimension"
                  ? "String"
                  : table.name === "Beta"
                    ? "DateTime"
                    : "Date",
              is_hidden: name === "B",
            })),
          );
        }
        await tx.insert(powerbiMeasure).values({
          dataset_id: id.sales,
          table_id: rows.find((t) => t.name === "Metrics")?.id ?? "",
          name: "Amount",
        });
        const joins = [
          ["Alpha", "Beta", "many_to_one"],
          ["Gamma", "Beta", "many_to_one"],
          ["Delta", "Alpha", "one_to_many"],
          ["Gamma", "Delta", "one_to_one"],
          ["Bridge", "Alpha", "many_to_many"],
          ["Alpha", "Dimension", "many_to_one"],
        ];
        await tx.insert(powerbiRelationship).values(
          joins.map(([from_table, to_table, cardinality]) => ({
            dataset_id: id.sales,
            from_table: from_table ?? "",
            from_column: "Z",
            to_table: to_table ?? "",
            to_column: "Z",
            cardinality,
          })),
        );
        await tx.insert(powerbiRelationship).values({
          dataset_id: id.sales,
          from_table: "Empty",
          from_column: "Key",
          to_table: "Delta",
          to_column: "Z",
          cardinality: "many_to_one",
          is_active: false,
        });
        await setRole(tx, "api_rw");
        const detail = await getDataset(
          asPerson(appReader, { db: tx }),
          id.sales,
        );
        expect(detail.date_tables).toEqual([
          { table: "Beta", column: "Z", joined_by: 2 },
          { table: "Delta", column: "Z", joined_by: 2 },
          { table: "Gamma", column: "Z", joined_by: 1 },
        ]);
        const kinds = Object.fromEntries(
          detail.tables.map((t) => [t.name, t.kind]),
        );
        expect(kinds).toMatchObject({
          Alpha: "fact",
          Beta: "date",
          Gamma: "date",
          Delta: "date",
          Empty: "fact",
          Metrics: "measures",
          Bridge: "fact",
          Dimension: "dimension",
          Standalone: "standalone",
        });
        expect(
          detail.tables.find((t) => t.name === "Alpha")?.column_names,
        ).toEqual(["Z", "A", "C", "D", "E"]);
        expect(detail.tables.find((t) => t.name === "Date")?.kind).toBe(
          "measures",
        );
        tx.rollback();
      }),
    ).rejects.toThrow(TransactionRollbackError));
});
