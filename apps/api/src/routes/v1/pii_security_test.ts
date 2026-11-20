import { randomUUID } from "node:crypto";
import { HTTP } from "@cerbos/http";
import { sampleTenant } from "@powerbi-metrics-book/powerbi-mock";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  cerbosAccess,
  closeTestPools,
  principals,
  testPool,
} from "../../../test/deps.js";
import { waitingOn } from "../../../test/locks.js";
import { MemorySecrets } from "../../../test/doubles.js";
import { loadSampleMirror } from "../../../test/sample-mirror.js";
import {
  followConnect,
  fromSpa,
  startOAuth,
  startSignIn,
  toolAnswer,
  type SignInFixture,
} from "../../../test/sign-in-support.js";
import { createApp } from "../../app.js";
import { createDb } from "../../db/client.js";
import { auditEvent } from "../../db/schema/audit.js";
import {
  metric,
  metricVariant,
  term,
  termColumn,
} from "../../db/schema/book.js";
import { powerbiDataset, powerbiRelationship } from "../../db/schema/mirror.js";
import { piiRule } from "../../db/schema/pii.js";
import {
  type PiiRule,
  removeRule,
  saveRule,
} from "../../services/pii/rules.js";
import { queryResult } from "../../db/schema/queries.js";
import { assignRole, MICROSOFT } from "../../services/auth/roles.js";
import {
  createKey,
  createServiceAccount,
} from "../../services/auth/service-accounts.js";
import {
  buildDocuments,
  collectDocuments,
} from "../../services/search/documents.js";

const worker = createDb(testPool("worker_rw"));
const db = createDb(testPool("api_rw"));
const sales = sampleTenant().datasets.find((d) =>
  d.tables.some((t) => t.name === "Sales lines"),
);
if (sales === undefined)
  throw new Error("The sample has no Sales lines table.");
const dataset = sales.id;
const metricId = randomUUID();
const base = randomUUID();
const shifted = randomUUID();
const termId = randomUUID();
const hiddenMetric = randomUUID();
let column = "";
let measure = "";
let clearedColumn = "";
let f: SignInFixture;
let oauth: ReturnType<typeof startOAuth>;
type Person = { id: string; cookie: string; token: string };
const people: Person[] = [];
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const queryCases = [
  [
    "qualified",
    'EVALUATE ROW("value", MAX(Customer[Customer]))',
    "Customer[Customer]",
  ],
  ["measure rule", 'EVALUATE ROW("value", [Net sales])', "[Net sales]"],
  [
    "column rule",
    `EVALUATE ROW("value", MAX('Sales lines'[Product key]))`,
    "'Sales lines'[Product key]",
  ],
  ["relationship from", "EVALUATE TOPN(1, Product)", "the table Product"],
  ["bare", 'EVALUATE ROW("value", [Customer])', "[Customer]"],
  ["whole table", "EVALUATE TOPN(1, Customer)", "the table Customer"],
  [
    "model wide",
    "EVALUATE COLUMNSTATISTICS()",
    "the function COLUMNSTATISTICS",
  ],
  [
    "relationship end",
    `EVALUATE ROW("value", MAX('Sales lines'[Customer key]))`,
    "'Sales lines'[Customer key]",
  ],
] as const;

