import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { roleUrl } from "../../test/database.js";

/*
 * What a deployed database does with the folder a start finds. This file's
 * database is at the committed migrations, as a deployment is, and each test
 * applies a copy of the folder with something added. scripts/check-migrations.mjs
 * refuses the two folders below that go wrong, for the reasons held here.
 */

const FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

interface Journal {
  entries: {
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }[];
}

let copy: string;
let client: pg.Client;

async function journal(): Promise<Journal> {
  const text = await readFile(join(copy, "meta/_journal.json"), "utf8");
  return JSON.parse(text) as Journal;
}

/** Adds a migration to the copy, this long after the last one's time. */
async function added(sql: string, later: number): Promise<void> {
  const current = await journal();
  const last = current.entries.at(-1);
  if (last === undefined) throw new Error("the folder holds no migration");
  const position = last.idx + 1;
  const tag = `${String(position).padStart(4, "0")}_test`;
  current.entries.push({
    ...last,
    idx: position,
    tag,
    when: last.when + later,
  });
  await writeFile(join(copy, `${tag}.sql`), sql);
  await writeFile(join(copy, "meta/_journal.json"), JSON.stringify(current));
}

const start = () => migrate(drizzle({ client }), { migrationsFolder: copy });

const tableExists = async (name: string) => {
  const { rows } = await client.query<{ found: string | null }>(
    "select to_regclass($1) as found",
    [name],
  );
  return rows[0]?.found !== null;
};

beforeEach(async () => {
  copy = await mkdtemp(join(tmpdir(), "pbmb-migrations-"));
  await cp(FOLDER, copy, { recursive: true });
  client = new pg.Client({ connectionString: roleUrl("migrator") });
  await client.connect();
});

afterEach(async () => {
  await client.end();
  await rm(copy, { recursive: true });
});

describe("a start on a deployed database", () => {
  it("applies only a later migration, and keeps every row", async () => {
    await client.query("create table kept (id int)");
    await client.query("insert into kept values (1)");
    await added("create table gained_by_upgrade (id int)", 1000);

    await start();

    expect(await tableExists("gained_by_upgrade")).toBe(true);
    const { rows } = await client.query("select id from kept");
    expect(rows).toEqual([{ id: 1 }]);
  });

  it("fails on the first migration written again with a later time", async () => {
    const [first] = (await journal()).entries;
    if (first === undefined) throw new Error("the folder holds no migration");
    const sql = await readFile(join(FOLDER, `${first.tag}.sql`), "utf8");
    await added(sql, 86_400_000);

    await expect(start()).rejects.toMatchObject({
      cause: { message: expect.stringContaining("already exists") as string },
    });
  });

  it("skips, saying nothing, a migration timed before the last one applied", async () => {
    await added("create table never_applied (id int)", -1000);

    await start();

    expect(await tableExists("never_applied")).toBe(false);
  });
});
