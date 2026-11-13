#!/usr/bin/env node
// Builds the whole of powerbimetricsbook.io into dist/: the docs first, built
// for the public site (PBMB_DOCS_SITE=1), then the landing page, then the docs
// build copied to dist/docs. The copy has to come last, because the landing
// page's `astro build` empties apps/site/dist first.
//
//   pnpm --filter @powerbi-metrics-book/site build

import { execFileSync } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = fileURLToPath(new URL("..", import.meta.url));
const DOCS = join(SITE, "../docs");

const run = (command, words, env = {}) =>
  execFileSync(command, words, {
    cwd: SITE,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });

run("pnpm", ["--filter", "@powerbi-metrics-book/docs", "build"], {
  PBMB_DOCS_SITE: "1",
});
run("pnpm", ["exec", "astro", "build"]);

const from = join(DOCS, "dist");
if (!existsSync(join(from, "index.html")))
  throw new Error(`${from} holds no docs build.`);
cpSync(from, join(SITE, "dist/docs"), { recursive: true });
