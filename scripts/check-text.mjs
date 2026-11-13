#!/usr/bin/env node
// Fails when written text holds an en or em dash or a curly quote, the marks
// the writing rules keep out of docs, interface text and code comments.
// Usage: node scripts/check-text.mjs <file or directory>...
// Directories are searched for text files; node_modules, dist and dot
// directories are skipped. Exits 1 naming each mark's file, line and column.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const MARKS = new Map(
  [
    [0x2013, "en dash"],
    [0x2014, "em dash"],
    [0x201c, "curly double quote"],
    [0x201d, "curly double quote"],
    [0x2018, "curly single quote"],
    [0x2019, "curly single quote"],
  ].map(([point, name]) => [String.fromCodePoint(point), name]),
);
const TEXT = new Set([
  ".md",
  ".mdx",
  ".txt",
  ".astro",
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".yml",
  ".yaml",
  ".toml",
  ".py",
  ".sh",
  ".css",
  ".html",
  ".svg",
]);
const SKIPPED = new Set(["node_modules", "dist"]);

function filesUnder(path) {
  if (!existsSync(path)) {
    console.error(`${path} does not exist.`);
    process.exit(2);
  }
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".") || SKIPPED.has(entry.name)) return [];
    const child = join(path, entry.name);
    if (entry.isDirectory()) return filesUnder(child);
    return TEXT.has(extname(entry.name)) ? [child] : [];
  });
}

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("Name the files or directories to check.");
  process.exit(2);
}

let found = 0;
for (const file of paths.flatMap(filesUnder)) {
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, index) => {
      [...line].forEach((character, column) => {
        const name = MARKS.get(character);
        if (name === undefined) return;
        found += 1;
        console.error(`${file}:${index + 1}:${column + 1}: ${name}`);
      });
    });
}
if (found > 0) {
  console.error(
    `${found} mark(s) the writing rules forbid. Use a colon, comma, period or straight quote.`,
  );
  process.exit(1);
}
