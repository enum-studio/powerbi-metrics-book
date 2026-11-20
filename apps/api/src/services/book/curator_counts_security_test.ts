import { and, eq, inArray, like } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeTestPools } from "../../../test/deps.js";
import { asPerson, reaching } from "../../../test/mirror-fixtures.js";
import {
  inSampleMirror,
  type SampleMirror,
  setRole,
} from "../../../test/sample-mirror.js";
import type { Db } from "../../context.js";
import { metric, metricVariant } from "../../db/schema/book.js";
import { powerbiMeasure, powerbiTable } from "../../db/schema/mirror.js";
import { piiRule } from "../../db/schema/pii.js";
import { ServiceError } from "../../errors.js";
import type { Principal } from "../../principal.js";
import { nextDrafts } from "./drafts.js";
import {
  approveMetric,
  getMetric,
  listMetrics,
  metricChecks,
  verifyMetric,
} from "./metrics.js";

afterAll(closeTestPools);

/*
 * The queue and a failing check shorten what they say by counting: a likely
 * merge counts the datasets holding its measure, and metric_not_the_same_as
 * counts the labels it does not name. A count is built from many rows, so each
 * test holds that the rows a caller may not see are neither named nor counted,
 * whether they are out of its reach or PII.
 */

const SALES = "Sales";
const FINANCE = "Finance";
const MARKETING = "Marketing";
/** In the Commercial workspace, as the Sales dataset is. */
const RETAIL = "Retail";
const RETAIL_TABLE = "Order lines";
/** A table of this name is in Sales, Finance and Marketing. */
const TABLE = "Sales lines";
const OTHER_TABLE = "Exchange rate";

type Fixture = { sample: SampleMirror; tx: Db };

async function tableOf(
  { sample, tx }: Fixture,
  datasetName: string,
  tableName: string,
) {
  const dataset = sample.tenant.datasets.find((d) => d.name === datasetName);
  if (dataset === undefined) throw new Error(`No dataset ${datasetName}`);
  const [table] = await tx
    .select({ id: powerbiTable.id })
    .from(powerbiTable)
    .where(
      and(
        eq(powerbiTable.dataset_id, dataset.id),
        eq(powerbiTable.name, tableName),
      ),
    );
  if (table === undefined)
    throw new Error(`${datasetName} has no ${tableName}`);
  return { dataset_id: dataset.id, table_id: table.id };
}

/** An id the test chooses, so an answer can be compared across two transactions. */
const fixedId = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function metricOf(tx: Db, name: string, label = name, id?: string) {
  const [row] = await tx
    .insert(metric)
    .values({ ...(id !== undefined && { id }), name, label, origin: "sync" })
    .returning({ id: metric.id });
  if (row === undefined) throw new Error(`${name} was not stored`);
  return row.id;
}

async function file(
  fixture: Fixture,
  metricId: string,
  measures: [
    datasetName: string,
    name: string,
    tableName?: string,
    id?: string,
  ][],
) {
  for (const [datasetName, name, tableName = TABLE, id] of measures) {
    const { dataset_id, table_id } = await tableOf(
      fixture,
      datasetName,
      tableName,
    );
    const [measure] = await fixture.tx
      .insert(powerbiMeasure)
      .values({ ...(id !== undefined && { id }), dataset_id, table_id, name })
      .returning({ id: powerbiMeasure.id });
    if (measure === undefined) throw new Error(`${name} was not stored`);
    await fixture.tx.insert(metricVariant).values({
      metric_id: metricId,
      measure_id: measure.id,
      assigned_by: "sync",
    });
  }
}

/** A rule on a measure's name in a table of that name, in any dataset, set as a person would. */
const piiMeasureRule = async (tx: Db, name: string, table_name = TABLE) => {
  await setRole(tx, "api_rw");
  await tx.insert(piiRule).values({
    kind: "measure",
    table_name,
    name,
    pii: true,
    set_by_kind: "person",
    set_by_id: "x",
    set_via: "api",
  });
};

/** The workspace a dataset of the sample sits in. */
const workspaceId = ({ sample }: Fixture, datasetName: string) => {
  const found = sample.tenant.datasets.find((d) => d.name === datasetName);
  if (found === undefined) throw new Error(`No dataset ${datasetName}`);
  return found.workspace_id;
};

