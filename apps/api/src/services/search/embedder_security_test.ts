import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { AppDeps, Db } from "../../context.js";
import { createDb } from "../../db/client.js";
import { jobRequest } from "../../db/schema/jobs.js";
import { ServiceError } from "../../errors.js";
import { createLogger } from "../../log.js";
import { testPool } from "../../../test/deps.js";
import { asRole } from "../../../test/db-roles.js";
import {
  embeddingDeps,
  KEY,
  mockOrigin,
  openAiAnswer,
  scripted,
  unitVectors,
  useEmbeddingMock,
  WORDS,
} from "../../../test/embedding-support.js";
import { rolledBack } from "../../../test/sample-mirror.js";
import { enqueue } from "../jobs/queue.js";
import "../jobs/all.js";
import { runJobs } from "../jobs/runner.js";
import { createEmbedder } from "./embedder.js";

/*
 * The embedding provider is a third party: it sees the book's names,
 * descriptions, display folders and term values, and holds the company's key.
 * These tests hold the key to its header, the provider's words out of every
 * error and log, a wait to a minute, the host to the fetcher's list, and an
 * answer to what is checked before anything of it is kept.
 */

useEmbeddingMock();

// No test waits for real: the embedder's sleep is this, which keeps the wait.
const waits = vi.hoisted(() => [] as number[]);
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers/promises")>()),
  setTimeout: (ms: number) => {
    waits.push(ms);
    return Promise.resolve();
  },
}));

