import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/*
 * One test Postgres per checkout.
 *
 * Several agents work this repository at once, each in its own worktree, each
 * running the api tests against a real Postgres. Sharing one server, they
 * would write into each other's runs and the damage would show up as flaky
 * tests rather than as a clash. So the port and the compose project name are
 * derived from a hash of the checkout's path: same checkout, same values,
 * every time, with nothing to pick and no file to write.
 *
 * The server's own database is powerbi_metrics_book on every checkout, as in
 * production: the stack's init script creates it with its extensions, and each
 * checkout has a server of its own, so the name need not differ. No test
 * reads or writes it. Global setup clones it once into a template and
 * migrates that; each test file then gets a database of its own cloned from
 * the template (test/file-database.ts), so files share no row, lock, event,
 * job or counter. roleUrl names the file's database.
 *
 * DATABASE_URL overrides the whole derivation: it is the api_rw URL of a
 * server this repository does not start, and every other role's password then
 * comes from the variable the init script reads (MIGRATOR_PASSWORD and so on).
 * Its database is the one the init script made, and the server must let
 * test_runner create databases: see TEST_RUNNER.
 */

export const ROLES = [
  "migrator",
  "api_rw",
  "worker_rw",
  "audit_writer",
] as const;
/**
 * The tests' own role, never a deployment's: a login with no rights of its
 * own (noinherit) that may `set role` to api_rw, worker_rw and audit_writer,
 * so one transaction that is rolled back can write rows as the worker and
 * read them as the api. It may also create databases, owned by the migrator
 * as in production, and `set role` to the migrator to drop them; it ends
 * sessions left open on them (pg_signal_backend, so Postgres 16 or later).
 * startDatabase makes it; with DATABASE_URL set, the server's owner makes it
 * with the same statements (CREATE_TEST_RUNNER), and TEST_RUNNER_PASSWORD
 * names its password. It connects to the server's `postgres` database to do
 * that work.
 */
export const TEST_RUNNER = "test_runner";
export type Role = (typeof ROLES)[number] | typeof TEST_RUNNER;

/** The passwords test/compose.yml hands the init script, and the tests' own role's. */
const COMPOSE_PASSWORDS: Record<Role, string> = {
  migrator: "migrator_test",
  api_rw: "api_rw_test",
  worker_rw: "worker_rw_test",
  audit_writer: "audit_writer_test",
  test_runner: "test_runner_test",
};

const CREATE_TEST_RUNNER = `
  set client_min_messages = warning;
  do $$ begin
    if not exists (select from pg_roles where rolname = '${TEST_RUNNER}') then
      create role ${TEST_RUNNER} login noinherit nosuperuser nocreatedb nocreaterole
        password '${COMPOSE_PASSWORDS.test_runner}';
    end if;
  end $$;
  alter role ${TEST_RUNNER} createdb;
  grant api_rw, worker_rw, audit_writer, migrator to ${TEST_RUNNER};
  grant pg_signal_backend to ${TEST_RUNNER} with inherit true;`;

const CHECKOUT_ROOT = fileURLToPath(
  new URL("../../../", import.meta.url),
).replace(/\/$/, "");
const COMPOSE_FILE = fileURLToPath(new URL("./compose.yml", import.meta.url));

export type LocalDatabase = { port: number; project: string };

export function deriveLocalDatabase(checkoutRoot: string): LocalDatabase {
  const digest = createHash("sha256").update(checkoutRoot).digest("hex");
  const slug = basename(checkoutRoot)
    .replace(/[^a-z0-9]+/gi, "_")
    .toLowerCase();
  // 20000 to 29999 sits above the well-known ports and below the ephemeral
  // range macOS hands out (49152 and up), so no outbound socket takes it.
  const port = 20000 + (parseInt(digest.slice(0, 8), 16) % 10000);
  return {
    port,
    project: `pbmb_api_test_${slug.slice(0, 24)}_${digest.slice(0, 8)}`,
  };
}

const local = deriveLocalDatabase(CHECKOUT_ROOT);

/** The database the init script made. No test connects to it: global setup clones it. */
export const BASE_DATABASE = process.env.DATABASE_URL
  ? decodeURIComponent(new URL(process.env.DATABASE_URL).pathname.slice(1))
  : "powerbi_metrics_book";
/** The base database with the migrations applied; each test file's database is a clone of it. */
export const TEMPLATE_DATABASE = `${BASE_DATABASE}_template`;
export const FILE_DATABASE_PREFIX = "pbmb_test_";
const FILE_DATABASE_VARIABLE = "PBMB_TEST_DATABASE";

function serverUrl(role: Role, database: string): string {
  const override = process.env.DATABASE_URL;
  if (override === undefined || override === "") {
    return `postgresql://${role}:${COMPOSE_PASSWORDS[role]}@127.0.0.1:${String(local.port)}/${database}`;
  }
  const url = new URL(override);
  url.pathname = `/${database}`;
  if (role === "api_rw") return url.href;
  const passwordVariable = `${role.toUpperCase()}_PASSWORD`;
  const password = process.env[passwordVariable];
  if (password === undefined || password === "") {
    throw new Error(`DATABASE_URL is set, so ${passwordVariable} must be too`);
  }
  url.username = role;
  url.password = password;
  return url.href;
}

