import { ROUTE_MATRIX } from "../authorization-matrix.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  cerbosAccess,
  closeTestPools,
  principals,
  TEST_PUBLIC_BASE_URL,
  testPool,
} from "../../../test/deps.js";
import { publishedIdentities } from "../../../test/secrets-support.js";
import { startOAuth } from "../../../test/sign-in-support.js";
import { createDb } from "../../db/client.js";
import {
  powerbiColumn,
  powerbiDataset,
  powerbiTable,
  powerbiWorkspace,
  syncRun,
} from "../../db/schema/mirror.js";
import { registerCheck, storeCheck } from "../../services/admin/checks.js";
import { jobRequest } from "../../db/schema/jobs.js";
import { settingCheck } from "../../db/schema/admin.js";
import { assignRole } from "../../services/auth/roles.js";
import {
  createKey,
  createServiceAccount,
} from "../../services/auth/service-accounts.js";
import { createSettingsStore } from "../../services/settings/store.js";

/*
 * The admin routes through the whole app: real Postgres and Cerbos, people
 * signed in through the dev sign-in. The Cerbos is the one that also loads
 * an example deployment's policy giving the role integration every admin
 * action, so a service account holding it shows the code's bound.
 */

const routeWriter = createDb(testPool("worker_rw"));
const routeDataset = {
  workspace: randomUUID(),
  id: randomUUID(),
  name: "Route test",
};

afterAll(async () => {
  await routeWriter
    .delete(powerbiWorkspace)
    .where(eq(powerbiWorkspace.id, routeDataset.workspace));
  await closeTestPools();
});

// The real store: saving a setting runs in a transaction, which a double cannot join.
const settings = createSettingsStore(createDb(testPool("api_rw")), {});
const oauth = startOAuth({
  settings,
  access: cerbosAccess(settings, "override"),
});
const admin = { ...oauth.deps, principal: principals.admin };
const SECRET = "sk-test-0123456789-abcdwxyz";

beforeAll(async () => {
  await routeWriter.insert(powerbiWorkspace).values({
    id: routeDataset.workspace,
    name: "Route test workspace",
  });
  await routeWriter.insert(powerbiDataset).values({
    id: routeDataset.id,
    workspace_id: routeDataset.workspace,
    name: routeDataset.name,
  });
  const tableId = randomUUID();
  await routeWriter.insert(powerbiTable).values({
    id: tableId,
    dataset_id: routeDataset.id,
    name: "Customer",
  });
  await routeWriter.insert(powerbiColumn).values({
    dataset_id: routeDataset.id,
    table_id: tableId,
    name: "Email",
  });
  await publishedIdentities(oauth.deps.db);
  registerCheck("route_step", () =>
    Promise.resolve({ status: "passing", message: null }),
  );
});

async function person(role: "viewer" | "curator" | "admin") {
  const signedIn = await oauth.person();
  if (role !== "viewer")
    await assignRole(
      oauth.deps.db,
      { role, subject_kind: "person", subject: signedIn.email },
      principals.admin,
    );
  return signedIn;
}

const browser = (cookie: string) => ({ cookie, origin: TEST_PUBLIC_BASE_URL });
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
    cache: answer.headers.get("cache-control"),
    text,
    body: text === "" ? null : (JSON.parse(text) as Record<string, unknown>),
  };
}

it("lists deactivation in the matrix and refuses a curator", async () => {
  expect(
    Reflect.get(ROUTE_MATRIX, "POST /api/v1/admin/people/:id/deactivate"),
  ).toMatchObject({ curator: "refused" });
  expect(
    (
      await send(
        browser((await person("curator")).cookie),
        "POST",
        `/admin/people/${randomUUID()}/deactivate`,
      )
    ).status,
  ).toBe(403);
});