const usageRows = async (tx: Db) =>
  (
    await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from embedding_usage`,
    )
  ).rows[0]?.n;

describe("the key", () => {
  it.each([
    ["openai", "authorization"],
    ["gemini", "x-goog-api-key"],
  ] as const)(
    "goes only in %s's header, to the configured origin",
    async (provider, header) => {
      await rolledBack("worker_rw", async (tx) => {
        const { deps, sent } = embeddingDeps(tx, provider);
        await (await createEmbedder(deps))?.embed(["alpha"], "document");
        const call = sent[0];
        expect(new URL(call?.url ?? "").origin).toBe(mockOrigin());
        expect(call?.url).not.toContain(KEY);
        expect(JSON.stringify(call?.body)).not.toContain(KEY);
        const holding = Object.entries(call?.headers ?? {})
          .filter(([, value]) => value.includes(KEY))
          .map(([name]) => name.toLowerCase());
        expect(holding).toEqual([header]);
      });
    },
  );

  it("is refused a host outside the fetcher's list, and never sent there", async () => {
    await rolledBack("worker_rw", async (tx) => {
      const { deps } = embeddingDeps(tx, "openai", {
        "search.base_url": "https://embeddings.other.example",
      });
      const before = await usageRows(tx);
      const error = await (
        await createEmbedder(deps)
      )
        ?.embed(["x"], "query")
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ServiceError);
      const { message } = error as ServiceError;
      expect(message).toContain("Refused https://embeddings.other.example");
      expect(message).not.toContain(KEY);
      expect(await usageRows(tx)).toBe(before);
    });
  });
});

describe("what the provider says", () => {
  it("is kept out of an error, and so is the key", async () => {
    await rolledBack("worker_rw", async (tx) => {
      const { deps } = embeddingDeps(tx, "openai");
      const answers: [Response, string][] = [
        [
          new Response(`${WORDS} ${KEY}`, { status: 401 }),
          "OpenAI refused the API key.",
        ],
        [
          new Response(WORDS, { status: 400 }),
          "OpenAI refused the request with HTTP 400.",
        ],
        [new Response(WORDS, { status: 503 }), "OpenAI failed with HTTP 503."],
        [
          new Response(`<html>${WORDS}`, { status: 200 }),
          "OpenAI answered with something that is not JSON.",
        ],
        [
          Response.json({ words: WORDS }),
          "OpenAI did not answer 1 vectors of 1536 numbers.",
        ],
      ];
      for (const [response, sentence] of answers) {
        const embedder = await createEmbedder({
          ...deps,
          fetcher: scripted(response).fetcher,
        });
        const error = await embedder
          ?.embed(["x"], "query")
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ServiceError);
        const { message } = error as ServiceError;
        expect(message).toContain(sentence);
        expect(message).not.toContain(WORDS);
        expect(message).not.toContain(KEY);
      }
    });
  });

  it("is kept out of job_request.error and the log, and the key out of embedding_usage", async () => {
    const pool = testPool("worker_rw");
    const db = createDb(pool);
    const [workspace, dataset, table] = [1, 2, 3].map(() => randomUUID());
    await pool.query(
      `with w as (insert into powerbi_workspace (id, name) values ($1, 'Keys')),
            d as (insert into powerbi_dataset (id, workspace_id, name) values ($2, $1, 'Keys')),
            t as (insert into powerbi_table (id, dataset_id, name) values ($3, $2, 'Keys'))
       insert into powerbi_column (dataset_id, table_id, name) values ($2, $3, 'Lock')`,
      [workspace, dataset, table],
    );
    const lines: string[] = [];
    const logger = createLogger("debug", (line) => lines.push(line));
    try {
      const { deps } = embeddingDeps(db, "openai");
      const refused = await runQueued({
        ...deps,
        logger,
        fetcher: scripted(new Response(`${WORDS} ${KEY}`, { status: 401 }))
          .fetcher,
      });
      expect(refused).toMatchObject({
        status: "failed",
        error: "OpenAI refused the API key.",
      });
      const embedded = await runQueued({ ...deps, logger });
      expect(embedded.status).toBe("succeeded");

      const stored = await db.execute<{ text: string }>(
        sql`select (select string_agg(u::text, ' ') from embedding_usage u) || ' ' || (select string_agg(j::text, ' ') from job_request j) as text`,
      );
      expect(stored.rows[0]?.text).toContain("openai");
      expect(stored.rows[0]?.text).not.toContain(KEY);
      expect(stored.rows[0]?.text).not.toContain(WORDS);
      const log = lines.join("\n");
      expect(log).toContain("job finished");
      expect(log).not.toContain(KEY);
      expect(log).not.toContain(WORDS);
    } finally {
      await pool.query("delete from search_document");
      await pool.query("delete from powerbi_workspace where id = $1", [
        workspace,
      ]);
    }
  });
});

/** Queues the embed job and lets the worker's own runner take it, to the end. */
async function runQueued(deps: AppDeps) {
  const id = await enqueue(deps.db, {
    job: "embed",
    runner: "worker",
    trigger: "manual",
  });
  const stop = new AbortController();
  const running = runJobs(deps, { signal: stop.signal });
  try {
    for (const until = Date.now() + 20_000; Date.now() < until;) {
      const [job] = await deps.db
        .select()
        .from(jobRequest)
        .where(eq(jobRequest.id, id));
      if (job !== undefined && !["queued", "running"].includes(job.status))
        return job;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`job ${id} did not finish`);
  } finally {
    stop.abort();
    await running;
  }
}

describe("a rate limit", () => {
  it("is waited out once, for its Retry-After and never more than 60 seconds", async () => {
    await rolledBack("worker_rw", async (tx) => {
      const { deps } = embeddingDeps(tx, "openai");
      const limited = (after?: string) =>
        new Response(WORDS, {
          status: 429,
          headers: after === undefined ? {} : { "retry-after": after },
        });
      for (const [after, waited] of [
        ["2", 2000],
        ["86400", 60_000],
        [undefined, 1000],
      ] as const) {
        waits.length = 0;
        const answers = scripted(limited(after), openAiAnswer(1));
        const embedder = await createEmbedder({
          ...deps,
          fetcher: answers.fetcher,
        });
        expect(await embedder?.embed(["x"], "document")).toHaveLength(1);
        expect(waits).toEqual([waited]);
      }

      waits.length = 0;
      const stuck = scripted(limited("86400"), limited("86400"));
      const embedder = await createEmbedder({
        ...deps,
        fetcher: stuck.fetcher,
      });
      await expect(embedder?.embed(["x"], "document")).rejects.toMatchObject({
        kind: "rate_limited",
      });
      expect(waits).toEqual([60_000]);
      expect(stuck.calls()).toBe(2);

      // A search's query is not waited for at all: a person is waiting.
      waits.length = 0;
      const once = scripted(limited("2"));
      const asking = await createEmbedder({ ...deps, fetcher: once.fetcher });
      await expect(asking?.embed(["x"], "query")).rejects.toMatchObject({
        kind: "rate_limited",
      });
      expect(waits).toEqual([]);
      expect(once.calls()).toBe(1);
    });
  });
});

describe("an answer", () => {
  const openAi = (data: unknown, tokens = 5) =>
    Response.json({ data, usage: { total_tokens: tokens } });
  const gemini = (values: number[][], promptTokenCount = 5) =>
    Response.json({
      embeddings: values.map((row) => ({ values: row })),
      usageMetadata: { promptTokenCount },
    });
  const [unit] = unitVectors(1);
  const vector = unit ?? [];
  const entry = (index: number, embedding = vector) => ({ index, embedding });

  it.each([
    ["OpenAI", "indexes that repeat", () => openAi([entry(0), entry(0)])],
    ["OpenAI", "indexes that skip one", () => openAi([entry(0), entry(2)])],
    [
      "OpenAI",
      "a value above 1",
      () =>
        openAi([
          entry(
            0,
            vector.map((v) => v + 0.5),
          ),
          entry(1),
        ]),
    ],
    [
      "OpenAI",
      "a token count past int4",
      () => openAi([entry(0), entry(1)], 2 ** 31),
    ],
    [
      "OpenAI",
      "a vector of another width",
      () => openAi([entry(0, vector.slice(1)), entry(1)]),
    ],
    [
      "Google",
      "a value below -1",
      () => gemini([vector.map((v) => v - 2), vector]),
    ],
    [
      "Google",
      "a token count past int4",
      () => gemini([vector, vector], 2 ** 31),
    ],
  ] as const)(
    "from %s with %s is refused before anything is recorded",
    async (who, _what, answer) => {
      await rolledBack("worker_rw", async (tx) => {
        const provider = who === "OpenAI" ? "openai" : "gemini";
        const { deps } = embeddingDeps(tx, provider);
        const before = await usageRows(tx);
        const embedder = await createEmbedder({
          ...deps,
          fetcher: scripted(answer()).fetcher,
        });
        const error = await embedder
          ?.embed(["one", "two"], "document")
          .catch((e: unknown) => e);
        expect(error).toMatchObject({ detail: { code: "bad_answer" } });
        expect((error as ServiceError).message).not.toMatch(/\d\.\d/);
        expect(await usageRows(tx)).toBe(before);
      });
    },
  );
});

describe("embedding_usage", () => {
  it.each(["api_rw", "worker_rw"] as const)(
    "is appended to by %s and never changed, removed or written with a negative number",
    async (role) => {
      const insert = (tokens: number, cost: number) =>
        asRole(
          role,
          `insert into embedding_usage (provider, model, tokens, cost_micro_usd, purpose) values ('openai', 'm', ${String(tokens)}, ${String(cost)}, 'query')`,
        );
      await insert(1, 1);
      await expect(
        asRole(role, "update embedding_usage set tokens = 0"),
      ).rejects.toThrow("permission denied for table embedding_usage");
      await expect(asRole(role, "delete from embedding_usage")).rejects.toThrow(
        "permission denied for table embedding_usage",
      );
      await expect(insert(-1, 1)).rejects.toThrow(
        "embedding_usage_tokens_check",
      );
      await expect(insert(1, -1)).rejects.toThrow("embedding_usage_cost_check");
    },
  );
});
