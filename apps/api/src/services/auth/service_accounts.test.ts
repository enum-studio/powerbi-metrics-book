import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import {
  cerbosAccess,
  closeTestPools,
  createTestDeps,
  principals,
  testConfig,
} from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import type { AppEnv } from "../../app.js";
import { createApp } from "../../app.js";
import { request, searchLog } from "../../db/schema/usage.js";
import { auditEvent } from "../../db/schema/audit.js";
import { createAuth } from "./better-auth.js";
import { authenticate } from "./principal.js";
import {
  createKey,
  createServiceAccount,
  deleteServiceAccount,
  disableServiceAccount,
  enableServiceAccount,
  listKeys,
  listServiceAccounts,
  revokeKey,
  updateServiceAccount,
} from "./service-accounts.js";

afterAll(closeTestPools);

let now = new Date();
const deps = createTestDeps({
  access: cerbosAccess(new MemorySettings()),
  config: testConfig("api", { TRUSTED_PROXY: "10.20.30.1" }),
  clock: () => now,
});
const admin = { ...deps, principal: principals.admin };
const run = randomUUID().slice(0, 8);
const WORKSPACE = randomUUID();
const APP = randomUUID();

async function account(suffix: string) {
  const name = `sa_${run}_${suffix}`;
  await createServiceAccount(admin, {
    name,
    owner_email: "owner@example.test",
    roles: ["viewer"],
    workspace_ids: [WORKSPACE],
  });
  return name;
}

const bearer = (key: string) => ({
  headers: { authorization: `Bearer ${key}` },
});

describe("service accounts", () => {
  it("makes, changes, lists and ends an account and its keys, auditing each change", async () => {
    const name = await account("life");
    const changed = await updateServiceAccount(admin, name, {
      roles: ["curator"],
      app_ids: [APP],
      source_cidrs: ["10.0.0.0/8"],
    });
    expect(changed).toMatchObject({
      roles: ["curator"],
      workspace_ids: [WORKSPACE],
      app_ids: [APP],
      source_cidrs: ["10.0.0.0/8"],
      max_key_age_days: 90,
      disabled_at: null,
      created_by: principals.admin.id,
    });
    const { key, ...made } = await createKey(admin, name, {
      expires_in_days: 30,
    });
    expect(key).toMatch(/^pbmb_sk_[A-Za-z0-9_-]{43}$/);
    expect(made.prefix).toBe(key.slice(8, 16));
    await revokeKey(admin, name, made.id);
    expect(await listKeys(admin, name)).toEqual([{ ...made, revoked_at: now }]);
    expect((await listServiceAccounts(admin)).map((row) => row.name)).toContain(
      name,
    );
    await disableServiceAccount(admin, name);
    await expect(
      createKey(admin, name, { expires_in_days: 1 }),
    ).rejects.toMatchObject({ kind: "conflict" });
    await enableServiceAccount(admin, name);
    await deleteServiceAccount(admin, name);
    await expect(listKeys(admin, name)).rejects.toMatchObject({
      kind: "not_found",
    });
    const audited = await deps.db
      .select({ action: auditEvent.action, detail: auditEvent.detail })
      .from(auditEvent)
      .where(eq(auditEvent.resource_id, name))
      .orderBy(asc(auditEvent.id));
    expect(audited.map((event) => event.action)).toEqual([
      "service_account.create",
      "service_account.update",
      "service_account.create_key",
      "service_account.revoke_key",
      "service_account.disable",
      "service_account.enable",
      "service_account.delete",
    ]);
    expect(audited[2]?.detail).toEqual({
      key_id: made.id,
      expires_at: made.expires_at.toISOString(),
    });
  });

  it("refuses pii_reader to a service account, made or changed", async () => {
    const name = await account("pii");
    await expect(
      createServiceAccount(admin, {
        name: `sa_${run}_pii2`,
        owner_email: "owner@example.test",
        roles: ["viewer", "pii_reader"],
      }),
    ).rejects.toMatchObject({
      kind: "invalid",
      message: expect.stringContaining("pii_reader") as string,
    });
    await expect(
      updateServiceAccount(admin, name, { roles: ["pii_reader"] }),
    ).rejects.toMatchObject({ kind: "invalid" });
  });

  it("answers a taken name as a conflict and a malformed one as invalid", async () => {
    const name = await account("taken");
    await expect(account("taken")).rejects.toMatchObject({ kind: "conflict" });
    for (const input of [
      { name: `Sa_${run}` },
      { name: `sa_${run}_cidr`, source_cidrs: ["10.0.0.1/8"] },
    ])
      await expect(
        createServiceAccount(admin, {
          owner_email: "owner@example.test",
          roles: [],
          ...input,
        }),
      ).rejects.toMatchObject({ kind: "invalid" });
    await expect(revokeKey(admin, name, randomUUID())).rejects.toMatchObject({
      kind: "not_found",
    });
    // Fields beside the named ones never reach the row.
    const smuggled = { roles: ["curator"], created_by: "someone", name: "x" };
    expect(await updateServiceAccount(admin, name, smuggled)).toMatchObject({
      name,
      roles: ["curator"],
      created_by: principals.admin.id,
    });
  });
});

