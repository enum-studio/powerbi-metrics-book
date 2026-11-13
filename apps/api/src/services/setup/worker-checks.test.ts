import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { closeTestPools, principals, testPool } from "../../../test/deps.js";
import { type SetupFixture, startSetup } from "../../../test/setup-support.js";
import { settingCheck } from "../../db/schema/admin.js";
import { jobRequest } from "../../db/schema/jobs.js";
import { storeCheck } from "../admin/checks.js";
import { setSetting } from "../admin/settings.js";
import { setSecret } from "../admin/secrets.js";
import { handlerFor } from "../jobs/registry.js";
import { WorkspaceDetails } from "./checks.js";
import { modifiedWorkspaces } from "../../powerbi/scanner.js";
import {
  CREDENTIALS,
  queueCheckInWorker,
  workerCheckState,
} from "./worker-checks.js";

/*
 * The worker stamps its result and the api stamps the job, in different
 * containers. Whatever those containers' clocks say, a step's own result is
 * judged on the database's clock alone.
 */

const HOUR = 60 * 60 * 1000;
const skewed = (offset: number) => () => new Date(Date.now() + offset);

let setup: SetupFixture;
beforeAll(async () => {
  setup = await startSetup();
});
afterAll(async () => {
  await setup.close();
  await closeTestPools();
});
beforeEach(async () => {
  await testPool("migrator").query(
    "delete from job_request where job = 'check'",
  );
  await setup.api.db.delete(settingCheck);
});

const context = () => ({ ...setup.api, principal: principals.admin });

describe("a worker check's own result, with the containers' clocks apart", () => {
  it.each([
    ["an hour behind the api", -HOUR],
    ["an hour ahead of the api", HOUR],
  ])(
    "is the job's own when the worker's clock is %s",
    async (_label, offset) => {
      const { id } = await queueCheckInWorker(context(), "scanner");
      await setup.api.db
        .update(jobRequest)
        .set({ status: "succeeded" })
        .where(eq(jobRequest.id, id));
      const worker = { ...setup.worker, clock: skewed(offset) };
      await storeCheck(worker, "scanner", { status: "passing", message: null });
      expect(await workerCheckState(setup.api, "scanner")).toMatchObject({
        status: "passing",
        own: true,
      });
    },
  );

  it("keeps a queued job waiting when the api's clock is an hour ahead of the database", async () => {
    await queueCheckInWorker(context(), "scanner");
    const state = await workerCheckState(
      { ...setup.api, clock: skewed(HOUR) },
      "scanner",
    );
    expect(state).toMatchObject({ pending: true, own: false });
  });
});

describe("a check that waits for the worker", () => {
  const UNTAKEN =
    "The worker has not started this check after 90 seconds, and no job of its is running. Check that the worker container is running.";
  const SYNCING =
    "The worker is finishing a sync. This check starts right after it.";
  const BUSY =
    "The worker is finishing another job. This check starts right after it.";

  beforeEach(async () => {
    await testPool("migrator").query(
      "delete from job_request where status = 'running'",
    );
  });

  async function running(job: "sync" | "expire_results", runner = "worker") {
    await testPool("migrator").query(
      "insert into job_request (job, runner, args, trigger, status) values ($1, $2, '{}', 'schedule', 'running')",
      [job, runner],
    );
  }
  const waitedLong = (id: string) =>
    setup.api.db
      .update(jobRequest)
      .set({ requested_at: sql`now() - interval '4 minutes'` })
      .where(eq(jobRequest.id, id));

  it("is not a failure, and says it starts shortly, when nothing holds the worker up", async () => {
    await queueCheckInWorker(context(), "scanner");
    expect(await workerCheckState(setup.api, "scanner")).toMatchObject({
      status: "failing",
      pending: true,
      own: false,
      message: "The check is in the worker's queue and starts shortly.",
    });
  });

  it("says a sync holds it up, however long it has waited, and never blames the worker", async () => {
    await running("sync");
    const { id } = await queueCheckInWorker(context(), "scanner");
    expect(await workerCheckState(setup.api, "scanner")).toMatchObject({
      pending: true,
      message: SYNCING,
    });
    await waitedLong(id);
    expect(await workerCheckState(setup.api, "scanner")).toMatchObject({
      pending: true,
      own: false,
      message: SYNCING,
    });
  });

  it("names another job of the worker's the same way", async () => {
    await running("expire_results");
    await queueCheckInWorker(context(), "what_to_sync");
    expect(await workerCheckState(setup.api, "what_to_sync")).toMatchObject({
      pending: true,
      message: BUSY,
    });
  });

  it("suspects a stopped worker only after 90 seconds with no job of its running, and still waits", async () => {
    await running("sync", "api");
    const { id } = await queueCheckInWorker(context(), "scanner");
    await waitedLong(id);
    expect(await workerCheckState(setup.api, "scanner")).toMatchObject({
      status: "failing",
      pending: true,
      own: false,
      message: UNTAKEN,
    });
  });

  it("waits the same way on the scanner's credentials check", async () => {
    await running("sync");
    await queueCheckInWorker(context(), "scanner_credentials");
    expect(
      await workerCheckState(setup.api, "scanner_credentials"),
    ).toMatchObject({ pending: true, message: SYNCING });
  });

  it("says the check runs while the job is running, whatever else is", async () => {
    await running("sync");
    const { id } = await queueCheckInWorker(context(), "what_to_sync");
    await setup.api.db
      .update(jobRequest)
      .set({ status: "running" })
      .where(eq(jobRequest.id, id));
    expect(await workerCheckState(setup.api, "what_to_sync")).toMatchObject({
      pending: true,
      message: "The worker is asking Power BI for the workspace list.",
    });
  });
});

