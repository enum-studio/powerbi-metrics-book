#!/usr/bin/env node
// Copies the repository's own documents into the site, so each has one source:
//
//   docs/security/threat_model.md -> security/threat-model.md
//   SECURITY.md                   -> security/reporting.md
//   CHANGELOG.md                  -> reference/changelog.md
//
// A copy gets the front matter Starlight needs, and its links to other files
// in the repository point at GitHub (or, for the other copied document, at the
// page). The copies are gitignored (apps/docs/.gitignore); `pnpm build` and
// `pnpm dev` run this first.
//
//   node scripts/sync-repo-docs.mjs

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = fileURLToPath(new URL("..", import.meta.url));
const REPOSITORY = join(SITE, "../..");
const CONTENT = join(SITE, "src/content/docs");
const GITHUB = "https://github.com/enum-studio/powerbi-metrics-book";

const SOURCES = [
  {
    from: "docs/security/threat_model.md",
    to: "security/threat-model.md",
    description:
      "Who attacks the stack, where trust changes hands, which control holds each boundary, which test proves it, and the risks that are left.",
    order: 30,
  },
  {
    from: "SECURITY.md",
    to: "security/reporting.md",
    description:
      "How to report a vulnerability privately, what happens next, and what is in scope.",
    order: 50,
  },
  {
    from: "CHANGELOG.md",
    to: "reference/changelog.md",
    description:
      "What each release changes, newest first, with the upgrade notes a release needs.",
    order: 90,
  },
];

/** The page a copied document becomes, as the path the site serves it at. */
const PAGE_OF = new Map(
  SOURCES.map(({ from, to }) => [from, `/docs/${to.replace(/\.md$/, "")}/`]),
);

const quoted = (text) => JSON.stringify(text);

/** Where a relative link in `source` points once the document is on the site. */
function rewriteTarget(source, target) {
  if (/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) return target;
  const [path, anchor = ""] = target.split("#");
  const resolved = posix.normalize(posix.join(posix.dirname(source), path));
  const page = PAGE_OF.get(resolved);
  if (page !== undefined) return anchor === "" ? page : `${page}#${anchor}`;
  const kind = path.endsWith("/") ? "tree" : "blob";
  return `${GITHUB}/${kind}/main/${resolved.replace(/\/$/, "")}${anchor === "" ? "" : `#${anchor}`}`;
}

/** Inline links and images, `](target)` and `](target "title")`. */
function rewriteLinks(source, text) {
  return text.replace(
    /\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g,
    (_match, target, title) => `](${rewriteTarget(source, target)}${title})`,
  );
}

function copy({ from, to, description, order }) {
  const original = readFileSync(join(REPOSITORY, from), "utf8");
  const heading = /^# (.+)\n+/.exec(original);
  if (heading === null)
    throw new Error(`${from} must start with a "# Title" line.`);
  const body = rewriteLinks(from, original.slice(heading[0].length));
  const page = [
    "---",
    `title: ${quoted(heading[1])}`,
    `description: ${quoted(description)}`,
    "sidebar:",
    `  order: ${String(order)}`,
    `editUrl: ${quoted(`${GITHUB}/edit/main/${from}`)}`,
    "---",
    "",
    `<!-- Copied from ${from} by scripts/sync-repo-docs.mjs. Edit that file. -->`,
    "",
    body,
  ].join("\n");
  const target = join(CONTENT, to);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, page);
}

for (const source of SOURCES) copy(source);
