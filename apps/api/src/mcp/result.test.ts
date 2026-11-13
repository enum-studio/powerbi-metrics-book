import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTestDeps, principals } from "../../test/deps.js";
import {
  asPerson,
  everyWorkspace,
  fileUnder,
  id,
  metricIn,
  rolledBack,
  useMirror,
} from "../../test/mirror-fixtures.js";
import { acceptReply, postThread, reply } from "../services/threads/threads.js";
import { searchLog } from "../db/schema/usage.js";
import type { UsageReport } from "../services/usage/report.js";
import { metric } from "../db/schema/book.js";
import { defineTool, type Tool } from "./registry.js";
import {
  ANSWER_LIMIT_BYTES,
  CUT_ROW_SENTENCE,
  CURSOR_MAX_CHARACTERS,
  CUT_SENTENCE,
  rowsCutSentence,
  toolAnswer,
} from "./result.js";
import { TOOLS } from "./tools/index.js";

useMirror();

const context = { ...createTestDeps(), principal: principals.viewer };

const tool = (wanted: string): Tool => {
  const found = TOOLS.find(({ name }) => name === wanted);
  if (found === undefined) throw new Error(`No tool named ${wanted}.`);
  return found;
};

type Row = { id: string; text: string };
type Page = { items: Row[]; next_cursor: string | null };

const rowsOf = (count: number, size: number): Row[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `row-${String(index)}`,
    text: "x".repeat(size),
  }));

/** A list over rows in memory, paged as a service pages: the cursor is the last row's id. */
function listing(all: Row[]) {
  const limits: (number | undefined)[] = [];
  const tool = defineTool({
    name: "listing",
    description: "Lists rows.",
    input: z.strictObject({
      cursor: z.string().optional(),
      limit: z.number().optional(),
    }),
    handler: (_, { cursor, limit }) => {
      limits.push(limit);
      const from =
        cursor === undefined ? 0 : all.findIndex(({ id }) => id === cursor) + 1;
      const items = all.slice(from, from + (limit ?? 100));
      const more = from + items.length < all.length;
      return Promise.resolve({
        items,
        next_cursor: more ? (items.at(-1)?.id ?? null) : null,
      });
    },
  });
  return { tool, limits };
}

const blocks = (result: { content: { text: string }[] }) =>
  result.content.map(({ text }) => text);

describe("a page too long for one answer", () => {
  it("ends on a whole row with its cursor, and paging reaches every row once", async () => {
    const all = rowsOf(200, 300);
    const { tool } = listing(all);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const result = await tool.call(
        context,
        cursor === null ? {} : { cursor },
      );
      const [only = "", ...rest] = blocks(result);
      expect(rest).toEqual([]);
      expect(Buffer.byteLength(only)).toBeLessThanOrEqual(ANSWER_LIMIT_BYTES);
      const page = JSON.parse(only) as Page;
      seen.push(...page.items.map(({ id }) => id));
      cursor = page.next_cursor;
    } while (cursor !== null);
    expect(seen).toEqual(all.map(({ id }) => id));
  });

  it("asks the list again only when the page does not fit", async () => {
    const short = listing(rowsOf(3, 10));
    await short.tool.call(context, {});
    expect(short.limits).toEqual([undefined]);

    const long = listing(rowsOf(200, 300));
    await long.tool.call(context, {});
    expect(long.limits).toHaveLength(2);
    expect(long.limits[1]).toBeLessThan(100);
  });

  it("keeps the cursor when one row alone is too long, so paging gets past it", async () => {
    const small = { id: "small", text: "x" };
    const huge = { id: "huge", text: "€".repeat(ANSWER_LIMIT_BYTES) };
    const last = { id: "last", text: "x" };
    const { tool } = listing([small, huge, last]);

    const first = await tool.call(context, {});
    expect(JSON.parse(blocks(first)[0] ?? "")).toEqual({
      items: [small],
      next_cursor: "small",
    });

    const inside = await tool.call(context, { cursor: "small" });
    const [cut = "", note = ""] = blocks(inside);
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(ANSWER_LIMIT_BYTES);
    expect(cut).toContain('"id":"huge"');
    expect(JSON.parse(note)).toEqual({
      truncated: true,
      message: CUT_ROW_SENTENCE,
      next_cursor: "huge",
    });

    const after = await tool.call(context, { cursor: "huge" });
    expect(JSON.parse(blocks(after)[0] ?? "")).toEqual({
      items: [last],
      next_cursor: null,
    });
  });

  it("pages list_metrics to the end on real rows, even at the largest limit", () =>
    rolledBack(async (tx) => {
      const names = Array.from(
        { length: 120 },
        (_, index) =>
          `metric_${String(index).padStart(3, "0")}_${"long_name_".repeat(20)}`,
      );
      for (const name of names) await metricIn(tx, name);
      const inTransaction = asPerson(everyWorkspace, { db: tx });
      const seen: string[] = [];
      let pages = 0;
      let cursor: string | null = null;
      do {
        const answer = await tool("list_metrics").call(inTransaction, {
          limit: 100,
          ...(cursor === null ? {} : { cursor }),
        });
        const [only = "", ...rest] = blocks(answer);
        expect(rest).toEqual([]);
        expect(Buffer.byteLength(only)).toBeLessThanOrEqual(ANSWER_LIMIT_BYTES);
        const page = JSON.parse(only) as {
          items: { name: string }[];
          next_cursor: string | null;
        };
        seen.push(...page.items.map(({ name }) => name));
        cursor = page.next_cursor;
        pages += 1;
      } while (cursor !== null);
      expect(pages).toBeGreaterThan(1);
      expect(seen.filter((name) => names.includes(name))).toEqual(names);
    }));

  it("is a rule for exactly the tools that list, none of which a caller could see run twice", () => {
    const pages = TOOLS.filter(({ inputSchema }) => {
      const fields = inputSchema.properties ?? {};
      return "cursor" in fields && "limit" in fields;
    }).map(({ name }) => name);
    expect(pages.sort()).toEqual([
      "list_columns",
      "list_datasets",
      "list_measures",
      "list_metrics",
      "list_requests",
      "list_terms",
      "list_threads",
      "list_variants",
      "search_query_log",
    ]);
  });
});

