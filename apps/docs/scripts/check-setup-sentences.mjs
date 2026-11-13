#!/usr/bin/env node
// Fails when the setup guide and the setup's code stop agreeing:
//
//   - a step in STEPS (apps/api/src/services/setup/steps.ts) whose docs_path,
//     or FAILURE_DOCS_PATH, has no page under set-up/;
//   - a step page whose title differs from the step's title;
//   - a failure sentence a setup check can produce that "When a check fails"
//     does not quote, or a sentence quoted there that no check produces.
//
//   node scripts/check-setup-sentences.mjs [pages-directory [repository]]
//
// A failure sentence is read from the code's syntax tree, not from a list:
// every sentence-like string in the setup's source files, except what a
// passing check says (inside pass(...) or an object whose status is
// "passing" or "explained") and the errors a request is refused with. That
// way a new `fail("...")` that nobody wrote up fails this check.
//
// On the page a sentence is quoted verbatim on one line starting with "> ".
// Where the code builds a sentence from a value (a count, a permission's
// name), the quote may hold anything in that place, such as `{count}`.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SITE = fileURLToPath(new URL("..", import.meta.url));
const PAGES = join(SITE, "src/content/docs/set-up");
const REPOSITORY = join(SITE, "../..");

const STEPS_FILE = "apps/api/src/services/setup/steps.ts";
const LINKS_FILE = "apps/web/src/setup/links.ts";
const SETUP_SOURCES = "apps/api/src/services/setup";
// The sentence a check's answer is replaced by when it repeats a secret.
const SCREENED = {
  file: "apps/api/src/services/admin/checks.ts",
  names: ["ECHOED"],
};
// The first-admin confirmation is refused with a ServiceError the step shows.
const REFUSALS_SHOWN = ["link.ts"];
// The product links this page's title beside every step (NeedHelp in
// apps/web/src/setup/parts.tsx).
const FAILURE_PAGE_TITLE = "When a check fails";
const FAILURE_PAGE = "when-a-check-fails.md";

const textOf = (node) => (ts.isStringLiteralLike(node) ? node.text : null);
const sourceOf = (path, text) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);

/** The text of a string or template, as its fixed fragments around each value. */
function fragmentsOf(node) {
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isTemplateExpression(node))
    return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)];
  return null;
}

/** A sentence reads like one: capitalised or opening on a value, three words or more, ending in a full stop. */
function isSentence(fragments) {
  const text = fragments.join("\uE000");
  return (
    /^[A-Z\uE000]/.test(text) &&
    text.endsWith(".") &&
    text.split(/\s+/).length >= 3
  );
}

const statusOf = (object) => {
  for (const property of object.properties)
    if (
      ts.isPropertyAssignment(property) &&
      property.name.getText() === "status"
    )
      return textOf(
        ts.isAsExpression(property.initializer)
          ? property.initializer.expression
          : property.initializer,
      );
  return null;
};

/** The failure sentences in one source file, as the fragments the code fixes. */
export function sentencesIn(path, text, { names = null, errors = false } = {}) {
  const file = sourceOf(path, text);
  // A sentence kept in a variable that only pass(...) is given is a passing one.
  const passed = new Set();
  const collect = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "pass"
    )
      for (const argument of node.arguments)
        if (ts.isIdentifier(argument)) passed.add(argument.text);
    ts.forEachChild(node, collect);
  };
  collect(file);
  const found = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isVariableDeclaration(node) && passed.has(node.name.getText()))
      return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "pass"
    )
      return;
    if (
      ts.isNewExpression(node) &&
      !errors &&
      ["ServiceError", "Error"].includes(node.expression.getText())
    )
      return;
    if (
      ts.isObjectLiteralExpression(node) &&
      ["passing", "explained"].includes(statusOf(node))
    )
      return;
    const fragments = fragmentsOf(node);
    if (fragments !== null) {
      if (isSentence(fragments)) found.push(fragments);
      if (ts.isStringLiteralLike(node)) return;
    }
    ts.forEachChild(node, visit);
  };
  for (const statement of file.statements) {
    if (names === null) {
      visit(statement);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations)
      if (
        names.includes(declaration.name.getText()) &&
        declaration.initializer !== undefined
      )
        visit(declaration.initializer);
  }
  return found;
}

/** The steps (id, title, docs path) and the failure page's path, read from steps.ts. */
export function stepsIn(text) {
  const file = sourceOf(STEPS_FILE, text);
  let prefix = null;
  let suffix = null;
  let steps = null;
  let failure = null;
  const docsPath = (call) => {
    const page =
      call.arguments[0] === undefined ? null : textOf(call.arguments[0]);
    if (page === null || prefix === null)
      throw new Error(`${STEPS_FILE}: docs(...) is not called with a string.`);
    return `${prefix}${page}${suffix}`;
  };
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const { name, initializer } of statement.declarationList
      .declarations) {
      if (initializer === undefined) continue;
      const id = name.getText();
      if (id === "docs" && ts.isArrowFunction(initializer)) {
        const body = initializer.body;
        if (!ts.isTemplateExpression(body) || body.templateSpans.length !== 1)
          throw new Error(`${STEPS_FILE}: docs is not a one-value template.`);
        prefix = body.head.text;
        suffix = body.templateSpans[0].literal.text;
      }
      if (id === "FAILURE_DOCS_PATH" && ts.isCallExpression(initializer))
        failure = docsPath(initializer);
      if (id === "STEPS" && ts.isArrayLiteralExpression(initializer))
        steps = initializer.elements.map((element) => {
          const step = {};
          for (const property of element.properties) {
            if (!ts.isPropertyAssignment(property)) continue;
            const key = property.name.getText();
            if (key === "id" || key === "title")
              step[key] = textOf(property.initializer);
            if (key === "docs_path")
              step.docs_path = docsPath(property.initializer);
          }
          return step;
        });
    }
  }
  if (steps === null || failure === null)
    throw new Error(`${STEPS_FILE}: no STEPS or FAILURE_DOCS_PATH found.`);
  return { steps, failure };
}

