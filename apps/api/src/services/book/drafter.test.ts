import {
  EXPECTED_CYCLE,
  EXPECTED_DISMISSED,
  EXPECTED_DRAFTS,
  EXPECTED_NOT_GROUPED,
  EXPECTED_READS_SELECTION,
  EXPECTED_UNPROVEN_SHIFTS,
} from "@powerbi-metrics-book/powerbi-mock";
import { randomUUID } from "node:crypto";
import {
  eq,
  inArray,
  isNull,
  like,
  sql,
  TransactionRollbackError,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  closeTestPools,
  createTestDeps,
  principals,
  testPool,
} from "../../../test/deps.js";
import { TEST_RUNNER } from "../../../test/database.js";
import { eventsSince } from "../../../test/events.js";
import { waitingOn } from "../../../test/locks.js";
import { asPerson, reaching } from "../../../test/mirror-fixtures.js";
import {
  inSampleMirror,
  loadSampleMirror,
  rolledBack,
  type SampleMirror,
  setRole,
} from "../../../test/sample-mirror.js";
import type { Db } from "../../context.js";
import { fingerprint, normalize } from "../../dax/index.js";
import { createDb } from "../../db/client.js";
import { bookChange, metric, metricVariant } from "../../db/schema/book.js";
import * as schema from "../../db/schema/index.js";
import {
  powerbiApp,
  powerbiDataset,
  powerbiMeasure,
  powerbiTable,
  powerbiWorkspace,
} from "../../db/schema/mirror.js";
import { setConventions } from "../conventions/store.js";
import { draftDatasets } from "./drafter.js";
import { moveVariant } from "./variants.js";

afterAll(closeTestPools);

type SampleMeasure = { dataset: string; measure: string };
type Filing = {
  variant: typeof metricVariant.$inferSelect;
  metric: typeof metric.$inferSelect;
};
type Lookup = (measure: SampleMeasure) => Filing;

const SALES = "Sales";
const FINANCE = "Finance";
const NET_SALES = { dataset: SALES, measure: "Net sales" };
const REVENUE = { dataset: FINANCE, measure: "Revenue" };
const NONE = {
  created: 0,
  filed: 0,
  regrouped: 0,
  dismissed: 0,
  deleted: 0,
  renamed: 0,
  failed: 0,
  failed_datasets: [],
};
const BASE = { period: "current", comparison: "none", comparison_period: null };
const OTHER = { ...BASE, period: "other" };
const UNPROVEN_SHIFTS = new Set(EXPECTED_UNPROVEN_SHIFTS);
const SAMPLE_PERIODS = [
  "previous_year",
  "previous_quarter",
  "previous_month",
  "previous_week",
  "previous_day",
  "year_to_date",
  "quarter_to_date",
  "month_to_date",
  "previous_year_to_date",
  "rolling_12_months",
];

const LINES = { dataset: SALES, measure: "Order lines" };
const LINES_LM = { dataset: SALES, measure: "Order lines LM" };
const LINES_LW = { dataset: SALES, measure: "Order lines LW" };
const LINES_LY = { dataset: SALES, measure: "Order lines LY" };
const LINES_WOW = { dataset: SALES, measure: "Order lines WoW" };

/** The expected draft whose base holds this measure. */
function expectedDraft({ measure }: SampleMeasure) {
  const found = EXPECTED_DRAFTS.find((d) =>
    d.base.some((b) => b.measure === measure),
  );
  if (found === undefined) throw new Error(`EXPECTED_DRAFTS has no ${measure}`);
  return found;
}

const draft = (tx: Db, sample: SampleMirror) =>
  draftDatasets(
    createTestDeps({ container: "worker", db: tx }),
    sample.tenant.datasets.map((dataset) => dataset.id),
  );

/** Every measure's variant and metric as they are now. */
async function filings(tx: Db, sample: SampleMirror): Promise<Lookup> {
  const rows = await tx
    .select({ variant: metricVariant, metric })
    .from(metricVariant)
    .innerJoin(metric, eq(metric.id, metricVariant.metric_id));
  const byMeasure = new Map(rows.map((row) => [row.variant.measure_id, row]));
  return (measure) => {
    const found = byMeasure.get(sample.measureId(measure));
    if (found === undefined) throw new Error(`${measure.measure} is not filed`);
    return found;
  };
}

/** The sample mirror, drafted once under the default conventions. */
const drafted = (
  work: (tx: Db, sample: SampleMirror, of: Lookup) => Promise<void> | void,
) =>
  inSampleMirror("worker_rw", async (tx, sample) => {
    await draft(tx, sample);
    await work(tx, sample, await filings(tx, sample));
  });

/** Adds a measure to the table that holds `beside`, and gives its id. */
async function addMeasure(
  tx: Db,
  sample: SampleMirror,
  beside: SampleMeasure,
  measure: { name: string; expression: string },
): Promise<string> {
  const { dataset_id, table_id } = one(
    await tx
      .select()
      .from(powerbiMeasure)
      .where(eq(powerbiMeasure.id, sample.measureId(beside))),
  );
  const added = await tx
    .insert(powerbiMeasure)
    .values({ dataset_id, table_id, ...measure })
    .returning();
  return one(added).id;
}

/** Sets the drafting conventions over the default preset, as the api does, and goes back to being the worker. */
async function setDrafting(tx: Db, drafting: Record<string, unknown>) {
  await setRole(tx, "api_rw");
  await setConventions({ db: tx }, principals.admin, {
    preset: "metrics_book",
    drafting,
  });
  await setRole(tx, "worker_rw");
}

/**
 * The sample as a book drafted before the drafter read these shifts: every
 * calculation in a draft of its own, and Order lines' two spellings in two.
 */
const olderBook = (
  work: (tx: Db, sample: SampleMirror, of: Lookup) => Promise<void>,
) =>
  inSampleMirror("worker_rw", async (tx, sample) => {
    await setDrafting(tx, { recognise_time_intelligence: false });
    await draft(tx, sample);
    const spelling = one(
      await tx
        .insert(metric)
        .values({
          name: "order_lines_3",
          label: "Order lines",
          origin: "sync",
          trust_state: "draft",
          name_is_generated: true,
        })
        .returning(),
    );
    await tx
      .update(metricVariant)
      .set({ metric_id: spelling.id })
      .where(
        eq(
          metricVariant.measure_id,
          sample.measureId({ dataset: "Marketing", measure: "Order lines" }),
        ),
      );
    await setDrafting(tx, {});
    await work(tx, sample, await filings(tx, sample));
  });

function one<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error("Expected a row");
  return row;
}

/** The measure's variant, if it has one. */
const variantOf = async (tx: Db, measureId: string) =>
  (
    await tx
      .select()
      .from(metricVariant)
      .where(eq(metricVariant.measure_id, measureId))
  ).at(0);