const curators = (fixture: Fixture) => {
  const inSales = reaching(
    { powerbi_workspace_ids: [workspaceId(fixture, SALES)] },
    "curator",
  );
  const inBoth = reaching(
    {
      powerbi_workspace_ids: [SALES, FINANCE].map((name) =>
        workspaceId(fixture, name),
      ),
    },
    "curator",
  );
  const withPii = (principal: Principal): Principal => ({
    ...principal,
    roles: [...principal.roles, "pii_reader"],
  });
  return { inSales, inBoth, withPii };
};

describe("a likely merge in the queue", () => {
  /**
   * Every pair is between the same two metrics, so one entry could easily take
   * a name or a count from a measure its caller may not see.
   */
  const shelved = async (tx: Db, sample: SampleMirror) => {
    const fixture = { sample, tx };
    const into = await metricOf(tx, "crate_sales");
    const from = await metricOf(tx, "crate_sales_ly");
    await file(fixture, into, [
      [SALES, "Crate sales"],
      [FINANCE, "Crate sales"],
      [SALES, "Far crates"],
      [FINANCE, "Ledger crates"],
      [SALES, "Private crates"],
      [FINANCE, "Split crates"],
    ]);
    await file(fixture, from, [
      [SALES, "Crate sales LY"],
      [FINANCE, "Crate sales LY"],
      [FINANCE, "Far crates LY"],
      [FINANCE, "Ledger crates LY"],
      [SALES, "Private crates LY"],
      [SALES, "Split crates LY"],
    ]);
    await piiMeasureRule(tx, "Private crates");
    return { fixture, into, from };
  };

  const merge = (
    ids: { from: string; into: string },
    measure: string,
    dataset_count: number,
  ) => ({
    metric_id: ids.from,
    measure: `${measure} LY`,
    into_metric_id: ids.into,
    into_measure: measure,
    word: "LY",
    axis: "period",
    dataset_count,
  });

  const queueOf = async (tx: Db, principal: Principal, draft: string) => {
    const queue = await nextDrafts(asPerson(principal, { db: tx }), {
      limit: 50,
    });
    const found = queue.find((d) => d.id === draft);
    if (found === undefined) throw new Error("The draft is not in the queue.");
    return { queue, found };
  };

  it("names and counts only what a caller who reaches one dataset may describe, and counts the rest as hidden", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const { fixture, ...ids } = await shelved(tx, sample);
      const { inSales } = curators(fixture);
      const { queue, found } = await queueOf(tx, inSales, ids.into);
      expect(found.suggested_merges).toEqual([merge(ids, "Crate sales", 1)]);
      // Ledger crates is in Finance, Private crates is PII, and Far crates and Split crates each have one side in Finance.
      expect(found.hidden_suggested_merges).toBe(4);
      // The other names here are in Sales and not PII, so a draft's own variants name them.
      expect(JSON.stringify(queue)).not.toMatch(
        /Far crates LY|Ledger crates|Private crates(?! LY)|Split crates(?! LY)/,
      );
    }));

  it("names no measure's id, so a measure out of reach gives away nothing", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const { fixture, ...ids } = await shelved(tx, sample);
      const { inSales } = curators(fixture);
      const { dataset_id } = await tableOf(fixture, FINANCE, TABLE);
      const outOfReach = await tx
        .select({ id: powerbiMeasure.id })
        .from(powerbiMeasure)
        .where(eq(powerbiMeasure.dataset_id, dataset_id));
      const { queue } = await queueOf(tx, inSales, ids.into);
      const answer = JSON.stringify(queue);
      expect(outOfReach.length).toBeGreaterThan(0);
      for (const { id } of outOfReach) expect(answer).not.toContain(id);
      expect(answer).not.toContain(dataset_id);
    }));

  it("names a PII measure only to a reader of PII", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const { fixture, ...ids } = await shelved(tx, sample);
      const { inSales, withPii } = curators(fixture);
      const { found } = await queueOf(tx, withPii(inSales), ids.into);
      expect(found.suggested_merges).toEqual([
        merge(ids, "Crate sales", 1),
        merge(ids, "Private crates", 1),
      ]);
      expect(found.hidden_suggested_merges).toBe(3);
    }));

  /**
   * One calculation under four names: two in Sales, one only in Finance, and
   * one a PII rule covers. `hidden` adds a Finance copy that sorts first.
   */
  const oneCalculation = async (
    tx: Db,
    sample: SampleMirror,
    hidden: [string, string][] = [],
  ) => {
    const fixture = { sample, tx };
    const net = await metricOf(tx, "crate_net");
    const revenue = await metricOf(tx, "crate_revenue");
    await file(fixture, net, [
      [SALES, "Crate net"],
      [FINANCE, "Crate net"],
      ...hidden,
    ]);
    await file(fixture, revenue, [[SALES, "Crate revenue"]]);
    await file(fixture, await metricOf(tx, "crate_ledger"), [
      [FINANCE, "Crate ledger"],
    ]);
    await file(fixture, await metricOf(tx, "crate_private"), [
      [SALES, "Crate private"],
    ]);
    await tx
      .update(powerbiMeasure)
      .set({ fingerprint: "one calculation" })
      .where(like(powerbiMeasure.name, "Crate %"));
    await piiMeasureRule(tx, "Crate private");
    return { fixture, net, revenue };
  };

  const proven = (
    ids: { net: string; revenue: string },
    dataset_count: number,
  ) => ({
    metric_id: ids.net,
    measure: "Crate net",
    into_metric_id: ids.revenue,
    into_measure: "Crate revenue",
    word: null,
    axis: "calculation",
    dataset_count,
  });

  it("offers one calculation only through measures the caller may describe, and counts nothing it may not", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const { fixture, ...ids } = await oneCalculation(tx, sample);
      const { inSales } = curators(fixture);
      const { queue, found } = await queueOf(tx, inSales, ids.net);
      expect(found.suggested_merges).toEqual([proven(ids, 1)]);
      expect(found.hidden_suggested_merges).toBe(0);
      expect(JSON.stringify(queue)).not.toMatch(
        /crate_ledger|Crate ledger|crate_private|Crate private/,
      );
    }));

  it("lets no copy of one calculation out of reach take an entry's place", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const { fixture, ...ids } = await oneCalculation(tx, sample, [
        [FINANCE, "Crate aaa"],
      ]);
      const { inSales } = curators(fixture);
      const { queue, found } = await queueOf(tx, inSales, ids.net);
      expect(found.suggested_merges).toEqual([proven(ids, 1)]);
      expect(JSON.stringify(queue)).not.toContain("Crate aaa");
    }));

  it("counts the datasets of one calculation that the caller reaches, and offers what it reaches there", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const { fixture, ...ids } = await oneCalculation(tx, sample);
      const { inBoth } = curators(fixture);
      const { found, queue } = await queueOf(tx, inBoth, ids.net);
      expect(found.suggested_merges).toContainEqual(proven(ids, 2));
      expect(found.suggested_merges.map((s) => s.measure)).toContain(
        "Crate ledger",
      );
      expect(JSON.stringify(queue)).not.toMatch(/Crate private/);
    }));

  it("offers one calculation through a PII measure only to a reader of PII", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const { fixture, ...ids } = await oneCalculation(tx, sample);
      const { inSales, withPii } = curators(fixture);
      const { found } = await queueOf(tx, withPii(inSales), ids.net);
      expect(found.suggested_merges.map((s) => s.into_measure)).toContain(
        "Crate private",
      );
      const { queue } = await queueOf(tx, inSales, ids.net);
      expect(JSON.stringify(queue)).not.toContain("Crate private");
    }));

  it("offers no pair of metrics whose only shared calculation is out of reach", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const fixture = { sample, tx };
      const one = await metricOf(tx, "crate_one");
      const other = await metricOf(tx, "crate_other");
      await file(fixture, one, [
        [SALES, "Crate one"],
        [FINANCE, "Crate far"],
      ]);
      await file(fixture, other, [
        [SALES, "Crate other"],
        [FINANCE, "Crate farther"],
      ]);
      await tx
        .update(powerbiMeasure)
        .set({ fingerprint: "one far calculation" })
        .where(inArray(powerbiMeasure.name, ["Crate far", "Crate farther"]));
      await setRole(tx, "api_rw");
      const { inSales, inBoth } = curators(fixture);
      const near = await queueOf(tx, inSales, one);
      expect(near.found.suggested_merges).toEqual([]);
      const far = await queueOf(tx, inBoth, one);
      expect(far.found.suggested_merges).toMatchObject([
        { into_metric_id: other, axis: "calculation" },
      ]);
    }));

  it("names no PII measure to a service account, whatever role it is given", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const { fixture, ...ids } = await shelved(tx, sample);
      const { inSales } = curators(fixture);
      const account: Principal = {
        ...inSales,
        kind: "service_account",
        id: "curating agent",
        via: "api",
        roles: [...inSales.roles, "pii_reader"],
      };
      const { found } = await queueOf(tx, account, ids.into);
      expect(found.suggested_merges).toEqual([merge(ids, "Crate sales", 1)]);
      expect(found.hidden_suggested_merges).toBe(4);
    }));

  it("counts every dataset of the measure for a caller who reaches them, but never a PII one", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const { fixture, ...ids } = await shelved(tx, sample);
      const { inBoth, withPii } = curators(fixture);
      const seen = await queueOf(tx, inBoth, ids.into);
      expect(seen.found.suggested_merges).toEqual([
        merge(ids, "Crate sales", 2),
        merge(ids, "Far crates", 1),
        merge(ids, "Ledger crates", 1),
        merge(ids, "Split crates", 1),
      ]);
      expect(seen.found.hidden_suggested_merges).toBe(1);
      const all = await queueOf(tx, withPii(inBoth), ids.into);
      expect(all.found.suggested_merges).toEqual([
        merge(ids, "Crate sales", 2),
        merge(ids, "Far crates", 1),
        merge(ids, "Ledger crates", 1),
        merge(ids, "Private crates", 1),
        merge(ids, "Split crates", 1),
      ]);
      expect(all.found.hidden_suggested_merges).toBe(0);
    }));

  it("leaves a PII copy of a measure out of the count, where a rule reaches only that copy's table", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const fixture = { sample, tx };
      const into = await metricOf(tx, "bin_sales");
      const from = await metricOf(tx, "bin_sales_ly");
      await file(fixture, into, [[SALES, "Bin sales"]]);
      await file(fixture, from, [
        [SALES, "Bin sales LY"],
        [FINANCE, "Bin sales LY", OTHER_TABLE],
      ]);
      await piiMeasureRule(tx, "Bin sales LY", OTHER_TABLE);
      const ids = { from, into };
      const { inBoth, withPii } = curators(fixture);
      const hidden = await queueOf(tx, inBoth, into);
      expect(hidden.found.suggested_merges).toEqual([
        merge(ids, "Bin sales", 1),
      ]);
      const read = await queueOf(tx, withPii(inBoth), into);
      expect(read.found.suggested_merges).toEqual([merge(ids, "Bin sales", 2)]);
    }));

  it("names only the spelling the caller may describe, where a hidden copy is written apart", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const fixture = { sample, tx };
      const into = await metricOf(tx, "foo");
      const from = await metricOf(tx, "foo_ly");
      await file(fixture, into, [[SALES, "Foo"]]);
      await file(fixture, from, [
        [SALES, "Foo LY"],
        [FINANCE, "FOO LY"],
      ]);
      const { inSales } = curators(fixture);
      const { queue, found } = await queueOf(tx, inSales, into);
      expect(found.suggested_merges).toEqual([merge({ from, into }, "Foo", 1)]);
      expect(found.hidden_suggested_merges).toBe(1);
      expect(JSON.stringify(queue)).not.toContain("FOO LY");
    }));

  it.each([
    ["the name with the word", "Foo", "Foo LY"],
    ["the name without it", "Foo LY", "Foo"],
  ])(
    "answers alike wherever a hidden copy of %s is filed, so no entry moves for a measure the caller may not see",
    async (_paired, own, paired) => {
      const draft = fixedId(10);
      const first = fixedId(11);
      const second = fixedId(12);
      const withHiddenCopyUnder = async (holder: string) => {
        let answer: unknown;
        await inSampleMirror("worker_rw", async (tx, sample) => {
          const fixture = { sample, tx };
          await metricOf(tx, "foo_draft", "foo_draft", draft);
          await metricOf(tx, "foo_first", "foo_first", first);
          await metricOf(tx, "foo_second", "foo_second", second);
          await file(fixture, draft, [[SALES, own]]);
          // The hidden copy has the lowest id of all, so it would come first if an id ordered them.
          await file(fixture, holder, [[FINANCE, paired, TABLE, fixedId(1)]]);
          await file(fixture, first, [[SALES, paired, TABLE, fixedId(2)]]);
          await file(fixture, second, [
            [RETAIL, paired, RETAIL_TABLE, fixedId(3)],
          ]);
          const { inSales } = curators(fixture);
          const { found } = await queueOf(tx, inSales, draft);
          expect(found.suggested_merges).toHaveLength(2);
          answer = [found.suggested_merges, found.hidden_suggested_merges];
        });
        return answer;
      };
      expect(await withHiddenCopyUnder(second)).toEqual(
        await withHiddenCopyUnder(first),
      );
    },
  );

  describe("on two metrics that share a name", () => {
    const named = async (tx: Db, sample: SampleMirror) => {
      const fixture = { sample, tx };
      const one = await metricOf(tx, "box_count_one");
      const other = await metricOf(tx, "box_count_other");
      await file(fixture, one, [
        [SALES, "Box count"],
        [FINANCE, "Box count"],
      ]);
      await file(fixture, other, [
        [RETAIL, "Box count", RETAIL_TABLE],
        [MARKETING, "Box count"],
      ]);
      return { fixture, one, other };
    };

    it("counts only the datasets the caller may describe", () =>
      inSampleMirror("worker_rw", async (tx, sample) => {
        const { fixture, one } = await named(tx, sample);
        const { inSales, inBoth } = curators(fixture);
        const seen = await queueOf(tx, inSales, one);
        expect(seen.found.suggested_merges).toEqual([
          expect.objectContaining({
            measure: "Box count",
            into_measure: "Box count",
            word: null,
            axis: "name",
            dataset_count: 1,
          }),
        ]);
        expect(seen.found.hidden_suggested_merges).toBe(0);
        const wider = await queueOf(tx, inBoth, one);
        const [entry] = wider.found.suggested_merges;
        // The metric on the measure's side holds Sales and Finance when it is `one`, and only Retail when not.
        expect(entry?.dataset_count).toBe(entry?.metric_id === one ? 2 : 1);
      }));

    it("offers no pair, and counts none, when the other metric is out of reach", () =>
      inSampleMirror("worker_rw", async (tx, sample) => {
        const { fixture, one } = await named(tx, sample);
        const inFinance = reaching(
          { powerbi_workspace_ids: [workspaceId(fixture, FINANCE)] },
          "curator",
        );
        const { queue, found } = await queueOf(tx, inFinance, one);
        expect(found.suggested_merges).toEqual([]);
        expect(found.hidden_suggested_merges).toBe(0);
        expect(JSON.stringify(queue)).not.toContain("box_count_other");
      }));

    it("offers no pair through a PII measure to a caller who may not read PII", () =>
      inSampleMirror("worker_rw", async (tx, sample) => {
        const { fixture, one } = await named(tx, sample);
        // The rule reaches every copy in a table called Sales, and Retail's copy is in another.
        await piiMeasureRule(tx, "Box count", RETAIL_TABLE);
        const { inSales, withPii } = curators(fixture);
        const hidden = await queueOf(tx, inSales, one);
        expect(hidden.found.suggested_merges).toEqual([]);
        expect(hidden.found.hidden_suggested_merges).toBe(0);
        const read = await queueOf(tx, withPii(inSales), one);
        expect(read.found.suggested_merges).toHaveLength(1);
      }));
  });
});

