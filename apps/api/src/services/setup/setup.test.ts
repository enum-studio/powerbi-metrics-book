import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { closeTestPools, principals } from "../../../test/deps.js";
import type { Db } from "../../context.js";
import {
  joined,
  startSetup,
  type SetupFixture,
} from "../../../test/setup-support.js";
import { cookies, followConnect } from "../../../test/sign-in-support.js";
import { settingCheck } from "../../db/schema/admin.js";
import { auditEvent } from "../../db/schema/audit.js";
import { powerbiConnection } from "../../db/schema/connection.js";
import { jobRequest } from "../../db/schema/jobs.js";
import { secret as storedSecret } from "../../db/schema/secrets.js";
import { hasAdmin } from "../admin/people.js";
import { storedChecks } from "../admin/settings.js";
import { runSync } from "../sync/run.js";
import { appRegistration } from "./checks.js";

/*
 * The whole first run through the API, from an empty database against the
 * mock, step by step; then each check's failures through the mock's
 * switches.
 */

type Answer = {
  status: "passing" | "failing";
  message: string | null;
  action?: string;
  details?: Record<string, unknown>;
  confirm?: { email: string; name: string };
  pending?: true;
};

let setup: SetupFixture;
beforeAll(async () => {
  setup = await startSetup();
});
afterAll(async () => {
  await setup.close();
  await closeTestPools();
});

async function step(
  name: string,
  cookie: string,
  body: object = {},
  headers: Record<string, string> = {},
) {
  const answer = await setup.post(
    `/api/setup/steps/${name}`,
    cookie,
    body,
    headers,
  );
  expect(answer.status, await answer.clone().text()).toBe(200);
  return { answer, result: (await answer.json()) as Answer };
}

