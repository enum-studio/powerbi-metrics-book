import type { SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import type { Config } from "./config.js";
import type * as schema from "./db/schema/index.js";
import type { Logger } from "./log.js";
import type { Principal } from "./principal.js";

/*
 * What every part of the api is built from. The interfaces AppDeps names are
 * declared here, so the core compiles before any of them is built; each is
 * implemented in the module named beside it, and test/doubles.ts holds an
 * in-memory double of each.
 */

export type Db = NodePgDatabase<typeof schema>;
export type Container = "api" | "worker";

export type AppDeps = {
  container: Container;
  /** The container's own role: api_rw or worker_rw. */
  db: Db;
  pool: Pool;
  /** audit_writer: insert only. */
  auditDb: Db;
  /** Bootstrap values only; everything else is a setting. */
  config: Config;
  logger: Logger;
  clock: () => Date;
  /** Implemented in src/http/fetcher.ts. */
  fetcher: GuardedFetcher;
  /** Implemented in src/services/settings/store.ts. */
  settings: SettingsStore;
  /** Implemented in src/services/secrets/store.ts. */
  secrets: SecretReader;
  /** Implemented in src/services/access/cerbos.ts. */
  access: Access;
  /** Implemented in src/services/connection/vault.ts. */
  vault: Vault;
};

export type ServiceContext = AppDeps & {
  principal: Principal;
  /** The request's, aborted when its caller goes away, so a service that waits can stop. */
  signal?: AbortSignal;
  /**
   * The address the request came from, as services/auth/client-address.ts
   * reads it, set by the REST adapter. Absent from the connector's calls,
   * which the demo does not serve, and null for a call made in process.
   * Demo mode counts searches against it.
   */
  client_address?: string | null;
};

/**
 * This container's age identity as a capability, built once at start. The
 * api seals Power BI tokens with it; no service holds the key itself.
 */
export interface Vault {
  /** The recipient seal encrypts for: this container's identity as it started. */
  readonly recipient: string;
  seal(text: string): Promise<Uint8Array>;
  /** With this container's identity, then those rotate-identity retired and left on disk; rejects when none opens it. */
  open(ciphertext: Uint8Array): Promise<string>;
}

export interface GuardedFetcher {
  /** https to the configured hosts only (Microsoft identity, Power BI, Graph, the embedding provider). */
  fetchFixed(
    url: string | URL,
    init?: Omit<RequestInit, "redirect"> & {
      timeout_ms?: number;
      max_bytes?: number;
      /** "return" hands a 3xx back unfollowed; the caller sends any request to its Location through the fetcher again. */
      redirect?: "refuse" | "return";
    },
  ): Promise<Response>;
  /** A URL someone else chose (a CIMD document, an OIDC issuer): https, public addresses only, 5 s, 64 KiB, no redirects. */
  fetchUntrusted(url: string | URL, init?: RequestInit): Promise<Response>;
}

export type SignInProvider = {
  id: string;
  kind: "google" | "oidc";
  label: string;
  client_id: string;
  issuer: string | null;
};

/** Every setting and the type of its value. The defaults and schemas live in src/services/settings/registry.ts. */
export type SettingValues = {
  "usage.capture": boolean;
  "usage.retention_days": number;
  "powerbi.tenant_id": string | null;
  "powerbi.app_client_id": string | null;
  "powerbi.scanner_client_id": string | null;
  "powerbi.authority": string;
  "powerbi.api_url": string;
  "powerbi.graph_url": string;
  "powerbi.sync.schedule": string;
  "powerbi.sync.full_scan_schedule": string;
  "powerbi.sync.workspaces.include": "all" | string[];
  "powerbi.sync.workspaces.exclude": string[];
  "powerbi.sync.workspaces.personal": boolean;
  "powerbi.datasets.new": "on" | "off";
  "powerbi.service_account_queries": boolean;
  "powerbi.connection_requires_matching_email": boolean;
  "powerbi.keep_connections_alive_days": number | null;
  "access.metadata_visibility": "powerbi" | "everyone" | "policy";
  "access.default_role": string;
  "sign_in.providers": SignInProvider[];
  "sign_in.passkeys": boolean;
  "sign_in.email_password": boolean;
  "email.from": string | null;
  "email.base_url": string;
  "branding.name": string | null;
  "branding.company": string | null;
  "search.provider": "openai" | "gemini" | "none";
  "search.model": string | null;
  "search.base_url": string | null;
  "results.ttl_hours": number;
  "results.preview_rows": number;
  "results.page_rows_max": number;
  "results.daily_row_budget": number;
  "queries.rate_per_minute": number;
  "service_accounts.rate_per_minute": number;
  "setup.completed_steps": string[];
  "setup.completed_at": string | null;
};
export type SettingKey = keyof SettingValues;
export type SettingValue<K extends SettingKey> = SettingValues[K];

export type SettingSource = "environment" | "database" | "default";

/** One line of the admin section's settings page. */
export type SettingListing = {
  key: SettingKey;
  value: unknown;
  source: SettingSource;
  environment_variable: string;
  description: string;
  /** Set only by the environment, because it says where a secret is sent. */
  environment_only: boolean;
  /** Why the stored value no longer matches the setting's schema, else null. It never repeats the value. */
  problem: string | null;
};

export interface SettingsStore {
  /** The environment override, then the database, then the default. */
  get<K extends SettingKey>(key: K): Promise<SettingValue<K>>;
  /** Validates the value against the setting's schema before saving it. */
  set<K extends SettingKey>(
    key: K,
    value: SettingValue<K>,
    by: Principal,
  ): Promise<void>;
  source(key: SettingKey): Promise<SettingSource>;
  /** Every key with its value, source and description, for the admin section. */
  list(): Promise<SettingListing[]>;
}

export type SecretName =
  | "powerbi_app_client_secret"
  | "powerbi_scanner_client_secret"
  | "result_link_key"
  | "openai_api_key"
  | "gemini_api_key"
  | "resend_api_key"
  | `sign_in_${string}_client_secret`;

/** Reads only the secrets this container is a reader of. */
export interface SecretReader {
  read(name: SecretName): Promise<string | null>;
}

/** The api only. */
export interface SecretWriter {
  write(
    name: SecretName,
    value: string,
    by: Principal,
    expiresAt: Date | null,
  ): Promise<void>;
}

export type ResourceKind =
  | "dataset"
  | "book"
  | "thread"
  | "query_log"
  | "result"
  | "admin"
  | "pii"
  | "request"
  | "search_log"
  | "usage_report";

export type Resource = {
  kind: ResourceKind;
  id: string;
  attr: Record<string, unknown>;
};

export interface Access {
  check(
    principal: Principal,
    resource: Resource,
    action: string,
  ): Promise<boolean>;
  /** Throws a ServiceError when the decision is no. */
  require(
    principal: Principal,
    resource: Resource,
    action: string,
  ): Promise<void>;
  /**
   * A Drizzle SQL condition over powerbi_dataset, from Cerbos planResources, independent of enabled.
   * For admin review only; every product read uses describableDatasets.
   */
  reachableDatasets(principal: Principal): Promise<SQL>;
  /** A Drizzle SQL condition over powerbi_dataset, from Cerbos planResources. */
  describableDatasets(principal: Principal): Promise<SQL>;
  /** A Drizzle SQL condition over query_log, from Cerbos planResources. */
  readableQueryLog(principal: Principal): Promise<SQL>;
  /** A Drizzle SQL condition over request, from Cerbos planResources. */
  readableRequests(principal: Principal): Promise<SQL>;
  /** A Drizzle SQL condition over search_log, from Cerbos planResources. */
  readableSearchLog(principal: Principal): Promise<SQL>;
}
