import {
  EXPECTED_NOT_GROUPED,
  EXPECTED_SAME_NAME,
} from "@powerbi-metrics-book/powerbi-mock";
import { eq, ne, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeTestPools, createTestDeps } from "../../../test/deps.js";
import {
  inSampleMirror,
  type SampleMirror,
} from "../../../test/sample-mirror.js";
import type { Db } from "../../context.js";
import { wordsOf } from "../../dax/index.js";
import { metric, metricVariant } from "../../db/schema/book.js";
import { powerbiMeasure, powerbiTable } from "../../db/schema/mirror.js";
import { currentConventions } from "../conventions/store.js";
import { baseVariant, draftDatasets } from "./drafter.js";
import {
  PAIRING_CHARACTERS,
  PAIRING_ROWS,
  PAIRING_TOTAL_CHARACTERS,
  pairingOf,
  suggestMerges,
  suggestSameNames,
  type MergeSuggestion,
} from "./suggestions.js";

afterAll(closeTestPools);

const everything = sql`true`;
const SALES = "Sales";
const FINANCE = "Finance";
const pairOf = (one: string, other: string) => [one, other].sort().join(" ");
const pairs = (suggestions: MergeSuggestion[]) =>
  suggestions
    .flatMap((s) =>
      s.measure_ids.flatMap((one) =>
        s.into_measure_ids.map((other) => pairOf(one, other)),
      ),
    )
    .sort();

describe("suggestMerges on names written apart", () => {
  const filed = async (
    tx: Db,
    dataset: string,
    table: string,
    name: string,
  ) => {
    const [measure] = await tx
      .insert(powerbiMeasure)
      .values({ dataset_id: dataset, table_id: table, name })
      .returning({ id: powerbiMeasure.id });
    const [draft] = await tx
      .insert(metric)
      .values({ name: `merge_${name}`, label: name, origin: "sync" })
      .returning({ id: metric.id });
    if (measure === undefined || draft === undefined)
      throw new Error(`${name} was not stored`);
    await tx.insert(metricVariant).values({
      metric_id: draft.id,
      measure_id: measure.id,
      assigned_by: "sync",
    });
    return draft.id;
  };

  it.each([
    ["Omsætning", "Omsætning - USD", "USD"],
    ["Pallet sales", "PALLET_SALES (LY)", "LY"],
    ["Crate sales", "Crate USD sales", "USD"],
    ["Return 50% rate", "Return 50% rate LY", "LY"],
  ])("pairs %s with %s, asked from either side", (base, worded, word) =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const dataset = sample.tenant.datasets[0];
      if (dataset === undefined) throw new Error("The sample has no dataset.");
      const [table] = await tx
        .select({ id: powerbiTable.id })
        .from(powerbiTable)
        .where(eq(powerbiTable.dataset_id, dataset.id));
      if (table === undefined) throw new Error("The sample has no table.");
      const into = await filed(tx, dataset.id, table.id, base);
      const from = await filed(tx, dataset.id, table.id, worded);
      const unrelated = await filed(tx, dataset.id, table.id, `${base} other`);
      const conventions = await currentConventions(tx);
      for (const asked of [from, into]) {
        const found = (
          await suggestMerges(tx, [asked], conventions, everything)
        ).suggestions;
        expect(found).toEqual([
          expect.objectContaining({
            metric_id: from,
            measure: worded,
            into_metric_id: into,
            into_measure: base,
            word,
          }),
        ]);
      }
      expect(
        (await suggestMerges(tx, [unrelated], conventions, everything))
          .suggestions,
      ).toEqual([]);
    }),
  );

  it("suggests two names under two metrics once, with every measure of each name", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const [first, second] = sample.tenant.datasets;
      if (first === undefined || second === undefined)
        throw new Error("The sample has too few datasets.");
      const tables = await Promise.all(
        [first, second].map(
          async ({ id }) =>
            (
              await tx
                .select({
                  id: powerbiTable.id,
                  dataset_id: powerbiTable.dataset_id,
                })
                .from(powerbiTable)
                .where(eq(powerbiTable.dataset_id, id))
            )[0],
        ),
      );
      const [into, from] = await tx
        .insert(metric)
        .values(
          ["pallet_sales", "pallet_sales_ly"].map((name) => ({
            name,
            label: name,
            origin: "sync" as const,
          })),
        )
        .returning({ id: metric.id });
      if (into === undefined || from === undefined)
        throw new Error("The metrics were not stored.");
      const held: Record<string, string[]> = {};
      for (const table of tables) {
        if (table === undefined) throw new Error("The sample has no table.");
        for (const [name, metricId] of [
          ["Pallet sales", into.id],
          ["Pallet sales LY", from.id],
        ] as const) {
          const [measure] = await tx
            .insert(powerbiMeasure)
            .values({ dataset_id: table.dataset_id, table_id: table.id, name })
            .returning({ id: powerbiMeasure.id });
          if (measure === undefined) throw new Error(`${name} was not stored`);
          held[name] = [...(held[name] ?? []), measure.id];
          await tx.insert(metricVariant).values({
            metric_id: metricId,
            measure_id: measure.id,
            assigned_by: "sync",
          });
        }
      }
      const conventions = await currentConventions(tx);
      const { suggestions: found } = await suggestMerges(
        tx,
        [into.id],
        conventions,
        everything,
      );
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        metric_id: from.id,
        measure: "Pallet sales LY",
        into_metric_id: into.id,
        into_measure: "Pallet sales",
        word: "LY",
      });
      expect([...(found[0]?.measure_ids ?? [])].sort()).toEqual(
        [...(held["Pallet sales LY"] ?? [])].sort(),
      );
      expect([...(found[0]?.into_measure_ids ?? [])].sort()).toEqual(
        [...(held["Pallet sales"] ?? [])].sort(),
      );
    }));
});

