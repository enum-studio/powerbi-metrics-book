import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { docsChecks } from "./docs.js";
import { setConventions } from "../conventions/store.js";
import { principals } from "../../../test/deps.js";
import { createTestDeps } from "../../../test/deps.js";
import { inSampleMirror, setRole } from "../../../test/sample-mirror.js";
import {
  asPerson,
  fileUnder,
  id,
  metricIn,
  outsider,
  reaching,
  rolledBack,
  useMirror,
} from "../../../test/mirror-fixtures.js";
import type { Db } from "../../context.js";
import {
  metric,
  metricVariant,
  term,
  termColumn,
} from "../../db/schema/book.js";
import { event } from "../../db/schema/events.js";
import {
  powerbiColumn,
  powerbiDataset,
  powerbiMeasure,
} from "../../db/schema/mirror.js";
import { piiRule } from "../../db/schema/pii.js";
import { NO_SUCH_DATASET, ServiceError } from "../../errors.js";
import type { Principal } from "../../principal.js";
import { nextDrafts } from "./drafts.js";
import { draftDatasets } from "./drafter.js";
import { readVisibleEvents } from "../events/feed.js";
import {
  deleteMetric,
  getMetric,
  listMetrics,
  mergeMetrics,
  metricChecks,
  summarizeBook,
  updateMetric,
  verifyMetric,
} from "./metrics.js";
import {
  createTerm,
  getTerm,
  linkColumn,
  listTerms,
  unlinkColumn,
  updateTerm,
} from "./terms.js";
import { getVariant, listVariants, moveVariant } from "./variants.js";

/*
 * Sales[Net sales] is a PII measure and Sales[Channel] a PII column. The
 * metric holds that measure as its base variant and Net sales LY as a shifted
 * one that reads the selection of both columns.
 */

useMirror();

const viewer = reaching({ powerbi_app_ids: [id.sales_app] });
const curator = reaching({ powerbi_app_ids: [id.sales_app] }, "curator");
const withRole = (principal: Principal): Principal => ({
  ...principal,
  roles: [...principal.roles, "pii_reader"],
});
const by = { set_by_kind: "person", set_by_id: "x", set_via: "api" };

async function filed(tx: Db) {
  await tx.insert(piiRule).values([
    {
      kind: "measure",
      table_name: "Sales",
      name: "Net sales",
      pii: true,
      ...by,
    },
    { kind: "column", table_name: "SALES", name: "channel", pii: true, ...by },
  ]);
  const metricId = await metricIn(tx, "pii_hidden_test");
  const [base, shifted] = await tx
    .insert(metricVariant)
    .values([
      { metric_id: metricId, measure_id: id.net_sales, assigned_by: "curator" },
      {
        metric_id: metricId,
        measure_id: id.net_sales_ly,
        assigned_by: "curator",
        period: "previous_year",
        reads_selection: true,
        selection_columns: [
          "Sales[Channel]",
          "'Sales'[Order date]",
          "[CHANNEL]",
        ],
      },
    ])
    .returning({ id: metricVariant.id });
  return { metricId, base: base?.id ?? "", shifted: shifted?.id ?? "" };
}

