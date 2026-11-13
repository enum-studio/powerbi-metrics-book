import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sampleTenant, type Tenant } from "@powerbi-metrics-book/powerbi-mock";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { inspectRoutes } from "hono/dev";
import { request } from "undici";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  cerbosAccess,
  closeTestPools,
  createTestDeps,
  principals,
  TEST_PUBLIC_BASE_URL as BASE,
  testPool,
} from "../../test/deps.js";
import { startPowerBi } from "../../test/powerbi-support.js";
import {
  cookies,
  followConnect,
  freshPeer,
  fromSpa,
  OIDC,
  pkce,
  type SignInFixture,
  startSignIn,
} from "../../test/sign-in-support.js";
import { type AppEnv, createApp } from "../app.js";
import type {
  AppDeps,
  SecretName,
  ServiceContext,
  SettingKey,
  SettingValue,
} from "../context.js";
import { createDb } from "../db/client.js";
import { user } from "../db/schema/auth.js";
import { metric, metricVariant } from "../db/schema/book.js";
import { powerbiColumn, powerbiMeasure } from "../db/schema/mirror.js";
import { TOOLS } from "../mcp/tools/index.js";
import { assignRole } from "../services/auth/roles.js";
import {
  createKey,
  createServiceAccount,
} from "../services/auth/service-accounts.js";
import { createCategory } from "../services/book/categories.js";
import { createMetric } from "../services/book/metrics.js";
import { createTerm } from "../services/book/terms.js";
import { METRIC_CHECK_NAMES } from "../services/conventions/schema.js";
import { createSettingsStore } from "../services/settings/store.js";
import { runSync } from "../services/sync/run.js";
import {
  ROUTE_CALLERS,
  ROUTE_MATRIX,
  type RouteCaller,
  type RouteKey,
  TOOL_CALLERS,
  TOOL_MATRIX,
  type ToolCaller,
  type ToolName,
  type Verdict,
} from "./authorization-matrix.js";

/*
 * The authorization matrix (authorization-matrix.ts), proved: one real request
 * per cell on the sample tenant, synced and drafted, with real credentials (dev
 * sign-in sessions connected to Power BI, the CLI's and an MCP client's OAuth
 * tokens, API keys from the service), and nothing unlisted in the route table
 * or the tool registry.
 */

vi.setConfig({ testTimeout: 180_000 });

/** Each route in the table as `METHOD path`: every handler but middleware, which takes `next`. */
function routeKeys(target: Hono<AppEnv>): string[] {
  const keys = inspectRoutes(target)
    .filter((route) => !route.isMiddleware)
    .map((route) => `${route.method} ${route.path}`);
  return [...new Set(keys)];
}
const unlisted = (names: string[], listed: object) =>
  names.filter((name) => !Object.hasOwn(listed, name));
const stale = (names: string[], listed: object) =>
  Object.keys(listed).filter((name) => !names.includes(name));

describe("the walk", () => {
  it("serves the Datasets shell publicly for every caller", () => {
    expect(ROUTE_MATRIX["GET /admin/datasets"]).toEqual({
      anonymous: "allowed",
      outsider: "allowed",
      viewer: "allowed",
      curator: "allowed",
      admin: "allowed",
      curator_elsewhere: "allowed",
      service_account: "allowed",
      service_account_granted: "allowed",
      curator_cli_token: "allowed",
      curator_mcp_token: "allowed",
    });
  });

  it("serves the PII shell publicly for every caller", () => {
    expect(ROUTE_MATRIX["GET /admin/pii"]).toEqual({
      anonymous: "allowed",
      outsider: "allowed",
      viewer: "allowed",
      curator: "allowed",
      admin: "allowed",
      curator_elsewhere: "allowed",
      service_account: "allowed",
      service_account_granted: "allowed",
      curator_cli_token: "allowed",
      curator_mcp_token: "allowed",
    });
  });

  it("fails on a route registered on the app and missing from the matrix", () => {
    const extended = createApp(createTestDeps());
    extended.get("/api/v1/added-later", (c) => c.text("open"));
    extended.all("/*", (c) => c.text("open"));
    expect(unlisted(routeKeys(extended), ROUTE_MATRIX)).toEqual([
      "GET /api/v1/added-later",
      "ALL /*",
    ]);
    expect(unlisted(["added_later"], TOOL_MATRIX)).toEqual(["added_later"]);
  });

  it("names every route and tool there is, and none there is not", () => {
    const keys = routeKeys(createApp(createTestDeps()));
    const names = TOOLS.map((tool) => tool.name);
    expect(unlisted(keys, ROUTE_MATRIX)).toEqual([]);
    expect(stale(keys, ROUTE_MATRIX)).toEqual([]);
    expect(unlisted(names, TOOL_MATRIX)).toEqual([]);
    expect(stale(names, TOOL_MATRIX)).toEqual([]);
  });
});

// The fixture: the tenant, the app, and each caller's credential.

const tag = randomUUID().slice(0, 8);
const MISSING = `missing_${tag}`;
const OWNER = "owner@example.test";
const THROWAWAY = `throwaway-${tag}@example.test`;
/** The sample's people who stand for each role. */
const PEOPLE = {
  admin: { mailbox: "admin", role: "admin" },
  curator: { mailbox: "analyst", role: "curator" },
  viewer: { mailbox: "viewer", role: "viewer" },
  outsider: { mailbox: "outsider", role: "viewer" },
  // Reaches Finance through the Leadership app, and nothing in Sales.
  curator_elsewhere: { mailbox: "leader", role: "curator" },
} as const;
type Person = keyof typeof PEOPLE;
const MCP_CLIENT = {
  client_name: "MCP client",
  redirect_uris: ["https://client.example.org/callback"],
  token_endpoint_auth_method: "none",
};
const CLI_LOGIN = {
  client_id: "pbmb-cli",
  scope: "api offline_access",
  resource: `${BASE}/api/v1`,
};
const FIXTURE_SETTINGS = [
  "powerbi.tenant_id",
  "powerbi.app_client_id",
  "sign_in.providers",
] as const;
const CLI_POLL = {
  grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  client_id: "pbmb-cli",
};
const VIEWER = { role: "viewer", subject_kind: "person" } as const;
const checksOff = () => ({ checks: { off: [...METRIC_CHECK_NAMES] } });

