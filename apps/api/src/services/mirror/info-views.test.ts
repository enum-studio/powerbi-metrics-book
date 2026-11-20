import { randomUUID } from "node:crypto";
import { sampleTenant, type Tenant } from "@powerbi-metrics-book/powerbi-mock";
import { and, eq, gte, like, type SQL, sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  cerbosAccess,
  closeTestPools,
  principals,
  testPool,
} from "../../../test/deps.js";
import { MemorySecrets } from "../../../test/doubles.js";
import { loadSampleMirror } from "../../../test/sample-mirror.js";
import {
  followConnect,
  type SignInFixture,
  startSignIn,
} from "../../../test/sign-in-support.js";
import type { ServiceContext } from "../../context.js";
import { createDb } from "../../db/client.js";
import { auditEvent } from "../../db/schema/audit.js";
import {
  modelViewRead,
  powerbiDataset,
  powerbiMeasure,
  powerbiRelationship,
} from "../../db/schema/mirror.js";
import { piiRule } from "../../db/schema/pii.js";
import { queryLog, queryResult } from "../../db/schema/queries.js";
import { requestRate } from "../../db/schema/rate-limit.js";
import type { Principal } from "../../principal.js";
import { MICROSOFT } from "../auth/roles.js";
import { searchQueryLog } from "../queries/log.js";
import { countRequest } from "../rate-limit.js";
import { getDataset, listColumns, listMeasures } from "./read.js";

/*
 * getDataset and listMeasures against the mock's Power BI and the sample
 * tenant's mirror, with each person signed in and connected. A person tries a
 * dataset once in five minutes, so a test that reads again moves the clock on,
 * and a caller's clock stands still from its first look: two calls on the
 * real clock could fall in two of the limit's fixed windows.
 */

const SALES = "Sales";
const MARKETING = "Marketing";
const PURPOSES = {
  RELATIONSHIPS: "Read the dataset's relationships for the catalog",
  MEASURES: "Read the dataset's measures for the catalog",
  COLUMNS: "Read the dataset's columns for the catalog",
} as const;
const worker = createDb(testPool("worker_rw"));
const reader = createDb(testPool("api_rw"));
let f: SignInFixture;
let salesModel: Tenant["datasets"][number]["relationships"];
/** Calls the api made to the mock's executeQueries since the test began. */
let reached = 0;

/** The fixture gives people and groups ids of their own; the access lists still name the sample's. */
function renameAccess(tenant: Tenant): void {
  const own = [...tenant.people, ...tenant.groups];
  const original = sampleTenant();
  const ids = new Map(
    [...original.people, ...original.groups].map((item, index) => [
      item.object_id,
      own[index]?.object_id,
    ]),
  );
  for (const item of [...tenant.workspaces, ...tenant.datasets, ...tenant.apps])
    for (const entry of item.users)
      entry.object_id = ids.get(entry.object_id) ?? entry.object_id;
}

const mockDataset = (name: string) => {
  const found = f.tenant.datasets.find((d) => d.name === name);
  if (found === undefined) throw new Error(`no ${name} in the sample`);
  return found;
};

beforeAll(async () => {
  f = await startSignIn();
  // These sign-ins reach their people through the default role.
  await f.settings.set("access.default_role", "viewer");
  renameAccess(f.tenant);
  const mock = await f.settings.get("powerbi.authority");
  await f.settings.set("powerbi.api_url", `${mock}/powerbi`);
  await f.settings.set("access.metadata_visibility", "everyone");
  await loadSampleMirror(worker);
  salesModel = structuredClone(mockDataset(SALES).relationships);
});

afterAll(async () => {
  await f.close();
  await closeTestPools();
});

const datasetRow = (name: string) =>
  eq(powerbiDataset.id, mockDataset(name).id);

