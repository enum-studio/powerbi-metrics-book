import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { generateSpecs } from "hono-openapi";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_RUNNER } from "../../../test/database.js";
import {
  cerbosAccess,
  closeTestPools,
  createTestDeps,
  principals,
  TEST_PUBLIC_BASE_URL,
  testPool,
} from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import {
  loadSampleMirror,
  setRole,
  type SampleMirror,
} from "../../../test/sample-mirror.js";
import { startOAuth } from "../../../test/sign-in-support.js";
import { createApp } from "../../app.js";
import { createDb } from "../../db/client.js";
import {
  powerbiColumn,
  powerbiMeasure,
  powerbiTable,
} from "../../db/schema/mirror.js";
import { assignRole } from "../../services/auth/roles.js";
import {
  createKey,
  createServiceAccount,
} from "../../services/auth/service-accounts.js";
import { getMetric, updateMetric } from "../../services/book/metrics.js";
import { createTerm, relateMetric } from "../../services/book/terms.js";
import { draftDatasets } from "../../services/book/drafter.js";
import { removeRule, setRule } from "../../services/pii/rules.js";
import {
  acceptReply,
  postThread,
  reply,
} from "../../services/threads/threads.js";
import { buildDocuments } from "../../services/search/documents.js";

/*
 * The read routes, through the whole app: real Postgres and Cerbos, the
 * sample tenant's mirror drafted once for the file, people signed in through
 * the dev sign-in, and a service account's API key.
 */

afterAll(closeTestPools);

const settings = new MemorySettings({
  "access.metadata_visibility": "everyone",
});
const oauth = startOAuth({ settings, access: cerbosAccess(settings) });
const admin = { ...oauth.deps, principal: principals.admin };
let sample: SampleMirror;

beforeAll(async () => {
  await createDb(testPool(TEST_RUNNER)).transaction(async (tx) => {
    await setRole(tx, "worker_rw");
    sample = await loadSampleMirror(tx);
    await draftDatasets(
      createTestDeps({ container: "worker", db: tx }),
      sample.tenant.datasets.map((dataset) => dataset.id),
    );
  });
}, 60_000);

/** A list's first item, whether it answers as an array or as items with a cursor; any other answer as it is. */
function first(body: unknown): unknown {
  if (Array.isArray(body)) return body[0];
  if (typeof body === "object" && body !== null && "items" in body)
    return Array.isArray(body.items) ? body.items[0] : body.items;
  return body;
}

async function get(headers: Record<string, string>, path: string) {
  const answer = await oauth.request(`/api/v1${path}`, { headers });
  const body = await answer.text();
  return {
    status: answer.status,
    body: body === "" ? null : (JSON.parse(body) as unknown),
  };
}

async function signedIn(role: "viewer" | "curator") {
  const person = await oauth.person();
  if (role !== "viewer")
    await assignRole(
      oauth.deps.db,
      { role, subject_kind: "person", subject: person.email },
      principals.admin,
    );
  const token = (await oauth.login(person.cookie)).access_token;
  return { authorization: `Bearer ${token}` };
}

describe("GET /metrics/{name}", () => {
  it("answers a service account's API key with the metric", async () => {
    const name = `reader_${randomUUID().slice(0, 8)}`;
    await createServiceAccount(admin, {
      name,
      owner_email: "owner@example.test",
      roles: ["viewer"],
      workspace_ids: sample.tenant.workspaces.map((workspace) => workspace.id),
    });
    const { key } = await createKey(admin, name, { expires_in_days: 7 });
    const byKey = { authorization: `Bearer ${key}` };
    const one = await get(byKey, "/metrics/sessions");
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ kind: "metric", name: "sessions" });
    const listed = await get(byKey, "/metrics?limit=5");
    expect(first(listed.body)).toMatchObject({ kind: "metric" });
  });
});

