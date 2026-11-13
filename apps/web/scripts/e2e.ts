// The whole web e2e, in order: the setup's first run on a stack with no admin
// (dev-stack.mjs up --no-setup), then every other spec and check:ui on a
// fresh dev stack (dev:up). Exits non-zero when any phase fails, prints the
// services' logs (dev:logs) when one did, and always takes the stack down.
// pnpm --filter @powerbi-metrics-book/web test:e2e.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const DEV_STACK = fileURLToPath(
  new URL("../../../scripts/dev-stack.mjs", import.meta.url),
);

/** Runs a command in apps/web with the output shown; whether it exited 0. */
function run(
  command: string,
  words: string[],
  env: Record<string, string> = {},
): boolean {
  console.log(`\n> ${[command, ...words].join(" ")}`);
  const { status, error } = spawnSync(command, words, {
    cwd: WEB,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (error !== undefined) throw error;
  return status === 0;
}

const stack = (...words: string[]) => run("node", [DEV_STACK, ...words]);
const playwright = (words: string[], env: Record<string, string> = {}) =>
  run("pnpm", ["exec", "playwright", "test", ...words], env);

const failed: string[] = [];
let finished = false;
try {
  if (!stack("reset") || !stack("up", "--no-setup"))
    throw new Error("The stack with no admin did not start.");
  if (!playwright(["--project=first-run"], { PBMB_E2E_FIRST_RUN: "1" }))
    failed.push("the setup's first run (--project=first-run)");
  if (!stack("reset") || !stack("up"))
    throw new Error("The dev stack did not start.");
  if (!playwright([])) failed.push("the specs (playwright test)");
  if (!run("pnpm", ["check:ui"])) failed.push("check:ui");
  finished = true;
} finally {
  // The services' logs go with the stack, so a failed run prints them first.
  if (!finished || failed.length > 0) stack("logs");
  stack("down");
}
if (failed.length > 0) {
  console.error(`\nThe web e2e failed: ${failed.join(", ")}.`);
  process.exit(1);
}
console.log("\nThe web e2e passed: the first run, the specs and check:ui.");