describe("draftDatasets on the sample mirror", () => {
  it("makes the drafts EXPECTED_DRAFTS names, and only those, recording each change", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const events = await eventsSince(tx);
      const counts = await draft(tx, sample);
      const of = await filings(tx, sample);
      const ids = new Set<string>();
      for (const { base, variants } of EXPECTED_DRAFTS) {
        const filed = [...base, ...variants].map(of);
        expect(new Set(filed.map((f) => f.metric.id)).size).toBe(1);
        for (const f of filed) ids.add(f.metric.id);
        for (const measure of base) {
          expect(of(measure).variant).toMatchObject({
            ...(UNPROVEN_SHIFTS.has(measure.measure) ? OTHER : BASE),
            assigned_by: "sync",
          });
          expect(of(measure).metric).toMatchObject({
            origin: "sync",
            trust_state: "draft",
            name_is_generated: true,
            dismissed_at: null,
          });
        }
        for (const v of variants)
          expect(of(v).variant).toMatchObject({
            ...v.shift,
            shift_note: v.note ?? null,
          });
      }
      expect(ids.size).toBe(EXPECTED_DRAFTS.length);
      const live = await tx
        .select()
        .from(metric)
        .where(isNull(metric.dismissed_at));
      expect(live).toHaveLength(EXPECTED_DRAFTS.length);
      expect(of(NET_SALES).metric.name).toBe("net_sales");
      expect(of(NET_SALES).metric.label).toBe("Net sales");

      const measures = EXPECTED_DRAFTS.flatMap((d) => [
        ...d.base,
        ...d.variants,
      ]);
      expect(counts).toEqual({
        ...NONE,
        created: EXPECTED_DRAFTS.length + EXPECTED_DISMISSED.length,
        filed: measures.length + EXPECTED_DISMISSED.length,
        dismissed: EXPECTED_DISMISSED.length,
      });
      const changes = await tx.select().from(bookChange);
      const actions = changes.map(
        (c) => `${c.action} ${c.principal_kind} ${c.principal_id}`,
      );
      expect(actions.filter((a) => a === "create system sync")).toHaveLength(
        counts.created,
      );
      expect(actions.filter((a) => a === "file system sync")).toHaveLength(
        counts.filed,
      );
      const kinds = (await events.read()).map((e) => e.kind);
      expect(kinds.filter((k) => k === "draft.created")).toHaveLength(
        counts.created,
      );
      expect(kinds.filter((k) => k === "variant.moved")).toHaveLength(
        counts.filed,
      );
      // A metric's event records the datasets it is in as a list, never a single dataset_id.
      const created = (await events.read()).filter(
        (e) => e.kind === "draft.created",
      );
      expect(created.map((e) => Object.keys(e.data).sort())).toEqual(
        created.map(() => [
          "dataset_ids",
          "dismissed_reason",
          "measure_ids",
          "name",
        ]),
      );
      const sales = sample.tenant.datasets.find((d) => d.name === SALES)?.id;
      expect(
        created.find((e) => e.element_id === of(NET_SALES).metric.id)?.data
          .dataset_ids,
      ).toEqual([sales]);
    }));

  it("keeps apart what EXPECTED_NOT_GROUPED pairs, and flags what reads the selection", () =>
    drafted((_tx, _sample, of) => {
      for (const {
        measures: [one, other],
      } of EXPECTED_NOT_GROUPED) {
        expect(of(one).metric.id).not.toBe(of(other).metric.id);
      }
      for (const { columns, ...measure } of EXPECTED_READS_SELECTION) {
        expect(of(measure).variant.reads_selection).toBe(true);
        expect(of(measure).variant.selection_columns).toEqual(columns);
      }
      expect(of(REVENUE).variant.reads_selection).toBe(false);
    }));

  it("dismisses EXPECTED_DISMISSED and records the cycle without filing it", () =>
    drafted(async (tx, sample, of) => {
      for (const { reason, ...measure } of EXPECTED_DISMISSED) {
        expect(of(measure).metric.dismissed_reason).toBe(reason);
        expect(of(measure).metric.dismissed_at).toBeInstanceOf(Date);
      }
      const { dataset, measures } = EXPECTED_CYCLE;
      const ids = measures.map((measure) =>
        sample.measureId({ dataset, measure }),
      );
      const cycle = await tx
        .select()
        .from(powerbiMeasure)
        .where(inArray(powerbiMeasure.id, ids));
      expect(cycle.map((row) => row.fingerprint)).toEqual([null, null, null]);
      for (const row of cycle)
        expect(row.fingerprint_error).toMatch(/^Reference cycle: /);
      const filed = await tx
        .select()
        .from(metricVariant)
        .where(inArray(metricVariant.measure_id, ids));
      expect(filed).toEqual([]);
    }));

  it("changes nothing on a second run", () =>
    drafted(async (tx, sample) => {
      const before = await tx.select().from(bookChange);
      expect(await draft(tx, sample)).toEqual(NONE);
      expect(await tx.select().from(bookChange)).toHaveLength(before.length);
    }));

  it("never moves a curator's filing: a moved variant, a touched metric, a dismissed draft", () =>
    drafted(async (tx, sample, of) => {
      const usd = of({ dataset: FINANCE, measure: "Revenue USD" }).variant;
      await tx
        .update(metricVariant)
        .set({
          metric_id: of(NET_SALES).metric.id,
          currency: "USD",
          assigned_by: "curator",
        })
        .where(eq(metricVariant.id, usd.id));
      // A touched metric keeps its measures even when one stops computing the same thing.
      const orders = { dataset: SALES, measure: "Orders" };
      await tx
        .update(metric)
        .set({ touched_at: new Date() })
        .where(eq(metric.id, of(orders).metric.id));
      await tx
        .update(powerbiMeasure)
        .set({
          expression: "COUNTROWS(Sales) * 2",
          expression_changed_at: new Date(),
        })
        .where(eq(powerbiMeasure.id, sample.measureId(orders)));
      const adSpendLy = {
        dataset: "Marketing",
        measure: "Ad spend LY",
      };
      await tx
        .update(metric)
        .set({
          dismissed_at: new Date(),
          dismissed_reason: "A copy",
          touched_at: new Date(),
        })
        .where(eq(metric.id, of(adSpendLy).metric.id));

      const before = await tx.select().from(metricVariant);
      // Revenue USD's own draft is left empty, so it goes.
      expect(await draft(tx, sample)).toEqual({ ...NONE, deleted: 1 });
      const after = await tx.select().from(metricVariant);
      expect(after).toHaveLength(before.length);
      expect(after).toEqual(expect.arrayContaining(before));
    }));

  it("regroups a measure whose expression changed under an untouched draft, with its variants", () =>
    drafted(async (tx, sample, of) => {
      await tx
        .update(powerbiMeasure)
        .set({
          expression: "SUMX(Sales, Sales[Net amount])",
          expression_changed_at: new Date(),
        })
        .where(eq(powerbiMeasure.id, sample.measureId(NET_SALES)));
      const { variants } = expectedDraft(NET_SALES);
      const salesVariants = variants.filter((v) => v.dataset === SALES);
      expect(await draft(tx, sample)).toEqual({
        ...NONE,
        created: 1,
        regrouped: 1 + salesVariants.length,
      });

      const after = await filings(tx, sample);
      const regrouped = after(NET_SALES).metric;
      expect(regrouped.name).toBe("net_sales_3");
      const marketing = { dataset: "Marketing", measure: "Net Sales" };
      expect(after(marketing).metric.id).toBe(of(NET_SALES).metric.id);
      for (const v of salesVariants)
        expect(after(v).metric.id).toBe(regrouped.id);
    }));

  it("deletes an emptied draft unless a curator made or touched it", () =>
    drafted(async (tx, sample, of) => {
      // No other measure reads these two, so removing them proves nothing away.
      const orderCount = { dataset: FINANCE, measure: "Order count" };
      const costPerClick = { dataset: "Marketing", measure: "Cost per click" };
      const touched = of(costPerClick).metric.id;
      await tx
        .update(metric)
        .set({ touched_at: new Date() })
        .where(eq(metric.id, touched));
      const curators = one(
        await tx
          .insert(metric)
          .values({ name: "curators_own", label: "Own", origin: "curator" })
          .returning(),
      ).id;
      const emptied = [orderCount, costPerClick].flatMap((measure) => {
        const { base, variants } = expectedDraft(measure);
        return [...base, ...variants].map((m) => sample.measureId(m));
      });
      await tx
        .update(powerbiMeasure)
        .set({ removed_at: new Date() })
        .where(inArray(powerbiMeasure.id, emptied));
      expect(await draft(tx, sample)).toEqual({ ...NONE, deleted: 1 });
      const ids = [of(orderCount).metric.id, touched, curators];
      const left = await tx
        .select()
        .from(metric)
        .where(inArray(metric.id, ids));
      expect(left.map((row) => row.id).sort()).toEqual(
        [touched, curators].sort(),
      );
    }));

  it("drafts nothing the conventions' skip rules name", () =>
    // The api sets the conventions; the worker drafts by them.
    inSampleMirror("api_rw", async (tx, sample) => {
      await setConventions({ db: tx }, principals.admin, {
        drafting: {
          skip: {
            hidden_measures: true,
            display_folders: ["Comparisons"],
            tables: ["Web sessions"],
            name_patterns: ["^Units sold"],
          },
        },
      });
      await setRole(tx, "worker_rw");
      await draft(tx, sample);
      const skipped = [
        { dataset: FINANCE, measure: "_Currency format" },
        { dataset: SALES, measure: "Net sales vs LY" },
        { dataset: "Marketing", measure: "Sessions" },
        { dataset: SALES, measure: "Units sold" },
      ];
      for (const measure of skipped) {
        expect(await variantOf(tx, sample.measureId(measure))).toBeUndefined();
      }
      expect(await variantOf(tx, sample.measureId(REVENUE))).toBeDefined();
    }));

  it("keeps columns on different tables in separate drafts despite a measure with the same name", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const units = await addMeasure(tx, sample, NET_SALES, {
        name: "Units",
        expression: "SUM(C[Quantity])",
      });
      const returned = await addMeasure(tx, sample, NET_SALES, {
        name: "Returned units",
        expression: "SUM(A[Units])",
      });
      const stock = await addMeasure(tx, sample, NET_SALES, {
        name: "Units on hand",
        expression: "SUM(B[Units])",
      });
      await draft(tx, sample);
      const variants = await tx
        .select({ metric })
        .from(metricVariant)
        .innerJoin(metric, eq(metric.id, metricVariant.metric_id))
        .where(inArray(metricVariant.measure_id, [returned, stock]));
      expect(variants).toHaveLength(2);
      expect(new Set(variants.map((row) => row.metric.id)).size).toBe(2);
      for (const row of variants) expect(row.metric.trust_state).toBe("draft");
      await tx
        .update(powerbiMeasure)
        .set({ expression: null })
        .where(eq(powerbiMeasure.id, units));
      await draft(tx, sample);
      const columns = await tx
        .select({ error: powerbiMeasure.fingerprint_error })
        .from(powerbiMeasure)
        .where(inArray(powerbiMeasure.id, [returned, stock]));
      expect(columns).toEqual([{ error: null }, { error: null }]);
    }));

  it("flags a measure that reads the selection through another measure", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const id = await addMeasure(tx, sample, REVENUE, {
        name: "Twice the revenue in selected currency",
        expression: "[Revenue in selected currency] * 2",
      });
      await draft(tx, sample);
      expect(await variantOf(tx, id)).toMatchObject({
        reads_selection: true,
        selection_columns: ["'Exchange rate'[Currency]"],
      });
    }));

  it("keeps a shared draft with the measure that did not change", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const before = "SUM(Sales[Quantity]) * 7";
      const print = (expression: string) => fingerprint(normalize(expression));
      // A new fingerprint that sorts first, so the order of fingerprints cannot be what keeps the draft.
      const after = Array.from(
        { length: 200 },
        (_, n) => `SUM(Sales[Quantity]) * ${String(n + 8)}`,
      ).find((expression) => print(expression) < print(before));
      if (after === undefined) throw new Error("No expression sorts first");
      const [zetaA, zetaB] = [
        await addMeasure(tx, sample, NET_SALES, {
          name: "Zeta A",
          expression: before,
        }),
        await addMeasure(tx, sample, NET_SALES, {
          name: "Zeta B",
          expression: before,
        }),
      ];
      await draft(tx, sample);
      const shared = (await variantOf(tx, zetaA))?.metric_id;
      expect((await variantOf(tx, zetaB))?.metric_id).toBe(shared);

      await tx
        .update(powerbiMeasure)
        .set({ expression: after })
        .where(eq(powerbiMeasure.id, zetaB));
      await draft(tx, sample);
      expect((await variantOf(tx, zetaA))?.metric_id).toBe(shared);
      expect((await variantOf(tx, zetaB))?.metric_id).not.toBe(shared);
    }));

  it("lets a curator's move stand when it lands while a run reads and writes", async () => {
    // Two sessions must see the same rows, so this test alone commits: a
    // dataset of its own, not the sample, removed with its workspace after.
    const worker = createDb(testPool("worker_rw"));
    const tag = randomUUID();
    const workspace = { id: randomUUID(), name: `Drafter race ${tag}` };
    const dataset = {
      ...workspace,
      id: randomUUID(),
      workspace_id: workspace.id,
    };
    await worker.insert(powerbiWorkspace).values(workspace);
    const curator = await testPool("api_rw").connect();
    try {
      await worker.insert(powerbiDataset).values(dataset);
      const { id: table_id } = one(
        await worker
          .insert(powerbiTable)
          .values({ dataset_id: dataset.id, name: "Race" })
          .returning(),
      );
      const [moved, filed] = await worker
        .insert(powerbiMeasure)
        .values(
          ["Moved", "Filed"].map((name) => ({
            dataset_id: dataset.id,
            table_id,
            name,
            expression: `SUM('Race'[${name} amount])`,
          })),
        )
        .returning();
      const [syncs, curated] = await worker
        .insert(metric)
        .values([
          { name: `race_${tag}`, label: "Race", origin: "sync" },
          { name: `race_curated_${tag}`, label: "Race", origin: "curator" },
        ])
        .returning();
      if (!moved || !filed || !syncs || !curated) throw new Error("No race");
      // Filed by the sync with a shift the run corrects, so the run writes the row.
      const variant = one(
        await worker
          .insert(metricVariant)
          .values({
            metric_id: syncs.id,
            measure_id: moved.id,
            period: "previous_year",
            assigned_by: "sync",
          })
          .returning(),
      );
      await curator.query("begin");
      await curator.query(
        "update metric_variant set metric_id = $1, assigned_by = 'curator' where id = $2",
        [curated.id, variant.id],
      );
      // And files a measure the run will read as unfiled.
      await curator.query(
        "insert into metric_variant (metric_id, measure_id, assigned_by) values ($1, $2, 'curator')",
        [curated.id, filed.id],
      );
      const { rows } = await curator.query<{ pid: number }>(
        "select pg_backend_pid() as pid",
      );
      const run = rolledBack("worker_rw", async (tx) => {
        const deps = createTestDeps({ container: "worker", db: tx });
        await draftDatasets(deps, [dataset.id]);
        for (const { id } of [moved, filed]) {
          expect(await variantOf(tx, id)).toMatchObject({
            metric_id: curated.id,
            assigned_by: "curator",
          });
        }
      });
      await waitingOn(one(rows).pid, 1);
      await curator.query("commit");
      await run;
    } finally {
      await curator.query("rollback");
      curator.release();
      await worker.delete(metric).where(like(metric.name, `race_%${tag}`));
      await worker
        .delete(powerbiWorkspace)
        .where(eq(powerbiWorkspace.id, workspace.id));
    }
  });

  it("waits in turn with a curator's move on the same metric, and neither deadlocks", async () => {
    // Each runs in a session of its own, rolled back after it, on rows this
    // test commits: a dataset of its own, removed with its workspace after.
    const worker = createDb(testPool("worker_rw"));
    const tag = randomUUID();
    const workspace = { id: randomUUID(), name: `Drafter and move ${tag}` };
    await worker.insert(powerbiWorkspace).values(workspace);
    const blocker = await testPool("api_rw").connect();
    try {
      const dataset = { ...workspace, id: randomUUID() };
      await worker
        .insert(powerbiDataset)
        .values({ ...dataset, workspace_id: workspace.id });
      const { id: table_id } = one(
        await worker
          .insert(powerbiTable)
          .values({ dataset_id: dataset.id, name: "Race" })
          .returning(),
      );
      /** A measure filed under a metric of its own. */
      const filed = async (name: string, by: "sync" | "curator") => {
        const measure = one(
          await worker
            .insert(powerbiMeasure)
            .values({
              dataset_id: dataset.id,
              table_id,
              name,
              expression: `SUM('Race'[${name} ${tag}])`,
            })
            .returning(),
        );
        const held = one(
          await worker
            .insert(metric)
            .values({ name: `race_${name}_${tag}`, label: name, origin: by })
            .returning(),
        );
        const variant = one(
          await worker
            .insert(metricVariant)
            .values({
              metric_id: held.id,
              measure_id: measure.id,
              assigned_by: by,
            })
            .returning(),
        );
        return { metric: held, variant };
      };
      const draft = await filed("alpha", "sync");
      const curated = await filed("beta", "curator");
      const settled = (
        role: "api_rw" | "worker_rw",
        work: (tx: Db) => Promise<unknown>,
      ) => {
        let outcome: unknown;
        return rolledBack(role, async (tx) => {
          outcome = await work(tx).then(
            () => "done",
            (error: unknown) => error,
          );
        }).then(() => outcome);
      };
      // Both wait on the metrics this session holds, the move first.
      await blocker.query("begin");
      await blocker.query("select from metric where id = any($1) for update", [
        [draft.metric.id, curated.metric.id],
      ]);
      const { rows } = await blocker.query<{ pid: number }>(
        "select pg_backend_pid() as pid",
      );
      const curator = reaching(
        { powerbi_workspace_ids: [workspace.id] },
        "curator",
      );
      const move = settled("api_rw", (tx) =>
        moveVariant(asPerson(curator, { db: tx }), draft.variant.id, {
          to_metric: curated.metric.name,
          period: "previous_year",
        }),
      );
      await waitingOn(one(rows).pid, 1);
      const run = settled("worker_rw", (tx) =>
        draftDatasets(createTestDeps({ container: "worker", db: tx }), [
          dataset.id,
        ]),
      );
      await waitingOn(one(rows).pid, 2);
      await blocker.query("commit");
      expect(await Promise.all([move, run])).toEqual(["done", "done"]);
    } finally {
      await blocker.query("rollback");
      blocker.release();
      await worker.delete(metric).where(like(metric.name, `race_%_${tag}`));
      await worker
        .delete(powerbiWorkspace)
        .where(eq(powerbiWorkspace.id, workspace.id));
    }
  });

  it("recognises no variant under the minimal preset with recognise_time_intelligence off", () =>
    // The api sets the conventions; the worker drafts by them.
    inSampleMirror("api_rw", async (tx, sample) => {
      await setConventions({ db: tx }, principals.admin, {
        preset: "minimal",
        drafting: { recognise_time_intelligence: false },
      });
      await setRole(tx, "worker_rw");
      await draft(tx, sample);
      const variants = await tx.select().from(metricVariant);
      expect(variants.length).toBeGreaterThan(EXPECTED_DRAFTS.length);
      expect(
        variants.filter(
          (v) => v.period !== "current" || v.comparison !== "none",
        ),
      ).toEqual([]);
    }));

  it("folds a book drafted under older rules into the drafts EXPECTED_DRAFTS names, then changes nothing", () =>
    olderBook(async (tx, sample) => {
      const counts = await draft(tx, sample);
      // Order lines LM leaves for its base, and Order lines LQ, which shared its
      // draft, takes a draft of its own name rather than keep LM's.
      expect(counts).toMatchObject({ created: 1, filed: 0, dismissed: 0 });
      expect(
        (await filings(tx, sample))({
          dataset: SALES,
          measure: "Order lines LQ",
        }).metric.name,
      ).toBe("order_lines_lq");
      const of = await filings(tx, sample);
      for (const { base, variants } of EXPECTED_DRAFTS) {
        const filed = [...base, ...variants].map(of);
        expect(new Set(filed.map((f) => f.metric.id)).size).toBe(1);
        for (const v of variants)
          expect(of(v).variant).toMatchObject({
            ...v.shift,
            shift_note: v.note ?? null,
          });
      }
      const live = await tx
        .select()
        .from(metric)
        .where(isNull(metric.dismissed_at));
      expect(live).toHaveLength(EXPECTED_DRAFTS.length);

      expect(await draft(tx, sample)).toEqual(NONE);
    }));

  it("folds around a curator's filing: a filed measure, a touched draft and a dismissed draft stay exactly as they are", () =>
    olderBook(async (tx, sample, of) => {
      await tx
        .update(metricVariant)
        .set({ assigned_by: "curator", shift_note: "Zero on purpose." })
        .where(eq(metricVariant.measure_id, sample.measureId(LINES_LW)));
      await tx
        .update(metric)
        .set({ touched_at: new Date() })
        .where(eq(metric.id, of(LINES_LM).metric.id));
      await tx
        .update(metric)
        .set({ dismissed_at: new Date(), dismissed_reason: "A copy" })
        .where(eq(metric.id, of(LINES_WOW).metric.id));
      const held = [LINES_LW, LINES_LM, LINES_WOW];
      const before = await filings(tx, sample);

      await draft(tx, sample);

      const after = await filings(tx, sample);
      for (const measure of held)
        expect(after(measure)).toEqual(before(measure));
      expect(after(LINES_LY).metric.id).toBe(after(LINES).metric.id);
      expect(after(LINES_LY).variant.period).toBe("previous_year");
      expect(await draft(tx, sample)).toEqual(NONE);
    }));

  describe("with a shift composed of shifted measures", () => {
    const MARGIN = { dataset: FINANCE, measure: "Gross margin %" };
    const MARGIN_PY = { dataset: FINANCE, measure: "Gross margin % PY" };
    const MARGIN_PQ = { dataset: FINANCE, measure: "Gross margin % PQ" };
    const MARGIN_VS_PY = { dataset: FINANCE, measure: "Gross margin % vs PY" };
    const PER_ORDER = { dataset: SALES, measure: "Units per order" };
    const PER_ORDER_PM = { dataset: SALES, measure: "Units per order PM" };
    const COMPOSED = [MARGIN_PY, MARGIN_PQ, MARGIN_VS_PY];

    it("folds around a curator's filing of one, and moves none that a curator holds", () =>
      olderBook(async (tx, sample, of) => {
        await tx
          .update(metricVariant)
          .set({ assigned_by: "curator", shift_note: "Kept on purpose." })
          .where(eq(metricVariant.measure_id, sample.measureId(MARGIN_PY)));
        await tx
          .update(metric)
          .set({ touched_at: new Date() })
          .where(eq(metric.id, of(MARGIN_PQ).metric.id));
        await tx
          .update(metric)
          .set({ dismissed_at: new Date(), dismissed_reason: "A copy" })
          .where(eq(metric.id, of(MARGIN_VS_PY).metric.id));
        const before = await filings(tx, sample);

        await draft(tx, sample);

        const after = await filings(tx, sample);
        for (const measure of COMPOSED)
          expect(after(measure)).toEqual(before(measure));
        expect(after(PER_ORDER_PM).metric.id).toBe(after(PER_ORDER).metric.id);
        expect(await draft(tx, sample)).toEqual(NONE);
      }));

    it("files one under a base a curator holds, and stays there", () =>
      olderBook(async (tx, sample, of) => {
        const margin = of(MARGIN).metric.id;
        await tx
          .update(metric)
          .set({ touched_at: new Date() })
          .where(eq(metric.id, margin));
        const own = of(MARGIN_PY).metric.id;

        await draft(tx, sample);

        const after = await filings(tx, sample);
        expect(after(MARGIN).metric.id).toBe(margin);
        expect(after(MARGIN_PY).metric.id).toBe(margin);
        expect(after(MARGIN_PY).variant).toMatchObject({
          period: "previous_year",
          assigned_by: "sync",
        });
        const [left] = await tx.select().from(metric).where(eq(metric.id, own));
        expect(left).toBeUndefined();
        expect(await draft(tx, sample)).toEqual(NONE);
      }));

    it("gives way to another calculation that holds its shift, on every run", () =>
      drafted(async (tx, sample, of) => {
        const newer = await addMeasure(tx, sample, MARGIN, {
          // Sorts first, and first come would otherwise take the place.
          name: "A gross margin rate last year",
          expression:
            "CALCULATE([Gross margin %], DATEADD('Date'[Date], -1, YEAR))",
        });
        const before = of(MARGIN_PY);
        await draft(tx, sample);
        const after = await filings(tx, sample);
        expect(after(MARGIN_PY).variant).toEqual(before.variant);
        const placed = await variantOf(tx, newer);
        expect(placed).toMatchObject(BASE);
        expect(placed?.metric_id).not.toBe(of(MARGIN).metric.id);
        expect(await draft(tx, sample)).toEqual(NONE);
      }));

    it("keeps its shift, and what compares against it, when a copy of the base arrives", () =>
      drafted(async (tx, sample, of) => {
        const other = await addMeasure(tx, sample, MARGIN, {
          name: "A gross margin rate last year",
          expression:
            "CALCULATE([Gross margin %], DATEADD('Date'[Date], -1, YEAR))",
        });
        await draft(tx, sample);
        const before = await variantOf(tx, other);

        // Sorts first, so a composed shift now names it as the base.
        const copy = await addMeasure(tx, sample, MARGIN, {
          name: "A copy of the margin rate",
          expression: "DIVIDE([Gross margin], [Revenue])",
        });
        await draft(tx, sample);

        const after = await filings(tx, sample);
        expect(after(MARGIN_PY).variant).toEqual(of(MARGIN_PY).variant);
        expect(after(MARGIN_VS_PY).variant).toEqual(of(MARGIN_VS_PY).variant);
        expect(await variantOf(tx, other)).toEqual(before);
        expect(await variantOf(tx, copy)).toMatchObject({
          ...BASE,
          metric_id: of(MARGIN).metric.id,
        });
        expect(await draft(tx, sample)).toEqual(NONE);
      }));

    it("files a shift under a copy of its base when a rule keeps the first by name out", () =>
      drafted(async (tx, sample, of) => {
        // The default conventions dismiss a measure named with a leading underscore.
        await addMeasure(tx, sample, MARGIN, {
          name: "_Margin helper",
          expression: "DIVIDE([Gross margin], [Revenue])",
        });
        await draft(tx, sample);
        const after = await filings(tx, sample);
        expect(after(MARGIN_PY).variant).toEqual(of(MARGIN_PY).variant);
        expect(after(MARGIN_VS_PY).variant).toEqual(of(MARGIN_VS_PY).variant);
        expect(await draft(tx, sample)).toEqual(NONE);
      }));

    it("holds a shift only on a live metric that has its calculation as a base", () =>
      drafted(async (tx, sample) => {
        const expression = "COUNTROWS(Sales) * 7";
        const zed = await addMeasure(tx, sample, MARGIN, {
          name: "Zed base",
          expression,
        });
        const moved = await addMeasure(tx, sample, MARGIN, {
          name: "A shift",
          expression: "CALCULATE([Zed base], DATEADD('Date'[Date], -1, YEAR))",
        });
        await draft(tx, sample);
        const gone = await variantOf(tx, zed);
        await tx
          .update(metric)
          .set({
            dismissed_at: new Date(Date.now() - 60_000),
            dismissed_reason: "A copy",
          })
          .where(eq(metric.id, String(gone?.metric_id)));
        const copy = await addMeasure(tx, sample, MARGIN, {
          name: "Base copy",
          expression,
        });
        const holder = await addMeasure(tx, sample, MARGIN, {
          name: "B shift",
          expression:
            "CALCULATE([Base copy], SAMEPERIODLASTYEAR('Date'[Date]))",
        });
        await draft(tx, sample);
        const live = await variantOf(tx, copy);
        expect(await variantOf(tx, holder)).toMatchObject({
          metric_id: live?.metric_id,
          period: "previous_year",
        });

        await tx
          .update(powerbiMeasure)
          .set({
            expression:
              "CALCULATE([Base copy], DATEADD('Date'[Date], -1, YEAR))",
            expression_changed_at: new Date(),
          })
          .where(eq(powerbiMeasure.id, moved));
        await draft(tx, sample);

        expect(await variantOf(tx, holder)).toMatchObject({
          metric_id: live?.metric_id,
          period: "previous_year",
        });
        expect((await variantOf(tx, moved))?.metric_id).not.toBe(
          live?.metric_id,
        );
      }));

    it("gives a shift to its plain form ahead of one that shows 0 for a blank", () =>
      inSampleMirror("worker_rw", async (tx, sample) => {
        const zero = await addMeasure(tx, sample, MARGIN, {
          name: "A gross margin rate last year or 0",
          expression: "DIVIDE([Gross margin PY], [Revenue PY], 0)",
        });
        await draft(tx, sample);
        const of = await filings(tx, sample);
        expect(of(MARGIN_PY).metric.id).toBe(of(MARGIN).metric.id);
        const placed = await variantOf(tx, zero);
        expect(placed).toMatchObject({ ...BASE, shift_note: null });
        expect(placed?.metric_id).not.toBe(of(MARGIN).metric.id);
        expect(await draft(tx, sample)).toEqual(NONE);
      }));

    it("files a second measure of one calculation under the shift the first holds", () =>
      drafted(async (tx, sample, of) => {
        const copy = await addMeasure(tx, sample, MARGIN, {
          name: "Gross margin % last year",
          expression: "DIVIDE( [Gross margin PY] , 'Sales'[Revenue PY] )",
        });
        expect(await draft(tx, sample)).toEqual({ ...NONE, filed: 1 });
        expect(await variantOf(tx, copy)).toMatchObject({
          metric_id: of(MARGIN).metric.id,
          period: "previous_year",
        });
      }));

    it("leaves for a draft of its own when a measure that proved it is removed, and takes what compared against it along", () =>
      drafted(async (tx, sample, of) => {
        await tx
          .update(powerbiMeasure)
          .set({ removed_at: new Date() })
          .where(
            eq(
              powerbiMeasure.id,
              sample.measureId({
                dataset: FINANCE,
                measure: "Gross margin PY",
              }),
            ),
          );

        await draft(tx, sample);

        const after = await filings(tx, sample);
        expect(after(MARGIN_PY).variant).toMatchObject(OTHER);
        expect(after(MARGIN_PY).metric.id).not.toBe(of(MARGIN).metric.id);
        expect(after(MARGIN_VS_PY).metric.id).not.toBe(of(MARGIN).metric.id);
        expect(after(MARGIN_PQ).variant).toEqual(of(MARGIN_PQ).variant);
        expect(await draft(tx, sample)).toEqual(NONE);
      }));

    it("reads its own zero only while the conventions say so, and a base's zero always", () =>
      inSampleMirror("worker_rw", async (tx, sample) => {
        await setDrafting(tx, { recognise_blank_as_zero: false });
        await draft(tx, sample);
        const of = await filings(tx, sample);
        expect(of(MARGIN_PQ).metric.id).not.toBe(of(MARGIN).metric.id);
        expect(of(MARGIN_PQ).variant).toMatchObject({
          ...OTHER,
          shift_note: null,
        });
        expect(of(MARGIN_PY).metric.id).toBe(of(MARGIN).metric.id);
        expect(of(PER_ORDER_PM).metric.id).toBe(of(PER_ORDER).metric.id);
        expect(of(PER_ORDER_PM).variant).toMatchObject({
          period: "previous_month",
          shift_note: null,
        });
      }));

    it("recognises none with time intelligence off", () =>
      inSampleMirror("worker_rw", async (tx, sample) => {
        await setDrafting(tx, { recognise_time_intelligence: false });
        await draft(tx, sample);
        const of = await filings(tx, sample);
        for (const measure of COMPOSED) {
          expect(of(measure).variant).toMatchObject(BASE);
          expect(of(measure).metric.id).not.toBe(of(MARGIN).metric.id);
        }
      }));
  });

  it("leaves a shift in its own draft while another calculation holds that shift on the metric, on every run", () =>
    olderBook(async (tx, sample, of) => {
      const lines = of(LINES).metric.id;
      const other = { dataset: SALES, measure: "Web order lines LM" };
      await tx
        .update(metric)
        .set({ touched_at: new Date() })
        .where(eq(metric.id, lines));
      await tx
        .update(metricVariant)
        .set({
          metric_id: lines,
          period: "previous_month",
          assigned_by: "curator",
        })
        .where(eq(metricVariant.measure_id, sample.measureId(other)));
      const own = of(LINES_LM).metric.id;

      await draft(tx, sample);

      const after = await filings(tx, sample);
      expect(after(LINES_LM).metric.id).toBe(own);
      expect(after(LINES_LM).variant).toMatchObject(BASE);
      expect(after(other).metric.id).toBe(lines);
      expect(after(other).variant.period).toBe("previous_month");
      expect(after(LINES_LY).metric.id).toBe(lines);
      expect(
        after({ dataset: "Marketing", measure: "Order lines" }).metric.id,
      ).toBe(lines);
      expect(await draft(tx, sample)).toEqual(NONE);
    }));

  it("files a second measure of one calculation under a shift the first holds", () =>
    drafted(async (tx, sample, of) => {
      const { expression } = one(
        await tx
          .select()
          .from(powerbiMeasure)
          .where(eq(powerbiMeasure.id, sample.measureId(LINES_LM))),
      );
      const copy = await addMeasure(tx, sample, LINES, {
        name: "Order lines PM",
        expression: expression ?? "",
      });
      expect(await draft(tx, sample)).toEqual({ ...NONE, filed: 1 });
      expect(await variantOf(tx, copy)).toMatchObject({
        metric_id: of(LINES).metric.id,
        period: "previous_month",
      });
    }));

  it("reads a blank shown as zero as the same calculation only while the conventions say so", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      await setDrafting(tx, { recognise_blank_as_zero: false });
      await draft(tx, sample);
      const of = await filings(tx, sample);
      for (const measure of [LINES_LW, LINES_WOW]) {
        expect(of(measure).metric.id).not.toBe(of(LINES).metric.id);
        expect(of(measure).variant).toMatchObject({
          ...OTHER,
          shift_note: null,
        });
      }
      expect(of(LINES_LY).metric.id).toBe(of(LINES).metric.id);
    }));

  it("reads a calendar column's period from the conventions' words", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      await setDrafting(tx, { period_words: { previous_month: ["Prior"] } });
      const prior = await addMeasure(tx, sample, LINES, {
        name: "Order lines prior",
        expression:
          "CALCULATE([Order lines], REMOVEFILTERS('Date'), DATESBETWEEN('Date'[Date], MIN('Date'[Date prior]), MAX('Date'[Date prior])))",
      });
      await draft(tx, sample);
      const of = await filings(tx, sample);
      expect(of(LINES_LM).metric.id).not.toBe(of(LINES).metric.id);
      expect(await variantOf(tx, prior)).toMatchObject({
        metric_id: of(LINES).metric.id,
        period: "previous_month",
      });
    }));

  it("keeps a shift with what holds it when a new measure of another calculation wants it, on every run", () =>
    drafted(async (tx, sample, of) => {
      const newer = await addMeasure(tx, sample, LINES, {
        // Sorts before Order lines LM, and first come would otherwise take the place.
        name: "Order lines A month back",
        expression:
          "CALCULATE([Order lines], DATEADD('Date'[Date], -1, MONTH))",
      });
      const before = of(LINES_LM);
      await draft(tx, sample);
      const after = await filings(tx, sample);
      expect(after(LINES_LM).variant).toEqual(before.variant);
      expect(after(LINES).metric.id).toBe(of(LINES).metric.id);
      const placed = await variantOf(tx, newer);
      expect(placed).toMatchObject(BASE);
      expect(placed?.metric_id).not.toBe(of(LINES).metric.id);
      expect(await draft(tx, sample)).toEqual(NONE);
    }));

  it("leaves a metric with its base when a shift filed there loses its place, whichever fingerprint sorts first", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const cases = [];
      for (let n = 1; n <= 8; n += 1) {
        const name = `Zed ${String(n)}`;
        cases.push({
          base: await addMeasure(tx, sample, LINES, {
            name,
            expression: `SUM(Sales[Quantity]) + ${String(n)}`,
          }),
          holder: await addMeasure(tx, sample, LINES, {
            name: `${name} LY`,
            expression: `CALCULATE([${name}], DATEADD('Date'[Date], -1, YEAR))`,
          }),
          loser: await addMeasure(tx, sample, LINES, {
            name: `${name} PY`,
            expression: `CALCULATE([${name}], SAMEPERIODLASTYEAR('Date'[Date]))`,
          }),
        });
      }
      await draft(tx, sample);
      const filed = async (id: string) => {
        const variant = await variantOf(tx, id);
        if (variant === undefined) throw new Error("Not filed");
        return variant;
      };
      // As the rules before this one filed them: both under the base's draft.
      const homes = [];
      for (const { base, loser } of cases) {
        const home = (await filed(base)).metric_id;
        homes.push(home);
        await tx
          .update(metricVariant)
          .set({ metric_id: home, period: "previous_year" })
          .where(eq(metricVariant.measure_id, loser));
      }

      await draft(tx, sample);

      for (const [n, { base, holder, loser }] of cases.entries()) {
        const home = homes[n];
        expect(await filed(base)).toMatchObject({ ...BASE, metric_id: home });
        expect(await filed(holder)).toMatchObject({
          metric_id: home,
          period: "previous_year",
        });
        const left = await filed(loser);
        expect(left).toMatchObject(BASE);
        expect(left.metric_id).not.toBe(home);
      }
      expect(await draft(tx, sample)).toEqual(NONE);
    }));

  it("records a measure past the limits as its error, leaves it unfiled and drafts the rest", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      await addMeasure(tx, sample, LINES, {
        name: "Bomb 0",
        expression: "SUM(Sales[Quantity])",
      });
      let bomb = "";
      for (let n = 1; n <= 40; n += 1) {
        const before = `[Bomb ${String(n - 1)}]`;
        bomb = await addMeasure(tx, sample, LINES, {
          name: `Bomb ${String(n)}`,
          expression: `${before} + ${before}`,
        });
      }
      const counts = await draft(tx, sample);
      expect(counts.failed).toBe(0);
      const measure = one(
        await tx
          .select()
          .from(powerbiMeasure)
          .where(eq(powerbiMeasure.id, bomb)),
      );
      expect(measure.fingerprint).toBeNull();
      expect(measure.fingerprint_error).toContain("characters");
      expect(await variantOf(tx, bomb)).toBeUndefined();
      const of = await filings(tx, sample);
      expect(of(NET_SALES).metric.name).toBe("net_sales");
    }));

  it("goes on to the next dataset when one fails, keeps none of its counts, and counts it", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      let attempts = 0;
      const flaky = new Proxy(tx, {
        get(target, property, receiver) {
          if (property !== "transaction")
            return Reflect.get(target, property, receiver) as unknown;
          attempts += 1;
          if (attempts === 1) throw new Error("The first dataset fails");
          return target.transaction.bind(target);
        },
      });
      const deps = createTestDeps({ container: "worker", db: flaky });
      const errors = vi.spyOn(deps.logger, "error");
      const ids = sample.tenant.datasets.map((dataset) => dataset.id);
      const counts = await draftDatasets(deps, ids);
      expect(counts.failed).toBe(1);
      expect(counts.failed_datasets).toEqual([ids[0]]);
      expect(errors).toHaveBeenCalledWith(
        "A dataset could not be drafted.",
        expect.objectContaining({ dataset_id: ids[0] }),
      );
      const filedThere = await tx
        .select({ id: metricVariant.id })
        .from(metricVariant)
        .innerJoin(
          powerbiMeasure,
          eq(powerbiMeasure.id, metricVariant.measure_id),
        )
        .where(eq(powerbiMeasure.dataset_id, ids[0] ?? ""));
      expect(filedThere).toEqual([]);
      expect(counts.filed).toBeGreaterThan(0);
      expect(await draft(tx, sample)).toMatchObject({ failed: 0 });
    }));

  it("gives a generated draft the name it wanted once that name is free, and no other draft a new name", () =>
    drafted(async (tx, sample, of) => {
      const twelve = await addMeasure(
        tx,
        sample,
        { dataset: "Marketing", measure: "Conversion rate" },
        { name: "Rolling 12", expression: "12" },
      );
      await draft(tx, sample);
      const rolling = (await variantOf(tx, twelve))?.metric_id ?? "";
      const named = async (
        measure: string,
        set: Partial<typeof metric.$inferInsert>,
      ) => {
        const { id } = of({ dataset: "Marketing", measure }).metric;
        await tx.update(metric).set(set).where(eq(metric.id, id));
        return id;
      };
      const freed = await named("Ad spend", { name: "ad_spend_2" });
      const touched = await named("Cost per click", {
        name: "cost_per_click_2",
        touched_at: new Date(),
      });
      const heldBy = await named("Return on ad spend", {
        name: "return_on_ad_spend_2",
      });
      await tx.insert(metric).values({
        name: "return_on_ad_spend",
        label: "Return on ad spend",
        origin: "curator",
      });

      expect(await draft(tx, sample)).toEqual({ ...NONE, renamed: 1 });

      const nameOf = async (id: string) =>
        one(await tx.select().from(metric).where(eq(metric.id, id))).name;
      expect(await nameOf(freed)).toBe("ad_spend");
      expect(await nameOf(rolling)).toBe("rolling_12");
      expect(await nameOf(touched)).toBe("cost_per_click_2");
      expect(await nameOf(heldBy)).toBe("return_on_ad_spend_2");
      const changes = await tx
        .select()
        .from(bookChange)
        .where(eq(bookChange.element_id, freed));
      expect(changes.at(-1)).toMatchObject({
        action: "rename",
        principal_id: "sync",
      });
      expect(await draft(tx, sample)).toEqual(NONE);
    }));

  it("gives a free name to one of the drafts that want it", () =>
    drafted(async (tx, sample) => {
      const sameName = await tx
        .select()
        .from(metric)
        .where(like(metric.name, "gross_margin%"));
      const plain = sameName.filter((row) =>
        /^gross_margin(_\d+)?$/u.test(row.name),
      );
      expect(plain.length).toBeGreaterThan(1);
      const first = plain.find((row) => row.name === "gross_margin");
      await tx
        .update(metric)
        .set({ name: "gross_margin_9" })
        .where(eq(metric.id, first?.id ?? ""));

      expect(await draft(tx, sample)).toEqual({ ...NONE, renamed: 1 });

      const after = await tx
        .select()
        .from(metric)
        .where(eq(metric.name, "gross_margin"));
      expect(after).toHaveLength(1);
      expect(await draft(tx, sample)).toEqual(NONE);
    }));
});

