import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { GuardedFetcher } from "../../context.js";
import { category, metric, term } from "../../db/schema/book.js";
import {
  powerbiApp,
  powerbiColumn,
  powerbiDataset,
  powerbiMeasure,
} from "../../db/schema/mirror.js";
import { ServiceError } from "../../errors.js";
import { createLogger } from "../../log.js";
import { setRole } from "../../../test/sample-mirror.js";
import { MemorySecrets, refusingFetcher } from "../../../test/doubles.js";
import { scripted } from "../../../test/embedding-support.js";
import {
  person,
  type Searchable,
  searchable,
  useSearchable,
} from "../../../test/search-support.js";
import { countRequest } from "../rate-limit.js";
import {
  EMBEDDING_FAILED_NOTE,
  type PathStep,
  prefixQuery,
  search,
  SEARCH_RATE,
  type SearchHit,
  type SearchInput,
  WORDS_ONLY_NOTE,
} from "./query.js";

useSearchable();

const SALES = "Sales";

/** A viewer who reaches every workspace of the sample. */
const everywhere = (s: Searchable) =>
  person({
    powerbi_workspace_ids: s.sample.tenant.workspaces.map((w) => w.id),
  });

/** How many queries were sent to the provider. */
const queriesEmbedded = async (s: Searchable) =>
  (
    await s.tx.execute<{ n: number }>(
      sql`select count(*)::int as n from embedding_usage where purpose = 'query'`,
    )
  ).rows[0]?.n;

