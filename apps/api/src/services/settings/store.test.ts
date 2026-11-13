import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { inRollback } from "../../../test/database.js";
import { closeTestPools, principals, testPool } from "../../../test/deps.js";
import { OKTA_PROVIDER } from "../../../test/settings-fixture.js";
import * as schema from "../../db/schema/index.js";
import { ServiceError } from "../../errors.js";
import { SETTING_KEYS, SETTINGS } from "./registry.js";
import { createSettingsStore } from "./store.js";

afterAll(closeTestPools);

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";

/** The store over the real database as api_rw, in a transaction that is rolled back, so tests share the database. */
function withStore<T>(
  environment: Record<string, string | undefined>,
  work: (
    store: ReturnType<typeof createSettingsStore>,
    client: pg.PoolClient,
  ) => Promise<T>,
): Promise<T> {
  return inRollback(testPool("api_rw"), (client) =>
    work(createSettingsStore(drizzle({ client, schema }), environment), client),
  );
}

/** The ServiceError a call is refused with, typed so its fields can be read. */
async function refusal(call: Promise<unknown>): Promise<ServiceError> {
  const outcome: unknown = await call.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(outcome instanceof ServiceError))
    throw new Error("the call was not refused with a ServiceError");
  return outcome;
}

describe("the environment", () => {
  it("wins over the database and refuses a change", async () => {
    await withStore({ POWERBI_TENANT_ID: TENANT }, async (store) => {
      expect(await store.get("powerbi.tenant_id")).toBe(TENANT);
      expect(await store.source("powerbi.tenant_id")).toBe("environment");
      const refused = await refusal(
        store.set("powerbi.tenant_id", OTHER_TENANT, principals.admin),
      );
      expect(refused.kind).toBe("conflict");
      expect(refused.message).toContain("set by the environment");
      expect(refused.message).toContain("POWERBI_TENANT_ID");
      expect(await store.get("powerbi.tenant_id")).toBe(TENANT);
    });
  });

  it("wins over a value saved before the variable was set, without reading it", async () => {
    await withStore({}, async (store, client) => {
      await store.set("powerbi.tenant_id", OTHER_TENANT, principals.admin);
      const db = drizzle({ client, schema });
      const select = vi.spyOn(db, "select");
      const overridden = createSettingsStore(db, {
        POWERBI_TENANT_ID: TENANT,
      });
      expect(await overridden.get("powerbi.tenant_id")).toBe(TENANT);
      expect(select).not.toHaveBeenCalled();
    });
  });

  it("stops the store being built when a variable is malformed, naming it", async () => {
    await expect(
      withStore({ RESULTS_TTL_HOURS: "soon" }, () => Promise.resolve()),
    ).rejects.toThrow(/^RESULTS_TTL_HOURS is not valid/);
  });
});

describe("a setting nobody set", () => {
  it("answers its default and says so", async () => {
    await withStore({}, async (store) => {
      expect(await store.get("powerbi.authority")).toBe(
        "https://login.microsoftonline.com",
      );
      expect(await store.get("powerbi.sync.workspaces.include")).toBe("all");
      expect(await store.source("powerbi.authority")).toBe("default");
    });
  });
});

describe("a saved value the registry has since tightened", () => {
  it("is refused on read, naming the key, rather than answered", async () => {
    await withStore({}, async (store, client) => {
      // Written around the store, as an older registry would have allowed it.
      await client.query(
        "insert into setting (key, value, set_by) values ('results.ttl_hours', '0', 'someone')",
      );
      await expect(store.get("results.ttl_hours")).rejects.toThrow(
        /saved value of results\.ttl_hours is no longer valid/,
      );
    });
  });
});