/** Most binds each statement took while `run` ran, by the statement with its lists folded. */
async function bindsOf(
  run: (tx: Db) => Promise<void>,
  onStatement: (shape: string) => void = () => undefined,
) {
  const binds = new Map<string, number>();
  const logging = drizzle({
    client: testPool(TEST_RUNNER),
    schema,
    logger: {
      logQuery: (query, params) => {
        const shape = query.replaceAll(/\$\d+(, \$\d+)*/g, "$");
        binds.set(shape, Math.max(binds.get(shape) ?? 0, params.length));
        onStatement(shape);
      },
    },
  });
  await logging
    .transaction(async (tx) => {
      await run(tx);
      tx.rollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof TransactionRollbackError)) throw error;
    });
  return binds;
}

describe("draftDatasets as a dataset grows", () => {
  /**
   * First a draft of every measure, then a sync that changes nothing, then a sync
   * that removes half: each list of measures, metrics, fingerprints and names is
   * as long as the dataset somewhere in these. Each name also takes a `_2`, and
   * takes back its name in the last run, so the tidy's list grows too.
   */
  const bindsAt = (size: number) =>
    bindsOf(async (tx) => {
      await setRole(tx, "worker_rw");
      const sample = await loadSampleMirror(tx);
      const { dataset_id, table_id } = one(
        await tx
          .select()
          .from(powerbiMeasure)
          .where(eq(powerbiMeasure.id, sample.measureId(NET_SALES))),
      );
      await tx.execute(sql`
        insert into powerbi_measure (dataset_id, table_id, name, expression)
        select ${dataset_id}::uuid, ${table_id}::uuid, name, expression
        from generate_series(1, ${size}::int) as n,
          lateral (values
            ('Bulk ' || n, 'SUM(Sales[Amount]) + ' || n),
            ('Bulk ' || n || '!', 'SUM(Sales[Amount]) - ' || n)
          ) as spelling(name, expression)`);
      const deps = createTestDeps({ container: "worker", db: tx });
      const counts = [
        await draftDatasets(deps, [dataset_id]),
        await draftDatasets(deps, [dataset_id]),
      ];
      await tx.execute(sql`
        update powerbi_measure set removed_at = now()
        where name like 'Bulk %' and name not like '%!'`);
      counts.push(await draftDatasets(deps, [dataset_id]));
      expect(counts.map(({ failed }) => failed)).toEqual([0, 0, 0]);
      expect(counts[0]?.created).toBeGreaterThanOrEqual(size);
      expect(counts[2]?.renamed).toBeGreaterThan(0);
    });

  it("binds as many parameters for 500 measures as for 50", async () => {
    const few = await bindsAt(50);
    const many = await bindsAt(500);
    const grown = [...many]
      // The feed's insert grows up to ROWS_PER_STATEMENT rows, and is cut there.
      .filter(([shape]) => !shape.startsWith('insert into "event"'))
      .filter(([shape, binds]) => binds > (few.get(shape) ?? 0));
    expect(grown).toEqual([]);
  }, 120_000);

  it("asks for names once for each 16 that share a key, not again for every draft", async () => {
    const SHARING = 100;
    let asked = 0;
    const names: string[] = [];
    await bindsOf(
      async (tx) => {
        await setRole(tx, "worker_rw");
        const sample = await loadSampleMirror(tx);
        const { dataset_id, table_id } = one(
          await tx
            .select()
            .from(powerbiMeasure)
            .where(eq(powerbiMeasure.id, sample.measureId(NET_SALES))),
        );
        // Spellings of one key, each its own calculation: every one wants "echo".
        await tx.execute(sql`
          insert into powerbi_measure (dataset_id, table_id, name, expression)
          select ${dataset_id}::uuid, ${table_id}::uuid,
            'Echo' || repeat('!', n), 'SUM(Sales[Amount]) + ' || n
          from generate_series(1, ${SHARING}::int) as n`);
        const deps = createTestDeps({ container: "worker", db: tx });
        expect((await draftDatasets(deps, [dataset_id])).failed).toBe(0);
        expect(await draftDatasets(deps, [dataset_id])).toEqual(NONE);
        const rows = await tx
          .select({ name: metric.name })
          .from(metric)
          .where(like(metric.name, "echo%"));
        names.push(...rows.map((row) => row.name));
      },
      (shape) => {
        if (shape.includes('"metric"."name" = any')) asked += 1;
      },
    );
    expect(new Set(names).size).toBe(SHARING);
    expect(names).toContain("echo_100");
    // A probe a draft, and a few more to tidy. Without the memory each draft
    // probes again from the first suffix: about 360 for 100.
    expect(asked).toBeLessThan(150);
  }, 120_000);
});

