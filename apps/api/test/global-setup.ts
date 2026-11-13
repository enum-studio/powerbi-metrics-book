import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { TestProject } from "vitest/node";
import { migrateDatabase } from "../src/db/migrate.js";
import {
  BASE_DATABASE,
  dropDatabase,
  FILE_DATABASE_PREFIX,
  publishedAddress,
  startDatabase,
  TEMPLATE_DATABASE,
  templateUrl,
  withAdmin,
} from "./database.js";

declare module "vitest" {
  export interface ProvidedContext {
    /** This checkout's Cerbos, serving access/policies. */
    cerbos_url: string;
    /** The same, with the example override deployment layered on. */
    cerbos_override_url: string;
    cerbos_sample_url: string;
  }
}

/** Two runs on one server must not build the template at once. */
const TEMPLATE_LOCK = "powerbi_metrics_book.test_template";
/** A file's database older than this is left over from a run that was killed. */
const STALE_AFTER_MS = 60 * 60 * 1000;
/** What decides whether the template is current: the migrations, the grants declared beside the tables, and the SQL. */
const FINGERPRINTED = ["../drizzle", "../src/db"];

/**
 * Runs once before the suite: every test file talks to a real, migrated
 * database and a real Cerbos. Starting the containers waits for all of them
 * to be healthy. Each test file's database is cloned from the template
 * (test/file-database.ts).
 */
export default async function setup(project: TestProject): Promise<void> {
  startDatabase();
  await prepareTemplate();
  project.provide("cerbos_url", cerbosUrl("cerbos", "CERBOS_URL"));
  project.provide(
    "cerbos_override_url",
    cerbosUrl("cerbos_override", "CERBOS_OVERRIDE_URL"),
  );
  project.provide(
    "cerbos_sample_url",
    cerbosUrl("cerbos_sample", "CERBOS_SAMPLE_URL"),
  );
}

/**
 * Builds the template when it is missing or was built from other migrations:
 * a clone of the init script's database (which holds its extensions),
 * migrated the way the api migrates at start. An unchanged one is reused.
 */
async function prepareTemplate(): Promise<void> {
  const fingerprint = await migrationFingerprint();
  const template = pg.escapeIdentifier(TEMPLATE_DATABASE);
  await withAdmin(async (admin) => {
    await admin.query("select pg_advisory_lock(hashtext($1))", [TEMPLATE_LOCK]);
    await dropStaleFileDatabases(admin);
    const { rows } = await admin.query<{ built_from: string | null }>(
      `select shobj_description(oid, 'pg_database') as built_from
         from pg_database where datname = $1`,
      [TEMPLATE_DATABASE],
    );
    if (rows[0]?.built_from === fingerprint) return;
    if (rows.length > 0) await dropDatabase(admin, TEMPLATE_DATABASE);
    // Only a template may be cloned by a role that does not own it.
    await admin.query("set role migrator");
    await admin.query(
      `alter database ${pg.escapeIdentifier(BASE_DATABASE)} is_template true`,
    );
    await admin.query("reset role");
    await admin.query(
      `create database ${template} owner migrator template ${pg.escapeIdentifier(BASE_DATABASE)}`,
    );
    await migrateDatabase(templateUrl("migrator"));
    // Marked last, so a build that stopped half way is built again.
    await admin.query("set role migrator");
    await admin.query(`alter database ${template} is_template true`);
    await admin.query(
      `comment on database ${template} is ${pg.escapeLiteral(fingerprint)}`,
    );
  });
}

async function migrationFingerprint(): Promise<string> {
  const hash = createHash("sha256");
  for (const folder of FINGERPRINTED) {
    const root = fileURLToPath(new URL(folder, import.meta.url));
    const entries = await readdir(root, {
      recursive: true,
      withFileTypes: true,
    });
    const files = entries
      .filter(
        (entry) =>
          entry.isFile() && !/(\.test|_security_test)\.ts$/.test(entry.name),
      )
      .map((entry) => join(entry.parentPath, entry.name))
      .sort();
    for (const file of files) {
      hash.update(file.slice(root.length)).update(await readFile(file));
    }
  }
  return hash.digest("hex");
}

/** A killed run leaves its files' databases behind, and each takes memory on the tmpfs. */
async function dropStaleFileDatabases(admin: pg.Client): Promise<void> {
  const { rows } = await admin.query<{ datname: string }>(
    "select datname from pg_database where starts_with(datname, $1)",
    [FILE_DATABASE_PREFIX],
  );
  for (const { datname } of rows) {
    const [made] = datname.slice(FILE_DATABASE_PREFIX.length).split("_");
    const madeAt = parseInt(made ?? "", 36);
    if (Date.now() - madeAt > STALE_AFTER_MS)
      await dropDatabase(admin, datname);
  }
}

/** A set DATABASE_URL means someone else runs the services, and then the variable names theirs. */
function cerbosUrl(service: string, variable: string): string {
  if (!process.env.DATABASE_URL)
    return `http://${publishedAddress(service, 3592)}`;
  const url = process.env[variable];
  if (url === undefined || url === "")
    throw new Error(`DATABASE_URL is set, so ${variable} must be too`);
  return url;
}