describe("concept terms on backing columns", () => {
  const conflict = (column: string, term: string = "Contact dimension") => ({
    kind: "conflict",
    message: `"${column}" is the name of a column that already backs the term "${term}", and a concept term has no column behind it. Define the word on "${term}": add it as an alias or extend its definition.`,
    detail: {},
  });
  it.each(["pii", "reader", "off", "unreachable", "removed", "admin"])(
    "checks only visible backing columns: %s",
    (visibility) =>
      inSampleMirror("api_rw", async (tx) => {
        const reader = asPerson(withRole(curator), { db: tx });
        await createTerm(reader, { name: "Contact dimension" });
        await linkColumn(reader, "Contact dimension", id.channel);
        if (visibility === "pii" || visibility === "reader") await filed(tx);
        if (["off", "removed", "admin"].includes(visibility)) {
          await setRole(tx, "worker_rw");
          await tx
            .update(powerbiDataset)
            .set(
              visibility === "off"
                ? { enabled: false }
                : { removed_at: new Date() },
            )
            .where(eq(powerbiDataset.id, id.sales));
          await setRole(tx, "api_rw");
        }
        let principal = curator;
        if (visibility === "reader") principal = withRole(curator);
        if (visibility === "unreachable") principal = reaching({}, "curator");
        if (visibility === "admin")
          principal = reaching(curator.attributes, "admin");
        const attempt = createTerm(asPerson(principal, { db: tx }), {
          name: "Channel",
        });
        if (visibility === "reader") {
          await expect(attempt).rejects.toMatchObject(conflict("Channel"));
        } else {
          await expect(attempt).resolves.toMatchObject({
            name: "Channel",
            type: "concept",
            columns: [],
          });
        }
      }),
  );

  it("refuses through a visible match even when a hidden match exists", () =>
    inSampleMirror("api_rw", async (tx) => {
      const reader = asPerson(withRole(curator), { db: tx });
      const hidden = await createTerm(reader, { name: "Hidden dimension" });
      await linkColumn(reader, "Hidden dimension", id.channel);
      await tx
        .insert(termColumn)
        .values({ term_id: hidden.id, column_id: id.margin });
      await filed(tx);
      await setRole(tx, "worker_rw");
      await tx
        .update(powerbiColumn)
        .set({ name: "Channel", table_id: id.date_table })
        .where(eq(powerbiColumn.id, id.order_date));
      await setRole(tx, "api_rw");
      await createTerm(reader, { name: "Visible dimension" });
      await linkColumn(reader, "Visible dimension", id.order_date);
      await expect(
        createTerm(asPerson(curator, { db: tx }), { name: "Channel" }),
      ).rejects.toMatchObject(conflict("Channel", "Visible dimension"));
      await expect(
        createTerm(asPerson(curator, { db: tx }), { name: "Margin" }),
      ).resolves.toMatchObject({ name: "Margin", type: "concept" });
    }));

  it.each([linkColumn, unlinkColumn])(
    "hides switched-off columns on change %#",
    (change) =>
      inSampleMirror("api_rw", async (tx) => {
        const context = asPerson(curator, { db: tx });
        await createTerm(context, { name: "Off dataset term" });
        await linkColumn(context, "Off dataset term", id.channel);
        await setRole(tx, "worker_rw");
        await tx
          .update(powerbiDataset)
          .set({ enabled: false })
          .where(eq(powerbiDataset.id, id.sales));
        await setRole(tx, "api_rw");
        for (const principal of [
          curator,
          reaching(curator.attributes, "admin"),
        ]) {
          const caller = asPerson(principal, { db: tx });
          for (const column of [randomUUID(), id.channel]) {
            await expect(
              change(caller, "Off dataset term", column),
            ).rejects.toMatchObject({
              kind: "not_found",
              message: "No such column.",
            });
          }
        }
      }),
  );

  it.each(["rename", "unlink"])(
    "checks the visible term type on %s",
    (action) =>
      rolledBack(async (tx) => {
        const reader = asPerson(withRole(curator), { db: tx });
        await createTerm(reader, { name: "Contact dimension" });
        await linkColumn(reader, "Contact dimension", id.order_date);
        await createTerm(reader, { name: "Origin" });
        await linkColumn(reader, "Origin", id.channel);
        if (action === "unlink") {
          await linkColumn(reader, "Origin", id.order_date);
          await updateTerm(reader, "Origin", { name: "Order date" });
        }
        await filed(tx);
        const context = asPerson(curator, { db: tx });
        const attempt =
          action === "rename"
            ? updateTerm(context, "Origin", { name: "Order date" })
            : unlinkColumn(context, "Order date", id.order_date);
        await expect(attempt).rejects.toMatchObject(conflict("Order date"));
      }),
  );
});

