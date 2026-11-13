#!/usr/bin/env node
// Fails when an internal link or anchor in the built site (dist/) does not
// resolve, naming each broken one with the page it is on.
//
//   node scripts/check-links.mjs [dist]
//
// Run `pnpm build` first. A link counts as internal when it has no scheme and
// no host, or names this site's own base (/docs). A link to a file resolves
// when the file is in dist; a link to a page resolves when it has an
// index.html; a #fragment resolves when that page holds an element with that
// id (or an anchor with that name).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DIST =
  process.argv[2] ?? fileURLToPath(new URL("../dist", import.meta.url));
const BASE = "/docs";

if (!existsSync(DIST)) {
  console.error(`${DIST} does not exist. Build the site first: pnpm build`);
  process.exit(1);
}

function htmlFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return htmlFiles(path);
    return name.endsWith(".html") ? [path] : [];
  });
}

/** The URL path a built file is served at. */
const urlOf = (file) => {
  const path = `${BASE}/${relative(DIST, file).split(sep).join("/")}`;
  return path.replace(/index\.html$/, "");
};

const ids = new Map();
function idsOf(file) {
  if (!ids.has(file)) {
    const html = readFileSync(file, "utf8");
    ids.set(
      file,
      new Set(
        [...html.matchAll(/\s(?:id|name)=(?:"([^"]*)"|'([^']*)')/g)].map(
          (match) => match[1] ?? match[2],
        ),
      ),
    );
  }
  return ids.get(file);
}

/** The built file a URL path names, or null. */
function fileFor(path) {
  const inside = path.slice(BASE.length).replace(/^\//, "");
  const direct = join(DIST, inside);
  if (inside !== "" && existsSync(direct) && statSync(direct).isFile())
    return direct;
  const index = join(direct, "index.html");
  return existsSync(index) ? index : null;
}

const decode = (text) =>
  text
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#38;", "&")
    .replaceAll("&#39;", "'");

const broken = [];
const pages = htmlFiles(DIST);
for (const page of pages) {
  const html = readFileSync(page, "utf8");
  const here = urlOf(page);
  for (const match of html.matchAll(
    /<(?:a|link|img|script|source)\b[^>]*?\s(?:href|src)=(?:"([^"]*)"|'([^']*)')/g,
  )) {
    const target = decode(match[1] ?? match[2]);
    if (target === "" || /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;
    const [pathPart, fragment] = target.split("#");
    const path =
      pathPart === ""
        ? here
        : pathPart.startsWith("/")
          ? pathPart
          : posix.join(here.replace(/[^/]*$/, ""), pathPart);
    const normalised = posix.normalize(path.split("?")[0]);
    if (!normalised.startsWith(`${BASE}/`) && normalised !== BASE) {
      // A root-relative link out of the site is the api's, such as /api or /setup.
      if (pathPart.startsWith("/")) continue;
      broken.push(`${here}: ${target} leaves the site`);
      continue;
    }
    const file = fileFor(normalised);
    if (file === null) {
      broken.push(`${here}: ${target} has no page`);
      continue;
    }
    if (fragment !== undefined && fragment !== "" && file.endsWith(".html")) {
      const wanted = decodeURIComponent(fragment);
      if (!idsOf(file).has(wanted))
        broken.push(`${here}: ${target} has no element with id "${wanted}"`);
    }
  }
}

if (broken.length > 0) {
  console.error(`${String(broken.length)} broken link(s):`);
  for (const line of [...new Set(broken)].sort()) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`Every internal link in ${String(pages.length)} pages resolves.`);
