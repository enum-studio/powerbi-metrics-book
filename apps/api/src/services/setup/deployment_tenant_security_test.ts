import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeTestPools,
  createTestDeps,
  principals,
  testConfig,
  testPool,
} from "../../../test/deps.js";
import {
  joined,
  startSetup,
  type SetupFixture,
} from "../../../test/setup-support.js";
import { cookies } from "../../../test/sign-in-support.js";
import { MemorySettings } from "../../../test/doubles.js";
import { ServiceError } from "../../errors.js";
import { personDeactivation } from "../../db/schema/people.js";
import { setupLink } from "../../db/schema/setup.js";
import { enqueue } from "../jobs/queue.js";
import { runJobs } from "../jobs/runner.js";
import { createSettingsStore } from "../settings/store.js";
import "../sync/run.js";
import "./worker-checks.js";
import {
  firstAdmin,
  followSetupSignIn,
  setupPrincipal,
  spendSetupSignIn,
  startSetupSignIn,
} from "./link.js";
import { bindTenant, boundTenant } from "./bound.js";
import { refuseAnotherTenant } from "./tenant.js";

/*
 * A database belongs to one tenant, for life (threat model B1): the setup's
 * first admin binds it; the api and the worker refuse to start against
 * another tenant or the other side of the mock; the database refuses another
 * powerbi.tenant_id, and no role of the stack changes or removes the row.
 */

afterAll(closeTestPools);

const SAMPLE = "http://localhost:4010";
const MICROSOFT = "https://login.microsoftonline.com";
const TENANT = randomUUID();
const OTHER = randomUUID();

const migrator = () => testPool("migrator");
const asApi = () => testPool("api_rw");

async function reset() {
  await migrator().query("delete from deployment_tenant");
  await migrator().query("delete from setting where key = 'powerbi.tenant_id'");
}
const bind = (tenant_id: string, sample: boolean) =>
  asApi().query(
    "insert into deployment_tenant (tenant_id, sample) values ($1, $2)",
    [tenant_id, sample],
  );
const deps = (settings: Record<string, string | null>) =>
  createTestDeps({ settings: new MemorySettings(settings) });
const start = (authority: string, tenant_id: string | null = TENANT) =>
  refuseAnotherTenant(
    deps({ "powerbi.authority": authority, "powerbi.tenant_id": tenant_id }),
  );
const saveTenantId = (value: string | null) =>
  asApi().query(
    `insert into setting (key, value, set_by) values ('powerbi.tenant_id', $1::jsonb, 'test') on conflict (key) do update set value = excluded.value`,
    [JSON.stringify(value)],
  );

describe("starting against the tenant a database belongs to", () => {
  beforeEach(reset);

  it("starts an unbound database, on the mock and off it", async () => {
    await expect(start(SAMPLE)).resolves.toBeUndefined();
    await expect(start(MICROSOFT)).resolves.toBeUndefined();
    await expect(start(MICROSOFT, null)).resolves.toBeUndefined();
  });

  it("starts a bound database on the side and the tenant it was bound to", async () => {
    await bind(TENANT, true);
    await expect(start(SAMPLE)).resolves.toBeUndefined();
    await reset();
    await bind(TENANT, false);
    await expect(start(MICROSOFT)).resolves.toBeUndefined();
  });

  it("refuses a sample database pointed at Microsoft, with the way out", async () => {
    await bind(TENANT, true);
    await expect(start(MICROSOFT)).rejects.toThrow(
      "This database belongs to the sample tenant, and the stack now points at Microsoft identity at login.microsoftonline.com. A database keeps one tenant: start your own tenant on a new database. How: https://metrics.example.com/docs/start/sample-tenant/#move-to-your-own-tenant",
    );
  });

  it("refuses a real tenant's database pointed at the mock", async () => {
    await bind(TENANT, false);
    await expect(start(SAMPLE)).rejects.toThrow(
      `This database belongs to tenant ${TENANT}, and the stack now points at the mock at localhost:4010. The mock never runs over a real tenant's data: run the sample on its own database, which compose.mock.yml gives it. How: https://metrics.example.com/docs/start/sample-tenant/`,
    );
  });

  it("refuses another tenant id, or none", async () => {
    await bind(TENANT, false);
    await expect(start(MICROSOFT, OTHER)).rejects.toThrow(
      `This database belongs to tenant ${TENANT}, and powerbi.tenant_id is now ${OTHER}. A database keeps one tenant: start ${OTHER} on a new database.`,
    );
    await expect(start(MICROSOFT, null)).rejects.toThrow(
      `powerbi.tenant_id is now not set`,
    );
    await expect(
      start(MICROSOFT, TENANT.toUpperCase()),
    ).resolves.toBeUndefined();
  });
});