describe("search", () => {
  it("finds a metric by its alias first, in any case", () =>
    searchable({ provider: "openai" }, async (s) => {
      await s.tx
        .update(metric)
        .set({ aliases: ["Sample turnover"] })
        .where(eq(metric.name, "net_sales"));
      await s.index();
      const answer = await search(s.as(everywhere(s)), {
        query: " sample  TURNOVER ",
      });
      expect(answer).toMatchObject({ search_mode: "hybrid", note: null });
      expect(answer.items).toHaveLength(10);
      // In three datasets, so no one dataset names it.
      expect(answer.items[0]).toMatchObject({
        kind: "metric",
        name: "net_sales",
        label: "Net sales",
        match: "exact",
        dataset: null,
      });
      expect(answer.items.filter((hit) => hit.match === "exact")).toHaveLength(
        1,
      );
      expect(await queriesEmbedded(s)).toBe(1);
    }));

  it("finds a measure by a word in its description", () =>
    searchable({ provider: "openai" }, async (s) => {
      await s.tx
        .update(powerbiMeasure)
        .set({ description: "Counts the sample parcels that left the store." })
        .where(
          eq(
            powerbiMeasure.id,
            s.sample.measureId({ dataset: SALES, measure: "Units sold" }),
          ),
        );
      await s.index();
      const answer = await search(s.as(everywhere(s)), {
        query: "parcels",
        kinds: ["measure"],
      });
      expect(answer.items.every((hit) => hit.kind === "variant")).toBe(true);
      expect(answer.items.filter((hit) => hit.match === "words")).toMatchObject(
        [
          {
            kind: "variant",
            name: "Units sold",
            dataset: { kind: "dataset", id: s.idOf("datasets", SALES) },
          },
        ],
      );
    }));

  it("keeps to the datasets an app shows", () =>
    searchable({ provider: "openai" }, async (s) => {
      const sales = s.idOf("datasets", SALES);
      const answer = await search(s.as(everywhere(s)), {
        query: "net sales",
        app: "Sales app",
        limit: 50,
      });
      expect(answer.items).toHaveLength(50);
      expect(new Set(answer.items.map((hit) => hit.dataset?.id))).toEqual(
        new Set([sales, s.idOf("datasets", "Retail")]),
      );
      // A metric in several datasets is named by the one the filter keeps.
      const netSales = answer.items.find((hit) => hit.name === "net_sales");
      expect(netSales?.dataset).toMatchObject({ id: sales, name: SALES });

      // A removed app shows nothing, as a missing one.
      await setRole(s.tx, "worker_rw");
      await s.tx
        .update(powerbiApp)
        .set({ removed_at: new Date() })
        .where(eq(powerbiApp.name, "Sales app"));
      await setRole(s.tx, "api_rw");
      const removed = await search(s.as(everywhere(s)), {
        query: "net sales",
        app: "Sales app",
      });
      expect(removed.items).toEqual([]);
    }));

  it("matches a custom field as text", () =>
    searchable({ provider: "none" }, async (s) => {
      await s.tx
        .update(powerbiDataset)
        .set({ custom: { tier: "gold" } })
        .where(eq(powerbiDataset.id, s.idOf("datasets", SALES)));
      await s.index();
      const answer = await search(s.as(everywhere(s)), {
        query: "sales",
        custom: { tier: "gold" },
      });
      expect(answer.items).toMatchObject([{ kind: "dataset", name: SALES }]);
    }));

  it("searches by words alone with no provider, and says so", () =>
    searchable({ provider: "none" }, async (s) => {
      const answer = await search(s.as(everywhere(s)), { query: "net sales" });
      expect(answer).toMatchObject({
        search_mode: "words_only",
        note: WORDS_ONLY_NOTE,
      });
      expect(answer.items).toHaveLength(10);
      expect(answer.items[0]?.match).toBe("exact");
      expect(answer.items.some((hit) => hit.match === "meaning")).toBe(false);
      expect(await queriesEmbedded(s)).toBe(0);
    }));

  it("falls back to words with a fixed sentence when the query is not embedded", () =>
    searchable({ provider: "openai" }, async (s) => {
      const keyless = s.as(everywhere(s), { secrets: new MemorySecrets([]) });
      const answer = await search(keyless, { query: "net sales" });
      expect(answer).toMatchObject({
        search_mode: "words_only",
        note: EMBEDDING_FAILED_NOTE,
      });
      expect(answer.items.some((hit) => hit.match === "meaning")).toBe(false);
    }));

  it("falls back to words, quoting nothing of the provider, when the provider times out or limits", () =>
    searchable({ provider: "openai" }, async (s) => {
      const limits: unknown[] = [];
      const timingOut: GuardedFetcher = {
        ...refusingFetcher,
        fetchFixed(url, init) {
          limits.push(init?.timeout_ms);
          // The guarded fetcher's own sentence, naming the provider's origin.
          throw new ServiceError(
            "upstream",
            `${new URL(url).origin} did not answer within 5 seconds, so the request was stopped.`,
          );
        },
      };
      const limiting = scripted(
        new Response(null, { status: 429, headers: { "retry-after": "60" } }),
      );
      for (const fetcher of [timingOut, limiting.fetcher]) {
        const answer = await search(s.as(everywhere(s), { fetcher }), {
          query: "net sales",
        });
        expect(answer).toMatchObject({
          search_mode: "words_only",
          note: EMBEDDING_FAILED_NOTE,
        });
        expect(answer.items.length).toBeGreaterThan(0);
        expect(JSON.stringify(answer)).not.toMatch(/http|openai|seconds/i);
      }
      expect(limits).toEqual([5_000]);
      expect(limiting.calls()).toBe(1);
    }));

  it("cuts a summary at 240 characters, and a page at 50", () =>
    searchable({ provider: "none" }, async (s) => {
      await s.tx
        .update(powerbiDataset)
        .set({ description: "Sample orders. ".repeat(40) })
        .where(eq(powerbiDataset.id, s.idOf("datasets", SALES)));
      await s.index();
      const context = s.as(everywhere(s));
      const dataset = (await search(context, { query: SALES })).items.find(
        (item) => item.kind === "dataset",
      );
      expect(dataset).toMatchObject({ match: "exact" });
      expect(dataset?.summary).toHaveLength(240);
      const many = await search(context, { query: "sales", limit: 50 });
      expect(many.items).toHaveLength(50);
    }));

  it("answers invalid input as invalid, never with a database error", () =>
    searchable({ provider: "none" }, async (s) => {
      const context = s.as(everywhere(s));
      const custom = (n: number) =>
        Object.fromEntries(
          Array.from({ length: n }, (_, at) => [`k${String(at)}`, "v"]),
        );
      const inputs: unknown[] = [
        { query: "  " },
        { query: "a".repeat(501) },
        { query: "sales\0" },
        ...[0, 51, 2.5, Number.NaN, Number.POSITIVE_INFINITY].map((limit) => ({
          query: "sales",
          limit,
        })),
        { query: "sales", custom: custom(17) },
        { query: "sales", custom: { "Not a key": "v" } },
        { query: "sales", custom: { ["k".repeat(65)]: "v" } },
        { query: "sales", custom: { tier: "v".repeat(201) } },
        { query: "sales", kinds: ["measures"] },
        { query: "sales", trust_states: ["trusted"] },
      ];
      for (const input of inputs)
        await expect(
          search(context, input as SearchInput),
        ).rejects.toMatchObject({ kind: "invalid" });
      expect(
        (await search(context, { query: "sales", custom: custom(16) })).items,
      ).toEqual([]);
    }));

  it("refuses a principal's searches past the rate before embedding, not another's", () =>
    searchable({ provider: "openai" }, async (s) => {
      const principal = everywhere(s);
      let fetches = 0;
      const counting: GuardedFetcher = {
        ...refusingFetcher,
        fetchFixed() {
          fetches += 1;
          return Promise.reject(new Error("no fetch was expected"));
        },
      };
      // The limit counts in fixed windows on the clock minute, so the search
      // must fall in the same one as the counts before it to be refused.
      let at = new Date(Math.floor(Date.now() / 60_000) * 60_000);
      const context = s.as(principal, { fetcher: counting, clock: () => at });
      for (let n = 0; n < SEARCH_RATE.max; n += 1)
        await countRequest(
          s.tx,
          `search:${principal.kind}:${principal.id}`,
          SEARCH_RATE,
          context.clock(),
        );
      at = new Date(at.getTime() + 59_000);
      await expect(search(context, { query: "sales" })).rejects.toMatchObject({
        kind: "rate_limited",
      });
      expect(fetches).toBe(0);
      const other = s.as({ ...principal, id: "another-person" });
      expect(await search(other, { query: "sales" })).toMatchObject({
        search_mode: "hybrid",
        items: { length: 10 },
      });
    }));

  it("counts a demo search against its client address, every visitor being the one demo person", () =>
    searchable({ provider: "none" }, async (s) => {
      const principal = everywhere(s);
      const at = new Date(Math.floor(Date.now() / 60_000) * 60_000);
      const base = s.as(principal, { clock: () => at });
      const visitor = (client_address: string | null) => ({
        ...base,
        config: { ...base.config, demo_mode: true },
        client_address,
      });
      for (let n = 0; n < SEARCH_RATE.max; n += 1)
        await countRequest(
          s.tx,
          "search:demo:198.51.100.7",
          SEARCH_RATE,
          base.clock(),
        );
      await expect(
        search(visitor("198.51.100.7"), { query: "sales" }),
      ).rejects.toMatchObject({ kind: "rate_limited" });
      expect(
        await search(visitor("198.51.100.8"), { query: "sales" }),
      ).toMatchObject({ search_mode: "words_only" });
      // An IPv6 visitor counts as its /64, so rotating through it buys nothing.
      for (let n = 0; n < SEARCH_RATE.max; n += 1)
        await countRequest(
          s.tx,
          "search:demo:2001:0db8:0001:0002::/64",
          SEARCH_RATE,
          base.clock(),
        );
      await expect(
        search(visitor("2001:db8:1:2::abcd"), { query: "sales" }),
      ).rejects.toMatchObject({ kind: "rate_limited" });
      expect(
        await search(visitor("2001:db8:1:3::1"), { query: "sales" }),
      ).toMatchObject({ search_mode: "words_only" });
      // The principal's own allowance is untouched, as outside demo mode.
      expect(await search(base, { query: "sales" })).toMatchObject({
        search_mode: "words_only",
      });
      await expect(
        search(visitor(null), { query: "sales" }),
      ).rejects.toMatchObject({ kind: "refused" });
    }));

  it("answers a search past its statement timeout as upstream, not as a database error", () =>
    searchable({ provider: "openai" }, async (s) => {
      const context = s.as(everywhere(s));
      await expect(
        search(context, { query: "net sales" }, { statement_timeout_ms: 1 }),
      ).rejects.toEqual(
        new ServiceError(
          "upstream",
          "The search took too long and was stopped. Narrow it with a filter, or try again.",
        ),
      );
      // The timeout ended with the search, and the transaction goes on.
      expect(
        (await search(context, { query: "net sales" })).items,
      ).toHaveLength(10);
    }));

  it("answers by words when the key cannot be sent, and logs nothing of it", () =>
    searchable({ provider: "openai" }, async (s) => {
      const key = "sk-test-not-real-0123456789\nX-Injected: 1";
      const lines: string[] = [];
      const answer = await search(
        s.as(everywhere(s), {
          secrets: new MemorySecrets([["openai_api_key", key]]),
          logger: createLogger("debug", (line) => lines.push(line)),
        }),
        { query: "net sales" },
      );
      expect(answer).toMatchObject({
        search_mode: "words_only",
        note: EMBEDDING_FAILED_NOTE,
      });
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.join("\n")).not.toContain("0123456789");
    }));
});

