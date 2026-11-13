import { randomUUID } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { describe, expect, it } from "vitest";
import type { Db, GuardedFetcher } from "../../context.js";
import { createDb } from "../../db/client.js";
import { category, metric, term, termColumn } from "../../db/schema/book.js";
import { jobRequest } from "../../db/schema/jobs.js";
import { powerbiColumn } from "../../db/schema/mirror.js";
import { ServiceError } from "../../errors.js";
import { createLogger } from "../../log.js";
import { principals, testPool } from "../../../test/deps.js";
import { accessFrom, refusingFetcher } from "../../../test/doubles.js";
import {
  embeddingDeps,
  KEY,
  mockOrigin,
  openAiAnswer,
  scripted,
  sizeOf,
  useEmbeddingMock,
  WORDS,
} from "../../../test/embedding-support.js";
import {
  inSampleMirror,
  rolledBack,
  setRole,
} from "../../../test/sample-mirror.js";
import { removeRule, setRule } from "../pii/rules.js";
import { recordBookChange } from "../book/changes.js";
import { renameCategory } from "../book/categories.js";
import { setDocs } from "../book/docs.js";
import { updateTerm } from "../book/terms.js";
import { enqueue, enqueueUnlessQueued, take } from "../jobs/queue.js";
import { handlerFor } from "../jobs/registry.js";
import "../jobs/all.js";
import { search } from "../setup/checks.js";
import { buildDocuments } from "./documents.js";
import { RUN_BUDGET_MS, runEmbed } from "./embed-job.js";
import { costMicroUsd, createEmbedder } from "./embedder.js";

useEmbeddingMock();

const SALES = "Sales";

const count = async (tx: Db, query: ReturnType<typeof sql>) =>
  (await tx.execute<{ n: number }>(query)).rows[0]?.n;