/** A step whose check the worker runs: the POST that queues it, then empty POSTs, as the screen polls, until it stops pending. */
async function settled(
  name: string,
  cookie: string,
  body: object,
  poll: object = {},
) {
  let { result } = await step(name, cookie, body);
  const deadline = Date.now() + 60_000;
  while (result.pending === true) {
    if (Date.now() > deadline)
      throw new Error(
        `the ${name} check still pends: ${String(result.message)}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
    ({ result } = await step(name, cookie, poll));
  }
  return result;
}

const checkJobs = (db: Db) =>
  db
    .select({ id: jobRequest.id })
    .from(jobRequest)
    .where(and(eq(jobRequest.job, "check"), eq(jobRequest.runner, "worker")));

const secret = (value: string) => ({
  value,
  expires_at: "2027-10-01T00:00:00Z",
});
const SCANNER_WRONG =
  "Microsoft refused the scanner registration's client id or secret. Copy the secret's Value, not its Secret ID, from Certificates & secrets.";

it("refuses a stored action outside sign_in and connect", async () => {
  await expect(
    setup.api.db.execute(sql`
    insert into setting_check (key, status, action, checked_at)
    values ('invalid_action', 'failing', 'other', now())
  `),
  ).rejects.toMatchObject({ cause: { constraint: "setting_check_action" } });
});

describe("the first run", () => {
  let link = "";
  let session = "";

  it("opens a setup session on an empty database", async () => {
    expect(await hasAdmin(setup.api.db)).toBe(false);
    link = await setup.openSession();
    const state = await setup.request("/api/setup", {
      headers: { cookie: link },
    });
    const { steps } = (await state.json()) as {
      steps: { id: string; passed: boolean }[];
    };
    expect(steps.map((s) => s.id)).toEqual([
      "address",
      "app_registration",
      "scanner",
      "what_to_sync",
      "first_sync",
    ]);
    expect(steps.some((s) => s.passed)).toBe(false);
  });

  it("checks the address the page came in at", async () => {
    const elsewhere = await step(
      "address",
      link,
      {},
      { host: "elsewhere.example.com" },
    );
    expect(elsewhere.result.message).toBe(
      "This page came in at another address than PUBLIC_BASE_URL, https://metrics.example.com. Open the setup at that address, or set PUBLIC_BASE_URL to the one people use.",
    );
    expect(
      (await step("address", link, {}, { host: "metrics.example.com" })).result
        .status,
    ).toBe("passing");
    const state: unknown = await (
      await setup.request("/api/setup", { headers: { cookie: link } })
    ).json();
    expect(state).toHaveProperty(
      "steps.0.check.details.public_base_url",
      "https://metrics.example.com",
    );
  });

  it("refuses the app registration's wrong secret, then asks the right one's holder to sign in", async () => {
    await setup.api.settings.set(
      "access.default_role",
      "none",
      principals.admin,
    );
    const registration = setup.tenant.apps_registrations[0];
    const settings = {
      "powerbi.tenant_id": setup.tenant.tenant_id,
      "powerbi.app_client_id": registration?.client_id,
    };
    const wrong = await step("app_registration", link, {
      settings,
      secrets: { powerbi_app_client_secret: secret("not-the-secret") },
    });
    expect(wrong.result.message).toBe(
      "Microsoft refused the app registration's client id or secret. Copy the secret's Value, not its Secret ID, from Certificates & secrets.",
    );
    const right = await step("app_registration", link, {
      secrets: {
        powerbi_app_client_secret: secret(registration?.secret ?? ""),
      },
    });
    expect(right.result.action).toBe("sign_in");
    link = joined(link, cookies(right.answer));
    const state = await setup.request("/api/setup", {
      headers: { cookie: link },
    });
    expect(await state.json()).toHaveProperty(
      "steps.1",
      expect.objectContaining({
        id: "app_registration",
        pending: false,
        action: "sign_in",
      }),
    );
  });

  it("makes the person the setup's sign-in admitted the first admin, and ends the setup session", async () => {
    const signedIn = await setup.signIn(setup.person("admin"), link);
    expect(signedIn.callback.headers.get("location")).toBe("/setup");
    session = cookies(signedIn.callback);
    const asked = await step("app_registration", signedIn.cookie);
    expect(asked.result.confirm).toEqual({
      email: "admin@sample.example",
      name: "Admin",
    });
    const { answer, result } = await step("app_registration", signedIn.cookie, {
      confirm_email: "admin@sample.example",
    });
    expect(await hasAdmin(setup.api.db)).toBe(true);
    expect(answer.headers.get("set-cookie")).toContain("__Secure-pbmb_setup=;");
    expect(result.action).toBe("connect");
    expect(
      (await setup.request("/api/setup", { headers: { cookie: link } })).status,
    ).toBe(404);
  });

  it("passes the app registration once the admin's Power BI is connected", async () => {
    const connected = await followConnect(
      setup.app,
      session,
      "/api/v1/powerbi/connect?next=/setup",
    );
    expect(connected.answer.headers.get("location")).toBe("/setup");
    expect((await step("app_registration", session)).result.status).toBe(
      "passing",
    );
    const state = await setup.request("/api/setup", {
      headers: { cookie: session },
    });
    expect(((await state.json()) as { holder: string }).holder).toBe("admin");
  });

  it.each(["stored", "given"])(
    "refuses the %s app client id as the scanner before saving anything",
    async (source) => {
      const appId =
        source === "given"
          ? crypto.randomUUID()
          : await setup.api.settings.get("powerbi.app_client_id");
      if (appId === null) throw new Error("The app client id is not set.");
      const answer = await setup.post("/api/setup/steps/scanner", session, {
        settings: {
          "powerbi.scanner_client_id": appId.toUpperCase(),
          ...(source === "given" ? { "powerbi.app_client_id": appId } : {}),
        },
        secrets: { powerbi_scanner_client_secret: secret("unused") },
      });
      expect(answer.status).toBe(400);
      expect(await answer.json()).toMatchObject({
        error: "invalid",
        message:
          "These are the same app. The scanner needs its own registration.",
      });
      expect(
        await setup.api.settings.get("powerbi.scanner_client_id"),
      ).toBeNull();
      expect(
        await setup.api.db
          .select({ name: storedSecret.name })
          .from(storedSecret)
          .where(eq(storedSecret.name, "powerbi_scanner_client_secret")),
      ).toEqual([]);
    },
  );

  it("runs the scanner's check in the worker, which alone reads its secret", async () => {
    setup.startWorker();
    const scanner = setup.tenant.service_principals.find(
      (sp) => sp.may_call_admin_apis,
    );
    const settings = { "powerbi.scanner_client_id": scanner?.app_id };
    const wrong = await settled("scanner", session, {
      settings,
      secrets: { powerbi_scanner_client_secret: secret("not-it") },
    });
    expect(wrong.message).toBe(SCANNER_WRONG);
    const right = await settled("scanner", session, {
      secrets: { powerbi_scanner_client_secret: secret(scanner?.secret ?? "") },
    });
    expect(right).toMatchObject({
      status: "passing",
      message: "The scanner read 3 of the 3 workspaces Power BI lists.",
    });
  });

  it("answers the scanner's state at once, queuing a check only on a save or start_check", async () => {
    await setup.stopWorker();
    const before = (await checkJobs(setup.api.db)).length;
    const read = await step("scanner", session);
    expect(read.result).toMatchObject({ status: "passing" });
    expect(read.result.pending).toBeUndefined();
    expect(await checkJobs(setup.api.db)).toHaveLength(before);

    const started = await step("scanner", session, { start_check: true });
    expect(started.result).toMatchObject({
      status: "failing",
      pending: true,
      message: "The check is in the worker's queue and starts shortly.",
    });
    const state = await setup.request("/api/setup", {
      headers: { cookie: session },
    });
    expect(await state.json()).toHaveProperty(
      "steps.2",
      expect.objectContaining({ id: "scanner", pending: true, action: null }),
    );
    // Asking again, or starting again while it waits, queues no other.
    await step("scanner", session);
    await step("scanner", session, { start_check: true });
    expect(await checkJobs(setup.api.db)).toHaveLength(before + 1);
    // A pending check leaves the step as it stood.
    expect(await setup.api.settings.get("setup.completed_steps")).toContain(
      "scanner",
    );

    setup.startWorker();
    expect(await settled("scanner", session, {})).toMatchObject({
      status: "passing",
    });
  });

  it("queues one scan for requests that start the check at once, with who asked, and audits each start", async () => {
    await setup.stopWorker();
    const before = (await checkJobs(setup.api.db)).length;
    const audits = () =>
      setup.api.db
        .select({ id: auditEvent.id })
        .from(auditEvent)
        .where(
          and(
            eq(auditEvent.action, "admin.check.run"),
            eq(auditEvent.resource_id, "scanner"),
          ),
        );
    const audited = (await audits()).length;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        step("scanner", session, { start_check: true }),
      ),
    );
    const jobs = await setup.api.db
      .select({ requested_by: jobRequest.requested_by })
      .from(jobRequest)
      .where(
        and(
          eq(jobRequest.job, "check"),
          eq(jobRequest.status, "queued"),
          sql`${jobRequest.args}->>'step' = 'scanner'`,
        ),
      );
    expect(jobs).toHaveLength(1);
    expect(await checkJobs(setup.api.db)).toHaveLength(before + 1);
    expect(jobs[0]?.requested_by).toEqual(expect.any(String));
    expect(await audits()).toHaveLength(audited + 6);
  });

  it("keeps pending when no worker took the check in 90 seconds, saying so, and leaves the step as it stood", async () => {
    const completed = await setup.api.settings.get("setup.completed_steps");
    await setup.api.db
      .update(jobRequest)
      .set({
        requested_at: sql`${jobRequest.requested_at} - interval '1 hour'`,
      })
      .where(
        and(
          eq(jobRequest.job, "check"),
          sql`${jobRequest.args}->>'step' = 'scanner'`,
        ),
      );
    const { result } = await step("scanner", session);
    expect(result).toMatchObject({
      status: "failing",
      pending: true,
      message:
        "The worker has not started this check after 90 seconds, and no job of its is running. Check that the worker container is running.",
    });
    expect(await setup.api.settings.get("setup.completed_steps")).toEqual(
      completed,
    );
    setup.startWorker();
    expect(await settled("scanner", session, {})).toMatchObject({
      status: "passing",
    });
  });

  it("does not mark the step from a stored result older than its latest job", async () => {
    const completed = await setup.api.settings.get("setup.completed_steps");
    await setup.api.settings.set(
      "setup.completed_steps",
      completed.filter((id) => id !== "scanner"),
      principals.admin,
    );
    await setup.api.db
      .update(settingCheck)
      .set({ checked_at: sql`now() - interval '1 day'` })
      .where(eq(settingCheck.key, "scanner"));
    const { result } = await step("scanner", session);
    expect(result.status).toBe("passing");
    expect(await setup.api.settings.get("setup.completed_steps")).not.toContain(
      "scanner",
    );
    // A check of its own marks it again.
    await settled("scanner", session, { start_check: true });
    expect(await setup.api.settings.get("setup.completed_steps")).toContain(
      "scanner",
    );
  });

  it("queues a fresh check behind a running one on a save, which may have read the value it replaces", async () => {
    await setup.stopWorker();
    const scannerJobs = () =>
      setup.api.db
        .select({ id: jobRequest.id, status: jobRequest.status })
        .from(jobRequest)
        .where(
          and(
            eq(jobRequest.job, "check"),
            sql`${jobRequest.args}->>'step' = 'scanner'`,
            sql`${jobRequest.status} in ('queued', 'running')`,
          ),
        );
    await step("scanner", session, { start_check: true });
    const [started] = await scannerJobs();
    await setup.api.db
      .update(jobRequest)
      .set({ status: "running", taken_at: new Date() })
      .where(eq(jobRequest.id, started?.id ?? ""));
    const scanner = setup.tenant.service_principals.find(
      (sp) => sp.may_call_admin_apis,
    );
    await step("scanner", session, {
      secrets: { powerbi_scanner_client_secret: secret(scanner?.secret ?? "") },
    });
    // The button, unlike a save, waits on the check that runs.
    await step("scanner", session, { start_check: true });
    expect((await scannerJobs()).map((job) => job.status).sort()).toEqual([
      "queued",
      "running",
    ]);

    await setup.api.db
      .update(jobRequest)
      .set({ status: "failed", finished_at: new Date(), error: "test" })
      .where(eq(jobRequest.id, started?.id ?? ""));
    setup.startWorker();
    expect(await settled("scanner", session, {})).toMatchObject({
      status: "passing",
    });
  });

  it("takes start_check on the worker's steps only", async () => {
    const answer = await setup.post("/api/setup/steps/search", session, {
      start_check: true,
    });
    expect(answer.status).toBe(400);
  });

  describe("Check the scanner app, on the scanner's own route", () => {
    const credentials = { credentials_only: true } as const;
    const scannerId = () => setup.api.settings.get("powerbi.scanner_client_id");

    it("takes credentials_only on the scanner step only", async () => {
      const answer = await setup.post("/api/setup/steps/search", session, {
        credentials_only: true,
      });
      expect(answer.status).toBe(400);
    });

    it("queues its own check on start_check, audits it, polling starts nothing, and it never marks the step", async () => {
      await setup.stopWorker();
      const completed = await setup.api.settings.get("setup.completed_steps");
      const jobs = () =>
        setup.api.db
          .select({ id: jobRequest.id })
          .from(jobRequest)
          .where(
            and(
              eq(jobRequest.job, "check"),
              sql`${jobRequest.args}->>'step' = 'scanner_credentials'`,
            ),
          );
      const before = (await jobs()).length;
      const started = await step("scanner", session, {
        ...credentials,
        start_check: true,
      });
      expect(started.result).toMatchObject({
        pending: true,
        status: "failing",
      });
      await step("scanner", session, credentials);
      expect(await jobs()).toHaveLength(before + 1);
      expect(
        await setup.api.db
          .select({ id: auditEvent.id })
          .from(auditEvent)
          .where(
            and(
              eq(auditEvent.action, "admin.check.run"),
              eq(auditEvent.resource_id, "scanner_credentials"),
            ),
          ),
      ).toHaveLength(1);
      setup.startWorker();
      const result = await settled(
        "scanner",
        session,
        credentials,
        credentials,
      );
      expect(result).toMatchObject({
        status: "passing",
        message: "The scanner registration gets a token from Microsoft.",
      });
      expect(await setup.api.settings.get("setup.completed_steps")).toEqual(
        completed,
      );
    });

    it("keeps the full check when the same values are sent again", async () => {
      expect((await step("scanner", session)).result.status).toBe("passing");
      await settled(
        "scanner",
        session,
        {
          ...credentials,
          settings: { "powerbi.scanner_client_id": await scannerId() },
        },
        credentials,
      );
      expect((await step("scanner", session)).result.status).toBe("passing");
      expect(await setup.api.settings.get("setup.completed_steps")).toContain(
        "scanner",
      );
    });

    it("ends the full check when a new secret is saved, and a wrong one does not pass on an old token", async () => {
      const result = await settled(
        "scanner",
        session,
        {
          ...credentials,
          secrets: { powerbi_scanner_client_secret: secret("not-it") },
        },
        credentials,
      );
      expect(result.message).toBe(SCANNER_WRONG);
      expect((await step("scanner", session)).result).toMatchObject({
        status: "failing",
        message: "This check has not run yet. Run it on this step.",
      });
      expect(
        await setup.api.settings.get("setup.completed_steps"),
      ).not.toContain("scanner");
      const state: unknown = await (
        await setup.request("/api/setup", { headers: { cookie: session } })
      ).json();
      expect(state).toHaveProperty("steps.2.check", null);
      expect(state).toHaveProperty(
        "steps.2.credentials.check.status",
        "failing",
      );
      const scanner = setup.tenant.service_principals.find(
        (sp) => sp.may_call_admin_apis,
      );
      expect(
        await settled("scanner", session, {
          secrets: {
            powerbi_scanner_client_secret: secret(scanner?.secret ?? ""),
          },
        }),
      ).toMatchObject({ status: "passing" });
      expect(await setup.api.settings.get("setup.completed_steps")).toContain(
        "scanner",
      );
    });

    it("saves a date alone: the value and the check stay, and the state shows the date", async () => {
      const read = () =>
        setup.api.db
          .select()
          .from(storedSecret)
          .where(eq(storedSecret.name, "powerbi_scanner_client_secret"));
      const stored = () => storedChecks(setup.api.db);
      expect(
        (await settled("scanner", session, { start_check: true })).status,
      ).toBe("passing");
      const [before] = await read();
      const checkBefore = (await stored()).get("scanner");
      await settled(
        "scanner",
        session,
        {
          ...credentials,
          secrets: {
            powerbi_scanner_client_secret: {
              expires_at: "2027-06-30T00:00:00.000Z",
            },
          },
        },
        credentials,
      );
      const [after] = await read();
      expect(after).toEqual({
        ...before,
        expires_at: new Date("2027-06-30T00:00:00.000Z"),
      });
      expect((await stored()).get("scanner")).toEqual(checkBefore);
      const state = (await (
        await setup.request("/api/setup", { headers: { cookie: session } })
      ).json()) as { steps: { fields: { name?: string }[] }[] };
      expect(
        state.steps
          .flatMap((each) => each.fields)
          .find((field) => field.name === "powerbi_scanner_client_secret"),
      ).toMatchObject({ set: true, expires_at: "2027-06-30T00:00:00.000Z" });
    });
  });

  it("says how many workspaces the first sync scans", async () => {
    const result = await settled("what_to_sync", session, {
      settings: { "powerbi.sync.workspaces.exclude": [] },
    });
    expect(result.message).toBe(
      "The first sync scans 3 of the 3 workspaces Power BI lists.",
    );
    const details = {
      personal_count: 1,
      workspaces: setup.tenant.workspaces
        .filter(({ type }) => type !== "PersonalGroup")
        .map(({ id, name, type }) => ({
          id,
          name,
          personal: type === "PersonalGroup",
        })),
      truncated: false,
    };
    expect(result.details).toEqual(details);
    const state: unknown = await (
      await setup.request("/api/setup", { headers: { cookie: session } })
    ).json();
    expect(state).toHaveProperty("steps.3.check.details", details);
  });

  it("starts the first sync only when asked, and reports what it found once it has run", async () => {
    await setup.stopWorker();
    expect((await step("first_sync", session)).result.message).toBe(
      "No sync has run yet. Start the first sync on this step.",
    );
    const firstSyncState = async (): Promise<unknown> => {
      const state = await setup.request("/api/setup", {
        headers: { cookie: session },
      });
      const body = (await state.json()) as { steps: unknown[] };
      return body.steps[4];
    };
    // That failure is now stored, as the daily job stores it, and no sync has started.
    expect(await firstSyncState()).toEqual(
      expect.objectContaining({
        id: "first_sync",
        pending: false,
        check: null,
      }),
    );
    const waiting = await step("first_sync", session, { start_sync: true });
    expect(waiting.result.message).toBe(
      "The first sync waits for the worker to start it. Check that the worker container is running.",
    );
    expect(await firstSyncState()).toEqual(
      expect.objectContaining({
        id: "first_sync",
        pending: true,
        action: null,
      }),
    );
    // The worker has taken the job and not yet recorded its run, which is no failure.
    const syncsIn = (status: "queued" | "running") =>
      and(eq(jobRequest.job, "sync"), eq(jobRequest.status, status));
    await setup.worker.db
      .update(jobRequest)
      .set({ status: "running" })
      .where(syncsIn("queued"));
    expect((await step("first_sync", session)).result.pending).toBe(true);
    await setup.worker.db
      .update(jobRequest)
      .set({ status: "queued" })
      .where(syncsIn("running"));
    // As the worker runs the job, polling the mock's scans without the wait.
    await runSync(setup.worker, {
      kind: "full",
      trigger: "manual",
      poll_ms: 5,
    });
    // Nobody watched it end, and the state says so without anyone asking first.
    expect(await firstSyncState()).toEqual(
      expect.objectContaining({
        pending: false,
        passed: false,
        check: expect.objectContaining({ status: "passing" }) as unknown,
      }),
    );
    const { result } = await step("first_sync", session);
    expect(result.status).toBe("passing");
    expect(result.message).toMatch(
      /^\d+ measures in 5 datasets, \d+ drafts ready for your agent\.$/,
    );

    // The request start_sync queued is the run above; checking again starts no other.
    const queuedSyncs = and(
      eq(jobRequest.job, "sync"),
      eq(jobRequest.status, "queued"),
    );
    await setup.worker.db
      .update(jobRequest)
      .set({ status: "succeeded", finished_at: new Date() })
      .where(queuedSyncs);
    expect((await step("first_sync", session)).result.status).toBe("passing");
    expect(
      await setup.worker.db.select().from(jobRequest).where(queuedSyncs),
    ).toEqual([]);
  });

  it("completes setup after the five first run steps, before any other check runs", async () => {
    expect(await setup.api.settings.get("setup.completed_steps")).toEqual([
      "address",
      "app_registration",
      "scanner",
      "what_to_sync",
      "first_sync",
    ]);
    const checks = await setup.api.db
      .select({ key: settingCheck.key })
      .from(settingCheck);
    for (const id of ["search", "sign_in", "who_gets_in", "agents", "security"])
      expect(checks.map((check) => check.key)).not.toContain(id);
    expect(await setup.api.settings.get("setup.completed_at")).toEqual(
      expect.any(String),
    );
  });

  it("checks sign-in, who gets in, search and agents", async () => {
    expect((await step("sign_in", session)).result.status).toBe("passing");
    const group = setup.tenant.groups[0]?.object_id ?? "";
    const assignments = [
      {
        role: "curator",
        subject_kind: "group",
        provider: "microsoft",
        subject: group,
      },
    ];
    const who = await step("who_gets_in", session, { assignments });
    expect(who.result.details?.assignments).toHaveLength(2);
    expect((await step("search", session)).result.details).toEqual({
      provider: "none",
    });
    const agents = await step("agents", session);
    expect(agents.result.status).toBe("failing");
    expect(agents.result.details?.mcp_url).toBe(
      "https://metrics.example.com/api/mcp",
    );
    // The CLI takes the address as --url (`pbmb login --help`), not as an argument.
    expect(agents.result.details?.cli_login).toBe(
      "pbmb login --url https://metrics.example.com",
    );
  });

  it("takes start_sync on the first sync step only", async () => {
    const answer = await setup.post("/api/setup/steps/search", session, {
      start_sync: true,
    });
    expect(answer.status).toBe(400);
  });

  it("passes the security checklist's live items, and keeps which steps passed", async () => {
    const { result } = await step("security", session);
    expect(result.status, JSON.stringify(result.details)).toBe("passing");
    const completed = await setup.api.settings.get("setup.completed_steps");
    expect([...completed].sort()).toEqual([
      "address",
      "app_registration",
      "first_sync",
      "scanner",
      "search",
      "security",
      "sign_in",
      "what_to_sync",
      "who_gets_in",
    ]);
    expect(await setup.api.settings.get("setup.completed_at")).toEqual(
      expect.any(String),
    );
  });

  describe("each check's failures, through the mock's switches", () => {
    beforeAll(() => {
      setup.startWorker();
    });
    const settings = () => setup.tenant.settings;

    it.each([
      [
        "service_principals_admin_apis",
        "Power BI refused admin APIs to this service principal: add it to the security group named in Admin API settings.",
      ],
      [
        "detailed_metadata",
        "Tables came back without columns and measures: turn on the tenant setting Enhance admin APIs responses with detailed metadata, for the scanner's security group.",
      ],
      [
        "dax_expressions",
        "Measures came back without DAX: turn on the tenant setting Enhance admin APIs responses with DAX and mashup expressions, for the scanner's security group.",
      ],
    ] as const)("names %s turned off", async (name, sentence) => {
      settings()[name] = false;
      const result = await settled("scanner", session, { start_check: true });
      settings()[name] = true;
      expect(result).toMatchObject({ status: "failing", message: sentence });
    });

    describe("what the app registration holds beyond the minimum", () => {
      const POWER_BI = "https://analysis.windows.net/powerbi/api";
      const WRITES =
        "Not needed by this app, which never uses it: Dataset.ReadWrite.All (can write). The app can still do what it allows.";
      let scopes: string[] = [];
      const holding = async (next: string[]) => {
        await setup.api.db.update(powerbiConnection).set({ scopes: next });
      };
      const appStep = async () => {
        const state = await setup.request("/api/setup", {
          headers: { cookie: session },
        });
        const { steps } = (await state.json()) as {
          steps: {
            id: string;
            passed: boolean;
            action: string | null;
            check: { status: string; message: string | null } | null;
          }[];
        };
        return steps.find((each) => each.id === "app_registration");
      };
      beforeAll(async () => {
        const [row] = await setup.api.db.select().from(powerbiConnection);
        scopes = row?.scopes ?? [];
      });
      afterEach(async () => {
        await holding(scopes);
      });

      it("passes a token that holds Dataset.ReadWrite.All, and keeps a note saying what it can do", async () => {
        await holding([...scopes, `${POWER_BI}/Dataset.ReadWrite.All`]);
        const { result } = await step("app_registration", session);
        expect(result).toMatchObject({ status: "passing", message: WRITES });
        expect(await appStep()).toMatchObject({
          passed: true,
          action: null,
          check: { status: "passing", message: WRITES },
        });
      });

      it("says on the security checklist that the app holds more, rather than that nothing writes", async () => {
        await holding([...scopes, `${POWER_BI}/Dataset.ReadWrite.All`]);
        await step("app_registration", session);
        const { result } = await step("security", session);
        expect(result.status).toBe("passing");
        const items = result.details?.items as {
          item: string;
          status: string;
          sentence: string;
        }[];
        const item = items.find(
          (each) => each.item === "app_registration_read_only",
        );
        expect(item?.status).toBe("explained");
        expect(item?.sentence).not.toContain("no permission that writes");
      });

      it("says on the security checklist only what it read, when the check names nothing", async () => {
        await step("app_registration", session);
        const { result } = await step("security", session);
        const items = result.details?.items as {
          item: string;
          status: string;
          sentence: string;
        }[];
        expect(
          items.find((each) => each.item === "app_registration_read_only"),
        ).toMatchObject({
          status: "passing",
          sentence:
            "The app registration holds nothing extra for Power BI. This check reads no other resource, such as Microsoft Graph.",
        });
      });

      it("says the app sends the token on service-account queries once they are on", async () => {
        const payload = Buffer.from(
          JSON.stringify({ roles: ["Tenant.Read.All"] }),
        ).toString("base64url");
        const real = setup.api.fetcher.fetchFixed.bind(setup.api.fetcher);
        // Tokens are kept per client id: this one stays out of the later checks.
        const clientId = await setup.api.settings.get("powerbi.app_client_id");
        await setup.api.settings.set(
          "powerbi.app_client_id",
          randomUUID(),
          principals.admin,
        );
        const fetch = vi
          .spyOn(setup.api.fetcher, "fetchFixed")
          .mockImplementation((url, init) =>
            String(url).includes("/oauth2/v2.0/token")
              ? Promise.resolve(
                  Response.json({
                    access_token: `e30.${payload}.signature`,
                    token_type: "Bearer",
                    expires_in: 3600,
                  }),
                )
              : real(url, init),
          );
        const check = (on: boolean) =>
          setup.api.settings
            .set("powerbi.service_account_queries", on, principals.admin)
            .then(() =>
              appRegistration(setup.api, {
                principal: null,
                person_id: null,
                host: null,
              }),
            );
        try {
          expect(await check(true)).toMatchObject({
            status: "passing",
            message:
              "An application permission acts without any person: Tenant.Read.All (reads every workspace). This app's service-account queries send the token holding it.",
          });
          expect(await check(false)).toMatchObject({
            status: "passing",
            message:
              "An application permission acts without any person: Tenant.Read.All (reads every workspace). This app does not use it, and it can be removed.",
          });
        } finally {
          fetch.mockRestore();
          await setup.api.settings.set(
            "powerbi.app_client_id",
            clientId,
            principals.admin,
          );
          await setup.api.settings.set(
            "powerbi.service_account_queries",
            false,
            principals.admin,
          );
        }
      });

      it("keeps a note with very many extras within the database's limit", async () => {
        const many = Array.from(
          { length: 60 },
          (_, index) =>
            `${POWER_BI}/Sample.${String.fromCharCode(97 + (index % 26), 97 + Math.floor(index / 26))}`,
        );
        await holding([...scopes, ...many]);
        const { result } = await step("app_registration", session);
        expect(result.status).toBe("passing");
        expect(result.message).toMatch(/ and \d+ more\./);
      });

      it("still fails, and takes back the step, when Dataset.Read.All is missing", async () => {
        await holding(["openid", `${POWER_BI}/Tenant.ReadWrite.All`]);
        const { result } = await step("app_registration", session);
        expect(result).toMatchObject({
          status: "failing",
          message:
            "Your Power BI token lacks Dataset.Read.All. Add that delegated permission under API permissions, grant admin consent, then connect Power BI again.",
        });
        expect((await appStep())?.passed).toBe(false);
      });

      it("takes a person stored as failing on the old rule past it, with nothing to do in Entra", async () => {
        await holding([...scopes, `${POWER_BI}/App.Read.All`]);
        // As an earlier release left it: refused for a permission too many.
        await setup.api.db
          .update(settingCheck)
          .set({
            status: "failing",
            action: null,
            message:
              "The app registration holds App.Read.All, which this app does not use. Remove it under API permissions: the app needs only the delegated permissions this step lists.",
          })
          .where(eq(settingCheck.key, "app_registration"));
        const completed = await setup.api.settings.get("setup.completed_steps");
        await setup.api.settings.set(
          "setup.completed_steps",
          completed.filter((id) => id !== "app_registration"),
          principals.admin,
        );
        expect(await appStep()).toMatchObject({
          passed: false,
          check: { status: "failing" },
        });
        const { result } = await step("app_registration", session);
        expect(result.status).toBe("passing");
        expect(await appStep()).toMatchObject({
          passed: true,
          check: {
            status: "passing",
            message:
              "Not needed by this app, which never uses it: App.Read.All. The app can still do what it allows.",
          },
        });
      });
    });
  });
});
