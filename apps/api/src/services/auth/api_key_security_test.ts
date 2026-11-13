import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { asRole } from "../../../test/db-roles.js";
import {
  cerbosAccess,
  closeTestPools,
  createTestDeps,
  principals,
  testConfig,
  testPool,
} from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import { createApp } from "../../app.js";
import {
  API_KEY_PREFIX,
  createKey,
  createServiceAccount,
  deleteServiceAccount,
  disableServiceAccount,
  revokeKey,
  type ServiceAccountInput,
  updateServiceAccount,
} from "./service-accounts.js";

/*
 * An API key works on /api/v1 only, while it is live, its account enabled,
 * and the request comes from where the account allows; the database keeps
 * no key in clear. A service account never administers, and never passes
 * for a person.
 */

afterAll(closeTestPools);

const PROXY = "10.20.30.1";
const deps = createTestDeps({
  access: cerbosAccess(new MemorySettings()),
  config: testConfig("api", { TRUSTED_PROXY: PROXY }),
});
const app = createApp(deps);
const admin = { ...deps, principal: principals.admin };
const run = randomUUID().slice(0, 8);
let made = 0;

async function accountWithKey(input: Partial<ServiceAccountInput> = {}) {
  made += 1;
  const name = `sec_${run}_${String(made)}`;
  await createServiceAccount(admin, {
    name,
    owner_email: "owner@example.test",
    roles: ["viewer"],
    ...input,
  });
  const { key, id } = await createKey(admin, name, { expires_in_days: 30 });
  return { name, key, id };
}

function call(
  key: string,
  options: { path?: string; peer?: string; forwarded?: string } = {},
) {
  const headers: Record<string, string> = { authorization: `Bearer ${key}` };
  if (options.forwarded !== undefined)
    headers["x-forwarded-for"] = options.forwarded;
  return app.request(
    options.path ?? "/api/v1/me",
    { headers },
    options.peer === undefined
      ? undefined
      : { incoming: { socket: { remoteAddress: options.peer } } },
  );
}

describe("API keys", () => {
  it("refuses a key whose digest is in the table but whose revoked_at is set", async () => {
    const { name, key, id } = await accountWithKey();
    expect((await call(key)).status).toBe(200);
    await revokeKey(admin, name, id);
    const refused = await call(key);
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toMatch(
      /error="invalid_token"/,
    );
  });

  it("refuses every key of a disabled account, and of a deleted one", async () => {
    const disabled = await accountWithKey();
    const second = await createKey(admin, disabled.name, {
      expires_in_days: 1,
    });
    await disableServiceAccount(admin, disabled.name);
    expect((await call(disabled.key)).status).toBe(401);
    expect((await call(second.key)).status).toBe(401);
    const deleted = await accountWithKey();
    await deleteServiceAccount(admin, deleted.name);
    expect((await call(deleted.key)).status).toBe(401);
  });

  it("is refused on /api/mcp, where it would otherwise pass the gate", async () => {
    const { key } = await accountWithKey();
    expect((await call(key)).status).toBe(200);
    expect((await call(key, { path: "/api/mcp" })).status).toBe(401);
  });

  it("refuses a request from outside source_cidrs, reading X-Forwarded-For only from TRUSTED_PROXY", async () => {
    const { key } = await accountWithKey({ source_cidrs: ["203.0.113.0/24"] });
    expect((await call(key, { peer: "203.0.113.9" })).status).toBe(200);
    expect(
      (await call(key, { peer: PROXY, forwarded: "203.0.113.9" })).status,
    ).toBe(200);
    expect((await call(key, { peer: "198.51.100.7" })).status).toBe(401);
    expect(
      (await call(key, { peer: "198.51.100.7", forwarded: "203.0.113.9" }))
        .status,
    ).toBe(401);
    expect(
      (await call(key, { peer: PROXY, forwarded: "198.51.100.7" })).status,
    ).toBe(401);
    // No connection to read an address from is not inside the range.
    expect((await call(key)).status).toBe(401);
  });

  it("keeps no key in clear in any column, nor in the audit", async () => {
    const { name, key, id } = await accountWithKey();
    await revokeKey(admin, name, id);
    // Each row as Postgres prints it: text as written, bytea in hex.
    const { rows } = await testPool("migrator").query<{ row: string }>(
      `select k::text as row from service_account_key k where k.service_account = $1
       union all select e::text from audit_event e where e.resource_id = $1`,
      [name],
    );
    const stored = rows.map((row) => row.row).join("\n");
    expect(stored).toContain(id);
    const secret = key.slice(API_KEY_PREFIX.length);
    for (const form of [
      secret,
      Buffer.from(key).toString("hex"),
      Buffer.from(secret, "base64url").toString("hex"),
    ])
      expect(stored).not.toContain(form);
  });

  it("lets only an admin make a service account or a key", async () => {
    const { name } = await accountWithKey();
    for (const principal of [principals.viewer, principals.curator]) {
      const context = { ...deps, principal };
      await expect(
        createServiceAccount(context, {
          name: `${name}_x`,
          owner_email: "owner@example.test",
          roles: ["admin"],
        }),
      ).rejects.toMatchObject({ kind: "refused" });
      await expect(
        createKey(context, name, { expires_in_days: 1 }),
      ).rejects.toMatchObject({ kind: "refused" });
    }
  });

  it("is refused a person's grants and Power BI connection", async () => {
    const { key } = await accountWithKey();
    for (const [method, path] of [
      ["GET", "/api/v1/me/grants"],
      ["DELETE", `/api/v1/me/grants/${randomUUID()}`],
      ["DELETE", "/api/v1/powerbi/connection"],
    ] as const) {
      const response = await app.request(path, {
        method,
        headers: { authorization: `Bearer ${key}` },
      });
      expect(response.status, path).toBe(403);
    }
  });
});

