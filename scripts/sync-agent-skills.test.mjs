import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { skillDifferences, syncSkills } from "./sync-agent-skills.mjs";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "sync-agent-skills.mjs",
);

function repositoryWith(files) {
  const root = mkdtempSync(join(tmpdir(), "pbmb-skills-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function runCli(root, ...flags) {
  return spawnSync("node", [SCRIPT, "--root", root, ...flags], {
    encoding: "utf8",
  });
}

test("--check fails after a line is changed in a skill and not synced", () => {
  const root = repositoryWith({
    "skills/query_power_bi/SKILL.md":
      "---\nname: query_power_bi\n---\nSearch first.\n",
  });
  assert.equal(runCli(root).status, 0);
  assert.equal(runCli(root, "--check").status, 0);

  writeFileSync(
    join(root, "skills/query_power_bi/SKILL.md"),
    "---\nname: query_power_bi\n---\nSearch first, then query.\n",
  );
  const stale = runCli(root, "--check");
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /query_power_bi\/SKILL\.md/);

  assert.equal(runCli(root).status, 0);
  assert.equal(runCli(root, "--check").status, 0);
});

test("sync copies a skill's whole folder and leaves the subagents folder out", () => {
  const root = repositoryWith({
    "skills/answer_questions/SKILL.md": "a\n",
    "skills/answer_questions/notes/extra.md": "b\n",
    "skills/agents/metrics_curator.md": "c\n",
    "skills/AGENTS.md": "d\n",
  });
  syncSkills({ root });
  assert.equal(
    readFileSync(
      join(root, ".agents/skills/answer_questions/notes/extra.md"),
      "utf8",
    ),
    "b\n",
  );
  assert.equal(existsSync(join(root, ".agents/skills/agents")), false);
  assert.equal(existsSync(join(root, ".agents/skills/AGENTS.md")), false);
});

test("a skill removed from skills is removed from .agents/skills, and --check names it", () => {
  const root = repositoryWith({
    "skills/one/SKILL.md": "one\n",
    ".agents/skills/gone/SKILL.md": "gone\n",
  });
  assert.deepEqual(skillDifferences({ root }), [
    ".agents/skills/one: missing",
    ".agents/skills/gone: no such skill in skills/",
  ]);
  syncSkills({ root });
  assert.equal(existsSync(join(root, ".agents/skills/gone")), false);
  assert.deepEqual(skillDifferences({ root }), []);
});

test("a symlink in .agents/skills is a difference, and sync replaces it with a copy", () => {
  const root = repositoryWith({ "skills/one/SKILL.md": "one\n" });
  mkdirSync(join(root, ".agents/skills"), { recursive: true });
  symlinkSync(join(root, "skills/one"), join(root, ".agents/skills/one"));
  assert.deepEqual(skillDifferences({ root }), [
    ".agents/skills/one: is a symlink, not a copy",
  ]);
  syncSkills({ root });
  assert.equal(
    lstatSync(join(root, ".agents/skills/one")).isSymbolicLink(),
    false,
  );
  assert.deepEqual(skillDifferences({ root }), []);
});

test("a file only in .agents/skills/<skill> is a difference", () => {
  const root = repositoryWith({
    "skills/one/SKILL.md": "one\n",
    ".agents/skills/one/SKILL.md": "one\n",
    ".agents/skills/one/extra.md": "x\n",
  });
  assert.deepEqual(skillDifferences({ root }), [
    ".agents/skills/one/extra.md: not in skills/one",
  ]);
});