describe("suggestMerges on the drafted sample", () => {
  it("offers the drafts whose measure names differ by a period or currency word, and no others", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const datasetIds = sample.tenant.datasets.map((dataset) => dataset.id);
      await draftDatasets(
        createTestDeps({ container: "worker", db: tx }),
        datasetIds,
      );
      const conventions = await currentConventions(tx);
      const drafts = await tx.select({ id: metric.id }).from(metric);
      const { suggestions } = await suggestMerges(
        tx,
        drafts.map((d) => d.id),
        conventions,
        everything,
      );

      const expected = EXPECTED_NOT_GROUPED.filter(
        (p) => p.suggested_by_name,
      ).map(({ measures: [one, other] }) =>
        pairOf(sample.measureId(one), sample.measureId(other)),
      );
      expect(pairs(suggestions)).toEqual(expected.sort());
      expect(suggestions).toContainEqual(
        expect.objectContaining({
          measure: "Revenue USD",
          into_measure: "Revenue",
          word: "USD",
          axis: "currency",
        }),
      );

      // Asked for the metric without the word, it finds the one with it.
      const adSpend = sample.measureId({
        dataset: "Marketing",
        measure: "Ad spend",
      });
      const [filing] = await tx
        .select()
        .from(metricVariant)
        .where(eq(metricVariant.measure_id, adSpend));
      const { suggestions: forAdSpend } = await suggestMerges(
        tx,
        filing === undefined ? [] : [filing.metric_id],
        conventions,
        everything,
      );
      expect(forAdSpend).toEqual([
        expect.objectContaining({
          measure: "Ad spend LY",
          into_measure_ids: [adSpend],
          word: "LY",
          axis: "period",
        }),
      ]);
    }));
});

