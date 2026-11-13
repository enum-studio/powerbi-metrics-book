#!/usr/bin/env node
// Fails when a link in the repository's own Markdown files does not resolve.
// A reader meets README.md and CONTRIBUTING.md on GitHub, where the docs
// site's addresses (/docs/...) lead nowhere, so a link to a docs page must
// name its file under apps/docs/src/content/docs/, and that file must exist.
// Every other relative link must name a file or directory that exists.
// Usage: node scripts/check-readme-links.mjs [file...]
// With no file, README.md and CONTRIBUTING.md are checked. Exits 1 and
// names each broken link with its file and line.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULTS = ["README.md", "CONTRIBUTING.md"];

/** Lines outside code fences, with inline code blanked, each with its number. */
function prose(text) {
  let fenced = false;
  return text.split("\n").flatMap((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return [];
    }
    return fenced ? [] : [[index + 1, line.replace(/`[^`]*`/g, "")]];
  });
}

/** Why a link does not resolve, or null when it does. */
function problem(file, target) {
  if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) return null;
  if (target === "/docs" || target.startsWith("/docs/"))
    return "is a docs site address, which leads nowhere on GitHub; link the page's file under apps/docs/src/content/docs/";
  const path = decodeURIComponent(target.split(/[#?]/)[0]);
  if (path === "") return null;
  const resolved = resolve(dirname(resolve(ROOT, file)), path);
  if (existsSync(resolved)) return null;
  return resolved.includes("/apps/docs/src/content/docs/")
    ? "names a docs page that does not exist"
    : "names a file that does not exist";
}

const files = process.argv.length > 2 ? process.argv.slice(2) : DEFAULTS;
const broken = [];
let count = 0;
for (const file of files) {
  const text = readFileSync(resolve(ROOT, file), "utf8");
  for (const [number, line] of prose(text)) {
    for (const match of line.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      count += 1;
      const why = problem(file, match[1]);
      if (why !== null)
        broken.push(`${file}:${String(number)}: ${match[1]} ${why}`);
    }
  }
}

if (broken.length > 0) {
  console.error(`${String(broken.length)} broken link(s):`);
  for (const line of broken) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`All ${String(count)} links in ${files.join(", ")} resolve.`);