describe("a time-shifted measure no pattern proves", () => {
  const QOQ = {
    name: "Invented swing",
    expression:
      "DIVIDE(SUM(Sales[Amount]), CALCULATE(SUM(Sales[Amount]), DATEADD(Calendar[Date], -1, quarter)), 0) - 7",
  };
  const NAMED = {
    name: "Net sales YTD estimate",
    expression: "SUM(Sales[Amount]) * 2",
  };

  const periodOf = async (tx: Db, measureId: string) =>
    one(
      await tx
        .select()
        .from(metricVariant)
        .where(eq(metricVariant.measure_id, measureId)),
    );

  it("files other when the DAX calls a time function", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const id = await addMeasure(tx, sample, NET_SALES, QOQ);
      await draft(tx, sample);
      expect(await periodOf(tx, id)).toMatchObject({
        period: "other",
        comparison: "none",
        comparison_period: null,
      });
    }));

  it("files other when the function is reached through another measure", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      await addMeasure(tx, sample, NET_SALES, QOQ);
      const id = await addMeasure(tx, sample, NET_SALES, {
        name: "Twice the growth",
        expression: "[Invented swing] * 2",
      });
      await draft(tx, sample);
      expect((await periodOf(tx, id)).period).toBe("other");
    }));

  it("files other when the name holds a word of the conventions, and reads no word from code", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const id = await addMeasure(tx, sample, NET_SALES, NAMED);
      await draft(tx, sample);
      expect((await periodOf(tx, id)).period).toBe("other");

      const words = {
        previous_year: [],
        previous_quarter: [],
        previous_month: [],
        previous_week: [],
        previous_day: [],
      };
      await setDrafting(tx, {
        period_words: words,
        name_hints: { period: ["estimate"], currency: [] },
      });
      const hinted = await addMeasure(tx, sample, NET_SALES, {
        name: "Stock estimate",
        expression: "SUM(Sales[Amount]) * 3",
      });
      const unhinted = await addMeasure(tx, sample, NET_SALES, {
        name: "Stock LY",
        expression: "SUM(Sales[Amount]) * 4",
      });
      await draft(tx, sample);
      expect((await periodOf(tx, hinted)).period).toBe("other");
      expect((await periodOf(tx, unhinted)).period).toBe("current");
    }));

  it("leaves a measure with neither sign, a date inside the selection included, current", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const plain = await addMeasure(tx, sample, NET_SALES, {
        name: "Sales doubled",
        expression: "SUM(Sales[Amount]) * 5",
      });
      const closing = await addMeasure(tx, sample, NET_SALES, {
        name: "Closing sales",
        expression: "CALCULATE(SUM(Sales[Amount]), LASTDATE(Calendar[Date]))",
      });
      await draft(tx, sample);
      expect((await periodOf(tx, plain)).period).toBe("current");
      expect((await periodOf(tx, closing)).period).toBe("current");
    }));

  it("files nothing as other with time intelligence off, or a period axis without it", async () => {
    await inSampleMirror("worker_rw", async (tx, sample) => {
      const id = await addMeasure(tx, sample, NET_SALES, QOQ);
      await setDrafting(tx, { recognise_time_intelligence: false });
      await draft(tx, sample);
      expect((await periodOf(tx, id)).period).toBe("current");
    });
    await inSampleMirror("worker_rw", async (tx, sample) => {
      const id = await addMeasure(tx, sample, NET_SALES, QOQ);
      await setRole(tx, "api_rw");
      await setConventions({ db: tx }, principals.admin, {
        preset: "metrics_book",
        variants: {
          axes: {
            period: { values: ["current", "previous_year"] },
            comparison: { values: ["none"] },
            currency: { values: "iso_4217_or_local" },
            custom: [],
          },
        },
      });
      await setRole(tx, "worker_rw");
      await draft(tx, sample);
      expect((await periodOf(tx, id)).period).toBe("current");
    });
  });

  it("is stable: the next sync changes nothing", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      await addMeasure(tx, sample, NET_SALES, QOQ);
      await draft(tx, sample);
      expect(await draft(tx, sample)).toEqual(NONE);
    }));

  it("changes no variant of a metric a person touched (rule 9)", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      // Filed as a base by the older reading, then touched.
      await setDrafting(tx, { recognise_time_intelligence: false });
      const id = await addMeasure(tx, sample, NET_SALES, QOQ);
      await draft(tx, sample);
      const before = await periodOf(tx, id);
      expect(before.period).toBe("current");
      await tx
        .update(metric)
        .set({ touched_at: new Date() })
        .where(eq(metric.id, before.metric_id));
      const curated = one(
        await tx
          .select()
          .from(metricVariant)
          .where(eq(metricVariant.measure_id, sample.measureId(NET_SALES))),
      );
      await setDrafting(tx, { recognise_time_intelligence: true });
      await draft(tx, sample);
      expect(await periodOf(tx, id)).toEqual(before);
      expect(await periodOf(tx, curated.measure_id)).toMatchObject({
        period: curated.period,
        metric_id: curated.metric_id,
      });
    }));

  it("keeps a curator's period on a measure it would read as other", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const id = await addMeasure(tx, sample, NET_SALES, QOQ);
      await draft(tx, sample);
      const filed = await periodOf(tx, id);
      await tx
        .update(metricVariant)
        .set({ period: "previous_quarter", assigned_by: "curator" })
        .where(eq(metricVariant.id, filed.id));
      await draft(tx, sample);
      expect(await periodOf(tx, id)).toMatchObject({
        period: "previous_quarter",
        metric_id: filed.metric_id,
        assigned_by: "curator",
      });
    }));

  it("flips an untouched draft filed current once, keeps its id and key, and leaves a touched metric's period", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      // Filed current by the older reading, then read again with the proof it lacks.
      await setDrafting(tx, { recognise_time_intelligence: false });
      const untouched = await addMeasure(tx, sample, NET_SALES, QOQ);
      const touchedId = await addMeasure(tx, sample, NET_SALES, {
        name: "Invented swing 2",
        expression: QOQ.expression.replace("- 7", "- 8"),
      });
      await draft(tx, sample);
      const before = await periodOf(tx, untouched);
      const held = await periodOf(tx, touchedId);
      expect([before.period, held.period]).toEqual(["current", "current"]);
      await tx
        .update(metric)
        .set({ touched_at: new Date() })
        .where(eq(metric.id, held.metric_id));
      const key = one(
        await tx.select().from(metric).where(eq(metric.id, before.metric_id)),
      ).name;

      await setDrafting(tx, { recognise_time_intelligence: true });
      const counts = await draft(tx, sample);
      expect(counts.regrouped).toBeGreaterThanOrEqual(1);

      const after = await periodOf(tx, untouched);
      expect(after).toMatchObject({
        id: before.id,
        metric_id: before.metric_id,
        period: "other",
      });
      expect(
        one(
          await tx.select().from(metric).where(eq(metric.id, after.metric_id)),
        ).name,
      ).toBe(key);
      expect(await periodOf(tx, touchedId)).toEqual(held);
      expect(await draft(tx, sample)).toEqual(NONE);
    }));

  /** Which measures share a metric, and how many live metrics there are, whatever the periods say. */
  const foldOf = async (tx: Db) => {
    const rows = await tx
      .select({
        metric: metricVariant.metric_id,
        measure: metricVariant.measure_id,
      })
      .from(metricVariant);
    const held = Map.groupBy(rows, (row) => row.metric);
    return [...held.values()]
      .map((group) =>
        group
          .map((row) => row.measure)
          .sort()
          .join(" "),
      )
      .sort();
  };

  it("moves no fold: the sample folds the same with other as without it", async () => {
    const foldWith = async (values: string[]) => {
      let found: string[] = [];
      let periods: string[] = [];
      await inSampleMirror("worker_rw", async (tx, sample) => {
        await setRole(tx, "api_rw");
        await setConventions({ db: tx }, principals.admin, {
          preset: "metrics_book",
          variants: {
            axes: {
              period: { values },
              comparison: {
                values: ["none", "difference", "growth_rate", "ratio"],
              },
              currency: { values: "iso_4217_or_local" },
              custom: [],
            },
          },
        });
        await setRole(tx, "worker_rw");
        await draft(tx, sample);
        // A second sync reads what the first filed: `other` must prove what `current` did.
        await draft(tx, sample);
        const ids = new Map<string, string>();
        for (const dataset of sample.tenant.datasets)
          for (const table of dataset.tables)
            for (const { name } of table.measures)
              ids.set(
                sample.measureId({ dataset: dataset.name, measure: name }),
                `${dataset.name}/${name}`,
              );
        found = (await foldOf(tx)).map((group) =>
          group
            .split(" ")
            .map((id) => ids.get(id) ?? id)
            .sort()
            .join(" "),
        );
        found.sort();
        periods = (await tx.select().from(metricVariant)).map((v) => v.period);
      });
      return { found, periods };
    };
    const without = await foldWith(["current", ...SAMPLE_PERIODS]);
    const withOther = await foldWith(["current", ...SAMPLE_PERIODS, "other"]);
    expect(withOther.found).toEqual(without.found);
    expect(without.periods).not.toContain("other");
    expect(withOther.periods).toContain("other");
  });

  it("moves no fold: a copy in another dataset still joins its draft through other", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const first = await addMeasure(tx, sample, NET_SALES, QOQ);
      const copy = await addMeasure(tx, sample, REVENUE, QOQ);
      await draft(tx, sample);
      const filed = await periodOf(tx, first);
      expect(filed.period).toBe("other");
      expect((await periodOf(tx, copy)).metric_id).toBe(filed.metric_id);

      // The same when the copy arrives after the draft holds its `other`.
      const later = await addMeasure(tx, sample, REVENUE, {
        ...QOQ,
        name: "Invented swing ",
      });
      await draft(tx, sample);
      expect((await periodOf(tx, later)).metric_id).toBe(filed.metric_id);
    }));
});

