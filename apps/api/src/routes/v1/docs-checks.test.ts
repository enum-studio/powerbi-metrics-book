import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  powerbiColumn,
  powerbiDataset,
  powerbiTable,
  powerbiWorkspace,
} from "../../db/schema/mirror.js";
import {
  closeTestPools,
  createTestDeps,
  principals,
  testPool,
} from "../../../test/deps.js";
import { createDb } from "../../db/client.js";
import { loadSampleMirror, setRole } from "../../../test/sample-mirror.js";
import { TEST_RUNNER } from "../../../test/database.js";
import { startOAuth } from "../../../test/sign-in-support.js";
import { MemorySettings } from "../../../test/doubles.js";
import { cerbosAccess } from "../../../test/deps.js";
import { setConventions } from "../../services/conventions/store.js";
import { assignRole } from "../../services/auth/roles.js";
import { z } from "zod";

const settings = new MemorySettings({
  "access.metadata_visibility": "everyone",
});
const oauth = startOAuth({ settings, access: cerbosAccess(settings) });
afterAll(closeTestPools);
let datasetName: string;
let otherTable: { dataset: string; table: string };
beforeAll(async () => {
  await createDb(testPool(TEST_RUNNER)).transaction(async (tx) => {
    await setRole(tx, "worker_rw");
    const sample = await loadSampleMirror(tx);
    const first = sample.tenant.datasets[0];
    if (first === undefined) throw new Error("The sample has no dataset.");
    datasetName = first.name;
    const other = sample.tenant.datasets.find(
      (row) => row.name !== first.name && row.tables.length > 0,
    );
    const table = other?.tables[0];
    if (other === undefined || table === undefined)
      throw new Error("The sample needs another dataset's table.");
    otherTable = { dataset: other.name, table: table.name };
  });
  await setConventions(createTestDeps(), principals.admin, {
    format: 1,
    exceptions: [
      {
        rule: "dataset_fields.owner",
        dataset: datasetName,
        reason: "Optional.",
      },
      {
        rule: "table_fields.caveats",
        ...otherTable,
        reason: "Optional table caveats.",
      },
    ],
  });
});
const Page = z.object({
  items: z.array(
    z.object({
      kind: z.string(),
      id: z.string(),
      name: z.string(),
      dataset: z.string(),
      results: z.array(z.object({ rule: z.string(), passed: z.boolean() })),
    }),
  ),
  failing: z.number(),
  next_cursor: z.string().nullable(),
  unused_exceptions: z.array(z.unknown()).optional(),
});

/** A signed-in person who curates, as GET /conventions/exceptions/unused asks. */
async function curatorPerson() {
  const person = await oauth.person();
  await assignRole(
    oauth.deps.db,
    { role: "curator", subject_kind: "person", subject: person.email },
    principals.admin,
  );
  return person;
}

it("requires a credential and validates paging", async () => {
  expect((await oauth.request("/api/v1/docs/checks")).status).toBe(401);
  const person = await oauth.person();
  for (const query of ["limit=0", "limit=501", "cursor=garbage"])
    expect(
      (
        await oauth.request(`/api/v1/docs/checks?${query}`, {
          headers: { cookie: person.cookie },
        })
      ).status,
    ).toBe(400);
});

