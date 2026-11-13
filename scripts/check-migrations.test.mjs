import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  againstSchema,
  generateFrom,
  problems,
  read,
} from "./check-migrations.mjs";

const COMMITTED = join(
  resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  "apps/api/drizzle",
);

const FIRST = { idx: 0, tag: "0000_first", when: 1000 };
const SECOND = { idx: 1, tag: "0001_second", when: 2000 };
const THIRD = { idx: 2, tag: "0002_third", when: 3000 };
const NOW = 10_000;

/** A folder holding these migrations, each with its SQL and snapshot. */
const folder = (...entries) =>
  new Map([
    ["meta/_journal.json", JSON.stringify({ entries })],
    ...entries.flatMap(({ tag }, position) => [
      [`${tag}.sql`, `create table ${tag};`],
      [`meta/000${position}_snapshot.json`, `{"id":"${tag}","of":"${tag}"}`],
    ]),
  ]);
const check = (base, head) => problems(base, head, NOW);

test("passes an unchanged folder and one with a later migration added", () => {
  assert.deepEqual(check(folder(FIRST), folder(FIRST)), []);
  assert.deepEqual(check(folder(FIRST), folder(FIRST, SECOND)), []);
});

test("passes the first migration of an empty base", () => {
  assert.deepEqual(check(new Map(), folder(FIRST)), []);
});

test("refuses an applied migration's SQL or snapshot changed", () => {
  for (const path of ["0000_first.sql", "meta/0000_snapshot.json"]) {
    const head = folder(FIRST).set(path, "changed");
    assert.deepEqual(check(folder(FIRST), head), [
      `${path} is applied on deployed databases and was changed`,
    ]);
  }
});

test("refuses the folder regenerated under a new name and time", () => {
  const found = check(
    folder(FIRST),
    folder({ ...FIRST, tag: "0000_other", when: 3000 }),
  );
  assert.ok(
    found.includes(
      "0000_first.sql is applied on deployed databases and was removed",
    ),
  );
  assert.ok(
    found.includes("the journal no longer lists 0000_first as entry 0"),
  );
});

test("refuses an applied migration given a later time", () => {
  assert.deepEqual(check(folder(FIRST), folder({ ...FIRST, when: 3000 })), [
    "the journal no longer lists 0000_first as entry 0",
  ]);
});

test("refuses a migration timed at or before the one ahead of it", () => {
  for (const when of [500, 1000]) {
    const [problem, ...rest] = check(
      folder(FIRST),
      folder(FIRST, { ...SECOND, when }),
    );
    assert.match(problem, /^0001_second is timed before 0000_first/);
    assert.deepEqual(rest, []);
  }
});

test("refuses a migration with no valid time, or one timed in the future", () => {
  for (const when of [undefined, "soon", 1.5]) {
    assert.deepEqual(check(folder(FIRST), folder(FIRST, { ...SECOND, when })), [
      "0001_second has no valid time, so a start would skip it",
    ]);
  }
  assert.deepEqual(
    check(folder(FIRST), folder(FIRST, { ...SECOND, when: NOW + 1 })),
    ["0001_second is timed in the future, so a start could skip others"],
  );
});

test("refuses a branch adding two migrations", () => {
  const [several] = check(folder(FIRST), folder(FIRST, SECOND, THIRD));
  assert.match(several, /^a branch adds one migration/);
});

test("refuses a tag that is not a name for its position", () => {
  for (const tag of ["0000_first", "0002_second", "second", "sub/second"]) {
    const head = folder(FIRST, { ...SECOND, tag });
    assert.ok(
      check(folder(FIRST), head).includes(
        `${tag} is not a name for entry 1: it takes 0001_ and then lower case letters, digits and underscores`,
      ),
      tag,
    );
  }
});

test("refuses any other change to an applied journal entry", () => {
  const head = folder({ ...FIRST, breakpoints: true });
  assert.deepEqual(check(folder(FIRST), head), [
    "the journal no longer lists 0000_first as entry 0",
  ]);
});

test("reads a link as no text, so it passes neither as a file nor as applied", () => {
  const scratch = mkdtempSync(join(tmpdir(), "pbmb-check-migrations-test-"));
  try {
    writeFileSync(join(scratch, "real.txt"), "text");
    symlinkSync(join(scratch, "real.txt"), join(scratch, "0000_first.sql"));
    assert.equal(read(scratch).get("0000_first.sql"), null);
    const head = folder(FIRST).set("0000_first.sql", null);
    assert.deepEqual(check(folder(FIRST), head), [
      "0000_first.sql is applied on deployed databases and was changed",
    ]);
  } finally {
    rmSync(scratch, { recursive: true });
  }
});

test("the generator finds nothing to add to the committed folder", () => {
  const committed = read(COMMITTED);
  assert.deepEqual(
    againstSchema(committed, committed, generateFrom(committed)),
    [],
  );
});

test("the generator finishes the same under forced colour", (t) => {
  t.after(() => delete process.env.FORCE_COLOR);
  process.env.FORCE_COLOR = "1";
  assert.ok(generateFrom(new Map()).has("meta/_journal.json"));
});

test("the generator's failure stops the check, though it exits 0", () => {
  const broken = read(COMMITTED).set("meta/0000_snapshot.json", "{}");
  assert.throws(() => generateFrom(broken), /db:generate did not finish/);
});

test("refuses any file the journal does not account for", () => {
  for (const path of [
    "0001_second.sql",
    "meta/0001_snapshot.json",
    "notes.txt",
  ]) {
    const head = folder(FIRST).set(path, "stray");
    assert.deepEqual(check(folder(FIRST), head), [
      `${path} is not in the journal, so it does not belong here`,
    ]);
  }
});

test("refuses a listed migration with no SQL or no snapshot", () => {
  for (const [path, problem] of [
    ["0001_second.sql", "0001_second.sql is missing"],
    ["meta/0001_snapshot.json", "meta/0001_snapshot.json is missing"],
  ]) {
    const head = folder(FIRST, SECOND);
    head.delete(path);
    assert.deepEqual(check(folder(FIRST), head), [problem]);
  }
});

test("passes a branch and a schema that agree, whatever the generated names", () => {
  const generated = folder(FIRST, { ...SECOND, tag: "0001_other" })
    .set("0001_other.sql", "create table 0001_second;")
    .set("meta/0001_snapshot.json", '{"id":"random","of":"0001_second"}');
  assert.deepEqual(
    againstSchema(folder(FIRST), folder(FIRST, SECOND), generated),
    [],
  );
  assert.deepEqual(
    againstSchema(folder(FIRST), folder(FIRST), folder(FIRST)),
    [],
  );
});

test("refuses a schema that moved with no migration, and one that did not with a migration", () => {
  const [missing] = againstSchema(
    folder(FIRST),
    folder(FIRST),
    folder(FIRST, SECOND),
  );
  assert.match(missing, /^the schema changed with no migration/);
  const [extra] = againstSchema(
    folder(FIRST),
    folder(FIRST, SECOND),
    folder(FIRST),
  );
  assert.match(extra, /^0001_second is not what the schema asks for/);
});

test("refuses a migration's SQL or snapshot that differs from what is generated", () => {
  for (const [path, problem] of [
    ["0001_second.sql", /^0001_second.sql differs/],
    ["meta/0001_snapshot.json", /^meta\/0001_snapshot.json differs/],
  ]) {
    const head = folder(FIRST, SECOND).set(path, '{"edited":true}');
    const [found] = againstSchema(folder(FIRST), head, folder(FIRST, SECOND));
    assert.match(found, problem);
  }
});