beforeAll(async () => {
  f = await startSignIn();
  const originals = [...sampleTenant().people, ...sampleTenant().groups];
  const own = [...f.tenant.people, ...f.tenant.groups];
  for (const item of [
    ...f.tenant.workspaces,
    ...f.tenant.datasets,
    ...f.tenant.apps,
  ])
    for (const user of item.users) {
      const replacement =
        own[originals.findIndex((p) => p.object_id === user.object_id)];
      if (replacement !== undefined) user.object_id = replacement.object_id;
    }
  await f.settings.set(
    "powerbi.api_url",
    `${await f.settings.get("powerbi.authority")}/powerbi`,
  );
  await f.settings.set("access.metadata_visibility", "everyone");
  const sample = await loadSampleMirror(worker);
  column = sample.columnId({
    dataset: sales.name,
    table: "Customer",
    column: "Customer",
  });
  clearedColumn = sample.columnId({
    dataset: sales.name,
    table: "Customer",
    column: "Region",
  });
  measure = sample.measureId({ dataset: sales.name, measure: "Net sales" });
  await worker
    .update(powerbiDataset)
    .set({ relationships_source: "scanner", relationships_read_at: new Date() })
    .where(eq(powerbiDataset.id, dataset));
  await worker.insert(powerbiRelationship).values([
    {
      dataset_id: dataset,
      from_table: "Sales lines",
      from_column: "Customer key",
      to_table: "Customer",
      to_column: "Customer key",
      cardinality: "many_to_one",
    },
    {
      dataset_id: dataset,
      from_table: "Sales lines",
      from_column: "Product key",
      to_table: "Product",
      to_column: "Product key",
      cardinality: "many_to_one",
    },
  ]);
  await f.settings.set("questions.enabled", true);
  oauth = startOAuth({
    settings: f.settings,
    vault: f.deps.vault,
    access: cerbosAccess(f.settings),
    secrets: new MemorySecrets([
      ["powerbi_app_client_secret", "sample-app-secret"],
      ["result_link_key", "test-link-key"],
    ]),
  });
  oauth.deps.fetcher.fetchFixed = (url, init) =>
    f.deps.fetcher.fetchFixed(url, init);
  for (const mailbox of ["viewer", "analyst", "admin"]) {
    const who = f.person(mailbox);
    await assignRole(
      db,
      {
        role: mailbox === "admin" ? "admin" : "viewer",
        subject_kind: "person",
        subject: who.email,
      },
      principals.admin,
    );
    if (mailbox === "analyst")
      await assignRole(
        db,
        { role: "pii_reader", subject_kind: "person", subject: who.email },
        principals.admin,
      );
    const { cookie } = await f.signIn(who, MICROSOFT);
    expect((await followConnect(f.app, cookie)).answer.status).toBe(302);
    people.push({
      id: await f.userId(who.email),
      cookie,
      token: (await oauth.connect(cookie, oauth.client())).access_token,
    });
  }
  const [, , admin] = people;
  if (admin === undefined) throw new Error("Missing admin.");
  await db.insert(piiRule).values(
    [
      { kind: "table" as const, table_name: "Customer", name: null },
      {
        kind: "measure" as const,
        table_name: "Sales lines",
        name: "Net sales",
      },
      { kind: "measure" as const, table_name: "Sales lines", name: "Orders" },
      {
        kind: "column" as const,
        table_name: "Sales lines",
        name: "Product key",
      },
      {
        kind: "column" as const,
        table_name: "Customer",
        name: "Region",
        pii: false,
      },
    ].map((rule) => ({
      pii: true,
      ...rule,
      set_by_kind: "person",
      set_by_id: admin.id,
      set_via: "browser",
    })),
  );
  await db.insert(metric).values({
    id: metricId,
    name: "pii_metric",
    label: "PII metric",
    origin: "sync",
  });
  await db.insert(metricVariant).values([
    { id: base, metric_id: metricId, measure_id: measure, assigned_by: "sync" },
    {
      id: shifted,
      metric_id: metricId,
      measure_id: sample.measureId({
        dataset: sales.name,
        measure: "Net sales LY",
      }),
      assigned_by: "sync",
      period: "previous_year",
      reads_selection: true,
      selection_columns: ["Customer[Customer]", "'Sales lines'[Date]"],
    },
  ]);
  await db.insert(metric).values({
    id: hiddenMetric,
    name: "pii_only_metric",
    label: "PII only metric",
    origin: "sync",
  });
  await db.insert(metricVariant).values({
    metric_id: hiddenMetric,
    measure_id: sample.measureId({ dataset: sales.name, measure: "Orders" }),
    assigned_by: "sync",
  });
  await db.insert(term).values({ id: termId, name: "PII dimension" });
  await db.insert(termColumn).values({ term_id: termId, column_id: column });
  await buildDocuments(worker);
  const mock = f.tenant.datasets.find((d) => d.id === dataset);
  if (mock === undefined) throw new Error("The mock has no dataset.");
  for (const [, dax] of queryCases)
    mock.recorded_queries.push({ dax, rows: [{ "[value]": 1 }] });
  mock.recorded_queries.push({
    dax: 'EVALUATE ROW("backstop", 1)',
    rows: [{ "Customer[Customer]": "Sample customer" }],
  });
});
afterAll(async () => {
  await f.close();
  await closeTestPools();
});