it("shows at most 300 characters of a refusal on a job's row, which no CHECK limits", async () => {
  const { id } = await queueCheckInWorker(context(), CREDENTIALS);
  await setup.api.db
    .update(jobRequest)
    .set({
      status: "failed",
      error: `scanner_credentials refused: ${"x".repeat(1000)}`,
    })
    .where(eq(jobRequest.id, id));
  const { message, status } = await workerCheckState(setup.api, CREDENTIALS);
  expect(status).toBe("failing");
  expect(message).toBe("x".repeat(300));
});

it.each([
  "Power BI refused admin APIs to this service principal: add it to the security group named in Admin API settings.",
  "Tables came back without columns and measures: turn on the tenant setting Enhance admin APIs responses with detailed metadata, for the scanner's security group.",
  "Measures came back without DAX: turn on the tenant setting Enhance admin APIs responses with DAX and mashup expressions, for the scanner's security group.",
])("marks a tenant settings refusal for the browser: %s", async (message) => {
  await storeCheck(setup.worker, "scanner", { status: "failing", message });
  expect(await workerCheckState(setup.api, "scanner")).toMatchObject({
    details: { reason: "tenant_settings" },
  });
  await queueCheckInWorker(context(), "scanner");
  const response = await setup.request("/api/setup", {
    headers: { cookie: await setup.openSession() },
  });
  expect(response.status).toBe(200);
  const state: unknown = await response.json();
  expect(state).toHaveProperty("steps.2.pending", true);
  expect(state).toHaveProperty(
    "steps.2.check.details.reason",
    "tenant_settings",
  );
});
it("does not wait on Microsoft for an invalid scanner credential", async () => {
  await storeCheck(setup.worker, "scanner", {
    status: "failing",
    message:
      "Microsoft refused the scanner registration's client id or secret.",
  });
  expect(
    (await workerCheckState(setup.api, "scanner")).details,
  ).toBeUndefined();
});