describe("the labels metric_not_the_same_as counts", () => {
  /** Enough visible labels that the sentence counts, and hidden ones that would be the closest. */
  const labelled = async (tx: Db, sample: SampleMirror) => {
    const fixture = { sample, tx };
    const asked = await metricOf(tx, "crate_sales", "Crate sales");
    await file(fixture, asked, [[SALES, "Crate sales"]]);
    for (const word of ["red", "blue", "green", "pink", "gold", "grey"]) {
      const name = `Crate ${word} shelf`;
      await file(fixture, await metricOf(tx, `crate_${word}_shelf`, name), [
        [SALES, name],
      ]);
    }
    const reachedOnlyInFinance = await metricOf(
      tx,
      "ledger_crate_sales",
      "Crate sales ledger",
    );
    await file(fixture, reachedOnlyInFinance, [[FINANCE, "Ledger crate"]]);
    const privateOne = await metricOf(
      tx,
      "private_crate_sales",
      "Crate sales private",
    );
    await file(fixture, privateOne, [[SALES, "Private crate"]]);
    await piiMeasureRule(tx, "Private crate");
    return fixture;
  };

  const isIt = ({ check }: { check: string }) =>
    check === "metric_not_the_same_as";

  /** The sentence and its labels on each path that gives them: a metric's page, its checks, and the refusal to verify or approve it. */
  const sentences = async (tx: Db, principal: Principal) => {
    const context = asPerson(principal, { db: tx });
    const { failing_checks } = await getMetric(context, "crate_sales");
    const refused = async (promotion: Promise<unknown>) => {
      const refusal: unknown = await promotion.catch((error: unknown) => error);
      if (!(refusal instanceof ServiceError))
        throw new Error("The metric was promoted.");
      return refusal.message;
    };
    return [
      JSON.stringify(failing_checks.find(isIt)),
      JSON.stringify((await metricChecks(context, "crate_sales")).find(isIt)),
      await refused(verifyMetric(context, "crate_sales")),
      // A service account never gets as far as the checks on an approve.
      ...(principal.kind === "person"
        ? [await refused(approveMetric(context, "crate_sales"))]
        : []),
    ];
  };

  /** The labels a page and the checks route name, which a hidden row must neither join nor take a place from. */
  const labels = async (tx: Db, principal: Principal) => {
    const context = asPerson(principal, { db: tx });
    const { failing_checks } = await getMetric(context, "crate_sales");
    return [
      failing_checks.find(isIt)?.other_labels,
      (await metricChecks(context, "crate_sales")).find(isIt)?.other_labels,
    ];
  };

  const SHELVES = ["blue", "gold", "green", "grey", "pink", "red"].map(
    (word) => `Crate ${word} shelf`,
  );

  it("neither names nor counts a label out of reach or held only through PII, on any path", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const fixture = await labelled(tx, sample);
      const { inSales } = curators(fixture);
      for (const said of await sentences(tx, inSales)) {
        expect(said).toMatch(/\b6 other metrics share/);
        expect(said).not.toMatch(/ledger|private/i);
      }
      for (const named of await labels(tx, inSales))
        expect(named).toEqual(SHELVES);
    }));

  it("names no PII label to a service account, whatever role it is given", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const fixture = await labelled(tx, sample);
      const { inSales } = curators(fixture);
      const account: Principal = {
        ...inSales,
        kind: "service_account",
        id: "curating agent",
        via: "api",
        roles: [...inSales.roles, "pii_reader"],
      };
      for (const said of await sentences(tx, account)) {
        expect(said).toMatch(/\b6 other metrics share/);
        expect(said).not.toMatch(/ledger|private/i);
      }
      for (const named of await labels(tx, account))
        expect(named).toEqual(SHELVES);
    }));

  it("counts each only for a caller who may see it, on any path", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const fixture = await labelled(tx, sample);
      const { inSales, inBoth, withPii } = curators(fixture);
      for (const [principal, count, closest, hidden] of [
        [inBoth, /\b7 other metrics share/, ["Crate sales ledger"], /private/i],
        [
          withPii(inSales),
          /\b7 other metrics share/,
          ["Crate sales private"],
          /ledger/i,
        ],
        [
          withPii(inBoth),
          /\b8 other metrics share/,
          ["Crate sales ledger", "Crate sales private"],
          /$^/,
        ],
      ] as const) {
        for (const said of await sentences(tx, principal)) {
          expect(said).toMatch(count);
          expect(said).not.toMatch(hidden);
        }
        for (const named of await labels(tx, principal))
          expect(named).toEqual([...closest, ...SHELVES]);
      }
    }));

  /** The keys and datasets a page names for the metrics sharing the label's words. */
  const otherMetrics = async (tx: Db, principal: Principal) => {
    const { failing_checks } = await getMetric(
      asPerson(principal, { db: tx }),
      "crate_sales",
    );
    return failing_checks.find(isIt)?.other_metrics;
  };

  it("names a same-label metric by key and by only the datasets the caller may describe", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const fixture = await labelled(tx, sample);
      await setRole(tx, "worker_rw");
      const twin = await metricOf(tx, "crate_sales_copy", "Crate sales");
      await file(fixture, twin, [
        [SALES, "Crate sales copy"],
        [FINANCE, "Crate sales copy"],
      ]);
      await setRole(tx, "api_rw");
      const { inSales, inBoth } = curators(fixture);
      const copy = (datasets: string[]) => ({
        key: "crate_sales_copy",
        label: "Crate sales",
        datasets,
      });
      expect(await otherMetrics(tx, inSales)).toContainEqual(copy([SALES]));
      expect(await otherMetrics(tx, inBoth)).toContainEqual(
        copy([FINANCE, SALES]),
      );
      expect(JSON.stringify(await otherMetrics(tx, inSales))).not.toContain(
        FINANCE,
      );
    }));

  it("leaves a PII variant's dataset out of a same-label metric's datasets for a caller without the role", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const fixture = await labelled(tx, sample);
      await setRole(tx, "worker_rw");
      const mixed = await metricOf(tx, "crate_sales_mixed", "Crate sales");
      await file(fixture, mixed, [
        [SALES, "Crate sales mixed"],
        [FINANCE, "Crate sales mixed pii"],
      ]);
      await piiMeasureRule(tx, "Crate sales mixed pii");
      const { inBoth, withPii } = curators(fixture);
      const datasetsOf = async (principal: Principal) =>
        (await otherMetrics(tx, principal))?.find(
          ({ key }) => key === "crate_sales_mixed",
        )?.datasets;
      expect(await datasetsOf(inBoth)).toEqual([SALES]);
      expect(await datasetsOf(withPii(inBoth))).toEqual([FINANCE, SALES]);
    }));

  it("names no metric out of reach or held only through PII, and none to a caller without the role", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const fixture = await labelled(tx, sample);
      const { inSales, withPii } = curators(fixture);
      const keys = async (principal: Principal) =>
        ((await otherMetrics(tx, principal)) ?? []).map(({ key }) => key);
      expect(await keys(inSales)).not.toContain("ledger_crate_sales");
      expect(await keys(inSales)).not.toContain("private_crate_sales");
      expect(await keys(withPii(inSales))).toContain("private_crate_sales");
    }));
});

