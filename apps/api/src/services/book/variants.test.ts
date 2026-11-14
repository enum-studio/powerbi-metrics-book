import { randomUUID } from "node:crypto";
import { sampleTenant } from "@powerbi-metrics-book/powerbi-mock";
import { and, eq, inArray, like } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  closeTestPools,
  createTestDeps,
  testPool,
} from "../../../test/deps.js";
import { waitingOn } from "../../../test/locks.js";
import { asPerson, reaching } from "../../../test/mirror-fixtures.js";
import {
  inSampleMirror,
  rolledBack,
  type SampleMirror,
  setRole,
} from "../../../test/sample-mirror.js";
import type { Db } from "../../context.js";
import { createDb } from "../../db/client.js";
import { bookChange, metric, metricVariant } from "../../db/schema/book.js";
import { event } from "../../db/schema/events.js";
import {
  powerbiDataset,
  powerbiMeasure,
  powerbiTable,
  powerbiWorkspace,
} from "../../db/schema/mirror.js";
import { setConventionsAsAdmin } from "../conventions/service.js";
import { draftDatasets } from "./drafter.js";
import { mergeMetrics } from "./metrics.js";
import { getVariant, listVariants, moveVariant } from "./variants.js";

afterAll(closeTestPools);

/*
 * Each test drafts the sample mirror under the default conventions and acts
 * as the api in a transaction that is rolled back, as metrics.test.ts does.
 */

const SALES = "Sales";
const FINANCE = "Finance";
const MARKETING = "Marketing";
const tenant = sampleTenant();
const idOf = (items: { id: string; name: string }[], name: string) => {
  const found = items.find((item) => item.name === name);
  if (found === undefined) throw new Error(`The sample has no ${name}`);
  return found.id;
};
const workspaceId = (name: string) => idOf(tenant.workspaces, name);

/** The sample's Admin, as a curator: every workspace. */
const curator = reaching(
  { powerbi_workspace_ids: [SALES, FINANCE, MARKETING].map(workspaceId) },
  "curator",
);

/** The Analyst, as a curator: the Sales workspace only. */
const salesCurator = reaching(
  { powerbi_workspace_ids: [workspaceId(SALES)] },
  "curator",
);
/** The Viewer: the Sales app. */
const viewer = reaching({
  powerbi_app_ids: [idOf(tenant.apps, "Sales app")],
});

const draft = (tx: Db, datasetIds: string[]) =>
  draftDatasets(createTestDeps({ container: "worker", db: tx }), datasetIds);

const drafted = (work: (tx: Db, sample: SampleMirror) => Promise<void>) =>
  inSampleMirror("worker_rw", async (tx, sample) => {
    await draft(
      tx,
      sample.tenant.datasets.map((dataset) => dataset.id),
    );
    await setRole(tx, "api_rw");
    await work(tx, sample);
  });

/** The measure's variant and the metric it is filed under. */
async function filing(
  tx: Db,
  sample: SampleMirror,
  dataset: string,
  measure: string,
) {
  const [row] = await tx
    .select({ variant: metricVariant, metric })
    .from(metricVariant)
    .innerJoin(metric, eq(metric.id, metricVariant.metric_id))
    .where(
      eq(metricVariant.measure_id, sample.measureId({ dataset, measure })),
    );
  if (row === undefined) throw new Error(`${measure} is not filed`);
  return row;
}