let f: SignInFixture;
let deps: AppDeps;
let app: Hono<AppEnv>;
const session = {} as Record<Person, string>;
const mcpToken = {} as Record<Person, string>;
const key = { none: "", granted: "", cli: "" };
const isPerson = (who: string): who is Person => Object.hasOwn(PEOPLE, who);
/** What the cells are about, found or made once the tenant is synced. */
const at = {
  sales: "",
  salesDax: "",
  metric: "",
  metricId: "",
  variant: "",
  column: "",
  term: `matrix_term_${tag}`,
  termId: "",
  category: `matrix_${tag}`,
  spare: `spare_${tag}`,
  spareKey: "",
  role: "",
  thread: "",
  acceptThread: "",
  archiveThread: "",
  reply: "",
  result: "",
  query: "",
  csvLink: "",
  request: "",
  /** A request of the curator's for each caller to delete. */
  doomed: {} as Record<string, string>,
};

afterAll(async () => {
  await f.close();
  await closeTestPools();
}, 180_000);

/** The fixture gives people and groups ids of their own; its access lists still name the sample's. */
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

const fromPeer = async (path: string, init: RequestInit = {}) =>
  app.request(path, init, {
    incoming: { socket: { remoteAddress: freshPeer() } },
  });
const FORM = "application/x-www-form-urlencoded";
const form = (fields: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "content-type": FORM },
  body: new URLSearchParams(fields).toString(),
});
async function ok<T extends z.ZodType>(answer: Response, shape: T) {
  expect(answer.status, await answer.clone().text()).toBeLessThan(300);
  return shape.parse(await answer.json());
}
const withId = z.object({ id: z.string() });
const tokens = z.object({ access_token: z.string() });
const ClientId = z.object({ client_id: z.string() });

/** Signed in through the dev sign-in, holding the role, and connected to Power BI as the sample person. */
async function signIn(person: Person): Promise<string> {
  const who = f.person(PEOPLE[person].mailbox);
  const assignment = { subject_kind: "person", subject: who.email } as const;
  await assignRole(
    deps.db,
    { ...assignment, role: PEOPLE[person].role },
    principals.admin,
  );
  const body = { email: who.email };
  const signed = await fromPeer("/api/auth/dev/sign-in", fromSpa("", body));
  expect(signed.status).toBe(200);
  // The dev sign-in names a person by their email; a display name tells the two apart in what the routes answer.
  await deps.db
    .update(user)
    .set({ name: PEOPLE[person].mailbox })
    .where(eq(user.email, who.email));
  f.actAs(who);
  const cookie = cookies(signed);
  expect((await followConnect(app, cookie)).answer.status).toBe(302);
  return cookie;
}

/** An MCP client's access token for the person: registered, allowed and redeemed. */
async function mcpTokenOf(cookie: string): Promise<string> {
  const registered = await fromPeer("/api/auth/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(MCP_CLIENT),
  });
  const { client_id } = await ok(registered, ClientId);
  const redirect_uri = MCP_CLIENT.redirect_uris[0] ?? "";
  const { verifier, challenge } = pkce();
  const query = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri,
    state: "sample-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${BASE}/api/mcp`,
  });
  const authorized = await fromPeer(
    `/api/auth/oauth2/authorize?${query.toString()}`,
    { headers: { cookie } },
  );
  const page = authorized.headers.get("location") ?? "";
  const request = new URL(page, BASE).search.slice(1);
  const consent = fromSpa(cookie, { request, allow: true });
  const allowed = await fromPeer("/api/v1/oauth/consent", consent);
  const back = await ok(allowed, z.object({ redirect_to: z.string() }));
  const code = new URL(back.redirect_to).searchParams.get("code") ?? "";
  const redeem = { code, redirect_uri, client_id, code_verifier: verifier };
  const answer = await fromPeer(
    "/api/auth/oauth2/token",
    form({ grant_type: "authorization_code", ...redeem }),
  );
  return (await ok(answer, tokens)).access_token;
}

/** `pbmb login`: the device flow, the person pressing Allow in the browser. */
async function cliTokenOf(cookie: string): Promise<string> {
  const started = await fromPeer("/api/auth/device/code", form(CLI_LOGIN));
  const { device_code, user_code } = await ok(
    started,
    z.object({ device_code: z.string(), user_code: z.string() }),
  );
  const answer = fromSpa(cookie, { user_code, allow: true });
  expect((await fromPeer("/api/v1/oauth/device", answer)).status).toBe(204);
  const poll = form({ ...CLI_POLL, device_code });
  return (await ok(await fromPeer("/api/auth/oauth2/token", poll), tokens))
    .access_token;
}

/** Power BI's connection round trip up to the callback, which a cell then makes. */
async function callbackQuery(person: Person): Promise<string> {
  f.actAs(f.person(PEOPLE[person].mailbox));
  const headers = { cookie: session[person] };
  const started = await fromPeer("/api/v1/powerbi/connect", { headers });
  const authorized = await request(started.headers.get("location") ?? "");
  await authorized.body.dump();
  return new URL(String(authorized.headers.location)).search.slice(1);
}

/** A metric whose every variant is in the Sales dataset, and one of those variants. */
async function salesOnlyMetric() {
  const filed = await deps.db
    .select({
      name: metric.name,
      id: metric.id,
      variant: metricVariant.id,
      dataset: powerbiMeasure.dataset_id,
    })
    .from(metricVariant)
    .innerJoin(metric, eq(metric.id, metricVariant.metric_id))
    .innerJoin(powerbiMeasure, eq(powerbiMeasure.id, metricVariant.measure_id));
  const elsewhere = new Set(
    filed.filter((row) => row.dataset !== at.sales).map((row) => row.name),
  );
  const found = filed.find((row) => !elsewhere.has(row.name));
  if (found === undefined) throw new Error("no metric is in Sales alone");
  return found;
}

