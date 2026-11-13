#!/usr/bin/env node
// Keeps .agents/skills (what Codex reads) a copy of skills/ (what the Claude
// plugin publishes). Codex follows copies, never symlinks, so the two folders
// are kept equal by this script and not by a link.
// Usage: node scripts/sync-agent-skills.mjs          copy skills/ over .agents/skills/
//        node scripts/sync-agent-skills.mjs --check  exit 1 and name each difference
// A skill is a folder of skills/ that holds a SKILL.md; skills/agents/ (the
// subagents) and skills/AGENTS.md are not skills and are not copied.
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = "skills";
const TARGET = ".agents/skills";

function skillNames(root) {
  const folder = join(root, SOURCE);
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && existsSync(join(folder, entry.name, "SKILL.md")),
    )
    .map((entry) => entry.name)
    .sort();
}

function copiedNames(root) {
  const folder = join(root, TARGET);
  if (!existsSync(folder)) return [];
  return readdirSync(folder).sort();
}

function filesUnder(folder, prefix = "") {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    return entry.isDirectory()
      ? filesUnder(join(folder, entry.name), relative)
      : [relative];
  });
}

function compareSkill(root, name) {
  const from = join(root, SOURCE, name);
  const to = join(root, TARGET, name);
  if (!existsSync(to)) return [`${TARGET}/${name}: missing`];
  if (lstatSync(to).isSymbolicLink())
    return [`${TARGET}/${name}: is a symlink, not a copy`];
  const wanted = filesUnder(from);
  const found = filesUnder(to);
  return [
    ...wanted.flatMap((file) => {
      if (!found.includes(file)) return [`${TARGET}/${name}/${file}: missing`];
      const same = readFileSync(join(from, file)).equals(
        readFileSync(join(to, file)),
      );
      return same
        ? []
        : [`${TARGET}/${name}/${file}: differs from ${SOURCE}/${name}/${file}`];
    }),
    ...found
      .filter((file) => !wanted.includes(file))
      .map((file) => `${TARGET}/${name}/${file}: not in ${SOURCE}/${name}`),
  ];
}

/** Every way .agents/skills differs from skills/, one sentence each. */
export function skillDifferences({ root }) {
  const skills = skillNames(root);
  const stale = copiedNames(root)
    .filter((name) => !skills.includes(name))
    .map((name) => `${TARGET}/${name}: no such skill in ${SOURCE}/`);
  return [...skills.flatMap((name) => compareSkill(root, name)), ...stale];
}

/** Makes .agents/skills a copy of skills/, removing what skills/ no longer has. */
export function syncSkills({ root }) {
  const skills = skillNames(root);
  mkdirSync(join(root, TARGET), { recursive: true });
  for (const name of copiedNames(root)) {
    if (!skills.includes(name))
      rmSync(join(root, TARGET, name), { recursive: true });
  }
  for (const name of skills) {
    rmSync(join(root, TARGET, name), { recursive: true, force: true });
    cpSync(join(root, SOURCE, name), join(root, TARGET, name), {
      recursive: true,
      dereference: true,
    });
  }
}

function main(argv) {
  const flags = [...argv];
  const rootAt = flags.indexOf("--root");
  const root =
    rootAt === -1
      ? resolve(dirname(fileURLToPath(import.meta.url)), "..")
      : resolve(flags.splice(rootAt, 2)[1]);
  const check = flags.includes("--check");
  const unknown = flags.filter((flag) => flag !== "--check");
  if (unknown.length > 0) {
    console.error(`Unknown option ${unknown[0]}. Use --check or nothing.`);
    return 2;
  }
  if (!check) {
    syncSkills({ root });
    return 0;
  }
  const differences = skillDifferences({ root });
  for (const line of differences) console.error(line);
  if (differences.length > 0) {
    console.error(
      `${differences.length} difference(s). Run: node scripts/sync-agent-skills.mjs`,
    );
    return 1;
  }
  return 0;
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2));
}