it.each([
  [1000, false, false],
  [1001, false, false],
  [1001, true, false],
  [1000, false, true],
  [1000, true, true],
  [1500, true, false],
  [1500, false, false],
  [1, true, false],
] as const)(
  "stores at most 1000 workspaces from %i with personal=%s and long names=%s without scanning",
  async (count, personal, longNames) => {
    const scanner = setup.tenant.service_principals.find(
      (app) => app.may_call_admin_apis,
    );
    if (scanner === undefined) throw new Error("No sample scanner");
    await setup.api.settings.set(
      "powerbi.scanner_client_id",
      scanner.app_id,
      principals.admin,
    );
    await setup.api.settings.set(
      "powerbi.tenant_id",
      setup.tenant.tenant_id,
      principals.admin,
    );
    await setSecret(
      context(),
      "powerbi_scanner_client_secret",
      scanner.secret,
      { expires_at: null },
    );
    const before = setup.tenant.workspaces;
    setup.tenant.workspaces = Array.from({ length: count }, (_, index) => ({
      id: count === 1 ? "11111111-1111-0111-0111-111111111111" : randomUUID(),
      name: longNames
        ? index % 2 === 0
          ? "\u0000\ud800" + "é".repeat(300) + "\udfff"
          : "x".repeat(255) + "😀"
        : `Workspace ${String(index)}`,
      type:
        index === 0 ||
        (index === count - 1 && count < 1500) ||
        (count === 1500 && index === 1498)
          ? "PersonalGroup"
          : index === 1
            ? "Personal"
            : index === 2
              ? "Unknown"
              : index === 3
                ? "Group"
                : "Workspace",
      state: "Active",
      users: [],
      dataset_ids: [],
      report_ids: [],
    }));
    await setup.api.settings.set(
      "powerbi.sync.workspaces.personal",
      personal,
      principals.admin,
    );
    await setup.api.settings.set(
      "powerbi.sync.workspaces.include",
      count === 1500 && !personal
        ? setup.tenant.workspaces.slice(-1).map(({ id }) => id)
        : "all",
      principals.admin,
    );
    const calls = vi.spyOn(setup.worker.fetcher, "fetchFixed");
    const listed = setup.tenant.workspaces
      .slice(0, 1001)
      .filter(
        (workspace) =>
          personal || ["Workspace", "Group"].includes(workspace.type),
      );
    setup.startWorker();
    try {
      await queueCheckInWorker(context(), "what_to_sync");
      await expect
        .poll(
          async () =>
            (await workerCheckState(setup.api, "what_to_sync")).pending,
          { timeout: 20_000 },
        )
        .toBeUndefined();
      const result = await workerCheckState(setup.api, "what_to_sync");
      expect(result.status).toBe("passing");
      expect(result.details).toHaveProperty(
        "personal_count",
        count > 1001 ? 3 : Math.min(count, 4),
      );
      expect(result.message).toBe(
        count === 1500 && !personal
          ? "The include list could not be checked against more than 1000 workspaces Power BI lists."
          : count > 1000
            ? "Power BI lists more than 1000 workspaces. The first sync uses your workspace selection."
            : `The first sync scans ${String(listed.length)} of the ${String(listed.length)} workspaces Power BI lists.`,
      );
      if (longNames) {
        const details = WorkspaceDetails.parse(result.details);
        expect(details.truncated).toBe(true);
        expect(
          details.workspaces.every(({ name }) =>
            ["é".repeat(256), "x".repeat(255)].includes(name),
          ),
        ).toBe(true);
        expect(
          details.workspaces.some(({ name }) => name === "x".repeat(255)),
        ).toBe(true);
        expect(details.workspaces.length).toBeGreaterThan(0);
        expect(details.workspaces.length).toBeLessThan(1000);
      } else
        expect(result.details).toEqual({
          personal_count: count > 1001 ? 3 : Math.min(count, 4),
          workspaces: listed.slice(0, 1000).map(({ id, name, type }) => ({
            id,
            name,
            personal: !["Workspace", "Group"].includes(type),
          })),
          truncated: count > 1000,
        });
      const [stored] = await setup.api.db
        .select()
        .from(settingCheck)
        .where(eq(settingCheck.key, "what_to_sync"));
      expect(stored?.details).toEqual(result.details);
      const state = await setup.request("/api/setup", {
        headers: { cookie: await setup.openSession() },
      });
      expect(state.status).toBe(200);
      const stateText = await state.text();
      if (!longNames)
        for (const text of [JSON.stringify(stored), stateText])
          for (const index of [0, 1, 2].slice(0, count))
            expect(
              text.includes(JSON.stringify(`Workspace ${String(index)}`)),
            ).toBe(personal);

      if (personal && !longNames) {
        await setSetting(context(), "powerbi.sync.workspaces.personal", false, {
          save_failing: false,
        });
        const hidden = await setup.request("/api/setup", {
          headers: { cookie: await setup.openSession() },
        });
        expect(hidden.status).toBe(200);
        expect(await hidden.text()).not.toContain("Workspace 0");
      }
      const adminCalls = calls.mock.calls
        .map(([url]) => new URL(url))
        .filter((url) => url.pathname.includes("/admin/"));
      expect(adminCalls).toHaveLength(1);
      expect(adminCalls[0]?.pathname).toBe("/powerbi/v1.0/myorg/admin/groups");
      expect(adminCalls[0]?.searchParams.get("$top")).toBe("1001");
    } finally {
      await setup.stopWorker();
      calls.mockRestore();
      setup.tenant.workspaces = before;
    }
  },
);