describe("moveVariant", () => {
  it("keeps a curator's move when the drafter runs on its dataset again", () =>
    drafted(async (tx, sample) => {
      const usd = await filing(tx, sample, FINANCE, "Revenue USD");
      const net = await filing(tx, sample, SALES, "Net sales");
      await moveVariant(asPerson(curator, { db: tx }), usd.variant.id, {
        to_metric: net.metric.name,
        currency: "USD",
      });
      await setRole(tx, "worker_rw");
      await draft(tx, [idOf(tenant.datasets, FINANCE)]);
      await setRole(tx, "api_rw");

      const after = await filing(tx, sample, FINANCE, "Revenue USD");
      expect(after.variant).toMatchObject({
        metric_id: net.metric.id,
        currency: "USD",
        assigned_by: "curator",
      });
      // The draft it left was untouched and is empty, so the move deleted it.
      const left = await tx
        .select()
        .from(metric)
        .where(eq(metric.id, usd.metric.id));
      expect(left).toEqual([]);
    }));

  it("records the move, announces it, and settles the trust of both metrics", () =>
    drafted(async (tx, sample) => {
      const usd = await filing(tx, sample, FINANCE, "Revenue USD");
      const net = await filing(tx, sample, SALES, "Net sales");
      // Both reviewed before: a token's change takes the review back.
      const now = new Date();
      await tx
        .update(metric)
        .set({ trust_state: "human_verified", touched_at: now })
        .where(eq(metric.id, net.metric.id));
      await tx
        .update(metric)
        .set({ trust_state: "agent_verified", touched_at: now })
        .where(eq(metric.id, usd.metric.id));
      const context = asPerson({ ...curator, via: "cli" }, { db: tx });
      const move = {
        to_metric: net.metric.name,
        currency: "USD",
        note: " At the list rate. ",
      };
      const moved = await moveVariant(context, usd.variant.id, move);
      expect(moved).toMatchObject({
        metric: { id: net.metric.id },
        shift: { currency: "USD", shift_note: "At the list rate." },
        assigned_by: "curator",
      });
      const trust = await tx
        .select({ trust_state: metric.trust_state })
        .from(metric)
        .where(inArray(metric.id, [net.metric.id, usd.metric.id]));
      expect(trust).toEqual([
        { trust_state: "draft" },
        { trust_state: "draft" },
      ]);
      const changes = () =>
        tx
          .select({ action: bookChange.action, after: bookChange.after })
          .from(bookChange)
          .where(
            and(
              eq(bookChange.element_id, usd.variant.id),
              eq(bookChange.principal_id, curator.id),
            ),
          );
      expect(await changes()).toMatchObject([
        {
          action: "move",
          after: { metric_id: net.metric.id, currency: "USD" },
        },
      ]);
      const announced = await tx
        .select({ kind: event.kind, id: event.element_id, data: event.data })
        .from(event)
        .where(eq(event.principal_id, curator.id));
      expect(announced.map(({ kind, id }) => `${kind} ${id ?? ""}`)).toEqual(
        expect.arrayContaining([
          `metric.changed ${net.metric.id}`,
          `metric.changed ${usd.metric.id}`,
        ]),
      );
      expect(announced).toContainEqual({
        kind: "variant.moved",
        id: usd.variant.id,
        data: {
          measure_id: usd.variant.measure_id,
          from_metric_id: usd.metric.id,
          to_metric_id: net.metric.id,
          dataset_id: idOf(tenant.datasets, FINANCE),
        },
      });
      // The same move again changes nothing, so it records nothing.
      await moveVariant(context, usd.variant.id, move);
      expect(await changes()).toHaveLength(1);
    }));

  it("refuses shift values outside the conventions' axes", () =>
    drafted(async (tx, sample) => {
      const context = asPerson(curator, { db: tx });
      const { variant } = await filing(tx, sample, FINANCE, "Revenue USD");
      const refused = (move: Parameters<typeof moveVariant>[2]) =>
        expect(moveVariant(context, variant.id, move)).rejects.toMatchObject({
          kind: "invalid",
        });
      await refused({ period: "fortnight" });
      await refused({ comparison: "growth_rate" });
      await refused({
        comparison: "growth_rate",
        comparison_period: "fortnight",
      });
      await refused({ comparison_period: "previous_year" });
      await refused({ currency: "usd" });
      await refused({ custom_axes: { market_scope: "home_market" } });

      const admin = asPerson(reaching({}, "admin"), { db: tx });
      await setConventionsAsAdmin(admin, {
        variants: {
          axes: {
            currency: { values: ["EUR"] },
            custom: [
              { key: "market_scope", values: ["all_markets", "home_market"] },
            ],
          },
        },
      });
      await refused({ currency: "USD" });
      await refused({ custom_axes: { market_scope: "abroad" } });
      const shifted = await moveVariant(context, variant.id, {
        comparison: "growth_rate",
        comparison_period: "previous_year",
        currency: "EUR",
        custom_axes: { market_scope: "home_market" },
      });
      expect(shifted.shift).toMatchObject({
        comparison: "growth_rate",
        comparison_period: "previous_year",
        currency: "EUR",
        custom_axes: { market_scope: "home_market" },
      });
    }));

  it("refuses a move to a metric that already holds that shift in that dataset, naming the clash", () =>
    drafted(async (tx, sample) => {
      const context = asPerson(curator, { db: tx });
      const web = await filing(tx, sample, SALES, "Web net sales LY");
      const net = await filing(tx, sample, SALES, "Net sales");
      await expect(
        moveVariant(context, web.variant.id, {
          to_metric: net.metric.name,
          period: "previous_year",
        }),
      ).rejects.toMatchObject({
        kind: "conflict",
        detail: {
          clashes: [`Web net sales LY and Net sales LY in ${SALES}`],
          hidden: 0,
        },
      });
      const after = await filing(tx, sample, SALES, "Web net sales LY");
      expect(after.variant).toEqual(web.variant);
    }));

  it("refuses a viewer, and answers what the curator may not describe like a missing one", () =>
    drafted(async (tx, sample) => {
      const usd = await filing(tx, sample, FINANCE, "Revenue USD");
      const orders = await filing(tx, sample, SALES, "Orders");
      const margin = await filing(tx, sample, FINANCE, "Gross margin");
      const viewing = asPerson(viewer, { db: tx });
      await expect(
        moveVariant(viewing, orders.variant.id, { period: "other" }),
      ).rejects.toMatchObject({ kind: "refused" });
      const context = asPerson(salesCurator, { db: tx });
      await expect(
        moveVariant(context, usd.variant.id, { to_metric: orders.metric.name }),
      ).rejects.toMatchObject({
        kind: "not_found",
        message: "No such variant.",
      });
      const kept = await filing(tx, sample, FINANCE, "Revenue USD");
      expect(kept.variant).toEqual(usd.variant);
      await expect(
        moveVariant(context, orders.variant.id, {
          to_metric: margin.metric.name,
        }),
      ).rejects.toMatchObject({ kind: "not_found" });
    }));

  it("lets two opposite moves wait in turn, and refuses one whose variant moved while it waited", async () => {
    // The moves run in sessions of their own, which must see the same rows, so
    // this test commits them: a dataset of its own, not the sample, removed
    // with its workspace after.
    const worker = createDb(testPool("worker_rw"));
    const tag = randomUUID();
    const workspace = { id: randomUUID(), name: `Variants race ${tag}` };
    await worker.insert(powerbiWorkspace).values(workspace);
    const blocker = await testPool("api_rw").connect();
    try {
      const dataset = one(
        await worker
          .insert(powerbiDataset)
          .values({
            ...workspace,
            id: randomUUID(),
            workspace_id: workspace.id,
          })
          .returning(),
      );
      const table = one(
        await worker
          .insert(powerbiTable)
          .values({ dataset_id: dataset.id, name: "Race" })
          .returning(),
      );
      /** A metric of its own holding one variant. */
      const filed = async (key: string) => {
        const values = {
          dataset_id: dataset.id,
          table_id: table.id,
          name: key,
        };
        const measure = one(
          await worker.insert(powerbiMeasure).values(values).returning(),
        );
        const name = `race_${key}_${tag}`;
        const held = one(
          await worker
            .insert(metric)
            .values({ name, label: key, origin: "sync" })
            .returning(),
        );
        const variant = one(
          await worker
            .insert(metricVariant)
            .values({
              metric_id: held.id,
              measure_id: measure.id,
              assigned_by: "sync",
            })
            .returning(),
        );
        return { id: variant.id, metric_id: held.id, name };
      };
      const a = await filed("a");
      const b = await filed("b");
      const curator = reaching(
        { powerbi_workspace_ids: [workspace.id] },
        "curator",
      );
      // A move's transaction nests in its session's, which is rolled back
      // after it: its locks are held as a commit holds them, and its book
      // changes and events, which other tests count, are never committed.
      const across = (from: typeof a, to: typeof a) => async () => {
        let outcome: unknown;
        await rolledBack("api_rw", async (tx) => {
          const context = asPerson(curator, { db: tx });
          outcome = await moveVariant(context, from.id, {
            to_metric: to.name,
            period: "previous_year",
          }).then(
            () => "moved",
            (error: unknown) => error,
          );
        });
        return outcome;
      };
      /** Starts the moves while this session holds both metrics, so they wait there, and lets go after `meanwhile`. */
      const contended = async (
        moves: (() => Promise<unknown>)[],
        meanwhile?: () => Promise<unknown>,
      ) => {
        await blocker.query("begin");
        await blocker.query(
          "select from metric where id = any($1) for update",
          [[a.metric_id, b.metric_id]],
        );
        const { rows } = await blocker.query<{ pid: number }>(
          "select pg_backend_pid() as pid",
        );
        const running = Promise.all(moves.map((move) => move()));
        await waitingOn(one(rows).pid, moves.length);
        await meanwhile?.();
        await blocker.query("commit");
        return running;
      };
      expect(await contended([across(a, b), across(b, a)])).toEqual([
        "moved",
        "moved",
      ]);
      const moveFirst = () =>
        blocker.query(
          "update metric_variant set metric_id = $1 where id = $2",
          [b.metric_id, a.id],
        );
      expect(await contended([across(a, b)], moveFirst)).toEqual([
        expect.objectContaining({ kind: "conflict" }),
      ]);
    } finally {
      await blocker.query("rollback");
      blocker.release();
      await worker.delete(metric).where(like(metric.name, `race_%_${tag}`));
      await worker
        .delete(powerbiWorkspace)
        .where(eq(powerbiWorkspace.id, workspace.id));
    }
  });
});

