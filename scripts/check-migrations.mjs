#!/usr/bin/env node
// Fails when a branch would stop a deployed database from upgrading, or would
// leave it behind the schema. A start applies the migrations timed after the
// last one it recorded, so an applied migration written again under a later
// time fails on tables that exist, and one timed before the last is skipped
// with no error (apps/api/src/db/migrations.test.ts holds both). A branch adds
// at most one migration, and it must be what db:generate writes from the base.
// Usage: node scripts/check-migrations.mjs [base]
// With no base, the commit this branch left origin/main at. The merge gate
// names main itself. Exits 1 and names each problem.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API = join(ROOT, "apps/api");
const FOLDER = "apps/api/drizzle";
const JOURNAL = "meta/_journal.json";
const TAG = /^\d{4}_[a-z0-9_]+$/;
const REDO =
  "take the base's apps/api/drizzle, then run pnpm --filter @powerbi-metrics-book/api db:generate again";
// A snapshot of the whole schema is about 200 KB, and this leaves it room.
const MAX_BUFFER = 64 * 1024 * 1024;
// The generator's last line when it finished, with a change or without one.
const FINISHED =
  /^(No schema changes, nothing to migrate|\[.\] Your SQL migration file)/;

const entriesOf = (files) =>
  files.has(JOURNAL) ? JSON.parse(files.get(JOURNAL)).entries : [];
const fourDigits = (position) => String(position).padStart(4, "0");
const snapshotOf = (position) => `meta/${fourDigits(position)}_snapshot.json`;

/**
 * What is wrong with `head`, a folder as a map of relative path to text, given
 * `base`, the same folder on the branch it merges into.
 */
export function problems(base, head, now = Date.now()) {
  const found = [];
  for (const [path, text] of base) {
    if (path === JOURNAL) continue;
    if (!head.has(path))
      found.push(`${path} is applied on deployed databases and was removed`);
    else if (head.get(path) !== text)
      found.push(`${path} is applied on deployed databases and was changed`);
  }
  const before = entriesOf(base);
  const after = entriesOf(head);
  before.forEach((entry, position) => {
    if (JSON.stringify(after[position]) !== JSON.stringify(entry))
      found.push(
        `the journal no longer lists ${entry.tag} as entry ${position}`,
      );
  });
  if (after.length > before.length + 1)
    found.push(`a branch adds one migration, and this adds several: ${REDO}`);
  after.forEach(({ idx, tag, when }, position) => {
    if (idx !== position)
      found.push(`${tag} is entry ${position} of the journal, not ${idx}`);
    if (!TAG.test(tag) || !tag.startsWith(`${fourDigits(position)}_`))
      found.push(
        `${tag} is not a name for entry ${position}: it takes ${fourDigits(position)}_ and then lower case letters, digits and underscores`,
      );
    if (!head.has(`${tag}.sql`)) found.push(`${tag}.sql is missing`);
    if (!head.has(snapshotOf(position)))
      found.push(`${snapshotOf(position)} is missing`);
    if (!Number.isSafeInteger(when)) {
      found.push(`${tag} has no valid time, so a start would skip it`);
      return;
    }
    const previous = after[position - 1];
    if (previous !== undefined && when <= previous.when)
      found.push(
        `${tag} is timed before ${previous.tag}, so a start would skip it: ${REDO}`,
      );
    if (position >= before.length && when > now)
      found.push(`${tag} is timed in the future, so a start could skip others`);
  });
  const known = new Set([
    JOURNAL,
    ...after.flatMap(({ tag }, position) => [
      `${tag}.sql`,
      snapshotOf(position),
    ]),
  ]);
  for (const path of head.keys())
    if (!known.has(path))
      found.push(`${path} is not in the journal, so it does not belong here`);
  return found;
}

/** A snapshot's text without its random id, which every generate writes anew. */
function withoutId(text) {
  return JSON.stringify({ ...JSON.parse(text), id: null });
}