describe("a viewer without pii_reader", () => {
  it("derives term type only from columns the caller may see", () =>
    rolledBack(async (tx) => {
      await filed(tx);
      const [piiOnly] = await tx
        .insert(term)
        .values({ name: "hidden_pii_term" })
        .returning({ id: term.id });
      const [unreachableOnly] = await tx
        .insert(term)
        .values({ name: "hidden_dataset_term" })
        .returning({ id: term.id });
      if (piiOnly === undefined || unreachableOnly === undefined)
        throw new Error("The terms were not created");
      await tx.insert(termColumn).values([
        { term_id: piiOnly.id, column_id: id.channel },
        { term_id: unreachableOnly.id, column_id: id.margin },
      ]);

      const salesViewer = asPerson(viewer, { db: tx });
      const piiReader = asPerson(withRole(viewer), { db: tx });
      const outsiderReader = asPerson(outsider, { db: tx });
      const financeReader = asPerson(
        reaching({ powerbi_app_ids: [id.leadership_app] }),
        { db: tx },
      );
      const piiTerm = await listTerms(salesViewer, {
        name_prefix: "hidden_pii",
      });
      expect(piiTerm.items[0]).toMatchObject({
        type: "concept",
        column_count: 0,
      });
      expect((await getTerm(salesViewer, piiOnly.id)).type).toBe("concept");
      expect((await getTerm(salesViewer, piiOnly.id)).columns).toEqual([]);
      expect((await getTerm(piiReader, piiOnly.id)).type).toBe("dimension");
      expect((await getTerm(piiReader, piiOnly.id)).columns).toHaveLength(1);

      const hiddenDatasetTerm = await listTerms(outsiderReader, {
        name_prefix: "hidden_dataset",
      });
      expect(hiddenDatasetTerm.items[0]).toMatchObject({
        type: "concept",
        column_count: 0,
      });
      expect((await getTerm(outsiderReader, unreachableOnly.id)).type).toBe(
        "concept",
      );
      expect(
        (await getTerm(outsiderReader, unreachableOnly.id)).columns,
      ).toEqual([]);
      expect((await getTerm(financeReader, unreachableOnly.id)).type).toBe(
        "dimension",
      );
      expect(
        (await getTerm(financeReader, unreachableOnly.id)).columns,
      ).toHaveLength(1);
    }));

  it("gets no variant of a PII measure from get_variant and list_variants", () =>
    rolledBack(async (tx) => {
      const { metricId, base, shifted } = await filed(tx);
      const context = asPerson(viewer, { db: tx });
      await expect(getVariant(context, base)).rejects.toMatchObject({
        kind: "not_found",
      });
      await expect(
        getVariant(context, { dataset: id.sales, measure: "Net sales" }),
      ).rejects.toMatchObject({ kind: "not_found" });
      const { items } = await listVariants(context, metricId);
      expect(items.map((item) => item.measure.name)).toEqual(["Net sales LY"]);
      expect(items[0]?.selection_columns).toEqual(["'Sales'[Order date]"]);
      expect((await getVariant(context, shifted)).selection_columns).toEqual([
        "'Sales'[Order date]",
      ]);
    }));

  it("sees the PII variant and every selection column with pii_reader", () =>
    rolledBack(async (tx) => {
      const { metricId, base, shifted } = await filed(tx);
      const context = asPerson(withRole(viewer), { db: tx });
      expect((await getVariant(context, base)).measure.name).toBe("Net sales");
      const { items } = await listVariants(context, metricId);
      expect(items.map((item) => item.measure.name)).toEqual([
        "Net sales",
        "Net sales LY",
      ]);
      expect((await getVariant(context, shifted)).selection_columns).toEqual([
        "Sales[Channel]",
        "'Sales'[Order date]",
        "[CHANNEL]",
      ]);
    }));

  it("gets get_metric without the PII base variant, the shifted count and the PII selection columns", () =>
    rolledBack(async (tx) => {
      const { metricId } = await filed(tx);
      const seen = await getMetric(asPerson(viewer, { db: tx }), metricId);
      expect(seen.base_variants).toEqual([]);
      expect(seen.other_variants).toHaveLength(1);
      const reader = await getMetric(
        asPerson(withRole(viewer), { db: tx }),
        metricId,
      );
      expect(reader.base_variants.map((v) => v.measure.name)).toEqual([
        "Net sales",
      ]);
      expect(reader.other_variants).toHaveLength(1);
    }));

  it("does not match a dataset filter in list_metrics through a PII measure alone", () =>
    rolledBack(async (tx) => {
      const { metricId } = await filed(tx);
      await tx
        .delete(metricVariant)
        .where(eq(metricVariant.metric_id, metricId));
      await tx.insert(metricVariant).values({
        metric_id: metricId,
        measure_id: id.net_sales,
        assigned_by: "curator",
      });
      const names = async (principal: Principal) =>
        (
          await listMetrics(asPerson(principal, { db: tx }), {
            dataset: id.sales,
            name_prefix: "pii_hidden",
          })
        ).items.map((item) => item.name);
      expect(await names(viewer)).toEqual([]);
      expect(await names(withRole(viewer))).toEqual(["pii_hidden_test"]);
    }));

  it("gets no draft of a PII measure", () =>
    rolledBack(async (tx) => {
      const { metricId } = await filed(tx);
      const names = async (principal: Principal) =>
        (
          await nextDrafts(asPerson(principal, { db: tx }), {
            dataset: id.sales,
            limit: 50,
          })
        ).flatMap((draft) =>
          draft.id === metricId
            ? draft.variants.map((v) => v.measure.name)
            : [],
        );
      expect(await names(curator)).toEqual(["Net sales LY"]);
      expect(await names(withRole(curator))).toEqual([
        "Net sales",
        "Net sales LY",
      ]);
    }));

  it("counts PII variants as hidden when refusing to delete a metric", () =>
    rolledBack(async (tx) => {
      const { metricId } = await filed(tx);
      await expect(
        deleteMetric(asPerson(curator, { db: tx }), metricId),
      ).rejects.toThrow(/1 variant, and some you cannot see/);
    }));
});