beforeAll(async () => {
  f = await startSignIn({ env: { ALLOW_DEV_SIGN_IN: "1" } });
  renameAccess(f.tenant);
  const powerbi = await startPowerBi(f.tenant);
  await runSync(createTestDeps({ ...powerbi.deps, container: "worker" }), {
    kind: "full",
    trigger: "manual",
    poll_ms: 1,
  });
  await powerbi.mock.close();
  // The real store, with the fixture's settings: saving a setting runs in a
  // transaction, which the fixture's double cannot join. The mock's URLs are
  // the environment's to set.
  const authority = await f.settings.get("powerbi.authority");
  const settings = createSettingsStore(createDb(testPool("api_rw")), {
    POWERBI_AUTHORITY: authority,
    POWERBI_API_URL: `${authority}/powerbi`,
    POWERBI_GRAPH_URL: await f.settings.get("powerbi.graph_url"),
  });
  const save = <K extends SettingKey>(name: K, value: SettingValue<K>) =>
    settings.set(name, value, principals.admin);
  for (const name of FIXTURE_SETTINGS)
    await save(name, await f.settings.get(name));
  await save("service_accounts.rate_per_minute", 10_000);
  await save("sign_in.passkeys", true);
  await save("sign_in.email_password", true);
  // The fixture's secrets, and the key that signs CSV links.
  const { secrets } = f.deps;
  const read = (name: SecretName) =>
    name === "result_link_key"
      ? Promise.resolve("test-result-link-key")
      : secrets.read(name);
  const access = cerbosAccess(settings);
  deps = { ...f.deps, settings, access, secrets: { read } };
  // The SPA's shell, built: an index.html and one hashed asset.
  const web = mkdtempSync(join(tmpdir(), "pbmb-web-"));
  mkdirSync(join(web, "assets"));
  writeFileSync(join(web, "index.html"), "<!doctype html><title>Shell</title>");
  writeFileSync(join(web, "assets", "app-4f2a.js"), "export {};");
  app = createApp(deps, { webDist: web });

  const sales = f.tenant.datasets.find((d) => d.name === "Sales");
  const recorded = sales?.recorded_queries[0];
  if (sales === undefined || recorded === undefined)
    throw new Error("no Sales");
  Object.assign(at, { sales: sales.id, salesDax: recorded.dax });

  for (const person of Object.keys(PEOPLE) as Person[]) {
    session[person] = await signIn(person);
    mcpToken[person] = await mcpTokenOf(session[person]);
  }
  key.cli = await cliTokenOf(session.curator);

  const admin: ServiceContext = { ...deps, principal: principals.admin };
  const curator: ServiceContext = { ...deps, principal: principals.curator };
  const account = async (name: string, workspace_ids: string[] = []) => {
    const fields = { name, owner_email: OWNER, roles: ["viewer"] };
    await createServiceAccount(admin, { ...fields, workspace_ids });
    return createKey(admin, name, { expires_in_days: 7 });
  };
  key.none = (await account(`none_${tag}`)).key;
  key.granted = (await account(`granted_${tag}`, [sales.workspace_id])).key;
  at.spareKey = (await account(at.spare)).id;
  await account(`gone_${tag}`);
  const gone = { ...VIEWER, subject: `gone-${tag}@example.test` };
  at.role = (await assignRole(deps.db, gone, principals.admin)).id;
  await assignRole(
    deps.db,
    { ...VIEWER, subject: THROWAWAY },
    principals.admin,
  );

  // Every check off, so verifying and approving turn on who asks alone.
  const off = { ...fromSpa(session.admin, checksOff()), method: "PUT" };
  expect((await fromPeer("/api/v1/conventions", off)).status).toBe(200);

  const found = await salesOnlyMetric();
  Object.assign(at, { metric: found.name, metricId: found.id });
  at.variant = found.variant;
  const [column] = await deps.db
    .select({ id: powerbiColumn.id })
    .from(powerbiColumn)
    .where(eq(powerbiColumn.dataset_id, at.sales));
  if (column === undefined) throw new Error("Sales has no column");
  at.column = column.id;
  const term = (name: string) =>
    createTerm(curator, { name, definition: "a term." });
  const made = (name: string) => createMetric(curator, { name, label: name });
  const madeTerm = await term(at.term);
  at.termId = madeTerm.id;
  await createCategory(curator, at.category, { name: "Matrix" });
  await made(`dismissed_${tag}`);
  for (const who of ROUTE_CALLERS) {
    for (const prefix of ["from", "into", "gone"]) await made(own(who, prefix));
    for (const prefix of ["gone", "columns"]) await term(own(who, prefix));
    await createCategory(curator, own(who, "gone"), { name: "Gone" });
  }

  const terms = `/api/v1/terms/${at.term}`;
  for (const path of [`columns/${at.column}`, `metrics/${at.metric}`]) {
    const linked = { ...fromSpa(session.curator, {}), method: "PUT" };
    expect((await fromPeer(`${terms}/${path}`, linked)).status).toBe(200);
  }

  // The admin's questions on the Sales metric, one answered by the curator.
  const ask = async (title: string) => {
    const element = { kind: "metric", id: at.metricId };
    const body = { kind: "question", element, title, body: "Returns?" };
    const answer = await fromPeer(
      "/api/v1/threads",
      fromSpa(session.admin, body),
    );
    return (await ok(answer, withId)).id;
  };
  // The admin's question on the term, which belongs to no dataset.
  const onTerm = {
    kind: "question",
    element: { kind: "term", id: madeTerm.id },
    title: "Which season?",
    body: "Spring or autumn?",
  };
  expect(
    (await fromPeer("/api/v1/threads", fromSpa(session.admin, onTerm))).status,
  ).toBe(201);
  at.thread = await ask("Read and upvoted");
  at.acceptThread = await ask("Accepted");
  at.archiveThread = await ask("Archived");
  const reply = fromSpa(session.curator, { body: "Yes, netted off." });
  const path = `/api/v1/threads/${at.acceptThread}/replies`;
  at.reply = (await ok(await fromPeer(path, reply), withId)).id;

  // The curator's query: its result is the curator's alone.
  const query = { dataset: at.sales, dax: at.salesDax };
  const ran = await ok(
    await fromPeer("/api/v1/queries", fromSpa(session.curator, query)),
    z.object({
      result_id: z.string(),
      query_id: z.string(),
      csv_url: z.string(),
    }),
  );
  Object.assign(at, { result: ran.result_id, query: ran.query_id });
  at.csvLink = new URL(ran.csv_url, BASE).search.slice(1);

  // The curator's requests: one to read, and one for each caller to delete.
  const requested = async () => {
    const asked = fromSpa(session.curator, ASKED);
    return (await ok(await fromPeer("/api/v1/requests", asked), withId)).id;
  };
  at.request = await requested();
  for (const who of ROUTE_CALLERS) at.doomed[who] = await requested();
}, 600_000);