describe("service accounts", () => {
  it("never hold admin, nor a malformed role: the database refuses it", async () => {
    const insert = (roles: (string | null)[]) =>
      asRole(
        "api_rw",
        `insert into service_account (name, owner_email, created_by, roles)
         values ($1, 'owner@example.test', 'test', $2)`,
        [`roles_${run}`, roles],
      );
    for (const roles of [[], ["viewer", "curator"], ["analyst_2"]])
      await expect(insert(roles)).resolves.toMatchObject({ rowCount: 1 });
    for (const roles of [
      ["admin"],
      ["viewer", "admin"],
      ["pii_reader"],
      ["viewer", "pii_reader"],
      ["none"],
      ["Viewer"],
      [""],
      ["viewer,admin"],
      ['viewer","admin'],
      ["viewer", null],
    ])
      await expect(insert(roles), JSON.stringify(roles)).rejects.toMatchObject({
        constraint: "service_account_roles",
      });
    await expect(
      createServiceAccount(admin, {
        name: `roles_${run}`,
        owner_email: "owner@example.test",
        roles: ["admin"],
      }),
    ).rejects.toMatchObject({ kind: "invalid" });
  });

  it("refuses source_cidrs while TRUSTED_PROXY is not set, naming it", async () => {
    const unproxied = { ...admin, config: testConfig("api") };
    const input = {
      name: `unproxied_${run}`,
      owner_email: "owner@example.test",
      roles: ["viewer"],
      source_cidrs: ["203.0.113.0/24"],
    };
    await expect(createServiceAccount(unproxied, input)).rejects.toMatchObject({
      kind: "invalid",
      message: expect.stringContaining("TRUSTED_PROXY") as unknown,
    });
    const { name } = await accountWithKey();
    await expect(
      updateServiceAccount(unproxied, name, { source_cidrs: ["10.0.0.0/8"] }),
    ).rejects.toMatchObject({ kind: "invalid" });
  });

  it("refuses source_cidrs under CLIENT_ADDRESS_HEADER=x-real-ip, a header nobody verified", async () => {
    const edge = {
      ...admin,
      config: testConfig("api", { CLIENT_ADDRESS_HEADER: "x-real-ip" }),
    };
    const input = {
      name: `edge_${run}`,
      owner_email: "owner@example.test",
      roles: ["viewer"],
      source_cidrs: ["203.0.113.0/24"],
    };
    await expect(createServiceAccount(edge, input)).rejects.toMatchObject({
      kind: "invalid",
      message: expect.stringContaining("x-real-ip") as unknown,
    });
    const { name } = await accountWithKey();
    await expect(
      updateServiceAccount(edge, name, { source_cidrs: ["10.0.0.0/8"] }),
    ).rejects.toMatchObject({ kind: "invalid" });
  });
});
