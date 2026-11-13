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
import { buildDeps } from "../../deps.js";
import { hasAdmin } from "../admin/people.js";
import { runJobs } from "../jobs/runner.js";
import { seedSample, setupLine } from "./seed.js";
import "../jobs/all.js";

const directory = await mkdtemp(join(tmpdir(), "sample-seed-"));

afterAll(async () => {
  await closeTestPools();
  await rm(directory, { recursive: true });
});

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

it("seeds an admin and sales on an empty database, then changes no category", async () => {
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
    expect(lines.at(-1)).toMatch(/steps pass\. Open: none$/);
    expect(
      (
        await testPool("migrator").query(
          `select 1 from session s join "user" u on u.id = s.user_id where u.email in ('viewer@sample.example', 'admin@sample.example')`,
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    stop.abort();
    await Promise.all(running);
    await Promise.all([api.close(), worker.close(), mock.close()]);
  }
}, 120_000);

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