/** The role's URL to the running test file's own database. */
export function roleUrl(role: Role): string {
  const database = process.env[FILE_DATABASE_VARIABLE];
  if (database === undefined || database === "")
    throw new Error(
      "this test file has no database: test/file-database.ts must be in setupFiles",
    );
  return serverUrl(role, database);
}

/** Called by test/file-database.ts, before the test file's own imports run. */
export function useFileDatabase(name: string): void {
  process.env[FILE_DATABASE_VARIABLE] = name;
}

/** The role's URL to the migrated template, for global setup. */
export function templateUrl(role: Role): string {
  return serverUrl(role, TEMPLATE_DATABASE);
}

/**
 * Runs work as test_runner on the server's `postgres` database, where
 * databases are made and dropped; the work runs `set role migrator` for what
 * only a database's owner may do. The connection ends, and any lock it took
 * with it.
 */
export async function withAdmin<T>(
  work: (admin: pg.Client) => Promise<T>,
): Promise<T> {
  const admin = new pg.Client({
    connectionString: serverUrl(TEST_RUNNER, "postgres"),
  });
  await admin.connect();
  try {
    return await work(admin);
  } finally {
    await admin.end();
  }
}

/**
 * A database for one test, owned by the migrator as in production. `options`
 * follow its name in `create database`. Named so that global setup's sweep
 * finds it if the test leaves it. Returns its name and the migrator's URL to it.
 */
export async function makeDatabase(
  options: string,
): Promise<{ name: string; url: string }> {
  const name = `${FILE_DATABASE_PREFIX}${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
  await withAdmin((admin) =>
    admin.query(
      `create database ${pg.escapeIdentifier(name)} owner migrator ${options}`,
    ),
  );
  return { name, url: serverUrl("migrator", name) };
}

/**
 * Drops a database, ending the sessions a test left open first. Not
 * `drop ... with (force)`: that ends them as the migrator, which holds no
 * rights over the other roles' sessions, while test_runner holds
 * pg_signal_backend. Only client backends: an autovacuum worker may be in the
 * database, and Postgres ends it itself when the drop starts. Dropping a
 * template takes its mark off first.
 */
export async function dropDatabase(
  admin: pg.Client,
  name: string,
): Promise<void> {
  const database = pg.escapeIdentifier(name);
  await admin.query(
    `select pg_terminate_backend(pid) from pg_stat_activity
      where datname = $1 and backend_type = 'client backend'`,
    [name],
  );
  await admin.query("set role migrator");
  await admin.query(`alter database ${database} is_template false`);
  await admin.query(`drop database ${database}`);
  await admin.query("reset role");
}

/**
 * Runs work on one connection inside a transaction that is always rolled
 * back, so nothing a test writes stays and test files can share the database
 * while running in parallel.
 */
export async function inRollback<T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    return await work(client);
  } finally {
    await client.query("rollback");
    client.release();
  }
}

/** Runs docker compose on this checkout's project and returns its output. */
function compose(...subcommand: string[]): string {
  const run = spawnSync(
    "docker",
    ["compose", "--file", COMPOSE_FILE, ...subcommand],
    {
      // Progress goes to stderr; stdout carries answers such as `port`'s.
      stdio: ["inherit", "pipe", "inherit"],
      encoding: "utf8",
      env: {
        ...process.env,
        COMPOSE_PROJECT_NAME: local.project,
        PBMB_API_TEST_PG_PORT: String(local.port),
      },
    },
  );
  if (run.status !== 0)
    throw new Error(
      `docker compose ${subcommand.join(" ")} exited with ${String(run.status)}`,
    );
  return run.stdout;
}

/**
 * Where this checkout's containers publish a service's port, as
 * 127.0.0.1:<port>. Docker picks the host port for Cerbos, so it is looked
 * up rather than derived.
 */
export function publishedAddress(service: string, port: number): string {
  return compose("port", service, String(port)).trim();
}

/** Starts this checkout's Postgres and waits for it; a set DATABASE_URL means someone else runs it. */
export function startDatabase(): void {
  if (process.env.DATABASE_URL) return;
  compose("up", "--detach", "--wait");
  // Here and not in the stack's init script, so the role never reaches a deployment.
  compose(
    ...[
      "exec",
      "--no-TTY",
      "postgres",
      "psql",
      "--quiet",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    ...["--username", "postgres", "--dbname", "powerbi_metrics_book"],
    ...["--command", CREATE_TEST_RUNNER],
  );
}

export function removeDatabase(): void {
  compose("down", "--volumes");
}

if (import.meta.main) {
  const command = process.argv[2];
  if (command !== "down")
    throw new Error(
      `usage: tsx test/database.ts down (got ${command ?? "nothing"})`,
    );
  removeDatabase();
}
