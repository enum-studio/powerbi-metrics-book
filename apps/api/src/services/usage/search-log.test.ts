import { count, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { MemorySettings } from "../../../test/doubles.js";
import { testPool } from "../../../test/deps.js";
import {
  person,
  searchable,
  useSearchable,
} from "../../../test/search-support.js";
import { createDb } from "../../db/client.js";
import { searchLog } from "../../db/schema/usage.js";
import { countRequest } from "../rate-limit.js";
import { search, SEARCH_RATE } from "../search/query.js";

useSearchable();

it.each(["mcp", "cli", "api"] as const)(
  "a %s search answers a search_id and writes one search_log row",
  (via) =>
    searchable({ provider: "none" }, async (s) => {
      const context = s.as({ ...person(), via });
      const db = createDb(testPool("api_rw"));
      const [before] = await db.select({ n: count() }).from(searchLog);
      const answer = await search(context, { query: "net sales" });
      try {
        expect(answer).toHaveProperty("search_id", expect.any(String));
        const rows = await db
          .select()
          .from(searchLog)
          .where(eq(searchLog.id, answer.search_id ?? ""));
        expect(rows).toHaveLength(1);
        expect(await db.select({ n: count() }).from(searchLog)).toEqual([
          { n: (before?.n ?? 0) + 1 },
        ]);
        expect(rows[0]).toMatchObject({
          query: "net sales",
          via,
          hit_count: answer.items.length,
        });
      } finally {
        if (answer.search_id)
          await db.delete(searchLog).where(eq(searchLog.id, answer.search_id));
      }
    }),
);

it("records variant hits, the first ten hit summaries and filters without query", () =>
  searchable({ provider: "none" }, async (s) => {
    const context = s.as({
      ...person({
        powerbi_workspace_ids: s.sample.tenant.workspaces.map((w) => w.id),
      }),
      via: "mcp",
    });
    const filters = {
      kinds: ["variant"] as const,
      limit: 50,
      include_removed: false,
    };
    const answer = await search(context, {
      query: "sales",
      ...filters,
      kinds: [...filters.kinds],
    });
    const db = createDb(testPool("api_rw"));
    try {
      expect(answer.items.length).toBeGreaterThan(10);
      expect(answer.items.every(({ kind }) => kind === "variant")).toBe(true);
      const [row] = await db
        .select()
        .from(searchLog)
        .where(eq(searchLog.id, answer.search_id ?? ""));
      expect(row?.metric_hit).toBe(true);
      expect(row?.hit_count).toBe(answer.items.length);
      expect(row?.top_hits).toEqual(
        answer.items
          .slice(0, 10)
          .map(({ kind, id, score, match }) => ({ kind, id, score, match })),
      );
      expect(row?.filters).toEqual(filters);
    } finally {
      if (answer.search_id)
        await db.delete(searchLog).where(eq(searchLog.id, answer.search_id));
    }
  }));

it.each([
  "browser",
  "capture disabled",
  "invalid input",
  "rate limited",
] as const)("%s writes no search_log row", (scenario) =>
  searchable({ provider: "none" }, async (s) => {
    const at = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    const principal = {
      ...person(),
      via: scenario === "browser" ? ("browser" as const) : ("mcp" as const),
    };
    const context = s.as(principal, {
      clock: () => at,
      ...(scenario === "capture disabled"
        ? { settings: new MemorySettings({ "usage.capture": false }) }
        : {}),
    });
    if (scenario === "rate limited") {
      for (let n = 0; n < SEARCH_RATE.max; n += 1)
        await countRequest(
          s.tx,
          `search:${principal.kind}:${principal.id}`,
          SEARCH_RATE,
          at,
        );
    }
    const db = createDb(testPool("api_rw"));
    const before = await db.select({ n: count() }).from(searchLog);
    if (scenario === "invalid input" || scenario === "rate limited") {
      await expect(
        search(context, {
          query: scenario === "invalid input" ? "" : "sales",
        }),
      ).rejects.toMatchObject({
        kind: scenario === "invalid input" ? "invalid" : "rate_limited",
      });
    } else {
      expect(await search(context, { query: "sales" })).toHaveProperty(
        "search_id",
        null,
      );
    }
    expect(await db.select({ n: count() }).from(searchLog)).toEqual(before);
  }),
);

it("does not store unknown search keys in filters", () =>
  searchable({ provider: "none" }, async (s) => {
    const input = { query: "sales", limit: 5, extra: "unparsed text" };
    const answer = await search(s.as({ ...person(), via: "mcp" }), input);
    const db = createDb(testPool("api_rw"));
    try {
      const [row] = await db
        .select()
        .from(searchLog)
        .where(eq(searchLog.id, answer.search_id ?? ""));
      expect(row?.filters).toEqual({ limit: 5 });
    } finally {
      if (answer.search_id)
        await db.delete(searchLog).where(eq(searchLog.id, answer.search_id));
    }
  }));