describe("suggestSameNames on the drafted sample", () => {
  const drafted = (
    work: (
      tx: Db,
      sample: SampleMirror,
      ids: string[],
      metricOf: (dataset: string, measure: string) => Promise<string>,
    ) => Promise<void>,
  ) =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      await draftDatasets(
        createTestDeps({ container: "worker", db: tx }),
        sample.tenant.datasets.map((dataset) => dataset.id),
      );
      const drafts = await tx.select({ id: metric.id }).from(metric);
      await work(
        tx,
        sample,
        drafts.map((d) => d.id),
        async (dataset, measure) => {
          const [filing] = await tx
            .select()
            .from(metricVariant)
            .where(
              eq(
                metricVariant.measure_id,
                sample.measureId({ dataset, measure }),
              ),
            );
          return filing?.metric_id ?? "";
        },
      );
    });

  it("offers each pair of metrics once, by the names two of them hold", () =>
    drafted(async (tx, _, ids) => {
      const found = (await suggestSameNames(tx, ids, undefined)).filter(
        (s) => s.axis === "name",
      );
      for (const s of found) {
        expect(wordsOf(s.measure)).toEqual(wordsOf(s.into_measure));
        expect(s).toMatchObject({ axis: "name", word: null });
      }
      expect(
        [...new Set(found.map((s) => wordsOf(s.measure).join(" ")))].sort(),
      ).toEqual(
        EXPECTED_SAME_NAME.map((name) => wordsOf(name).join(" ")).sort(),
      );
      const metricPairs = found.map((s) =>
        pairOf(s.metric_id, s.into_metric_id),
      );
      expect(metricPairs).toEqual([...new Set(metricPairs)]);
    }));

  it("offers two drafts of one calculation under two names, once, and on proof before a name", () =>
    drafted(async (tx, _, ids, metricOf) => {
      const net = await metricOf(SALES, "Net sales");
      const revenue = await metricOf(FINANCE, "Revenue");
      const found = (await suggestSameNames(tx, ids, undefined)).filter(
        (s) => pairOf(s.metric_id, s.into_metric_id) === pairOf(net, revenue),
      );
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        into_measure: "Revenue",
        word: null,
        axis: "calculation",
      });
    }));

  it("offers no calculation through a measure the caller may not describe", () =>
    drafted(async (tx, sample, ids, metricOf) => {
      const net = await metricOf(SALES, "Net sales");
      const revenue = await metricOf(FINANCE, "Revenue");
      const finance = sample.tenant.datasets.find((d) => d.name === FINANCE);
      const found = await suggestSameNames(
        tx,
        ids,
        eq(powerbiMeasure.dataset_id, finance?.id ?? ""),
      );
      expect(
        found.filter(
          (s) => pairOf(s.metric_id, s.into_metric_id) === pairOf(net, revenue),
        ),
      ).toEqual([]);
    }));

  it("offers no calculation between a shift and a base", () =>
    drafted(async (tx, _, ids) => {
      const found = await suggestSameNames(tx, ids, undefined);
      const shifted = await tx
        .select({ id: metricVariant.measure_id })
        .from(metricVariant)
        .where(sql`not ${baseVariant}`);
      const shifts = new Set(shifted.map((row) => row.id));
      expect(
        found.filter(
          (s) =>
            s.axis === "calculation" &&
            [...s.measure_ids, ...s.into_measure_ids].some((id) =>
              shifts.has(id),
            ),
        ),
      ).toEqual([]);
    }));

  it("reads only the measures the caller may describe, so a hidden one neither shows nor hides a pair", () =>
    drafted(async (tx, sample, _, metricOf) => {
      const lines = await metricOf("Sales", "Order lines");
      const others = await metricOf("Retail", "Order lines");
      const marketing = sample.tenant.datasets.find(
        (d) => d.name === "Marketing",
      );
      // Order lines is also in Marketing, and whichever measure sorts first, the pair stands.
      const found = await suggestSameNames(
        tx,
        [lines],
        ne(powerbiMeasure.dataset_id, marketing?.id ?? ""),
      );
      expect(found.map((s) => [s.measure, s.into_metric_id])).toContainEqual([
        "Order lines",
        others,
      ]);
      const blind = await suggestSameNames(
        tx,
        [lines],
        eq(
          powerbiMeasure.id,
          sample.measureId({ dataset: "Sales", measure: "Order lines" }),
        ),
      );
      expect(blind).toEqual([]);
    }));

  it("offers one metric a bounded number of others, however many hold the name", () =>
    drafted(async (tx, sample, _, metricOf) => {
      const lines = await metricOf("Sales", "Order lines");
      const [home] = await tx
        .select()
        .from(powerbiMeasure)
        .where(
          eq(
            powerbiMeasure.id,
            sample.measureId({ dataset: "Sales", measure: "Order lines" }),
          ),
        );
      if (home === undefined) throw new Error("The sample has no Order lines");
      const crowd: string[] = [];
      for (let n = 0; n < 15; n += 1) {
        // Punctuation is no word, so each of these is the name again.
        const [added] = await tx
          .insert(powerbiMeasure)
          .values({
            dataset_id: home.dataset_id,
            table_id: home.table_id,
            name: `Order lines${"!".repeat(n + 1)}`,
            expression: `COUNTROWS('Sales lines') + ${String(n)}`,
          })
          .returning();
        const [draft] = await tx
          .insert(metric)
          .values({
            name: `crowd_${String(n)}`,
            label: `Crowd ${String(n)}`,
            origin: "sync",
          })
          .returning();
        if (added === undefined || draft === undefined)
          throw new Error("Not inserted");
        crowd.push(draft.id);
        await tx.insert(metricVariant).values({
          metric_id: draft.id,
          measure_id: added.id,
          assigned_by: "sync",
        });
      }
      const found = await suggestSameNames(tx, [lines], undefined);
      expect(found).toHaveLength(10);
      // Asked about all of them, no metric is in more than that many pairs.
      const pairsOf = new Map<string, number>();
      for (const s of await suggestSameNames(tx, crowd, undefined))
        for (const id of [s.metric_id, s.into_metric_id])
          pairsOf.set(id, (pairsOf.get(id) ?? 0) + 1);
      expect(pairsOf.size).toBeGreaterThan(10);
      expect(Math.max(...pairsOf.values())).toBeLessThanOrEqual(10);
    }));
});