it("returns fragment-token links for link invites and resend", async () => {
  const auth = browser((await person("admin")).cookie);
  const created = await send(auth, "POST", "/admin/people/invites", {
    emails: [`invite-${randomUUID()}@sample.example`],
    role: "curator",
    delivery: "link",
  });
  expect(created.status).toBe(200);
  const [invite] = z
    .object({
      invites: z.array(z.object({ id: z.string(), link: z.string() })),
    })
    .parse(created.body).invites;
  if (!invite) throw new Error("The invite answered no link");
  const first = new URL(invite.link);
  expect(first.search).toBe("");
  expect(first.hash.length).toBeGreaterThan(1);
  const resent = await send(
    auth,
    "POST",
    `/admin/people/invites/${invite.id}/resend`,
  );
  expect(resent.status).toBe(200);
  const link = z.object({ link: z.string() }).parse(resent.body).link;
  expect(new URL(link).search).toBe("");
  expect(new URL(link).hash.length).toBeGreaterThan(1);
  expect(link).not.toBe(invite.link);
  const listed = await send(auth, "GET", "/admin/people/invites");
  expect(listed.status).toBe(200);
  expect(
    z.object({ email_ready: z.boolean() }).parse(listed.body).email_ready,
  ).toBe(false);
  expect(
    (await send(auth, "DELETE", `/admin/people/invites/${invite.id}`)).status,
  ).toBe(204);
});

const ID = randomUUID();
const BOOK = "format: 1\nsettings:\n  results.ttl_hours: 48\n";
const adminCalls: [string, string, object?][] = [
  ["GET", "/admin/pii/rules"],
  [
    "PUT",
    "/admin/pii/rules",
    { kind: "column", table: "Customer", name: "Customer", pii: true },
  ],
  ["DELETE", `/admin/pii/rules/${ID}`],
  ...["some-version", "stale-version"].flatMap(
    (expected_version): [string, string, object?][] => [
      [
        "PUT",
        "/admin/pii/rules",
        { kind: "table", table: "Customer", pii: true, expected_version },
      ],
      ["DELETE", `/admin/pii/rules/${ID}?expected_version=${expected_version}`],
    ],
  ),
  ["GET", "/admin/pii/suggestions"],
  ["GET", "/admin/datasets"],
  ["PUT", `/admin/datasets/${routeDataset.id}`, { enabled: true }],
  ["GET", "/admin/settings/results.ttl_hours"],
  ["PUT", "/admin/settings/results.ttl_hours", { value: 24 }],
  ["GET", "/admin/secrets"],
  ["PUT", "/admin/secrets/openai_api_key", { value: SECRET }],
  ["PUT", "/admin/secrets/openai_api_key/expiry", { expires_at: null }],
  ["POST", "/admin/checks/route_step"],
  ["GET", "/admin/roles"],
  [
    "POST",
    "/admin/roles",
    { role: "curator", subject_kind: "person", subject: "a@example.test" },
  ],
  ["DELETE", `/admin/roles/${ID}`],
  ["GET", "/admin/people"],
  ["PUT", `/admin/people/${ID}/role`, { role: "viewer" }],
  ["PUT", `/admin/people/${ID}/pii`, { allowed: true }],
  ["POST", `/admin/people/${ID}/deactivate`],
  ["POST", `/admin/people/${ID}/reactivate`],
  ["POST", `/admin/people/${ID}/sign-out`],
  ["DELETE", `/admin/people/${ID}`],
  ["GET", "/admin/people/invites"],
  ["POST", `/admin/people/invites/${ID}/resend`],
  ["DELETE", `/admin/people/invites/${ID}`],
  ["PUT", "/admin/branding/logo"],
  ["DELETE", "/admin/branding/logo"],
  [
    "POST",
    "/admin/people/invites",
    { emails: ["invited@sample.example"], role: "viewer", delivery: "link" },
  ],
  ["POST", "/admin/sync", {}],
  ["GET", "/admin/sync"],
  ["GET", "/admin/service-accounts"],
  [
    "POST",
    "/admin/service-accounts",
    { name: "route_refused", owner_email: "o@example.test", roles: ["viewer"] },
  ],
  ["PATCH", "/admin/service-accounts/route_refused", { disabled: true }],
  ["DELETE", "/admin/service-accounts/route_refused"],
  ["GET", "/admin/service-accounts/route_refused/keys"],
  [
    "POST",
    "/admin/service-accounts/route_refused/keys",
    { expires_in_days: 30 },
  ],
  ["DELETE", `/admin/service-accounts/route_refused/keys/${ID}`],
  ["DELETE", "/admin/grants/some_grant"],
  ["GET", "/admin/audit"],
  ["GET", "/admin/export"],
  ["POST", "/admin/import", { yaml: BOOK }],
];

