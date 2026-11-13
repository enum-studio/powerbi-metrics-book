import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { skippedTests, unpinnedImages } from "./check-all.mjs";

const DIGEST = `sha256:${"a".repeat(64)}`;

test("a FROM without a digest is reported", () => {
  assert.deepEqual(unpinnedImages("FROM node:24-slim AS build\n"), [
    "FROM node:24-slim AS build",
  ]);
});

test("a FROM pinned by digest passes", () => {
  assert.deepEqual(unpinnedImages(`FROM node:24-slim@${DIGEST}\n`), []);
});

test("a stage named by an earlier FROM passes", () => {
  const text = `FROM node:24-slim@${DIGEST} AS base\nFROM base AS build\n`;
  assert.deepEqual(unpinnedImages(text), []);
});

test("PBMB_IMAGE with no default passes: the build hands it in with its digest", () => {
  const text = `ARG PBMB_IMAGE\nFROM \${PBMB_IMAGE} AS release\nFROM node:24-slim@${DIGEST}\n`;
  assert.deepEqual(unpinnedImages(text), []);
});

test("PBMB_IMAGE with an unpinned default is reported", () => {
  const text = "ARG PBMB_IMAGE=node:24-slim\nFROM ${PBMB_IMAGE}\n";
  assert.equal(unpinnedImages(text).length, 1);
});

test("another ARG with no default is reported", () => {
  const text = "ARG BASE\nFROM ${BASE}\n";
  assert.deepEqual(unpinnedImages(text), ["FROM ${BASE}"]);
});

test("a FROM naming an ARG that was never declared is reported", () => {
  assert.equal(unpinnedImages("FROM ${BASE}\n").length, 1);
});

test("an ARG with a pinned default passes", () => {
  const text = `ARG BASE=node:24-slim@${DIGEST}\nFROM \${BASE}\n`;
  assert.deepEqual(unpinnedImages(text), []);
});

test("the skipped-test guard reads the number before the word (vitest, pytest)", () => {
  assert.equal(skippedTests("Tests  3 passed | 2 skipped (5)\n"), 2);
  assert.equal(skippedTests("== 4 passed, 1 skipped in 0.2s ==\n"), 1);
});

test("the skipped-test guard reads the number after the word (node --test)", () => {
  assert.equal(skippedTests("ℹ pass 4\nℹ fail 0\nℹ skipped 1\nℹ todo 0\n"), 1);
});

test("a run with no skipped tests counts zero in either form", () => {
  assert.equal(skippedTests("ℹ skipped 0\nTests  3 passed (3)\n"), 0);
});

test("a skipped test in a real node --test run is counted", () => {
  const folder = mkdtempSync(join(tmpdir(), "pbmb-skip-"));
  try {
    const file = join(folder, "skipped.test.mjs");
    writeFileSync(
      file,
      'import { test } from "node:test";\ntest("not today", { skip: true }, () => {});\n',
    );
    // Inside a test run, NODE_TEST_CONTEXT makes a nested run print for its
    // parent instead of as text; without it the run prints what a person sees.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const { stdout, stderr } = spawnSync(process.execPath, ["--test", file], {
      encoding: "utf8",
      env,
    });
    assert.equal(skippedTests(stdout + stderr), 1);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