async function call(
  person: Person,
  transport: string,
  tool: string,
  extra: { name?: string; dataset?: string; [key: string]: unknown } = {},
): Promise<unknown> {
  const endpoints: Record<string, [string, object]> = {
    list_columns: [`/datasets/${dataset}/columns`, { dataset }],
    list_measures: [`/datasets/${dataset}/measures`, { dataset }],
    get_dataset: [`/datasets/${dataset}`, { id: dataset }],
    list_relationships: ["", { dataset }],
    list_variants: [`/metrics/${metricId}/variants`, { metric: metricId }],
    get_variant: [`/variants/${String(extra.id)}`, {}],
    get_metric: [`/metrics/${extra.name ?? metricId}`, { name: metricId }],
    list_metrics: ["/metrics", {}],
    get_term: [`/terms/${termId}`, { name: termId }],
    list_terms: [
      extra.dataset === undefined
        ? "/terms"
        : `/terms?dataset=${extra.dataset}`,
      {},
    ],
    search: [
      `/search?query=${String(extra.query)}&dataset=${dataset}`,
      { dataset },
    ],
    execute_dax: ["/queries", { dataset }],
    post_thread: ["/threads", {}],
    list_threads: ["/threads", {}],
    get_thread: [`/threads/${String(extra.thread_id)}`, {}],
  };
  const endpoint = endpoints[tool];
  if (endpoint === undefined) throw new Error(`No route for ${tool}`);
  const [path, defaults] = endpoint;
  const args = { ...defaults, ...extra };
  const write = tool === "execute_dax" || tool === "post_thread";
  const answer =
    transport === "REST"
      ? await oauth.request(
          `/api/v1${path}`,
          write
            ? fromSpa(person.cookie, args)
            : { headers: { cookie: person.cookie } },
        )
      : await oauth.request("/api/mcp", {
          method: "POST",
          headers: {
            ...bearer(person.token),
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: tool,
              // The most a list takes, so what these tests see is not narrowed by its default.
              arguments: tool.startsWith("list_")
                ? { limit: 100, ...args }
                : args,
            },
          }),
        });
  const body: unknown =
    transport === "REST" ? await answer.json() : await toolAnswer(answer);
  const error =
    typeof body === "object" && body !== null && "error" in body
      ? body.error
      : undefined;
  expect(answer.status).toBe(
    transport === "MCP"
      ? 200
      : error === "refused"
        ? 403
        : error === "not_found"
          ? 404
          : write
            ? 201
            : 200,
  );
  return body;
}
const containing = (value: object): unknown => expect.objectContaining(value);
const including = (items: unknown[]): unknown => expect.arrayContaining(items);
const mentioning = (value: string): unknown => expect.stringContaining(value);
const pageWith = (id: string) => ({ items: including([containing({ id })]) });

const denials = (principal: string) =>
  db
    .select()
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.principal_id, principal),
        eq(auditEvent.action, "query.pii_refused"),
      ),
    );
async function expectNewDenial(
  principal: string,
  before: Awaited<ReturnType<typeof denials>>,
  reference: string,
) {
  const after = await denials(principal);
  expect(after).toHaveLength(before.length + 1);
  expect(
    after.filter((row) => !before.some((old) => old.id === row.id)),
  ).toEqual([
    containing({
      decision: "deny",
      detail: { dataset_id: dataset, references: [reference] },
    }),
  ]);
}

