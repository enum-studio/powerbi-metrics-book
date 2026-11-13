import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { devIdentity, gitSha } from "../../../scripts/dev-stack.mjs";

/** The checkout's root, as the dev stack names it, so the hash is the same for the same checkout. */
export const ROOT = realpathSync(
  fileURLToPath(new URL("../../..", import.meta.url)),
);

export type E2eStack = {
  project: string;
  api_port: number;
  mock_port: number;
  /** PUBLIC_BASE_URL: where the test, the CLI and the MCP client reach the api. */
  url: string;
  /** The mock on its published port, for its control routes. */
  mock_url: string;
  /** What compose interpolates: the ports, the project and this run's throwaway passwords. */
  env: Record<string, string>;
};

const PASSWORDS = [
  "POSTGRES_PASSWORD",
  "MIGRATOR_PASSWORD",
  "API_RW_PASSWORD",
  "WORKER_RW_PASSWORD",
  "AUDIT_WRITER_PASSWORD",
  "AUTH_SECRET",
];
const POOLS_FULL = "all predefined address pools have been fully subnetted";

/**
 * This checkout's end-to-end stack: the dev stack's identity of its stack/e2e
 * directory, so it runs beside the dev stack. Volumes start empty every run,
 * so the passwords are new each time.
 */
export function openStack(): E2eStack {
  const identity = devIdentity(join(ROOT, "stack", "e2e"));
  const project = identity.project.replace(/^pbmb_/, "pbmb_e2e_");
  const url = `http://localhost:${String(identity.api_port)}`;
  return {
    project,
    api_port: identity.api_port,
    mock_port: identity.mock_port,
    url,
    mock_url: `http://127.0.0.1:${String(identity.mock_port)}`,
    env: {
      COMPOSE_PROJECT_NAME: project,
      PBMB_PORT: String(identity.api_port),
      PBMB_MOCK_PORT: String(identity.mock_port),
      PUBLIC_BASE_URL: url,
      GIT_SHA: gitSha(ROOT),
      ...Object.fromEntries(
        PASSWORDS.map((name) => [name, randomBytes(24).toString("hex")]),
      ),
    },
  };
}

const BOTH = ["stack/compose.yml", "stack/e2e/compose.e2e.yml"];

/** docker compose on compose.yml and the e2e overlay (or the files named), as this stack's project; its stdout. */
export function compose(
  stack: E2eStack,
  command: string[],
  files = BOTH,
): string {
  const result = spawnSync(
    "docker",
    [
      "compose",
      ...files.flatMap((file) => ["-f", file]),
      ...["-p", stack.project],
      ...command,
    ],
    {
      cwd: ROOT,
      env: { ...process.env, ...stack.env },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.error)
    throw new Error(`Could not run docker compose: ${result.error.message}`);
  if (result.status !== 0) {
    const said = result.stderr.trim().slice(-3000);
    if (said.includes(POOLS_FULL))
      throw new Error(
        `The stack cannot start: Docker's network address pools are full (${POOLS_FULL}). Remove unused networks; this is not a failure of the product.`,
      );
    throw new Error(
      `docker compose ${command.join(" ")} exited with ${String(result.status)}: ${said}`,
    );
  }
  return result.stdout;
}

/** This project's containers, networks, volumes and its two image tags; nothing another project uses. */
export function takeDown(stack: E2eStack): void {
  compose(stack, ["down", "--volumes", "--remove-orphans"]);
  for (const name of ["powerbi-metrics-book", "powerbi-metrics-book-mock"]) {
    const image = `${name}:${stack.project}`;
    const listed = spawnSync("docker", ["image", "ls", "--quiet", image], {
      encoding: "utf8",
    });
    if (listed.stdout.trim() !== "")
      spawnSync("docker", ["image", "rm", image], { stdio: "ignore" });
  }
}