// The requests: what each cell sends besides its route's own method and path.

type Spec = {
  segments?: Record<string, string>;
  /** Parameters naming nothing that exists: a hidden or refused answer must equal that call's. */
  missing?: Record<string, string>;
  /** As `missing`, where the body names the target. */
  missingBody?: unknown;
  /** Whose answer to the missing call it must equal, when not the caller's own. */
  missingBy?: RouteCaller;
  query?: string;
  body?: unknown;
  form?: Record<string, string>;
  /** Statuses that come after authorization, besides 2xx and 3xx. */
  past?: number[];
};
type Call = { method: string; path: string; body?: unknown; form?: object };

const nobody = () => randomUUID();
const own = (who: RouteCaller, prefix: string) => `${prefix}_${tag}_${who}`;
const rpc = (method: string) => ({ jsonrpc: "2.0", id: 1, method });
const named = (name: string, body?: unknown): Spec => ({
  segments: { name },
  missing: { name: MISSING },
  body,
});
const byId = (id: string, body?: unknown): Spec => ({
  segments: { id },
  missing: { id: nobody() },
  body,
});
const theMetric = (body?: unknown) => named(at.metric, body);
/** The Sales metric for the curator elsewhere, who must find it missing; a metric of their own for anyone else. */
const salesFor = (who: RouteCaller, name: string) =>
  who === "curator_elsewhere" ? at.metric : name;
const sales = () => byId(at.sales);
const salesColumn = (): Spec => ({
  segments: { id: at.sales, column_id: at.column },
  missing: { id: nobody() },
});
const salesDocs = (body?: unknown): Spec => ({
  ...byId(at.sales, body),
  segments: { kind: "dataset", id: at.sales },
});
const termColumn = (who: RouteCaller): Spec => ({
  segments: { name: own(who, "columns"), column_id: at.column },
  missing: { column_id: nobody() },
});
const termMetric = (who: RouteCaller): Spec => ({
  segments: { name: own(who, "columns"), metric: at.metric },
  missing: { metric: MISSING },
});
const ASKED = { question: "Net sales by week?", outcome: "answered" };
const comment = (id: string) => ({
  kind: "comment",
  element: { kind: "metric", id },
  body: "a comment.",
});
/** The setup API answers anyone it is not for as it answers no credential at all. */
const setup = (body?: unknown): Spec => ({
  body,
  missing: {},
  missingBy: "anonymous",
  past: [400],
});
const stateless = (): Spec => ({ past: [405] });
const toSignIn = (body: object): Spec => ({
  body: { ...body, callbackURL: "/" },
});
const badInput = (): Spec => ({ body: {}, past: [400] });
/** What the consent and device routes answer a request or code that names nothing. */
const NOTHING = [400, 404];
const deny = (field: string): Spec => ({
  body: { [field]: "none", allow: false },
  past: NOTHING,
});
const atPath = (path: string, body?: unknown): Spec => ({
  segments: { path },
  missing: { path: MISSING },
  body,
});
const ttl = (body?: unknown): Spec => ({
  segments: { key: "results.ttl_hours" },
  body,
});
const noSuchGrant = (): Spec => ({ segments: { id: nobody() }, past: [404] });
const noSuchPerson = (body?: unknown): Spec => ({ ...noSuchGrant(), body });

/** A route with no entry sends its own method and path, and no body. */
const ROUTE_REQUESTS: Partial<
  Record<RouteKey, (who: RouteCaller) => Spec | Promise<Spec>>