describe.each(["REST", "MCP"])("PII through %s", (transport) => {
  it("filters columns, measures, table counts and relationship ends for viewers", async () => {
    for (const [index, person] of people.slice(0, 2).entries()) {
      const reads = index === 1;
      for (const [kind, hidden, present] of [
        ["columns", 4, column],
        ["measures", 2, measure],
      ] as const) {
        const body = await call(person, transport, `list_${kind}`);
        if (kind === "columns")
          expect(body).toMatchObject(pageWith(clearedColumn));
        if (reads) {
          expect(body).toMatchObject({
            items: including([containing({ id: present, pii: true })]),
          });
          expect(body).not.toHaveProperty("pii_hidden");
        } else {
          expect(body).toMatchObject({ pii_hidden: hidden });
          expect(body).not.toMatchObject(pageWith(present));
        }
      }
      const detail = await call(person, transport, "get_dataset");
      if (reads) expect(detail).not.toHaveProperty("pii_hidden");
      else expect(detail).toMatchObject({ pii_hidden: 4 });
      if (transport === "MCP") {
        const relationships = await call(
          person,
          transport,
          "list_relationships",
        );
        expect(relationships).toMatchObject({
          items: (detail as { relationships?: unknown[] }).relationships ?? [],
        });
        if (reads) expect(relationships).not.toHaveProperty("pii_hidden");
        else expect(relationships).toMatchObject({ pii_hidden: 2 });
      }
      const customer = {
        name: "Customer",
        column_count: reads ? 4 : 1,
        ...(reads ? { pii: true } : {}),
      };
      expect(detail).toMatchObject({
        tables: including([
          containing(customer),
          containing({
            name: "Sales lines",
            measure_count:
              sales.tables
                .filter((table) => table.name === "Sales lines")
                .flatMap((table) => table.measures).length - (reads ? 0 : 2),
          }),
        ]),
        relationships: reads
          ? [
              containing({ from_column: "Customer key" }),
              containing({ from_column: "Product key" }),
            ]
          : [],
      });
    }
  });

  it("filters variants, metrics, selections, terms and indexed search", async () => {
    for (const [index, person] of people.slice(0, 2).entries()) {
      const reads = index === 1;
      const variants = await call(person, transport, "list_variants");
      expect(variants).toMatchObject(pageWith(shifted));
      expect(JSON.stringify(variants).includes(base)).toBe(reads);
      const variant = await call(person, transport, "get_variant", {
        id: base,
      });
      expect(variant).toMatchObject(
        reads ? { id: base } : { error: "not_found" },
      );
      expect(
        await call(person, transport, "get_variant", { id: shifted }),
      ).toMatchObject({
        selection_columns: reads
          ? ["Customer[Customer]", "'Sales lines'[Date]"]
          : ["'Sales lines'[Date]"],
      });
      const metricBody = await call(person, transport, "get_metric");
      expect(metricBody).toMatchObject({
        base_variants: reads ? [containing({ id: base })] : [],
      });
      expect(
        await call(person, transport, "get_metric", { name: hiddenMetric }),
      ).toMatchObject(reads ? { id: hiddenMetric } : { error: "not_found" });
      expect(
        JSON.stringify(await call(person, transport, "list_metrics")).includes(
          hiddenMetric,
        ),
      ).toBe(reads);
      expect(
        await call(person, transport, "search", { query: "Net sales" }),
      ).not.toMatchObject(pageWith(base));
      const documents = await collectDocuments(worker);
      expect(documents.map((doc) => doc.element_id)).not.toContain(column);
      expect(documents.map((doc) => doc.element_id)).not.toContain(base);
      const termBody = await call(person, transport, "get_term");
      expect(JSON.stringify(termBody).includes(column)).toBe(reads);
      const terms = await call(person, transport, "list_terms");
      expect(terms).toMatchObject(pageWith(termId));
      expect(JSON.stringify(terms)).not.toContain(column);
      expect(
        JSON.stringify(
          await call(person, transport, "list_terms", { dataset }),
        ).includes(termId),
      ).toBe(reads);
      const found = await call(person, transport, "search", {
        query: "Customer",
      });
      expect(found).not.toMatchObject(pageWith(column));
      expect(
        await call(person, transport, "search", { query: "Date" }),
      ).toMatchObject({ items: including([containing({ name: "Date" })]) });
    }
  });

  it.each(queryCases)(
    "refuses %s with a deny row and lets the PII reader query",
    async (_kind, dax, reference) => {
      const viewer = people[0];
      const reader = people[1];
      if (viewer === undefined || reader === undefined)
        throw new Error("Missing people.");
      const input = { dataset, dax };
      const before = await denials(viewer.id);
      const denied = await call(viewer, transport, "execute_dax", input);
      expect(denied).toMatchObject({
        error: "refused",
        message: mentioning(reference),
      });
      await expectNewDenial(viewer.id, before, reference);
      expect(
        await call(reader, transport, "execute_dax", input),
      ).toHaveProperty("result_id");
    },
  );

  it("refuses a PII result header without storing any result", async () => {
    const viewer = people[0];
    if (viewer === undefined) throw new Error("Missing viewer.");
    const before = await db
      .select()
      .from(queryResult)
      .where(eq(queryResult.owner_id, viewer.id));
    const auditedBefore = await denials(viewer.id);
    const input = { dataset, dax: 'EVALUATE ROW("backstop", 1)' };
    expect(await call(viewer, transport, "execute_dax", input)).toMatchObject({
      error: "refused",
      message: mentioning("Customer[Customer]"),
    });
    expect(
      await db
        .select()
        .from(queryResult)
        .where(eq(queryResult.owner_id, viewer.id)),
    ).toEqual(before);
    await expectNewDenial(viewer.id, auditedBefore, "Customer[Customer]");
  });

  it("hides threads on PII and refuses starting them", async () => {
    const viewer = people[0];
    const reader = people[1];
    if (viewer === undefined || reader === undefined)
      throw new Error("Missing people.");
    for (const element of [
      { kind: "column", id: column },
      { kind: "measure", id: measure },
    ]) {
      const input = {
        kind: "comment",
        element,
        body: "Sample metadata question",
      };
      const created = (await call(reader, transport, "post_thread", input)) as {
        id: string;
      };
      expect(created.id).toBeTypeOf("string");
      expect(await call(viewer, transport, "post_thread", input)).toMatchObject(
        { error: "not_found" },
      );
      expect(
        await call(viewer, transport, "get_thread", { thread_id: created.id }),
      ).toMatchObject({ error: "not_found" });
      expect(await call(viewer, transport, "list_threads")).not.toMatchObject(
        pageWith(created.id),
      );
      expect(await call(reader, transport, "list_threads")).toMatchObject(
        pageWith(created.id),
      );
    }
  });
});

