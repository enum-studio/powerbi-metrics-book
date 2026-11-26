import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sampleTenant,
  startMockPowerBi,
} from "@powerbi-metrics-book/powerbi-mock";
import { afterAll, expect, inject, it } from "vitest";
import {
  closeTestPools,
  testEnvironment,
  testPool,
} from "../../../test/deps.js";
import { loadConfig } from "../../config.js";
import type { AppDeps } from "../../context.js";
import { buildDeps } from "../../deps.js";
import { hasAdmin } from "../admin/people.js";
import { personPrincipal } from "../auth/principal.js";
import { docsChecks } from "../book/docs.js";
import { runJobs } from "../jobs/runner.js";
import { seedSample, setupLine } from "./seed.js";
import "../jobs/all.js";

const directory = await mkdtemp(join(tmpdir(), "sample-seed-"));

afterAll(async () => {
  await closeTestPools();
  await rm(directory, { recursive: true });
});

/** Each failing documentation check the sample admin sees, on every page of GET /api/v1/docs/checks. */
async function failingDocs(deps: AppDeps): Promise<string[]> {
  const { rows } = await testPool("migrator").query<{
    id: string;
    email: string;
  }>(`select id, email from "user" where email = 'admin@sample.example'`);
  const [admin] = rows;
  if (admin === undefined) throw new Error("The seed made no sample admin.");
  const principal = await personPrincipal(
    deps,
    { ...admin, email_verified: true },
    { via: "browser", client_id: null },
  );
  const failing: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await docsChecks(
      { ...deps, principal },
      { limit: 500, cursor },
    );
    for (const { dataset, table, name, results } of page.items)
      for (const { rule, passed } of results)
        if (!passed) failing.push(`${dataset} ${table ?? ""} ${name}: ${rule}`);
    cursor = page.next_cursor ?? undefined;
  } while (cursor !== undefined);
  return failing;
}

const UNDESCRIBED = ["dataset", "table", "column", "measure"]
  .map(
    (kind) =>
      `select '${kind}' as kind, name from powerbi_${kind} where removed_at is null and description is null`,
  )
  .join(" union all ");
const DOCS_CHANGES =
  "select count(*)::int as count from book_change where action = 'docs'";

async function withMock(
  run: (env: ReturnType<typeof testEnvironment>) => Promise<void>,
  extra: Record<string, string> = {},
) {
  const mock = await startMockPowerBi({
    tenant: sampleTenant({ public_base_url: "https://metrics.example.com" }),
    control: true,
  });
  try {
    await run(
      testEnvironment("api", {
        CERBOS_URL: inject("cerbos_url"),
        IDENTITY_DIR: directory,
        SEARCH_BASE_URL: `${mock.url}/openai`,
        POWERBI_AUTHORITY: mock.url,
        POWERBI_API_URL: `${mock.url}/powerbi`,
        POWERBI_GRAPH_URL: `${mock.url}/graph`,
        ...extra,
      }),
    );
  } finally {
    await mock.close();
  }
}

it("refuses in demo mode with usage capture on, before writing anything", async () => {
  await withMock(
    async (env) => {
      await expect(seedSample(env, () => undefined)).rejects.toThrow(
        /usage\.capture is on/,
      );
      const deps = await buildDeps(loadConfig(env, "api"), env);
      try {
        expect(await hasAdmin(deps.db)).toBe(false);
      } finally {
        await deps.close();
      }
    },
    { DEMO_MODE: "1", TRUSTED_PROXY: "10.0.0.1" },
  );
}, 60_000);