describe("a metric whose every variant is PII", () => {
  it("counts in the book's summary only for a reader of PII", () =>
    rolledBack(async (tx) => {
      const count = async (principal: Principal) =>
        (await summarizeBook(asPerson(principal, { db: tx }))).metrics.draft;
      const [without, reader] = [
        await count(curator),
        await count(withRole(curator)),
      ];
      expect(reader).toBe(without);
      const { shifted } = await filed(tx);
      await tx.delete(metricVariant).where(eq(metricVariant.id, shifted));
      expect(await count(curator)).toBe(without);
      expect(await count(withRole(curator))).toBe(reader + 1);
    }));

  it.each(["merge", "move"] as const)(
    "records the PII measure when a curator performs a %s",
    (action) =>
      rolledBack(async (tx) => {
        const { metricId, base, shifted } = await filed(tx);
        await tx.delete(metricVariant).where(eq(metricVariant.id, shifted));
        const target = await metricIn(tx, "pii_event_target");
        const context = asPerson(withRole(curator), { db: tx });
        if (action === "merge") {
          await mergeMetrics(context, { from: metricId, into: target });
        } else {
          await updateMetric(context, metricId, {
            definition: "Private metric.",
          });
          await moveVariant(context, base, { to_metric: target });
        }
        const written = (await readVisibleEvents(context, {})).filter(
          (row) => row.element_id === metricId && row.data.action === action,
        );
        expect(written).toHaveLength(1);
        expect(written[0]?.data.measure_ids).toEqual([id.net_sales]);
        expect(
          (await readVisibleEvents(asPerson(viewer, { db: tx }), {})).filter(
            (row) => row.element_id === metricId,
          ),
        ).toEqual([]);
      }),
  );

  it("records the measure named by a PII draft and hides its event", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const measureId = randomUUID();
      const beside = sample.measureId({
        dataset: "Sales",
        measure: "Net sales",
      });
      const [measure] = await tx
        .select()
        .from(powerbiMeasure)
        .where(eq(powerbiMeasure.id, beside));
      if (measure === undefined)
        throw new Error("The sample measure is missing");
      await tx.insert(powerbiMeasure).values({
        id: measureId,
        dataset_id: measure.dataset_id,
        table_id: measure.table_id,
        name: "Private event total",
        expression: "314159",
      });
      await setRole(tx, "api_rw");
      await tx.insert(piiRule).values({
        kind: "measure",
        table_name: "Sales lines",
        name: "Private event total",
        pii: true,
        ...by,
      });
      await setRole(tx, "worker_rw");
      await draftDatasets(createTestDeps({ container: "worker", db: tx }), [
        measure.dataset_id,
      ]);
      await setRole(tx, "api_rw");
      const principal = reaching({ powerbi_dataset_ids: [measure.dataset_id] });
      const reader = asPerson(withRole(principal), { db: tx });
      const created = (
        await readVisibleEvents(reader, { kinds: ["draft.created"] })
      ).filter((row) => row.data.name === "private_event_total");
      expect(created).toHaveLength(1);
      expect(created[0]?.data.measure_ids).toEqual([measureId]);
      expect(
        (await readVisibleEvents(asPerson(principal, { db: tx }), {})).filter(
          (row) => row.element_id === created[0]?.element_id,
        ),
      ).toEqual([]);
    }));

  describe("the feed's lists and names for a reader with partial reach", () => {
    const wide = reaching(
      { powerbi_app_ids: [id.sales_app, id.leadership_app] },
      "curator",
    );
    const seenBy = async (tx: Db, principal: Principal, metricId: string) =>
      (await readVisibleEvents(asPerson(principal, { db: tx }), {}))
        .filter((row) => row.element_id === metricId)
        .map((row) => row.data);
    // The writer emits the event: its lists and name are what the code records, not a hand-written row.
    const written = async (tx: Db) => {
      await tx.insert(piiRule).values({
        kind: "measure",
        table_name: "Sales",
        name: "Net sales",
        pii: true,
        ...by,
      });
      const metricId = await metricIn(tx, "pii_feed_lists_test");
      await tx.insert(metricVariant).values(
        [id.net_sales, id.days, id.profit].map((measure_id) => ({
          metric_id: metricId,
          measure_id,
          assigned_by: "curator" as const,
        })),
      );
      await updateMetric(asPerson(withRole(wide), { db: tx }), metricId, {
        definition: "Written by a reader of PII.",
      });
      return metricId;
    };
    const sorted = (value: unknown) => [...(value as string[])].sort();

    it("gives a reader of PII the datasets it can describe and a viewer those of the measures it is shown", () =>
      rolledBack(async (tx) => {
        const metricId = await written(tx);
        const [all] = await seenBy(tx, withRole(wide), metricId);
        expect(sorted(all?.dataset_ids)).toEqual([id.finance, id.sales].sort());
        const [partial] = await seenBy(tx, withRole(viewer), metricId);
        expect(partial?.dataset_ids).toEqual([id.sales]);
        expect(sorted(partial?.measure_ids)).toEqual(
          [id.net_sales, id.days].sort(),
        );
        expect(partial?.name).toBe("pii_feed_lists_test");
        const [plain] = await seenBy(tx, viewer, metricId);
        expect(plain?.dataset_ids).toEqual([id.sales]);
        expect(plain?.measure_ids).toEqual([id.days]);
      }));

    it("keeps a name recorded before a measure became PII, for a viewer and a reader of PII alike", () =>
      rolledBack(async (tx) => {
        const metricId = await metricIn(tx, "pii_frozen_name_test");
        await tx.insert(metricVariant).values(
          [id.net_sales, id.days].map((measure_id) => ({
            metric_id: metricId,
            measure_id,
            assigned_by: "curator" as const,
          })),
        );
        await tx.insert(event).values({
          kind: "draft.created",
          element_kind: "metric",
          element_id: metricId,
          data: {
            name: "frozen_name",
            previous_name: "older_name",
            dataset_ids: [id.sales],
            measure_ids: [id.net_sales, id.days],
          },
        });
        const [before] = await seenBy(tx, viewer, metricId);
        expect(before?.name).toBe("frozen_name");
        await tx.insert(piiRule).values({
          kind: "measure",
          table_name: "Sales",
          name: "Net sales",
          pii: true,
          ...by,
        });
        const [after] = await seenBy(tx, viewer, metricId);
        expect(after).toEqual({
          name: "frozen_name",
          previous_name: "older_name",
          dataset_ids: [id.sales],
          measure_ids: [id.days],
        });
        const [reader] = await seenBy(tx, withRole(viewer), metricId);
        expect(reader?.name).toBe("frozen_name");
        expect(reader?.previous_name).toBe("older_name");
      }));

    it("names a moved variant only to a caller shown its measure", () =>
      rolledBack(async (tx) => {
        await tx.insert(piiRule).values({
          kind: "measure",
          table_name: "Sales",
          name: "Net sales",
          pii: true,
          ...by,
        });
        const metricId = await metricIn(tx, "pii_moved_variant_test");
        const target = await metricIn(tx, "pii_moved_variant_target");
        const [hidden] = await tx
          .insert(metricVariant)
          .values(
            [id.net_sales, id.days].map((measure_id) => ({
              metric_id: metricId,
              measure_id,
              assigned_by: "curator" as const,
            })),
          )
          .returning({
            id: metricVariant.id,
            measure_id: metricVariant.measure_id,
          });
        const writer = asPerson(withRole(wide), { db: tx });
        await updateMetric(writer, metricId, { definition: "Touched." });
        const moving = hidden?.measure_id === id.net_sales ? hidden.id : "";
        await moveVariant(writer, moving, { to_metric: target });
        const moved = async (principal: Principal) =>
          (await seenBy(tx, principal, metricId)).filter(
            (data) => data.action === "move",
          );
        expect(await moved(withRole(viewer))).toMatchObject([
          { variant_id: moving },
        ]);
        expect(await moved(viewer)).toEqual([]);
      }));

    const netSalesIsPii = (tx: Db) =>
      tx.insert(piiRule).values({
        kind: "measure",
        table_name: "Sales",
        name: "Net sales",
        pii: true,
        ...by,
      });
    const eventOn = async (tx: Db, data: Record<string, unknown>) => {
      const element_id = randomUUID();
      const [row] = await tx
        .insert(event)
        .values({
          kind: "metric.changed",
          element_kind: "metric",
          element_id,
          data,
        })
        .returning({ id: event.id });
      return { element_id, id: row?.id ?? 0 };
    };

    it("hides a hidden variant's move on both metrics, before the page is cut, and keeps a shown one's fields", () =>
      rolledBack(async (tx) => {
        await netSalesIsPii(tx);
        const from = await metricIn(tx, "pii_move_from");
        const into = await metricIn(tx, "pii_move_into");
        const variants = await tx
          .insert(metricVariant)
          .values([
            {
              metric_id: from,
              measure_id: id.net_sales,
              assigned_by: "curator" as const,
            },
            {
              metric_id: from,
              measure_id: id.days,
              assigned_by: "curator" as const,
            },
            {
              metric_id: into,
              measure_id: id.net_sales_ly,
              assigned_by: "curator" as const,
              period: "previous_year",
            },
          ])
          .returning({
            id: metricVariant.id,
            measure_id: metricVariant.measure_id,
          });
        const of = (measure: string) =>
          variants.find(({ measure_id }) => measure_id === measure)?.id ?? "";
        const writer = asPerson(withRole(wide), { db: tx });
        await updateMetric(writer, from, { definition: "Touched." });
        const { id: mark } = await eventOn(tx, { dataset_ids: [] });

        await moveVariant(writer, of(id.net_sales), { to_metric: into });
        const moves = async (principal: Principal, after: number) =>
          (await readVisibleEvents(asPerson(principal, { db: tx }), { after }))
            .map((row) => row.data)
            .filter((data) => data.action === "move");
        expect(await moves(viewer, mark)).toEqual([]);
        expect(await moves(withRole(viewer), mark)).toHaveLength(2);

        await updateMetric(writer, into, { definition: "After the move." });
        const [firstShown] = await readVisibleEvents(
          asPerson(viewer, { db: tx }),
          { after: mark, limit: 1 },
        );
        expect(firstShown?.data.action).not.toBe("move");
        expect(firstShown?.element_id).toBe(into);

        const { id: secondMark } = await eventOn(tx, { dataset_ids: [] });
        const second = await metricIn(tx, "pii_move_second");
        await moveVariant(writer, of(id.days), { to_metric: second });
        const shown = await moves(viewer, secondMark);
        expect(shown).toHaveLength(2);
        expect(shown).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              variant_id: of(id.days),
              to_metric_id: second,
            }),
            expect.objectContaining({
              variant_id: of(id.days),
              from_metric_id: from,
            }),
          ]),
        );
      }));

    it("names a dataset by the row's own measures, whatever else is on the page", () =>
      rolledBack(async (tx) => {
        await netSalesIsPii(tx);
        const mixed = await eventOn(tx, {
          name: "mixed_row",
          dataset_ids: [id.finance, id.sales],
          measure_ids: [id.profit, id.net_sales],
        });
        await eventOn(tx, {
          name: "other_row",
          dataset_ids: [id.sales],
          measure_ids: [id.days],
        });
        const reader = asPerson(wide, { db: tx });
        const after = mixed.id - 1;
        const [wholePage] = await readVisibleEvents(reader, { after });
        const [aloneOnPage] = await readVisibleEvents(reader, {
          after,
          limit: 1,
        });
        expect(wholePage?.data.dataset_ids).toEqual([id.finance]);
        expect(aloneOnPage?.data.dataset_ids).toEqual([id.finance]);
      }));

    it("gives no sign in a name of whether a hidden measure is PII or refused, and the metric's own read has that name", () =>
      rolledBack(async (tx) => {
        await netSalesIsPii(tx);
        const words = { name: "same_name", previous_name: "older_name" };
        const pii = await eventOn(tx, {
          ...words,
          dataset_ids: [id.sales],
          measure_ids: [id.days, id.net_sales],
        });
        const refused = await eventOn(tx, {
          ...words,
          dataset_ids: [id.sales, id.finance],
          measure_ids: [id.days, id.profit],
        });
        const expected = {
          ...words,
          dataset_ids: [id.sales],
          measure_ids: [id.days],
        };
        expect(await seenBy(tx, viewer, pii.element_id)).toEqual([expected]);
        expect(await seenBy(tx, viewer, refused.element_id)).toEqual([
          expected,
        ]);
        const live = await metricIn(tx, "pii_live_name");
        await tx.insert(metricVariant).values(
          [id.net_sales, id.days].map((measure_id) => ({
            metric_id: live,
            measure_id,
            assigned_by: "curator" as const,
          })),
        );
        const read = await getMetric(asPerson(viewer, { db: tx }), live);
        expect(read.name).toBe("pii_live_name");
      }));

    it("treats an empty measure list as no list", () =>
      rolledBack(async (tx) => {
        const row = await eventOn(tx, {
          name: "empty_list",
          dataset_ids: [id.sales],
          measure_ids: [],
        });
        expect(await seenBy(tx, withRole(viewer), row.element_id)).toEqual([
          { name: "empty_list", dataset_ids: [id.sales], measure_ids: [] },
        ]);
        expect(await seenBy(tx, viewer, row.element_id)).toEqual([]);
      }));

    it("keeps variant_id for a reader who may see the variant, on an old row and after the variant is gone", () =>
      rolledBack(async (tx) => {
        const metricId = await metricIn(tx, "pii_kept_variant");
        const [live] = await tx
          .insert(metricVariant)
          .values({
            metric_id: metricId,
            measure_id: id.days,
            assigned_by: "curator" as const,
          })
          .returning({ id: metricVariant.id });
        const liveVariant = live?.id ?? "";
        const gone = randomUUID();
        const oldRow = await eventOn(tx, {
          variant_id: liveVariant,
          dataset_ids: [id.sales],
        });
        const oldGone = await eventOn(tx, {
          variant_id: gone,
          dataset_ids: [id.sales],
        });
        const listed = await eventOn(tx, {
          variant_id: gone,
          dataset_ids: [id.sales],
          measure_ids: [id.days],
        });
        const reader = withRole(viewer);
        expect(
          (await seenBy(tx, reader, oldRow.element_id))[0]?.variant_id,
        ).toBe(liveVariant);
        expect(
          (await seenBy(tx, reader, oldGone.element_id))[0]?.variant_id,
        ).toBe(gone);
        for (const principal of [reader, viewer])
          expect(
            (await seenBy(tx, principal, listed.element_id))[0]?.variant_id,
          ).toBe(gone);
      }));

    it("hides a row when it cannot show the variant is one the reader may see", () =>
      rolledBack(async (tx) => {
        await netSalesIsPii(tx);
        const metricId = await metricIn(tx, "pii_refused_variant");
        const [refused] = await tx
          .insert(metricVariant)
          .values({
            metric_id: metricId,
            measure_id: id.profit,
            assigned_by: "curator" as const,
          })
          .returning({ id: metricVariant.id });
        const gone = randomUUID();
        const oldRefused = await eventOn(tx, {
          variant_id: refused?.id,
          dataset_ids: [id.sales, id.finance],
        });
        const goneWithPii = await eventOn(tx, {
          variant_id: gone,
          dataset_ids: [id.sales],
          measure_ids: [id.days, id.net_sales],
        });
        const goneWithRefused = await eventOn(tx, {
          variant_id: gone,
          dataset_ids: [id.sales, id.finance],
          measure_ids: [id.days, id.profit],
        });
        const reader = withRole(viewer);
        expect(await seenBy(tx, reader, oldRefused.element_id)).toEqual([]);
        expect(await seenBy(tx, viewer, goneWithPii.element_id)).toEqual([]);
        expect(await seenBy(tx, reader, goneWithPii.element_id)).toHaveLength(
          1,
        );
        expect(await seenBy(tx, reader, goneWithRefused.element_id)).toEqual(
          [],
        );
        expect(
          await seenBy(tx, withRole(wide), goneWithRefused.element_id),
        ).toHaveLength(1);
      }));

    it("shows a reader of PII a row from before the lists, to the datasets it can describe", () =>
      rolledBack(async (tx) => {
        const metricId = await metricIn(tx, "pii_old_row_test");
        await fileUnder(tx, metricId, id.days);
        await tx.insert(event).values({
          kind: "metric.changed",
          element_kind: "metric",
          element_id: metricId,
          data: { name: "old_row", dataset_ids: [id.sales, id.finance] },
        });
        expect(await seenBy(tx, viewer, metricId)).toEqual([]);
        expect(await seenBy(tx, withRole(viewer), metricId)).toEqual([
          { name: "old_row", dataset_ids: [id.sales] },
        ]);
      }));
  });

  const only = async (tx: Db) => {
    const metricId = await metricIn(tx, "pii_only_test");
    await tx.insert(piiRule).values({
      kind: "measure",
      table_name: "Sales",
      name: "Net sales",
      pii: true,
      ...by,
    });
    await fileUnder(tx, metricId, id.net_sales);
    await tx.insert(event).values({
      kind: "draft.created",
      element_kind: "metric",
      element_id: metricId,
      data: { name: "net_sales", dataset_ids: [id.sales] },
    });
    return metricId;
  };

  it("reads like a metric on datasets the caller cannot reach, in lists, lookups and the feed", () =>
    rolledBack(async (tx) => {
      const metricId = await only(tx);
      const seen = async (principal: Principal) => {
        const context = asPerson(principal, { db: tx });
        const listed = await listMetrics(context, { name_prefix: "pii_only" });
        const feed = await readVisibleEvents(context, {
          kinds: ["draft.created"],
        });
        return [
          listed.items.length,
          feed.filter((row) => row.element_id === metricId).length,
          await getMetric(context, metricId).then(
            () => "found",
            (error: unknown) => {
              if (error instanceof ServiceError) return error.kind;
              throw error;
            },
          ),
        ];
      };
      expect(await seen(viewer)).toEqual([0, 0, "not_found"]);
      expect(await seen(withRole(viewer))).toEqual([1, 1, "found"]);
    }));

  it("answers through its alias exactly as an alias nobody holds", () =>
    rolledBack(async (tx) => {
      const metricId = await only(tx);
      await tx
        .update(metric)
        .set({ aliases: ["private word"] })
        .where(eq(metric.id, metricId));
      const context = asPerson(viewer, { db: tx });
      await expect(getMetric(context, "private word")).rejects.toMatchObject({
        kind: "not_found",
        message: `No metric goes by "private word". search finds a metric by a word, and list_metrics lists the metrics by key.`,
      });
      await expect(getMetric(context, "unheld word")).rejects.toMatchObject({
        kind: "not_found",
        message: `No metric goes by "unheld word". search finds a metric by a word, and list_metrics lists the metrics by key.`,
      });
      const reader = asPerson(withRole(viewer), { db: tx });
      expect((await getMetric(reader, "private word")).id).toBe(metricId);
    }));

  it("leaves a shared alias to the metric the caller may see, and names no other", () =>
    rolledBack(async (tx) => {
      const hidden = await only(tx);
      const seen = await metricIn(tx, "pii_alias_seen_test");
      await fileUnder(tx, seen, id.net_sales_ly);
      await tx
        .update(metric)
        .set({ aliases: ["shared word"] })
        .where(inArray(metric.id, [hidden, seen]));
      const found = await getMetric(
        asPerson(viewer, { db: tx }),
        "shared word",
      );
      expect(found.id).toBe(seen);
      expect(JSON.stringify(found)).not.toContain("pii_only_test");
      await expect(
        getMetric(asPerson(withRole(viewer), { db: tx }), "shared word"),
      ).rejects.toMatchObject({
        kind: "invalid",
        message: expect.stringContaining("pii_only_test") as string,
      });
    }));

  it("names no metric the caller cannot see in a check's answer, whichever way it is read", () =>
    rolledBack(async (tx) => {
      const hidden = await only(tx);
      const shown = await metricIn(tx, "zorblax_shown_test");
      const curating = asPerson(withRole(curator), { db: tx });
      await updateMetric(curating, hidden, { label: "Zorblax hidden" });
      await updateMetric(curating, shown, { label: "Zorblax shown" });
      const answers = async (principal: Principal) => {
        const context = asPerson(principal, { db: tx });
        const refusal: unknown = await verifyMetric(context, shown).catch(
          (error: unknown) => error,
        );
        if (!(refusal instanceof ServiceError))
          throw new Error("A metric with failing checks was verified.");
        return [
          (await getMetric(context, shown)).failing_checks,
          await metricChecks(context, shown),
          refusal.detail,
        ].map((answer) => JSON.stringify(answer));
      };
      for (const answer of await answers(withRole(curator)))
        expect(answer).toContain("Zorblax hidden");
      // Hidden as a PII measure, and hidden as a dataset out of reach.
      for (const principal of [curator, withRole(reaching({}, "curator"))])
        for (const answer of await answers(principal))
          expect(answer).not.toContain("Zorblax hidden");
    }));
});

