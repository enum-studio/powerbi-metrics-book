import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
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
import { auditEvent } from "../../db/schema/audit.js";
import { request, searchLog } from "../../db/schema/usage.js";
import { ServiceError } from "../../errors.js";
import type { Principal } from "../../principal.js";
import { logQuery } from "../queries/log.js";
import {
  deleteRequest,
  getRequest,
  listRequests,
  recordRequest,
  type RecordRequestInput,
} from "./requests.js";

/*
 * A request is personal data: its principal and the company's curators read
 * it, its principal and admins delete it, and to anyone else it answers as a
 * missing one. The owner is compared by kind and id. What a refusal says
 * never tells another principal's id, or a hidden element, from a missing one.
 */

useMirror();
const deps = createTestDeps({ access: cerbosAccess(new MemorySettings()) });
const as = (principal: Principal, db: Db = deps.db): ServiceContext => ({
  ...deps,
  db,
  principal,
});
const someone = (
  role: "viewer" | "curator" | "admin",
  kind: Principal["kind"] = "person",
  id = `${role}-${randomUUID()}`,
): Principal => ({ ...reaching({}, role), kind, id });

const failure = (work: Promise<unknown>) =>
  work.then(
    () => null,
    (error: unknown) => error,
  );
/** What a refusal tells: its kind and its sentence. */
const told = async (work: Promise<unknown>) => {
  const error = await failure(work);
  return error instanceof ServiceError
    ? { kind: error.kind, message: error.message, detail: error.detail }
    : error;
};

const asked: RecordRequestInput = {
  question: "What were net sales last month?",
  outcome: "not_answered",
  gaps: ["no_metric"],
};
async function recorded(
  context: ServiceContext,
  input: Partial<RecordRequestInput> = {},
): Promise<string> {
  const answer = await recordRequest(context, { ...asked, ...input });
  if (!answer.recorded) throw new Error(answer.note);
  return answer.id;
}
async function searched({ principal }: ServiceContext): Promise<string> {
  const id = randomUUID();
  await deps.auditDb.insert(searchLog).values({
    id,
    at: new Date(),
    principal_kind: principal.kind,
    principal_id: principal.id,
    via: "mcp",
    query: "churn",
    search_mode: "words_only",
    hit_count: 0,
    metric_hit: false,
  });
  return id;
}
async function queried(context: ServiceContext): Promise<string> {
  const id = randomUUID();
  await logQuery(context, {
    id,
    at: new Date(),
    dataset: null,
    dax: "EVALUATE {1}",
    purpose: null,
    status: "succeeded",
    error: null,
    duration_ms: 10,
    measure_names: [],
    metric_ids: [],
  });
  return id;
}
const listed = async (context: ServiceContext) =>
  (await listRequests(context, { limit: 100 })).items.map(({ id }) => id);
const searchesReadBy = async (context: ServiceContext, id: string) =>
  deps.db
    .select({ id: searchLog.id })
    .from(searchLog)
    .where(
      and(
        eq(searchLog.id, id),
        await deps.access.readableSearchLog(context.principal),
      ),
    );
const stillThere = async (id: string) =>
  (await deps.db.select().from(request).where(eq(request.id, id))).length;