function one<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error("Expected a row");
  return row;
}

describe("getVariant", () => {
  it("gives the measure's DAX, its shift and what it reads of the selection, by id or by dataset and measure", () =>
    drafted(async (tx, sample) => {
      const context = asPerson(curator, { db: tx });
      const name = "Revenue in selected currency";
      const filed = await filing(tx, sample, FINANCE, name);
      const byId = await getVariant(context, filed.variant.id);
      expect(
        await getVariant(context, { dataset: FINANCE, measure: name }),
      ).toEqual(byId);
      const measure = tenant.datasets
        .flatMap((d) => d.tables.flatMap((table) => table.measures))
        .find((m) => m.name === name);
      expect(byId).toMatchObject({
        kind: "variant",
        metric: { id: filed.metric.id, name: filed.metric.name },
        dataset: { name: FINANCE },
        measure: { name },
        measure_reference: `[${name}]`,
        expression: measure?.expression,
        format_string: measure?.format_string,
        display_folder: "Currency",
        description_pbi: measure?.description,
        shift: { period: "current", comparison: "none", currency: null },
        reads_selection: true,
        assigned_by: "sync",
        removed: false,
      });
      expect(byId.normalized_expression).toMatch(/selectedvalue/i);
      expect(byId.selection_columns.length).toBeGreaterThan(0);
    }));

  it("answers a variant in a dataset the caller may not describe like a missing one", () =>
    drafted(async (tx, sample) => {
      const context = asPerson(viewer, { db: tx });
      const { variant } = await filing(tx, sample, FINANCE, "Revenue");
      const references = [
        variant.id,
        { dataset: FINANCE, measure: "Revenue" },
        randomUUID(),
        "not an id",
      ];
      for (const reference of references) {
        await expect(getVariant(context, reference)).rejects.toMatchObject({
          kind: "not_found",
          message: "No such variant.",
        });
      }
      const seen = await getVariant(context, {
        dataset: SALES,
        measure: "Net sales LY",
      });
      expect(seen.shift.period).toBe("previous_year");
    }));
});