> = {
  "POST /api/auth/sign-in/email": badInput,
  "POST /api/auth/invites/accept": badInput,
  "POST /api/auth/invites/lookup": () => ({ body: { token: "unknown" } }),
  "POST /api/auth/email/forgot-password": badInput,
  "POST /api/auth/reset-password": badInput,
  "POST /api/auth/change-password": badInput,
  "POST /api/v1/admin/people/invites": () => ({
    body: {
      emails: [`invite-${tag}@x.test`],
      role: "viewer",
      delivery: "link",
    },
  }),
  "POST /api/auth/sign-in/social": () => toSignIn({ provider: "microsoft" }),
  "POST /api/auth/sign-in/sso": () => toSignIn({ providerId: OIDC }),
  "POST /api/auth/passkey/verify-authentication": badInput,
  "POST /api/auth/dev/sign-in": () => ({ body: { email: THROWAWAY } }),
  "GET /api/auth/oauth2/authorize": () => ({ past: [400] }),
  "POST /api/auth/oauth2/token": () => ({
    form: { ...CLI_POLL, device_code: "no" },
    past: [400],
  }),
  "POST /api/auth/oauth2/register": () => ({ body: MCP_CLIENT }),
  "POST /api/auth/device/code": () => ({ form: CLI_LOGIN }),
  "POST /api/auth/passkey/verify-registration": badInput,
  "POST /api/auth/passkey/delete-passkey": () => ({
    body: { id: "none" },
    past: [400, 404],
  }),
  "POST /api/auth/revoke-other-sessions": () => ({ body: {} }),
  "POST /api/auth/sign-out": () => ({ body: {} }),
  "POST /api/mcp": () => ({ body: rpc("ping") }),
  "GET /api/mcp": stateless,
  "PUT /api/mcp": stateless,
  "PATCH /api/mcp": stateless,
  "DELETE /api/mcp": stateless,
  // No such grant: the caller's own tokens stay.
  "DELETE /api/v1/me/grants/:id": noSuchGrant,
  "GET /api/v1/powerbi/callback": async (who) => ({
    query: await callbackQuery(isPerson(who) ? who : "curator"),
  }),
  "POST /api/v1/metrics": (who) => ({
    body: { name: own(who, "new"), label: "New" },
  }),
  "PATCH /api/v1/metrics/:name": () => theMetric({ definition: "Sample." }),
  "POST /api/v1/metrics/:name/merge": (who) =>
    named(salesFor(who, own(who, "into")), { from: own(who, "from") }),
  "POST /api/v1/metrics/:name/verify": () => theMetric(),
  "POST /api/v1/metrics/:name/approve": () => theMetric(),
  "POST /api/v1/metrics/:name/dismiss": (who) =>
    named(salesFor(who, `dismissed_${tag}`), { reason: "Not a metric." }),
  "DELETE /api/v1/metrics/:name": (who) =>
    named(salesFor(who, own(who, "gone"))),
  "GET /api/v1/metrics/:name/checks": () => theMetric(),
  "GET /api/v1/metrics/:name/history": () => theMetric(),
  "PATCH /api/v1/variants/:id": () => byId(at.variant, { note: "Sample." }),
  "POST /api/v1/categories/:path{.+}": (who) =>
    atPath(own(who, "new"), { name: "New" }),
  "PATCH /api/v1/categories/:path{.+}": () =>
    atPath(at.category, { description: "Sample." }),
  "DELETE /api/v1/categories/:path{.+}": (who) => atPath(own(who, "gone")),
  "POST /api/v1/terms/:name": (who) =>
    named(own(who, "new"), { definition: "New." }),
  "PATCH /api/v1/terms/:name": () => named(at.term, { definition: "Sample." }),
  "DELETE /api/v1/terms/:name": (who) => named(own(who, "gone")),
  "PUT /api/v1/terms/:name/columns/:column_id": termColumn,
  "DELETE /api/v1/terms/:name/columns/:column_id": termColumn,
  "PUT /api/v1/terms/:name/metrics/:metric": termMetric,
  "DELETE /api/v1/terms/:name/metrics/:metric": termMetric,
  "PUT /api/v1/elements/:kind/:id/docs": () =>
    salesDocs({ description: "every order line." }),
  "PUT /api/v1/elements/:kind/:id/icon": () => salesDocs({ icon: "emoji:🛒" }),
  "DELETE /api/v1/elements/:kind/:id/icon": () => salesDocs(),
  "PUT /api/v1/conventions": () => ({ body: checksOff() }),
  "POST /api/v1/conventions/diff": () => ({ body: checksOff() }),
  "POST /api/v1/queries": () => ({
    body: { dataset: at.sales, dax: at.salesDax },
    missingBody: { dataset: nobody(), dax: at.salesDax },
  }),
  "GET /api/v1/queries/:id": () => byId(at.query),
  "GET /api/v1/results/:id": () => byId(at.result),
  "POST /api/v1/results/:id/csv-link": () => byId(at.result),
  // Anonymous holds the signed link; anyone else shows their own credential.
  "GET /api/v1/results/:id/csv": (who) =>
    who === "anonymous"
      ? { segments: { id: at.result }, query: at.csvLink }
      : byId(at.result),
  "POST /api/v1/threads": () => ({
    body: comment(at.metricId),
    missingBody: comment(nobody()),
  }),
  "GET /api/v1/usage/report": () => ({
    query: `since=${new Date(Date.now() - 86_400_000).toISOString()}`,
  }),
  "POST /api/v1/requests": () => ({ body: ASKED }),
  "GET /api/v1/requests/:id": () => byId(at.request),
  // The curator elsewhere reads the request, so its refusal tells nothing a missing one would hide.
  "DELETE /api/v1/requests/:id": (who) =>
    who === "curator_elsewhere"
      ? { segments: { id: at.doomed[who] ?? "" } }
      : byId(at.doomed[who] ?? ""),
  "GET /api/v1/threads/:id": () => byId(at.thread),
  "POST /api/v1/threads/:id/replies": () =>
    byId(at.thread, { body: "a reply." }),
  "PUT /api/v1/threads/:id/upvote": () => byId(at.thread),
  "DELETE /api/v1/threads/:id/upvote": () => byId(at.thread),
  "POST /api/v1/threads/:id/accept": () =>
    byId(at.acceptThread, { reply_id: at.reply }),
  "POST /api/v1/threads/:id/archive": () => byId(at.archiveThread),
  "GET /api/v1/search": () => ({ query: "query=sales" }),
  "GET /api/v1/metrics/:name": () => theMetric(),
  "GET /api/v1/metrics/:name/variants": () => theMetric(),
  "GET /api/v1/variants/:id": () => byId(at.variant),
  "GET /api/v1/terms/:name": () => named(at.term),
  "GET /api/v1/datasets/:id": sales,
  "GET /api/v1/datasets/:id/columns": sales,
  "GET /api/v1/datasets/:id/columns/:column_id": salesColumn,
  "GET /api/v1/datasets/:id/measures": sales,
  "GET /api/v1/elements/:kind/:id/docs": () => salesDocs(),
  "GET /api/v1/events": () => ({ query: "after=0" }),
  "GET /api/v1/admin/settings/:key": () => ttl(),
  "PUT /api/v1/admin/settings/:key": () => ttl({ value: 24 }),
  "GET /api/v1/admin/pii/rules": () => ({}),
  "PUT /api/v1/admin/pii/rules": () => ({
    body: { kind: "column", table: "Customer", name: "Customer", pii: true },
  }),
  "DELETE /api/v1/admin/pii/rules/:id": () => ({
    segments: { id: randomUUID() },
    past: [404],
  }),
  "GET /api/v1/admin/pii/suggestions": () => ({}),
  "GET /api/v1/admin/datasets": () => ({}),
  "PUT /api/v1/admin/datasets/:dataset": () => ({
    segments: { dataset: "missing_dataset" },
    body: { enabled: true },
    past: [404],
  }),
  // Saved once the api has started its secrets store; a test app has none.
  "PUT /api/v1/admin/secrets/:name": () => ({
    segments: { name: "openai_api_key" },
    body: { value: "sk-sample-matrix" },
    past: [409],
  }),
  // 400 when the secret has no value yet, the answer after authorization.
  "PUT /api/v1/admin/secrets/:name/expiry": () => ({
    segments: { name: "openai_api_key" },
    body: { expires_at: null },
    past: [400],
  }),
  "POST /api/v1/admin/checks/:name": () => ({ segments: { name: "address" } }),
  // A check the worker runs, which the GET polls.
  "GET /api/v1/admin/checks/:name": () => ({ segments: { name: "scanner" } }),
  "POST /api/v1/admin/roles": () => ({
    body: { ...VIEWER, subject: `new-${tag}@x.test` },
  }),
  "DELETE /api/v1/admin/roles/:id": () => byId(at.role),
  // No such person or invite: 404 is the answer after authorization.
  "PUT /api/v1/admin/people/:id/role": () => noSuchPerson({ role: "viewer" }),
  "PUT /api/v1/admin/people/:id/pii": () => noSuchPerson({ allowed: true }),
  "POST /api/v1/admin/people/:id/deactivate": () => noSuchPerson(),
  "POST /api/v1/admin/people/:id/reactivate": () => noSuchPerson(),
  "POST /api/v1/admin/people/:id/sign-out": () => noSuchPerson(),
  "DELETE /api/v1/admin/people/:id": () => noSuchPerson(),
  "POST /api/v1/admin/people/invites/:id/resend": () => noSuchPerson(),
  "DELETE /api/v1/admin/people/invites/:id": () => noSuchPerson(),
  // A JSON body is no image: 400 comes from the type check, after authorization.
  "PUT /api/v1/admin/branding/logo": () => ({ body: {}, past: [400] }),
  "POST /api/v1/admin/sync": () => ({ body: {} }),
  "POST /api/v1/admin/service-accounts": () => ({
    body: { name: `new_${tag}`, owner_email: OWNER, roles: ["viewer"] },
  }),
  "PATCH /api/v1/admin/service-accounts/:name": () =>
    named(at.spare, { owner_email: OWNER }),
  "DELETE /api/v1/admin/service-accounts/:name": () => named(`gone_${tag}`),
  "GET /api/v1/admin/service-accounts/:name/keys": () => named(at.spare),
  "POST /api/v1/admin/service-accounts/:name/keys": () =>
    named(at.spare, { expires_in_days: 7 }),
  "DELETE /api/v1/admin/service-accounts/:name/keys/:id": () => ({
    segments: { name: at.spare, id: at.spareKey },
    missing: { id: nobody() },
  }),
  // No such grant: nobody's tokens are revoked.
  "DELETE /api/v1/admin/grants/:id": noSuchGrant,
  "POST /api/v1/admin/import": () => ({
    body: { yaml: "format: 1\nsettings:\n  results.ttl_hours: 48\n" },
  }),
  // 404 until an admin stores a logo, the route's own answer.
  "GET /api/branding/logo": () => ({ past: [404] }),
  "GET /api/v1/oauth/consent": () => ({ query: "client_id=no", past: NOTHING }),
  "POST /api/v1/oauth/consent": () => deny("request"),
  "GET /api/v1/oauth/device": () => ({ query: "user_code=NO", past: NOTHING }),
  "POST /api/v1/oauth/device": () => deny("user_code"),
  "POST /api/setup/session": () => setup({ token: "guessed" }),
  "GET /api/setup": () => setup(),
  "POST /api/setup/tenant": () => setup(),
  "GET /assets/:file": () => ({ segments: { file: "app-4f2a.js" } }),
  "GET /review/metrics/:name": () => ({
    segments: { name: "number_of_orders" },
  }),
  "GET /catalog/categories/*": () => ({
    segments: { "*": "sales/orders" },
  }),
  "GET /catalog/metrics/:name": () => ({
    segments: { name: "net_sales" },
  }),
  "GET /catalog/terms/:term": () => ({
    segments: { term: "Channel" },
  }),
  "GET /catalog/datasets/:id": () => ({
    segments: { id: "d0000000-0000-4000-8000-000000000001" },
  }),
  "GET /catalog/datasets/:id/tables/:table": () => ({
    segments: { id: "d0000000-0000-4000-8000-000000000001", table: "Sales" },
  }),
  "GET /catalog/datasets/:id/tables/:table/folders/:folder": () => ({
    segments: {
      id: "d0000000-0000-4000-8000-000000000001",
      table: "Sales",
      folder: "Dates%5CFiscal",
    },
  }),
  "GET /catalog/datasets/:id/tables/:table/columns/:column": () => ({
    segments: {
      id: "d0000000-0000-4000-8000-000000000001",
      table: "Sales",
      column: "Channel",
    },
  }),
  // 404 when the docs are not built, and for a page the site does not have:
  // either is the docs' own answer, after authorization.
  "GET /docs": () => ({ past: [404] }),
  "GET /docs/*": () => ({ segments: { "*": "no-page" }, past: [404] }),
};