/** The dataset as the sync leaves it before anyone has asked: nothing read, no folders, no relationships. */
async function unread(name: string): Promise<void> {
  const { id } = mockDataset(name);
  await worker
    .update(powerbiDataset)
    .set({
      relationships_source: null,
      relationships_read_at: null,
      schema_changed_at: null,
      removed_at: null,
      custom: {},
    })
    .where(datasetRow(name));
  await worker
    .update(powerbiMeasure)
    .set({ display_folder: null })
    .where(eq(powerbiMeasure.dataset_id, id));
  await worker
    .delete(powerbiRelationship)
    .where(eq(powerbiRelationship.dataset_id, id));
}

beforeEach(async () => {
  reached = 0;
  await unread(SALES);
  await unread(MARKETING);
  const migrator = createDb(testPool("migrator"));
  await migrator
    .delete(requestRate)
    .where(like(requestRate.key, "relationships:%"));
  await migrator.delete(modelViewRead);
});

afterEach(() => {
  mockDataset(SALES).relationships = structuredClone(salesModel);
  mockDataset(SALES).refuses_info_views = false;
});

function contextFor(principal: Principal): ServiceContext {
  let at: Date | undefined;
  return {
    ...f.deps,
    clock: () => (at ??= new Date()),
    fetcher: {
      ...f.deps.fetcher,
      fetchFixed: (url, init) => {
        if (String(url).endsWith("/executeQueries")) reached += 1;
        return f.deps.fetcher.fetchFixed(url, init);
      },
    },
    access: cerbosAccess(f.settings),
    secrets: new MemorySecrets([
      ["powerbi_app_client_secret", "sample-app-secret"],
      ["result_link_key", "test-result-link-key"],
    ]),
    principal,
  };
}

async function connected(mailbox: string) {
  const who = f.person(mailbox);
  const { cookie } = await f.signIn(who, MICROSOFT);
  expect((await followConnect(f.app, cookie)).answer.status).toBe(302);
  return contextFor({ ...principals.viewer, id: await f.userId(who.email) });
}

/** The same caller, `minutes` on: past the five minutes before it may try a dataset again. */
const later = (context: ServiceContext, minutes: number): ServiceContext => ({
  ...context,
  clock: () => new Date(Date.now() + minutes * 60_000),
});

const modelFolders = (name: string) =>
  mockDataset(name).tables.flatMap((t) =>
    t.measures.map((m) => [m.name, m.display_folder]),
  );

type Ends = Record<
  "from_table" | "from_column" | "to_table" | "to_column",
  string
>;
const ends = (r: Ends) =>
  `${r.from_table}.${r.from_column} to ${r.to_table}.${r.to_column}`;

/** Every relationship row of the dataset, removed ones too, by their ends. */
async function storedRelationships(name: string) {
  const rows = await worker
    .select()
    .from(powerbiRelationship)
    .where(eq(powerbiRelationship.dataset_id, mockDataset(name).id));
  return new Map(rows.map((row) => [ends(row), row]));
}

