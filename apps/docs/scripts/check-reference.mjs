#!/usr/bin/env node
// Fails when a generated reference page differs from what the code now says.
// gen-reference.mjs does the comparison and names each stale page and the
// command that regenerates it.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const { status } = spawnSync(
  process.execPath,
  [fileURLToPath(new URL("gen-reference.mjs", import.meta.url)), "--check"],
  { stdio: "inherit" },
);
process.exit(status ?? 1);
