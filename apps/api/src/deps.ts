import type { Config } from "./config.js";
import type { AppDeps, SettingsStore } from "./context.js";
import { createDb, createPool } from "./db/client.js";
import { createGuardedFetcher, protectNativeFetch } from "./http/fetcher.js";
import { createLogger } from "./log.js";
import { createAccess } from "./services/access/cerbos.js";
import { createVault } from "./services/connection/vault.js";
import {
  type LoadedIdentity,
  loadIdentity,
} from "./services/secrets/identities.js";
import { createSecretReader } from "./services/secrets/store.js";
import type { Environment } from "./services/settings/env.js";
import { createSettingsStore } from "./services/settings/store.js";

/** Where each embedding provider is when `search.base_url` does not say. */
export const EMBEDDING_HOSTS = {
  openai: "https://api.openai.com",
  gemini: "https://generativelanguage.googleapis.com",
} as const;

/** What `buildDeps` made, with what only the entries need: the identity (`server rotate-identity`) and the pools to end. */
export type BuiltDeps = AppDeps & {
  identity: LoadedIdentity;
  close(): Promise<void>;
};

/**
 * Everything a container is built from, wired once at start: the pools for
 * its own role and for audit_writer, the settings (the environment wins
 * over what is saved), this container's identity, the secrets it reads and
 * its vault, the guarded fetcher and Cerbos. The caller ends the pools with
 * close().
 */
export async function buildDeps(
  config: Config,
  env: Environment = process.env,
): Promise<BuiltDeps> {
  protectNativeFetch();
  const logger = createLogger(config.log_level);
  const pool = createPool(config.database_url);
  const auditPool = createPool(config.audit_database_url);
  for (const [role, each] of [
    [config.container, pool],
    ["audit_writer", auditPool],
  ] as const) {
    // An idle connection that drops (Postgres restarting) is reported on its
    // pool; unheard, it would end the process. The next query opens another.
    each.on("error", (error) => {
      logger.error("idle database connection failed", {
        role,
        error: String(error),
      });
    });
  }
  const db = createDb(pool);
  const clock = (): Date => new Date();
  const settings = createSettingsStore(db, env);
  const identity = await loadIdentity(config, db);
  return {
    container: config.container,
    db,
    pool,
    auditDb: createDb(auditPool),
    config,
    logger,
    clock,
    fetcher: createGuardedFetcher({
      allowedOrigins: () => fixedHosts(settings),
      nodeEnv: config.node_env,
      demoMock: config.demo_mode,
    }),
    settings,
    secrets: createSecretReader(
      { container: config.container, db, env },
      identity,
    ),
    access: createAccess({ cerbosUrl: config.cerbos_url, settings }),
    vault: createVault(config, identity),
    identity,
    close: async () => {
      await Promise.all([pool.end(), auditPool.end()]);
    },
  };
}

/** Read on each call, so a host saved in the admin section is reachable at once. */
async function fixedHosts(settings: SettingsStore): Promise<string[]> {
  const hosts = await Promise.all([
    settings.get("powerbi.authority"),
    settings.get("powerbi.api_url"),
    settings.get("powerbi.graph_url"),
    embeddingHost(settings),
    settings.get("email.base_url"),
  ]);
  return hosts.filter((host) => host !== null);
}

async function embeddingHost(settings: SettingsStore): Promise<string | null> {
  const provider = await settings.get("search.provider");
  if (provider === "none") return null;
  return (await settings.get("search.base_url")) ?? EMBEDDING_HOSTS[provider];
}