describe("binding", () => {
  beforeEach(reset);

  it("records the tenant and the side of the mock once, and refuses a second row", async () => {
    const db = createTestDeps().db;
    expect(await boundTenant(db)).toBeNull();
    await bindTenant(db, { tenant_id: TENANT, sample: true });
    expect(await boundTenant(db)).toEqual({ tenant_id: TENANT, sample: true });
    await expect(
      bindTenant(db, { tenant_id: OTHER, sample: false }),
    ).rejects.toThrow("The setup already finished.");
    expect(await boundTenant(db)).toEqual({ tenant_id: TENANT, sample: true });
  });

  it("lets one of two binds at once succeed, and keeps the first", async () => {
    const { db } = createTestDeps();
    const settled = await Promise.allSettled([
      bindTenant(db, { tenant_id: TENANT, sample: false }),
      bindTenant(db, { tenant_id: TENANT, sample: false }),
    ]);
    expect(settled.map((each) => each.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(await boundTenant(db)).toEqual({
      tenant_id: TENANT,
      sample: false,
    });
  });
});

describe("an admin without a binding", () => {
  beforeEach(reset);
  afterAll(() => migrator().query("delete from role_assignment"));
  const admin = () =>
    migrator().query(
      "insert into role_assignment (role, subject_kind, subject, granted_by) values ('admin', 'person', 'a@example.test', 'test')",
    );

  it("refuses the api and worker starts without reading roles", async () => {
    const workerDb = testPool("worker_rw");
    await expect(
      workerDb.query("select deployment_has_admin() as has_admin"),
    ).resolves.toMatchObject({ rows: [{ has_admin: false }] });
    await admin();
    await expect(start(SAMPLE)).rejects.toThrow(
      "An admin exists but this database holds no tenant. It was set up before tenants were recorded, or a setup did not finish: start on a new database.",
    );
    await expect(
      workerDb.query("select deployment_has_admin() as has_admin"),
    ).resolves.toMatchObject({ rows: [{ has_admin: true }] });
    await expect(
      refuseAnotherTenant(
        createTestDeps({
          container: "worker",
          pool: testPool("worker_rw"),
          settings: new MemorySettings({ "powerbi.authority": SAMPLE }),
        }),
      ),
    ).rejects.toThrow(
      "An admin exists but this database holds no tenant. It was set up before tenants were recorded, or a setup did not finish: start on a new database.",
    );
    await bind(TENANT, true);
    await expect(start(SAMPLE)).resolves.toBeUndefined();
  });
});

describe("the dev sign-in runs only on the mock", () => {
  beforeEach(reset);
  const open = testConfig("api", { ALLOW_DEV_SIGN_IN: "1" });
  const shut = testConfig("api", { ALLOW_DEV_SIGN_IN: "0" });
  const startWith = (config: typeof open, authority = MICROSOFT) =>
    refuseAnotherTenant(
      createTestDeps({
        config,
        settings: new MemorySettings({
          "powerbi.authority": authority,
          "powerbi.tenant_id": TENANT,
        }),
      }),
    );
  const sentence =
    "The dev sign-in is open (NODE_ENV=test with ALLOW_DEV_SIGN_IN=1), and the stack points at Microsoft identity at login.microsoftonline.com. The dev sign-in runs only on the mock: shut it, or point the stack at the mock.";

  it("is refused at start over a real authority, unbound and bound", async () => {
    await expect(startWith(open)).rejects.toThrow(sentence);
    await bind(TENANT, false);
    await expect(startWith(open)).rejects.toThrow(sentence);
    await expect(startWith(shut)).resolves.toBeUndefined();
  });

  it("is allowed on the mock, over the sample tenant", async () => {
    await expect(startWith(open, SAMPLE)).resolves.toBeUndefined();
    await bind(TENANT, true);
    await expect(startWith(open, SAMPLE)).resolves.toBeUndefined();
  });
});

describe("the worker's jobs", () => {
  beforeEach(reset);
  afterAll(() => migrator().query("delete from job_request"));

  it("checks the tenant before each job, a sync and a setup check alike", async () => {
    const worker = createTestDeps({
      container: "worker",
      pool: testPool("worker_rw"),
      settings: new MemorySettings({
        "powerbi.authority": MICROSOFT,
        "powerbi.tenant_id": OTHER,
      }),
    });
    await bind(TENANT, false);
    await migrator().query("delete from job_request");
    const stop = new AbortController();
    const running = runJobs(worker, { signal: stop.signal });
    const ids = await Promise.all([
      enqueue(worker.db, {
        job: "sync",
        runner: "worker",
        trigger: "schedule",
        args: { kind: "incremental" },
      }),
      enqueue(worker.db, {
        job: "check",
        runner: "worker",
        trigger: "manual",
        args: { step: "scanner" },
      }),
    ]);
    const deadline = Date.now() + 20_000;
    for (;;) {
      const { rows } = await migrator().query<{
        status: string;
        error: string;
      }>("select status, error from job_request where id = any($1)", [ids]);
      if (
        rows.length === 2 &&
        rows.every((row) => row.status !== "queued" && row.status !== "running")
      ) {
        for (const row of rows) {
          expect(row.status).toBe("failed");
          expect(row.error).toContain(
            `This database belongs to tenant ${TENANT}, and powerbi.tenant_id is now ${OTHER}.`,
          );
        }
        break;
      }
      if (Date.now() > deadline) throw new Error("the jobs did not finish");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    stop.abort();
    await running;
  });
});

describe("the database refuses another tenant id", () => {
  beforeEach(reset);
  const store = () => createSettingsStore(createTestDeps().db, {});

  it("through the settings service, with a sentence", async () => {
    await bind(TENANT, false);
    const refused = await store()
      .set("powerbi.tenant_id", OTHER, principals.admin)
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ServiceError);
    expect(refused).toMatchObject({
      kind: "invalid",
      message: `This deployment belongs to tenant ${TENANT}. A deployment keeps one tenant: run another tenant on a new database.`,
    });
    await expect(
      store().set("powerbi.tenant_id", null, principals.admin),
    ).rejects.toMatchObject({ kind: "invalid" });
    await store().set("powerbi.tenant_id", TENANT, principals.admin);
  });

  it("through SQL as api_rw, whatever the service checks", async () => {
    await saveTenantId(TENANT);
    await bind(TENANT, false);
    await expect(saveTenantId(OTHER)).rejects.toThrow(
      `This deployment belongs to tenant ${TENANT}.`,
    );
    await expect(saveTenantId(null)).rejects.toThrow(/belongs to tenant/);
    await expect(
      asApi().query(
        "update setting set value = to_jsonb($1::text) where key = 'powerbi.tenant_id'",
        [OTHER],
      ),
    ).rejects.toThrow(/belongs to tenant/);
    await saveTenantId(TENANT);
  });

  it("refuses to rename a row, so the trigger cannot be skipped by a new key", async () => {
    await migrator().query("delete from setting where key = 'search.model'");
    await saveTenantId(TENANT);
    const rename = () =>
      asApi().query(
        "update setting set key = 'search.model' where key = 'powerbi.tenant_id'",
      );
    await expect(rename()).rejects.toThrow(/key of a setting never changes/);
    await bind(TENANT, false);
    await expect(rename()).rejects.toThrow(/key of a setting never changes/);
  });

  it("pins the search_path of both trigger functions", async () => {
    const { rows } = await migrator().query<{
      proname: string;
      proconfig: string[];
      prosecdef: boolean;
      owner: string;
    }>(
      "select procedure.proname, procedure.proconfig, procedure.prosecdef, pg_get_userbyid(procedure.proowner) as owner from pg_proc as procedure where procedure.proname in ('setting_keep_bound_tenant', 'setting_keep_key', 'deployment_has_admin')",
    );
    expect(rows.map((row) => row.proname).sort()).toEqual([
      "deployment_has_admin",
      "setting_keep_bound_tenant",
      "setting_keep_key",
    ]);
    for (const row of rows)
      expect(row.proconfig).toContain("search_path=pg_catalog, public");
    expect(
      rows.find((row) => row.proname === "deployment_has_admin")?.prosecdef,
    ).toBe(true);
    expect(
      rows.find((row) => row.proname === "deployment_has_admin")?.owner,
    ).toBe("migrator");
  });

  it("leaves every other setting alone", async () => {
    await bind(TENANT, false);
    await asApi().query(
      `insert into setting (key, value, set_by) values ('access.default_role', '"none"', 'test') on conflict (key) do update set value = excluded.value`,
    );
  });
});

describe("the binding row", () => {
  beforeEach(reset);

  it("is changed or removed by no role of the stack, and written by the api alone", async () => {
    await bind(TENANT, false);
    await expect(
      asApi().query("update deployment_tenant set sample = true"),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asApi().query("delete from deployment_tenant"),
    ).rejects.toThrow(/permission denied/);
    await expect(
      testPool("worker_rw").query(
        "insert into deployment_tenant (tenant_id, sample) values ($1, false)",
        [OTHER],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      testPool("worker_rw").query("select tenant_id from deployment_tenant"),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(
      testPool("audit_writer").query("select 1 from deployment_tenant"),
    ).rejects.toThrow(/permission denied/);
  });

  it("holds one row at most", async () => {
    await bind(TENANT, false);
    await expect(bind(OTHER, false)).rejects.toThrow(/duplicate key/);
    await expect(
      asApi().query(
        "insert into deployment_tenant (id, tenant_id, sample) values (false, $1, false)",
        [OTHER],
      ),
    ).rejects.toThrow(/deployment_tenant_single_row/);
  });
});

describe("the setup's first admin", () => {
  let setup: SetupFixture;
  beforeAll(async () => {
    setup = await startSetup();
  });
  afterAll(() => setup.close());

  const step = "/api/setup/steps/app_registration";
  const EMAIL = "admin@sample.example";

  /** A clean database, the app registration saved, and the person signed in through the mock. */
  async function signedIn() {
    await reset();
    await migrator().query("delete from role_assignment");
    await migrator().query("delete from setup_link");
    const app = setup.tenant.apps_registrations[0];
    const session = await setup.openSession();
    const registered = await setup.post(step, session, {
      settings: {
        "powerbi.tenant_id": setup.tenant.tenant_id,
        "powerbi.app_client_id": app?.client_id,
      },
      secrets: {
        powerbi_app_client_secret: { value: app?.secret, expires_at: null },
      },
    });
    expect(registered.status).toBe(200);
    const done = await setup.signIn(
      setup.person("admin"),
      joined(session, cookies(registered)),
    );
    return done.cookie;
  }
  const nothingMade = async () => {
    expect(await boundTenant(setup.api.db)).toBeNull();
    const roles = await migrator().query("select 1 from role_assignment");
    expect(roles.rowCount).toBe(0);
    const links = await migrator().query("select 1 from setup_link");
    expect(links.rowCount).toBe(1);
  };
  const confirm = (cookie: string) =>
    setup.post(step, cookie, { confirm_email: EMAIL });

  it("binds the tenant and the side the setup's sign-in came through, on the mock", async () => {
    const cookie = await signedIn();
    const [row] = await setup.api.db.select().from(setupLink);
    expect(row).toMatchObject({
      signed_in_tenant_id: setup.tenant.tenant_id,
      signed_in_sample: true,
    });
    expect(await boundTenant(setup.api.db)).toBeNull();
    expect((await confirm(cookie)).status).toBe(200);
    expect(await boundTenant(setup.api.db)).toEqual({
      tenant_id: setup.tenant.tenant_id,
      sample: true,
    });
  });

  it("refuses another tenant id saved after the sign-in, and makes nothing", async () => {
    const cookie = await signedIn();
    await migrator().query(
      "update setting set value = to_jsonb($1::text) where key = 'powerbi.tenant_id'",
      [OTHER],
    );
    const refused = await confirm(cookie);
    expect(refused.status).toBe(400);
    expect(JSON.stringify(await refused.json())).toContain(
      `The setup's sign-in came through tenant ${setup.tenant.tenant_id} on the mock, and the stack now has tenant ${OTHER} on the mock. Print a new setup link and sign in again.`,
    );
    await nothingMade();
  });

  it("refuses the other side of the mock after the sign-in, and makes nothing", async () => {
    const cookie = await signedIn();
    const [session] = await setup.api.db.select().from(setupLink);
    if (session === undefined) throw new Error("no setup session");
    const otherSide = createSettingsStore(setup.api.db, {
      POWERBI_AUTHORITY: MICROSOFT,
    });
    await expect(
      firstAdmin(
        {
          ...setup.api,
          settings: otherSide,
          principal: setupPrincipal(session),
        },
        session,
        session.admitted_user_id,
        EMAIL,
      ),
    ).rejects.toThrow(
      `The setup's sign-in came through tenant ${setup.tenant.tenant_id} on the mock, and the stack now has tenant ${setup.tenant.tenant_id} on Microsoft. Print a new setup link and sign in again.`,
    );
    expect(cookie).not.toBe("");
    await nothingMade();
  });

  it("refuses to confirm without a tenant id, recorded or current", async () => {
    const cookie = await signedIn();
    await migrator().query(
      "update setup_link set signed_in_tenant_id = null, signed_in_sample = null",
    );
    const refused = await confirm(cookie);
    expect(refused.status).toBe(400);
    expect(JSON.stringify(await refused.json())).toContain(
      "The setup's sign-in came through no tenant id",
    );
    await nothingMade();
  });

  it("refuses to confirm a real tenant under an open dev sign-in, and makes nothing", async () => {
    await signedIn();
    await migrator().query("update setup_link set signed_in_sample = false");
    const [session] = await setup.api.db.select().from(setupLink);
    if (session === undefined) throw new Error("no setup session");
    await expect(
      firstAdmin(
        {
          ...setup.api,
          config: testConfig("api", { ALLOW_DEV_SIGN_IN: "1" }),
          settings: createSettingsStore(setup.api.db, {
            POWERBI_AUTHORITY: MICROSOFT,
          }),
          principal: setupPrincipal(session),
        },
        session,
        session.admitted_user_id,
        EMAIL,
      ),
    ).rejects.toThrow(
      "The dev sign-in is open (NODE_ENV=test with ALLOW_DEV_SIGN_IN=1), and the stack points at Microsoft identity at login.microsoftonline.com. The dev sign-in runs only on the mock: shut it, or point the stack at the mock.",
    );
    await nothingMade();
  });

  it("refuses the first admin when the person who signed in is deactivated, and makes nothing", async () => {
    await signedIn();
    const [session] = await setup.api.db.select().from(setupLink);
    if (session?.admitted_user_id == null) throw new Error("no setup session");
    await setup.api.db.insert(personDeactivation).values({
      user_id: session.admitted_user_id,
      deactivated_by: session.admitted_user_id,
      deactivated_at: new Date(),
    });
    try {
      await expect(
        firstAdmin(
          { ...setup.api, principal: setupPrincipal(session) },
          session,
          session.admitted_user_id,
          EMAIL,
        ),
      ).rejects.toMatchObject({
        kind: "refused",
        message: "An admin deactivated you, so this change was refused.",
      });
      await nothingMade();
    } finally {
      // The tests after this one sign in as the same person.
      await setup.api.db
        .delete(personDeactivation)
        .where(eq(personDeactivation.user_id, session.admitted_user_id));
    }
  });

  it("compares the tenant id the stack uses, so one set in the environment confirms over a stale row", async () => {
    await signedIn();
    await migrator().query(
      "update setting set value = to_jsonb($1::text) where key = 'powerbi.tenant_id'",
      [OTHER],
    );
    const [session] = await setup.api.db.select().from(setupLink);
    if (session === undefined) throw new Error("no setup session");
    const settings = createSettingsStore(setup.api.db, {
      POWERBI_AUTHORITY: await setup.api.settings.get("powerbi.authority"),
      POWERBI_TENANT_ID: setup.tenant.tenant_id.toUpperCase(),
    });
    await expect(
      firstAdmin(
        { ...setup.api, settings, principal: setupPrincipal(session) },
        session,
        session.admitted_user_id,
        EMAIL,
      ),
    ).resolves.toEqual({ made: true });
    expect(await boundTenant(setup.api.db)).toEqual({
      tenant_id: setup.tenant.tenant_id,
      sample: true,
    });
  });

  it("compares the tenant id again inside the transaction, under a lock on its row", async () => {
    const cookie = await signedIn();
    const holder = await testPool("migrator").connect();
    try {
      const { rows } = await holder.query<{ pid: number }>(
        "select pg_backend_pid() as pid",
      );
      const pid = rows[0]?.pid;
      await holder.query("begin");
      await holder.query(
        "update setting set value = to_jsonb($1::text) where key = 'powerbi.tenant_id'",
        [OTHER],
      );
      const refused = confirm(cookie);
      const deadline = Date.now() + 10_000;
      for (;;) {
        const { rowCount } = await holder.query(
          "select 1 from pg_stat_activity where $1 = any(pg_blocking_pids(pid))",
          [pid],
        );
        if (rowCount !== 0) break;
        if (Date.now() > deadline) {
          await holder.query("rollback");
          throw new Error("the confirm never waited on the setting's row");
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await holder.query("commit");
      const answer = await refused;
      expect(answer.status).toBe(400);
      expect(JSON.stringify(await answer.json())).toContain(
        `the stack now has tenant ${OTHER}`,
      );
    } finally {
      holder.release();
    }
    await nothingMade();
  });

  it("makes one admin and one binding from two confirms at once", async () => {
    const cookie = await signedIn();
    const answers = await Promise.all([confirm(cookie), confirm(cookie)]);
    expect(
      answers.filter((each) => each.status === 200),
      JSON.stringify(await Promise.all(answers.map((each) => each.text()))),
    ).toHaveLength(1);
    const roles = await migrator().query("select 1 from role_assignment");
    expect(roles.rowCount).toBe(1);
    expect(await boundTenant(setup.api.db)).toMatchObject({ sample: true });
  });

  it("writes the first admin's role.assign audit row", async () => {
    const cookie = await signedIn();
    expect((await confirm(cookie)).status).toBe(200);
    const [role] = (
      await migrator().query<{ id: string }>("select id from role_assignment")
    ).rows;
    const audit = await migrator().query(
      "select 1 from audit_event where action = 'admin.role.assign' and resource_kind = 'role_assignment' and resource_id = $1 and decision = 'allow'",
      [role?.id],
    );
    expect(audit.rowCount).toBe(1);
  });

  it("records the tenant and side the token was checked against, not the settings read later", async () => {
    await signedIn();
    const [session] = await setup.api.db.select().from(setupLink);
    if (session?.admitted_user_id == null) throw new Error("no admitted user");
    const marker = await startSetupSignIn(setup.api, session);
    await followSetupSignIn(
      setup.api,
      { marker, state: null },
      Response.json({ url: "https://login.example/authorize?state=abc" }),
    );
    const spent = await spendSetupSignIn(
      setup.api,
      { marker, state: "abc" },
      session.admitted_user_id,
      {
        provider: "microsoft",
        microsoft_object_id: randomUUID(),
        tenant_member: true,
        group_ids: null,
        domain_verified: true,
        checked_tenant_id: OTHER,
        checked_on_mock: false,
      },
    );
    expect(spent).toBe(true);
    const [row] = await setup.api.db.select().from(setupLink);
    expect(row).toMatchObject({
      signed_in_tenant_id: OTHER,
      signed_in_sample: false,
    });
  });

  it("makes no admin when the binding fails, all in one transaction", async () => {
    const cookie = await signedIn();
    await bind(OTHER, false);
    const auditRowsBefore = await migrator().query<{ id: string }>(
      "select id from audit_event where action = 'admin.role.assign' order by id",
    );
    const refused = await confirm(cookie);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      error: "invalid",
      message: "The setup already finished.",
    });
    const roles = await migrator().query("select 1 from role_assignment");
    expect(roles.rowCount).toBe(0);
    const links = await migrator().query("select 1 from setup_link");
    expect(links.rowCount).toBe(1);
    const auditRowsAfter = await migrator().query<{ id: string }>(
      "select id from audit_event where action = 'admin.role.assign' order by id",
    );
    expect(auditRowsAfter.rows).toEqual(auditRowsBefore.rows);
  });
});
