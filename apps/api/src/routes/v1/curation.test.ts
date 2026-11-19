import { randomUUID } from "node:crypto";
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
  assignRole,
  listAssignments,
  revokeRole,
} from "../../services/auth/roles.js";
import { draftDatasets } from "../../services/book/drafter.js";
import { METRIC_CHECK_NAMES } from "../../services/conventions/schema.js";

/*
 * The curation, review and conventions routes, through the whole app: real
 * Postgres and Cerbos, the sample tenant's mirror drafted once for the file,
 * people signed in through the dev sign-in, and bearer tokens from the CLI's
 * device flow.
 */

afterAll(closeTestPools);

const settings = new MemorySettings({
  "access.metadata_visibility": "everyone",
});
const oauth = startOAuth({ settings, access: cerbosAccess(settings) });

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

type Role = "viewer" | "curator" | "admin";

/** A person holding the role, signed in: the cookie of their browser session. */
async function person(role: Role) {
  const signedIn = await oauth.person();
  if (role !== "viewer")
    await assignRole(
      oauth.deps.db,
      { role, subject_kind: "person", subject: signedIn.email },
      principals.admin,
    );
  return signedIn;
}

const browser = (cookie: string) => ({
  cookie,
  origin: TEST_PUBLIC_BASE_URL,
});
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function send(
  auth: Record<string, string>,
  method: string,
  path: string,
  body?: unknown,
) {
  const answer = await oauth.request(`/api/v1${path}`, {
    method,
    headers: { ...auth, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await answer.text();
  return {
    status: answer.status,
    body: text === "" ? null : (JSON.parse(text) as unknown),
  };
}

const ID = randomUUID();
const viewerWrites: [string, string, object?][] = [
  ["POST", "/metrics", { name: "x", label: "X" }],
  ["PATCH", "/metrics/x", { definition: "d" }],
  ["POST", "/metrics/x/merge", { from: "y" }],
  ["POST", "/metrics/x/verify"],
  ["POST", "/metrics/x/approve"],
  ["POST", "/metrics/x/dismiss", { reason: "r" }],
  ["DELETE", "/metrics/x"],
  ["PATCH", `/variants/${ID}`, { period: "current" }],
  ["POST", "/categories/x", { name: "X" }],
  ["PATCH", "/categories/x", { name: "Y" }],
  ["DELETE", "/categories/x"],
  ["POST", "/terms/x", { definition: "d" }],
  ["PATCH", "/terms/x", { definition: "e" }],
  ["DELETE", "/terms/x"],
  ["PUT", `/terms/x/columns/${ID}`],
  ["DELETE", `/terms/x/columns/${ID}`],
  ["PUT", "/terms/x/metrics/y"],
  ["DELETE", "/terms/x/metrics/y"],
  ["PUT", `/elements/metric/${ID}/docs`, { description: "d" }],
  ["PUT", `/elements/metric/${ID}/icon`, { icon: "emoji:\u{1F4C8}" }],
  ["DELETE", `/elements/metric/${ID}/icon`],
  ["PUT", "/conventions", {}],
  ["POST", "/conventions/diff", {}],
];

describe("the routes", () => {
  it("describe every operation in the OpenAPI document, with a schema for its success and its errors", async () => {
    const { paths, components } = await generateSpecs(createApp(oauth.deps));
    // Setup is outside /api/v1 and answers 404 where these routes answer 401 and 403.
    const operations = Object.entries(paths)
      .filter(([path]) => path.startsWith("/api/v1/"))
      .flatMap(([path, item]) =>
        Object.entries(item as object).map(([method, operation]) => ({
          name: `${method} ${path}`,
          responses: (
            operation as {
              responses: Record<string, { content?: Record<string, unknown> }>;
            }
          ).responses,
        })),
      );
    expect(operations.length).toBeGreaterThanOrEqual(37);
    // The shared entities are named once, and every reference resolves.
    const named = Object.keys(components.schemas ?? {});
    expect(named).toEqual(
      expect.arrayContaining([
        "Error",
        "Metric",
        "Variant",
        "Term",
        "Category",
        "Thread",
        "Reply",
        "Anchor",
        "Entry",
        "ResultPage",
        "Link",
      ]),
    );
    const refs = [...JSON.stringify(paths).matchAll(/"\$ref":"([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs)
      expect(named, String(ref)).toContain(
        String(ref).replace("#/components/schemas/", ""),
      );
    for (const { name, responses } of operations) {
      const success = Object.keys(responses).find(
        (status) => status.startsWith("2") || status === "302",
      );
      expect(success, name).toBeDefined();
      // 204 and a redirect have no body; every other success and every error names its schema.
      for (const [status, response] of Object.entries(responses))
        if (status !== "204" && status !== "302")
          expect(
            Object.values(response.content ?? {}),
            `${name} ${status}`,
          ).toEqual([
            expect.objectContaining({ schema: expect.anything() as unknown }),
          ]);
      expect(Object.keys(responses), name).toEqual(
        expect.arrayContaining(["401", "403"]),
      );
    }
  });

  it("refuse a person no role reaches before they read the request", async () => {
    const nobody = await person("viewer");
    for (const row of await listAssignments(oauth.deps.db))
      if (row.subject === nobody.email) await revokeRole(oauth.deps.db, row.id);
    const bad = await send(browser(nobody.cookie), "POST", "/metrics", {
      nope: 1,
    });
    expect(bad.status).toBe(403);
  });

  it("answer a conventions version list to an admin and refuse a viewer", async () => {
    const viewer = browser((await person("viewer")).cookie);
    const admin = browser((await person("admin")).cookie);
    expect((await send(viewer, "GET", "/conventions/versions")).status).toBe(
      403,
    );
    const listed = await send(admin, "GET", "/conventions/versions");
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveProperty("versions");
  });

  it("refuse a viewer on each write, with a session and with a token", async () => {
    const viewer = await person("viewer");
    const token = (await oauth.login(viewer.cookie)).access_token;
    for (const [method, path, body] of viewerWrites)
      for (const auth of [browser(viewer.cookie), bearer(token)])
        expect(
          (await send(auth, method, path, body)).status,
          `${method} ${path}`,
        ).toBe(403);
  });

  it("write each kind's built-in fields over PUT docs and show them in the REST answers", async () => {
    const curator = await person("curator");
    const agent = bearer((await oauth.login(curator.cookie)).access_token);
    const dataset = sample.tenant.datasets[0];
    if (dataset === undefined) throw new Error("the sample has no dataset");
    const detail = async () =>
      (await send(agent, "GET", `/datasets/${dataset.id}`)).body as {
        when_to_use: string | null;
        owner: string | null;
        freshness: string | null;
        caveats: string | null;
        tables: { id: string; grain_and_filters: string | null }[];
      };
    const table = (await detail()).tables[0];
    const columns = (
      await send(agent, "GET", `/datasets/${dataset.id}/columns`)
    ).body as { items: { id: string }[] };
    const column = columns.items[0];
    if (table === undefined || column === undefined)
      throw new Error("the sample dataset has no table or column");

    const put = (kind: string, id: string, body: object) =>
      send(agent, "PUT", `/elements/${kind}/${id}/docs`, body);
    const datasetFields = {
      when_to_use: "Daily traffic questions.",
      owner: "Web team",
      freshness: "Hourly",
      caveats: "Bots are included.",
    };
    const done = await put("dataset", dataset.id, datasetFields);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject(datasetFields);
    expect(
      (await put("table", table.id, { grain_and_filters: "One row per day." }))
        .body,
    ).toMatchObject({ grain_and_filters: "One row per day." });
    expect(
      (await put("column", column.id, { unit: "USD", blank_means: "Unknown" }))
        .body,
    ).toMatchObject({ unit: "USD", blank_means: "Unknown" });

    const read = await detail();
    expect(read).toMatchObject(datasetFields);
    expect(read.tables.find((t) => t.id === table.id)).toMatchObject({
      grain_and_filters: "One row per day.",
    });
    const listed = (await send(agent, "GET", "/datasets?limit=100")).body as {
      items: { id: string; when_to_use: string | null }[];
    };
    expect(listed.items.find((d) => d.id === dataset.id)).toMatchObject({
      when_to_use: "Daily traffic questions.",
    });
    const columnList = (
      (await send(agent, "GET", `/datasets/${dataset.id}/columns?limit=500`))
        .body as { items: { id: string }[] }
    ).items;
    expect(columnList.find((c) => c.id === column.id)).toMatchObject({
      unit: "USD",
      blank_means: "Unknown",
    });
    expect(
      (await send(agent, "GET", `/datasets/${dataset.id}/columns/${column.id}`))
        .body,
    ).toMatchObject({ column: { unit: "USD", blank_means: "Unknown" } });
  });

  it("refuse a field the kind does not have with the code docs.field_not_on_kind, and send no code for an upstream refusal", async () => {
    const curator = await person("curator");
    const agent = bearer((await oauth.login(curator.cookie)).access_token);
    const dataset = sample.tenant.datasets[0];
    if (dataset === undefined) throw new Error("the sample has no dataset");
    const refused = await send(
      agent,
      "PUT",
      `/elements/dataset/${dataset.id}/docs`,
      { unit: "USD" },
    );
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({
      error: "invalid",
      code: "docs.field_not_on_kind",
    });
    expect(JSON.stringify(refused.body)).toContain("unit");
    expect(JSON.stringify(refused.body)).toContain("dataset");
  });

  it("set, read and clear an icon on a metric, and refuse what is not an icon", async () => {
    const curator = await person("curator");
    const agent = bearer((await oauth.login(curator.cookie)).access_token);
    const name = `icon_route_${randomUUID().slice(0, 8)}`;
    const created = await send(agent, "POST", "/metrics", {
      name,
      label: "Icon route",
    });
    const { id } = created.body as { id: string };
    const set = await send(agent, "PUT", `/elements/metric/${id}/icon`, {
      icon: "glyph:chart-line:green",
    });
    expect(set).toEqual({
      status: 200,
      body: { kind: "metric", id, icon: "glyph:chart-line:green" },
    });
    expect((await send(agent, "GET", `/metrics/${name}`)).body).toMatchObject({
      icon: "glyph:chart-line:green",
    });
    const bad = await send(agent, "PUT", `/elements/metric/${id}/icon`, {
      icon: "glyph:chart:green",
    });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain("pbmb icons list");
    expect(
      (
        await send(agent, "PUT", `/elements/metric/${id}/icon`, {
          icon: "emoji:\u{1F4C8}",
          extra: 1,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await send(agent, "PUT", `/elements/table/${id}/icon`, {
          icon: "emoji:\u{1F4C8}",
        })
      ).status,
    ).toBe(400);
    expect(
      (await send(agent, "DELETE", `/elements/metric/${id}/icon`)).body,
    ).toEqual({ kind: "metric", id, icon: null });
    expect(
      (
        await send(agent, "PUT", `/elements/metric/${randomUUID()}/icon`, {
          icon: "emoji:\u{1F4C8}",
        })
      ).status,
    ).toBe(404);
  });

  it("let a curator's agent curate a draft end to end", async () => {
    const curator = await person("curator");
    const agent = bearer((await oauth.login(curator.cookie)).access_token);
    const call = async (method: string, path: string, body?: object) => {
      const answer = await send(agent, method, path, body);
      expect(
        answer.status,
        `${method} ${path}: ${JSON.stringify(answer.body)}`,
      ).toBeLessThan(300);
      return answer.body;
    };
    const drafts = (await call("GET", "/drafts/next?limit=20")) as {
      name: string;
      variants: { id: string }[];
    }[];
    const variantOf = (draft: string) =>
      drafts.find((d) => d.name === draft)?.variants[0]?.id ?? "";
    const name = "total_advertising_spend_excl_vat";
    await call("PATCH", "/metrics/ad_spend", { name });
    await call("PATCH", `/variants/${variantOf("ad_spend_ly")}`, {
      to_metric: name,
      period: "previous_year",
    });
    await call("POST", "/metrics/orders/merge", { from: "order_count" });
    await call("POST", "/categories/sales", { name: "Sales" });
    await call("PATCH", `/metrics/${name}`, {
      definition: "Money spent on advertising.",
      when_to_use: "Questions about marketing cost.",
      grain_and_filters: "Per campaign day.",
      unit: "money",
      aliases: [],
      not_the_same_as:
        "Ad spend LY is the same spend a year earlier; return on ad spend is revenue per unit spent.",
      category: "sales",
    });
    const verified = await call("POST", `/metrics/${name}/verify`);
    expect(verified).toMatchObject({ trust_state: "agent_verified" });
    const history = (await call("GET", `/metrics/${name}/history`)) as {
      principal_name: string;
    }[];
    expect(history).toBeInstanceOf(Array);
    const me = await send(browser(curator.cookie), "GET", "/me");
    const { name: displayName } = me.body as { name: string };
    expect(history.at(-1)?.principal_name).toBe(displayName);
  });

  it("relate a term to a metric for a curator and take it away again, and answer a metric the caller cannot see like a missing one", async () => {
    const curator = await person("curator");
    const agent = bearer((await oauth.login(curator.cookie)).access_token);
    const suffix = randomUUID().slice(0, 8);
    const term = `season_${suffix}`;
    const metric = `season_sales_${suffix}`;
    await send(agent, "POST", "/metrics", { name: metric, label: "Sales" });
    await send(agent, "POST", `/terms/${term}`, { definition: "A season." });
    const url = `/terms/${term}/metrics/${metric}`;
    const related = await send(agent, "PUT", url);
    expect(related.status, JSON.stringify(related.body)).toBe(200);
    expect(related.body).toMatchObject({
      name: term,
      metrics: [{ kind: "metric", name: metric }],
    });
    const removed = await send(agent, "DELETE", url);
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ name: term, metrics: [] });
    // Under "powerbi" this curator, connected to no Power BI, describes no dataset, so the sample's sessions metric is hidden from them.
    await settings.set("access.metadata_visibility", "powerbi");
    try {
      const absent = `no_such_metric_${suffix}`;
      for (const method of ["PUT", "DELETE"]) {
        const hidden = await send(
          agent,
          method,
          `/terms/${term}/metrics/sessions`,
        );
        const missing = await send(
          agent,
          method,
          `/terms/${term}/metrics/${absent}`,
        );
        expect(hidden.status, method).toBe(404);
        expect(
          JSON.stringify(hidden.body).replaceAll("sessions", "<ref>"),
          method,
        ).toBe(JSON.stringify(missing.body).replaceAll(absent, "<ref>"));
      }
    } finally {
      await settings.set("access.metadata_visibility", "everyone");
    }
  });

  it("report every check on a metric, and answer a hidden one like a missing one", async () => {
    const curator = await person("curator");
    const agent = bearer((await oauth.login(curator.cookie)).access_token);
    const name = `number_of_checks_${randomUUID().slice(0, 8)}`;
    await send(agent, "POST", "/metrics", { name, label: "Number of checks" });
    const checked = await send(agent, "GET", `/metrics/${name}/checks`);
    const results = (checked.body as { checks: { passed: boolean }[] }).checks;
    expect(results.filter((r) => r.passed).length).toBeGreaterThan(0);
    expect(results.filter((r) => !r.passed).length).toBeGreaterThan(0);
    expect((await send(agent, "GET", "/metrics/sessions/checks")).status).toBe(
      200,
    );
    // Under "powerbi" this curator, connected to no Power BI, describes no dataset.
    await settings.set("access.metadata_visibility", "powerbi");
    try {
      const hidden = await send(agent, "GET", "/metrics/sessions/checks");
      expect(hidden.status).toBe(404);
      expect((await send(agent, "GET", `/metrics/${name}/checks`)).status).toBe(
        200,
      );
    } finally {
      await settings.set("access.metadata_visibility", "everyone");
    }
  });

  it("refuse approval by a token, approve for a curator's session, and approve by a token when the conventions say any", async () => {
    const curator = await person("curator");
    const agent = bearer((await oauth.login(curator.cookie)).access_token);
    const admin = browser((await person("admin")).cookie);
    const name = `approved_${randomUUID().slice(0, 8)}`;
    await send(agent, "POST", "/metrics", { name, label: "Approved" });
    const off = { checks: { off: [...METRIC_CHECK_NAMES] } };
    const saved = await send(admin, "PUT", "/conventions", off);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const url = `/metrics/${name}/approve`;
    expect((await send(agent, "POST", url)).status).toBe(403);
    const approved = await send(browser(curator.cookie), "POST", url);
    const me = (await send(browser(curator.cookie), "GET", "/me")).body as {
      name: string;
    };
    expect(approved.body).toMatchObject({
      trust_state: "human_verified",
      verified_by: curator.id,
      verified_by_name: me.name,
    });
    const any = {
      ...off,
      trust: { agent_verify_requires: "all_checks", human_verify_from: "any" },
    };
    expect((await send(admin, "PUT", "/conventions", any)).status).toBe(200);
    const second = `${name}_by_token`;
    await send(agent, "POST", "/metrics", { name: second, label: "By token" });
    const byToken = await send(agent, "POST", `/metrics/${second}/approve`);
    expect(byToken.body).toMatchObject({ trust_state: "human_verified" });
  });
});