it("offers no element docs or curator drafts tools through MCP", async () => {
  for (const person of people.slice(0, 2)) {
    const answer = await oauth.request("/api/mcp", {
      method: "POST",
      headers: { ...bearer(person.token), "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(answer.status).toBe(200);
    const body: unknown = await answer.json();
    expect(body).toMatchObject({
      result: { tools: including([containing({ name: "get_variant" })]) },
    });
    expect(JSON.stringify(body)).not.toMatch(
      /"name":"[^"]*(?:docs|draft)[^"]*"/u,
    );
  }
});

it("refuses a service account even though the override policy allows its PII read", async () => {
  const override = cerbosAccess(f.settings, "override");
  const app = createApp({ ...oauth.deps, access: override });
  const admin = { ...oauth.deps, principal: principals.admin };
  await createServiceAccount(admin, {
    name: "pii_account",
    owner_email: "sample@example.test",
    roles: ["viewer"],
    workspace_ids: [sales.workspace_id],
  });
  const policy = new HTTP(inject("cerbos_override_url"));
  expect(
    await policy.isAllowed({
      principal: {
        id: "pii_account",
        roles: ["viewer"],
        attr: { kind: "service_account" },
      },
      resource: { kind: "pii", id: "pii", scope: "deployment" },
      action: "read",
    }),
  ).toBe(true);
  expect(
    await override.check(
      {
        ...principals.viewer,
        kind: "service_account",
        id: "pii_account",
        roles: ["viewer", "pii_reader"],
      },
      { kind: "pii", id: "pii", attr: {} },
      "read",
    ),
  ).toBe(false);
  const key = (await createKey(admin, "pii_account", { expires_in_days: 1 }))
    .key;
  const before = await denials("pii_account");
  const answer = await app.request("/api/v1/queries", {
    method: "POST",
    headers: { ...bearer(key), "content-type": "application/json" },
    body: JSON.stringify({ dataset, dax: queryCases[0][1] }),
  });
  expect(answer.status).toBe(403);
  expect(await answer.json()).toMatchObject({
    error: "refused",
    message: mentioning("Customer[Customer]"),
  });
  await expectNewDenial("pii_account", before, "Customer[Customer]");
});

it("records browser and CLI rule provenance and filters element docs and curator drafts", async () => {
  const admin = people[2];
  if (admin === undefined) throw new Error("Missing admin.");
  for (const person of people.slice(0, 2)) {
    for (const [kind, id] of [
      ["column", column],
      ["measure", measure],
    ] as const) {
      const answer = await oauth.request(
        `/api/v1/elements/${kind}/${id}/docs`,
        { headers: { cookie: person.cookie } },
      );
      expect(answer.status).toBe(person === people[1] ? 200 : 404);
    }
  }
  const token = (await oauth.login(admin.cookie)).access_token;
  for (const [via, headers] of [
    ["browser", fromSpa(admin.cookie, {}).headers],
    ["cli", { ...bearer(token), "content-type": "application/json" }],
  ] as const) {
    const answer = await oauth.request("/api/v1/admin/pii/rules", {
      method: "PUT",
      headers: new Headers(headers),
      body: JSON.stringify({
        kind: "column",
        table: "Unmirrored",
        name: via,
        pii: true,
      }),
    });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ rule: { set_via: via } });
  }
  for (const [index, person] of people.slice(0, 2).entries()) {
    const who = f.person(index === 0 ? "viewer" : "analyst");
    await assignRole(
      db,
      { role: "curator", subject_kind: "person", subject: who.email },
      principals.admin,
    );
    const drafts = await oauth.request(
      `/api/v1/drafts/next?dataset=${dataset}`,
      { headers: { cookie: person.cookie } },
    );
    expect(drafts.status).toBe(200);
    expect(JSON.stringify(await drafts.json()).includes(measure)).toBe(
      index === 1,
    );
  }
});

it("makes Undo conditional across admins, including absent and recreated rules", async () => {
  const a = people[2];
  if (a === undefined) throw new Error("Missing admin.");
  const who = f.person("analyst");
  await assignRole(
    db,
    { role: "admin", subject_kind: "person", subject: who.email },
    principals.admin,
  );
  const b = await f.signIn(who, MICROSOFT);
  const input = {
    kind: "column",
    table: `Undo_${randomUUID()}`,
    name: "Email",
    pii: true,
    note: "Before",
  };
  const put = (cookie: string, body: object) =>
    oauth.request("/api/v1/admin/pii/rules", {
      ...fromSpa(cookie, body),
      method: "PUT",
    });
  const save = async (cookie: string, body: object) => {
    const response = await put(cookie, body);
    expect(response.status).toBe(200);
    return response.json() as Promise<{
      rule: PiiRule;
      before: PiiRule | null;
    }>;
  };
  const remove = (rule: PiiRule) =>
    oauth.request(
      `/api/v1/admin/pii/rules/${rule.id}?expected_version=${encodeURIComponent(rule.version)}`,
      {
        method: "DELETE",
        headers: fromSpa(a.cookie, {}).headers,
      },
    );
  const first = await save(a.cookie, input);
  try {
    expect(first.before).toBeNull();
    const changed = await save(a.cookie, {
      ...input,
      table: input.table.toLowerCase(),
      pii: false,
    });
    expect(changed.before).toEqual(first.rule);
    expect(changed.rule.version).not.toBe(first.rule.version);
    const restored = await save(a.cookie, {
      ...input,
      expected_version: changed.rule.version,
    });
    expect(restored.rule).toMatchObject({
      ...first.rule,
      version: restored.rule.version,
      set_at: restored.rule.set_at,
    });
    expect(restored.rule.version).not.toBe(changed.rule.version);
    const bSaved = await save(b.cookie, { ...input, note: "B changed this" });
    const stored = () =>
      db.select().from(piiRule).where(eq(piiRule.id, bSaved.rule.id));
    const audit = () =>
      db
        .select()
        .from(auditEvent)
        .where(eq(auditEvent.resource_id, bSaved.rule.id));
    const before = await stored();
    const audited = await audit();
    for (const response of [
      await put(a.cookie, {
        ...input,
        expected_version: restored.rule.version,
      }),
      await remove(restored.rule),
    ]) {
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: "conflict",
        message: `The rule changed since; it was last set by ${who.email} in the browser.`,
      });
      expect(await stored()).toEqual(before);
      expect(await audit()).toEqual(audited);
    }
    expect((await remove(bSaved.rule)).status).toBe(204);
    const returned = await save(a.cookie, {
      ...input,
      note: "B changed this",
      expected_version: null,
    });
    expect(returned.rule).toMatchObject({
      pii: true,
      note: "B changed this",
      set_by_id: a.id,
      set_via: "browser",
    });
    expect(returned.before).toBeNull();
    expect(returned.rule.version).not.toBe(bSaved.rule.version);
    expect((await remove(returned.rule)).status).toBe(204);
    const recreated = await save(b.cookie, {
      ...input,
      table: input.table.toUpperCase(),
      note: "B recreated this",
    });
    const response = await put(a.cookie, { ...input, expected_version: null });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "conflict",
      message: `The rule changed since; it was last set by ${who.email} in the browser.`,
    });
    const listed = await oauth.request("/api/v1/admin/pii/rules", {
      headers: { cookie: a.cookie },
    });
    expect(await listed.json()).toMatchObject({
      rules: expect.arrayContaining([
        expect.objectContaining(recreated.rule),
      ]) as PiiRule[],
    });
  } finally {
    await db
      .delete(piiRule)
      .where(sql`lower(table_name) = ${input.table.toLowerCase()}`);
  }
});