describe("the read routes", () => {
  it("accepts name_contains and preserves first-page totals on list routes", async () => {
    const viewer = await signedIn("viewer");
    const dataset = sample.tenant.datasets[0];
    if (dataset === undefined) throw new Error("Sample has no dataset");
    for (const path of [
      "/metrics",
      "/terms",
      "/datasets",
      `/datasets/${dataset.id}/columns`,
      `/datasets/${dataset.id}/measures`,
    ]) {
      const answer = await get(
        viewer,
        `${path}?name_contains=absent%25sample&limit=1`,
      );
      expect(answer).toMatchObject({
        status: 200,
        body: { total: 0, items: [] },
      });
    }
  });

  it("keeps a related metric's truncated summary flag over REST", async () => {
    const viewer = await signedIn("viewer");
    const original = await getMetric(admin, "sessions");
    const term = await createTerm(admin, {
      name: `summary_${randomUUID().slice(0, 8)}`,
      definition: "A sample concept.",
    });
    try {
      await updateMetric(admin, "sessions", {
        definition: "Sample summary ".repeat(30),
      });
      await relateMetric(admin, term.id, "sessions");
      const found = await get(viewer, `/terms/${term.id}`);
      expect(found.status).toBe(200);
      expect(found.body).toMatchObject({
        metrics: [
          {
            summary: expect.stringMatching(/summary…$/u) as unknown,
            summary_truncated: true,
          },
        ],
      });
    } finally {
      await updateMetric(admin, "sessions", {
        definition: original.definition,
      });
    }
  });

  it("keeps accepted answer truncation flags over REST only when cut", async () => {
    const viewer = await signedIn("viewer");
    const term = await createTerm(admin, {
      name: `answer_${randomUUID().slice(0, 8)}`,
      definition: "A sample concept.",
    });
    const question = await postThread(admin, {
      kind: "question",
      element: { kind: "term", id: term.id },
      title: "Which period?",
      body: "A sample question.",
    });
    const long = await reply(admin, question.id, "Sample answer ".repeat(200));
    await acceptReply(admin, question.id, long.id);
    expect((await get(viewer, `/terms/${term.id}`)).body).toMatchObject({
      accepted_answers: [{ excerpt_truncated: true }],
    });
    const exact = await reply(admin, question.id, "😀".repeat(2000));
    await acceptReply(admin, question.id, exact.id);
    const found = await get(viewer, `/terms/${term.id}`);
    const body = found.body as { accepted_answers: unknown[] };
    expect(body.accepted_answers[0]).toMatchObject({
      answer: "😀".repeat(2000),
    });
    expect(body.accepted_answers[0]).not.toHaveProperty("excerpt_truncated");
  });

  it("answer a person, and refuse a request with no credential", async () => {
    const viewer = await signedIn("viewer");
    const curator = await signedIn("curator");
    const made = await oauth.request("/api/v1/terms/customer_segment", {
      method: "POST",
      headers: { ...curator, "content-type": "application/json" },
      body: JSON.stringify({ definition: "A group of customers." }),
    });
    expect(made.status).toBe(201);
    const filed = await oauth.request("/api/v1/categories/sales", {
      method: "POST",
      headers: { ...curator, "content-type": "application/json" },
      body: JSON.stringify({ name: "Sales" }),
    });
    expect(filed.status).toBe(201);
    const dataset = sample.tenant.datasets[0];
    if (dataset === undefined) throw new Error("the sample has no dataset");
    const sessions = (await get(viewer, "/metrics/sessions")).body as {
      base_variants: { id: string }[];
    };
    const variant = sessions.base_variants[0]?.id ?? "";
    const routes: [string, object][] = [
      ["/conventions", { preset: expect.any(String) as unknown }],
      ["/metrics", { kind: "metric", icon: null }],
      ["/metrics/sessions", { kind: "metric", name: "sessions", icon: null }],
      ["/metrics/sessions/variants", { kind: "variant" }],
      [`/variants/${variant}`, { kind: "variant", id: variant }],
      ["/categories", { kind: "category", key: "sales", icon: null }],
      ["/terms", { kind: "term", icon: null }],
      [
        "/terms/customer_segment",
        { kind: "term", type: "concept", icon: null },
      ],
      ["/workspaces", { kind: "workspace", icon: null }],
      ["/apps", { kind: "app" }],
      ["/datasets", { kind: "dataset", icon: null }],
      [
        `/datasets/${dataset.id}`,
        { kind: "dataset", id: dataset.id, icon: null },
      ],
      [
        "/icons",
        {
          colors: expect.arrayContaining(["green"]) as unknown,
          glyphs: expect.arrayContaining(["chart-line"]) as unknown,
        },
      ],
      [`/datasets/${dataset.id}/columns`, { kind: "column" }],
      [`/datasets/${dataset.id}/measures`, { kind: "measure" }],
      [
        `/elements/dataset/${dataset.id}/docs`,
        { element: { kind: "dataset", id: dataset.id } },
      ],
    ];
    for (const [path, expected] of routes) {
      const answered = await get(viewer, path);
      expect(answered.status, path).toBe(200);
      expect(first(answered.body), path).toMatchObject(expected);
      expect((await get({}, path)).status, path).toBe(401);
    }
  });

  it("includes table summaries and date tables in dataset detail", async () => {
    const viewer = await signedIn("viewer");
    const dataset = sample.tenant.datasets[0];
    if (dataset === undefined) throw new Error("the sample has no dataset");
    const result = await get(viewer, `/datasets/${dataset.id}`);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      date_tables: expect.any(Array) as unknown,
      tables: expect.arrayContaining([
        expect.objectContaining({
          kind: expect.stringMatching(
            /^(measures|date|fact|dimension|standalone)$/,
          ) as unknown,
          column_names: expect.any(Array) as unknown,
        }),
      ]) as unknown,
    });
  });

  it("answer one column's detail, and a missing column as not found", async () => {
    const viewer = await signedIn("viewer");
    const dataset = sample.tenant.datasets[0];
    if (dataset === undefined) throw new Error("the sample has no dataset");
    const listed = await get(viewer, `/datasets/${dataset.id}/columns`);
    const { id: column } = first(listed.body) as { id: string };
    const path = `/datasets/${dataset.id}/columns/${column}`;
    const found = await get(viewer, path);
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({
      column: { id: column, kind: "column" },
      relationships: expect.any(Array) as unknown,
      used_by: expect.any(Array) as unknown,
    });
    expect((await get({}, path)).status).toBe(401);
    const missing = `/datasets/${dataset.id}/columns/${randomUUID()}`;
    expect((await get(viewer, missing)).status).toBe(404);
  });

  it("answer what `pbmb variants list` sends, by the metric's id with every filter", async () => {
    const curator = await signedIn("curator");
    const sessions = (await get(curator, "/metrics/sessions")).body as {
      id: string;
      base_variants: {
        dataset: { name: string };
        workspace: { name: string };
      }[];
    };
    const base = sessions.base_variants[0];
    if (base === undefined) throw new Error("sessions has no base variant");
    const query = new URLSearchParams({
      dataset: base.dataset.name,
      workspace: base.workspace.name,
      period: "current",
      comparison: "none",
      currency: "",
      limit: "1",
    });
    const answered = await get(
      curator,
      `/metrics/${sessions.id}/variants?${query.toString()}`,
    );
    expect(answered.status).toBe(200);
    expect(first(answered.body)).toMatchObject({
      kind: "variant",
      metric: { name: "sessions" },
      dataset: { name: base.dataset.name },
      shift: { period: "current", comparison: "none", currency: null },
    });
  });

  it("refuse input past the connector's caps", async () => {
    const viewer = await signedIn("viewer");
    const dataset = sample.tenant.datasets[0];
    if (dataset === undefined) throw new Error("Sample has no dataset");
    const custom = Array.from(
      { length: 21 },
      (_, n) => `custom.f${String(n)}=x`,
    ).join("&");
    for (const path of [
      "/metrics?limit=501",
      "/metrics?limit=0",
      `/metrics?${custom}`,
      "/terms?custom.Bad-Key=x",
      "/metrics?trust_states=bogus",
      "/search?query=sales&name_contains=sales",
      "/search?query=sales&name_prefix=sales",
      `/datasets/${dataset.id}/measures?name_prefix=Net`,
      "/metrics?not_filed=bogus",
      `/metrics/${"x".repeat(501)}`,
      "/datasets/not-an-id",
      `/datasets?workspace=${"x".repeat(501)}`,
      "/elements/metric/not-an-id/docs",
      // A NUL cannot be stored, so it is refused where text is read.
      "/metrics/a%00b",
      "/metrics?unit=a%00b",
      "/metrics?cursor=a%00b",
      "/metrics/sessions/variants?currency=a%00b",
      "/terms?custom.owner_team=a%00b",
    ])
      expect((await get(viewer, path)).status, path).toBe(400);
  });

  it("document the query of the metric and term lists, custom fields included", async () => {
    const { paths } = await generateSpecs(createApp(oauth.deps));
    type Documented = {
      get: {
        parameters: {
          name: string;
          description?: string;
          schema: { maxLength?: number };
        }[];
      };
    };
    const documentedParameters = (route: string) =>
      (paths[`/api/v1${route}`] as Documented).get.parameters;
    for (const route of ["/metrics", "/terms"]) {
      const listed = documentedParameters(route).map(({ name }) => name);
      expect(listed, route).toEqual(
        expect.arrayContaining(["limit", "trust_states", "custom.KEY"]),
      );
    }
    // The search service takes fewer and shorter custom fields than the lists do, and the document says so.
    const search = documentedParameters("/search");
    expect(search.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["query", "kinds", "unit", "custom.KEY"]),
    );
    expect(search.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(["name_contains"]),
    );
    expect(search.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(["name_prefix"]),
    );
    const searchCustom = search.find(({ name }) => name === "custom.KEY");
    expect(searchCustom?.description).toContain("At most 16");
    expect(searchCustom?.schema.maxLength).toBe(200);
  });

  it("filter on custom fields given as custom.KEY=VALUE", async () => {
    const viewer = await signedIn("viewer");
    const curator = await signedIn("curator");
    const admin = await oauth.person();
    await assignRole(
      oauth.deps.db,
      { role: "admin", subject_kind: "person", subject: admin.email },
      principals.admin,
    );
    const fields = [{ key: "owner_team", label: "Owner team", type: "text" }];
    const saved = await oauth.request("/api/v1/conventions", {
      method: "PUT",
      headers: {
        cookie: admin.cookie,
        origin: TEST_PUBLIC_BASE_URL,
        "content-type": "application/json",
      },
      body: JSON.stringify({ term_fields: { custom: fields } }),
    });
    expect(saved.status).toBe(200);
    const made = await oauth.request("/api/v1/terms/owned_term", {
      method: "POST",
      headers: { ...curator, "content-type": "application/json" },
      body: JSON.stringify({
        definition: "A term with an owner.",
        custom: { owner_team: "finance" },
      }),
    });
    expect(made.status).toBe(201);
    const matched = await get(viewer, "/terms?custom.owner_team=finance");
    expect(matched.body).toMatchObject({
      items: [{ kind: "term", name: "owned_term" }],
    });
    const none = await get(viewer, "/terms?custom.owner_team=nobody_at_all");
    expect(none.body).toMatchObject({ items: [] });
    expect(
      (await get(viewer, "/metrics?custom.owner_team=nobody_at_all")).body,
    ).toMatchObject({ items: [] });
  });

  it("search: find a metric by its alias first, show the outsider nothing, and refuse a limit of 0", async () => {
    const curator = await signedIn("curator");
    const changed = await oauth.request("/api/v1/metrics/sessions", {
      method: "PATCH",
      headers: { ...curator, "content-type": "application/json" },
      body: JSON.stringify({ aliases: ["page_visits"] }),
    });
    expect(changed.status).toBe(200);
    // The worker's embed job builds the documents search reads.
    await buildDocuments(createDb(testPool("worker_rw")));
    const viewer = await signedIn("viewer");
    const hits = await get(viewer, "/search?query=page_visits&kinds=metric");
    expect(hits.status).toBe(200);
    expect(first(hits.body)).toMatchObject({
      kind: "metric",
      name: "sessions",
      match: "exact",
      path: expect.any(Array) as unknown,
      icon: null,
      metric: null,
    });
    expect(hits.body).toMatchObject({
      counts: { metric: expect.any(Number) as unknown },
      // An OAuth token's search is logged; only the browser's is not.
      search_id: expect.any(String) as unknown,
      search_mode: expect.any(String) as unknown,
    });
    expect((await get({}, "/search?query=page_visits")).status).toBe(401);
    expect((await get(viewer, "/search?query=a&limit=0")).status).toBe(400);
    expect((await get(viewer, "/search?query=a%00b")).status).toBe(400);
    await settings.set("access.metadata_visibility", "powerbi");
    try {
      const outsider = await signedIn("viewer");
      const none = await get(outsider, "/search?query=page_visits");
      expect(none.status).toBe(200);
      expect(none.body).toMatchObject({ items: [] });
    } finally {
      await settings.set("access.metadata_visibility", "everyone");
    }
  });

  it("answer a dataset the caller may not describe exactly like a missing one", async () => {
    const dataset = sample.tenant.datasets[0];
    if (dataset === undefined) throw new Error("the sample has no dataset");
    // Under "powerbi" a person connected to no Power BI describes no dataset.
    await settings.set("access.metadata_visibility", "powerbi");
    try {
      const viewer = await signedIn("viewer");
      for (const suffix of ["", "/columns", "/measures"]) {
        const hidden = await get(viewer, `/datasets/${dataset.id}${suffix}`);
        const missing = await get(viewer, `/datasets/${randomUUID()}${suffix}`);
        expect(hidden.status, suffix).toBe(404);
        expect(hidden, suffix).toEqual(missing);
      }
    } finally {
      await settings.set("access.metadata_visibility", "everyone");
    }
  });

  it("carry pii_hidden to a viewer and pii to a pii_reader", async () => {
    const dataset = sample.tenant.datasets[0];
    if (dataset === undefined) throw new Error("the sample has no dataset");
    // Tables no other test file's sample copy has, since rules are by name.
    const own = randomUUID().slice(0, 8);
    const secrets = `Pii route ${own}`;
    const plain = `Pii route plain ${own}`;
    const worker = createDb(testPool("worker_rw"));
    const tables = await worker
      .insert(powerbiTable)
      .values(
        [secrets, plain].map((name) => ({ dataset_id: dataset.id, name })),
      )
      .returning();
    const [first, second] = tables;
    const on = (table: typeof first, name: string) => ({
      dataset_id: dataset.id,
      table_id: table?.id ?? "",
      name,
    });
    await worker
      .insert(powerbiColumn)
      .values([on(first, "Email"), on(first, "Region"), on(second, "Note")]);
    await worker
      .insert(powerbiMeasure)
      .values([on(first, "Secret total"), on(first, "Open total")]);
    const made: string[] = [];
    try {
      for (const rule of [
        { kind: "column", table_name: secrets, name: "Email" },
        { kind: "measure", table_name: secrets, name: "Secret total" },
        { kind: "table", table_name: plain },
      ] as const)
        made.push((await setRule(admin, { ...rule, pii: true })).rule.id);
      const viewer = await signedIn("viewer");
      const person = await oauth.person();
      await assignRole(
        oauth.deps.db,
        { role: "pii_reader", subject_kind: "person", subject: person.email },
        principals.admin,
      );
      const reader = {
        authorization: `Bearer ${(await oauth.login(person.cookie)).access_token}`,
      };
      type Items = {
        items: { name: string; pii?: true }[];
        pii_hidden?: number;
      };
      const where = `/datasets/${dataset.id}`;
      const list = async (who: Record<string, string>, kind: string) =>
        (
          await get(
            who,
            `${where}/${kind}?table=${encodeURIComponent(secrets)}`,
          )
        ).body as Items;

      const columns = await list(viewer, "columns");
      expect(columns.items.map((item) => item.name)).toEqual(["Region"]);
      expect(columns.pii_hidden).toBe(1);
      const own_columns = await list(reader, "columns");
      expect(own_columns.items.map((item) => [item.name, item.pii])).toEqual([
        ["Email", true],
        ["Region", undefined],
      ]);
      expect(own_columns.pii_hidden).toBeUndefined();

      const measures = await list(viewer, "measures");
      expect(measures.items.map((item) => item.name)).toEqual(["Open total"]);
      expect(measures.pii_hidden).toBe(1);
      const own_measures = await list(reader, "measures");
      expect(own_measures.items.map((item) => item.pii)).toEqual([
        undefined,
        true,
      ]);

      type Detail = {
        tables: { name: string; pii?: true }[];
        pii_hidden?: number;
      };
      const seen = (await get(viewer, where)).body as Detail;
      // The Email column and the plain table's one column.
      expect(seen.pii_hidden).toBe(2);
      expect(seen.tables.some((table) => "pii" in table)).toBe(false);
      const read = (await get(reader, where)).body as Detail;
      expect(read.pii_hidden).toBeUndefined();
      expect(read.tables.find((table) => table.name === plain)?.pii).toBe(true);
    } finally {
      for (const id of made) await removeRule(admin, id);
      await worker.delete(powerbiTable).where(
        inArray(
          powerbiTable.id,
          tables.map((table) => table.id),
        ),
      );
    }
  });
});