describe("the embedders", () => {
  it("asks OpenAI for 1,536 dimensions, with the key in a header", async () => {
    await rolledBack("worker_rw", async (tx) => {
      const { deps, sent } = embeddingDeps(tx, "openai");
      const embedder = await createEmbedder(deps);
      const answer = await embedder?.embed(["alpha beta", "gamma"], "document");
      expect(answer).toHaveLength(2);
      expect(answer?.[0]).toHaveLength(1536);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        url: `${mockOrigin()}/openai/v1/embeddings`,
        headers: { authorization: `Bearer ${KEY}` },
        body: {
          model: "text-embedding-3-large",
          input: ["alpha beta", "gamma"],
          dimensions: 1536,
        },
      });
    });
  });

  it("asks Gemini for 1,536 dimensions, with a task prefix for each purpose", async () => {
    await rolledBack("worker_rw", async (tx) => {
      const { deps, sent } = embeddingDeps(tx, "gemini");
      const embedder = await createEmbedder(deps);
      await embedder?.embed(["alpha"], "query");
      await embedder?.embed(["beta"], "document");
      const request = (text: string) => ({
        model: "models/gemini-embedding-2",
        content: { parts: [{ text }] },
        outputDimensionality: 1536,
      });
      expect(sent.map((call) => call.url)).toEqual([
        `${mockOrigin()}/gemini/v1beta/models/gemini-embedding-2:batchEmbedContents`,
        `${mockOrigin()}/gemini/v1beta/models/gemini-embedding-2:batchEmbedContents`,
      ]);
      expect(sent[0]?.headers).toMatchObject({ "x-goog-api-key": KEY });
      expect(sent[0]?.body).toEqual({
        requests: [request("task: search result | query: alpha")],
      });
      expect(sent[1]?.body).toEqual({
        requests: [request("title: none | text: beta")],
      });
    });
  });

  it("splits OpenAI's calls at 500 texts and at 300,000 bytes, and counts each call", async () => {
    await rolledBack("worker_rw", async (tx) => {
      const { deps, sent } = embeddingDeps(tx, "openai");
      const embedder = await createEmbedder(deps);
      const many = Array.from({ length: 1200 }, (_, i) => `text ${String(i)}`);
      expect(await embedder?.embed(many, "document")).toHaveLength(1200);
      expect(sent.map(sizeOf)).toEqual([500, 500, 200]);
      sent.length = 0;
      const large = Array.from({ length: 4 }, () => "a".repeat(100_000));
      await embedder?.embed(large, "document");
      expect(sent.map(sizeOf)).toEqual([3, 1]);
      expect(
        await count(tx, sql`select count(*)::int as n from embedding_usage`),
      ).toBe(5);
    });
  });

  it("splits Gemini's calls at 100 texts", async () => {
    await rolledBack("worker_rw", async (tx) => {
      const { deps, sent } = embeddingDeps(tx, "gemini");
      const embedder = await createEmbedder(deps);
      const many = Array.from({ length: 250 }, (_, i) => `text ${String(i)}`);
      expect(await embedder?.embed(many, "document")).toHaveLength(250);
      expect(sent.map(sizeOf)).toEqual([100, 100, 50]);
    });
  });

  it("records each call's tokens and cost in integer micro-dollars", async () => {
    await rolledBack("worker_rw", async (tx) => {
      const ten = "one two three four five six seven eight nine ten";
      for (const provider of ["openai", "gemini"] as const) {
        const embedder = await createEmbedder(embeddingDeps(tx, provider).deps);
        await embedder?.embed([ten], "query");
      }
      const { rows } = await tx.execute(
        sql`select provider, model, tokens, cost_micro_usd::int as cost, purpose from embedding_usage order by provider`,
      );
      // The mock counts 13 tokens for ten words, and 20 once Gemini's prefix adds five.
      expect(rows).toEqual([
        {
          provider: "gemini",
          model: "gemini-embedding-2",
          tokens: 20,
          cost: 4,
          purpose: "query",
        },
        {
          provider: "openai",
          model: "text-embedding-3-large",
          tokens: 13,
          cost: 2,
          purpose: "query",
        },
      ]);
    });
    expect(costMicroUsd("openai", 1_000_000)).toBe(130_000);
    expect(costMicroUsd("gemini", 1_000_000)).toBe(200_000);
    expect(costMicroUsd("openai", 1)).toBe(1);
  });

  it("uses each provider's own host when search.base_url is empty", async () => {
    const urls: string[] = [];
    const fetcher: GuardedFetcher = {
      ...refusingFetcher,
      fetchFixed(url) {
        urls.push(String(url));
        return Promise.reject(new ServiceError("upstream", "stopped"));
      },
    };
    await rolledBack("worker_rw", async (tx) => {
      for (const provider of ["openai", "gemini"] as const) {
        const { deps } = embeddingDeps(tx, provider, {
          "search.base_url": null,
        });
        const embedder = await createEmbedder({ ...deps, fetcher });
        await expect(embedder?.embed(["x"], "query")).rejects.toThrow(
          "stopped",
        );
      }
    });
    expect(urls).toEqual([
      "https://api.openai.com/v1/embeddings",
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents",
    ]);
  });

  it("puts the model in Gemini's path with its odd characters encoded", async () => {
    const urls: string[] = [];
    const fetcher: GuardedFetcher = {
      ...refusingFetcher,
      fetchFixed(url) {
        urls.push(String(url));
        return Promise.reject(new ServiceError("upstream", "stopped"));
      },
    };
    await rolledBack("worker_rw", async (tx) => {
      const { deps } = embeddingDeps(tx, "gemini", {
        "search.model": "odd/model name",
      });
      const embedder = await createEmbedder({ ...deps, fetcher });
      await expect(embedder?.embed(["x"], "query")).rejects.toThrow("stopped");
    });
    expect(urls).toEqual([
      `${mockOrigin()}/gemini/v1beta/models/odd%2Fmodel%20name:batchEmbedContents`,
    ]);
  });

  it("has no embedder for none, and none without the key", async () => {
    await rolledBack("worker_rw", async (tx) => {
      expect(await createEmbedder(embeddingDeps(tx, "none").deps)).toBeNull();
      await expect(
        createEmbedder(embeddingDeps(tx, "openai", {}, []).deps),
      ).rejects.toMatchObject({ detail: { code: "key_missing" } });
    });
  });
});