describe("a read by key", () => {
  it("never looks a row up through the key's index, which a moved collation can leave stale", async () => {
    const statements: string[] = [];
    await inRollback(testPool("api_rw"), async (client) => {
      const logged = drizzle({
        client,
        schema,
        logger: { logQuery: (query) => statements.push(query) },
      });
      const store = createSettingsStore(logged, {});
      await store.set("access.default_role", "none", principals.admin);
      statements.length = 0;
      expect(await store.get("access.default_role")).toBe("none");
      expect(await store.source("access.default_role")).toBe("database");
    });
    expect(statements).toHaveLength(2);
    for (const statement of statements)
      expect(statement).not.toMatch(/\bwhere\b/i);
  });
});

describe("a key saved twice while its index was stale", () => {
  it("answers the newest row, whichever the table lists first", async () => {
    await inRollback(testPool("migrator"), async (client) => {
      await client.query("alter table setting drop constraint setting_pkey");
      const insert = (value: string, set_at: string) =>
        client.query(
          "insert into setting (key, value, set_by, set_at) values ('access.default_role', $1::jsonb, $2, $3)",
          [JSON.stringify(value), principals.admin.id, set_at],
        );
      await insert("viewer", "2026-01-01T00:00:00Z");
      await insert("none", "2026-02-01T00:00:00Z");
      await insert("viewer", "2025-12-01T00:00:00Z");
      const store = createSettingsStore(drizzle({ client, schema }), {});
      expect(await store.get("access.default_role")).toBe("none");
      const listed = (await store.list()).find(
        (entry) => entry.key === "access.default_role",
      );
      expect(listed?.value).toBe("none");
    });
  });
});

describe("set", () => {
  it("saves a value, answers it from the database, and records who", async () => {
    await withStore({}, async (store, client) => {
      await store.set("results.ttl_hours", 24, principals.admin);
      expect(await store.get("results.ttl_hours")).toBe(24);
      expect(await store.source("results.ttl_hours")).toBe("database");
      const { rows } = await client.query(
        "select set_by from setting where key = 'results.ttl_hours'",
      );
      expect(rows).toEqual([{ set_by: principals.admin.id }]);

      await store.set("results.ttl_hours", 48, principals.curator);
      expect(await store.get("results.ttl_hours")).toBe(48);
      const changed = await client.query(
        "select set_by from setting where key = 'results.ttl_hours'",
      );
      expect(changed.rows).toEqual([{ set_by: principals.curator.id }]);
    });
  });

  it("keeps every kind of value as it was given", async () => {
    await withStore({}, async (store) => {
      const providers = [OKTA_PROVIDER];
      await store.set("powerbi.tenant_id", TENANT, principals.admin);
      // A string that reads as a number or as null is still a string.
      await store.set("search.model", "123", principals.admin);
      await store.set("powerbi.sync.workspaces.include", [], principals.admin);
      await store.set("sign_in.passkeys", true, principals.admin);
      await store.set("sign_in.providers", providers, principals.admin);
      expect(await store.get("powerbi.tenant_id")).toBe(TENANT);
      expect(await store.get("search.model")).toBe("123");
      expect(await store.get("powerbi.sync.workspaces.include")).toEqual([]);
      expect(await store.get("sign_in.passkeys")).toBe(true);
      expect(await store.get("sign_in.providers")).toEqual(providers);
    });
  });

  it("saves a setting cleared back to null as a value of its own", async () => {
    await withStore({}, async (store) => {
      await store.set("powerbi.tenant_id", TENANT, principals.admin);
      await store.set("powerbi.tenant_id", null, principals.admin);
      expect(await store.get("powerbi.tenant_id")).toBeNull();
      expect(await store.source("powerbi.tenant_id")).toBe("database");
    });
  });

  it("refuses a value its schema refuses, naming the key, and saves nothing", async () => {
    await withStore({}, async (store) => {
      const tooSmall = await refusal(
        store.set("results.ttl_hours", 0, principals.admin),
      );
      expect(tooSmall.kind).toBe("invalid");
      expect(tooSmall.message).toContain("results.ttl_hours");
      expect(await store.source("results.ttl_hours")).toBe("default");
    });
  });

  it("refuses a result lifetime above 72 hours, and takes 72", async () => {
    await withStore({}, async (store) => {
      const tooLong = await refusal(
        store.set("results.ttl_hours", 73, principals.admin),
      );
      expect(tooLong.kind).toBe("invalid");
      expect(tooLong.message).toContain("results.ttl_hours");
      expect(await store.source("results.ttl_hours")).toBe("default");
      await store.set("results.ttl_hours", 72, principals.admin);
      expect(await store.get("results.ttl_hours")).toBe(72);
    });
  });
});