it("seeds an admin, sales and documentation on an empty database, then changes nothing", async () => {
  const mock = await startMockPowerBi({
    tenant: sampleTenant({ public_base_url: "https://metrics.example.com" }),
    control: true,
  });
  const env = testEnvironment("api", {
    CERBOS_URL: inject("cerbos_url"),
    IDENTITY_DIR: directory,
    SEARCH_BASE_URL: `${mock.url}/openai`,
    POWERBI_AUTHORITY: mock.url,
    POWERBI_API_URL: `${mock.url}/powerbi`,
    POWERBI_GRAPH_URL: `${mock.url}/graph`,
    DEMO_MODE: "1",
    TRUSTED_PROXY: "10.0.0.1",
    USAGE_CAPTURE: "false",
  });
  const api = await buildDeps(loadConfig(env, "api"), env);
  const workerEnv = testEnvironment("worker", {
    ...env,
    DATABASE_URL: testEnvironment("worker").DATABASE_URL ?? "",
  });
  const worker = await buildDeps(loadConfig(workerEnv, "worker"), workerEnv);
  const stop = new AbortController();
  const running = [api, worker].map((deps) =>
    runJobs(deps, { signal: stop.signal }),
  );
  const lines: string[] = [];
  try {
    await seedSample(env, (line) => lines.push(line));
    expect(await api.settings.get("access.default_role")).toBe("none");
    expect(await hasAdmin(api.db)).toBe(true);
    expect(await api.settings.get("search.provider")).toBe("openai");
    expect(
      (
        await testPool("migrator").query(
          "select d.name from powerbi_dataset d where d.name in ('Sales', 'Retail') and d.relationships_read_at is not null order by d.name",
        )
      ).rows,
    ).toEqual([{ name: "Retail" }, { name: "Sales" }]);
    expect(
      lines.some((line) => line.startsWith("Relationships read for ")),
    ).toBe(true);
    expect(await failingDocs(api)).toEqual([]);
    expect((await testPool("migrator").query(UNDESCRIBED)).rows).toEqual([]);
    const reading = await testPool("migrator").query(`
      select name from metric m where dismissed_at is null and (
        tier = '' or importance = '' or direction = '' or use_for = '' or dont_use_for = ''
        or decisions = '' or owner_team = '' or owner_person is null
        or (select count(*) from metric_link l where l.metric_id = m.id or l.other_metric_id = m.id) < 2
      )`);
    expect(reading.rows).toEqual([]);
    expect(
      (
        await testPool("migrator").query(
          "select count(*)::int as count from metric_edge",
        )
      ).rows,
    ).toEqual([{ count: 2 }]);
    const documented = await testPool("migrator").query(DOCS_CHANGES);
    const categories = () =>
      testPool("migrator").query("select * from category order by key");
    const first = (await categories()).rows;
    expect(first).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "sales" })]),
    );
    expect(
      (
        await testPool("migrator").query(
          "select email from \"user\" where email = 'viewer@sample.example'",
        )
      ).rowCount,
    ).toBe(1);
    await seedSample(env, (line) => lines.push(line));
    expect(
      (
        await testPool("migrator").query(
          "select role from role_assignment where subject_kind = 'person' and subject = 'viewer@sample.example'",
        )
      ).rows,
    ).toEqual([{ role: "viewer" }]);
    expect((await categories()).rows).toEqual(first);
    expect(lines).toContain("Sample book: already seeded, nothing changed.");
    expect(lines).toContain("Sample docs: already written, nothing changed.");
    expect(lines).toContain("Sample reading page: 0 changes.");
    expect((await testPool("migrator").query(DOCS_CHANGES)).rows).toEqual(
      documented.rows,
    );
    expect(lines.at(-1)).toMatch(/steps pass\. Open: none$/);
    expect(
      (
        await testPool("migrator").query(
          `select 1 from session s join "user" u on u.id = s.user_id where u.email in ('viewer@sample.example', 'admin@sample.example', 'analyst@sample.example', 'leader@sample.example')`,
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    stop.abort();
    await Promise.all(running);
    await Promise.all([api.close(), worker.close(), mock.close()]);
  }
  // Two seeds and some 300 documentation writes: past two minutes on a busy machine.
}, 240_000);

it("names each open step with its check's sentence and failing items", () => {
  const state = {
    steps: [
      { id: "address", passed: true, check: null },
      { id: "agents", passed: false, check: { message: "No agent yet." } },
    ],
  };
  const items = [
    { item: "claude", status: "failing", sentence: "Add the connector." },
    { item: "cursor", status: "passing", sentence: "Done." },
  ];
  expect(setupLine(state, new Map([["agents", items]]))).toBe(
    "Setup: 1 of 2 steps pass. Open: agents: No agent yet.; claude: Add the connector.",
  );
  expect(setupLine({ steps: state.steps.slice(0, 1) }, new Map())).toBe(
    "Setup: 1 of 1 steps pass. Open: none",
  );
});

it("signs the admin out when the seed fails after sign-in", async () => {
  await withMock(async (env) => {
    await expect(
      seedSample(env, (line) => {
        if (line.startsWith("Sample book")) throw new Error("stop here");
      }),
    ).rejects.toThrow("stop here");
    expect(
      (
        await testPool("migrator").query(
          `select 1 from session s join "user" u on u.id = s.user_id where u.email = 'admin@sample.example'`,
        )
      ).rowCount,
    ).toBe(0);
  });
}, 120_000);

it("leaves search.provider none outside demo mode", async () => {
  await testPool("migrator").query(
    "delete from setting where key = 'search.provider'",
  );
  await withMock(async (env) => {
    await expect(
      seedSample(env, (line) => {
        if (line.startsWith("Sample book")) throw new Error("stop here");
      }),
    ).rejects.toThrow("stop here");
    const deps = await buildDeps(loadConfig(env, "api"), env);
    try {
      expect(await deps.settings.get("search.provider")).toBe("none");
    } finally {
      await deps.close();
    }
  });
}, 120_000);