/** A page's front matter title, or null. */
function titleOf(markdown) {
  const front = /^---\n([\s\S]*?)\n---/.exec(markdown)?.[1] ?? "";
  const line = /^title:\s*(.+)$/m.exec(front)?.[1];
  return line === undefined ? null : line.replace(/^(["'])(.*)\1$/, "$2");
}

const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const patternOf = (fragments) =>
  new RegExp(`^${fragments.map(escaped).join(".+")}$`);

/** Every problem, as a sentence that names the page or file it is about. */
export function problems(pages, repository) {
  const found = [];
  const read = (path) => readFileSync(join(repository, path), "utf8");
  const { steps, failure } = stepsIn(read(STEPS_FILE));
  const slugOf = (path) =>
    /^\/docs\/set-up\/([a-z-]+)\/$/.exec(path)?.[1] ?? null;
  const pageOf = (slug) => {
    const path = join(pages, `${slug}.md`);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  };
  const guide = readdirSync(pages)
    .filter((name) => name.endsWith(".md"))
    .map((name) => readFileSync(join(pages, name), "utf8"))
    .join("\n");
  const links = sourceOf(LINKS_FILE, read(LINKS_FILE));
  let addresses = 0;
  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText() === "href" &&
      ts.isStringLiteralLike(node.initializer)
    ) {
      addresses++;
      const href = node.initializer.text;
      if (!guide.includes(href))
        found.push(`set-up/: no page links a Microsoft address: ${href}`);
    }
    ts.forEachChild(node, visit);
  };
  for (const statement of links.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations)
      if (declaration.name.getText() === "MICROSOFT_LINKS") visit(declaration);
  }
  if (addresses === 0)
    throw new Error(`${LINKS_FILE}: no MICROSOFT_LINKS addresses found.`);

  for (const step of steps) {
    const slug = slugOf(step.docs_path);
    if (slug === null) {
      found.push(
        `${STEPS_FILE}: the step ${step.id} links ${step.docs_path}, which is not a page of the set-up part.`,
      );
      continue;
    }
    const page = pageOf(slug);
    if (page === null) {
      found.push(
        `set-up/${slug}.md is missing: the step "${step.title}" links ${step.docs_path}.`,
      );
      continue;
    }
    const title = titleOf(page);
    if (title !== step.title)
      found.push(
        `set-up/${slug}.md: the title is ${JSON.stringify(title)}, but the step's title in the product is ${JSON.stringify(step.title)}.`,
      );
  }

  const failureSlug = slugOf(failure);
  if (failureSlug === null || `${failureSlug}.md` !== FAILURE_PAGE) {
    found.push(
      `${STEPS_FILE}: FAILURE_DOCS_PATH is ${failure}, but this check reads set-up/${FAILURE_PAGE}.`,
    );
    return found;
  }
  const failurePage = pageOf(failureSlug);
  if (failurePage === null) {
    found.push(
      `set-up/${FAILURE_PAGE} is missing: the product links ${failure} beside every step.`,
    );
    return found;
  }
  if (titleOf(failurePage) !== FAILURE_PAGE_TITLE)
    found.push(
      `set-up/${FAILURE_PAGE}: the title must be ${JSON.stringify(FAILURE_PAGE_TITLE)}, the link text the product shows.`,
    );

  const sentences = [];
  for (const name of readdirSync(join(repository, SETUP_SOURCES)).sort()) {
    if (!name.endsWith(".ts") || /\.test\.ts$|_security_test\.ts$/.test(name))
      continue;
    const path = `${SETUP_SOURCES}/${name}`;
    for (const fragments of sentencesIn(path, read(path), {
      errors: REFUSALS_SHOWN.includes(name),
    }))
      sentences.push({ path, fragments });
  }
  for (const fragments of sentencesIn(SCREENED.file, read(SCREENED.file), {
    names: SCREENED.names,
  }))
    sentences.push({ path: SCREENED.file, fragments });

  const quoted = failurePage
    .split("\n")
    .flatMap((line, index) =>
      line.startsWith("> ")
        ? [{ text: line.slice(2).trim(), line: index + 1 }]
        : [],
    );
  for (const { path, fragments } of sentences) {
    const pattern = patternOf(fragments);
    if (!quoted.some((each) => pattern.test(each.text)))
      found.push(
        `set-up/${FAILURE_PAGE} does not quote a sentence of ${path}: ${fragments.join("{...}")}`,
      );
  }
  for (const { text, line } of quoted)
    if (!sentences.some(({ fragments }) => patternOf(fragments).test(text)))
      found.push(
        `set-up/${FAILURE_PAGE}:${String(line)}: no check says this any more: ${text}`,
      );
  return found;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [pages = PAGES, repository = REPOSITORY] = process.argv.slice(2);
  const found = problems(pages, repository);
  if (found.length > 0) {
    for (const each of found) console.error(each);
    console.error(
      `${String(found.length)} problems between the setup guide and the setup's code.`,
    );
    process.exit(1);
  }
  console.log(
    "The setup guide has every step, failure sentence and Microsoft address.",
  );
}