it.each(["viewer", "curator", "service_account"] as const)(
  "refuses %s before checking matching or stale PII rule versions",
  async (role) => {
    const a = people[2];
    if (a === undefined) throw new Error("Missing admin.");
    const admin = { ...oauth.deps, principal: principals.admin };
    let headers: RequestInit["headers"];
    if (role === "service_account") {
      await createServiceAccount(admin, {
        name: "pii_version_account",
        owner_email: "sample@example.test",
        roles: ["viewer"],
      });
      headers = bearer(
        (await createKey(admin, "pii_version_account", { expires_in_days: 1 }))
          .key,
      );
    } else {
      const person = await oauth.person();
      if (role === "curator")
        await assignRole(
          db,
          { role, subject_kind: "person", subject: person.email },
          principals.admin,
        );
      headers = fromSpa(person.cookie, {}).headers;
    }
    const input = {
      kind: "table",
      table: `Version_${randomUUID()}`,
      pii: true,
    };
    const saved = await oauth.request("/api/v1/admin/pii/rules", {
      ...fromSpa(a.cookie, input),
      method: "PUT",
    });
    expect(saved.status).toBe(200);
    const { rule } = (await saved.json()) as { rule: PiiRule };
    const stored = () =>
      db.select().from(piiRule).where(eq(piiRule.id, rule.id));
    const audit = () =>
      db.select().from(auditEvent).where(eq(auditEvent.resource_id, rule.id));
    const before = await stored();
    const audited = await audit();
    try {
      for (const expected_version of ["stale-version", rule.version])
        for (const method of ["PUT", "DELETE"]) {
          const response = await oauth.request(
            `/api/v1/admin/pii/rules${method === "DELETE" ? `/${rule.id}?expected_version=${encodeURIComponent(expected_version)}` : ""}`,
            {
              method,
              headers: {
                ...Object.fromEntries(new Headers(headers)),
                "content-type": "application/json",
              },
              ...(method === "PUT"
                ? { body: JSON.stringify({ ...input, expected_version }) }
                : {}),
            },
          );
          expect(response.status).toBe(403);
          expect(await response.json()).toMatchObject({ error: "refused" });
          expect(await stored()).toEqual(before);
          expect(await audit()).toEqual(audited);
        }
    } finally {
      await db.delete(piiRule).where(eq(piiRule.id, rule.id));
    }
  },
);

