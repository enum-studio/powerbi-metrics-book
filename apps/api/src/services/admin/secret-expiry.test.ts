import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cerbosAccess,
  closeTestPools,
  createTestDeps,
  principals,
  TEST_PUBLIC_BASE_URL,
  testConfig,
  testPool,
} from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import { publishedIdentities } from "../../../test/secrets-support.js";
import { createApp } from "../../app.js";
import { createDb } from "../../db/client.js";
import { settingCheck } from "../../db/schema/admin.js";
import { user } from "../../db/schema/auth.js";
import { powerbiConnection } from "../../db/schema/connection.js";
import { syncRun } from "../../db/schema/mirror.js";
import { secret } from "../../db/schema/secrets.js";
import { assignRole } from "../auth/roles.js";
import { registerCheck } from "./checks.js";
import { setSecret } from "./secrets.js";
import { adminStatus } from "./status.js";

// Entra client secrets expire; 30 days and again 7 days before, the admin
// status and every admin's /api/v1/me warn (spec, Settings and secrets).

afterAll(closeTestPools);

const NOW = new Date("2026-10-25T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const deps = createTestDeps({
  access: cerbosAccess(new MemorySettings()),
  config: testConfig("api", { ALLOW_DEV_SIGN_IN: "1" }),
  clock: () => NOW,
});
const admin = { ...deps, principal: principals.admin };
const app = createApp(deps);
const VALUE = "secret-value-never-shown-0001";
const emailOf = (role: string) => `expiry-${role}@example.test`;

async function signedIn(email: string): Promise<string> {
  const response = await app.request("/api/auth/dev/sign-in", {
    method: "POST",
    headers: {
      origin: TEST_PUBLIC_BASE_URL,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email }),
  });
  expect(response.status).toBe(200);
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

beforeAll(async () => {
  await publishedIdentities(deps.db);
  registerCheck("powerbi_scanner_client_secret", () =>
    Promise.resolve({ status: "failing", message: "Entra refused it." }),
  );
  const expiring = {
    openai_api_key: 40,
    powerbi_app_client_secret: 20,
    powerbi_scanner_client_secret: 5,
  };
  for (const [name, days] of Object.entries(expiring))
    await setSecret(admin, name, VALUE, {
      expires_at: new Date(NOW.getTime() + days * DAY),
    });
  for (const role of ["admin", "viewer"])
    await assignRole(
      deps.db,
      { role, subject_kind: "person", subject: emailOf(role) },
      principals.admin,
    );
});

describe("secret expiry warnings", () => {
  it("lists in adminStatus the secrets expiring within 30 days, urgent within 7", async () => {
    const status = await adminStatus(admin);
    expect(status.secrets_expiring).toEqual([
      expect.objectContaining({
        name: "powerbi_scanner_client_secret",
        days_left: 5,
        urgent: true,
      }),
      expect.objectContaining({
        name: "powerbi_app_client_secret",
        days_left: 20,
        urgent: false,
      }),
    ]);
    expect(JSON.stringify(status)).not.toContain(VALUE);
  });

  it("warns whoever manages secrets in /api/v1/me, and nobody else", async () => {
    const asAdmin = await app.request("/api/v1/me", {
      headers: { cookie: await signedIn(emailOf("admin")) },
    });
    const body: unknown = await asAdmin.json();
    expect(JSON.stringify(body)).not.toContain(VALUE);
    expect(body).toMatchObject({
      warnings: [
        "The scanner registration's client secret expires in 5 days, on 2026-10-30. Enter a new one in the admin section now.",
        "The app registration's client secret expires in 20 days, on 2026-11-14. Enter a new one in the admin section.",
      ],
    });
    const asViewer = await app.request("/api/v1/me", {
      headers: { cookie: await signedIn(emailOf("viewer")) },
    });
    expect(await asViewer.json()).toMatchObject({ warnings: [] });
  });
});

