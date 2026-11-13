#!/usr/bin/env node
// Tier 3 of the test tiers (docs/specs, "Test tiers"): every check, every
// test, the scanners and the end-to-end tests, in one command.
//   pnpm check:all                  every step, in order
//   pnpm check:all --only scanners  the steps of one group, or whose name holds the text
//   pnpm check:all --list           the steps and their groups
// A step's output goes to a log file; the run shows each step's result and
// duration, the last lines of a failed one, and a table at the end. A failure
// does not stop the run. Exits 1 when any step failed. Needs Docker, uv and
// pnpm; the stack steps start the dev stack, so hold the stack lock first.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listPath as privateNamesList } from "./check-private-names.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const API = "@powerbi-metrics-book/api";
const WEB = "@powerbi-metrics-book/web";
const DOCS = "@powerbi-metrics-book/docs";
const MOCK = "@powerbi-metrics-book/powerbi-mock";
const TOKENS = "@enum-studio/tokens";

// The scanners run from these images, by digest, so a run today and a run in
// a year use the same tool. Raise a version on purpose, with its digest.
const IMAGES = {
  gitleaks:
    "ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f",
  osv: "ghcr.io/google/osv-scanner:v2.7.0@sha256:4f3b7e2c64b9d38a5febc5a7e4a3dfef1d1362f726dea7a2ef4762b46469fcd0",
  trivy:
    "ghcr.io/aquasecurity/trivy:0.76.1@sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c",
  semgrep:
    "semgrep/semgrep:1.182.0@sha256:4a34048c04fef049f71665047f074cffb00cc3d89482f965a5cd151d589237af",
  zizmor:
    "ghcr.io/zizmorcore/zizmor:1.31.1@sha256:42d409dbb851d4c5d35a058cf042b828bea1e3f2884378c526eb0974780e18d9",
};

// One image tag and one scratch folder (logs, the image file) per checkout, so two checkouts running
// at once do not take each other's image or files.
const CHECKOUT = createHash("sha256").update(ROOT).digest("hex").slice(0, 8);
const IMAGE_TAG = `pbmb-check-all-api:${CHECKOUT}`;
const WORK = join(tmpdir(), `pbmb-check-all-${CHECKOUT}`);
// Trivy's vulnerability database, kept between runs: it is about 80 MB.
const TRIVY_CACHE = join(homedir(), ".cache", "pbmb-check-all", "trivy");

class Failed extends Error {}

/** Runs a command, adding its output to the step's log; throws Failed unless it exits 0. */
function run(log, argv, { cwd = ROOT, env = {} } = {}) {
  appendFileSync(log, `$ ${argv.join(" ")}\n`);
  const fd = openSync(log, "a");
  try {
    const { status, signal, error } = spawnSync(argv[0], argv.slice(1), {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", fd, fd],
    });
    if (error !== undefined) throw error;
    if (status !== 0)
      throw new Failed(`${argv[0]} exited with ${String(status ?? signal)}`);
  } finally {
    closeSync(fd);
  }
}

/** The whole output of a command, or null when it fails. */
function capture(argv) {
  const { status, stdout } = spawnSync(argv[0], argv.slice(1), {
    cwd: ROOT,
    encoding: "utf8",
  });
  return status === 0 ? stdout.trim() : null;
}

const pnpm = (...words) => ["pnpm", ...words];
const uv = (...words) => ["uv", "run", ...words];

