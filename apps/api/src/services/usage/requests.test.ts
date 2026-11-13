import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { cerbosAccess, createTestDeps } from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import {
  fileUnder,
  id as mirror,
  metricIn,
  reaching,
  rolledBack,
  useMirror,
} from "../../../test/mirror-fixtures.js";
import type { Db, ServiceContext } from "../../context.js";
import { category, metric } from "../../db/schema/book.js";
import { request } from "../../db/schema/usage.js";
import { countRequest } from "../rate-limit.js";
import {
  CAPTURE_OFF_NOTE,
  deleteRequest,
  getRequest,
  listRequests,
  recordRequest,
  REQUEST_RATE,
  type RecordRequestInput,
} from "./requests.js";

useMirror();
const AT = new Date("2026-11-11T09:00:00.000Z");
const settings = new MemorySettings({ "usage.retention_days": 30 });
const deps = createTestDeps({
  access: cerbosAccess(new MemorySettings()),
  settings,
  clock: () => AT,
});
const asker = (db: Db = deps.db, overrides: Partial<ServiceContext> = {}) => ({
  ...deps,
  db,
  principal: {
    ...reaching({ powerbi_app_ids: [mirror.sales_app] }),
    id: `asker-${randomUUID()}`,
    via: "mcp" as const,
  },
  ...overrides,
});
const asked: RecordRequestInput = {
  question: "Why did returns rise in March?",
  outcome: "partly_answered",
  gaps: ["missing_dimension"],
  missing: "No return reason on the order lines.",
};
const failure = (work: Promise<unknown>) =>
  work.then(
    () => null,
    (error: unknown) => error,
  );
const key = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;

describe("recordRequest", () => {
  it("records a request, kept for usage.retention_days, and gets it back", async () => {
    const context = asker();
    const answer = await recordRequest(context, asked);
    expect(answer).toEqual({
      recorded: true,
      id: expect.any(String) as string,
      kept_until: "2026-12-11T09:00:00.000Z",
    });
    if (!answer.recorded) return;
    expect(await getRequest(context, answer.id)).toEqual({
      id: answer.id,
      at: AT.toISOString(),
      principal: { kind: "person", id: context.principal.id },
      via: "mcp",
      question: asked.question,
      outcome: "partly_answered",
      gaps: ["missing_dimension"],
      missing: asked.missing,
      elements: [],
      query_ids: [],
      search_ids: [],
      queries: [],
      searches: [],
    });
  });

  it.each([
    [{ outcome: "not_answered", gaps: [] }, "gaps needs at least one gap"],
    [{ gaps: ["no_metric", "no_metric"] }, "gaps names no_metric twice."],
    [{ gaps: ["guess"] }, "gaps[0] is not one of"],
    [{ question: "  " }, "question is empty."],
    [{ missing: "x".repeat(2001) }, "missing is longer than 2000 characters"],
    [{ query_ids: Array.from({ length: 21 }, randomUUID) }, "query_ids holds"],
  ] as const)("refuses %j: %s", async (change, sentence) => {
    const input = { ...asked, ...change } as RecordRequestInput;
    expect(await failure(recordRequest(asker(), input))).toMatchObject({
      kind: "invalid",
      message: expect.stringContaining(sentence) as string,
    });
  });

  it("takes an answered request with no gap", async () => {
    const answer = await recordRequest(asker(), {
      question: "Net sales in May?",
      outcome: "answered",
    });
    expect(answer.recorded).toBe(true);
  });

  it("resolves a metric by key and by alias, and a category by its path", () =>
    rolledBack(async (tx) => {
      const name = key("net");
      const id = await metricIn(tx, name);
      await fileUnder(tx, id, mirror.net_sales);
      const alias = key("turnover");
      await tx
        .update(metric)
        .set({ aliases: [alias] })
        .where(eq(metric.id, id));
      const [parent] = await tx
        .insert(category)
        .values({ name: "Finance", key: key("finance") })
        .returning();
      const [child] = await tx
        .insert(category)
        .values({ name: "Sales", key: "sales", parent_id: parent?.id })
        .returning();
      const context = asker(tx);
      const answer = await recordRequest(context, {
        ...asked,
        elements: [
          { kind: "metric", id: name },
          { kind: "metric", id: alias },
          { kind: "category", id: `${parent?.key ?? ""}/sales` },
          { kind: "dataset", id: mirror.sales },
        ],
      });
      if (!answer.recorded) throw new Error(answer.note);
      expect((await getRequest(context, answer.id)).elements).toEqual([
        { kind: "metric", id },
        { kind: "metric", id },
        { kind: "category", id: child?.id },
        { kind: "dataset", id: mirror.sales },
      ]);
    }));

  it("writes nothing when usage.capture is off", async () => {
    const off = new MemorySettings({ "usage.capture": false });
    const context = asker(deps.db, { settings: off });
    expect(await recordRequest(context, asked)).toEqual({
      recorded: false,
      note: CAPTURE_OFF_NOTE,
    });
    const rows = await deps.db
      .select()
      .from(request)
      .where(eq(request.principal_id, context.principal.id));
    expect(rows).toEqual([]);
  });

  it("is rate limited per principal", async () => {
    const context = asker();
    const { kind, id } = context.principal;
    for (let n = 0; n < REQUEST_RATE.max; n += 1)
      await countRequest(
        deps.db,
        `record_request:${kind}:${id}`,
        REQUEST_RATE,
        AT,
      );
    expect(await failure(recordRequest(context, asked))).toMatchObject({
      kind: "rate_limited",
    });
  });
});

describe("listRequests", () => {
  it("filters by outcome, gap and words, newest first, and pages on", async () => {
    let minute = 0;
    const context = asker(deps.db, {
      clock: () => {
        minute += 1;
        return new Date(AT.getTime() + minute * 60_000);
      },
    });
    const word = key("churn");
    const ids: string[] = [];
    for (const outcome of [
      "answered",
      "not_answered",
      "not_answered",
    ] as const) {
      const answer = await recordRequest(context, {
        question: `How is ${word} counted?`,
        outcome,
        gaps: outcome === "answered" ? [] : ["unclear_metric"],
      });
      if (answer.recorded) ids.push(answer.id);
    }
    const mine = { mine: true } as const;
    const listed = async (filters: object) =>
      (await listRequests(context, { ...mine, ...filters })).items.map(
        ({ id }) => id,
      );
    expect(await listed({})).toEqual([...ids].reverse());
    expect(await listed({ outcome: "answered" })).toEqual([ids[0]]);
    expect(await listed({ gap: "unclear_metric" })).toEqual([ids[2], ids[1]]);
    expect(await listed({ text: word, limit: 1 })).toEqual([ids[2]]);
    const first = await listRequests(context, { ...mine, limit: 2 });
    const rest = await listRequests(context, {
      ...mine,
      cursor: first.next_cursor ?? "",
    });
    expect(rest.items.map(({ id }) => id)).toEqual([ids[0]]);
    expect(rest.next_cursor).toBeNull();
  });
});

it("keeps the request when its deletion cannot be audited", async () => {
  const context = asker();
  const answer = await recordRequest(context, asked);
  if (!answer.recorded) throw new Error("Request was not recorded.");
  // api_rw cannot insert audit events: exercise a real audit write failure.
  await expect(
    deleteRequest({ ...context, auditDb: context.db }, answer.id),
  ).rejects.toMatchObject({ cause: { code: "42501" } });
  expect(await getRequest(context, answer.id)).toMatchObject({
    question: asked.question,
  });
});
