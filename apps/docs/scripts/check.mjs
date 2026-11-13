#!/usr/bin/env node
// Runs every scripts/check-*.mjs in turn and fails if any does. A later issue
// adds a check by adding a file here, with no change to this one. Every check
// runs even after one fails, so one run lists everything that is wrong.
//
//   pnpm --filter @powerbi-metrics-book/docs check

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCRIPTS = fileURLToPath(new URL(".", import.meta.url));

const checks = readdirSync(SCRIPTS)
  .filter((name) => /^check-.+\.mjs$/.test(name))
  .sort();

const failed = checks.filter((name) => {
  console.log(`> ${name}`);
  const { status } = spawnSync(process.execPath, [`${SCRIPTS}${name}`], {
    stdio: "inherit",
  });
  return status !== 0;
});

if (failed.length > 0) {
  console.error(`Failed: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`All ${String(checks.length)} checks passed.`);
