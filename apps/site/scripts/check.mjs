#!/usr/bin/env node
// Checks the built site in dist/ and fails naming each problem:
//
//   - every link on the landing page that stays on the site names a page or a
//     file in dist (the docs under dist/docs included), and every #fragment
//     names an element on that page;
//   - every page, the landing page and each docs page, links to the GitHub
//     repository (a redirect stub excepted);
//   - the docs' own links resolve (apps/docs/scripts/check-links.mjs, run on
//     the copy in dist/docs).
//
//   pnpm --filter @powerbi-metrics-book/site build
//   pnpm --filter @powerbi-metrics-book/site check

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(SITE, "dist");
const GITHUB = "https://github.com/enum-studio/powerbi-metrics-book";

if (!existsSync(join(DIST, "docs/index.html"))) {
  console.error(
    `${DIST} holds no full build. Build the site first: pnpm build`,
  );
  process.exit(1);
}

function htmlFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return htmlFiles(path);
    return name.endsWith(".html") ? [path] : [];
  });
}

/** The built file a root-relative path names, or null. */
function fileFor(path) {
  const direct = join(DIST, path);
  if (existsSync(direct) && statSync(direct).isFile()) return direct;
  const index = join(direct, "index.html");
  return existsSync(index) ? index : null;
}

const broken = [];
const landing = join(DIST, "index.html");
const html = readFileSync(landing, "utf8");
for (const match of html.matchAll(
  /<(?:a|link|img|script)\b[^>]*?\s(?:href|src)="([^"]*)"/g,
)) {
  const target = match[1].replaceAll("&amp;", "&");
  if (!target.startsWith("/") || target.startsWith("//")) continue;
  const [path, fragment] = target.split("#");
  const file = fileFor(path === "" ? "/" : path);
  if (file === null) {
    broken.push(`/: ${target} has no page`);
    continue;
  }
  if (fragment && file.endsWith(".html")) {
    const page = readFileSync(file, "utf8");
    if (!page.includes(` id="${fragment}"`))
      broken.push(`/: ${target} has no element with id "${fragment}"`);
  }
}

for (const page of htmlFiles(DIST)) {
  const text = readFileSync(page, "utf8");
  // A redirect (Astro's `redirects`) is a stub that forwards at once.
  if (/<meta http-equiv="refresh"/i.test(text)) continue;
  if (!text.includes(`href="${GITHUB}`))
    broken.push(`/${relative(DIST, page)}: no link to ${GITHUB}`);
}

if (broken.length > 0) {
  console.error(`${String(broken.length)} problem(s) in the site:`);
  for (const line of broken.sort()) console.error(`  ${line}`);
  process.exit(1);
}
console.log(
  "The landing page's links resolve, and every page links to GitHub.",
);

execFileSync(
  "node",
  [join(SITE, "../docs/scripts/check-links.mjs"), join(DIST, "docs")],
  { stdio: "inherit" },
);
