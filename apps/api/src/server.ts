import { loadConfig, readDatabaseUrl } from "./config.js";
import type { Container } from "./context.js";
import { type BuiltDeps, buildDeps } from "./deps.js";
import { seedSample } from "./services/sample/seed.js";
import { rotateIdentity } from "./services/secrets/rotate.js";
import { newSetupLink } from "./services/setup/link.js";

/*
 * The image's `server` command, run inside a running container
 * (`docker compose exec api server rotate-identity`). It builds that
 * container's deps, as the container itself does, then runs one subcommand.
 */

export type ServerDeps = BuiltDeps & { print: (line: string) => void };

/** One entry per subcommand. */
const COMMANDS = new Map<string, (deps: ServerDeps) => Promise<void>>([
  [
    "setup-link",
    async (deps) => {
      if (deps.config.container !== "api")
        throw new Error(
          "Run setup-link in the api: docker compose exec api server setup-link",
        );
      const link = await newSetupLink(deps, { revoke_earlier: true });
      deps.print(
        link === null
          ? "An admin exists, so there is no setup link. Sign in, and use the admin section."
          : `Open this link to set up Power BI Metrics Book. It works once, for 24 hours, and every earlier link and setup session has ended: ${link}`,
      );
    },
  ],
  [
    "rotate-identity",
    async (deps) => {
      const { reencrypted, left_behind } = await rotateIdentity(deps);
      const { container } = deps.config;
      deps.print(
        `The ${container} has a new identity and ${String(reencrypted)} secrets were encrypted to it. Restart the ${container} so it reads them with the new identity.`,
      );
      if (left_behind !== null)
        deps.print(
          `Remove ${left_behind} by hand: it could not be removed, and it still opens database backups taken before this rotation.`,
        );
    },
  ],
]);

type Env = Record<string, string | undefined>;

export async function runServer(
  args: readonly string[],
  env: Env,
  print: (line: string) => void,
): Promise<void> {
  const [name, ...extra] = args;
  const usage = `usage: server ${[...COMMANDS.keys(), "sample-seed"].join(" | ")}`;
  if (name === "--help" || name === "-h") {
    print(usage);
    return;
  }
  if (name === "sample-seed" && extra.length === 0) {
    if (containerOf(env) !== "api")
      throw new Error(
        "Run sample-seed in the api: docker compose exec api server sample-seed",
      );
    await seedSample(env, print);
    return;
  }
  const command = name === undefined ? undefined : COMMANDS.get(name);
  if (command === undefined || extra.length > 0) throw new Error(usage);
  const deps = await buildDeps(loadConfig(env, containerOf(env)), env);
  try {
    await command({ ...deps, print });
  } finally {
    await deps.close();
  }
}

/**
 * The image runs as either container, and `server` is started inside one
 * with that container's environment. Its database role says which: each
 * container connects as its own.
 */
function containerOf(env: Env): Container {
  const role = new URL(readDatabaseUrl(env, "DATABASE_URL")).username;
  if (role === "api_rw") return "api";
  if (role === "worker_rw") return "worker";
  throw new Error(
    `server runs inside the api or the worker container, whose DATABASE_URL connects as api_rw or worker_rw, not ${role}`,
  );
}