describe("a shift of a base a curator filed in a currency", () => {
  const ZED = { name: "Zed total EUR", expression: "COUNTROWS(Sales) * 3" };
  const ZED_LY = {
    name: "Zed total EUR LY",
    expression: "CALCULATE([Zed total EUR], DATEADD('Date'[Date], -1, YEAR))",
  };
  const ZED_YOY = {
    name: "Zed total EUR YoY",
    expression:
      "DIVIDE([Zed total EUR] - [Zed total EUR LY], [Zed total EUR LY])",
  };
  const AXES = { currency: "EUR", custom_axes: { channel: "web" } };
  type Held = {
    metric: typeof metric.$inferSelect;
    base: typeof metricVariant.$inferSelect;
  };

  /**
   * The sample drafted with `Zed total EUR` and the measures given, then the
   * base moved by a curator, in EUR on the web channel, into a metric of theirs.
   */
  const curated = (
    shift: Partial<typeof metricVariant.$inferInsert>,
    added: { name: string; expression: string }[],
    work: (
      tx: Db,
      sample: SampleMirror,
      held: Held,
      ids: string[],
    ) => Promise<void>,
  ) =>
    drafted(async (tx, sample) => {
      const base = await addMeasure(tx, sample, NET_SALES, ZED);
      const ids: string[] = [];
      for (const measure of added)
        ids.push(await addMeasure(tx, sample, NET_SALES, measure));
      await draft(tx, sample);
      const held = one(
        await tx
          .insert(metric)
          .values({
            name: "zed_total",
            label: "Zed total",
            origin: "curator",
            trust_state: "draft",
            touched_at: new Date(),
          })
          .returning(),
      );
      const filed = one(
        await tx
          .update(metricVariant)
          .set({
            ...AXES,
            ...shift,
            metric_id: held.id,
            assigned_by: "curator",
          })
          .where(eq(metricVariant.measure_id, base))
          .returning(),
      );
      await work(tx, sample, { metric: held, base: filed }, ids);
    });
  it("files a new shift under the curator's metric, in the base's currency and axes, and leaves the curator's filing as it was", () =>
    curated({}, [], async (tx, sample, held) => {
      const [before] = await tx
        .select()
        .from(metric)
        .where(eq(metric.id, held.metric.id));
      const ly = await addMeasure(tx, sample, NET_SALES, ZED_LY);
      const yoy = await addMeasure(tx, sample, NET_SALES, ZED_YOY);

      expect(await draft(tx, sample)).toEqual({
        ...NONE,
        filed: 2,
        deleted: 1,
      });

      expect(await variantOf(tx, ly)).toMatchObject({
        metric_id: held.metric.id,
        period: "previous_year",
        comparison: "none",
        ...AXES,
        assigned_by: "sync",
      });
      expect(await variantOf(tx, yoy)).toMatchObject({
        metric_id: held.metric.id,
        period: "current",
        comparison: "growth_rate",
        comparison_period: "previous_year",
        ...AXES,
        assigned_by: "sync",
      });
      expect(await variantOf(tx, held.base.measure_id)).toEqual(held.base);
      expect(
        await tx.select().from(metric).where(eq(metric.id, held.metric.id)),
      ).toEqual([before]);
      const filed = await variantOf(tx, ly);
      const [change] = await tx
        .select()
        .from(bookChange)
        .where(eq(bookChange.element_id, String(filed?.id)));
      expect(change).toMatchObject({
        principal_kind: "system",
        principal_id: "sync",
        action: "file",
        before: null,
      });
      expect(await draft(tx, sample)).toEqual(NONE);
    }));

  it("gives a new shift the custom axes of a base a curator filed with no currency", () =>
    curated({ currency: null }, [], async (tx, sample, held) => {
      const ly = await addMeasure(tx, sample, NET_SALES, ZED_LY);

      await draft(tx, sample);

      expect(await variantOf(tx, ly)).toMatchObject({
        metric_id: held.metric.id,
        period: "previous_year",
        currency: null,
        custom_axes: AXES.custom_axes,
        assigned_by: "sync",
      });
      expect(await variantOf(tx, held.base.measure_id)).toEqual(held.base);
      expect(await draft(tx, sample)).toEqual(NONE);
    }));

  it("takes the shifts the base left behind in the draft it was moved out of", () =>
    curated({}, [ZED_LY, ZED_YOY], async (tx, sample, held, [ly, yoy]) => {
      const left = (await variantOf(tx, String(ly)))?.metric_id;
      expect(left).toBeDefined();
      expect(left).not.toBe(held.metric.id);
      expect((await variantOf(tx, String(yoy)))?.metric_id).toBe(left);

      await draft(tx, sample);

      expect(await variantOf(tx, String(ly))).toMatchObject({
        metric_id: held.metric.id,
        period: "previous_year",
        ...AXES,
        assigned_by: "sync",
      });
      expect(await variantOf(tx, String(yoy))).toMatchObject({
        metric_id: held.metric.id,
        comparison: "growth_rate",
        comparison_period: "previous_year",
        ...AXES,
        assigned_by: "sync",
      });
      expect(
        await tx
          .select()
          .from(metric)
          .where(eq(metric.id, String(left))),
      ).toEqual([]);
      expect(await variantOf(tx, held.base.measure_id)).toEqual(held.base);
      expect(await draft(tx, sample)).toEqual(NONE);
    }));

  it("leaves a new shift a draft of its own while another calculation holds that shift in that currency, on every run", () =>
    curated({}, [], async (tx, sample, held) => {
      const other = await addMeasure(tx, sample, NET_SALES, {
        name: "Zed other EUR LY",
        expression: "COUNTROWS(Sales) * 5",
      });
      await draft(tx, sample);
      const holder = one(
        await tx
          .update(metricVariant)
          .set({
            ...AXES,
            metric_id: held.metric.id,
            period: "previous_year",
            assigned_by: "curator",
          })
          .where(eq(metricVariant.measure_id, other))
          .returning(),
      );
      const ly = await addMeasure(tx, sample, NET_SALES, ZED_LY);

      await draft(tx, sample);

      expect(await variantOf(tx, other)).toEqual(holder);
      const own = await variantOf(tx, ly);
      expect(own?.metric_id).not.toBe(held.metric.id);
      expect(own).toMatchObject({ ...BASE, currency: null, custom_axes: {} });
      expect(await draft(tx, sample)).toEqual(NONE);
    }));

  it("files a shift beside the same shift in another currency", () =>
    curated({}, [], async (tx, sample, held) => {
      const other = await addMeasure(tx, sample, NET_SALES, {
        name: "Zed total LY",
        expression: "COUNTROWS(Sales) * 5",
      });
      await draft(tx, sample);
      await tx
        .update(metricVariant)
        .set({
          metric_id: held.metric.id,
          period: "previous_year",
          assigned_by: "curator",
        })
        .where(eq(metricVariant.measure_id, other));
      const ly = await addMeasure(tx, sample, NET_SALES, ZED_LY);

      await draft(tx, sample);

      expect(await variantOf(tx, ly)).toMatchObject({
        metric_id: held.metric.id,
        period: "previous_year",
        ...AXES,
      });
      expect(await draft(tx, sample)).toEqual(NONE);
    }));

  it("leaves a new shift a draft of its own when the curator filed its base as a shift", () =>
    curated({ period: "year_to_date" }, [], async (tx, sample, held) => {
      const ly = await addMeasure(tx, sample, NET_SALES, ZED_LY);

      await draft(tx, sample);

      const own = await variantOf(tx, ly);
      expect(own?.metric_id).not.toBe(held.metric.id);
      expect(own).toMatchObject({ currency: null, custom_axes: {} });
      expect(await variantOf(tx, held.base.measure_id)).toEqual(held.base);
      expect(await draft(tx, sample)).toEqual(NONE);
    }));
});

describe("inSampleMirror", () => {
  it("never commits the sample: another session sees none of it meanwhile", () =>
    inSampleMirror("api_rw", async (tx, { tenant }) => {
      const ids = {
        workspaces: tenant.workspaces.map((w) => w.id),
        apps: tenant.apps.map((a) => a.id),
        datasets: tenant.datasets.map((d) => d.id),
      };
      const seen = (db: Db) =>
        Promise.all([
          db.$count(
            powerbiWorkspace,
            inArray(powerbiWorkspace.id, ids.workspaces),
          ),
          db.$count(powerbiApp, inArray(powerbiApp.id, ids.apps)),
          db.$count(powerbiDataset, inArray(powerbiDataset.id, ids.datasets)),
          db.$count(
            powerbiMeasure,
            inArray(powerbiMeasure.dataset_id, ids.datasets),
          ),
        ]);
      expect(Math.min(...(await seen(tx)))).toBeGreaterThan(0);
      expect(await seen(createDb(testPool("worker_rw")))).toEqual([0, 0, 0, 0]);
    }));
});
