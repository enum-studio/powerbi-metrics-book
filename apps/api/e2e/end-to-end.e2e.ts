// The product end to end on the compose stack and the Power BI mock, never a
// real tenant: each test is one clause of the spec's "End to end" bullet (How
// it is tested), in its order, and each builds on what the one before left.
// Every failure names the request and what the api answered.
import {
  EXPECTED_DRAFTS,
  EXPECTED_UNPROVEN_SHIFTS,
  sampleTenant,
} from "@powerbi-metrics-book/powerbi-mock";
import { describe, expect, inject, it } from "vitest";
import { SAMPLE } from "../src/services/sample/tenant.js";
import { SAMPLE_IDS } from "../../../packages/powerbi-mock/src/sample/tenant.js";
import {
  answered,
  bearer,
  type Browser,
  browser,
  connectPowerBi,
  json,
  signInWithMicrosoft,
} from "./browser.js";
import { type Cli, loginCli } from "./cli.js";
import { type McpClient, signInMcpClient } from "./mcp-client.js";
import { compose } from "./stack.js";

const stack = inject("e2e_stack");
const SALES_DATASET = sampleDataset(SAMPLE_IDS.datasets.sales);
const SALES = SALES_DATASET.name;
const MARKETING = sampleDataset(SAMPLE_IDS.datasets.marketing).name;
// The sample people's object ids at the mock's Microsoft.
const ADMIN = SAMPLE.people["admin@sample.example"];
const VIEWER = SAMPLE.people["viewer@sample.example"];
const ANALYST = SAMPLE.people["analyst@sample.example"];

type Step = {
  status: "passing" | "failing" | "explained";
  message: string;
  action?: string;
  pending?: true;
  confirm?: { email: string };
};
type Whoami = { email?: string | null; via: string; roles: string[] };
type Page<T> = { items: T[]; next_cursor: string | null };
type Shift = {
  period: string;
  comparison: string;
  comparison_period: string | null;
};
type VariantItem = {
  id: string;
  dataset: { name: string };
  measure: { name: string };
  shift: Shift;
};
type Dataset = {
  id: string;
  name: string;
  workspace: { id: string };
  reached_through: { kind: string; name: string }[];
};
type ResultPage = {
  columns: { name: string }[];
  offset: number;
  rows: unknown[][];
  next_offset: number | null;
};
type FeedEvent = {
  id: number;
  kind: string;
  element: { kind: string; id: string } | null;
};

/** What the suite carries forward from one clause to the next. */
const state = {
  admin: browser(stack.url),
  curator: browser(stack.url),
  viewer: browser(stack.url),
  datasets: new Map<string, Dataset>(),
  feed_start: 0,
  /** The admin's CLI login, which the feed follower reads with. */
  admin_token: "",
  changes: [] as { kind: string; element_id: string; what: string }[],
};
let curatorCli: Cli;
let viewerMcp: McpClient;
let netSales: { id: string; key: string };
let adSpend: { id: string; key: string };
let threadId: string;
let queryId: string;
let appQueryId: string;

/** A change the feed follower must see, in the order it was made. */
const changed = (kind: string, element_id: string, what: string) =>
  state.changes.push({ kind, element_id, what });
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Asks again every 2 s for 2 minutes, for what the worker does after a change. */
async function until<T>(
  what: () => string,
  attempt: () => Promise<T | undefined>,
) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const got = await attempt();
    if (got !== undefined) return got;
    if (Date.now() > deadline) throw new Error(`After 2 minutes, ${what()}`);
    await sleep(2000);
  }
}

/** POST /api/setup/steps/<id> as the admin's browser; the check's answer. */
async function step(id: string, input: object = {}): Promise<Step> {
  return json<Step>(
    await state.admin.send(`/api/setup/steps/${id}`, {
      method: "POST",
      json: input,
    }),
    200,
    `POST /api/setup/steps/${id}`,
  );
}

/**
 * A step whose check must pass. The worker's checks answer pending until it
 * has run them, so the first call starts the check and, as the setup screen
 * does, empty ones ask again until the step is no longer pending.
 */