/** Each `:name` (or `:name{pattern}`) and `*` of the route's path, filled from `segments`. */
function fill(pattern: string, segments: Record<string, string>): string {
  return pattern.replace(/:(\w+)(\{[^}]*\})?|\*/g, (_, name?: string) => {
    const value = segments[name ?? "*"];
    if (value === undefined)
      throw new Error(`${pattern} needs a value for ${name ?? "*"}`);
    return name === undefined ? value : encodeURIComponent(value);
  });
}

async function routeTarget(key: RouteKey, who: RouteCaller) {
  const [method = "", pattern = ""] = key.split(" ");
  const step = pattern.startsWith("/api/setup/steps/");
  const spec =
    (await ROUTE_REQUESTS[key]?.(who)) ??
    (step ? setup({ settings: "none" }) : {});
  const query = spec.query === undefined ? "" : `?${spec.query}`;
  const segments = spec.segments ?? {};
  const call = (values: Record<string, string>, body: unknown): Call => ({
    method,
    path: `${fill(pattern, values)}${query}`,
    body,
    ...(spec.form === undefined ? {} : { form: spec.form }),
  });
  const named = spec.missing !== undefined || spec.missingBody !== undefined;
  return {
    call: call(segments, spec.body),
    missing: named
      ? call({ ...segments, ...spec.missing }, spec.missingBody ?? spec.body)
      : null,
    missingBy: spec.missingBy ?? who,
    past: spec.past ?? [],
    swaps: swapsOf(segments, spec.missing ?? {}),
  };
}