describe("ensureModelDetails, through getDataset and listMeasures", () => {
  it("skips the query rate check and row reservation for model-view reads", async () => {
    const analyst = await connected("analyst");
    const rate = await f.settings.get("queries.rate_per_minute");
    const budget = await f.settings.get("results.daily_row_budget");
    await f.settings.set("queries.rate_per_minute", 1);
    await f.settings.set("results.daily_row_budget", 1);
    try {
      const answer = await getDataset(analyst, SALES);
      expect(answer.relationships_source).toBe("info_view");
      expect(answer).not.toHaveProperty("relationships_current");
    } finally {
      await f.settings.set("queries.rate_per_minute", rate);
      await f.settings.set("results.daily_row_budget", budget);
    }
  });

  it("reads a PII dataset's model views internally and deletes their results", async () => {
    const analyst = await connected("analyst");
    const ruleId = randomUUID();
    await reader.insert(piiRule).values({
      id: ruleId,
      kind: "table",
      table_name: "Sales lines",
      name: null,
      pii: true,
      set_by_kind: "person",
      set_by_id: "test",
      set_via: "api",
    });
    try {
      const since = new Date();
      const answer = await getDataset(analyst, SALES);
      expect(answer.relationships_source).toBe("info_view");
      // Stored for the query check, though hidden from the analyst: every one has an end on Sales lines.
      expect((await storedRelationships(SALES)).size).toBeGreaterThan(0);
      expect(answer.relationships).toEqual([]);
      const logs = await reader
        .select({ origin: queryLog.origin, result_id: queryLog.result_id })
        .from(queryLog)
        .where(
          and(
            eq(queryLog.principal_id, analyst.principal.id),
            gte(queryLog.at, since),
          ),
        );
      // The log never points to a catalog read's rows, which name personal-data columns.
      expect(logs).toEqual(
        Array.from({ length: 3 }, () => ({
          origin: "catalog",
          result_id: null,
        })),
      );
      expect(
        await reader
          .select()
          .from(auditEvent)
          .where(
            and(
              eq(auditEvent.principal_id, analyst.principal.id),
              gte(auditEvent.at, since),
            ),
          ),
      ).toEqual([]);
      expect(
        await reader
          .select({ id: queryResult.id })
          .from(queryResult)
          .where(
            and(
              eq(queryResult.owner_id, analyst.principal.id),
              gte(queryResult.created_at, since),
            ),
          ),
      ).toEqual([]);
    } finally {
      await reader.delete(piiRule).where(eq(piiRule.id, ruleId));
    }
  });

  it("reads once with the person's token, stores what Power BI says, and makes no call the second time", async () => {
    // A clock that moves on at every look: the read is stamped with the first.
    const start = Date.now();
    let ticks = 0;
    const admin = {
      ...(await connected("admin")),
      clock: () => new Date(start + 1000 * ticks++),
    };
    const first = await getDataset(admin, SALES);
    expect(reached).toBe(3);
    expect(first).toMatchObject({
      relationships_source: "info_view",
      relationships_read_at: new Date(start),
      relationships_note: null,
    });
    const model = mockDataset(SALES).relationships;
    expect(model.some((r) => !r.is_active)).toBe(true);
    const shape = (r: Ends & { is_active: boolean }) => [ends(r), r.is_active];
    expect(first.relationships.map(shape).sort()).toEqual(
      model.map(shape).sort(),
    );
    expect(first.relationships[0]).toMatchObject({
      cardinality: "many_to_one",
      cross_filtering_behavior: "one_direction",
    });
    const second = await getDataset(admin, SALES);
    const { items } = await listMeasures(admin, { dataset: SALES });
    expect(reached).toBe(3);
    expect(second).toMatchObject({
      relationships: first.relationships,
      relationships_read_at: first.relationships_read_at,
    });
    const folders = modelFolders(SALES);
    expect(folders.some(([, folder]) => folder !== null)).toBe(true);
    expect(items.map((m) => [m.name, m.display_folder]).sort()).toEqual(
      folders.sort(),
    );
    const { items: columns } = await listColumns(admin, { dataset: SALES });
    const year = columns.find(
      (c) => c.table.name === "Date" && c.name === "Year",
    );
    expect(year?.display_folder).toBe("Dates\\Fiscal");
    expect(
      columns.find((c) => c.table.name === "Date" && c.name === "Date")
        ?.display_folder,
    ).toBeNull();
  });

  it("stores a blank display folder as none, for a measure and for a column", async () => {
    const dataset = mockDataset(SALES);
    const measure = dataset.tables.flatMap((t) => t.measures)[0];
    const column = dataset.tables
      .flatMap((t) => t.columns)
      .find((c) => c.display_folder == null);
    if (measure === undefined || column === undefined)
      throw new Error("the sample has no measure or unfiled column");
    const folder = measure.display_folder;
    measure.display_folder = "";
    column.display_folder = "";
    try {
      const admin = await connected("admin");
      await getDataset(admin, SALES);
      const { items } = await listMeasures(admin, { dataset: SALES });
      expect(
        items.find((m) => m.name === measure.name)?.display_folder,
      ).toBeNull();
      const { items: columns } = await listColumns(admin, { dataset: SALES });
      expect(
        columns.find((c) => c.name === column.name)?.display_folder,
      ).toBeNull();
    } finally {
      measure.display_folder = folder;
      column.display_folder = undefined;
    }
  });

  it("answers two overlapping requests from one person with the one read, both with the relationships", async () => {
    const admin = await connected("admin");
    const answers = await Promise.all([
      getDataset(admin, SALES),
      getDataset(admin, SALES),
    ]);
    expect(reached).toBe(3);
    const model = mockDataset(SALES).relationships.map(ends).sort();
    for (const answer of answers) {
      expect(answer).toMatchObject({
        relationships_source: "info_view",
        relationships_note: null,
      });
      expect(answer.relationships.map(ends).sort()).toEqual(model);
    }
  });

  /** What a reader that is still running, or that stopped mid-read, leaves: its count, and its row. */
  async function readInFlight(context: ServiceContext, startedAt: SQL) {
    await countRequest(
      reader,
      `relationships:${context.principal.id}:${mockDataset(SALES).id}`,
      { window_seconds: 5 * 60, max: 1 },
      context.clock(),
    );
    await reader.insert(modelViewRead).values({
      user_id: context.principal.id,
      dataset_id: mockDataset(SALES).id,
      started_at: startedAt,
    });
  }

  it("does not wait on a read whose reader died, and says relationships are unknown for now", async () => {
    const admin = await connected("admin");
    await readInFlight(admin, sql`now() - interval '1 minute'`);
    const started = performance.now();
    const answer = await getDataset(admin, SALES);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(reached).toBe(0);
    expect(answer.relationships_note).toMatch(
      /^Relationships are unknown for now/,
    );
  });

  it("stops waiting on a running read when the caller goes away", async () => {
    const admin = await connected("admin");
    await readInFlight(admin, sql`now()`);
    const gone = new AbortController();
    setTimeout(() => {
      gone.abort();
    }, 300);
    const started = performance.now();
    const answer = await getDataset({ ...admin, signal: gone.signal }, SALES);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(reached).toBe(0);
    expect(answer.relationships_note).toMatch(
      /^Relationships are unknown for now/,
    );
  });

  it("records a dataset that refuses the INFO functions as unavailable, says how to ask, and does not ask again", async () => {
    const admin = await connected("admin");
    const answer = await getDataset(admin, MARKETING);
    // The relationships view is refused, so the measures view is never run.
    expect(reached).toBe(1);
    expect(answer).toMatchObject({
      relationships_source: "unavailable",
      relationships: [],
    });
    expect(answer.relationships_read_at).toBeInstanceOf(Date);
    expect(answer.relationships_note).toMatch(
      /^Relationships are unknown\. Power BI refuses the INFO functions.*Ask its owner in Power BI/,
    );
    await getDataset(admin, MARKETING);
    await listMeasures(admin, { dataset: MARKETING });
    expect(reached).toBe(1);
  });

  it("keeps the relationships and folders already stored when the INFO functions are then refused", async () => {
    const admin = await connected("admin");
    const first = await getDataset(admin, SALES);
    const ids = first.relationships.map((r) => r.id).sort();
    mockDataset(SALES).refuses_info_views = true;
    await worker
      .update(powerbiDataset)
      .set({ schema_changed_at: new Date(Date.now() + 60_000) })
      .where(datasetRow(SALES));
    const refused = await getDataset(later(admin, 6), SALES);
    expect(refused.relationships_source).toBe("unavailable");
    expect(refused.relationships_note).toMatch(
      /^Relationships are unknown\..*may be out of date\.$/,
    );
    expect(refused.relationships.map((r) => r.id).sort()).toEqual(ids);
    const { items } = await listMeasures(admin, { dataset: SALES });
    expect(items.map((m) => [m.name, m.display_folder]).sort()).toEqual(
      modelFolders(SALES).sort(),
    );
  });

  it("writes nothing when a person without Build asks first, and a person with it then reads and stores", async () => {
    const leader = await connected("leader");
    const refused = await getDataset(leader, SALES);
    expect(reached).toBe(1);
    expect(refused).toMatchObject({
      relationships_source: null,
      relationships_read_at: null,
      relationships: [],
    });
    expect(refused.relationships_note).toBe(
      "Relationships are unknown. Power BI refused the query for your connection, most often because you lack the Build right on this dataset; ask its owner in Power BI.",
    );
    // Not tried again for this person within five minutes.
    const again = await getDataset(leader, SALES);
    expect(reached).toBe(1);
    expect(again.relationships_note).toMatch(
      /^Relationships are unknown for now/,
    );

    const admin = await connected("admin");
    const read = await getDataset(admin, SALES);
    expect(read).toMatchObject({
      relationships_source: "info_view",
      relationships_note: null,
    });
    expect(read.relationships).toHaveLength(
      mockDataset(SALES).relationships.length,
    );
    // What the person with Build stored is shown to the one without.
    const shown = await getDataset(leader, SALES);
    expect(reached).toBe(4);
    expect(shown.relationships_note).toBeNull();
    expect(shown.relationships).toEqual(read.relationships);
  });

  it("reads again once the dataset's schema has changed, whether it was read or refused", async () => {
    const admin = await connected("admin");
    await getDataset(admin, SALES);
    await getDataset(admin, MARKETING);
    expect(reached).toBe(4);
    const changed = new Date(Date.now() + 60_000);
    for (const name of [SALES, MARKETING])
      await worker
        .update(powerbiDataset)
        .set({ schema_changed_at: changed })
        .where(datasetRow(name));
    await listMeasures(later(admin, 6), { dataset: SALES });
    expect(reached).toBe(7);
    await getDataset(later(admin, 6), MARKETING);
    expect(reached).toBe(8);
  });

  it("keeps a relationship's row while Power BI gives it, marks one it stops giving removed, and brings it back as the same row", async () => {
    const admin = await connected("admin");
    const [dropped, ...kept] = salesModel;
    if (dropped === undefined) throw new Error("the sample Sales has no model");
    const added = {
      ...dropped,
      from_column: "Region key",
      to_table: "Region",
      cross_filtering_behavior: "BothDirections" as const,
    };
    await getDataset(admin, SALES);
    const before = await storedRelationships(SALES);
    const changeSchema = (minutes: number) =>
      worker
        .update(powerbiDataset)
        .set({ schema_changed_at: new Date(Date.now() + minutes * 60_000) })
        .where(datasetRow(SALES));

    mockDataset(SALES).relationships = [...kept, added];
    await changeSchema(1);
    const answer = await getDataset(later(admin, 6), SALES);
    const after = await storedRelationships(SALES);
    expect(answer.relationships.map(ends).sort()).toEqual(
      [...kept, added].map(ends).sort(),
    );
    for (const r of kept)
      expect(after.get(ends(r))?.id).toBe(before.get(ends(r))?.id);
    const gone = after.get(ends(dropped));
    expect(gone?.id).toBe(before.get(ends(dropped))?.id);
    expect(gone?.removed_at).toBeInstanceOf(Date);
    expect(after.get(ends(added))).toMatchObject({
      removed_at: null,
      cardinality: "many_to_one",
      cross_filtering_behavior: "both_directions",
    });
    mockDataset(SALES).relationships = [...kept, added, dropped];
    await changeSchema(8);
    await getDataset(later(admin, 12), SALES);
    const back = await storedRelationships(SALES);
    expect(back.get(ends(dropped))).toMatchObject({
      id: before.get(ends(dropped))?.id,
      removed_at: null,
    });
    expect(back.size).toBe(salesModel.length + 1);
  });

  it("logs both queries under the person, with the purpose", async () => {
    // Nobody else here is the analyst, and later-clocked reads log at later times.
    const analyst = await connected("analyst");
    const since = new Date();
    await getDataset(analyst, SALES);
    const { items } = await searchQueryLog(analyst, { mine: true, since });
    expect(items).toHaveLength(3);
    expect(
      items.every((entry) =>
        entry.dax.startsWith("EVALUATE SELECTCOLUMNS(INFO.VIEW."),
      ),
    ).toBe(true);
    for (const entry of items) {
      const view = /INFO\.VIEW\.(RELATIONSHIPS|MEASURES|COLUMNS)\(/.exec(
        entry.dax,
      )?.[1] as keyof typeof PURPOSES;
      expect(entry).toMatchObject({
        purpose: PURPOSES[view],
        status: "succeeded",
      });
      expect(entry.principal.id).toBe(analyst.principal.id);
    }
  });

  it("never reads for a service account, or for a person who has not connected, and says relationships are unknown", async () => {
    // A service account holds the workspaces its admin gave it.
    const workspace = mockDataset(SALES).workspace_id;
    const account: Principal = {
      ...principals.viewer,
      kind: "service_account",
      id: "catalog-reader",
      attributes: {
        ...principals.viewer.attributes,
        powerbi_workspace_ids: [workspace],
      },
    };
    const stranger = { ...principals.viewer, id: `nobody-${randomUUID()}` };
    const unknown = { relationships_source: null, relationships: [] };
    const first = await getDataset(contextFor(account), SALES);
    expect(first).toMatchObject(unknown);
    const second = await getDataset(contextFor(stranger), SALES);
    expect(second).toMatchObject(unknown);
    for (const { relationships_note } of [first, second])
      expect(relationships_note).toMatch(
        /^Relationships are unknown\. They are read with a person's own.*settings\/connections/,
      );
    expect(reached).toBe(0);
  });

  it("does not repeat a read that failed within five minutes, and reads after them", async () => {
    const admin = await connected("admin");
    f.failNext("/powerbi/v1.0/myorg/datasets/", 500);
    const failed = await getDataset(admin, SALES);
    expect(reached).toBe(1);
    expect(failed).toMatchObject({
      relationships_source: null,
      relationships: [],
    });
    const note =
      /^Relationships are unknown for now\. They were tried a moment ago/;
    expect(failed.relationships_note).toMatch(note);
    const again = await getDataset(admin, SALES);
    expect(reached).toBe(1);
    expect(again.relationships_note).toMatch(note);

    const next = await getDataset(later(admin, 6), SALES);
    expect(reached).toBe(4);
    expect(next).toMatchObject({
      relationships_source: "info_view",
      relationships_note: null,
    });
  });

  it("writes nothing on the dataset when Cerbos refuses the query, and answers that relationships are unknown", async () => {
    const admin = await connected("admin");
    const setCustom = (custom: Record<string, unknown>) =>
      worker.update(powerbiDataset).set({ custom }).where(datasetRow(SALES));
    await setCustom({ queries_off: true });
    const refused = await getDataset(admin, SALES);
    // Cerbos decides before Power BI is asked.
    expect(reached).toBe(0);
    expect(refused).toMatchObject({
      relationships_source: null,
      relationships_read_at: null,
      relationships: [],
    });
    expect(refused.relationships_note).toMatch(
      /^Relationships are unknown\. Power BI does not show this dataset to your connection, or your access here does not let you query it/,
    );
    // The dataset was not marked: once queries are on again, it reads.
    await setCustom({});
    const read = await getDataset(later(admin, 6), SALES);
    expect(reached).toBe(3);
    expect(read.relationships_source).toBe("info_view");
  });

  it("never reads a removed dataset, and does not count it against the person's five minutes", async () => {
    const admin = await connected("admin");
    const setRemoved = (removed_at: Date | null) =>
      worker
        .update(powerbiDataset)
        .set({ removed_at })
        .where(datasetRow(SALES));
    await setRemoved(new Date());
    await listMeasures(admin, { dataset: SALES, removed: true });
    expect(reached).toBe(0);
    // The same person, in the same five minutes, reads it once it is back.
    await setRemoved(null);
    const read = await getDataset(admin, SALES);
    expect(reached).toBe(3);
    expect(read.relationships_source).toBe("info_view");
  });
});