/** The sample mirror's columns are all the book holds, and the only embedded kind. */
const COLUMNS = 173;

function jobHandler() {
  const registered = handlerFor("embed", "worker");
  if (registered === undefined) throw new Error("no embed job is registered");
  return registered.handler;
}

describe("the embed job", () => {
  it("embeds the same document twice with one call to the provider", async () => {
    await inSampleMirror("worker_rw", async (tx) => {
      const { deps, sent } = embeddingDeps(tx, "openai");
      await jobHandler()(deps, {}, "schedule");
      await jobHandler()(deps, {}, "schedule");
      expect(sent).toHaveLength(1);
      expect(sizeOf(sent[0])).toBe(COLUMNS);
      expect(
        await count(
          tx,
          sql`select count(*)::int as n from search_document where vector_dims(embedding) = 1536`,
        ),
      ).toBe(COLUMNS);
    });
  });

  it("embeds a changed text again and leaves an unchanged one", async () => {
    await inSampleMirror("worker_rw", async (tx, sample) => {
      const { deps, sent } = embeddingDeps(tx, "openai");
      await jobHandler()(deps, {}, "schedule");
      const column = sample.columnId({
        dataset: "Sales",
        table: "Customer",
        column: "Region",
      });
      await tx
        .update(powerbiColumn)
        .set({ description: "Sample words that were not there before." })
        .where(eq(powerbiColumn.id, column));
      await jobHandler()(deps, {}, "schedule");
      expect(sent).toHaveLength(2);
      expect(sizeOf(sent[1])).toBe(1);
      expect(sent[1]?.body.input?.[0]).toContain(
        "Sample words that were not there before.",
      );
      expect(
        await count(tx, sql`select count(*)::int as n from embedding_usage`),
      ).toBe(2);
    });
  });

  it("embeds everything again when the model or the provider changes", async () => {
    await inSampleMirror("worker_rw", async (tx) => {
      const { deps, settings, sent } = embeddingDeps(tx, "openai");
      await jobHandler()(deps, {}, "schedule");
      await settings.set("search.model", "text-embedding-3-small");
      await jobHandler()(deps, {}, "schedule");
      expect(sent[1]?.body).toMatchObject({ model: "text-embedding-3-small" });
      expect(sizeOf(sent[1])).toBe(COLUMNS);

      await settings.set("search.model", null);
      await settings.set("search.provider", "gemini");
      await settings.set("search.base_url", `${mockOrigin()}/gemini`);
      await jobHandler()(deps, {}, "schedule");
      expect(sizeOf(sent[2])).toBe(100);
      const { rows } = await tx.execute(
        sql`select distinct embedding_model from search_document where kind = 'column'`,
      );
      expect(rows).toEqual([{ embedding_model: "gemini-embedding-2" }]);
    });
  });

  it("leaves embeddings null with no provider, and still builds the documents", async () => {
    await inSampleMirror("worker_rw", async (tx) => {
      const { deps, sent } = embeddingDeps(tx, "none");
      await jobHandler()(deps, {}, "schedule");
      expect(sent).toHaveLength(0);
      expect(
        await count(
          tx,
          sql`select count(*)::int as n from search_document where embedding is null`,
        ),
      ).toBeGreaterThan(COLUMNS);
      expect(
        await count(tx, sql`select count(*)::int as n from embedding_usage`),
      ).toBe(0);
    });
  });

  it("embeds a refused batch by halves, and only the refused text has no vector", async () => {
    await inSampleMirror("worker_rw", async (tx, sample) => {
      const { deps } = embeddingDeps(tx, "openai");
      const refused = sample.columnId({
        dataset: SALES,
        table: "Customer",
        column: "Region",
      });
      await tx
        .update(powerbiColumn)
        .set({ description: "REFUSE-ME" })
        .where(eq(powerbiColumn.id, refused));
      const asked: number[] = [];
      const lines: string[] = [];
      const picky: GuardedFetcher = {
        ...refusingFetcher,
        fetchFixed(_url, init) {
          const body = JSON.parse(init?.body as string) as { input: string[] };
          asked.push(body.input.length);
          return Promise.resolve(
            body.input.some((text) => text.includes("REFUSE-ME"))
              ? new Response(WORDS, { status: 400 })
              : openAiAnswer(body.input.length),
          );
        },
      };
      const logger = createLogger("warn", (line) => lines.push(line));
      await jobHandler()({ ...deps, fetcher: picky, logger }, {}, "schedule");
      // The whole batch, the probe, then two calls for each halving: far
      // short of a call for each text.
      expect(asked[0]).toBe(COLUMNS);
      expect(asked[1]).toBe(1);
      expect(asked.length).toBeLessThanOrEqual(
        2 + 2 * Math.ceil(Math.log2(COLUMNS)),
      );
      expect(
        await count(
          tx,
          sql`select count(*)::int as n from search_document where kind = 'column' and embedding is not null`,
        ),
      ).toBe(COLUMNS - 1);
      expect(
        await count(
          tx,
          sql`select count(*)::int as n from search_document where id = ${`column:${refused}`} and embedding is null and embedding_hash is not null`,
        ),
      ).toBe(1);
      // By element id and kind, and nothing of the text or of the provider's answer.
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "")).toMatchObject({
        msg: "the provider refused a document",
        element_id: refused,
        kind: "column",
      });
      expect(lines[0]).not.toContain("REFUSE-ME");
      expect(lines[0]).not.toContain(WORDS);
    });
  });

  it("stops with the provider's refusal when the probe is refused too, and no document keeps a hash", async () => {
    await inSampleMirror("worker_rw", async (tx) => {
      const { deps } = embeddingDeps(tx, "openai");
      const asked: number[] = [];
      const nothing: GuardedFetcher = {
        ...refusingFetcher,
        fetchFixed(_url, init) {
          const body = JSON.parse(init?.body as string) as { input: string[] };
          asked.push(body.input.length);
          return Promise.resolve(new Response(WORDS, { status: 400 }));
        },
      };
      await expect(
        jobHandler()({ ...deps, fetcher: nothing }, {}, "schedule"),
      ).rejects.toMatchObject({ detail: { code: "request_refused" } });
      // The batch, then the probe, and nothing more.
      expect(asked).toEqual([COLUMNS, 1]);
      expect(
        await count(
          tx,
          sql`select count(*)::int as n from search_document where kind = 'column' and embedding_hash is not null`,
        ),
      ).toBe(0);
    });
  });

  it("leaves a lone document's hash null when its refusal is the request's, so the next run asks again", async () => {
    await inSampleMirror("worker_rw", async (tx, sample) => {
      const { deps } = embeddingDeps(tx, "openai");
      const kept = sample.columnId({
        dataset: SALES,
        table: "Customer",
        column: "Region",
      });
      await tx.delete(powerbiColumn).where(ne(powerbiColumn.id, kept));
      const wrong: GuardedFetcher = {
        ...refusingFetcher,
        fetchFixed: () => Promise.resolve(new Response(WORDS, { status: 400 })),
      };
      await expect(
        runEmbed({ ...deps, fetcher: wrong }, { changes_only: false }),
      ).rejects.toMatchObject({ detail: { code: "request_refused" } });
      const document = sql`from search_document where id = ${`column:${kept}`}`;
      expect(
        await count(
          tx,
          sql`select count(*)::int as n ${document} and embedding_hash is null`,
        ),
      ).toBe(1);
      expect(await runEmbed(deps, { changes_only: false })).toMatchObject({
        embedded: 1,
      });
      expect(
        await count(
          tx,
          sql`select count(*)::int as n ${document} and embedding is not null`,
        ),
      ).toBe(1);
    });
  });

  it("stops at its time budget with what it has stored, and queues its successor", async () => {
    await inSampleMirror("worker_rw", async (tx) => {
      await tx.execute(
        sql`insert into powerbi_column (dataset_id, table_id, name)
            select c.dataset_id, c.table_id, 'Sample extra ' || g
            from (select dataset_id, table_id from powerbi_column limit 1) c, generate_series(1, 600) g`,
      );
      const { deps } = embeddingDeps(tx, "openai");
      // The clock jumps past the budget once the provider has answered.
      let skew = 0;
      const slow = {
        ...deps,
        clock: () => new Date(Date.now() + skew),
        fetcher: {
          ...deps.fetcher,
          async fetchFixed(...call: Parameters<GuardedFetcher["fetchFixed"]>) {
            const answer = await deps.fetcher.fetchFixed(...call);
            skew = RUN_BUDGET_MS + 1;
            return answer;
          },
        },
      };
      const first = await runEmbed(slow, { changes_only: false });
      // One page of 500, then the budget is spent.
      expect(first).toMatchObject({ embedded: 500, queued_rest: true });
      expect(await queued(tx)).toEqual([{}]);
      expect(await cursor(tx)).toBeUndefined();

      skew = 0;
      const second = await runEmbed(slow, { changes_only: false });
      expect(second).toMatchObject({
        embedded: COLUMNS + 600 - 500,
        queued_rest: false,
      });
      expect(await cursor(tx)).toBe(0);
      expect(
        await count(
          tx,
          sql`select count(*)::int as n from search_document where embedding is not null`,
        ),
      ).toBe(COLUMNS + 600);
    });
  });

  it("builds the documents and then says the key is missing", async () => {
    await inSampleMirror("worker_rw", async (tx) => {
      const { deps } = embeddingDeps(tx, "openai", {}, []);
      await expect(jobHandler()(deps, {}, "schedule")).rejects.toMatchObject({
        detail: { code: "key_missing" },
      });
      expect(
        await count(tx, sql`select count(*)::int as n from search_document`),
      ).toBeGreaterThan(COLUMNS);
    });
  });
});