describe("adminStatus", () => {
  it("shows the last sync, failing checks, connections to remake, version and sha", async () => {
    const worker = createDb(testPool("worker_rw"));
    for (const started_at of [new Date(NOW.getTime() - DAY), NOW])
      await worker.insert(syncRun).values({
        kind: "full",
        trigger: "manual",
        status: "failed",
        started_at,
        error: "The scan failed.",
      });
    const [viewer] = await deps.db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, emailOf("viewer")));
    if (viewer === undefined) throw new Error("the viewer signed in above");
    await deps.db.insert(powerbiConnection).values({
      user_id: viewer.id,
      microsoft_object_id: randomUUID(),
      status: "needs_reconnect",
      connected_at: NOW,
    });
    const shared = {
      connections_needing_reconnect: 1,
      version: expect.any(String) as unknown,
      git_sha: deps.config.git_sha,
    };
    expect(await adminStatus(admin)).toMatchObject({
      ...shared,
      last_sync: { kind: "full", status: "failed", error: "The scan failed." },
      failing_checks: expect.arrayContaining([
        expect.objectContaining({
          name: "powerbi_scanner_client_secret",
          message: "Entra refused it.",
        }),
      ]) as unknown,
      people_to_reconnect: [{ user_id: viewer.id, email: emailOf("viewer") }],
    });
    // A read-only caller (here a service account whose role a deployment
    // gave read_status) gets names, dates and a count, never the detail.
    const reader = {
      ...principals.admin,
      kind: "service_account" as const,
      roles: ["integration"],
    };
    const access = cerbosAccess(new MemorySettings(), "override");
    const at = (days: number) => new Date(NOW.getTime() + days * DAY);
    const read = await adminStatus({ ...deps, access, principal: reader });
    expect(read.failing_checks).toContainEqual({
      name: "powerbi_scanner_client_secret",
    });
    for (const check of read.failing_checks)
      expect(Object.keys(check)).toEqual(["name"]);
    expect({ ...read, failing_checks: [] }).toEqual({
      ...shared,
      last_sync: { status: "failed", started_at: NOW, finished_at: null },
      failing_checks: [],
      secrets_expiring: [
        { name: "powerbi_scanner_client_secret", expires_at: at(5) },
        { name: "powerbi_app_client_secret", expires_at: at(20) },
      ],
    });
  });

  it("lists a stored failing check, but not an agent yet to sign in or the checklist as one line", async () => {
    await deps.db.insert(settingCheck).values(
      ["agents", "security", "powerbi.tenant"].map((key) => ({
        key,
        status: "failing" as const,
        message: `${key} failed.`,
        checked_at: NOW,
      })),
    );
    const names = (await adminStatus(admin)).failing_checks.map(
      (check) => check.name,
    );
    expect(names).toContain("powerbi.tenant");
    expect(names).not.toContain("agents");
    expect(names).not.toContain("security");
  });

  it("reads the checklist fresh, so a date just entered clears its line at once", async () => {
    const line = "expiry_powerbi_scanner_client_secret";
    const names = async () =>
      (await adminStatus(admin)).failing_checks.map((check) => check.name);
    await deps.db
      .update(secret)
      .set({ expires_at: null })
      .where(eq(secret.name, "powerbi_scanner_client_secret"));
    expect(await names()).toContain(line);
    expect(
      (await adminStatus(admin)).failing_checks.find(
        (check) => check.name === line,
      ),
    ).toMatchObject({
      message:
        "The scanner registration's client secret has no expiry date. Enter the date Entra shows, so you are warned before it expires.",
    });
    // A read-only caller reads that the checklist has something to fix, not what.
    const read = await adminStatus({
      ...deps,
      access: cerbosAccess(new MemorySettings(), "override"),
      principal: {
        ...principals.admin,
        kind: "service_account" as const,
        roles: ["integration"],
      },
    });
    expect(read.failing_checks).toContainEqual({ name: "security" });
    expect(read.failing_checks).not.toContainEqual({ name: line });
    await deps.db
      .update(secret)
      .set({ expires_at: new Date(NOW.getTime() + 100 * DAY) })
      .where(eq(secret.name, "powerbi_scanner_client_secret"));
    expect(await names()).not.toContain(line);
  });

  it("still answers when the identity folder cannot be read, and names that item", async () => {
    const answer = await adminStatus({
      ...admin,
      config: {
        ...deps.config,
        age_identity: null,
        identity_dir: `${import.meta.filename}/inside`,
      },
    });
    expect(answer.failing_checks).toContainEqual(
      expect.objectContaining({
        name: "identity_volume_private",
        message:
          "The api could not read IDENTITY_DIR, so it cannot say who else can. The api's log has the reason.",
      }),
    );
  });

  it("is refused to a curator", async () => {
    await expect(
      adminStatus({ ...deps, principal: principals.curator }),
    ).rejects.toMatchObject({ kind: "refused" });
  });
});