/** A tool from its pinned image, with the checkout mounted read-only at /src. */
function container(image, words, { mounts = [] } = {}) {
  // A worktree's .git is a file that points into the main checkout's .git;
  // git inside the container reads the history only if that folder is there.
  const common = capture([
    "git",
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const history =
    common !== null && !common.startsWith(`${ROOT}/`)
      ? [`${common}:${common}:ro`]
      : [];
  return [
    "docker",
    "run",
    "--rm",
    ...[`${ROOT}:/src:ro`, ...history, ...mounts].flatMap((mount) => [
      "--volume",
      mount,
    ]),
    "--workdir",
    "/src",
    image,
    ...words,
  ];
}

const steps = [];
/** Adds a step: its group, its name, and a function that throws when it fails. */
function step(group, name, body, { skip = null, noSkippedTests = false } = {}) {
  steps.push({ group, name, body, skip, noSkippedTests });
}
const command = (group, name, argv, options) =>
  step(group, name, (log) => run(log, argv), options);

/**
 * How many skipped tests a runner's output reports. vitest and pytest put the
 * number before the word ("2 skipped"); node --test puts it after ("skipped 2").
 */
export function skippedTests(output) {
  return [...output.matchAll(/\b(\d+) skipped\b|\bskipped (\d+)\b/g)]
    .map((match) => Number(match[1] ?? match[2]))
    .reduce((sum, count) => sum + count, 0);
}

// A skipped test counts as a failed test (CONTRIBUTING.md).
function assertNoSkippedTests(log) {
  const skipped = skippedTests(readFileSync(log, "utf8"));
  if (skipped > 0)
    throw new Failed(`${String(skipped)} skipped tests; a skip is a failure`);
}

// Formatting, lint and types.
command("lint", "prettier", pnpm("fmt:check"));
// The docs' `astro:content` types are generated into apps/docs/.astro, which
// is not committed; without them eslint reports three errors in the docs on a
// fresh checkout. `astro sync` writes them and builds nothing.
step("lint", "eslint", (log) => {
  run(log, pnpm("--filter", DOCS, "exec", "astro", "sync"));
  run(log, pnpm("lint"));
});
command("lint", "typescript", pnpm("typecheck"));
command("lint", "ruff format", uv("ruff", "format", "--check"));
command("lint", "ruff check", uv("ruff", "check"));
command("lint", "mypy", uv("mypy", "apps/cli/src"));

// Builds. The docs build comes before the docs check, which reads dist/.
command("build", "build api", pnpm("--filter", API, "build"));
command("build", "build web", pnpm("--filter", WEB, "build"));
command("build", "build docs", pnpm("--filter", DOCS, "build"));
command("build", "build mock", pnpm("--filter", MOCK, "build"));
command("build", "build image", [
  "docker",
  "build",
  "-f",
  "apps/api/Dockerfile",
  "-t",
  IMAGE_TAG,
  ".",
]);

// Tests.
const tests = { noSkippedTests: true };
command("test", "test api", pnpm("--filter", API, "test"), tests);
command("test", "test mock", pnpm("--filter", MOCK, "test"), tests);
command("test", "test tokens", pnpm("--filter", TOKENS, "test"), tests);
command("test", "test web", pnpm("--filter", WEB, "test"), tests);
command("test", "test cli", uv("pytest", "apps/cli/tests", "-q"), tests);
command("test", "cerbos policy tests", ["bash", "access/run_policy_tests.sh"]);
command(
  "test",
  "script tests",
  ["node", "--test", "scripts/*.test.mjs"],
  tests,
);

const BUILD_SUPPLIED_IMAGE = "PBMB_IMAGE";

/** The FROM lines of a Dockerfile that name an image no digest pins. */
export function unpinnedImages(text) {
  const stages = new Set();
  const defaults = new Map();
  const found = [];
  for (const line of text.split("\n")) {
    const declaration = /^\s*ARG\s+(\w+)(?:=(\S*))?/i.exec(line);
    if (declaration !== null)
      defaults.set(declaration[1], declaration[2] ?? null);
    const from = /^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (from === null) continue;
    let [, image, stage] = from;
    const variable = /^\$\{?(\w+)\}?$/.exec(image);
    if (variable !== null) {
      // Only PBMB_IMAGE may have no default: deploy/cerbos.Dockerfile takes
      // the release image with its digest from whoever builds (Railway's
      // service variable, the Azure guide's az acr build). Any other ARG
      // without a default would let a Dockerfile skip this check. An ARG with
      // a default is checked like a literal.
      const value = defaults.get(variable[1]);
      if (variable[1] === BUILD_SUPPLIED_IMAGE && value === null) {
        if (stage !== undefined) stages.add(stage.toLowerCase());
        continue;
      }
      if (value === null || value === undefined) {
        found.push(line.trim());
        if (stage !== undefined) stages.add(stage.toLowerCase());
        continue;
      }
      image = value;
    }
    const pinned = /@sha256:[0-9a-f]{64}$/.test(image);
    if (!pinned && image !== "scratch" && !stages.has(image.toLowerCase()))
      found.push(line.trim());
    if (stage !== undefined) stages.add(stage.toLowerCase());
  }
  return found;
}

step("test", "every Dockerfile FROM pinned by digest", (log) => {
  const files = capture([
    "git",
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  if (files === null) throw new Failed("git ls-files failed");
  const dockerfiles = files
    .split("\n")
    .filter((file) =>
      /^(.+\.)?Dockerfile(\.(?!dockerignore$).+)?$/.test(basename(file)),
    );
  if (dockerfiles.length === 0) throw new Failed("No Dockerfile found.");
  const problems = dockerfiles.flatMap((file) =>
    unpinnedImages(readFileSync(join(ROOT, file), "utf8")).map(
      (line) => `${file}: ${line}`,
    ),
  );
  appendFileSync(log, `${dockerfiles.join("\n")}\n`);
  if (problems.length > 0) {
    appendFileSync(log, `Not pinned by digest:\n${problems.join("\n")}\n`);
    throw new Failed(`${String(problems.length)} FROM lines without a digest`);
  }
});

// How a host that deploys a fresh clone gets the commit into the image: with no
// GIT_SHA, from a loose ref and from a packed one. Of .git, only HEAD and the
// refs reach the build: .git/config can hold the token the host cloned with.
step("test", "image reads the commit from a clone", (log) => {
  const clone = join(WORK, "clone");
  rmSync(clone, { recursive: true, force: true });
  run(log, ["git", "clone", "--depth", "1", `file://${ROOT}`, clone]);
  const expected = capture(["git", "-C", clone, "rev-parse", "HEAD"]);
  const tag = `${IMAGE_TAG}-from-clone`;
  const dockerfile = join(ROOT, "apps/api/Dockerfile");
  const build = (...flags) =>
    run(log, ["docker", "build", ...flags, "-f", dockerfile, "-t", tag, clone]);
  const inImage = (script) => {
    const output = capture([
      "docker",
      "run",
      "--rm",
      "--entrypoint",
      "sh",
      tag,
      "-c",
      script,
    ]);
    if (output === null) throw new Failed(`docker run failed: ${script}`);
    return output;
  };
  const compareCommit = () => {
    build();
    const found = inImage('cat "$GIT_SHA_FILE"');
    if (found !== expected)
      throw new Failed(`expected ${expected}, the image holds ${found}`);
  };
  try {
    compareCommit();
    run(log, ["git", "-C", clone, "pack-refs", "--all"]);
    compareCommit();
    build("--target", "commit");
    const files = inImage("cd /git && find . -type f");
    appendFileSync(log, `${files}\n`);
    const allowed = /^\.\/(HEAD|package\.json|packed-refs|refs\/heads\/.+)$/;
    const others = files.split("\n").filter((file) => !allowed.test(file));
    if (others.length > 0)
      throw new Failed(`reached the build from .git: ${others.join(", ")}`);
    rmSync(join(clone, ".git"), { recursive: true });
    build("--target", "commit");
    if (inImage("cat /git_sha") !== "")
      throw new Failed("a context with no .git left a commit in the image");
  } finally {
    run(log, ["docker", "rmi", tag]);
  }
});

// The merge gate's check, against where this branch left main. The gate
// compares with main itself.
command("generated", "migrations are safe and match the schema", [
  "node",
  "scripts/check-migrations.mjs",
]);
step("generated", "openapi.json matches the routes", (log) => {
  const file = join(ROOT, "apps/api/openapi.json");
  const committed = readFileSync(file);
  try {
    run(log, pnpm("--filter", API, "openapi"));
    if (!committed.equals(readFileSync(file)))
      throw new Failed(
        "apps/api/openapi.json differs from what the routes generate; run pnpm --filter @powerbi-metrics-book/api openapi",
      );
  } finally {
    writeFileSync(file, committed);
  }
});
command(
  "generated",
  "cli assets",
  uv("python", "apps/cli/scripts/sync_assets.py", "--check"),
);
command("generated", "codex skills", [
  "node",
  "scripts/sync-agent-skills.mjs",
  "--check",
]);
// The docs' check runs every apps/docs/scripts/check-*.mjs, the generated
// reference pages' (check-reference.mjs) among them.
command(
  "generated",
  "docs check and reference pages",
  pnpm("--filter", DOCS, "check"),
);
command(
  "generated",
  "readme links",
  ["node", "scripts/check-readme-links.mjs"],
  {
    skip: () =>
      existsSync(join(ROOT, "scripts/check-readme-links.mjs"))
        ? null
        : "scripts/check-readme-links.mjs is absent",
  },
);
command("generated", "deploy guides", ["bash", "deploy/check.sh"]);

// The maintainer's private names (scripts/check-private-names.mjs), over
// every tracked file. The list lives outside the repository, so a checkout
// without one skips this step.
command(
  "scanners",
  "private names",
  ["node", "scripts/check-private-names.mjs"],
  {
    skip: () =>
      existsSync(privateNamesList())
        ? null
        : `no private-names list at ${privateNamesList()}`,
  },
);

// Scanners. A finding is a failure unless the scanner's allowlist
// names it with a reason and a date to look at it again: .gitleaks.toml,
// .osv-scanner.toml, .trivyignore.yaml. Semgrep and zizmor take no allowlist
// file: a finding is fixed, or the line says `nosemgrep` / `zizmor: ignore`
// and why.
command(
  "scanners",
  "gitleaks over the history",
  container(IMAGES.gitleaks, [
    "git",
    "--config=/src/.gitleaks.toml",
    "--redact",
    "--verbose",
    "--no-banner",
    "--no-color",
    "/src",
  ]),
);
command(
  "scanners",
  "osv-scanner over both lockfiles",
  container(IMAGES.osv, [
    "scan",
    "source",
    "--config=/src/.osv-scanner.toml",
    "--lockfile=/src/pnpm-lock.yaml",
    "--lockfile=/src/uv.lock",
  ]),
);

const trivy = (words, mounts = []) => {
  mkdirSync(TRIVY_CACHE, { recursive: true });
  return container(
    IMAGES.trivy,
    [
      ...words,
      "--cache-dir=/cache",
      "--severity=HIGH,CRITICAL",
      "--exit-code=1",
      "--ignorefile=/src/.trivyignore.yaml",
    ],
    { mounts: [`${TRIVY_CACHE}:/cache`, ...mounts] },
  );
};
step("scanners", "trivy over the built image", (log) => {
  // From a file, so the scanner gets no access to the Docker socket.
  run(log, ["docker", "save", "--output", join(WORK, "image.tar"), IMAGE_TAG]);
  run(
    log,
    trivy(
      ["image", "--no-progress", "--input=/work/image.tar"],
      [`${WORK}:/work:ro`],
    ),
  );
});
command(
  "scanners",
  "trivy over the filesystem",
  trivy([
    "fs",
    "--no-progress",
    "--scanners=vuln,misconfig,secret",
    "--skip-dirs=node_modules,.venv,.claude/worktrees,.git,dist",
    "/src",
  ]),
);
// Trivy reads no Compose file (`trivy config` finds no config file in
// stack/compose.yml), so what it can check of the stack is the third-party
// images the file pins by digest. The api image is the built one above.
step("scanners", "trivy over the images stack/compose.yml pins", (log) => {
  const compose = readFileSync(join(ROOT, "stack/compose.yml"), "utf8");
  const images = [
    ...compose.matchAll(/^\s*image:\s+(\S+@sha256:[0-9a-f]{64})\s*$/gm),
  ].map((match) => match[1]);
  if (images.length === 0)
    throw new Failed("No image pinned by digest in stack/compose.yml.");
  // gosu, the Go program the upstream pgvector image uses to drop from root,
  // is skipped rather than allowlisted per CVE. Upstream gosu does not rebuild
  // for Go standard library advisories, so every new one would need an entry.
  // It never runs in Compose (the containers start as user 999:999, so the
  // entry point skips `exec gosu`) and never in Azure (the bicep overrides the
  // command with `bash -c`). On Railway it runs once, at the entry point. It
  // does no TLS and takes no network input. Everything else in the image is
  // still scanned.
  const skipGosu = (image) =>
    image.startsWith("pgvector/pgvector:")
      ? ["--skip-files=usr/local/bin/gosu"]
      : [];
  // Every image is scanned, so one run lists every finding.
  const failed = images.filter((image) => {
    try {
      run(log, trivy(["image", "--no-progress", ...skipGosu(image), image]));
      return false;
    } catch (error) {
      if (!(error instanceof Failed)) throw error;
      return true;
    }
  });
  if (failed.length > 0) throw new Failed(`findings in ${failed.join(", ")}`);
});
command(
  "scanners",
  "semgrep rule tests",
  container(IMAGES.semgrep, [
    "semgrep",
    "--test",
    "--metrics=off",
    ".semgrep/",
  ]),
);
command(
  "scanners",
  "semgrep",
  container(IMAGES.semgrep, [
    "semgrep",
    "scan",
    "--error",
    "--metrics=off",
    "--config=.semgrep/",
    "--config=p/typescript",
    "--config=p/python",
    "--exclude=node_modules",
    "--exclude=.venv",
    "--exclude=.claude",
    "--exclude=dist",
    ".",
  ]),
);
command(
  "scanners",
  "zizmor over the workflows",
  container(IMAGES.zizmor, ["--no-progress", ".github/workflows/"]),
);

// These two start the dev stack and the end-to-end stack, one at a time.
command(
  "ui",
  "web e2e: the specs, then check:ui on the dev stack",
  pnpm("--filter", WEB, "test:e2e"),
);
command("e2e", "api end-to-end test", pnpm("--filter", API, "test:e2e"));

const SECOND = 1000;
function duration(milliseconds) {
  const seconds = milliseconds / SECOND;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes)}m ${String(Math.round(seconds - minutes * 60)).padStart(2, "0")}s`;
}

function tail(log, lines) {
  return readFileSync(log, "utf8")
    .trimEnd()
    .split("\n")
    .slice(-lines)
    .join("\n");
}

function main(argv) {
  const only = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--only" && argv[i + 1] !== undefined) only.push(argv[++i]);
    else if (argv[i] === "--list") {
      for (const { group, name } of steps)
        console.log(`${group.padEnd(10)}${name}`);
      return 0;
    } else {
      console.error(
        `Unknown option ${argv[i]}. Use --only <group or text> or --list.`,
      );
      return 2;
    }
  }
  const chosen = steps.filter(
    ({ group, name }) =>
      only.length === 0 ||
      only.some((text) => group === text || name.includes(text)),
  );
  if (chosen.length === 0) {
    console.error("No step matches. Run with --list to see them.");
    return 2;
  }

  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  console.log(`Logs: ${WORK}`);
  const results = [];
  chosen.forEach((current, index) => {
    const log = join(
      WORK,
      `${String(index + 1).padStart(2, "0")}-${current.name.replace(/\W+/g, "-")}.log`,
    );
    console.log(
      `\n> [${String(index + 1)}/${String(chosen.length)}] ${current.name}`,
    );
    const skipped = current.skip?.() ?? null;
    if (skipped !== null) {
      console.log(`  skipped: ${skipped}`);
      results.push({ ...current, result: "skipped", time: 0 });
      return;
    }
    const started = performance.now();
    let failure = null;
    try {
      current.body(log);
      if (current.noSkippedTests) assertNoSkippedTests(log);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    const time = performance.now() - started;
    results.push({
      ...current,
      result: failure === null ? "pass" : "FAIL",
      time,
    });
    if (failure === null) {
      console.log(`  pass  ${duration(time)}`);
    } else {
      console.log(`  FAIL  ${duration(time)}  ${failure}`);
      if (existsSync(log))
        console.log(`${tail(log, 25)}\n  (full output: ${log})`);
    }
  });

  const width = Math.max(...results.map(({ name }) => name.length));
  console.log(`\n${"Step".padEnd(width)}  Result   Time`);
  for (const { name, result, time } of results)
    console.log(
      `${name.padEnd(width)}  ${result.padEnd(7)}  ${result === "skipped" ? "" : duration(time)}`,
    );
  const failed = results.filter(({ result }) => result === "FAIL");
  console.log(
    `\n${String(results.length - failed.length)} of ${String(results.length)} steps passed` +
      `, in ${duration(results.reduce((sum, { time }) => sum + time, 0))}.` +
      (failed.length > 0
        ? ` Failed: ${failed.map(({ name }) => name).join(", ")}.`
        : ""),
  );
  return failed.length > 0 ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const code = main(process.argv.slice(2));
  // The image is this run's own; the logs stay for reading.
  rmSync(join(WORK, "image.tar"), { force: true });
  if (capture(["docker", "image", "inspect", IMAGE_TAG]) !== null) {
    const { status } = spawnSync("docker", ["rmi", IMAGE_TAG], {
      stdio: "ignore",
    });
    if (status !== 0) console.warn(`Could not remove the image ${IMAGE_TAG}.`);
  }
  process.exit(code);
}