const queued = async (tx: Db) =>
  (
    await tx
      .select({ args: jobRequest.args })
      .from(jobRequest)
      .where(and(eq(jobRequest.job, "embed"), eq(jobRequest.status, "queued")))
  ).map((row) => row.args);
const settle = (tx: Db) =>
  tx
    .update(jobRequest)
    .set({ status: "succeeded" })
    .where(eq(jobRequest.job, "embed"));
const change = (tx: Db, element_id = randomUUID()) =>
  recordBookChange(tx, {
    principal: null,
    element_kind: "metric",
    element_id,
    action: "update",
    before: null,
    after: null,
  });
const cursor = async (tx: Db) =>
  (
    await tx.execute<{ n: number }>(
      sql`select book_change_id::int as n from search_state`,
    )
  ).rows[0]?.n;
const latestChange = async (tx: Db) =>
  (
    await tx.execute<{ n: number }>(
      sql`select max(id)::int as n from book_change`,
    )
  ).rows[0]?.n;

describe("the embed job and the book's changes", () => {
  it("queues one embed for a description, a category or a term change, and rebuilds only those documents", async () => {
    await inSampleMirror("worker_rw", async (tx, sample) => {
      const { deps, sent } = embeddingDeps(tx, "openai");
      const column = sample.columnId({
        dataset: "Sales",
        table: "Customer",
        column: "Region",
      });
      await setRole(tx, "api_rw");
      const [sales] = await tx
        .insert(category)
        .values({ name: "Sales", key: "sales" })
        .returning();
      const [region] = await tx
        .insert(term)
        .values({ name: "Region" })
        .returning();
      await tx
        .insert(termColumn)
        .values({ term_id: region?.id ?? "", column_id: column });
      await tx.insert(metric).values({
        name: "number_of_orders",
        label: "Number of orders",
        origin: "curator",
        category_id: sales?.id,
      });
      await setRole(tx, "worker_rw");
      await jobHandler()(deps, {}, "schedule");
      sent.length = 0;

      const curator = {
        ...deps,
        access: accessFrom(
          () => true,
          () => sql`true`,
        ),
        principal: principals.curator,
      };
      const curate = async (work: () => Promise<unknown>) => {
        await setRole(tx, "api_rw");
        await work();
        await setRole(tx, "worker_rw");
        expect(await queued(tx)).toEqual([{ changes_only: true }]);
        await jobHandler()(deps, { changes_only: true }, "schedule");
        await settle(tx);
      };
      const texts = () => sent.flatMap((call) => call.body.input ?? []);

      await curate(() =>
        setDocs(
          curator,
          { kind: "column", id: column },
          { description: "Sample words about the region." },
        ),
      );
      expect(texts()).toHaveLength(1);
      expect(texts()[0]).toContain("Sample words about the region.");

      sent.length = 0;
      await curate(() => renameCategory(curator, "sales", { name: "Revenue" }));
      expect(texts()).toHaveLength(1);
      expect(texts()[0]).toContain("Category: Revenue");

      sent.length = 0;
      await curate(() => updateTerm(curator, "Region", { name: "Area" }));
      // The term's own text, and the text of the column that names it.
      expect(texts()).toHaveLength(2);
      expect(texts().some((text) => text.includes("Term: Area"))).toBe(true);
    });
  });

  it("deletes a PII column's document on a scoped run and restores it when the rule is removed", async () => {
    await inSampleMirror("worker_rw", async (tx, sample) => {
      const { deps } = embeddingDeps(tx, "openai");
      const column = sample.columnId({
        dataset: SALES,
        table: "Customer",
        column: "Region",
      });
      const held = async () =>
        await count(
          tx,
          sql`select count(*)::int as n from search_document where id = ${`column:${column}`}`,
        );
      await jobHandler()(deps, {}, "schedule");
      expect(await held()).toBe(1);
      await settle(tx);

      const admin = {
        ...deps,
        access: accessFrom(
          () => true,
          () => sql`true`,
        ),
        principal: principals.admin,
      };
      await setRole(tx, "api_rw");
      const { rule } = await setRule(admin, {
        kind: "column",
        table_name: "Customer",
        name: "Region",
        pii: true,
      });
      await setRole(tx, "worker_rw");
      await jobHandler()(deps, { changes_only: true }, "schedule");
      expect(await held()).toBe(0);
      await settle(tx);

      await setRole(tx, "api_rw");
      await removeRule(admin, rule.id);
      await setRole(tx, "worker_rw");
      await jobHandler()(deps, { changes_only: true }, "schedule");
      expect(await held()).toBe(1);
    });
  });

  it("lets a scoped run embed documents that have no hash", async () => {
    await inSampleMirror("worker_rw", async (tx) => {
      const { deps, settings, sent } = embeddingDeps(tx, "none");
      await jobHandler()(deps, {}, "schedule");
      expect(sent).toHaveLength(0);
      await settings.set("search.provider", "openai");
      await settings.set("search.base_url", `${mockOrigin()}/openai`);
      await change(tx);
      await runEmbed(deps, { changes_only: true });
      expect(sent).toHaveLength(1);
      expect(sizeOf(sent[0])).toBe(COLUMNS);
    });
  });

  it("queues one embed for fifty changes in one transaction", async () => {
    await rolledBack("worker_rw", async (tx) => {
      for (let at = 0; at < 50; at++) await change(tx);
      expect(await queued(tx)).toEqual([{ changes_only: true }]);
      expect(
        await enqueueUnlessQueued(tx, {
          job: "embed",
          runner: "worker",
          trigger: "schedule",
        }),
      ).toBeNull();
    });
  });

  it("compares a change inside the lookback again, and writes nothing and calls no provider", async () => {
    await inSampleMirror("worker_rw", async (tx) => {
      const { deps, sent } = embeddingDeps(tx, "openai");
      await change(tx);
      await jobHandler()(deps, {}, "schedule");
      expect(await cursor(tx)).toBe(await latestChange(tx));
      sent.length = 0;
      // The change is still within the lookback, so it is compared again.
      expect(await runEmbed(deps, { changes_only: true })).toMatchObject({
        written: 0,
        deleted: 0,
        embedded: 0,
      });
      expect(sent).toHaveLength(0);
    });
  });

  it("returns at once, building no document, when book_change has no row in the window", async () => {
    await inSampleMirror("worker_rw", async (tx) => {
      const { deps, sent } = embeddingDeps(tx, "openai");
      await jobHandler()(deps, {}, "schedule");
      sent.length = 0;
      // A metric with no book_change: only a run that looks at the book would build it.
      const [unrecorded] = await tx
        .insert(metric)
        .values({
          name: "sample_unrecorded",
          label: "Sample unrecorded",
          origin: "curator",
        })
        .returning();
      expect(await runEmbed(deps, { changes_only: true })).toEqual({
        documents: 0,
        written: 0,
        deleted: 0,
        embedded: 0,
        queued_rest: false,
      });
      expect(sent).toHaveLength(0);
      expect(
        await count(
          tx,
          sql`select count(*)::int as n from search_document where id = ${`metric:${unrecorded?.id ?? ""}`}`,
        ),
      ).toBe(0);
      // A full run, which does not rest on book_change, builds it.
      await runEmbed(deps, { changes_only: false });
      expect(
        await count(
          tx,
          sql`select count(*)::int as n from search_document where id = ${`metric:${unrecorded?.id ?? ""}`}`,
        ),
      ).toBe(1);
    });
  });

  it("leaves the cursor where it was when a run fails", async () => {
    await inSampleMirror("worker_rw", async (tx) => {
      const { deps } = embeddingDeps(tx, "openai");
      await change(tx);
      await jobHandler()(deps, {}, "schedule");
      const before = await cursor(tx);
      await change(tx);
      const keyless = embeddingDeps(tx, "openai", {}, []).deps;
      await expect(
        runEmbed(keyless, { changes_only: true }),
      ).rejects.toMatchObject({ detail: { code: "key_missing" } });
      expect(await cursor(tx)).toBe(before);
      await runEmbed(deps, { changes_only: true });
      expect(await cursor(tx)).toBe(await latestChange(tx));
    });
  });
});