describe("another person's request", () => {
  it("is not listed, got or deleted, and their searches are not seen", async () => {
    const owner = as(someone("viewer"));
    const search = await searched(owner);
    const id = await recorded(owner, { search_ids: [search] });
    const other = as(someone("viewer"));
    const nothing = randomUUID();

    expect(await listed(other)).not.toContain(id);
    expect(await told(getRequest(other, id))).toEqual(
      await told(getRequest(other, nothing)),
    );
    expect(await told(getRequest(other, id))).toMatchObject({
      kind: "not_found",
    });
    expect(await told(deleteRequest(other, id))).toEqual(
      await told(deleteRequest(other, nothing)),
    );
    expect(await stillThere(id)).toBe(1);
    expect(await searchesReadBy(other, search)).toEqual([]);
    expect(await searchesReadBy(owner, search)).toEqual([{ id: search }]);
  });

  it("is read but not deleted by a curator, and deleted by an admin, which is audited", async () => {
    const owner = as(someone("viewer"));
    const search = await searched(owner);
    const id = await recorded(owner, { search_ids: [search] });
    const curator = as(someone("curator"));
    const admin = as(someone("admin"));

    expect(await listed(curator)).toContain(id);
    expect((await getRequest(curator, id)).searches).toEqual([
      { id: search, query: "churn", hit_count: 0 },
    ]);
    expect(await told(deleteRequest(curator, id))).toMatchObject({
      kind: "refused",
    });
    expect(await stillThere(id)).toBe(1);

    await deleteRequest(admin, id);
    expect(await stillThere(id)).toBe(0);
    const audited = await deps.db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.resource_id, id));
    expect(audited).toMatchObject([
      {
        action: "request.delete",
        principal_id: admin.principal.id,
        decision: "allow",
      },
    ]);
  });

  it("is deleted by its own principal", async () => {
    const owner = as(someone("viewer"));
    const id = await recorded(owner);
    await deleteRequest(owner, id);
    expect(await stillThere(id)).toBe(0);
  });
});

describe("a service account named like a person's id", () => {
  it("reads neither the person's requests nor searches, nor the person the account's", async () => {
    const name = `twin-${randomUUID()}`;
    const person = as(someone("viewer", "person", name));
    const account = as(someone("viewer", "service_account", name));
    for (const [owner, reader] of [
      [person, account],
      [account, person],
    ] as const) {
      const search = await searched(owner);
      const id = await recorded(owner, { search_ids: [search] });
      expect(await listed(reader)).not.toContain(id);
      expect(await told(getRequest(reader, id))).toMatchObject({
        kind: "not_found",
      });
      expect(await searchesReadBy(reader, search)).toEqual([]);
    }
  });
});

describe("a link to another principal's query or search", () => {
  it.each(["query_ids", "search_ids"] as const)(
    "in %s is refused with the sentence a missing id gets",
    async (name) => {
      const owner = as(someone("viewer"));
      const twin = as({ ...owner.principal, kind: "service_account" });
      const caller = as(someone("viewer"));
      const make = name === "query_ids" ? queried : searched;
      const owners = await make(owner);
      const refusedTwin = await told(recorded(twin, { [name]: [owners] }));
      expect(refusedTwin).toEqual(
        await told(recorded(twin, { [name]: [randomUUID()] })),
      );
      expect(refusedTwin).toMatchObject({
        kind: "invalid",
        message: `${name}[0] is no ${name === "query_ids" ? "query" : "search"} of yours.`,
      });
      for (const theirs of [owners, await make(twin)]) {
        const refused = await told(recorded(caller, { [name]: [theirs] }));
        expect(refused).toEqual(
          await told(recorded(caller, { [name]: [randomUUID()] })),
        );
        expect(refused).toMatchObject({ kind: "invalid" });
      }
      const own = await make(caller);
      await expect(recorded(caller, { [name]: [own] })).resolves.toEqual(
        expect.any(String),
      );
    },
  );
});

describe("an element the caller may not describe", () => {
  it("is refused with the sentence an unknown element gets", () =>
    rolledBack(async (tx) => {
      const key = `hidden_${randomUUID().replaceAll("-", "")}`;
      const metric = await metricIn(tx, key);
      await fileUnder(tx, metric, mirror.net_sales);
      const outsider = as(someone("viewer"), tx);
      const refusal = (kind: "metric" | "dataset" | "measure", id: string) =>
        told(recorded(outsider, { elements: [{ kind, id }] }));
      for (const [kind, hidden, unknown] of [
        ["metric", metric, randomUUID()],
        ["metric", key, `nothing_${randomUUID().replaceAll("-", "")}`],
        ["dataset", mirror.sales, randomUUID()],
        ["measure", mirror.net_sales, randomUUID()],
      ] as const) {
        const said = await refusal(kind, hidden);
        expect(said).toEqual(await refusal(kind, unknown));
        expect(said).toMatchObject({ kind: "invalid" });
      }
      const seer = as(reaching({ powerbi_app_ids: [mirror.sales_app] }), tx);
      await expect(
        recorded(seer, { elements: [{ kind: "metric", id: metric }] }),
      ).resolves.toEqual(expect.any(String));
    }));
});