type ToolSpec = { input: object; missing?: object };
/** A tool's input naming its target in `field`, and the same input naming a missing one. */
const about = (
  field: string,
  value: string,
  rest: object = {},
  missing: string = nobody(),
): ToolSpec => ({
  input: { [field]: value, ...rest },
  missing: { [field]: missing },
});

/** Each missing reference beside the real one it stands for, so a message that repeats the caller's own words compares equal. */
const swapsOf = (real: object, missing: object): [string, string][] =>
  Object.entries(missing).flatMap(([name, value]: [string, unknown]) => {
    const was: unknown = Object.entries(real).find(([n]) => n === name)?.[1];
    return typeof value === "string" && typeof was === "string"
      ? [[value, was]]
      : [];
  });

/** A tool with no entry is called with no input. */
const TOOL_REQUESTS: Partial<Record<ToolName, () => ToolSpec>> = {
  search: () => ({ input: { query: "sales" } }),
  get_metric: () => about("name", at.metric, {}, MISSING),
  list_variants: () => about("metric", at.metric, {}, MISSING),
  get_variant: () => about("id", at.variant),
  get_term: () => ({ input: { name: at.term } }),
  get_dataset: () => about("id", at.sales),
  list_columns: () => about("dataset", at.sales),
  list_measures: () => about("dataset", at.sales),
  execute_dax: () => about("dataset", at.sales, { dax: at.salesDax }),
  read_query_result: () => about("result_id", at.result),
  get_result_csv_link: () => about("result_id", at.result),
  get_query: () => ({ input: { id: at.query } }),
  post_thread: () => ({
    input: comment(at.metricId),
    missing: { element: { kind: "metric", id: nobody() } },
  }),
  reply_in_thread: () => about("thread_id", at.thread, { body: "A reply." }),
  get_thread: () => about("thread_id", at.thread),
  accept_reply: () =>
    about("thread_id", at.acceptThread, { reply_id: at.reply }),
  set_upvote: () => about("thread_id", at.thread, { upvoted: true }),
  record_request: () => ({ input: ASKED }),
  get_usage_report: () => ({
    input: { since: new Date(Date.now() - 86_400_000).toISOString() },
  }),
  get_request: () => about("id", at.request),
};

// The cells.

const CONNECTOR = { method: "POST", path: "/api/mcp" };
const bearer = (value: string) => ({ authorization: `Bearer ${value}` });

/** Each caller's credential; a person reaches /api/mcp with an MCP client's token. */
const credential = (who: RouteCaller | ToolCaller): Record<string, string> =>
  ({
    anonymous: {},
    outsider: { cookie: session.outsider },
    viewer: { cookie: session.viewer },
    curator: { cookie: session.curator },
    admin: { cookie: session.admin },
    curator_elsewhere: { cookie: session.curator_elsewhere },
    curator_session: { cookie: session.curator },
    service_account: bearer(key.none),
    service_account_granted: bearer(key.granted),
    curator_cli_token: bearer(key.cli),
    curator_mcp_token: bearer(mcpToken.curator),
  })[who];

type Answer = { status: number; text: string };

async function send(headers: Record<string, string>, call: Call) {
  const { method, path, form: fields } = call;
  const json = call.body === undefined ? null : JSON.stringify(call.body);
  const body = fields ? new URLSearchParams({ ...fields }).toString() : json;
  const type = fields ? FORM : "application/json";
  const sent = { ...headers, origin: BASE, "content-type": type };
  const answer = await fromPeer(path, { method, headers: sent, body });
  return { status: answer.status, text: await answer.text() };
}

const errorKind = (text: string): unknown =>
  z.object({ error: z.unknown() }).safeParse(JSON.parse(text)).data?.error;

/** Callers who reach nothing in Power BI: a refusal must not tell them an existing target from a missing one. */
const BLIND: readonly string[] = [
  "outsider",
  "service_account",
  "curator_elsewhere",
];
/** The query log names the datasets queried to everyone: an accepted risk (threat_model.md, Residual risks). */
const QUERY_LOG = [
  "GET /api/v1/queries",
  "GET /api/v1/queries/:id",
  "search_query_log",
  "get_query",
];
/** What an answer to a blind caller must never hold. */
const salesIds = () => [
  at.sales,
  `"${at.metric}"`,
  at.metricId,
  at.variant,
  at.column,
  at.thread,
];