describe("the total on the first page of list_metrics", () => {
  const shelf = async (tx: Db, sample: SampleMirror) => {
    const fixture = { sample, tx };
    for (const [name, dataset, measure] of [
      ["crate_a", SALES, "Crate a"],
      ["crate_b", SALES, "Crate b"],
      ["crate_c", FINANCE, "Crate c"],
      ["crate_pii", SALES, "Crate pii"],
    ] as const)
      await file(fixture, await metricOf(tx, name), [[dataset, measure]]);
    await piiMeasureRule(tx, "Crate pii");
    return fixture;
  };

  const first = async (tx: Db, principal: Principal, limit = 100) =>
    listMetrics(asPerson(principal, { db: tx }), {
      name_prefix: "crate_",
      limit,
    });

  it("counts only the metrics the caller may describe, and not a PII one without the role", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const fixture = await shelf(tx, sample);
      const { inSales, inBoth, withPii } = curators(fixture);
      expect((await first(tx, inSales)).total).toBe(2);
      expect((await first(tx, inBoth)).total).toBe(3);
      expect((await first(tx, withPii(inSales))).total).toBe(3);
      expect((await first(tx, withPii(inBoth))).total).toBe(4);
    }));

  it("counts all the matches, not the page, and only on the first page", () =>
    inSampleMirror("worker_rw", async (tx, sample) => {
      const fixture = await shelf(tx, sample);
      const { inBoth } = curators(fixture);
      const page = await first(tx, inBoth, 1);
      expect(page.items).toHaveLength(1);
      expect(page.total).toBe(3);
      const next = await listMetrics(asPerson(inBoth, { db: tx }), {
        name_prefix: "crate_",
        limit: 1,
        cursor: page.next_cursor ?? undefined,
      });
      expect(next).not.toHaveProperty("total");
    }));
});