describe("get_metric", () => {
  it("keeps the trust state, the measures and the checks when the definition fills the answer", () =>
    rolledBack(async (tx) => {
      const orders = await metricIn(tx, "orders");
      await fileUnder(tx, orders, id.net_sales);
      await tx.update(metric).set({ definition: "x".repeat(20_000) });

      const [cut = ""] = blocks(
        await tool("get_metric").call(asPerson(everyWorkspace, { db: tx }), {
          name: "orders",
        }),
      );
      expect(cut).toContain('"trust_state":"');
      expect(cut).toContain('"measure_reference":"[Net sales]"');
      expect(cut).toContain('"failing_checks"');
      expect(cut.indexOf('"failing_checks"')).toBeLessThan(
        cut.indexOf('"definition"'),
      );
    }));

  it("keeps the measures and the checks when accepted answers fill the answer", () =>
    rolledBack(async (tx) => {
      const orders = await metricIn(tx, "orders");
      await fileUnder(tx, orders, id.net_sales);
      const person = asPerson(everyWorkspace, { db: tx });
      for (let index = 0; index < 10; index += 1) {
        const question = await postThread(person, {
          kind: "question",
          element: { kind: "metric", id: orders },
          title: `Question ${String(index)}`,
          body: "What does it count?",
        });
        const answer = await reply(person, question.id, "x".repeat(2000));
        await acceptReply(person, question.id, answer.id);
      }

      const [cut = ""] = blocks(
        await tool("get_metric").call(person, { name: "orders" }),
      );
      expect(cut).toContain('"measure_reference":"[Net sales]"');
      expect(cut).toContain('"failing_checks"');
      expect(cut.indexOf('"failing_checks"')).toBeLessThan(
        cut.indexOf('"accepted_answers"'),
      );
    }));

  it("keeps the measures when hundreds of metrics share a word of the label, and names only a few", () =>
    rolledBack(async (tx) => {
      const orders = await metricIn(tx, "orders");
      await fileUnder(tx, orders, id.net_sales);
      for (let index = 0; index < 400; index += 1)
        await metricIn(
          tx,
          `orders_${String(index).padStart(3, "0")}_held_in_a_long_label`,
        );

      const answer = await tool("get_metric").call(
        asPerson(everyWorkspace, { db: tx }),
        { name: "orders" },
      );

      const [only = "", ...rest] = blocks(answer);
      expect(rest).toEqual([]);
      expect(Buffer.byteLength(only)).toBeLessThanOrEqual(ANSWER_LIMIT_BYTES);
      expect(only.indexOf('"base_variants"')).toBeLessThan(
        only.indexOf('"failing_checks"'),
      );
      const metric = JSON.parse(only) as {
        base_variants: { measure_reference: string }[];
        failing_checks: {
          check: string;
          message: string;
          other_labels?: string[];
        }[];
      };
      expect(metric.base_variants).toMatchObject([
        { measure_reference: "[Net sales]" },
      ]);
      const sharing = metric.failing_checks.find(
        ({ check }) => check === "metric_not_the_same_as",
      );
      expect(sharing?.message).toMatch(/^400 other metrics share/);
      expect(sharing?.other_labels).toHaveLength(10);
    }));

  it("keeps the measures ahead of a failing check too long for one answer", () =>
    rolledBack(async (tx) => {
      const orders = await metricIn(tx, "orders");
      await fileUnder(tx, orders, id.net_sales);
      for (let index = 0; index < 20; index += 1)
        await metricIn(
          tx,
          `orders_${String(index).padStart(2, "0")}_${"held_in_a_long_label_".repeat(40)}`,
        );

      const [cut = "", note = ""] = blocks(
        await tool("get_metric").call(asPerson(everyWorkspace, { db: tx }), {
          name: "orders",
        }),
      );
      expect(note).toContain('"truncated":true');
      expect(
        Buffer.byteLength(cut) + Buffer.byteLength(note),
      ).toBeLessThanOrEqual(ANSWER_LIMIT_BYTES);
      expect(cut).toContain('"measure_reference":"[Net sales]"');
      expect(cut.indexOf('"base_variants"')).toBeLessThan(
        cut.indexOf('"failing_checks"'),
      );
    }));
});