it.each(["0", "17s"])("restores lock_timeout %s", async (timeout) => {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('lock_timeout', ${timeout}, true)`);
    const context = { ...oauth.deps, db: tx, principal: principals.admin };
    const current = () => tx.execute(sql`show lock_timeout`);
    const input = { kind: "table" as const, table_name: "Timeout", pii: true };
    const { rule } = await saveRule(context, input);
    expect((await current()).rows).toEqual([{ lock_timeout: timeout }]);
    await removeRule(context, rule.id);
    expect((await current()).rows).toEqual([{ lock_timeout: timeout }]);
  });
});

it.each(["PUT", "DELETE"])(
  "times out a blocked PII %s without changing the rule or audit",
  async (method) => {
    const a = people[2];
    if (a === undefined) throw new Error("Missing admin.");
    const input = {
      kind: "table",
      table: `Timeout_${randomUUID()}`,
      pii: true,
    };
    const saved = await oauth.request("/api/v1/admin/pii/rules", {
      ...fromSpa(a.cookie, input),
      method: "PUT",
    });
    expect(saved.status).toBe(200);
    const { rule } = (await saved.json()) as { rule: PiiRule };
    const stored = () =>
      db.select().from(piiRule).where(eq(piiRule.id, rule.id));
    const audit = () =>
      db.select().from(auditEvent).where(eq(auditEvent.resource_id, rule.id));
    const before = await stored();
    const audited = await audit();
    const holder = await testPool("api_rw").connect();
    let saving: Promise<Response> | undefined;
    try {
      await holder.query("begin");
      await holder.query("lock table pii_rule in share row exclusive mode");
      const { rows } = await holder.query<{ pid: number }>(
        "select pg_backend_pid() as pid",
      );
      saving = oauth.request(
        `/api/v1/admin/pii/rules${method === "DELETE" ? `/${rule.id}?expected_version=${encodeURIComponent(rule.version)}` : ""}`,
        {
          ...fromSpa(a.cookie, {
            ...input,
            pii: false,
            expected_version: rule.version,
          }),
          method,
        },
      );
      await waitingOn(rows[0]?.pid ?? 0, 1);
      const response = await saving;
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: "conflict",
        message: "Another PII change is in progress; try again.",
      });
      expect(await stored()).toEqual(before);
      expect(await audit()).toEqual(audited);
    } finally {
      await holder.query("rollback");
      holder.release();
      await saving;
      await db.delete(piiRule).where(eq(piiRule.id, rule.id));
    }
  },
);

it("checks absent-rule Undo after a concurrent folded-name insert commits", async () => {
  const a = people[2];
  if (a === undefined) throw new Error("Missing admin.");
  const holder = await testPool("api_rw").connect();
  const id = randomUUID();
  const table = `Concurrent_${id}`;
  const stored = () =>
    db
      .select()
      .from(piiRule)
      .where(sql`lower(table_name) = ${table.toLowerCase()}`);
  const audit = () =>
    db.select().from(auditEvent).where(eq(auditEvent.resource_id, id));
  let saving: Promise<Response> | undefined;
  try {
    await holder.query("begin");
    await holder.query(
      "insert into pii_rule (id, kind, table_name, name, pii, set_by_kind, set_by_id, set_via) values ($1, 'column', $2, 'ＥＭＡＩＬ', true, 'person', $3, 'cli')",
      [id, table.toUpperCase(), a.id],
    );
    const { rows } = await holder.query<{ pid: number }>(
      "select pg_backend_pid() as pid",
    );
    const audited = await audit();
    saving = oauth.request("/api/v1/admin/pii/rules", {
      ...fromSpa(a.cookie, {
        kind: "column",
        table,
        name: "Email",
        pii: false,
        expected_version: null,
      }),
      method: "PUT",
    });
    await waitingOn(rows[0]?.pid ?? 0, 1);
    const locks = await holder.query<{ mode: string }>(
      "select mode from pg_locks where relation = 'pii_rule'::regclass and not granted",
    );
    await holder.query("commit");
    const response = await saving;
    expect(response.status).toBe(409);
    expect(await stored()).toMatchObject([
      { id, pii: true, name: "ＥＭＡＩＬ" },
    ]);
    expect(await stored()).toHaveLength(1);
    expect(await audit()).toEqual(audited);
    expect(locks.rows).toContainEqual({ mode: "ShareRowExclusiveLock" });
    expect(await response.json()).toMatchObject({
      error: "conflict",
      message: `The rule changed since; it was last set by ${f.person("admin").email} with the CLI.`,
    });
  } finally {
    await holder.query("rollback");
    holder.release();
    await saving;
    await db.delete(piiRule).where(eq(piiRule.id, id));
  }
});