async function pass(id: string, input: object = {}): Promise<void> {
  let result = await step(id, input);
  if (result.pending === true) {
    const started = result;
    result = await until(
      () => `the ${id} step was still pending: ${started.message}`,
      async () => {
        const again = await step(id);
        return again.pending === true ? undefined : again;
      },
    );
  }
  if (result.status !== "passing")
    throw new Error(
      `The ${id} step's check is ${result.status}: ${result.message}`,
    );
}

/** The first query the mock recorded for a dataset, with its rows. */
function recordedQuery(dataset: string) {
  const recorded = sampleTenant().datasets.find((each) => each.name === dataset)
    ?.recorded_queries[0];
  if (recorded === undefined)
    throw new Error(`The sample records no query on ${dataset}`);
  return recorded;
}

function sampleDataset(id: string) {
  const dataset = sampleTenant().datasets.find((each) => each.id === id);
  if (dataset === undefined) throw new Error(`The sample has no dataset ${id}`);
  return dataset;
}

const secret = (value: string) => ({
  value,
  expires_at: "2099-12-31T00:00:00Z",
});

/** The curator's description of the Net sales draft, as `pbmb metrics update` flags. */
const NET_SALES = {
  label: "Total net sales excl VAT",
  definition:
    "What customers paid for the order lines, before returns, excluding VAT.",
  aliases: "Turnover, Net sales",
  "when-to-use":
    "To see how much was sold in a period. For how many orders, use Number of orders.",
  "not-the-same-as":
    "Web net sales LY, which counts the web channel in the previous year only.",
  grain: "One order line. Test orders left out. VAT excluded.",
  unit: "money",
};
const flags = (fields: Record<string, string>) =>
  Object.entries(fields).flatMap(([name, value]) => [`--${name}`, value]);

/** The change feed after an id, page by page with ?after=, as a tool follows it. */
async function feedAfter(
  after: number,
  send: (path: string) => Promise<Response>,
): Promise<FeedEvent[]> {
  const seen: FeedEvent[] = [];
  for (;;) {
    const path = `/api/v1/events?after=${String(after)}&limit=10`;
    const page = await json<FeedEvent[]>(await send(path), 200, `GET ${path}`);
    if (page.length === 0) return seen;
    seen.push(...page);
    after = page.at(-1)?.id ?? after;
  }
}

/** Every item of a list route, following next_cursor. */
async function all<T>(web: Browser, path: string): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const at: string =
      cursor === null
        ? path
        : `${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`;
    const page: Page<T> = await web.get<Page<T>>(at);
    items.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor !== null);
  return items;
}

/** Every draft's variants, keyed by "<dataset>/<measure>", as the admin sees them. */
async function draftsByMeasure() {
  const found = new Map<
    string,
    { metric: { id: string; key: string }; shift: Shift; variant_id: string }
  >();
  const drafts = await all<{ id: string; name: string }>(
    state.admin,
    "/api/v1/metrics?trust_states=draft&limit=500",
  );
  for (const metric of drafts)
    for (const variant of await all<VariantItem>(
      state.admin,
      `/api/v1/metrics/${encodeURIComponent(metric.name)}/variants?limit=500`,
    ))
      found.set(`${variant.dataset.name}/${variant.measure.name}`, {
        metric: { id: metric.id, key: metric.name },
        shift: variant.shift,
        variant_id: variant.id,
      });
  return found;
}

/** A tiny RFC 4180 reader: quoted fields, doubled quotes, CRLF or LF. */
function readCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  // A field, quoted or not, and what ends it: a comma, a line end or the text's end.
  const fields = /("(?:[^"]|"")*"|[^",\r\n]*)(,|\r?\n|$)/g;
  for (const [, field = "", end] of text.matchAll(fields)) {
    const quoted = field.startsWith('"');
    row.push(quoted ? field.slice(1, -1).replaceAll('""', '"') : field);
    if (end === ",") continue;
    // The empty line after the last line end is no row.
    if (end !== "" || row.length > 1 || field !== "") rows.push(row);
    if (end === "") break;
    row = [];
  }
  return rows;
}