describe("listVariants", () => {
  it("filters the metric's variants by dataset, workspace and shift, and pages by measure name", () =>
    drafted(async (tx, sample) => {
      const context = asPerson(curator, { db: tx });
      const net = (await filing(tx, sample, SALES, "Net sales")).metric.name;
      const revenue = await filing(tx, sample, FINANCE, "Revenue");
      await mergeMetrics(context, { from: revenue.metric.name, into: net });
      const names = async (filters: Parameters<typeof listVariants>[2]) =>
        (await listVariants(context, net, filters)).items.map(
          (item) => item.measure.name,
        );
      expect(await names({ dataset: FINANCE })).toEqual([
        "Revenue",
        "Revenue PQ",
        "Revenue PY",
        "Revenue PY YTD",
        "Revenue YTD",
      ]);
      expect(await names({ period: "previous_year" })).toEqual([
        "Net sales LY",
        "Revenue PY",
      ]);
      expect(await names({ comparison: "growth_rate" })).toEqual([
        "Net sales growth",
      ]);
      expect(await names({ workspace: MARKETING, currency: null })).toEqual([
        "Net Sales",
      ]);
      expect(await names({ currency: "USD" })).toEqual([]);

      const first = await listVariants(context, net, {
        dataset: SALES,
        limit: 3,
      });
      expect(first.items.map((item) => item.measure.name)).toEqual([
        "Net sales",
        "Net sales growth",
        "Net sales LY",
      ]);
      expect(first.items[0]).toMatchObject({
        kind: "variant",
        dataset: { name: SALES },
        measure_reference: "[Net sales]",
        shift: { period: "current", comparison: "none", currency: null },
        reads_selection: false,
      });
      expect(first.items[0]).not.toHaveProperty("expression");
      const next = await listVariants(context, net, {
        dataset: SALES,
        cursor: first.next_cursor ?? "",
      });
      expect(next.items.map((item) => item.measure.name)).toEqual([
        "Net sales LY YTD",
        "Net sales MTD",
        "Net sales QTD",
        "Net sales vs LY",
        "Net sales YTD",
      ]);
    }));

  it("puts equal measure names in order of workspace, whatever their ids, and pages across them", () =>
    drafted(async (tx, sample) => {
      const context = asPerson(curator, { db: tx });
      const sales = await filing(tx, sample, SALES, "Orders");
      const marketing = await filing(tx, sample, MARKETING, "Orders");
      expect(marketing.metric.id).toBe(sales.metric.id);
      // Ids that would put Sales first, as a random draw sometimes does.
      await tx
        .update(metricVariant)
        .set({ id: "00000000-0000-4000-8000-000000000001" })
        .where(eq(metricVariant.id, sales.variant.id));
      await tx
        .update(metricVariant)
        .set({ id: "ffffffff-ffff-4fff-8fff-ffffffffffff" })
        .where(eq(metricVariant.id, marketing.variant.id));
      const orders = sales.metric.name;
      const equal = <T extends { measure: { name: string } }>(items: T[]) =>
        items.filter((item) => item.measure.name === "Orders");

      const { items } = await listVariants(context, orders);
      expect(equal(items).map((item) => item.dataset.name)).toEqual([
        MARKETING,
        SALES,
      ]);

      const first = await listVariants(context, orders, { limit: 1 });
      expect(first).toHaveProperty("total", items.length);
      const second = await listVariants(context, orders, {
        limit: 1,
        cursor: first.next_cursor ?? "",
      });
      expect(
        [...first.items, ...second.items].map((item) => item.dataset.name),
      ).toEqual([MARKETING, SALES]);

      expect(second).not.toHaveProperty("total");
      // One at a time, the pages give every variant once, in the list's order.
      const paged: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await listVariants(context, orders, { limit: 1, cursor });
        paged.push(...page.items.map((item) => item.id));
        cursor = page.next_cursor ?? undefined;
      } while (cursor !== undefined);
      expect(paged).toEqual(items.map((item) => item.id));
    }));

  it("lists to a viewer only the variants in datasets it may describe", () =>
    drafted(async (tx, sample) => {
      const context = asPerson(viewer, { db: tx });
      const net = (await filing(tx, sample, SALES, "Net sales")).metric.name;
      const { items } = await listVariants(context, net);
      const datasets = new Set(items.map((item) => item.dataset.name));
      expect(datasets).toEqual(new Set([SALES]));
      const margin = (await filing(tx, sample, FINANCE, "Gross margin")).metric
        .name;
      await expect(listVariants(context, margin)).rejects.toMatchObject({
        kind: "not_found",
      });
    }));
});