/** Gives each metric a definition and a trust state, and indexes again. */
async function described(
  s: Searchable,
  set: Record<string, [string, NonNullable<SearchHit["trust_state"]>?]>,
) {
  for (const [name, [definition, trust_state = "draft"]] of Object.entries(set))
    await s.tx
      .update(metric)
      .set({ definition, trust_state })
      .where(eq(metric.name, name));
  await s.index();
}

describe("search ranking", () => {
  it("builds the words query from words alone, the last a prefix from 2 characters", () => {
    expect(prefixQuery("net sal")).toBe("'net' & 'sal':*");
    expect(prefixQuery("Gross m")).toBe("'gross' & 'm'");
    expect(prefixQuery(`'a':* | !(b) & "c's" \\ <-> dd`)).toBe(
      "'a' & 'b' & 'c' & 's' & 'dd':*",
    );
    expect(prefixQuery("Ørsted_nét")).toBe("'ørsted' & 'nét':*");
    expect(prefixQuery("%% -- !!")).toBeNull();
  });

  it("finds a metric by the first letters of its name, and by its name with a letter dropped", () =>
    searchable({ provider: "none" }, async (s) => {
      const context = s.as(everywhere(s));
      const kinds: SearchInput["kinds"] = ["metric"];
      const { items } = await search(context, { query: "gro", kinds });
      expect(items).toContainEqual(
        expect.objectContaining({ name: "gross_margin", match: "words" }),
      );
      // No word of the query is in the metric: only its likeness finds it.
      expect(
        (await search(context, { query: "gross_margn", kinds })).items[0],
      ).toMatchObject({ name: "gross_margin", match: "words" });
      // A query in tsquery's own syntax is read as words.
      for (const query of ["':* | !(", "\\", "net & | sal:*", "%%"])
        expect((await search(context, { query })).items).toBeInstanceOf(Array);
    }));

  it("lifts an agent verified metric past the drafts ranked above it by words", () =>
    searchable({ provider: "none" }, async (s) => {
      const context = s.as(everywhere(s));
      const query: SearchInput = { query: "quokka", kinds: ["metric"] };
      await described(s, {
        net_sales: ["Sample quokka quokka quokka."],
        units_sold: ["Sample quokka quokka."],
        gross_margin: ["Sample quokka."],
      });
      const names = async () =>
        (await search(context, query)).items.map((hit) => hit.name);
      expect(await names()).toEqual([
        "net_sales",
        "units_sold",
        "gross_margin",
      ]);
      await described(s, {
        gross_margin: ["Sample quokka.", "agent_verified"],
      });
      expect(await names()).toEqual([
        "gross_margin",
        "net_sales",
        "units_sold",
      ]);
    }));

  it("keeps an exact draft above a human verified hit by words", () =>
    searchable({ provider: "none" }, async (s) => {
      await s.tx
        .update(metric)
        .set({ aliases: ["Sample turnover"] })
        .where(eq(metric.name, "net_sales"));
      await described(s, {
        units_sold: ["Sample turnover by the piece.", "human_verified"],
      });
      const { items } = await search(s.as(everywhere(s)), {
        query: "sample turnover",
        kinds: ["metric"],
      });
      expect(items.slice(0, 2)).toMatchObject([
        { name: "net_sales", match: "exact", trust_state: "draft" },
        { name: "units_sold", match: "words", trust_state: "human_verified" },
      ]);
    }));

  it("counts the hits of each kind, past the page", () =>
    searchable({ provider: "none" }, async (s) => {
      const context = s.as(everywhere(s));
      const all = await search(context, { query: "gross margin", limit: 50 });
      expect(all.items.length).toBeGreaterThan(1);
      expect(all.items.length).toBeLessThan(50);
      const tally: Record<string, number> = {};
      for (const hit of all.items) tally[hit.kind] = (tally[hit.kind] ?? 0) + 1;
      expect(all.counts).toEqual(tally);
      const page = await search(context, { query: "gross margin", limit: 1 });
      expect(page).toMatchObject({ items: { length: 1 }, counts: tally });
      expect(await search(context, { query: "zqxv frumious" })).toMatchObject({
        items: [],
        counts: {},
      });
    }));
  it("counts a kind in full when another kind fills the words pool", () =>
    searchable({ provider: "none" }, async (s) => {
      const context = s.as(everywhere(s));
      await setRole(s.tx, "worker_rw");
      await s.tx.update(powerbiColumn).set({ description_pbi: "zebra" });
      await setRole(s.tx, "api_rw");
      await described(s, {
        net_sales: ["Sample zebra."],
        units_sold: ["Sample zebra."],
      });
      const all = await search(context, { query: "zebra", limit: 50 });
      expect(all.counts.column).toBeGreaterThanOrEqual(30);
      const metrics = await search(context, {
        query: "zebra",
        kinds: ["metric"],
        limit: 50,
      });
      expect(metrics.items.length).toBeGreaterThan(0);
      expect(all.counts.metric).toBe(metrics.items.length);
    }));

  it("counts every match of a kind, past the pool", () =>
    searchable({ provider: "none" }, async (s) => {
      await setRole(s.tx, "worker_rw");
      await s.tx.update(powerbiColumn).set({ description_pbi: "zebra" });
      await setRole(s.tx, "api_rw");
      await s.index();
      const matched = (
        await s.tx.execute<{ n: number }>(
          sql`select count(*)::int as n from search_document
            where kind = 'column' and search_tsv @@ to_tsquery('simple', 'zebra')`,
        )
      ).rows[0]?.n;
      // More than the words and likeness pools together, so a count cut at
      // either pool is caught.
      expect(matched).toBeGreaterThan(60);
      const { counts } = await search(s.as(everywhere(s)), {
        query: "zebra",
      });
      expect(counts.column).toBe(matched);
    }));

  it("leads with the metric when a metric and a measure are both exact, whatever their fused scores", () =>
    searchable({ provider: "none" }, async (s) => {
      const { items } = await search(s.as(everywhere(s)), {
        query: "net sales",
      });
      expect(items[0]).toMatchObject({ kind: "metric", name: "net_sales" });
      expect(
        items.some((hit) => hit.kind === "variant" && hit.match === "exact"),
      ).toBe(true);
    }));

  it("puts a metric before a measure of the same name on a tie", () =>
    searchable({ provider: "none" }, async (s) => {
      // A name of no words is found by no order, so both hits score alone on the exact match.
      await setRole(s.tx, "worker_rw");
      await s.tx
        .update(powerbiMeasure)
        .set({ name: "§§" })
        .where(
          eq(
            powerbiMeasure.id,
            s.sample.measureId({ dataset: SALES, measure: "Net sales" }),
          ),
        );
      await setRole(s.tx, "api_rw");
      await s.tx
        .update(metric)
        .set({ aliases: ["§§"] })
        .where(eq(metric.name, "net_sales"));
      await s.index();
      const { items } = await search(s.as(everywhere(s)), { query: "§§" });
      expect(items.map((hit) => hit.kind)).toEqual(["metric", "variant"]);
    }));
});