const REST_ROUTE = /^\w+ \/api\/v1\//;
/** The admin section, which names people by email. */
const ADMIN_ROUTE = /^\w+ \/api\/v1\/admin\//;
/** The other routes that may hold a person's email, each by key: the caller's own and the consent that names the caller. A new route is not exempt until it is listed. */
const EMAIL_ROUTES = [
  "GET /api/v1/me",
  "GET /api/v1/me/connection",
  "GET /api/v1/me/grants",
  "DELETE /api/v1/me/grants/:id",
  "GET /api/v1/oauth/consent",
  "POST /api/v1/oauth/consent",
  "GET /api/v1/oauth/device",
  "POST /api/v1/oauth/device",
];
const seededEmails = () =>
  Object.values(PEOPLE).map(({ mailbox }) => f.person(mailbox).email);

/** The answer against the verdict, and against the missing target's answer where they must match. */
async function judge(
  cell: { verdict: Verdict; who: string; name: string },
  answer: Answer,
  missing: (() => Promise<Answer>) | null,
  past: number[],
): Promise<void> {
  const verdict = cell.verdict;
  const said = `${String(answer.status)} ${answer.text.slice(0, 400)}`;
  if (verdict === "allowed") {
    const passed = answer.status < 400 || past.includes(answer.status);
    expect(passed, said).toBe(true);
    if (BLIND.includes(cell.who) && !QUERY_LOG.includes(cell.name))
      for (const id of salesIds()) expect(answer.text, said).not.toContain(id);
    // Only the admin section, /me and the consent name a person by email.
    if (
      REST_ROUTE.test(cell.name) &&
      !ADMIN_ROUTE.test(cell.name) &&
      !EMAIL_ROUTES.includes(cell.name)
    )
      for (const email of seededEmails())
        expect(answer.text, `${cell.name} as ${cell.who}`).not.toContain(email);
    return;
  }
  const status = { unauthenticated: 401, refused: 403, hidden: 404 }[verdict];
  expect(answer.status, said).toBe(status);
  const compared =
    verdict === "hidden" || (verdict === "refused" && BLIND.includes(cell.who));
  // A refusal that names no target has nothing to tell apart.
  if (!compared || (missing === null && verdict === "refused")) return;
  if (missing === null) throw new Error("a hidden cell needs a missing call");
  expect(await missing()).toEqual(answer);
}

const swapped = (answer: Answer, swaps: [string, string][]): Answer => ({
  ...answer,
  text: swaps.reduce(
    (text, [from, to]) => text.replaceAll(from, to),
    answer.text,
  ),
});

describe("each tool, for each caller", () => {
  const cells = Object.entries(TOOL_MATRIX).flatMap(([name, row]) =>
    TOOL_CALLERS.map((who) => ({
      name: name as ToolName,
      who,
      verdict: row[who],
    })),
  );
  /** A tool's answer as REST would give it: a refusal in the body becomes its status. */
  const call = async (who: ToolCaller, name: string, input: object) => {
    const body = { ...rpc("tools/call"), params: { name, arguments: input } };
    const headers = isPerson(who) ? bearer(mcpToken[who]) : credential(who);
    const sent = await send(headers, { ...CONNECTOR, body });
    if (sent.status !== 200) return sent;
    const { result } = z
      .object({
        result: z.object({
          content: z.array(z.object({ text: z.string() })),
          isError: z.literal(true).optional(),
        }),
      })
      .parse(JSON.parse(sent.text));
    const text = result.content[0]?.text ?? "";
    if (result.isError !== true) return { status: 200, text };
    const statuses: Record<string, number> = { refused: 403, not_found: 404 };
    return { status: statuses[String(errorKind(text))] ?? 400, text };
  };
  it.each(cells)("$name as $who: $verdict", async ({ name, who, verdict }) => {
    const { input, missing } = TOOL_REQUESTS[name]?.() ?? { input: {} };
    const answer = await call(who, name, input);
    const swaps = swapsOf(input, missing ?? {});
    const other =
      missing === undefined
        ? null
        : async () =>
            swapped(await call(who, name, { ...input, ...missing }), swaps);
    await judge({ verdict, who, name }, answer, other, []);
  });
});

// Before the routes: their last rows end the callers' sessions.
describe("a path no route claims", () => {
  it.each(ROUTE_CALLERS)(
    "GET /no-screen-claims-this as %s: the gate's 401 without a session, the app's own 404 with one",
    async (who) => {
      const answer = await send(credential(who), {
        method: "GET",
        path: "/no-screen-claims-this",
      });
      const said = `${String(answer.status)} ${answer.text.slice(0, 400)}`;
      expect(answer.status, said).toBe(isPerson(who) ? 404 : 401);
      if (isPerson(who)) expect(answer.text).toBe("404 Not Found");
    },
  );
});

describe("who asked", () => {
  const asker = async (who: RouteCaller) => {
    const path = `/api/v1/threads?element_kind=term&element_id=${at.termId}`;
    const answer = await send(credential(who), { method: "GET", path });
    expect(answer.status, answer.text).toBe(200);
    return z
      .object({
        items: z.array(z.object({ author_name: z.string().nullable() })),
      })
      .parse(JSON.parse(answer.text)).items;
  };
  it.each(["outsider", "service_account"] as const)(
    "is not told to %s, who can see no dataset, on a term's question",
    async (who) => {
      expect(await asker(who)).toEqual([{ author_name: null }]);
    },
  );
  it("is told to a viewer, by display name and not by email", async () => {
    const [thread] = await asker("viewer");
    expect(thread?.author_name).toEqual(expect.any(String));
    expect(thread?.author_name).not.toContain("@");
  });
});

describe("each route, for each caller", () => {
  const cells = Object.entries(ROUTE_MATRIX).flatMap(([key, row]) =>
    ROUTE_CALLERS.map((who) => ({
      key: key as RouteKey,
      who,
      verdict: row[who],
    })),
  );
  it.each(cells)("$key as $who: $verdict", async ({ key, who, verdict }) => {
    const target = await routeTarget(key, who);
    const { call, missing, missingBy, past, swaps } = target;
    const answer = await send(credential(who), call);
    const other =
      missing === null
        ? null
        : async () =>
            swapped(await send(credential(missingBy), missing), swaps);
    await judge({ verdict, who, name: key }, answer, other, past);
  });
});