describe("the list counts", () => {
  it("leave a dataset reached only through a PII measure out of a metric's dataset_count", () =>
    rolledBack(async (tx) => {
      await tx.insert(piiRule).values({
        kind: "measure",
        table_name: "Sales",
        name: "Net sales",
        pii: true,
        ...by,
      });
      const metricId = await metricIn(tx, "pii_count_test");
      await tx.insert(metricVariant).values([
        { metric_id: metricId, measure_id: id.profit, assigned_by: "curator" },
        {
          metric_id: metricId,
          measure_id: id.net_sales,
          assigned_by: "curator",
        },
      ]);
      const both = reaching({
        powerbi_app_ids: [id.sales_app, id.leadership_app],
      });
      const count = async (principal: Principal) =>
        (
          await listMetrics(asPerson(principal, { db: tx }), {
            name_prefix: "pii_count_test",
          })
        ).items[0]?.dataset_count;
      expect(await count(both)).toBe(1);
      expect(await count(withRole(both))).toBe(2);
      // A service account never reads PII, whatever roles it carries.
      const account: Principal = {
        ...withRole(both),
        kind: "service_account",
        id: "pii-count-account",
        via: "api",
      };
      expect(await count(account)).toBe(1);
    }));

  it("leave a PII column out of a term's column_count", () =>
    rolledBack(async (tx) => {
      await filed(tx);
      const reader = asPerson(withRole(curator), { db: tx });
      await createTerm(reader, { name: "PII count term" });
      await linkColumn(reader, "PII count term", id.channel);
      await linkColumn(reader, "PII count term", id.order_date);
      const count = async (principal: Principal) =>
        (await listTerms(asPerson(principal, { db: tx }))).items.find(
          (item) => item.name === "PII count term",
        )?.column_count;
      expect(await count(viewer)).toBe(1);
      expect(await count(withRole(viewer))).toBe(2);
    }));
});

