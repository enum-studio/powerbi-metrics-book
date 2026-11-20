import { sampleTenant } from "@powerbi-metrics-book/powerbi-mock";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeTestPools } from "../../../test/deps.js";
import { asPerson, reaching } from "../../../test/mirror-fixtures.js";
import { inSampleMirror, setRole } from "../../../test/sample-mirror.js";
import type { Db } from "../../context.js";
import { metric, metricVariant } from "../../db/schema/book.js";
import {
  powerbiDataset,
  powerbiMeasure,
  powerbiTable,
} from "../../db/schema/mirror.js";
import { currentConventions } from "../conventions/store.js";
import { nextDrafts } from "./drafts.js";
import { suggestMerges } from "./suggestions.js";

afterAll(closeTestPools);

/*
 * What a likely merge looks for has a bound, so what fills it must not depend on
 * a measure the caller may not describe: enough of them to fill it can neither
 * show themselves nor take away a pair the caller could see.
 */

const tenant = sampleTenant();
const idOf = (items: { id: string; name: string }[], name: string) => {
  const found = items.find((item) => item.name === name);
  if (found === undefined) throw new Error(`The sample has no ${name}`);
  return found.id;
};
const salesCurator = reaching(
  { powerbi_workspace_ids: [idOf(tenant.workspaces, "Commercial")] },
  "curator",
);
/*
 * Names of two words, the second of 3,000 characters, which cost a metric about
 * a fifth of what it may have a likely merge look for, so a few dozen fill it.
 * The pair's names are longer by ten characters than any filler, so once the
 * fillers have filled the limit the pair does not fit in what is left.
 */
const FILLERS = 40;
const filler = (n: number) => `Aaa${String(n)} ${"x".repeat(3000)}`;
const crates = (suffix = "") => `Zebra ${"c".repeat(3010)}${suffix}`;

const stored = async (tx: Db, name: string) => {
  const [draft] = await tx
    .insert(metric)
    .values({ name, label: name, origin: "sync" })
    .returning({ id: metric.id });
  if (draft === undefined) throw new Error(`${name} was not stored`);
  return draft.id;
};

const file = async (
  tx: Db,
  metricId: string,
  dataset: string,
  names: string[],
) => {
  const [table] = await tx
    .select({ id: powerbiTable.id })
    .from(powerbiTable)
    .where(eq(powerbiTable.dataset_id, dataset));
  if (table === undefined) throw new Error("The dataset has no table.");
  const measures = await tx
    .insert(powerbiMeasure)
    .values(
      names.map((name) => ({ dataset_id: dataset, table_id: table.id, name })),
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

describe("the bound on what a likely merge looks for", () => {
  it("is filled by what the caller may describe before a hidden measure", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const sales = idOf(sample.tenant.datasets, "Sales");
      const finance = idOf(sample.tenant.datasets, "Finance");
      const draft = await stored(tx, "crates_draft");
      const worded = await stored(tx, "crates_worded");
      await file(
        tx,
        draft,
        finance,
        Array.from({ length: FILLERS }, (_, n) => filler(n)),
      );
      await file(tx, draft, sales, [crates()]);
      await file(tx, worded, sales, [crates(" LY")]);
      await setRole(tx, "api_rw");

      // Asked with no caller, the fillers sort first and fill the bound: the pair is lost.
      const blind = await suggestMerges(
        tx,
        [draft],
        await currentConventions(tx),
        sql`true`,
      );
      expect(blind.suggestions).toEqual([]);

      const queue = await nextDrafts(asPerson(salesCurator, { db: tx }), {
        limit: 50,
      });
      const found = queue.find((d) => d.id === draft);
      expect(found?.suggested_merges).toContainEqual(
        expect.objectContaining({
          measure: crates(" LY"),
          into_measure: crates(),
          word: "LY",
        }),
      );
      expect(JSON.stringify(queue)).not.toContain("hidden filler");
    }));

  it("is filled by what a policy on a nullable column lets through, not by a measure it gives NULL", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const sales = idOf(sample.tenant.datasets, "Sales");
      const finance = idOf(sample.tenant.datasets, "Finance");
      // A policy `sensitivity_label == "General"` is NULL, not false, for a dataset with no label.
      await tx
        .update(powerbiDataset)
        .set({ sensitivity_label: "General" })
        .where(eq(powerbiDataset.id, sales));
      await tx
        .update(powerbiDataset)
        .set({ sensitivity_label: null })
        .where(eq(powerbiDataset.id, finance));
      const draft = await stored(tx, "pallets_draft");
      const worded = await stored(tx, "pallets_worded");
      await file(
        tx,
        draft,
        finance,
        Array.from({ length: FILLERS }, (_, n) => filler(n)),
      );
      await file(tx, draft, sales, [crates()]);
      await file(tx, worded, sales, [crates(" LY")]);
      await setRole(tx, "api_rw");

      const { suggestions, cut } = await suggestMerges(
        tx,
        [draft],
        await currentConventions(tx),
        eq(powerbiDataset.sensitivity_label, "General"),
      );
      expect(suggestions).toEqual([
        expect.objectContaining({
          measure: crates(" LY"),
          into_measure: crates(),
        }),
      ]);
      expect(cut.size).toBe(0);
    }));

  it("counts a pair with a hidden side apart, so it cannot use up the entries of a visible pair", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const sales = idOf(sample.tenant.datasets, "Sales");
      const finance = idOf(sample.tenant.datasets, "Finance");
      const spelt = (base: string, suffix: string) =>
        Array.from(
          { length: 300 },
          (_, n) => `${base}${".".repeat(n + 1)}${suffix}`,
        );
      const worded = await stored(tx, "spelt_worded");
      const plain = await stored(tx, "spelt_plain");
      await file(tx, worded, sales, spelt("Zed", " USD"));
      await file(tx, plain, sales, spelt("Zed", ""));
      await file(tx, worded, finance, spelt("Aaa", " USD"));
      await file(tx, plain, finance, spelt("Aaa", ""));

      const { suggestions } = await suggestMerges(
        tx,
        [worded],
        await currentConventions(tx),
        eq(powerbiMeasure.dataset_id, sales),
      );
      expect(
        suggestions.filter((s) => s.measure.startsWith("Zed")),
      ).toHaveLength(25);
      expect(suggestions).toHaveLength(50);
    }));

  it("says a draft lost a name the caller may describe, and says nothing of a name it may not", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const sales = idOf(sample.tenant.datasets, "Sales");
      const finance = idOf(sample.tenant.datasets, "Finance");
      // Each name builds about 1.5 million characters under the default hints, and one metric may have 2 million.
      const long = (letter: string) => letter.repeat(20_000);
      const open = await stored(tx, "long_open");
      const shut = await stored(tx, "long_shut");
      await file(tx, open, sales, [long("a"), long("b")]);
      await file(tx, shut, sales, [long("c")]);
      await file(tx, shut, finance, [long("d"), long("e")]);
      await setRole(tx, "api_rw");

      const queue = await nextDrafts(asPerson(salesCurator, { db: tx }), {
        limit: 50,
      });
      expect(queue.find((d) => d.id === open)?.suggested_merges_truncated).toBe(
        true,
      );
      expect(queue.find((d) => d.id === shut)?.suggested_merges_truncated).toBe(
        false,
      );
    }));
});