describe("the bounds on likely merges from a word", () => {
  const spellings = 300;
  const filed = async (
    tx: Db,
    metricId: string,
    dataset: string,
    table: string,
    names: string[],
  ) => {
    const measures = await tx
      .insert(powerbiMeasure)
      .values(
        names.map((name) => ({ dataset_id: dataset, table_id: table, name })),
      )
      .returning({ id: powerbiMeasure.id });
    await tx.insert(metricVariant).values(
      measures.map(({ id }) => ({
        metric_id: metricId,
        measure_id: id,
        assigned_by: "sync" as const,
      })),
    );
  };
  const draft = async (tx: Db, name: string) => {
    const [row] = await tx
      .insert(metric)
      .values({ name, label: name, origin: "sync" })
      .returning({ id: metric.id });
    if (row === undefined) throw new Error(`${name} was not stored`);
    return row.id;
  };
  const tableOf = async (tx: Db, dataset: string) => {
    const [table] = await tx
      .select({ id: powerbiTable.id })
      .from(powerbiTable)
      .where(eq(powerbiTable.dataset_id, dataset));
    if (table === undefined) throw new Error("The dataset has no table.");
    return table.id;
  };
  // The same words under many spellings, since each spelling is a name of its own.
  const spelt = (base: string, suffix: string) =>
    Array.from(
      { length: spellings },
      (_, n) => `${base}${".".repeat(n + 1)}${suffix}`,
    );

  it("offers an asked metric at most the entry limit, however many spellings pair", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const [dataset] = sample.tenant.datasets;
      if (dataset === undefined) throw new Error("The sample has no dataset.");
      const table = await tableOf(tx, dataset.id);
      const worded = await draft(tx, "spelt_worded");
      const plain = await draft(tx, "spelt_plain");
      await filed(tx, worded, dataset.id, table, spelt("Zed", " USD"));
      await filed(tx, plain, dataset.id, table, spelt("Zed", ""));

      const conventions = await currentConventions(tx);
      for (const asked of [[worded], [plain], [worded, plain]]) {
        expect(
          (await suggestMerges(tx, asked, conventions, everything)).suggestions,
        ).toHaveLength(25);
      }
    }));

  const hint = (word: string) => ({
    axis: "currency" as const,
    word,
    words: wordsOf(word),
  });

  const names = (count: number, make: (n: number) => string) =>
    Array.from({ length: count }, (_, n) => ({
      metric_id: `metric_${String(n)}`,
      name: make(n),
      visible: true,
    }));
  const lengthOf = (strings: string[]) =>
    strings.reduce((sum, name) => sum + name.length, 0);

  it("leaves a full page of the queue whole: 50 drafts of 15 names of 15 words", () => {
    const hints = Array.from({ length: 36 }, (_, n) =>
      hint(`code${String(n)}`),
    );
    const words = (n: number) =>
      Array.from({ length: 15 }, (_, w) => `word${String(w)}x${String(n)}`);
    const held = Array.from({ length: 750 }, (_, n) => ({
      metric_id: `metric_${String(Math.floor(n / 15))}`,
      name: words(n).join(" "),
      visible: true,
    }));
    const { names: pairing, cut } = pairingOf(held, hints);
    expect(cut.size).toBe(0);
    expect(pairing.length).toBeGreaterThan(400_000);
    expect(lengthOf(pairing)).toBeLessThan(PAIRING_TOTAL_CHARACTERS);
  });

  it("holds what a pairing is made of to PAIRING_ROWS strings, however many names ask", () => {
    // Short names under many metrics, so neither limit in characters is reached first.
    const held = names(PAIRING_ROWS / 4, (n) => `a${String(n)} b c d`);
    const { names: pairing, cut } = pairingOf(held, [hint("usd")]);
    expect(pairing.length).toBeGreaterThan(PAIRING_ROWS * 0.9);
    expect(pairing.length).toBeLessThanOrEqual(PAIRING_ROWS);
    expect(lengthOf(pairing)).toBeLessThan(PAIRING_TOTAL_CHARACTERS);
    expect(cut.size).toBeGreaterThan(0);
  });

  it("holds what a pairing is made of to PAIRING_TOTAL_CHARACTERS, however long the names", () => {
    // Under many metrics, so the limit for one metric is not reached first.
    const held = names(
      Math.ceil(PAIRING_TOTAL_CHARACTERS / 8000) * 2,
      (n) => `${"x".repeat(3000)}${String(n)}`,
    );
    const { names: pairing, cut } = pairingOf(held, [hint("usd")]);
    expect(lengthOf(pairing)).toBeGreaterThan(PAIRING_TOTAL_CHARACTERS * 0.9);
    expect(lengthOf(pairing)).toBeLessThanOrEqual(PAIRING_TOTAL_CHARACTERS);
    expect(pairing.length).toBeLessThan(PAIRING_ROWS);
    expect(cut.size).toBeGreaterThan(0);
  });

  it("holds what one metric asks to PAIRING_CHARACTERS and leaves the others whole", () => {
    const greedy = Array.from({ length: 400 }, (_, n) => ({
      metric_id: "greedy",
      name: `${"x".repeat(3000)}${String(n)}`,
      visible: true,
    }));
    const modest = { metric_id: "modest", name: "net sales", visible: true };
    const { names: pairing, cut } = pairingOf(
      [...greedy, modest],
      [hint("usd")],
    );
    expect(
      lengthOf(pairing.filter((name) => name.startsWith("x"))),
    ).toBeLessThanOrEqual(PAIRING_CHARACTERS);
    expect(pairing).toContain("net sales usd");
    expect([...cut]).toEqual(["greedy"]);
  });
});