it.each(["[]", "true", "1", '"text"', "null"])(
  "refuses stored details that are not an object: %s",
  async (json) => {
    await expect(
      setup.api.db.insert(settingCheck).values({
        key: "what_to_sync",
        status: "passing",
        message: null,
        checked_at: new Date(),
        details: sql`${json}::jsonb`,
      }),
    ).rejects.toMatchObject({ cause: { constraint: "setting_check_details" } });
  },
);

it("bounds workspace identifiers and names", () => {
  for (const workspace of [
    { id: "x".repeat(37), name: "Sales", personal: false },
    { id: randomUUID(), name: "x".repeat(257), personal: false },
  ])
    expect(
      WorkspaceDetails.safeParse({
        workspaces: [workspace],
        truncated: false,
        personal_count: 0,
      }).success,
    ).toBe(false);
});

it("refuses stored details above 256 KiB in bytes", async () => {
  await expect(
    setup.api.db.insert(settingCheck).values({
      key: "what_to_sync",
      status: "passing",
      checked_at: new Date(),
      details: { text: "é".repeat(131072) },
    }),
  ).rejects.toMatchObject({ cause: { constraint: "setting_check_details" } });
});

it("omits invalid stored workspace details and logs only their setting key", async () => {
  await storeCheck(setup.worker, "what_to_sync", {
    status: "passing",
    message: null,
    details: { workspaces: "Private sample name" },
  });
  const warn = vi.spyOn(setup.api.logger, "warn");
  try {
    const response = await setup.request("/api/setup", {
      headers: { cookie: await setup.openSession() },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty("steps.3.check.details");
    expect(warn).toHaveBeenCalled();
    for (const [, fields] of warn.mock.calls)
      expect(fields).toEqual({ key: "what_to_sync" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(
      "Private sample name",
    );
  } finally {
    warn.mockRestore();
  }
});

describe("what the scanner check says when Power BI fails it", () => {
  const ADMIN = "/powerbi/v1.0/myorg/admin";
  const REFUSED = /^Power BI refused admin APIs to this service principal/;
  const NO_TOKEN = /^Microsoft gave the scanner registration no token/;
  // A token is kept until five minutes before it expires, so a check that must
  // ask Microsoft again runs at a moment later than any before it.
  let later = 0;

  async function configureScanner(): Promise<void> {
    const scanner = setup.tenant.service_principals.find(
      (app) => app.may_call_admin_apis,
    );
    if (scanner === undefined) throw new Error("No sample scanner");
    const admin = principals.admin;
    await setup.api.settings.set(
      "powerbi.scanner_client_id",
      scanner.app_id,
      admin,
    );
    await setup.api.settings.set(
      "powerbi.tenant_id",
      setup.tenant.tenant_id,
      admin,
    );
    await setSecret(
      context(),
      "powerbi_scanner_client_secret",
      scanner.secret,
      { expires_at: null },
    );
  }

  async function runCheck(
    step: "scanner" | "what_to_sync",
    options: { freshToken?: boolean } = {},
  ): Promise<string> {
    await configureScanner();
    if (options.freshToken) later += 2 * HOUR;
    const worker = { ...setup.worker, clock: skewed(later) };
    await handlerFor("check", "worker")?.handler(worker, { step }, "manual");
    const [stored] = await setup.api.db
      .select()
      .from(settingCheck)
      .where(eq(settingCheck.key, step));
    return stored?.message ?? "";
  }

  const tokenPath = () => `/${setup.tenant.tenant_id}/oauth2/v2.0/token`;

  /** Runs the full check and answers the workspaces it asked Power BI to scan, and what it stored. */
  async function scanned(): Promise<{ asked: string[]; message: string }> {
    const real = setup.worker.fetcher.fetchFixed.bind(setup.worker.fetcher);
    const asked: string[] = [];
    const fetch = vi
      .spyOn(setup.worker.fetcher, "fetchFixed")
      .mockImplementation((url, init) => {
        if (String(url).includes("/workspaces/getInfo"))
          asked.push(
            ...(JSON.parse(init?.body as string) as { workspaces: string[] })
              .workspaces,
          );
        return real(url, init);
      });
    try {
      return { message: await runCheck("scanner"), asked };
    } finally {
      fetch.mockRestore();
    }
  }

  describe("the workspaces it scans", () => {
    const admin = principals.admin;
    const listed = async () => {
      await configureScanner();
      return modifiedWorkspaces(setup.worker, { since: null });
    };
    afterEach(async () => {
      await setup.api.settings.set(
        "powerbi.sync.workspaces.exclude",
        [],
        admin,
      );
      await setup.api.settings.set(
        "powerbi.sync.workspaces.include",
        "all",
        admin,
      );
    });

    it("never scans an excluded workspace saved in another case", async () => {
      const all = await listed();
      await setup.api.settings.set(
        "powerbi.sync.workspaces.exclude",
        all.slice(0, 1).map((id) => id.toUpperCase()),
        admin,
      );
      const { asked } = await scanned();
      expect(asked).toEqual(all.slice(1, 11));
    });

    it("never scans an excluded workspace", async () => {
      const all = await listed();
      const excluded = all.slice(0, 1);
      expect(all.length).toBeGreaterThan(1);
      await setup.api.settings.set(
        "powerbi.sync.workspaces.exclude",
        excluded,
        admin,
      );
      const { asked, message } = await scanned();
      expect(asked).toEqual(all.slice(1, 11));
      expect(message).toBe(
        `The scanner read ${String(asked.length)} of the ${String(all.length)} workspaces Power BI lists.`,
      );
    });

    it("scans only the included workspaces", async () => {
      const all = await listed();
      const included = all.slice(-1);
      await setup.api.settings.set(
        "powerbi.sync.workspaces.include",
        included,
        admin,
      );
      expect((await scanned()).asked).toEqual(included);
    });

    it("scans nothing when the selection leaves nothing, and says so without failing the scanner", async () => {
      const all = await listed();
      await setup.api.settings.set(
        "powerbi.sync.workspaces.exclude",
        all,
        admin,
      );
      const { asked, message } = await scanned();
      expect(asked).toEqual([]);
      expect(message).toBe(
        "The tenant settings could not be proven, because your workspace selection leaves nothing to scan.",
      );
    });
  });

  describe("new credentials saved while it runs", () => {
    /** Runs the full check as a job, with change made during its first call to Power BI, and answers where the check then stands. */
    async function runThrough(change: () => Promise<unknown>) {
      await configureScanner();
      const { id } = await queueCheckInWorker(context(), "scanner");
      const real = setup.worker.fetcher.fetchFixed.bind(setup.worker.fetcher);
      const fetch = vi
        .spyOn(setup.worker.fetcher, "fetchFixed")
        .mockImplementation(async (url, init) => {
          if (String(url).includes("/workspaces/modified")) await change();
          return real(url, init);
        });
      try {
        await handlerFor("check", "worker")?.handler(
          setup.worker,
          { step: "scanner" },
          "manual",
        );
      } finally {
        fetch.mockRestore();
      }
      await setup.api.db
        .update(jobRequest)
        .set({ status: "succeeded" })
        .where(eq(jobRequest.id, id));
      return workerCheckState(setup.api, "scanner");
    }

    it("keeps no result when the secret changed", async () => {
      const state = await runThrough(() =>
        setSecret(
          context(),
          "powerbi_scanner_client_secret",
          "a-new-sample-secret-value",
          { expires_at: null },
        ),
      );
      expect(state).toMatchObject({
        status: "failing",
        message: "This check has not run yet. Run it on this step.",
        own: false,
      });
      expect(await setup.api.db.select().from(settingCheck)).toEqual([]);
    });

    it("keeps no result when the client id changed", async () => {
      const state = await runThrough(() =>
        setup.api.settings.set(
          "powerbi.scanner_client_id",
          randomUUID(),
          principals.admin,
        ),
      );
      expect(state).toMatchObject({ status: "failing", own: false });
      expect(await setup.api.db.select().from(settingCheck)).toEqual([]);
    });

    it("keeps the result when the same credentials were saved again", async () => {
      const scanner = setup.tenant.service_principals.find(
        (app) => app.may_call_admin_apis,
      );
      if (scanner === undefined) throw new Error("No sample scanner");
      const state = await runThrough(async () => {
        await setup.api.settings.set(
          "powerbi.scanner_client_id",
          scanner.app_id,
          principals.admin,
        );
        await setSecret(
          context(),
          "powerbi_scanner_client_secret",
          scanner.secret,
          { expires_at: null },
        );
      });
      expect(state).toMatchObject({ status: "passing", own: true });
    });
  });

  it.each([401, 400])(
    "gives the token sentence when Microsoft identity answers %i, not the admin API's",
    async (status) => {
      setup.mock.failNext(tokenPath(), status);
      const message = await runCheck("scanner", { freshToken: true });
      expect(message).toMatch(NO_TOKEN);
      expect(message).not.toMatch(REFUSED);
      expect(message).not.toContain("did not answer");
    },
  );

  // Microsoft's own words, none of which may reach the check or the log.
  const TENANT_TEXT = "Contoso finance workspace Q3-secret is unavailable";
  const TENANT_CODE = "WorkspaceGone";

  /** Answers the admin API calls whose address holds path with what answer gives, and any other as the mock does. */
  function answering(path: string, answer: () => Response) {
    const real = setup.worker.fetcher.fetchFixed.bind(setup.worker.fetcher);
    return vi
      .spyOn(setup.worker.fetcher, "fetchFixed")
      .mockImplementation((url, init) =>
        String(url).includes(path)
          ? Promise.resolve(answer())
          : real(url, init),
      );
  }

  it.each([
    ["scanner", "/workspaces/modified"],
    ["what_to_sync", "/groups"],
  ] as const)(
    "says only the status for a %s check's admin API 500, never Microsoft's sentence or code, in the result or the log",
    async (step, path) => {
      const fetch = answering(path, () =>
        Response.json(
          { error: { code: TENANT_CODE, message: TENANT_TEXT } },
          { status: 500 },
        ),
      );
      const warn = vi.spyOn(setup.worker.logger, "warn");
      try {
        const message = await runCheck(step);
        expect(message).toBe(
          "Power BI's admin API answered 500. Try the check again in a few minutes.",
        );
        for (const word of ["Contoso", "secret", "unavailable", TENANT_CODE])
          expect(message).not.toContain(word);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("scanner check failed"),
          { kind: "upstream", status: 500, code: TENANT_CODE },
        );
        const logged = JSON.stringify(warn.mock.calls);
        expect(logged).not.toContain("Contoso");
        expect(logged).not.toContain("unavailable");
      } finally {
        fetch.mockRestore();
        warn.mockRestore();
      }
    },
  );

  it("says the scan did not finish when Power BI fails it, without Microsoft's text", async () => {
    const fetch = answering("/workspaces/scanStatus/", () =>
      Response.json({
        id: "scan",
        status: "Failed",
        error: { code: TENANT_CODE, message: TENANT_TEXT },
      }),
    );
    const warn = vi.spyOn(setup.worker.logger, "warn");
    try {
      expect(await runCheck("scanner")).toBe(
        "Power BI's scan did not finish. Try the check again in a few minutes.",
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain("Contoso");
    } finally {
      fetch.mockRestore();
      warn.mockRestore();
    }
  });

  it("shows the limit and the wait when the admin API is limiting calls", async () => {
    for (let call = 0; call < 3; call += 1)
      setup.mock.failNext(`${ADMIN}/workspaces/modified`, 429, 1);
    expect(await runCheck("scanner")).toBe(
      "Power BI's admin API is limiting calls. Try again in 1 seconds.",
    );
  });

  it("keeps the tenant settings sentence for a 403 from the admin API", async () => {
    setup.mock.failNext(`${ADMIN}/workspaces/modified`, 403);
    expect(await runCheck("scanner")).toMatch(REFUSED);
  });

  it("shows the shape sentence, and logs where the answer differed, never its content", async () => {
    const real = setup.worker.fetcher.fetchFixed.bind(setup.worker.fetcher);
    const fetch = vi
      .spyOn(setup.worker.fetcher, "fetchFixed")
      .mockImplementation((url, init) =>
        String(url).includes("/workspaces/modified")
          ? Promise.resolve(
              Response.json([{ id: 7, other: "Private sample text" }]),
            )
          : real(url, init),
      );
    const warn = vi.spyOn(setup.worker.logger, "warn");
    try {
      expect(await runCheck("scanner")).toBe(
        "Power BI's admin API answered in a shape this version cannot read.",
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("scanner check failed"),
        { kind: "upstream", issues: '[[0,"id"]]' },
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain("Private sample");
    } finally {
      fetch.mockRestore();
      warn.mockRestore();
    }
  });

  it("logs a token failure, with no message", async () => {
    const warn = vi.spyOn(setup.worker.logger, "warn");
    try {
      setup.mock.failNext(tokenPath(), 400);
      await runCheck("scanner", { freshToken: true });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("scanner check failed"),
        expect.objectContaining({ kind: "upstream", status: 400 }),
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain("was set to fail");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the scanner's two checks", () => {
  const app = () => {
    const scanner = setup.tenant.service_principals.find(
      (each) => each.may_call_admin_apis,
    );
    if (scanner === undefined) throw new Error("No sample scanner");
    return scanner;
  };

  async function configure(value = app().secret): Promise<void> {
    await setup.api.settings.set(
      "powerbi.scanner_client_id",
      app().app_id,
      principals.admin,
    );
    await setup.api.settings.set(
      "powerbi.tenant_id",
      setup.tenant.tenant_id,
      principals.admin,
    );
    await setSecret(context(), "powerbi_scanner_client_secret", value, {
      expires_at: null,
    });
  }

  /** Queues the check for the real runner, and waits for where it ends. */
  async function ran(check: "scanner" | "scanner_credentials") {
    setup.startWorker();
    try {
      await queueCheckInWorker(context(), check);
      await expect
        .poll(async () => (await workerCheckState(setup.api, check)).pending, {
          timeout: 20_000,
        })
        .toBeUndefined();
      return await workerCheckState(setup.api, check);
    } finally {
      await setup.stopWorker();
    }
  }

  const empty = (index: number) => ({
    id: `e0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    name: `Empty ${String(index)}`,
    type: "Workspace",
    state: "Active",
    users: [],
    dataset_ids: [],
    report_ids: [],
  });

  /** The sample's first workspace with datasets, placed at `at` among empty workspaces. */
  function listed(count: number, at: number | null) {
    const full = setup.tenant.workspaces.find(
      (workspace) => workspace.dataset_ids.length > 0,
    );
    if (full === undefined) throw new Error("No sample workspace with data");
    return Array.from({ length: count }, (_, index) =>
      index === at ? full : empty(index),
    );
  }

  async function withWorkspaces<T>(
    workspaces: typeof setup.tenant.workspaces,
    work: () => Promise<T>,
  ): Promise<T> {
    const before = setup.tenant.workspaces;
    setup.tenant.workspaces = workspaces;
    try {
      return await work();
    } finally {
      setup.tenant.workspaces = before;
    }
  }

  const NO_TABLES =
    "The tenant settings could not be proven, because no scanned workspace has a table.";

  describe("Check the scanner app", () => {
    it("passes on a token, and calls nothing else of Power BI's", async () => {
      await configure();
      const calls = vi.spyOn(setup.worker.fetcher, "fetchFixed");
      try {
        expect(await ran("scanner_credentials")).toMatchObject({
          status: "passing",
          message: "The scanner registration gets a token from Microsoft.",
          own: false,
        });
        for (const [url] of calls.mock.calls)
          expect(new URL(url).pathname).toMatch(/\/oauth2\/v2\.0\/token$/);
      } finally {
        calls.mockRestore();
      }
    });

    it("passes though the admin APIs would refuse the scanner", async () => {
      await configure();
      setup.tenant.settings.service_principals_admin_apis = false;
      try {
        expect((await ran("scanner_credentials")).status).toBe("passing");
      } finally {
        setup.tenant.settings.service_principals_admin_apis = true;
      }
    });

    it("gives Microsoft's refusal as our sentence, stores no check row, and leaves the job failed", async () => {
      await configure("not-the-secret");
      expect(await ran("scanner_credentials")).toMatchObject({
        status: "failing",
        message:
          "Microsoft refused the scanner registration's client id or secret. Copy the secret's Value, not its Secret ID, from Certificates & secrets.",
        own: false,
      });
      expect(
        await setup.api.db.select({ key: settingCheck.key }).from(settingCheck),
      ).toEqual([]);
      const [job] = await setup.api.db
        .select({ status: jobRequest.status, args: jobRequest.args })
        .from(jobRequest)
        .where(eq(jobRequest.job, "check"));
      expect(job).toEqual({
        status: "failed",
        args: { step: "scanner_credentials" },
      });
    });

    it("says it has not run before any job", async () => {
      expect(
        await workerCheckState(setup.api, "scanner_credentials"),
      ).toMatchObject({
        status: "failing",
        message: "This check has not run yet. Run it on this step.",
      });
    });

    it("hides what a job that crashed left, showing only its own sentence", async () => {
      const { id } = await queueCheckInWorker(context(), "scanner_credentials");
      await setup.api.db
        .update(jobRequest)
        .set({
          status: "failed",
          error: "connect ECONNREFUSED at a private address",
        })
        .where(eq(jobRequest.id, id));
      expect(
        await workerCheckState(setup.api, "scanner_credentials"),
      ).toMatchObject({
        status: "failing",
        message:
          "The worker could not run this check. The worker's log says why.",
      });
    });

    it("runs apart from the full check, which a waiting one does not stand for", async () => {
      const full = await queueCheckInWorker(context(), "scanner");
      const token = await queueCheckInWorker(context(), "scanner_credentials");
      expect(token.queued).toBe(true);
      expect(token.id).not.toBe(full.id);
    });

    it("shows its result on the scanner's step in the state, beside the full check's", async () => {
      await configure();
      await ran("scanner_credentials");
      const response = await setup.request("/api/setup", {
        headers: { cookie: await setup.openSession() },
      });
      const state: unknown = await response.json();
      expect(state).toHaveProperty("steps.2.id", "scanner");
      expect(state).toHaveProperty("steps.2.check", null);
      expect(state).toHaveProperty("steps.2.credentials.pending", false);
      expect(state).toHaveProperty(
        "steps.2.credentials.check.status",
        "passing",
      );
      expect(state).toHaveProperty(
        "steps.2.credentials.check.message",
        "The scanner registration gets a token from Microsoft.",
      );
      expect(state).not.toHaveProperty("steps.1.credentials");
    });
  });

  describe("Check the scanner", () => {
    it("still reports the token, then the admin APIs", async () => {
      await configure("not-the-secret");
      expect((await ran("scanner")).message).toMatch(
        /^Microsoft refused the scanner registration's/,
      );
      await configure();
      setup.tenant.settings.service_principals_admin_apis = false;
      try {
        expect((await ran("scanner")).message).toMatch(
          /^Power BI refused admin APIs/,
        );
      } finally {
        setup.tenant.settings.service_principals_admin_apis = true;
      }
    });

    it("scans the first 10 listed workspaces in one call", async () => {
      await configure();
      const calls = vi.spyOn(setup.worker.fetcher, "fetchFixed");
      try {
        const result = await withWorkspaces(listed(12, null), () =>
          ran("scanner"),
        );
        expect(result.status).toBe("passing");
        const scans = calls.mock.calls.filter(([url]) =>
          new URL(url).pathname.endsWith("/workspaces/getInfo"),
        );
        expect(scans).toHaveLength(1);
        const body = JSON.parse(scans[0]?.[1]?.body as string) as {
          workspaces: string[];
        };
        expect(body.workspaces).toEqual(
          listed(10, null).map((workspace) => workspace.id),
        );
      } finally {
        calls.mockRestore();
      }
    });

    it("passes with its fixed sentence when no scanned workspace has a table", async () => {
      await configure();
      setup.tenant.settings.detailed_metadata = false;
      try {
        expect(
          await withWorkspaces(listed(3, null), () => ran("scanner")),
        ).toMatchObject({ status: "passing", message: NO_TABLES });
      } finally {
        setup.tenant.settings.detailed_metadata = true;
      }
    });

    it("judges the settings on tables found past an empty first workspace", async () => {
      await configure();
      setup.tenant.settings.detailed_metadata = false;
      try {
        expect(
          await withWorkspaces(listed(3, 2), () => ran("scanner")),
        ).toMatchObject({
          status: "failing",
          message: expect.stringMatching(
            /^Tables came back without columns/,
          ) as unknown,
        });
      } finally {
        setup.tenant.settings.detailed_metadata = true;
      }
    });

    it("does not reach a workspace past the first 10", async () => {
      await configure();
      setup.tenant.settings.detailed_metadata = false;
      try {
        expect(
          await withWorkspaces(listed(11, 10), () => ran("scanner")),
        ).toMatchObject({ status: "passing", message: NO_TABLES });
      } finally {
        setup.tenant.settings.detailed_metadata = true;
      }
    });

    it("says how many it read when tables came back", async () => {
      await configure();
      expect(
        await withWorkspaces(listed(12, 0), () => ran("scanner")),
      ).toMatchObject({
        status: "passing",
        message: "The scanner read 10 of the 12 workspaces Power BI lists.",
      });
    });
  });
});