describe("a cut answer", () => {
  it("stays within the bound with its note, whatever the cursor", () => {
    const result = toolAnswer({
      items: [{ text: "x".repeat(ANSWER_LIMIT_BYTES) }],
      next_cursor: "c".repeat(CURSOR_MAX_CHARACTERS),
    });
    const [cut = "", note = ""] = blocks(result);
    expect(
      Buffer.byteLength(cut) + Buffer.byteLength(note),
    ).toBeLessThanOrEqual(ANSWER_LIMIT_BYTES);
    expect(JSON.parse(note)).toMatchObject({ message: CUT_ROW_SENTENCE });
  });

  it("gives no cursor for a page of several rows, which would skip those the cut took", () => {
    const [, note = ""] = blocks(
      toolAnswer({ items: rowsOf(100, 300), next_cursor: "row-99" }),
    );
    expect(JSON.parse(note)).toEqual({
      truncated: true,
      message: CUT_SENTENCE,
    });
  });
});

describe("a row too long for one answer, with a cursor no tool could take", () => {
  it("drops the cursor rather than break the bound on the note", () => {
    const [, note = ""] = blocks(
      toolAnswer({
        items: [{ text: "x".repeat(ANSWER_LIMIT_BYTES) }],
        next_cursor: "c".repeat(CURSOR_MAX_CHARACTERS + 1),
      }),
    );
    expect(JSON.parse(note)).toEqual({
      truncated: true,
      message: CUT_SENTENCE,
    });
  });
});

describe("a list with no cursor, too long for one answer", () => {
  const all = rowsOf(100, 300);

  it("keeps an answer's items to the rows that fit, its other fields, and says so", () => {
    const result = toolAnswer({
      items: all,
      search_mode: "words_only",
      note: "Searched by words only.",
    });
    const [body = "", note = ""] = blocks(result);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(ANSWER_LIMIT_BYTES);
    const answer = JSON.parse(body) as { items: Row[] };
    expect(answer).toMatchObject({
      search_mode: "words_only",
      note: "Searched by words only.",
    });
    expect(answer.items).toEqual(all.slice(0, answer.items.length));
    expect(answer.items.length).toBeGreaterThan(30);
    expect(JSON.parse(note)).toEqual({
      truncated: true,
      message: rowsCutSentence(answer.items.length, all.length),
    });
  });

  it("keeps a bare list to the rows that fit", () => {
    const [body = "", note = ""] = blocks(toolAnswer(all));
    const rows = JSON.parse(body) as Row[];
    expect(rows).toEqual(all.slice(0, rows.length));
    expect(JSON.parse(note)).toEqual({
      truncated: true,
      message: rowsCutSentence(rows.length, all.length),
    });
  });
});

it("get_usage_report refits a large seeded log within 16 KiB with truncated_lists", async () => {
  const deps = createTestDeps();
  const now = deps.clock();
  await deps.auditDb.insert(searchLog).values(
    Array.from({ length: 100 }, (_, n) => ({
      id: randomUUID(),
      at: now,
      principal_kind: "person" as const,
      principal_id: "report-reader",
      via: "mcp" as const,
      query: `${String(n)} ${"€".repeat(450)}`,
      search_mode: "words_only" as const,
      hit_count: 0,
      metric_hit: false,
      top_hits: [],
    })),
  );
  const as = asPerson({ ...everyWorkspace, roles: ["curator"] });
  const reads = vi.spyOn(as.access, "require");
  const answer = await tool("get_usage_report").call(as, {
    since: new Date(now.getTime() - 60_000).toISOString(),
    limit: 100,
  });
  expect(answer.isError).toBeUndefined();
  expect(answer.content).toHaveLength(1);
  const serialised = blocks(answer)[0] ?? "";
  expect(Buffer.byteLength(serialised)).toBeLessThanOrEqual(ANSWER_LIMIT_BYTES);
  const report = JSON.parse(serialised) as UsageReport;
  expect(report.truncated_lists).toContain("searches_with_no_hits");
  expect(report.not_covered.searches_with_no_hits.length).toBeGreaterThan(0);
  expect(reads.mock.calls.length).toBeGreaterThan(1);
});
