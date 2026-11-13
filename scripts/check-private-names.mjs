#!/usr/bin/env node
// Fails when text names something on the maintainer's private list: a
// client, a tenant the product was tested on, an internal host. The list
// cannot live here, since the repository is public and the list would
// publish the names it guards, so it is a file on the maintainer's machine:
// $PBMB_PRIVATE_NAMES, or ~/.config/powerbi-metrics-book/private-names.
// One entry per line, matched case-insensitively anywhere in a line; blank
// lines and lines starting with # are ignored.
//
// Usage: node scripts/check-private-names.mjs [file]...
// With no file it checks every tracked file. A commit message or a pull
// request body is checked by naming its file. A hit is reported by file,
// line, column and the entry's line in the list, never by the entry, so the
// report itself can be pasted anywhere. Exits 1 on a hit; without a list it
// says so and exits 0, as a checkout without one has nothing to look for.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the list is read from. */
export function listPath(env = process.env, home = homedir()) {
  const named = env.PBMB_PRIVATE_NAMES;
  if (named !== undefined && named !== "") return named;
  return join(home, ".config", "powerbi-metrics-book", "private-names");
}

/** The list's entries, lower-cased, each with its line number in the list. */
export function parseList(text) {
  return text
    .split("\n")
    .map((line, index) => ({
      entry: line.trim().toLowerCase(),
      listLine: index + 1,
    }))
    .filter(({ entry }) => entry !== "" && !entry.startsWith("#"));
}

/** Every place in `text` where an entry appears. */
export function hits(text, entries) {
  const found = [];
  text.split("\n").forEach((line, index) => {
    const lower = line.toLowerCase();
    for (const { entry, listLine } of entries) {
      let column = lower.indexOf(entry);
      while (column !== -1) {
        found.push({ line: index + 1, column: column + 1, listLine });
        column = lower.indexOf(entry, column + 1);
      }
    }
  });
  return found;
}

/** A file's text, or null for one that is gone or binary. */
function readText(file) {
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  const bytes = readFileSync(file);
  if (bytes.includes(0)) return null;
  return bytes.toString("utf8");
}

function main() {
  const path = listPath();
  if (!existsSync(path)) {
    console.error(`No private-names list at ${path}; nothing to check.`);
    return 0;
  }
  const entries = parseList(readFileSync(path, "utf8"));
  const named = process.argv.slice(2);
  const files =
    named.length > 0
      ? named
      : execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
          .split("\0")
          .filter((file) => file !== "");

  let count = 0;
  for (const file of files) {
    const text = readText(file);
    if (text === null) continue;
    for (const hit of hits(text, entries)) {
      count += 1;
      console.error(
        `${file}:${hit.line}:${hit.column}: entry on line ${hit.listLine} of the private-names list`,
      );
    }
  }
  if (count > 0) {
    console.error(
      `${count} private name(s). Say "a client" or use the sample tenant's names; see "Working in public" in AGENTS.md.`,
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