/**
 * What is wrong with `head` given `generated`, what db:generate leaves when
 * started from `base` and given the branch's schema.
 */
export function againstSchema(base, head, generated) {
  const position = entriesOf(base).length;
  const written = entriesOf(generated)[position];
  const ours = entriesOf(head)[position];
  if (written === undefined && ours === undefined) return [];
  if (ours === undefined)
    return [
      "the schema changed with no migration: run pnpm --filter @powerbi-metrics-book/api db:generate",
    ];
  if (written === undefined)
    return [`${ours.tag} is not what the schema asks for, which is nothing`];
  const found = [];
  if (head.get(`${ours.tag}.sql`) !== generated.get(`${written.tag}.sql`))
    found.push(`${ours.tag}.sql differs from what db:generate writes: ${REDO}`);
  const snapshot = head.get(snapshotOf(position));
  if (
    snapshot !== undefined &&
    withoutId(snapshot) !== withoutId(generated.get(snapshotOf(position)))
  )
    found.push(
      `${snapshotOf(position)} differs from what db:generate writes: ${REDO}`,
    );
  return found;
}

function committed(base) {
  const git = (...words) =>
    execFileSync("git", words, {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
    });
  const names = git("ls-tree", "-r", "--name-only", base, `${FOLDER}/`)
    .split("\n")
    .filter(Boolean);
  return new Map(
    names.map((name) => [
      name.slice(FOLDER.length + 1),
      git("show", `${base}:${name}`),
    ]),
  );
}

/** A folder as a map of relative path to text. A link has no text, so it matches nothing. */
export function read(folder) {
  if (!existsSync(folder)) return new Map();
  return new Map(
    readdirSync(folder, { recursive: true, withFileTypes: true })
      .filter((entry) => !entry.isDirectory())
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return [
          path.slice(folder.length + 1),
          entry.isFile() ? readFileSync(path, "utf8") : null,
        ];
      }),
  );
}

/**
 * Runs db:generate's generator over a copy of `base`, so the branch's own
 * folder has no say in what the schema asks for. Throws unless it finished: it
 * can crash and exit 0, and with no terminal it fails where it would ask whether
 * a table or column was renamed, which nothing here can answer for it.
 */
export function generateFrom(base) {
  const folder = mkdtempSync(join(tmpdir(), "pbmb-check-migrations-"));
  try {
    for (const [path, text] of base) {
      mkdirSync(dirname(join(folder, path)), { recursive: true });
      writeFileSync(join(folder, path), text);
    }
    const run = spawnSync(
      "pnpm",
      [
        "exec",
        "drizzle-kit",
        "generate",
        "--dialect",
        "postgresql",
        "--schema",
        "./src/db/schema/index.ts",
        "--out",
        // It puts ./ ahead of what it is given, so an absolute path fails.
        relative(API, folder),
      ],
      { cwd: API, encoding: "utf8", input: "", maxBuffer: MAX_BUFFER },
    );
    // FORCE_COLOR puts escape codes inside the line this reads.
    const last =
      stripVTControlCharacters(run.stdout).trim().split("\n").at(-1) ?? "";
    if (run.status !== 0 || !FINISHED.test(last))
      throw new Error(
        `db:generate did not finish. If it stopped to ask about a rename, make the change in two pull requests: add the new name, then remove the old one.\n${run.stdout}\n${run.stderr}`,
      );
    return read(folder);
  } finally {
    rmSync(folder, { recursive: true });
  }
}

if (import.meta.main) {
  const base =
    process.argv[2] ??
    execFileSync("git", ["merge-base", "HEAD", "origin/main"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
  const before = committed(base);
  const head = read(join(ROOT, FOLDER));
  const found = problems(before, head);
  if (found.length === 0)
    found.push(...againstSchema(before, head, generateFrom(before)));
  for (const problem of found) console.error(problem);
  process.exit(found.length === 0 ? 0 : 1);
}
