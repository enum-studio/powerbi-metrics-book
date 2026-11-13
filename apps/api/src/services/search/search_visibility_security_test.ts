import { randomUUID } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  metric,
  metricVariant,
  term,
  termColumn,
} from "../../db/schema/book.js";
import {
  powerbiAppDataset,
  powerbiColumn,
  powerbiDataset,
  powerbiMeasure,
} from "../../db/schema/mirror.js";
import { setRole } from "../../../test/sample-mirror.js";
import {
  person,
  type Searchable,
  searchable,
  serviceAccount,
  useSearchable,
} from "../../../test/search-support.js";
import { createEmbedder } from "./embedder.js";
import { search } from "./query.js";

useSearchable();

/*
 * Search decides what the caller may see inside its one SQL query, from
 * Cerbos's plan over powerbi_dataset as it is now: before ranking, so a page
 * is never thinned, and never from the dataset ids a document copied when it
 * was built.
 */

const SALES = "Sales";
const FINANCE = "Finance";
/** Words in no document, so whatever ranks, ranks by meaning. */
const NO_WORDS = "zqxv frumious vorpal";

/** Gives the drafted metric an alias in no other text, and indexes again. */
async function aliased(s: Searchable, key: string, alias: string) {
  await s.tx
    .update(metric)
    .set({ aliases: [alias] })
    .where(eq(metric.name, key));
  await s.index();
}

/** The element ids of every document but a term's that names a dataset. */
async function inSomeDataset(s: Searchable): Promise<Set<string>> {
  const { rows } = await s.tx.execute<{ id: string }>(
    sql`select element_id as id from search_document where cardinality(dataset_ids) > 0 and kind <> 'term'`,
  );
  return new Set(rows.map((row) => row.id));
}

async function inDataset(s: Searchable, dataset: string): Promise<Set<string>> {
  const { rows } = await s.tx.execute<{ id: string }>(
    sql`select element_id as id from search_document where ${dataset}::uuid = any(dataset_ids)`,
  );
  return new Set(rows.map((row) => row.id));
}

const ids = (answer: Awaited<ReturnType<typeof search>>) =>
  answer.items.map((hit) => hit.id);