it("paginates only failures, preserves totals and filters by dataset name or id", async () => {
  const person = await oauth.person();
  const get = async (query = "") => {
    const answer = await oauth.request(`/api/v1/docs/checks${query}`, {
      headers: { cookie: person.cookie },
    });
    expect(answer.status).toBe(200);
    return Page.parse(await answer.json());
  };
  const all = await get("?limit=500");
  // The unused list is a curator's.
  expect(all).not.toHaveProperty("unused_exceptions");
  const hundred = await get("?limit=100");
  expect(hundred.items).toEqual(all.items.slice(0, 100));
  expect(hundred.failing).toBe(all.failing);
  expect(hundred.next_cursor !== null).toBe(all.failing > 100);
  expect(all.failing).toBeGreaterThan(1);
  expect(
    all.items.every((row) => row.results.some((result) => !result.passed)),
  ).toBe(true);
  const first = await get("?limit=1");
  expect(first.items).toHaveLength(1);
  const ids = first.items.map((row) => row.id);
  let cursor = first.next_cursor;
  while (cursor !== null) {
    const page = await get(`?limit=1&cursor=${encodeURIComponent(cursor)}`);
    expect(page.items).toHaveLength(1);
    expect(page.failing).toBe(all.failing);
    ids.push(...page.items.map((row) => row.id));
    cursor = page.next_cursor;
  }
  expect(ids).toEqual(all.items.map((row) => row.id));
  const dataset = all.items.find((row) => row.kind === "dataset");
  expect(dataset).toBeDefined();
  const named = await get(
    `?dataset=${encodeURIComponent(dataset?.name ?? "")}`,
  );
  expect(await get(`?dataset=${dataset?.id ?? ""}`)).toEqual(named);
  expect(named.items.every((row) => row.dataset === dataset?.name)).toBe(true);
  expect(
    (
      await oauth.request("/api/v1/docs/checks?dataset=Missing", {
        headers: { cookie: person.cookie },
      })
    ).status,
  ).toBe(404);
});

it("includes a visible element exception in the existing unused route", async () => {
  const person = await curatorPerson();
  const answer = await oauth.request("/api/v1/conventions/exceptions/unused", {
    headers: { cookie: person.cookie },
  });
  expect(answer.status).toBe(200);
  expect(await answer.json()).toEqual({
    unused: [
      {
        rule: "dataset_fields.owner",
        target: { dataset: datasetName },
        reason: "Optional.",
        why: "passes",
      },
      {
        rule: "table_fields.caveats",
        target: otherTable,
        reason: "Optional table caveats.",
        why: "passes",
      },
    ],
  });
});

it("filters unused table exceptions by dataset", async () => {
  const person = await curatorPerson();
  const get = async (dataset: string) => {
    const answer = await oauth.request(
      `/api/v1/docs/checks?dataset=${encodeURIComponent(dataset)}`,
      { headers: { cookie: person.cookie } },
    );
    expect(answer.status).toBe(200);
    return Page.parse(await answer.json()).unused_exceptions;
  };
  const exception = {
    rule: "table_fields.caveats",
    target: otherTable,
    reason: "Optional table caveats.",
    why: "passes",
  };
  expect(await get(otherTable.dataset)).toContainEqual(exception);
  expect(await get(datasetName)).not.toContainEqual(exception);
});

it("pages through a dataset, table and column named in 200 CJK characters each", async () => {
  const dataset = randomUUID();
  await createDb(testPool(TEST_RUNNER)).transaction(async (tx) => {
    await setRole(tx, "worker_rw");
    const [workspace] = await tx
      .select({ id: powerbiWorkspace.id })
      .from(powerbiWorkspace)
      .limit(1);
    if (workspace === undefined)
      throw new Error("The sample has no workspace.");
    await tx.insert(powerbiDataset).values({
      id: dataset,
      workspace_id: workspace.id,
      name: "売上".repeat(100),
    });
    const [table] = await tx
      .insert(powerbiTable)
      .values({ dataset_id: dataset, name: "注文".repeat(100) })
      .returning({ id: powerbiTable.id });
    if (table === undefined) throw new Error("No table was made.");
    await tx.insert(powerbiColumn).values({
      dataset_id: dataset,
      table_id: table.id,
      name: "金額".repeat(100),
      data_type: "String",
      column_type: "data",
    });
  });
  const person = await oauth.person();
  const kinds: string[] = [];
  let cursor: string | null = "";
  while (cursor !== null) {
    const answer = await oauth.request(
      `/api/v1/docs/checks?dataset=${dataset}&limit=1${
        cursor === "" ? "" : `&cursor=${encodeURIComponent(cursor)}`
      }`,
      { headers: { cookie: person.cookie } },
    );
    expect(answer.status).toBe(200);
    const page = Page.parse(await answer.json());
    kinds.push(...page.items.map((row) => row.kind));
    cursor = page.next_cursor;
  }
  expect(kinds).toEqual(["dataset", "table", "column"]);
});