describe("the secrets routes", () => {
  it("change a saved secret's date and leave its value, hint and setter as they were", async () => {
    const admins = browser((await person("admin")).cookie);
    const saved = await send(admins, "PUT", "/admin/secrets/openai_api_key", {
      value: SECRET,
    });
    expect(saved.status, saved.text).toBe(200);
    const dated = await send(
      admins,
      "PUT",
      "/admin/secrets/openai_api_key/expiry",
      { expires_at: "2027-06-30T23:59:59Z" },
    );
    expect(dated.status, dated.text).toBe(200);
    expect(dated.text).not.toContain(SECRET);
    expect(dated.body).toEqual({
      ...(saved.body as object),
      expires_at: "2027-06-30T23:59:59.000Z",
    });
    const cleared = await send(
      admins,
      "PUT",
      "/admin/secrets/openai_api_key/expiry",
      { expires_at: null },
    );
    expect(cleared.body).toMatchObject({ expires_at: null, hint: "wxyz" });
  });

  it("refuse a date for a secret with no value, a name that is no secret and a date with a value in it", async () => {
    const admins = browser((await person("admin")).cookie);
    const unset = await send(
      admins,
      "PUT",
      "/admin/secrets/resend_api_key/expiry",
      { expires_at: "2027-06-30T23:59:59Z" },
    );
    expect(unset.status).toBe(400);
    expect(unset.text).toContain("resend_api_key has no value yet");
    expect(
      (
        await send(admins, "PUT", "/admin/secrets/not_a_secret/expiry", {
          expires_at: null,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await send(admins, "PUT", "/admin/secrets/openai_api_key/expiry", {
          expires_at: null,
          value: SECRET,
        })
      ).status,
    ).toBe(400);
  });

  it("answer a saved secret without its value, and list it set with its last four characters", async () => {
    const admins = browser((await person("admin")).cookie);
    const saved = await send(admins, "PUT", "/admin/secrets/openai_api_key", {
      value: SECRET,
      expires_at: "2027-06-30T00:00:00Z",
    });
    expect(saved.status, saved.text).toBe(200);
    expect(saved.body).toMatchObject({
      name: "openai_api_key",
      set: true,
      hint: "wxyz",
    });
    expect(saved.text).not.toContain(SECRET);
    const listed = await send(admins, "GET", "/admin/secrets");
    const found = (listed.body?.secrets as { name: string }[]).find(
      (s) => s.name === "openai_api_key",
    );
    expect(found).toMatchObject({ set: true, hint: "wxyz" });
    expect(listed.text).not.toContain(SECRET);
  });

  it("refuse a value that is empty, too long, or sent as anything but a string", async () => {
    const admins = browser((await person("admin")).cookie);
    for (const value of ["", "x".repeat(8193), 7, null])
      expect(
        (await send(admins, "PUT", "/admin/secrets/openai_api_key", { value }))
          .status,
      ).toBe(400);
    expect(
      (await send(admins, "PUT", "/admin/secrets/not_a_secret", { value: "v" }))
        .status,
    ).toBe(400);
  });
});

// Each test signs people in, and the people list reads every one of them.
describe("the admin routes", { timeout: 120_000 }, () => {
  it("sets a PII rule with its live counts", async () => {
    const admins = browser((await person("admin")).cookie);
    const saved = await send(admins, "PUT", "/admin/pii/rules", {
      kind: "column",
      table: "Customer",
      name: "Email",
      pii: true,
    });
    expect(saved.status, saved.text).toBe(200);
    expect(saved.body).toMatchObject({
      rule: {
        kind: "column",
        table_name: "Customer",
        name: "Email",
        pii: true,
      },
      columns: 0,
      measures: 0,
      datasets: 0,
    });
    const listed = await send(admins, "GET", "/admin/pii/rules?pii=true");
    expect(listed.status).toBe(200);
    const ruleId = (saved.body?.rule as { id: string }).id;
    expect(
      (
        listed.body?.rules as {
          id: string;
          columns: number;
          datasets: number;
        }[]
      ).find(({ id }) => id === ruleId),
    ).toMatchObject({ columns: 0, datasets: 0 });
  });

  it("lists, suggests, removes rules, and switches datasets", async () => {
    const admins = browser((await person("admin")).cookie);
    expect(
      (await send(admins, "GET", "/admin/pii/rules?pii=true")).status,
    ).toBe(200);
    expect((await send(admins, "GET", "/admin/pii/suggestions")).status).toBe(
      200,
    );
    expect(
      (await send(admins, "GET", "/admin/pii/suggestions?dataset=%00")).status,
    ).toBe(400);
    expect((await send(admins, "GET", "/admin/datasets")).status).toBe(200);
    const turnedOff = await send(
      admins,
      "PUT",
      `/admin/datasets/${routeDataset.id}`,
      { enabled: false },
    );
    expect(turnedOff.status).toBe(200);
    expect(turnedOff.body).toMatchObject({
      id: routeDataset.id,
      enabled: false,
    });
    const listedDatasets = await send(admins, "GET", "/admin/datasets");
    expect(
      (
        listedDatasets.body?.datasets as { id: string; enabled: boolean }[]
      ).find(({ id }) => id === routeDataset.id),
    ).toMatchObject({ enabled: false });
    expect(
      (
        await send(admins, "PUT", "/admin/pii/rules", {
          kind: "table",
          table: "Customer",
          pii: true,
          extra: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await send(admins, "PUT", "/admin/pii/rules", {
          kind: "table",
          table: "Customer",
          pii: true,
          set_via: "forged",
        })
      ).status,
    ).toBe(400);
    const added = await send(admins, "PUT", "/admin/pii/rules", {
      kind: "table",
      table: "Orders",
      pii: false,
    });
    expect(added.status).toBe(200);
    const addedRuleId = (added.body?.rule as { id: string }).id;
    expect(
      (await send(admins, "DELETE", `/admin/pii/rules/${addedRuleId}`)).status,
    ).toBe(204);
    expect(
      (await send(admins, "DELETE", `/admin/pii/rules/${randomUUID()}`)).status,
    ).toBe(404);
    expect(
      (
        await send(
          admins,
          "DELETE",
          `/admin/pii/rules/${randomUUID()}?expected_version=null`,
        )
      ).status,
    ).toBe(409);
  });

  it("refuse a curator on every route, and a viewer too", async () => {
    for (const role of ["curator", "viewer"] as const) {
      const auth = browser((await person(role)).cookie);
      // The status is read_status, which only a deployment's own policy gives another role.
      for (const [method, path, body] of [
        ...adminCalls,
        ["GET", "/admin/status"] as [string, string, object?],
      ])
        expect(
          (await send(auth, method, path, body)).status,
          `${role} ${method} ${path}`,
        ).toBe(403);
    }
  });

  it("refuse a service account on every route but the status, which a policy may give its role", async () => {
    const name = `route_sa_${randomUUID().slice(0, 8)}`;
    await createServiceAccount(admin, {
      name,
      owner_email: "owner@example.test",
      roles: ["integration"],
    });
    const { key } = await createKey(admin, name, { expires_in_days: 30 });
    for (const [method, path, body] of adminCalls)
      expect(
        (await send(bearer(key), method, path, body)).status,
        `${method} ${path}`,
      ).toBe(403);
    const status = await send(bearer(key), "GET", "/admin/status");
    expect(status.status, status.text).toBe(200);
    // Without manage_settings in code, the status names what needs doing and no more.
    expect(status.body).not.toHaveProperty("people_to_reconnect");
  });

  it("say no-store on every admin answer, a refusal and an error too", async () => {
    const admins = browser((await person("admin")).cookie);
    const viewer = browser((await person("viewer")).cookie);
    for (const [auth, path, status] of [
      [admins, "/admin/people", 200],
      [admins, "/admin/roles/nope", 400],
      [viewer, "/admin/people", 403],
    ] as const) {
      const answer = await send(
        auth,
        path === "/admin/roles/nope" ? "DELETE" : "GET",
        path,
      );
      expect(answer.status, path).toBe(status);
      expect(answer.cache, path).toBe("no-store");
    }
  });

  it("let an admin read and save a setting, run a check, and read the status", async () => {
    const admins = browser((await person("admin")).cookie);
    const saved = await send(
      admins,
      "PUT",
      "/admin/settings/results.ttl_hours",
      {
        value: 36,
      },
    );
    expect(saved.body).toMatchObject({ key: "results.ttl_hours", value: 36 });
    const read = await send(admins, "GET", "/admin/settings/results.ttl_hours");
    expect(read.body).toMatchObject({ value: 36, source: "database" });
    expect(
      (await send(admins, "GET", "/admin/settings/no.such.key")).status,
    ).toBe(404);
    expect(
      (
        await send(admins, "PUT", "/admin/settings/results.ttl_hours", {
          value: "never",
        })
      ).status,
    ).toBe(400);
    expect(
      (await send(admins, "POST", "/admin/checks/route_step")).body,
    ).toEqual({ status: "passing", message: null });
    expect(
      (await send(admins, "POST", "/admin/checks/no_such_check")).status,
    ).toBe(404);
    expect((await send(admins, "GET", "/admin/checks/route_step")).status).toBe(
      404,
    );
    const security = await send(admins, "POST", "/admin/checks/security");
    expect(security.body).toMatchObject({
      status: "failing",
      message: expect.stringContaining("items fail") as unknown,
      details: {
        items: expect.arrayContaining([
          {
            item: "app_registration_read_only",
            status: "failing",
            sentence: expect.stringContaining("app registration") as unknown,
          },
        ]) as unknown,
      },
    });
    const status = await send(admins, "GET", "/admin/status");
    expect(status.body).toMatchObject({
      version: expect.any(String) as unknown,
      people_to_reconnect: [],
    });
  });

  it("answer an admin's run of the scanner check before the worker has run it, and settle once it has", async () => {
    const admins = browser((await person("admin")).cookie);
    const scannerJobs = () =>
      oauth.deps.db
        .select({ id: jobRequest.id })
        .from(jobRequest)
        .where(
          sql`${jobRequest.job} = 'check' and ${jobRequest.args}->>'step' = 'scanner'`,
        );
    // No worker runs here: the answer cannot have waited for one.
    const started = Date.now();
    const run = await send(admins, "POST", "/admin/checks/scanner");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(run.body).toEqual({
      status: "failing",
      pending: true,
      message: "The check is in the worker's queue and starts shortly.",
    });
    // Polling starts nothing, and a second run while it waits queues no other.
    expect(
      (await send(admins, "GET", "/admin/checks/scanner")).body,
    ).toMatchObject({ pending: true });
    await send(admins, "POST", "/admin/checks/scanner");
    expect(await scannerJobs()).toHaveLength(1);

    // As the worker does: it finishes the job and stores its result.
    await oauth.deps.db
      .update(jobRequest)
      .set({ status: "succeeded", finished_at: new Date() })
      .where(
        sql`${jobRequest.job} = 'check' and ${jobRequest.args}->>'step' = 'scanner'`,
      );
    await storeCheck(oauth.deps, "scanner", {
      status: "passing",
      message: "Read.",
    });
    expect((await send(admins, "GET", "/admin/checks/scanner")).body).toEqual({
      status: "passing",
      message: "Read.",
    });
  });

  it("refuse a value that fails its check with fields a client can branch on, and keep it when save_failing says so", async () => {
    const SENTENCE = "The page size is more than the database holds.";
    registerCheck("results.page_rows_max", () =>
      Promise.resolve({ status: "failing", message: SENTENCE }),
    );
    const admins = browser((await person("admin")).cookie);
    const url = "/admin/settings/results.page_rows_max";
    const refused = await send(admins, "PUT", url, { value: 300 });
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({
      error: "invalid",
      message: expect.stringContaining("failed its check") as unknown,
      save_failing_allowed: true,
      check: { name: "results.page_rows_max", message: SENTENCE },
    });
    // A value the schema refuses is not one to save anyway, and says nothing of it.
    const invalid = await send(admins, "PUT", url, { value: "never" });
    expect(invalid.body).not.toHaveProperty("save_failing_allowed");
    const kept = await send(admins, "PUT", url, {
      value: 300,
      save_failing: true,
    });
    expect(kept.body).toMatchObject({
      value: 300,
      check: { status: "failing", message: SENTENCE },
    });
  });

  it("send the redirect URIs of each way of signing in ready to copy, Microsoft's two included", async () => {
    const admins = browser((await person("admin")).cookie);
    const read = await send(admins, "GET", "/admin/settings/sign_in.providers");
    const base = TEST_PUBLIC_BASE_URL.replace(/\/$/, "");
    expect(read.body).toMatchObject({
      redirect_uris: {
        microsoft: [
          `${base}/api/auth/callback/microsoft`,
          `${base}/api/v1/powerbi/callback`,
        ],
        google: [`${base}/api/auth/callback/google`],
        oidc: [`${base}/api/auth/sso/callback`],
      },
    });
    const other = await send(
      admins,
      "GET",
      "/admin/settings/results.ttl_hours",
    );
    expect(other.body).toMatchObject({ redirect_uris: null });
  });

  it("assign and revoke roles, and list people with where each role comes from", async () => {
    const admins = browser((await person("admin")).cookie);
    const email = `roles-${randomUUID().slice(0, 8)}@example.test`;
    const made = await send(admins, "POST", "/admin/roles", {
      role: "curator",
      subject_kind: "person",
      subject: email,
    });
    expect(made.status, made.text).toBe(201);
    const id = made.body?.id as string;
    expect(
      (
        await send(admins, "POST", "/admin/roles", {
          role: "curator",
          subject_kind: "person",
          subject: email,
        })
      ).status,
    ).toBe(409);
    const listed = await send(admins, "GET", "/admin/roles");
    expect((listed.body?.roles as { id: string }[]).map((r) => r.id)).toContain(
      id,
    );
    const people = await send(admins, "GET", "/admin/people");
    expect(people.status).toBe(200);
    expect((people.body?.people as unknown[]).length).toBeGreaterThan(0);
    expect((await send(admins, "DELETE", `/admin/roles/${id}`)).status).toBe(
      204,
    );
    expect((await send(admins, "DELETE", "/admin/roles/nope")).status).toBe(
      400,
    );
  });

  it("queue one sync for requests at the same moment, answer 202 to it and 200 to the rest, and audit it once", async () => {
    const admins = browser((await person("admin")).cookie);
    const answers = await Promise.all(
      Array.from({ length: 6 }, () =>
        send(admins, "POST", "/admin/sync", { kind: "full" }),
      ),
    );
    const queued = answers.filter((a) => a.status === 202);
    expect(queued, JSON.stringify(answers.map((a) => a.status))).toHaveLength(
      1,
    );
    const job_id = queued[0]?.body?.job_id;
    expect(queued[0]?.body).toEqual({ job_id, queued: true });
    for (const answer of answers.filter((a) => a !== queued[0]))
      expect(answer).toMatchObject({
        status: 200,
        body: { job_id, queued: false },
      });
    const queuedAfter = await send(admins, "POST", "/admin/sync", {});
    expect(queuedAfter.body).toEqual({ job_id, queued: false });
    const audit = await send(
      admins,
      "GET",
      "/admin/audit?action=admin.sync.start",
    );
    expect(audit.body?.events).toEqual([
      expect.objectContaining({
        resource_id: job_id,
        detail: { kind: "full" },
      }),
    ]);
  });

  it("list the sync runs newest first, parsed as the schema says", async () => {
    const admins = browser((await person("admin")).cookie);
    const started_at = new Date("2026-10-01T08:00:00Z");
    const finished_at = new Date("2026-10-01T08:05:00Z");
    const [row] = await createDb(testPool("worker_rw"))
      .insert(syncRun)
      .values({
        kind: "incremental",
        trigger: "schedule",
        status: "succeeded",
        started_at,
        finished_at,
        workspaces_scanned: 3,
        counts: { measures: 41, datasets_changed: 2 },
      })
      .returning({ id: syncRun.id });
    const listed = await send(admins, "GET", "/admin/sync?limit=1");
    expect(listed.body).toEqual({
      runs: [
        {
          id: row?.id,
          kind: "incremental",
          trigger: "schedule",
          status: "succeeded",
          started_at: started_at.toISOString(),
          finished_at: finished_at.toISOString(),
          workspaces_scanned: 3,
          counts: { measures: 41, datasets_changed: 2 },
          error: null,
        },
      ],
    });
    expect((await send(admins, "GET", "/admin/sync?limit=0")).status).toBe(400);
  });

  it("make a service account and its keys, show a key once, and revoke it", async () => {
    const admins = browser((await person("admin")).cookie);
    const name = `route_acct_${randomUUID().slice(0, 8)}`;
    const base = `/admin/service-accounts/${name}`;
    const made = await send(admins, "POST", "/admin/service-accounts", {
      name,
      owner_email: "owner@example.test",
      roles: ["viewer"],
    });
    expect(made.status, made.text).toBe(201);
    const bad = await send(admins, "POST", "/admin/service-accounts", {
      name,
      owner_email: "owner@example.test",
      roles: ["admin"],
    });
    expect(bad.status).toBe(400);
    const patched = await send(admins, "PATCH", base, {
      owner_email: "new@example.test",
    });
    expect(patched.body).toMatchObject({ owner_email: "new@example.test" });

    const created = await send(admins, "POST", `${base}/keys`, {
      expires_in_days: 30,
    });
    expect(created.status, created.text).toBe(201);
    const key = created.body?.key as string;
    expect(key).toMatch(/^pbmb_sk_/);
    const listed = await send(admins, "GET", `${base}/keys`);
    expect(listed.body).toEqual({
      keys: [expect.objectContaining({ id: created.body?.id }) as unknown],
    });
    expect(listed.text).not.toContain(key);
    expect(
      JSON.stringify((await send(admins, "GET", "/admin/audit")).body),
    ).not.toContain(key);
    expect((await send(bearer(key), "GET", "/me")).status).toBe(200);

    const off = await send(admins, "PATCH", base, { disabled: true });
    expect(off.body?.disabled_at).toEqual(expect.any(String));
    expect((await send(bearer(key), "GET", "/me")).status).toBe(401);
    expect(
      (await send(admins, "PATCH", base, { disabled: false })).body,
    ).toMatchObject({ disabled_at: null });
    expect(
      (await send(admins, "DELETE", `${base}/keys/${String(created.body?.id)}`))
        .status,
    ).toBe(204);
    expect((await send(bearer(key), "GET", "/me")).status).toBe(401);
    expect((await send(admins, "PATCH", base, {})).status).toBe(400);
    expect((await send(admins, "DELETE", base)).status).toBe(204);
    expect((await send(admins, "DELETE", base)).status).toBe(404);
  });

  it("let an admin end another person's grant, and say whose it was in the audit", async () => {
    const admins = browser((await person("admin")).cookie);
    const other = await person("viewer");
    await oauth.connect(other.cookie, oauth.client());
    const grants = await send(browser(other.cookie), "GET", "/me/grants");
    const [grant] = grants.body?.grants as { id: string }[];
    expect(grant).toBeDefined();
    const listedFor = await send(admins, "GET", "/admin/people");
    const them = (
      listedFor.body?.people as { id: string; grants: unknown[] }[]
    ).find((p) => p.id === other.id);
    expect(them?.grants).toEqual([
      expect.objectContaining({
        id: grant?.id,
        via: "mcp",
        last_used_at: null,
      }) as unknown,
    ]);
    const viewer = await send(browser(other.cookie), "GET", "/admin/people");
    expect(viewer.status).toBe(403);
    expect(viewer.text).not.toContain("grants");
    const revoked = await send(
      admins,
      "DELETE",
      `/admin/grants/${grant?.id ?? ""}`,
    );
    expect(revoked.status, revoked.text).toBe(204);
    expect(
      (await send(browser(other.cookie), "GET", "/me/grants")).body,
    ).toEqual({ grants: [] });
    expect(
      (await send(admins, "DELETE", `/admin/grants/${grant?.id ?? ""}`)).status,
    ).toBe(404);
    const audit = await send(
      admins,
      "GET",
      "/admin/audit?action=admin.connection.revoke",
    );
    expect(audit.body?.events).toEqual([
      expect.objectContaining({
        resource_id: grant?.id,
        detail: expect.objectContaining({ user_id: other.id }) as unknown,
      }),
    ]);
  });

  it("export without a secret or a key, and show an import's difference before applying it", async () => {
    const admins = browser((await person("admin")).cookie);
    const exported = await send(admins, "GET", "/admin/export");
    expect(exported.status, exported.text).toBe(200);
    expect(exported.body?.yaml).toEqual(expect.stringContaining("format: 1"));
    const dry = await send(admins, "POST", "/admin/import", { yaml: BOOK });
    expect(dry.body).toMatchObject({
      applied: false,
      changes: [{ path: "settings.results.ttl_hours", after: 48 }],
    });
    expect(
      (await send(admins, "GET", "/admin/settings/results.ttl_hours")).body,
    ).not.toMatchObject({ value: 48 });
    const applied = await send(admins, "POST", "/admin/import", {
      yaml: BOOK,
      apply: true,
    });
    expect(applied.body).toMatchObject({ applied: true });
    expect(
      (await send(admins, "GET", "/admin/settings/results.ttl_hours")).body,
    ).toMatchObject({ value: 48 });
    expect(
      (await send(admins, "POST", "/admin/import", { yaml: "{" })).status,
    ).toBe(400);
  });

  it("hold the value of a secret in no answer an admin can read", async () => {
    const admins = browser((await person("admin")).cookie);
    await send(admins, "PUT", "/admin/secrets/gemini_api_key", {
      value: SECRET,
    });
    const reads = [
      "/admin/settings/results.ttl_hours",
      "/admin/secrets",
      "/admin/status",
      "/admin/roles",
      "/admin/people",
      "/admin/sync",
      "/admin/service-accounts",
      "/admin/audit?limit=500",
      "/admin/export",
    ];
    for (const path of reads) {
      const answer = await send(admins, "GET", path);
      expect(answer.status, path).toBe(200);
      expect(answer.text, path).not.toContain(SECRET);
    }
    const dry = await send(admins, "POST", "/admin/import", { yaml: BOOK });
    expect(dry.text).not.toContain(SECRET);
  });
});

it("removes cached workspace names when personal sync is disabled through admin settings", async () => {
  const admins = browser((await person("admin")).cookie);
  for (const value of [true, false]) {
    await storeCheck(oauth.deps, "what_to_sync", {
      status: "passing",
      message: null,
      details: {
        workspaces: [
          {
            id: randomUUID(),
            name: "Private sample workspace",
            personal: true,
          },
        ],
        personal_count: 1,
        truncated: false,
      },
    });
    const response = await send(
      admins,
      "PUT",
      "/admin/settings/powerbi.sync.workspaces.personal",
      { value },
    );
    expect(response.status).toBe(200);
    const rows = await oauth.deps.db
      .select()
      .from(settingCheck)
      .where(eq(settingCheck.key, "what_to_sync"));
    expect(rows).toHaveLength(value ? 1 : 0);
  }
});