describe("Power BI Metrics Book end to end, on the mock", () => {
  it("sets up through the API from an empty database, the admin signing in with Microsoft", async () => {
    // The api's log holds no link: a person prints it with `server setup-link`.
    const link = compose(stack, [
      "exec",
      "-T",
      "api",
      "server",
      "setup-link",
    ]).match(/https?:\/\/\S+/)?.[0];
    if (link === undefined)
      throw new Error("server setup-link printed no link on an empty database");
    const token = new URLSearchParams(new URL(link).hash.slice(1)).get("token");
    await answered(
      await state.admin.send("/api/setup/session", {
        method: "POST",
        json: { token },
      }),
      204,
      "Opening the setup link (POST /api/setup/session)",
    );

    await pass("address");

    const registered = await step("app_registration", {
      settings: {
        "powerbi.tenant_id": SAMPLE.tenant_id,
        "powerbi.app_client_id": SAMPLE.app.client_id,
      },
      secrets: { powerbi_app_client_secret: secret(SAMPLE.app.secret) },
    });
    if (registered.action !== "sign_in")
      throw new Error(
        `The app registration step did not ask the admin to sign in: ${registered.message}`,
      );
    await signInWithMicrosoft(state.admin, stack, ADMIN, "/setup");
    const { confirm } = await step("app_registration");
    expect(confirm?.email, "the person setup asks to confirm").toBe(
      "admin@sample.example",
    );
    await step("app_registration", { confirm_email: confirm?.email });
    await connectPowerBi(state.admin, stack, ADMIN);
    await pass("app_registration");

    await pass("scanner", {
      settings: { "powerbi.scanner_client_id": SAMPLE.scanner.client_id },
      secrets: {
        powerbi_scanner_client_secret: secret(SAMPLE.scanner.secret),
      },
    });
    // Nothing is saved on this step, so the check is started by name.
    await pass("what_to_sync", { start_check: true });
    await pass("sign_in");
    // The analyst curates; everyone else in the tenant gets the default, viewer.
    await pass("who_gets_in", {
      settings: { "access.default_role": "viewer" },
      assignments: [
        {
          role: "curator",
          subject_kind: "person",
          subject: "analyst@sample.example",
        },
      ],
    });
    // The mock answers OpenAI's embeddings route; any key is a key to it.
    await pass("search", {
      settings: {
        "search.provider": "openai",
        "search.model": "text-embedding-3-small",
      },
      secrets: { openai_api_key: secret("sample-openai-key") },
    });

    // The admin's own MCP client reaches the connector, which is what the
    // agents step waits for.
    const adminMcp = await signInMcpClient(`${stack.url}/api/mcp`, state.admin);
    const me = await adminMcp.call<Whoami>("whoami");
    expect(me, "whoami through the admin's MCP client").toMatchObject({
      via: "mcp",
      roles: expect.arrayContaining(["admin"]) as unknown,
    });
    await pass("agents");

    let sync = await step("first_sync", { start_sync: true });
    const deadline = Date.now() + 5 * 60_000;
    while (sync.status !== "passing") {
      if (!/running|waits for the worker/.test(sync.message))
        throw new Error(`The first sync did not pass: ${sync.message}`);
      if (Date.now() > deadline)
        throw new Error(`The first sync did not finish: ${sync.message}`);
      await sleep(3000);
      sync = await step("first_sync");
    }
    await pass("security");

    const setup = await state.admin.get<{
      steps: { id: string; passed: boolean }[];
    }>("/api/setup");
    expect(
      setup.steps.filter((each) => !each.passed).map((each) => each.id),
      "setup steps not passed",
    ).toEqual([]);
    // The first run is these five; the other steps live on in /admin.
    expect(setup.steps.map((each) => each.id)).toEqual([
      "address",
      "app_registration",
      "scanner",
      "what_to_sync",
      "first_sync",
    ]);
  });

  it("runs the sync, which leaves drafts with the sample tenant's groups and variants", async () => {
    type Runs = { runs: { kind: string; status: string }[] };
    const { runs } = await state.admin.get<Runs>("/api/v1/admin/sync");
    // A scheduled sync right after the first one is skipped, as it should be.
    const ran = runs.filter((each) => each.status !== "skipped");
    expect(ran[0], "the latest sync that ran").toMatchObject({
      kind: "full",
      status: "succeeded",
    });

    const drafts = await draftsByMeasure();
    const current = { period: "current", comparison: "none" };
    const unproven = new Set(EXPECTED_UNPROVEN_SHIFTS);
    // Each expected draft is one metric holding its measures and no other,
    // so two expected drafts can never share one.
    expect(EXPECTED_DRAFTS.length).toBeGreaterThan(0);
    for (const draft of EXPECTED_DRAFTS) {
      const members = [
        ...draft.base.map((each) => ({
          ...each,
          shift: unproven.has(each.measure)
            ? { ...current, period: "other" }
            : current,
        })),
        ...draft.variants,
      ];
      const ats = members.map((each) => `${each.dataset}/${each.measure}`);
      const home = drafts.get(ats[0] ?? "")?.metric;
      const held = [...drafts].filter(
        ([, each]) => each.metric.id === home?.id,
      );
      expect(
        held.map(([at]) => at).sort(),
        `the draft of ${ats[0] ?? ""}`,
      ).toEqual(ats.sort());
      for (const member of members)
        expect(
          drafts.get(`${member.dataset}/${member.measure}`)?.shift,
          `the shift of ${member.dataset}/${member.measure}`,
        ).toMatchObject(member.shift);
    }
    const net = drafts.get(`${SALES}/Net sales`);
    const spend = drafts.get(`${MARKETING}/Ad spend`);
    if (net === undefined || spend === undefined)
      throw new Error("The Net sales or the Ad spend draft is missing");
    netSales = net.metric;
    adSpend = spend.metric;

    for (const each of await all<Dataset>(
      state.admin,
      "/api/v1/datasets?limit=500",
    ))
      state.datasets.set(each.name, each);
  });

  it("lets the app-only dataset's audience see it and query it", async () => {
    await signInWithMicrosoft(state.viewer, stack, VIEWER);
    await connectPowerBi(state.viewer, stack, VIEWER);
    const seen = await all<Dataset>(state.viewer, "/api/v1/datasets?limit=500");
    expect(
      seen.map((each) => each.name),
      "the datasets the viewer sees",
    ).toEqual(["Retail", SALES]);
    expect(
      seen.map((each) => each.reached_through.map((reach) => reach.kind)),
    ).toEqual([["app"], ["app"]]);

    const sales = seen.find((each) => each.name === SALES);
    if (sales === undefined) throw new Error("The viewer cannot see Sales");

    const recorded = recordedQuery(SALES);
    const ran = await json<{ row_count: number; query_id: string }>(
      await state.viewer.send("/api/v1/queries", {
        method: "POST",
        json: {
          dataset: sales.id,
          dax: recorded.dax,
          purpose: "End-to-end: the app audience queries",
        },
      }),
      201,
      "POST /api/v1/queries as the Sales app's audience",
    );
    expect(ran.row_count).toBe(recorded.rows.length);
    appQueryId = ran.query_id;
  });

  it("takes an agent's curation through pbmb, and pbmb metrics check passes", async () => {
    await signInWithMicrosoft(state.curator, stack, ANALYST);
    curatorCli = await loginCli(stack.url, state.curator);
    const me = await curatorCli.json<Whoami>(["whoami"]);
    expect(me, "pbmb whoami").toMatchObject({
      email: "analyst@sample.example",
      via: "cli",
      roles: expect.arrayContaining(["curator"]) as unknown,
    });
    const before = await feedAfter(0, (path) => state.admin.send(path));
    state.feed_start = before.at(-1)?.id ?? 0;

    const key = "total_net_sales_excl_vat";
    await curatorCli.json(["metrics", "rename", netSales.key, key]);
    netSales = { ...netSales, key };
    changed("metric.changed", netSales.id, "rename");
    await curatorCli.json(["metrics", "update", key, ...flags(NET_SALES)]);
    changed("metric.changed", netSales.id, "describe");
    await curatorCli.json(["categories", "create", "sales", "--name", "Sales"]);
    await curatorCli.json(["metrics", "update", key, "--category", "sales"]);
    changed("metric.changed", netSales.id, "categorise");

    // Ad spend LY is Ad spend a year back in a form the patterns do not know:
    // its shift is set first, as Ad spend already holds the current period.
    const lastYear = (await draftsByMeasure()).get(`${MARKETING}/Ad spend LY`);
    if (lastYear === undefined) throw new Error("No draft holds Ad spend LY");
    const shift = flags({
      to: lastYear.metric.key,
      period: "previous_year",
      comparison: "none",
      note: "DATEADD of -365 days: the previous year.",
    });
    await curatorCli.json(["variants", "move", lastYear.variant_id, ...shift]);
    changed("metric.changed", lastYear.metric.id, "set a shift");
    const merge = [lastYear.metric.key, "--into", adSpend.key];
    await curatorCli.json(["metrics", "merge", ...merge]);
    // A merge moves the variant and changes both metrics.
    changed("variant.moved", lastYear.variant_id, "merge");
    changed(
      "metric.changed",
      lastYear.metric.id,
      "merge, the metric folded in",
    );
    changed("metric.changed", adSpend.id, "merge, the metric kept");
    const after = await draftsByMeasure();
    expect(after.get(`${MARKETING}/Ad spend LY`)).toMatchObject({
      metric: { id: adSpend.id },
      shift: {
        period: "previous_year",
        comparison: "none",
        comparison_period: null,
      },
    });

    const term = await curatorCli.json<{ id: string }>([
      ...["terms", "create", "Sales channel", "--aliases", "Channel"],
      "--definition",
      "Where an order was placed: the web shop, a store or a marketplace.",
    ]);
    changed("term.changed", term.id, "create a term");
    await curatorCli.json(["terms", "relate", "Sales channel", key]);
    changed("term.changed", term.id, "link a term");

    // What each step set, read back as an agent reads the metric.
    const described = await curatorCli.json<Record<string, unknown>>([
      ...["metrics", "show", key],
    ]);
    expect(described, "pbmb metrics show").toMatchObject({
      label: NET_SALES.label,
      definition: NET_SALES.definition,
      aliases: NET_SALES.aliases.split(", "),
      when_to_use: NET_SALES["when-to-use"],
      not_the_same_as: NET_SALES["not-the-same-as"],
      grain_and_filters: NET_SALES.grain,
      unit: NET_SALES.unit,
      category: { path: "sales", name: "Sales" },
      terms: [{ id: term.id }],
    });
    type Checked = {
      failing: number;
      metrics: { name: string; checks: { check: string; passed: boolean }[] }[];
    };
    const checked = await curatorCli.json<Checked>(["metrics", "check", key]);
    expect(checked.failing, "failing checks").toBe(0);
    expect(checked.metrics.map((each) => each.name)).toEqual([key]);
    const checks = checked.metrics[0]?.checks ?? [];
    expect(checks.length, "the checks run").toBeGreaterThan(0);
    expect(checks.filter((each) => !each.passed)).toEqual([]);
    await curatorCli.json(["metrics", "verify", key]);
    changed("metric.verified", netSales.id, "verify");
    const shown = await curatorCli.json<{ trust_state: string }>([
      ...["metrics", "show", key],
    ]);
    expect(shown.trust_state).toBe("agent_verified");
  });

  it("finds the metric by an alias and by meaning", async () => {
    const search = (query: string) =>
      state.viewer.get<{
        search_mode: string;
        note: string | null;
        items: { kind: string; id: string; match: string }[];
      }>(`/api/v1/search?kinds=metric&query=${encodeURIComponent(query)}`);
    const byAlias = await search("turnover");
    expect(byAlias.items[0], "the first hit for the alias").toMatchObject({
      kind: "metric",
      id: netSales.id,
      match: "exact",
    });
    // "Income" shares no word with anything the curator wrote, only the
    // concept of sales and turnover in the mock's embeddings (its sample
    // README, "What by meaning matches"): only meaning finds the metric.
    const phrase = "income";
    const written = Object.values(NET_SALES).join(" ").toLowerCase();
    expect(written.split(/\W+/), "the words the curator wrote").not.toContain(
      phrase,
    );
    let seen = "";
    const said = () => `the search for "${phrase}" answered ${seen}`;
    const byMeaning = await until(said, async () => {
      const answer = await search(phrase);
      seen = JSON.stringify(answer).slice(0, 600);
      const hit = answer.items.find((each) => each.id === netSales.id);
      return hit?.match === "meaning" ? answer : undefined;
    });
    expect(byMeaning.search_mode).toBe("hybrid");
    expect(byMeaning.note).toBeNull();
  });

  it("serves an MCP client: OAuth sign-in, DAX, page two and a CSV equal to the pages", async () => {
    viewerMcp = await signInMcpClient(`${stack.url}/api/mcp`, state.viewer);
    const me = await viewerMcp.call<Whoami>("whoami");
    expect(me, "whoami as the viewer").toMatchObject({
      via: "mcp",
      roles: ["viewer"],
    });
    const ran = await viewerMcp.call<{
      result_id: string;
      query_id: string;
      row_count: number;
    }>("execute_dax", {
      dataset: state.datasets.get(SALES)?.id,
      dax: "EVALUATE TOPN(25, 'Sales')",
      purpose: "End-to-end: an agent pages through order lines",
      preview_rows: 5,
    });
    expect(ran.row_count).toBe(25);
    queryId = ran.query_id;

    const pages: ResultPage[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const asked = { result_id: ran.result_id, offset, limit: 10 };
      const page: ResultPage = await viewerMcp.call("read_query_result", asked);
      pages.push(page);
      offset = page.next_offset;
    }
    expect(pages.map((page) => page.rows.length)).toEqual([10, 10, 5]);
    expect(pages[1]?.offset, "page two starts where page one ended").toBe(10);

    const link = await viewerMcp.call<{ url: string }>("get_result_csv_link", {
      result_id: ran.result_id,
    });
    const csv = await answered(
      await fetch(link.url),
      200,
      "Downloading the CSV link",
    );
    const [header, ...csvRows] = readCsv(await csv.text());
    expect(header, "the CSV's header").toEqual(
      pages[0]?.columns.map((each) => each.name),
    );
    // A CSV holds text: a null is an empty cell, any other value its JSON.
    const cell = (value: unknown) =>
      typeof value === "string"
        ? value
        : value === null
          ? ""
          : JSON.stringify(value);
    expect(csvRows, "the CSV's rows against the pages' rows").toEqual(
      pages.flatMap((page) => page.rows.map((row) => row.map(cell))),
    );
  });

  it("refuses a viewer's PII query until the same person receives pii_reader", async () => {
    const path = "/api/v1/admin/pii/rules";
    await json(
      await state.admin.send(path, {
        method: "PUT",
        json: {
          kind: "column",
          table: "Customer",
          name: "Customer",
          pii: true,
          note: "Customer names are personal data",
        },
      }),
      200,
      `PUT ${path}`,
    );
    const query = {
      dataset: SAMPLE_IDS.datasets.sales,
      dax: "DEFINE VAR customer_names = VALUES(Customer[Customer]) EVALUATE Customer",
      purpose: "Check the viewer's PII access",
    };
    const refused = await json<{ error: string; message: string }>(
      await state.viewer.send("/api/v1/queries", {
        method: "POST",
        json: query,
      }),
      403,
      "POST /api/v1/queries without pii_reader",
    );
    expect(refused.error).toBe("refused");
    expect(refused.message).toContain("Customer[Customer]");
    expect(refused.message).toContain("pii_reader");

    const viewer = await state.viewer.get<{ id: string }>("/api/v1/me");
    const { events } = await state.admin.get<{
      events: { detail: { references: string[] } }[];
    }>("/api/v1/admin/audit?action=query.pii_refused");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "query.pii_refused",
      principal_kind: "person",
      principal_id: viewer.id,
      resource_kind: "dataset",
      resource_id: query.dataset,
      decision: "deny",
      reason: "refused",
      detail: { dataset_id: query.dataset },
    });
    expect(events[0]?.detail.references).toContain("Customer[Customer]");

    for (const role of ["viewer", "pii_reader"])
      await json(
        await state.admin.send("/api/v1/admin/roles", {
          method: "POST",
          json: {
            role,
            subject_kind: "person",
            subject: "viewer@sample.example",
          },
        }),
        201,
        `POST /api/v1/admin/roles: ${role} for the viewer`,
      );
    const ran = await json<{ result_id: string; row_count: number }>(
      await state.viewer.send("/api/v1/queries", {
        method: "POST",
        json: query,
      }),
      201,
      "POST /api/v1/queries with pii_reader",
    );
    const customers = SALES_DATASET.tables.find(
      (each) => each.name === "Customer",
    );
    if (customers === undefined)
      throw new Error("The sample has no Customer table");
    expect(ran.row_count).toBe(customers.rows.length);
    const result = await state.viewer.get<ResultPage>(
      `/api/v1/results/${ran.result_id}?limit=500`,
    );
    const nameIndex = result.columns.findIndex(
      (each) => each.name === "Customer[Customer]",
    );
    expect(nameIndex).toBeGreaterThanOrEqual(0);
    expect(result.rows.map((row) => row[nameIndex])).toEqual(
      customers.rows.map((row) => row.Customer),
    );
  });

  it("answers a question asked through MCP from the CLI, unread in the asker's questions", async () => {
    const thread = await viewerMcp.call<{ id: string }>("post_thread", {
      kind: "question",
      element: { kind: "metric", id: netSales.id },
      title: "Does Total net sales excl VAT count returned orders?",
      body: "I compared it with the returns report and the totals differ.",
    });
    threadId = thread.id;
    changed("thread.created", threadId, "ask");
    const answer = "It counts them: the definition says before returns.";
    const reply = await curatorCli.json<{ id: string }>([
      ...["questions", "reply", threadId, "--body", answer],
    ]);
    changed("thread.replied", threadId, "reply");
    await curatorCli.json(["questions", "accept", threadId, reply.id]);
    changed("thread.answered", threadId, "accept");

    type Mine = { id: string; status: string; unread_replies: number };
    const mine = await all<Mine>(state.viewer, "/api/v1/threads?mine=true");
    const asked = mine.find((each) => each.id === threadId);
    expect(asked, "the question in my questions").toMatchObject({
      status: "answered",
      unread_replies: 1,
    });
  });

  it("finds the query in the query log by a word of its DAX", async () => {
    const log = async (word: string) =>
      (
        await state.viewer.get<Page<{ id: string }>>(
          `/api/v1/queries?text=${word}`,
        )
      ).items.map((each) => each.id);
    // TOPN is in the MCP query's DAX and not in the app audience's.
    const found = await log("TOPN");
    expect(found).toContain(queryId);
    expect(found).not.toContain(appQueryId);
    expect(await log("zeppelin"), "a word in no DAX").not.toContain(queryId);
  });

  it("lets a service account's API key query through REST until pbmb sa keys revoke", async () => {
    const adminCli = await loginCli(stack.url, state.admin);
    const name = "sample_e2e_reports";
    // Its grant names the workspace it may query, where the app's service
    // principal, which its queries run as, is a Member.
    const marketing = state.datasets.get(MARKETING);
    const owner = flags({
      owner: "admin@sample.example",
      role: "viewer",
      workspace: marketing?.workspace.id ?? "",
    });
    // Off by default: the admin turns service-account queries on.
    const setting = ["powerbi.service_account_queries", "true"];
    await adminCli.json(["admin", "settings", "set", ...setting]);
    await adminCli.json(["sa", "create", name, ...owner]);
    type Key = { id: string; key: string };
    const key = await adminCli.json<Key>(["sa", "keys", "create", name]);
    const recorded = recordedQuery(MARKETING);
    const query = () =>
      bearer(`${stack.url}/api/v1/queries`, key.key, {
        method: "POST",
        json: { dataset: marketing?.id, dax: recorded.dax },
      });
    const asKey = await json<Whoami>(
      await bearer(`${stack.url}/api/v1/me`, key.key),
      200,
      "GET /api/v1/me with the key",
    );
    expect(asKey, "a key holds no person").toMatchObject({ email: null });
    const ran = await json<{ row_count: number }>(
      await query(),
      201,
      "POST /api/v1/queries with the key",
    );
    expect(ran.row_count).toBe(recorded.rows.length);

    await adminCli.json(["sa", "keys", "revoke", name, key.id]);
    await answered(
      await query(),
      401,
      "POST /api/v1/queries with the revoked key",
    );
    state.admin_token = adminCli.accessToken();
  });

  it("shows a tool following the change feed each change once, in order", async () => {
    const seen = await feedAfter(state.feed_start, (path) =>
      bearer(`${stack.url}${path}`, state.admin_token),
    );
    const ids = seen.map((each) => each.id);
    expect(ids, "event ids, each once and rising").toEqual(
      [...new Set(ids)].sort((a, b) => a - b),
    );
    let from = 0;
    for (const change of state.changes) {
      const at = seen.findIndex(
        (each, index) =>
          index >= from &&
          each.kind === change.kind &&
          each.element?.id === change.element_id,
      );
      if (at === -1)
        throw new Error(
          `The feed has no ${change.kind} for ${change.what} after the change before it; it holds ${seen.map((each) => each.kind).join(", ")}`,
        );
      from = at + 1;
    }
    // Each change is one event: as many events of a kind on an element as
    // changes of that kind were made to it.
    const tally = (list: { kind: string; element_id: string }[]) =>
      Object.fromEntries(
        Object.entries(
          Object.groupBy(list, (each) => `${each.kind} ${each.element_id}`),
        ).map(([at, group]) => [at, group?.length ?? 0]),
      );
    const made = tally(state.changes);
    const delivered = tally(
      seen.flatMap((each) =>
        each.element === null
          ? []
          : [{ kind: each.kind, element_id: each.element.id }],
      ),
    );
    for (const at of Object.keys(made))
      expect(delivered[at], `the events for ${at}`).toBe(made[at]);
  });

  it("publishes no port but the api's from compose.yml, and only the mock's beside it here", () => {
    // compose.yml alone, as a deployment is generated from it.
    type Config = {
      services: Record<
        string,
        { ports?: { host_ip?: string; published?: string }[] }
      >;
    };
    const fromComposeYml = {
      api: [`127.0.0.1:${String(stack.api_port)}`],
      worker: [],
      postgres: [],
      cerbos: [],
    };
    const base = JSON.parse(
      compose(stack, ["config", "--format", "json"], ["stack/compose.yml"]),
    ) as Config;
    expect(
      Object.fromEntries(
        Object.entries(base.services).map(([name, service]) => [
          name,
          (service.ports ?? []).map(
            (port) => `${port.host_ip ?? ""}:${port.published ?? ""}`,
          ),
        ]),
      ),
      "the ports compose.yml publishes",
    ).toEqual(fromComposeYml);

    // The running stack: compose.yml's ports and the overlay's one addition.
    type Listed = {
      Service: string;
      Publishers: { URL: string; PublishedPort: number }[] | null;
    };
    const services = compose(stack, ["ps", "--format", "json"])
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Listed);
    const published = Object.fromEntries(
      services.map((each) => [
        each.Service,
        (each.Publishers ?? [])
          .filter((port) => port.PublishedPort > 0)
          .map((port) => `${port.URL}:${String(port.PublishedPort)}`),
      ]),
    );
    const overlayAdds = {
      // The test opens the mock's sign-in page here, as a browser opens Microsoft's.
      "powerbi-mock": [`127.0.0.1:${String(stack.mock_port)}`],
    };
    expect(published, "the ports the running stack publishes").toEqual({
      ...fromComposeYml,
      ...overlayAdds,
    });
  });
});
