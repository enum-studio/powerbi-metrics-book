import type { SQL } from "drizzle-orm";
import type {
  Access,
  GuardedFetcher,
  Resource,
  SecretName,
  SecretReader,
  SecretWriter,
  SettingKey,
  SettingListing,
  SettingsStore,
  SettingValue,
  SettingValues,
} from "../src/context.js";
import { NO_SUCH_DATASET, ServiceError } from "../src/errors.js";
import type { Principal } from "../src/principal.js";
import { environmentVariable } from "../src/services/settings/env.js";
import { SETTING_KEYS, SETTINGS } from "../src/services/settings/registry.js";

/*
 * In-memory stand-ins for the interfaces in src/context.ts, for tests that do
 * not need the real one. Postgres is never doubled: a test that reads or
 * writes data uses the real database through test/deps.ts.
 */

/** The defaults in the spec's settings table. */
export const DEFAULT_SETTINGS: SettingValues = {
  "usage.capture": true,
  "usage.retention_days": 180,
  "powerbi.tenant_id": null,
  "powerbi.app_client_id": null,
  "powerbi.scanner_client_id": null,
  "powerbi.authority": "https://login.microsoftonline.com",
  "powerbi.api_url": "https://api.powerbi.com",
  "powerbi.graph_url": "https://graph.microsoft.com",
  "powerbi.sync.schedule": "0 * * * *",
  "powerbi.sync.full_scan_schedule": "30 2 * * *",
  // An empty list syncs nothing; "all" is how every workspace is asked for.
  "powerbi.sync.workspaces.include": "all",
  "powerbi.sync.workspaces.exclude": [],
  "powerbi.sync.workspaces.personal": false,
  "powerbi.datasets.new": "on",
  "powerbi.service_account_queries": false,
  "powerbi.connection_requires_matching_email": false,
  "powerbi.keep_connections_alive_days": null,
  "access.metadata_visibility": "powerbi",
  "access.default_role": "viewer",
  // Microsoft is always on and is not listed; these are the others.
  "sign_in.providers": [],
  "sign_in.passkeys": false,
  "sign_in.email_password": false,
  "email.from": null,
  "email.base_url": "https://api.resend.com",
  "branding.name": null,
  "branding.company": null,
  "search.provider": "none",
  "search.model": null,
  "search.base_url": null,
  "results.ttl_hours": 24,
  "results.preview_rows": 20,
  "results.page_rows_max": 500,
  "results.daily_row_budget": 1_000_000,
  "queries.rate_per_minute": 60,
  "service_accounts.rate_per_minute": 60,
  "setup.completed_steps": [],
  "setup.completed_at": null,
};

/**
 * Settings kept in memory: the saved ones, then the defaults. It neither
 * validates nor reads the environment. No setting's value is ever undefined
 * (an unset one is null), so undefined means "not saved".
 */
export class MemorySettings implements SettingsStore {
  readonly #saved: Partial<SettingValues>;

  constructor(saved: Partial<SettingValues> = {}) {
    this.#saved = { ...saved };
  }

  get<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
    const saved = this.#saved[key];
    return Promise.resolve(saved === undefined ? DEFAULT_SETTINGS[key] : saved);
  }

  set<K extends SettingKey>(key: K, value: SettingValue<K>): Promise<void> {
    this.#saved[key] = value;
    return Promise.resolve();
  }

  source(key: SettingKey): Promise<"database" | "default"> {
    return Promise.resolve(
      this.#saved[key] === undefined ? "default" : "database",
    );
  }

  list(): Promise<SettingListing[]> {
    return Promise.all(
      SETTING_KEYS.map(async (key) => ({
        key,
        value: await this.get(key),
        source: await this.source(key),
        environment_variable: environmentVariable(key),
        description: SETTINGS[key].description,
        environment_only: SETTINGS[key].environment_only === true,
        problem: null,
      })),
    );
  }
}

/** Secrets kept in memory, readable by whoever holds the double. */
export class MemorySecrets implements SecretReader, SecretWriter {
  readonly #values: Map<SecretName, string>;

  constructor(initial: Iterable<readonly [SecretName, string]> = []) {
    this.#values = new Map(initial);
  }

  read(name: SecretName): Promise<string | null> {
    return Promise.resolve(this.#values.get(name) ?? null);
  }

  write(name: SecretName, value: string): Promise<void> {
    this.#values.set(name, value);
    return Promise.resolve();
  }
}

function refuse(url: string | URL): Promise<Response> {
  return Promise.reject(
    new Error(
      `the test fetcher refuses every request, ${String(url)} included: pass createTestDeps a fetcher that answers it`,
    ),
  );
}

/** Fails every request, so a test reaching the network by mistake fails rather than calling out. */
export const refusingFetcher: GuardedFetcher = {
  fetchFixed: refuse,
  fetchUntrusted: refuse,
};

export type Decide = (
  principal: Principal,
  resource: Resource,
  action: string,
) => boolean | Promise<boolean>;

/**
 * Access decided by the test's own function. require refuses a dataset as
 * not_found and anything else as refused, as the real one does.
 * describableDatasets answers from the second function, and throws when the
 * test gave none, since there is no condition a test could safely assume.
 * reachableDatasets answers from the same describable function.
 */
export function accessFrom(
  decide: Decide,
  describable?: (principal: Principal) => SQL,
): Access {
  const datasets = (principal: Principal) => {
    if (describable === undefined)
      return Promise.reject(
        new Error("accessFrom was given no describableDatasets function"),
      );
    return Promise.resolve(describable(principal));
  };
  return {
    check: async (principal, resource, action) =>
      decide(principal, resource, action),
    require: async (principal, resource, action) => {
      if (await decide(principal, resource, action)) return;
      if (resource.kind === "dataset")
        throw new ServiceError("not_found", NO_SUCH_DATASET);
      throw new ServiceError(
        "refused",
        `You may not ${action} this ${resource.kind}.`,
      );
    },
    reachableDatasets: datasets,
    describableDatasets: datasets,
    readableQueryLog: () =>
      Promise.reject(
        new Error(
          "accessFrom cannot decide the query log in SQL; use cerbosAccess",
        ),
      ),
    readableRequests: () =>
      Promise.reject(
        new Error("accessFrom cannot decide requests in SQL; use cerbosAccess"),
      ),
    readableSearchLog: () =>
      Promise.reject(
        new Error(
          "accessFrom cannot decide the search log in SQL; use cerbosAccess",
        ),
      ),
  };
}
