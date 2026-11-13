import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { buildDeps } from "./deps.js";
import { migrateDatabase } from "./db/migrate.js";
import { refuseDevSignInResidue } from "./services/auth/dev-sign-in.js";
import { queueRekeyAtStart } from "./services/connection/jobs.js";
import { refuseDemoOffTheSample } from "./services/demo/locks.js";
import { runJobs } from "./services/jobs/runner.js";
import { announceSetupLink } from "./services/setup/link.js";
import { refuseAnotherTenant } from "./services/setup/tenant.js";
import type { Environment } from "./services/settings/env.js";
// Loaded for its side effect: it imports every module that registers a job.
import "./services/jobs/all.js";

/**
 * The `api` command: migrates as the migrator, serves on PORT, and takes the
 * jobs marked runner = 'api' from the queue. Returns once signal aborts and
 * the requests in flight are answered; rejects when a job's session ends, so
 * the container exits and restarts.
 */
export async function startApi(
  env: Environment,
  signal: AbortSignal,
): Promise<void> {
  const config = loadConfig(env, "api");
  await migrateDatabase(config.migrator_database_url);
  const deps = await buildDeps(config, env);
  await refuseDevSignInResidue(deps.db, config);
  await refuseAnotherTenant(deps);
  await refuseDemoOffTheSample(deps);
  // After rotate-identity, only an api restarted with the new identity can
  // seal the tokens again.
  await queueRekeyAtStart(deps);
  // At warn, so LOG_LEVEL=warn still shows it. The link itself is never logged.
  await announceSetupLink(deps);
  // Every interface: inside a container the proxy reaches the api from outside.
  const server = serve(
    { fetch: createApp(deps).fetch, port: config.port, hostname: "0.0.0.0" },
    (info) => {
      deps.logger.info("listening", {
        port: info.port,
        git_sha: config.git_sha,
      });
    },
  );
  try {
    await runJobs(deps, { signal });
  } finally {
    // Stops taking connections and waits for the requests in flight.
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    await deps.close();
    deps.logger.info("api stopped");
  }
}
