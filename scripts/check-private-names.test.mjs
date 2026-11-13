import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hits, listPath, parseList } from "./check-private-names.mjs";

const SCRIPT = join(
  resolve(dirname(fileURLToPath(import.meta.url))),
  "check-private-names.mjs",
);

test("reads the list from PBMB_PRIVATE_NAMES, else from the config folder", () => {
  assert.equal(
    listPath({ PBMB_PRIVATE_NAMES: "/x/names" }, "/home/a"),
    "/x/names",
  );
  assert.equal(
    listPath({}, "/home/a"),
    "/home/a/.config/powerbi-metrics-book/private-names",
  );
  assert.equal(
    listPath({ PBMB_PRIVATE_NAMES: "" }, "/home/a"),
    "/home/a/.config/powerbi-metrics-book/private-names",
  );
});

test("skips blank lines and comments, and keeps each entry's line", () => {
  assert.deepEqual(parseList("# clients\nAcme Corp\n\n  globex  \n"), [
    { entry: "acme corp", listLine: 2 },
    { entry: "globex", listLine: 4 },
  ]);
});

test("finds an entry in any case, inside a longer word, every time", () => {
  const entries = parseList("globex\n");
  assert.deepEqual(hits("ok\nGlobex and globexlabs.example", entries), [
    { line: 2, column: 1, listLine: 1 },
    { line: 2, column: 12, listLine: 1 },
  ]);
  assert.deepEqual(hits("Sales and Finance", entries), []);
});

test("fails on a hit without printing the entry, and passes without a list", () => {
  const folder = mkdtempSync(join(tmpdir(), "private-names-"));
  try {
    const list = join(folder, "names");
    const message = join(folder, "message.txt");
    writeFileSync(list, "globex\n");
    writeFileSync(message, "Port the search page from Globex's catalog\n");

    const hit = spawnSync("node", [SCRIPT, message], {
      env: { ...process.env, PBMB_PRIVATE_NAMES: list },
      encoding: "utf8",
    });
    assert.equal(hit.status, 1);
    assert.match(hit.stderr, /message\.txt:1:27: entry on line 1/);
    assert.doesNotMatch(hit.stderr, /globex/i);

    writeFileSync(message, "Port the search page from the reference catalog\n");
    const clean = spawnSync("node", [SCRIPT, message], {
      env: { ...process.env, PBMB_PRIVATE_NAMES: list },
      encoding: "utf8",
    });
    assert.equal(clean.status, 0);

    const none = spawnSync("node", [SCRIPT, message], {
      env: { ...process.env, PBMB_PRIVATE_NAMES: join(folder, "absent") },
      encoding: "utf8",
    });
    assert.equal(none.status, 0);
    assert.match(none.stderr, /No private-names list/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
