#!/usr/bin/env node
// Fails when a security page names something in the repository that is not
// there: a test file, a test, a policy, a command's script. The checklist's
// whole value is that each line can be traced to a test, so a rename or a
// deleted test must break the build, not leave a page claiming a proof.
//
//   node scripts/check-security-tests.mjs [pages-directory [repository]]
//
// What a hand-written page in security/ may contain, and what is checked:
//   - a code span that starts with a top-level directory of the repository
//     (`apps/api/src/...`): the path must exist;
//   - a link to github.com/enum-studio/powerbi-metrics-book/blob/main/<path>
//     or .../tree/main/<path>: the path must exist;
//   - on a line whose first link is to a test file, every code span after
//     that link is the name of a test in that file, written as in the source;
//   - checklist.md: every "###" item names at least one test file.
// The pages copied from the repository (they say "Copied from") are skipped:
// their links already point at GitHub, and their source is checked in review.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = fileURLToPath(new URL("..", import.meta.url));
const GITHUB = "https://github.com/enum-studio/powerbi-metrics-book";
const ROOTS =
  /^(apps|packages|stack|access|conventions|docs|scripts|skills|\.github|\.semgrep)\//;
const TEST_FILE =
  /(\.test\.[cm]?[jt]s|_security_test\.[cm]?[jt]s|\/test_[a-z_]+\.py|_security_test\.py)$/;
const LINK = /\[([^\]]*)\]\(([^)\s]+)\)/g;
const CODE = /`([^`]+)`/g;

const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every problem on one page, as sentences that name the page and the line. */
export function problemsIn(page, text, repository) {
  const found = [];
  const report = (line, sentence) =>
    found.push(`${page}:${String(line)}: ${sentence}`);
  const missing = (path) => !existsSync(join(repository, path));
  const lines = text.split("\n");
  const sources = new Map();
  const sourceOf = (path) => {
    if (!sources.has(path))
      sources.set(path, readFileSync(join(repository, path), "utf8"));
    return sources.get(path);
  };
  let item = null;
  const items = [];

  lines.forEach((line, index) => {
    const number = index + 1;
    if (/^### /.test(line)) {
      item = { title: line.slice(4), line: number, tests: 0 };
      items.push(item);
    }

    // A link's own text is compared with its target below.
    for (const [, code] of line.replace(LINK, "").matchAll(CODE))
      if (ROOTS.test(code) && !/[\s*<>]/.test(code) && missing(code))
        report(number, `\`${code}\` is not in the repository.`);

    let testPath = null;
    let afterTestLink = 0;
    for (const match of line.matchAll(LINK)) {
      const target = match[2];
      const prefix = [`${GITHUB}/blob/main/`, `${GITHUB}/tree/main/`].find(
        (each) => target.startsWith(each),
      );
      if (prefix === undefined) continue;
      const path = target.slice(prefix.length).replace(/#.*$/, "");
      if (missing(path)) {
        report(number, `${path} is linked but is not in the repository.`);
        continue;
      }
      const shown = /^`(.+)`$/.exec(match[1]);
      if (shown !== null && ROOTS.test(shown[1]) && shown[1] !== path)
        report(number, `${shown[1]} is shown but the link goes to ${path}.`);
      if (testPath === null && TEST_FILE.test(path)) {
        testPath = path;
        afterTestLink = match.index + match[0].length;
        if (item !== null) item.tests += 1;
      }
    }

    if (testPath === null) return;
    for (const [, name] of line.slice(afterTestLink).matchAll(CODE)) {
      // A Python test is a function; a JavaScript test is a quoted title.
      const written = testPath.endsWith(".py")
        ? new RegExp(`def ${escaped(name)}\\(`)
        : new RegExp(`(["'\`])${escaped(name)}\\1`);
      if (!written.test(sourceOf(testPath)))
        report(number, `${testPath} has no test named \`${name}\`.`);
    }
  });

  if (page === "checklist.md") {
    if (items.length === 0)
      found.push(`${page}: has no "###" item, so it checks nothing.`);
    for (const each of items)
      if (each.tests === 0)
        report(each.line, `"${each.title}" links no test file.`);
  }
  return found;
}

/** The hand-written pages of a directory: every .md that is not a copy. */
function pagesOf(directory) {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".md") || name.endsWith(".mdx"))
    .filter((name) => statSync(join(directory, name)).isFile())
    .map((name) => [name, readFileSync(join(directory, name), "utf8")])
    .filter(([, text]) => !text.includes("<!-- Copied from "));
}

/**
 * The check must be able to fail. This builds a small repository with one
 * test file, then runs the check on a page that names a file, a test and a
 * path that are not in it, and on a page that names only what is.
 */
function selfTest() {
  const repository = mkdtempSync(join(tmpdir(), "security-tests-"));
  try {
    mkdirSync(join(repository, "apps/api"), { recursive: true });
    writeFileSync(
      join(repository, "apps/api/real_security_test.ts"),
      'it("keeps the door shut", () => {});\n',
    );
    const link = (path) => `[\`${path}\`](${GITHUB}/blob/main/${path})`;
    const bad = [
      "### Item",
      `${link("apps/api/nope_security_test.ts")}: \`a test\``,
      `${link("apps/api/real_security_test.ts")}: \`no such test\``,
      "`apps/api/missing/file.ts`",
    ].join("\n");
    const good = `### Item\n${link("apps/api/real_security_test.ts")}: \`keeps the door shut\``;
    const caught = problemsIn("checklist.md", bad, repository).length;
    if (caught !== 3 || problemsIn("checklist.md", good, repository).length > 0)
      throw new Error(
        `The check no longer tells a missing test from a present one (caught ${String(caught)} of 3).`,
      );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
}

function main() {
  const directory = process.argv[2] ?? join(SITE, "src/content/docs/security");
  const repository = process.argv[3] ?? join(SITE, "../..");
  selfTest();
  const pages = pagesOf(directory);
  if (!pages.some(([name]) => name === "checklist.md")) {
    console.error(`${directory} has no checklist.md.`);
    process.exit(1);
  }
  const problems = pages.flatMap(([name, text]) =>
    problemsIn(name, text, repository),
  );
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    console.error(`${String(problems.length)} security page claim(s) fail.`);
    process.exit(1);
  }
  console.log(
    `${String(pages.length)} security pages: every file and test they name exists.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