describe("moving and merging around PII variants", () => {
  /** A holds Net sales LY as a base variant; B holds the PII Net sales as its base and Days in month a year back. */
  const fixture = async (tx: Db) => {
    await tx.insert(piiRule).values({
      kind: "measure",
      table_name: "Sales",
      name: "Net sales",
      pii: true,
      ...by,
    });
    const from = await metricIn(tx, "pii_move_from");
    const into = await metricIn(tx, "pii_move_into");
    const [moving] = await tx
      .insert(metricVariant)
      .values({
        metric_id: from,
        measure_id: id.net_sales_ly,
        assigned_by: "curator",
      })
      .returning({ id: metricVariant.id });
    const [secret] = await tx
      .insert(metricVariant)
      .values({
        metric_id: into,
        measure_id: id.net_sales,
        assigned_by: "curator",
      })
      .returning({ id: metricVariant.id });
    await tx.insert(metricVariant).values({
      metric_id: into,
      measure_id: id.days,
      assigned_by: "curator",
      period: "previous_year",
    });
    return { from, into, moving: moving?.id ?? "", secret: secret?.id ?? "" };
  };
  const refusal = async (work: () => Promise<unknown>) =>
    String(await work().catch((error: unknown) => error));

  it("counts a clash with a PII variant as hidden, without naming it", () =>
    rolledBack(async (tx) => {
      const { from, into, moving } = await fixture(tx);
      const told = await refusal(() =>
        moveVariant(asPerson(curator, { db: tx }), moving, {
          to_metric: into,
        }),
      );
      expect(told).toContain("1 clash you cannot see");
      expect(told).not.toMatch(/Net sales|datasets/);
      const reader = await refusal(() =>
        moveVariant(asPerson(withRole(curator), { db: tx }), moving, {
          to_metric: into,
        }),
      );
      expect(reader).toContain("Net sales LY and Net sales in");
      const merged = await refusal(() =>
        mergeMetrics(asPerson(curator, { db: tx }), { from, into }),
      );
      expect(merged).toContain("1 clash you cannot see");
      expect(merged).not.toMatch(/Net sales|datasets/);
    }));

  it("answers not_found, and moves nothing, for the variant of a PII measure", () =>
    rolledBack(async (tx) => {
      const { secret } = await fixture(tx);
      const fresh = await metricIn(tx, "pii_move_fresh_target");
      await expect(
        moveVariant(asPerson(curator, { db: tx }), secret, {
          to_metric: fresh,
        }),
      ).rejects.toMatchObject({ kind: "not_found" });
      const [row] = await tx
        .select({ metric_id: metricVariant.metric_id })
        .from(metricVariant)
        .where(eq(metricVariant.id, secret));
      expect(row?.metric_id).not.toBe(fresh);
    }));
});