describe("search under metadata_visibility: powerbi", () => {
  it("gives the outsider no hit from any dataset, and what is in none", () =>
    searchable({ provider: "openai" }, async (s) => {
      const [, region] = await s.tx
        .insert(term)
        .values([
          {
            name: "Fiscal week",
            definition: "A sample week that starts on a Monday.",
          },
          { name: "Sample region", definition: "Where a sample order went." },
        ])
        .returning({ id: term.id });
      // A term is the book's word, shown to everyone signed in: its text
      // names nothing of the Sales column behind it.
      await s.tx.insert(termColumn).values({
        term_id: region?.id ?? "",
        column_id: s.sample.columnId({
          dataset: SALES,
          table: "Customer",
          column: "Region",
        }),
      });
      await aliased(s, "units_sold", "Sample pieces shipped");
      const outsider = s.as(person());
      const member = s.as(
        person({ powerbi_workspace_ids: [s.idOf("workspaces", SALES)] }),
      );

      expect(
        (await search(member, { query: "Sample pieces shipped" })).items[0],
      ).toMatchObject({ kind: "metric", name: "units_sold", match: "exact" });

      // By meaning something always ranks: here only what is in no dataset.
      const held = await inSomeDataset(s);
      for (const query of ["Sample pieces shipped", "units_sold", "sales"]) {
        const answer = await search(outsider, { query, limit: 50 });
        expect(answer.items.length).toBeGreaterThan(0);
        expect(ids(answer).filter((id) => held.has(id))).toEqual([]);
      }
      const metrics = await search(outsider, {
        query: "Sample pieces shipped",
        kinds: ["metric"],
      });
      expect(metrics.items).toEqual([]);
      // The two terms are all the outsider can find.
      for (const [query, name] of [
        ["fiscal week", "Fiscal week"],
        ["sample region", "Sample region"],
      ]) {
        const { items } = await search(outsider, { query: query ?? "" });
        expect(items).toHaveLength(2);
        expect(items[0]).toMatchObject({ kind: "term", name, match: "exact" });
        expect(
          items.every((hit) => hit.kind === "term" && hit.dataset === null),
        ).toBe(true);
      }
    }));

  it("fills a page from what the person may see, however much ranks above it", () =>
    searchable({ provider: "none" }, async (s) => {
      const finance = s.idOf("datasets", FINANCE);
      const everyone = s.as(
        person({
          powerbi_workspace_ids: s.sample.tenant.workspaces.map((w) => w.id),
        }),
      );
      const leader = s.as(
        person({
          powerbi_app_ids: [s.idOf("apps", "Leadership app")],
        }),
      );
      const query = "sales";
      const limit = 10;

      // Filtered after ranking, the person would get only these.
      const ranked = await search(everyone, { query, limit: 30 });
      const theirs = ranked.items.filter((hit) => hit.dataset?.id === finance);
      expect(theirs.length).toBeLessThan(limit);

      const page = await search(leader, { query, limit });
      expect(page.items).toHaveLength(limit);
      expect(page.items.map((hit) => hit.dataset?.id)).toEqual(
        Array.from({ length: limit }, () => finance),
      );
    }));

  it("fills a page by meaning alone from what the person may see", () =>
    searchable({ provider: "openai" }, async (s) => {
      const finance = s.idOf("datasets", FINANCE);
      const leader = s.as(
        person({
          powerbi_app_ids: [s.idOf("apps", "Leadership app")],
        }),
      );
      const page = await search(leader, { query: NO_WORDS, limit: 10 });
      expect(page.search_mode).toBe("hybrid");
      expect(page.items.map((hit) => [hit.match, hit.dataset?.id])).toEqual(
        Array.from({ length: 10 }, () => ["meaning", finance]),
      );
    }));

  it("caps the filtered vector scan at 20000 index tuples", () =>
    searchable({ provider: "openai" }, async (s) => {
      const member = s.as(
        person({ powerbi_workspace_ids: [s.idOf("workspaces", FINANCE)] }),
      );
      const cap = async () =>
        (
          await s.tx.execute<{ cap: string | null }>(
            sql`select current_setting('hnsw.max_scan_tuples', true) as cap`,
          )
        ).rows[0]?.cap;
      // pgvector's own default is 20000 too, so start from another value.
      await s.tx.execute(sql`set local hnsw.max_scan_tuples = 1000`);
      expect(await cap()).toBe("1000");
      const answer = await search(member, {
        query: NO_WORDS,
        kinds: ["table"],
      });
      expect(answer).toMatchObject({ search_mode: "hybrid", note: null });
      // search runs in a savepoint here, so its transaction-local setting stays readable.
      expect(await cap()).toBe("20000");
    }));

  it("walks the HNSW index past hidden near neighbours to the visible ones", () =>
    searchable({ provider: "openai" }, async (s) => {
      const member = s.as(
        person({ powerbi_workspace_ids: [s.idOf("workspaces", FINANCE)] }),
      );
      const embedder = await createEmbedder(member);
      const [vector] = (await embedder?.embed([NO_WORDS], "query")) ?? [];
      // Tables are searched by words only, so these are the only table vectors:
      // 300 hidden ones beside the query, and 3 visible ones opposite it. Each
      // is moved a little in every dimension. Moved 0.001 along one axis instead,
      // 14 builds of 280 gave a graph where a walk from this query found almost
      // nothing but those 300, and the page came back short:
      // docs/decisions/search.md.
      const seed = (
        dataset: string,
        count: number,
        sign: number,
        name: string,
      ) =>
        s.tx.execute(sql`
          insert into search_document (id, kind, element_id, dataset_ids, name, label, search_text, embedding, embedding_model)
          select 'table:' || md5(${name} || g)::uuid, 'table', md5(${name} || g)::uuid,
            array[${dataset}::uuid], ${name} || g, ${name} || g, 'seeded',
            (select array_agg(${sign} * x + 0.0088 * hashtext(${name} || g || ':' || at) / 2147483648.0 order by at)
              from unnest(${JSON.stringify(vector)}::vector::real[]) with ordinality as u(x, at))::vector,
            ${embedder?.model ?? ""}
          from generate_series(1, ${count}) g`);
      await setRole(s.tx, "worker_rw");
      await seed(s.idOf("datasets", SALES), 300, 1, "Sample hidden ");
      await seed(s.idOf("datasets", FINANCE), 3, -1, "Sample far ");
      await setRole(s.tx, "api_rw");
      // As on a large book: the planner takes the index, not a scan and sort.
      await s.tx.execute(sql`set local enable_seqscan = off`);
      const scans = async () =>
        (
          await s.tx.execute<{ n: number }>(
            sql`select pg_stat_get_xact_numscans('search_document_embedding_idx'::regclass)::int as n`,
          )
        ).rows[0]?.n ?? 0;
      const before = await scans();
      // Without the iterative scan the index stops at ef_search candidates,
      // every one hidden, and the page is empty.
      const answer = await search(member, {
        query: NO_WORDS,
        kinds: ["table"],
        limit: 50,
      });
      // These words match nothing, so a failed embedding would also answer an empty page.
      expect(answer).toMatchObject({ search_mode: "hybrid", note: null });
      expect(
        answer.items.map((hit) => `${hit.name}: ${hit.match}`).sort(),
      ).toEqual([
        "Sample far 1: meaning",
        "Sample far 2: meaning",
        "Sample far 3: meaning",
      ]);
      expect(await scans()).toBeGreaterThan(before);
      // The control: a scan that stops at hnsw.ef_search, which search sets to 100
      // for this transaction, reaches no visible row, so the walk is what found
      // them. At most 100 rows shows it did stop there: a plan that sorts instead
      // answers every seeded row.
      await s.tx.execute(sql`set local hnsw.iterative_scan = off`);
      const { rows: stopped } = await s.tx.execute<{ name: string }>(
        sql`select name from search_document order by embedding <=> ${JSON.stringify(vector)}::vector limit 1000`,
      );
      expect(stopped.length).toBeGreaterThan(0);
      expect(stopped.length).toBeLessThanOrEqual(100);
      expect(
        stopped.filter((row) => row.name.startsWith("Sample far")),
      ).toEqual([]);
    }));

  it("does not find a metric whose only live variant is in a dataset the caller cannot describe", () =>
    searchable({ provider: "openai" }, async (s) => {
      // Gross margin is drafted from Finance alone. Give it a second variant,
      // over a Sales measure the sync has since seen removed.
      const [gross] = await s.tx
        .select({ id: metric.id })
        .from(metric)
        .where(eq(metric.name, "gross_margin"));
      await setRole(s.tx, "worker_rw");
      const [table] = await s.tx
        .select({ id: powerbiMeasure.table_id })
        .from(powerbiMeasure)
        .where(
          eq(
            powerbiMeasure.id,
            s.sample.measureId({ dataset: SALES, measure: "Orders" }),
          ),
        );
      const [gone] = await s.tx
        .insert(powerbiMeasure)
        .values({
          dataset_id: s.idOf("datasets", SALES),
          table_id: table?.id ?? "",
          name: "Sample margin, retired",
          expression: "0",
          removed_at: new Date(),
        })
        .returning({ id: powerbiMeasure.id });
      await s.tx.insert(metricVariant).values({
        metric_id: gross?.id ?? "",
        measure_id: gone?.id ?? "",
        assigned_by: "curator",
      });
      await aliased(s, "gross_margin", "Sample margin kept");

      const salesMember = s.as(
        person({ powerbi_workspace_ids: [s.idOf("workspaces", SALES)] }),
      );
      const financeMember = s.as(
        person({ powerbi_workspace_ids: [s.idOf("workspaces", FINANCE)] }),
      );
      for (const query of [
        "Sample margin kept",
        "gross_margin",
        "gross margin",
      ])
        expect(
          ids(await search(salesMember, { query, limit: 50 })),
        ).not.toContain(gross?.id);
      expect(
        (await search(financeMember, { query: "Sample margin kept" })).items[0],
      ).toMatchObject({ id: gross?.id, match: "exact" });

      // Its Finance variants go before the worker builds the documents again,
      // which still name Finance: the metric is checked as it is now.
      await setRole(s.tx, "worker_rw");
      await s.tx
        .delete(metricVariant)
        .where(
          and(
            eq(metricVariant.metric_id, gross?.id ?? ""),
            ne(metricVariant.measure_id, gone?.id ?? ""),
          ),
        );
      await setRole(s.tx, "api_rw");
      for (const query of ["Sample margin kept", "gross margin"])
        expect(
          ids(await search(financeMember, { query, limit: 50 })),
        ).not.toContain(gross?.id);
    }));

  it("hides a metric filed into a hidden dataset after its document was built", () =>
    searchable({ provider: "openai" }, async (s) => {
      // A curator's metric with no variant yet is everyone's, as the book shows it.
      const [made] = await s.tx
        .insert(metric)
        .values({
          name: "sample_basket_size",
          label: "Sample basket size",
          definition: "Sample units per order.",
          origin: "curator",
        })
        .returning({ id: metric.id });
      await s.index();
      const query = { query: "Sample basket size", kinds: ["metric" as const] };
      const outsider = s.as(person());
      expect(ids(await search(outsider, query))).toEqual([made?.id]);

      // A variant on a live Sales measure, before the embed job runs again.
      await setRole(s.tx, "worker_rw");
      const orders = s.sample.measureId({ dataset: SALES, measure: "Orders" });
      const [table] = await s.tx
        .select({ id: powerbiMeasure.table_id })
        .from(powerbiMeasure)
        .where(eq(powerbiMeasure.id, orders));
      const [basket] = await s.tx
        .insert(powerbiMeasure)
        .values({
          dataset_id: s.idOf("datasets", SALES),
          table_id: table?.id ?? "",
          name: "Sample basket size",
          expression: "1",
        })
        .returning({ id: powerbiMeasure.id });
      await s.tx.insert(metricVariant).values({
        metric_id: made?.id ?? "",
        measure_id: basket?.id ?? "",
        assigned_by: "curator",
      });
      await setRole(s.tx, "api_rw");
      expect(ids(await search(outsider, query))).toEqual([]);
      const member = s.as(
        person({ powerbi_workspace_ids: [s.idOf("workspaces", SALES)] }),
      );
      expect(ids(await search(member, query))[0]).toBe(made?.id);
    }));

  it("answers a filter naming a hidden app, dataset or workspace as one naming nothing", () =>
    searchable({ provider: "openai" }, async (s) => {
      const sales = s.idOf("datasets", SALES);
      // Reaches the Sales dataset by a direct share: not its app, not Finance.
      const shared = s.as(person({ powerbi_dataset_ids: [sales] }));
      const app = s.sample.tenant.apps.find(
        (found) => found.name === "Sales app",
      );
      const filters = {
        app: [app?.name ?? "", app?.id ?? ""],
        dataset: [FINANCE, s.idOf("datasets", FINANCE)],
        workspace: [FINANCE, s.idOf("workspaces", FINANCE)],
      };
      for (const [filter, names] of Object.entries(filters))
        for (const name of [...names, "Nothing", randomUUID()])
          expect(
            await search(shared, { query: "sales", limit: 50, [filter]: name }),
          ).toEqual({
            items: [],
            counts: {},
            search_id: null,
            search_mode: "hybrid",
            note: null,
          });
      // The share itself is a dataset the filter finds.
      expect(
        (await search(shared, { query: "sales", dataset: sales })).items.length,
      ).toBeGreaterThan(0);
    }));

  it("gives a service account nothing from a dataset shared with it directly", () =>
    searchable({ provider: "openai" }, async (s) => {
      await aliased(s, "units_sold", "Sample pieces shipped");
      const held = await inSomeDataset(s);
      const shared = s.as(
        serviceAccount({ powerbi_dataset_ids: [s.idOf("datasets", SALES)] }),
      );
      for (const query of ["Sample pieces shipped", "sales"]) {
        const answer = await search(shared, { query, limit: 50 });
        expect(ids(answer).filter((id) => held.has(id))).toEqual([]);
      }
    }));

  it("filters a document by its dataset as it is now, not as the worker copied it", () =>
    searchable({ provider: "openai" }, async (s) => {
      await aliased(s, "units_sold", "Sample pieces shipped");
      const sales = s.idOf("datasets", SALES);
      const retail = s.idOf("datasets", "Retail");
      const salesApp = s.idOf("apps", "Sales app");
      const query = { query: "Sample pieces shipped", limit: 50 };
      const member = s.as(
        person({ powerbi_workspace_ids: [s.idOf("workspaces", SALES)] }),
      );
      const granted = s.as(serviceAccount({ powerbi_app_ids: [salesApp] }));
      const found = { kind: "metric", name: "units_sold", match: "exact" };
      const [hit] = (await search(member, query)).items;
      expect(hit).toMatchObject(found);
      expect((await search(granted, query)).items[0]).toMatchObject(found);
      const held = await inSomeDataset(s);
      for (const id of await inDataset(s, retail)) held.delete(id);
      // Retail stays reachable, so its documents are left out; the metric this
      // test is about must still be held through Sales.
      expect(held.has(hit?.id ?? "")).toBe(true);
      const reached = async (context: typeof member) =>
        ids(await search(context, query)).filter((id) => held.has(id));

      // The app stops showing Sales; the documents still name the app.
      await setRole(s.tx, "worker_rw");
      await s.tx
        .delete(powerbiAppDataset)
        .where(
          and(
            eq(powerbiAppDataset.app_id, salesApp),
            eq(powerbiAppDataset.dataset_id, sales),
          ),
        );
      await setRole(s.tx, "api_rw");
      const copied = await s.tx.execute<{ n: number }>(
        sql`select count(*)::int as n from search_document where ${salesApp}::uuid = any(app_ids)`,
      );
      expect(copied.rows[0]?.n).toBeGreaterThan(0);
      expect(await reached(granted)).toEqual([]);
      expect((await search(member, query)).items[0]).toMatchObject(found);

      // Power BI removes the dataset; the documents still name it.
      await setRole(s.tx, "worker_rw");
      await s.tx
        .update(powerbiDataset)
        .set({ removed_at: new Date() })
        .where(eq(powerbiDataset.id, sales));
      await setRole(s.tx, "api_rw");
      expect(await reached(member)).toEqual([]);
    }));

  it("follows a deployment policy's attribute as it is now", () =>
    searchable(
      { provider: "openai", mode: "policy", policies: "override" },
      async (s) => {
        // The override policy opens certified datasets to everyone signed in.
        const finance = s.idOf("datasets", FINANCE);
        const certify = async (endorsement: string | null) => {
          await setRole(s.tx, "worker_rw");
          await s.tx
            .update(powerbiDataset)
            .set({ endorsement })
            .where(eq(powerbiDataset.id, finance));
          await setRole(s.tx, "api_rw");
        };
        await aliased(s, "gross_margin", "Sample margin kept");
        const anyone = s.as(person());
        const query = { query: "Sample margin kept" };
        expect(ids(await search(anyone, query))).toEqual([]);
        await certify("Certified");
        expect((await search(anyone, query)).items[0]).toMatchObject({
          name: "gross_margin",
          dataset: { id: finance },
        });
        await certify(null);
        expect(ids(await search(anyone, query))).toEqual([]);
      },
    ));

  it("names in a path only datasets and workspaces the caller may see", () =>
    searchable({ provider: "openai" }, async (s) => {
      const { rows: datasets } = await s.tx.execute<{
        id: string;
        workspace_id: string;
      }>(sql`select id, workspace_id from powerbi_dataset`);
      const workspaceOf = new Map(datasets.map((d) => [d.id, d.workspace_id]));
      const salesWorkspace = s.idOf("workspaces", SALES);
      const callers = [
        { principal: person(), datasets: [] as string[] },
        {
          principal: person({
            powerbi_app_ids: [s.idOf("apps", "Leadership app")],
          }),
          datasets: [s.idOf("datasets", FINANCE)],
        },
        {
          principal: person({ powerbi_workspace_ids: [salesWorkspace] }),
          datasets: datasets
            .filter((d) => d.workspace_id === salesWorkspace)
            .map((d) => d.id),
        },
      ];
      for (const { principal, datasets: seen } of callers) {
        const shown = new Set([
          ...seen,
          ...seen.map((id) => workspaceOf.get(id)),
        ]);
        const named = new Set<string>();
        for (const query of ["sales", "gross margin", "date", NO_WORDS])
          for (const kind of ["measure", "column", "table", "dataset"] as const)
            for (const hit of (
              await search(s.as(principal), { query, kinds: [kind], limit: 50 })
            ).items)
              for (const step of hit.path)
                if (step.kind === "dataset" || step.kind === "workspace")
                  named.add(step.id);
        expect([...named].filter((id) => !shown.has(id))).toEqual([]);
        // Each caller who may see a dataset is shown it in a path.
        expect(named.size > 0).toBe(seen.length > 0);
      }
    }));

  it("gives a variant or column in a hidden dataset no path, even when its document names a seen one", () =>
    searchable({ provider: "none" }, async (s) => {
      const sales = s.idOf("datasets", SALES);
      const finance = s.idOf("datasets", FINANCE);
      const { rows } = await s.tx.execute<{
        id: string;
        kind: "variant" | "column";
        name: string;
      }>(
        sql`select distinct on (kind) id, kind, name from search_document
          where kind in ('variant', 'column') and ${finance}::uuid = any(dataset_ids)
          order by kind, id`,
      );
      expect(rows.map((row) => row.kind)).toEqual(["column", "variant"]);
      // The worker's copy is stale: it says Sales, and the element is in Finance.
      await setRole(s.tx, "worker_rw");
      for (const row of rows)
        await s.tx.execute(
          sql`update search_document set dataset_ids = array[${sales}::uuid] where id = ${row.id}`,
        );
      await setRole(s.tx, "api_rw");
      const member = s.as(
        person({ powerbi_workspace_ids: [s.idOf("workspaces", SALES)] }),
      );
      for (const row of rows) {
        const { items } = await search(member, {
          query: row.name,
          kinds: [row.kind === "variant" ? "measure" : "column"],
          limit: 50,
        });
        const hit = items.find((item) => `${item.kind}:${item.id}` === row.id);
        expect(hit).toMatchObject({ kind: row.kind, path: [] });
      }
    }));

  it("counts no document the caller may not see", () =>
    searchable({ provider: "none" }, async (s) => {
      const everyone = s.as(
        person({
          powerbi_workspace_ids: s.sample.tenant.workspaces.map((w) => w.id),
        }),
      );
      const callers = [
        s.as(person()),
        s.as(person({ powerbi_app_ids: [s.idOf("apps", "Leadership app")] })),
      ];
      for (const query of ["sales", "gross margin", "date"]) {
        const all = await search(everyone, { query, limit: 50 });
        expect(all.counts.variant ?? all.counts.column ?? 0).toBeGreaterThan(0);
        for (const context of callers) {
          const answer = await search(context, { query, limit: 50 });
          // Every hit fits on the page, so the counts are the page's.
          expect(answer.items.length).toBeLessThan(50);
          const tally: Record<string, number> = {};
          for (const hit of answer.items)
            tally[hit.kind] = (tally[hit.kind] ?? 0) + 1;
          expect(answer.counts).toEqual(tally);
        }
      }
    }));

  it("counts no document the caller may not see, past the pool", () =>
    searchable({ provider: "none" }, async (s) => {
      await setRole(s.tx, "worker_rw");
      await s.tx.update(powerbiColumn).set({ description_pbi: "zebra" });
      await setRole(s.tx, "api_rw");
      await s.index();
      const sales = s.idOf("workspaces", SALES);
      const inSales = (
        await s.tx.execute<{ n: number }>(
          sql`select count(*)::int as n from search_document
            where kind = 'column' and search_tsv @@ to_tsquery('simple', 'zebra')
              and dataset_ids && array(
                select id from powerbi_dataset where workspace_id = ${sales})`,
        )
      ).rows[0]?.n;
      // Past the words and likeness pools together, so a count that left
      // the caller's filter out of either pool's source would show here.
      expect(inSales).toBeGreaterThan(60);
      const everyone = await search(
        s.as(
          person({
            powerbi_workspace_ids: s.sample.tenant.workspaces.map((w) => w.id),
          }),
        ),
        { query: "zebra" },
      );
      const member = await search(
        s.as(person({ powerbi_workspace_ids: [sales] })),
        { query: "zebra" },
      );
      expect(member.counts.column).toBe(inSales);
      expect(member.counts.column).toBeLessThan(everyone.counts.column ?? 0);
    }));
});