describe("list", () => {
  it("answers every setting with its value, where it came from and what it is", async () => {
    await withStore({ POWERBI_TENANT_ID: TENANT }, async (store) => {
      await store.set("results.ttl_hours", 24, principals.admin);
      const listing = await store.list();
      expect(listing.map((line) => line.key)).toEqual([...SETTING_KEYS]);
      expect(listing.find((line) => line.key === "powerbi.tenant_id")).toEqual({
        key: "powerbi.tenant_id",
        value: TENANT,
        source: "environment",
        environment_variable: "POWERBI_TENANT_ID",
        description: SETTINGS["powerbi.tenant_id"].description,
        environment_only: false,
        problem: null,
      });
      expect(
        listing.find((line) => line.key === "results.ttl_hours"),
      ).toMatchObject({ value: 24, source: "database", problem: null });
      expect(
        listing.find((line) => line.key === "results.preview_rows"),
      ).toMatchObject({ value: 20, source: "default" });
    });
  });
});

describe("list, over saved values the registry has since tightened", () => {
  it("answers each with the stored value and why it fails, and the rest without a problem", async () => {
    await withStore({}, async (store, client) => {
      // Written around the store, as an older registry would have allowed them.
      await client.query(
        "insert into setting (key, value, set_by) values ('results.ttl_hours', '0', 'someone'), ('powerbi.tenant_id', '\"my-company\"', 'someone')",
      );
      const listing = await store.list();
      const stale = listing.filter((line) => line.problem !== null);
      expect(stale.map((line) => line.key).sort()).toEqual([
        "powerbi.tenant_id",
        "results.ttl_hours",
      ]);
      const tenant = stale.find((line) => line.key === "powerbi.tenant_id");
      expect(tenant).toMatchObject({ value: "my-company", source: "database" });
      // The sentence says what is wrong, never what the value was.
      expect(tenant?.problem).not.toContain("my-company");
      expect(
        stale.find((line) => line.key === "results.ttl_hours"),
      ).toMatchObject({ value: 0, source: "database" });
      // A stale value is shown, never answered: get still refuses it.
      await expect(store.get("results.ttl_hours")).rejects.toThrow(
        /no longer valid/,
      );
    });
  });

  it("lets the environment's value stand over a stale saved one", async () => {
    await withStore({ POWERBI_TENANT_ID: TENANT }, async (store, client) => {
      await client.query(
        "insert into setting (key, value, set_by) values ('powerbi.tenant_id', '\"my-company\"', 'someone')",
      );
      const line = (await store.list()).find(
        (entry) => entry.key === "powerbi.tenant_id",
      );
      expect(line).toMatchObject({
        value: TENANT,
        source: "environment",
        problem: null,
      });
    });
  });
});

describe("the setting table", () => {
  it("refuses a key the registry does not know, whoever writes it", async () => {
    await withStore({}, async (_, client) => {
      await expect(
        client.query(
          "insert into setting (key, value, set_by) values ('no.such_setting', '1', 'someone')",
        ),
      ).rejects.toMatchObject({ constraint: "setting_key_known" });
    });
  });

  it("accepts every key the registry knows, so the migration has not fallen behind it", async () => {
    await withStore({}, async (_, client) => {
      const inserted = await client.query(
        "insert into setting (key, value, set_by) select key, 'null', 'someone' from unnest($1::text[]) as key",
        [SETTING_KEYS],
      );
      expect(inserted.rowCount).toBe(SETTING_KEYS.length);
    });
  });
});
