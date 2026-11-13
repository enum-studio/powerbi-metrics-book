import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { inject } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import type {
  Access,
  AppDeps,
  Container,
  SettingsStore,
  Vault,
} from "../src/context.js";
import { createDb } from "../src/db/client.js";
import { user } from "../src/db/schema/auth.js";
import { personIdentity } from "../src/db/schema/mirror.js";
import { createLogger } from "../src/log.js";
import type { Principal } from "../src/principal.js";
import { createAccess } from "../src/services/access/cerbos.js";
import { assignRole } from "../src/services/auth/roles.js";
import { type Role, roleUrl } from "./database.js";
import {
  accessFrom,
  MemorySecrets,
  MemorySettings,
  refusingFetcher,
} from "./doubles.js";

/*
 * Deps for a test: the real database, as the container's own role, and the
 * doubles in test/doubles.ts for everything else until a test passes the real
 * one in overrides.
 */

export const TEST_PUBLIC_BASE_URL = "https://metrics.example.com";

/** One pool per role per test file; end them with closeTestPools in afterAll. */
const pools = new Map<Role, pg.Pool>();

export function testPool(role: Role): pg.Pool {
  let pool = pools.get(role);
  if (pool === undefined) {
    pool = new pg.Pool({ connectionString: roleUrl(role) });
    pools.set(role, pool);
  }
  return pool;
}

export async function closeTestPools(): Promise<void> {
  const ending = [...pools.values()].map((pool) => pool.end());
  pools.clear();
  await Promise.all(ending);
}

/** The environment a container starts from in a test; `env` adds or replaces variables. */
export function testEnvironment(
  container: Container,
  env: Record<string, string> = {},
): Record<string, string> {
  return {
    PUBLIC_BASE_URL: TEST_PUBLIC_BASE_URL,
    DATABASE_URL: roleUrl(container === "api" ? "api_rw" : "worker_rw"),
    MIGRATOR_DATABASE_URL: roleUrl("migrator"),
    AUDIT_DATABASE_URL: roleUrl("audit_writer"),
    AUTH_SECRET: "test-auth-secret-at-least-32-characters",
    CERBOS_URL: "http://127.0.0.1:3592",
    GIT_SHA: "3b5aa24",
    LOG_LEVEL: "error",
    NODE_ENV: "test",
    ...env,
  };
}

/** A bootstrap environment as the container would see it, read through the real loadConfig; `env` adds or replaces variables. */
export function testConfig(
  container: Container,
  env: Record<string, string> = {},
): Config {
  return loadConfig(testEnvironment(container, env), container);
}

/** A test that seals or opens passes a vault of its own (createVault with a fresh identity). */
const refusingVault: Vault = {
  recipient: "",
  seal: () => Promise.reject(new Error("this test has no vault")),
  open: () => Promise.reject(new Error("this test has no vault")),
};

export function createTestDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  const container = overrides.container ?? "api";
  const pool =
    overrides.pool ?? testPool(container === "api" ? "api_rw" : "worker_rw");
  return {
    container,
    pool,
    db: createDb(pool),
    auditDb: createDb(testPool("audit_writer")),
    config: testConfig(container),
    logger: createLogger("error", () => {}),
    clock: () => new Date(),
    fetcher: refusingFetcher,
    settings: new MemorySettings(),
    secrets: new MemorySecrets(),
    // Refuses everything until a test says otherwise.
    access: accessFrom(() => false),
    vault: refusingVault,
    ...overrides,
  };
}

/** Refuses everything and describes no dataset, for a test that reads the book as a caller who sees none. */
export const describesNothing = (): Access =>
  accessFrom(
    () => false,
    () => sql`false`,
  );

/**
 * The real Access, asking this checkout's Cerbos (test/global-setup.ts), with
 * the visibility mode from settings. `override` asks the Cerbos that also
 * loads the example deployment in access/layering_tests/override, `sample`
 * the one that also loads examples/sample/access/policies.
 */
export function cerbosAccess(
  settings: SettingsStore,
  policies: "defaults" | "override" | "sample" = "defaults",
): Access {
  const url = inject(
    (
      {
        defaults: "cerbos_url",
        override: "cerbos_override_url",
        sample: "cerbos_sample_url",
      } as const
    )[policies],
  );
  return createAccess({ cerbosUrl: new URL(url), settings });
}

function person(role: string): Principal {
  return {
    kind: "person",
    id: `test-${role}`,
    roles: [role],
    attributes: {
      powerbi_workspace_ids: [],
      powerbi_app_ids: [],
      powerbi_dataset_ids: [],
    },
    via: "browser",
    client_id: null,
  };
}

/** A signed-in person holding each shipped role. */
export const principals = {
  viewer: person("viewer"),
  curator: person("curator"),
  admin: person("admin"),
} as const satisfies Record<string, Principal>;

/** The domain of adminOnRecord's emails, so a test can tell the caller's own assignment apart. */
export const ADMINS_DOMAIN = "admins.example.test";

/**
 * An admin on record, for a test of a change that takes the admin lock, which
 * reads the caller's roles again from the database. By default admin is
 * assigned to their email. Through a group, a Microsoft group of their own
 * read now, the last-admin rule, which counts assignments to a person, stays
 * about the people the test makes; it holds for SIGN_IN_FRESH_MS of the
 * test's clock.
 */
export async function adminOnRecord(
  deps: Pick<AppDeps, "db" | "clock">,
  {
    through = "person",
    name = "Test admin",
  }: { through?: "person" | "group"; name?: string } = {},
): Promise<Principal> {
  const id = randomUUID();
  const email = `${id}@${ADMINS_DOMAIN}`;
  await deps.db.insert(user).values({ id, email, name, emailVerified: true });
  if (through === "person") {
    await assignRole(
      deps.db,
      { role: "admin", subject_kind: "person", subject: email },
      principals.admin,
    );
    return { ...principals.admin, id };
  }
  const group = randomUUID();
  await deps.db.insert(personIdentity).values({
    user_id: id,
    microsoft_object_id: randomUUID(),
    group_object_ids: [group],
    groups_read_at: deps.clock(),
  });
  await assignRole(
    deps.db,
    {
      role: "admin",
      subject_kind: "group",
      provider: "microsoft",
      subject: group,
    },
    principals.admin,
  );
  return { ...principals.admin, id };
}