describe("authenticating with an API key", () => {
  const auth = createAuth(deps);
  const echo = new Hono<AppEnv>()
    .use(authenticate(deps, auth, false))
    .get("/api/v1/principal", (c) => c.json(c.get("principal") ?? null));

  it("builds a service_account principal with the account's roles and grants, via api", async () => {
    const name = await account("who");
    await updateServiceAccount(admin, name, { app_ids: [APP] });
    const { key } = await createKey(admin, name, { expires_in_days: 1 });
    const response = await echo.request("/api/v1/principal", bearer(key));
    expect(await response.json()).toEqual({
      kind: "service_account",
      id: name,
      roles: ["viewer"],
      attributes: {
        powerbi_workspace_ids: [WORKSPACE],
        powerbi_app_ids: [APP],
        powerbi_dataset_ids: [],
      },
      via: "api",
      client_id: null,
    });
  });

  it("lets a key made before a disable work again after enable", async () => {
    const name = await account("back");
    const { key } = await createKey(admin, name, { expires_in_days: 1 });
    const who = async () =>
      (await echo.request("/api/v1/principal", bearer(key))).json();
    await disableServiceAccount(admin, name);
    expect(await who()).toBeNull();
    await enableServiceAccount(admin, name);
    expect(await who()).toMatchObject({ id: name });
  });

  it("notes last_used_at at most once a minute", async () => {
    const name = await account("used");
    const { key, id } = await createKey(admin, name, { expires_in_days: 1 });
    const lastUsed = async (at: Date) => {
      now = at;
      await echo.request("/api/v1/principal", bearer(key));
      const [shown] = (await listKeys(admin, name)).filter(
        (row) => row.id === id,
      );
      return shown?.last_used_at;
    };
    const first = new Date();
    expect(await lastUsed(first)).toEqual(first);
    expect(await lastUsed(new Date(first.getTime() + 59_000))).toEqual(first);
    const later = new Date(first.getTime() + 60_001);
    expect(await lastUsed(later)).toEqual(later);
    now = new Date();
  });

  it("refuses one account's requests past service_accounts.rate_per_minute with 429, read on each request", async () => {
    const settings = new MemorySettings({
      "service_accounts.rate_per_minute": 3,
    });
    const app = createApp({ ...deps, settings });
    const name = await account("busy");
    const { key } = await createKey(admin, name, { expires_in_days: 1 });
    const statuses: number[] = [];
    for (let n = 0; n < 4; n += 1)
      statuses.push((await app.request("/api/v1/me", bearer(key))).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    await settings.set("service_accounts.rate_per_minute", 10);
    expect((await app.request("/api/v1/me", bearer(key))).status).toBe(200);
    const other = await createKey(admin, await account("calm"), {
      expires_in_days: 1,
    });
    expect((await app.request("/api/v1/me", bearer(other.key))).status).toBe(
      200,
    );
  });
});

it("deletes service account usage without deleting a person with the same id", async () => {
  const owner = await account("usage");
  const ids = [];
  for (const principal of [
    { principal_kind: "service_account" as const, principal_id: owner },
    { principal_kind: "person" as const, principal_id: owner },
  ]) {
    const row = {
      id: randomUUID(),
      at: deps.clock(),
      via: "mcp" as const,
      ...principal,
    };
    ids.push(row.id);
    await deps.auditDb
      .insert(request)
      .values({ ...row, question: "Sample question", outcome: "answered" });
    await deps.auditDb.insert(searchLog).values({
      ...row,
      query: "Sample search",
      search_mode: "words_only",
      hit_count: 0,
      metric_hit: false,
    });
  }
  await deleteServiceAccount(admin, owner);
  for (const table of [request, searchLog]) {
    expect(
      await deps.db
        .select({ id: table.id })
        .from(table)
        .where(eq(table.id, ids[0] ?? "")),
    ).toEqual([]);
    expect(
      await deps.db
        .select({ id: table.id })
        .from(table)
        .where(eq(table.id, ids[1] ?? "")),
    ).toHaveLength(1);
    await deps.db.delete(table).where(eq(table.id, ids[1] ?? ""));
  }
});