const request = { principal: null, person_id: null, host: null };

describe("the setup's search check", () => {
  it("embeds a sentence and says what the book would cost", async () => {
    await inSampleMirror("worker_rw", async (tx) => {
      const { deps, sent } = embeddingDeps(tx, "openai", {}, undefined, "api");
      await buildDocuments(tx);
      // The check runs as the api.
      await setRole(tx, "api_rw");
      const result = await search(deps, request);
      expect(result.status).toBe("passing");
      expect(sent).toHaveLength(1);
      // About four characters to a token, summed by hand over what was built.
      const { rows } = await tx.execute<{ search_text: string }>(
        sql`select search_text from search_document where kind in ('metric', 'variant', 'column', 'term')`,
      );
      const tokens = rows.reduce(
        (sum, row) => sum + Math.ceil(row.search_text.length / 4),
        0,
      );
      expect(tokens).toBeGreaterThan(0);
      expect(result.details).toEqual({
        provider: "openai",
        model: "text-embedding-3-large",
        documents: COLUMNS,
        estimated_tokens: tokens,
        cost_micro_usd: costMicroUsd("openai", tokens),
      });
      expect(result.message).toMatch(
        /^One sentence was embedded with openai text-embedding-3-large\. Embedding the book as it stands, 173 documents, would cost about \$0\.\d{4}\.$/,
      );
    });
  });

  it("answers with a fixed sentence when the provider refuses, never its words", async () => {
    await rolledBack("api_rw", async (tx) => {
      const { deps } = embeddingDeps(tx, "openai", {}, undefined, "api");
      const result = await search(
        {
          ...deps,
          fetcher: scripted(new Response(`${WORDS} ${KEY}`, { status: 401 }))
            .fetcher,
        },
        request,
      );
      expect(result).toEqual({
        status: "failing",
        message:
          "The provider refused the API key. Paste the key again, and check that it belongs to the provider you chose.",
      });
      const missing = await search(
        embeddingDeps(tx, "gemini", {}, [], "api").deps,
        request,
      );
      expect(missing.message).toBe(
        "Enter the API key of the provider you chose, then run the check again.",
      );
    });
  });
});

