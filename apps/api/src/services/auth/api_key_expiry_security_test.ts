import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { asRole } from "../../../test/db-roles.js";
import {
  cerbosAccess,
  closeTestPools,
  createTestDeps,
  principals,
  testPool,
} from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import { createApp } from "../../app.js";
import {
  createKey,
  createServiceAccount,
  updateServiceAccount,
} from "./service-accounts.js";

/*
 * An API key lives at most 90 days: the database refuses a longer one,
 * whoever writes it. The api also stops a key older than its account's
 * max_key_age_days as the limit stands now, so lowering it takes effect at
 * once. Both count on the database's clock.
 */

afterAll(closeTestPools);

const deps = createTestDeps({ access: cerbosAccess(new MemorySettings()) });
const app = createApp(deps);
const admin = { ...deps, principal: principals.admin };
const run = randomUUID().slice(0, 8);

const me = (key: string) =>
  app.request("/api/v1/me", { headers: { authorization: `Bearer ${key}` } });

/** A key and its account, as an admin makes them. */
async function keyFor(name: string, max_key_age_days: number, days: number) {
  await createServiceAccount(admin, {
    name,
    owner_email: "owner@example.test",
    roles: ["viewer"],
    max_key_age_days,
  });
  return createKey(admin, name, { expires_in_days: days });
}

/** Moves a key's dates back, as the owner of the table; api_rw may not. */
async function age(id: string, days: number): Promise<void> {
  await testPool("migrator").query(
    `update service_account_key
     set created_at = created_at - make_interval(days => $2),
       expires_at = expires_at - make_interval(days => $2)
     where id = $1`,
    [id, days],
  );
}

/** One statement as api_rw after making an account, rolled back. */
function asApi(statement: string) {
  return asRole(
    "api_rw",
    `with account as (
       insert into service_account (name, owner_email, created_by)
       values ('exp_${run}_' || floor(random() * 1e9)::text, 'o@example.test', 'test')
       returning name)
     ${statement}`,
  );
}

/** A key row from the account above, with these extra columns. */
const keyWith = (columns: string, values: string) =>
  `insert into service_account_key
     (service_account, prefix, digest, created_by, ${columns})
   select name, 'abcdefgh', sha256(random()::text::bytea), 'test', ${values}
   from account`;

describe("API key expiry", () => {
  it("refuses a key once it has expired", async () => {
    const { key, id } = await keyFor(`exp_${run}`, 90, 1);
    expect((await me(key)).status).toBe(200);
    await age(id, 2);
    expect((await me(key)).status).toBe(401);
  });

  it("is refused by the database past 90 days, and created_at is the database's to set", async () => {
    await expect(
      asApi(keyWith("expires_at", "now() + interval '90 days'")),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(
      asApi(keyWith("expires_at", "now() + interval '90 days 1 second'")),
    ).rejects.toMatchObject({ constraint: "service_account_key_expiry" });
    // Dated ahead, a key would pass the check and outlive 90 days.
    await expect(
      asApi(
        keyWith(
          "created_at, expires_at",
          "now() + interval '365 days', now() + interval '400 days'",
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("stops a key older than its account's max_key_age_days once that is lowered", async () => {
    const name = `exp_${run}_short`;
    const { key, id } = await keyFor(name, 30, 30);
    await age(id, 10);
    expect((await me(key)).status).toBe(200);
    await updateServiceAccount(admin, name, { max_key_age_days: 7 });
    expect((await me(key)).status).toBe(401);
    for (const expires_in_days of [8, 0, 1.5])
      await expect(
        createKey(admin, name, { expires_in_days }),
      ).rejects.toMatchObject({ kind: "invalid" });
    await expect(keyFor(`exp_${run}_long`, 91, 1)).rejects.toMatchObject({
      kind: "invalid",
    });
  });
});