describe("what a hit carries", () => {
  it("places a variant, a column, a table and a dataset by what holds them", () =>
    searchable({ provider: "none" }, async (s) => {
      const measure = s.sample.measureId({
        dataset: SALES,
        measure: "Net sales",
      });
      const column = s.sample.columnId({
        dataset: SALES,
        table: "Date",
        column: "Year",
      });
      await s.tx
        .update(powerbiMeasure)
        .set({ display_folder: "Revenue\\Net ;Elsewhere\\Other" })
        .where(eq(powerbiMeasure.id, measure));
      await s.tx
        .update(powerbiColumn)
        .set({ display_folder: "Dates\\Fiscal" })
        .where(eq(powerbiColumn.id, column));
      await s.tx
        .update(powerbiDataset)
        .set({ icon: "glyph:database:blue" })
        .where(eq(powerbiDataset.id, s.idOf("datasets", SALES)));
      // Where each element sits, as a path names the levels.
      const { rows } = await s.tx.execute<Record<string, PathStep>>(sql`
        select json_build_object('kind', 'workspace', 'id', w.id, 'name', w.name) as workspace,
          json_build_object('kind', 'dataset', 'id', d.id, 'name', d.name) as dataset,
          json_build_object('kind', 'table', 'id', t.id, 'name', t.name) as table
        from (select table_id, 1 as n from powerbi_measure where id = ${measure}
          union all select table_id, 2 from powerbi_column where id = ${column}) e
        join powerbi_table t on t.id = e.table_id
        join powerbi_dataset d on d.id = t.dataset_id
        join powerbi_workspace w on w.id = d.workspace_id
        order by e.n`);
      // In the order the query names them: workspace, dataset, table.
      const [ofMeasure, ofColumn] = rows.map((row) => Object.values(row));
      const context = s.as(everywhere(s));
      const found = async (
        query: string,
        kind: NonNullable<SearchInput["kinds"]>[number],
      ) =>
        (
          await search(context, { query, kinds: [kind], dataset: SALES })
        ).items.find((hit) => hit.name === query);
      expect(await found("Net sales", "measure")).toMatchObject({
        icon: null,
        metric: { name: "net_sales", label: "Net sales" },
        path: [
          ...(ofMeasure ?? []),
          { kind: "folder", id: "Revenue", name: "Revenue" },
          { kind: "folder", id: "Revenue\\Net", name: "Net" },
        ],
      });
      expect(await found("Date[Year]", "column")).toMatchObject({
        icon: null,
        metric: null,
        path: [
          ...(ofColumn ?? []),
          { kind: "folder", id: "Dates", name: "Dates" },
          { kind: "folder", id: "Dates\\Fiscal", name: "Fiscal" },
        ],
      });
      expect(await found("Date", "table")).toMatchObject({
        icon: null,
        path: ofColumn?.slice(0, 2),
      });
      expect(await found(SALES, "dataset")).toMatchObject({
        icon: "glyph:database:blue",
        path: ofColumn?.slice(0, 1),
      });
    }));

  it("places a metric and a category by their categories, and a term nowhere", () =>
    searchable({ provider: "none" }, async (s) => {
      const [parent] = await s.tx
        .insert(category)
        .values({
          name: "Commercial",
          key: "commercial",
          icon: "glyph:folder:gray",
        })
        .returning({ id: category.id });
      const [child] = await s.tx
        .insert(category)
        .values({ name: "Revenue kept", key: "kept", parent_id: parent?.id })
        .returning({ id: category.id });
      await s.tx
        .update(metric)
        .set({ category_id: child?.id, icon: "glyph:chart-line:green" })
        .where(eq(metric.name, "net_sales"));
      await s.tx.insert(term).values({
        name: "Sample fiscal week",
        icon: "glyph:calendar:teal",
      });
      await s.index();
      const commercial = {
        kind: "category",
        id: parent?.id,
        name: "Commercial",
        key: "commercial",
      };
      const first = async (query: string) =>
        (await search(s.as(everywhere(s)), { query, limit: 1 })).items[0];
      expect(await first("net_sales")).toMatchObject({
        kind: "metric",
        icon: "glyph:chart-line:green",
        metric: null,
        path: [
          commercial,
          {
            kind: "category",
            id: child?.id,
            name: "Revenue kept",
            key: "kept",
          },
        ],
      });
      expect(await first("Revenue kept")).toMatchObject({
        kind: "category",
        key: "kept",
        icon: null,
        path: [commercial],
      });
      expect(await first("Commercial")).toMatchObject({
        key: "commercial",
        icon: "glyph:folder:gray",
        path: [],
      });
      expect(await first("Sample fiscal week")).toMatchObject({
        kind: "term",
        key: null,
        icon: "glyph:calendar:teal",
        metric: null,
        path: [],
      });
    }));

  it("stops a category's path at a cycle written into the data", () =>
    searchable({ provider: "none" }, async (s) => {
      const [parent] = await s.tx
        .insert(category)
        .values({ name: "Outer", key: "outer" })
        .returning({ id: category.id });
      const [child] = await s.tx
        .insert(category)
        .values({ name: "Inner", key: "inner", parent_id: parent?.id })
        .returning({ id: category.id });
      await s.tx
        .update(metric)
        .set({ category_id: child?.id })
        .where(eq(metric.name, "net_sales"));
      await s.index();
      // Indexing walks the tree too, so the cycle comes after it.
      // The curation service refuses this; the test writes it directly.
      await s.tx
        .update(category)
        .set({ parent_id: child?.id })
        .where(eq(category.id, parent?.id ?? ""));
      const hit = (
        await search(s.as(everywhere(s)), { query: "net_sales", limit: 1 })
      ).items[0];
      expect(hit?.path.map((step) => step.name)).toEqual(["Outer", "Inner"]);
    }));
});