// Last in the file, because it commits for real: book_change and search_state
// cannot be deleted, and the tests above count on what they leave being theirs.
describe("a change that commits after a later one was read", () => {
  it("is applied by the next run, though its id is below the cursor", async () => {
    const pool = testPool("worker_rw");
    const db = createDb(pool);
    const [workspace, dataset, table, column] = [1, 2, 3, 4].map(() =>
      randomUUID(),
    );
    await pool.query(
      `with w as (insert into powerbi_workspace (id, name) values ($1, 'Race')),
            d as (insert into powerbi_dataset (id, workspace_id, name) values ($2, $1, 'Race')),
            t as (insert into powerbi_table (id, dataset_id, name) values ($3, $2, 'Race'))
       insert into powerbi_column (id, dataset_id, table_id, name) values ($4, $2, $3, 'Lap')`,
      [workspace, dataset, table, column],
    );
    const { deps, sent } = embeddingDeps(db, "openai");
    const first = await pool.connect();
    try {
      await jobHandler()(deps, {}, "schedule");
      sent.length = 0;
      // T1 writes its change first, so it has the lower id, and commits last.
      await first.query("begin");
      await first.query(
        "update powerbi_column set description = 'Sample words from T1.' where id = $1",
        [column],
      );
      await first.query(
        `insert into book_change (principal_kind, principal_id, element_kind, element_id, action)
         values ('system', 'sync', 'column', $1, 'docs')`,
        [column],
      );
      await change(db);
      await runEmbed(deps, { changes_only: true });
      expect(sent).toHaveLength(0);
      await first.query("commit");
      await runEmbed(deps, { changes_only: true });
      expect(sent).toHaveLength(1);
      expect(sent[0]?.body.input?.[0]).toContain("Sample words from T1.");
    } finally {
      first.release();
      await pool.query("delete from search_document");
      await pool.query("delete from powerbi_workspace where id = $1", [
        workspace,
      ]);
    }
  });
});

describe("a queued request that a change relied on", () => {
  it("is not taken until that change commits", async () => {
    const pool = testPool("worker_rw");
    const db = createDb(pool);
    await db
      .update(jobRequest)
      .set({ status: "succeeded" })
      .where(eq(jobRequest.job, "embed"));
    const queuedId = await enqueue(db, {
      job: "embed",
      runner: "worker",
      trigger: "schedule",
    });
    const writer = await pool.connect();
    const runner = await pool.connect();
    try {
      await writer.query("begin");
      // The change finds the request queued, and relies on it to see the change.
      const found = await enqueueUnlessQueued(drizzle({ client: writer }), {
        job: "embed",
        runner: "worker",
        trigger: "schedule",
      });
      expect(found).toBeNull();
      expect(await take(runner, "worker", ["embed"])).toBeNull();
      await writer.query("commit");
      expect((await take(runner, "worker", ["embed"]))?.id).toBe(queuedId);
    } finally {
      writer.release();
      runner.release(true);
      await db
        .update(jobRequest)
        .set({ status: "succeeded" })
        .where(eq(jobRequest.job, "embed"));
    }
  });
});