it("never lists a PII column's missing documentation or names its unused exception for a non-reader", () =>
  rolledBack(async (tx) => {
    await filed(tx);
    await setConventions({ db: tx }, principals.admin, {
      format: 1,
      exceptions: [
        {
          rule: "column_fields.blank_means",
          dataset: "Sales",
          column: "'Sales'[Channel]",
          reason: "Optional.",
        },
      ],
    });
    const hidden = await docsChecks(asPerson(curator, { db: tx }));
    expect(hidden.items.some((item) => item.id === id.channel)).toBe(false);
    expect(JSON.stringify(hidden.unused_exceptions)).not.toContain("Channel");
    const seen = await docsChecks(asPerson(withRole(curator), { db: tx }));
    expect(
      seen.items.find((item) => item.id === id.channel)?.results,
    ).toContainEqual(
      expect.objectContaining({
        rule: "column_fields.definition",
        passed: false,
      }),
    );
    expect(seen.unused_exceptions).toContainEqual(
      expect.objectContaining({
        target: { dataset: "Sales", column: "'Sales'[Channel]" },
      }),
    );
    await tx.insert(piiRule).values({
      kind: "column",
      table_name: "Sales",
      name: "Order date",
      pii: true,
      ...by,
    });
    // With both columns hidden and a visible measure, Sales is a measures table.
    const withoutColumns = await docsChecks(asPerson(curator, { db: tx }));
    expect(
      withoutColumns.items.some((item) => item.id === id.sales_table),
    ).toBe(false);
    expect(seen.items.some((item) => item.id === id.sales_table)).toBe(true);
    for (const dataset of ["Finance", "Missing"])
      await expect(
        docsChecks(asPerson(curator, { db: tx }), { dataset }),
      ).rejects.toMatchObject({ kind: "not_found", message: NO_SUCH_DATASET });
  }));
