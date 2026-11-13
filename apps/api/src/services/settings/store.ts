import { sql } from "drizzle-orm";
import type {
  Db,
  SettingKey,
  SettingListing,
  SettingSource,
  SettingsStore,
  SettingValue,
} from "../../context.js";
import { setting } from "../../db/schema/settings.js";
import { ServiceError } from "../../errors.js";
import type { Principal } from "../../principal.js";
import {
  type Environment,
  environmentVariable,
  isSetByEnvironment,
  readEnvironment,
} from "./env.js";
import { boundTenant } from "../setup/bound.js";
import { describeIssues, SETTING_KEYS, SETTINGS } from "./registry.js";

type Saved = { value: unknown };

const environments = new WeakMap<SettingsStore, Environment>();

/** A saved row for such a key, from before it was one, is never read. */
const environmentOnly = (key: SettingKey): boolean =>
  SETTINGS[key].environment_only === true;

/**
 * The same settings on a transaction, with the environment the store was made
 * with, so a key the environment sets is refused there as well.
 */
export function inTransaction(store: SettingsStore, tx: Db): SettingsStore {
  const environment = environments.get(store);
  if (environment === undefined)
    throw new Error("inTransaction takes a store createSettingsStore made");
  return createSettingsStore(tx, environment);
}

/**
 * While a stale key index lets set() insert beside a row it missed, a key can
 * have two rows. The newest was saved last, so it is the admin's latest word.
 */
function newestByKey<R extends { key: string; set_at: Date }>(
  rows: readonly R[],
): Map<string, R> {
  const newest = new Map<string, R>();
  for (const row of rows) {
    const held = newest.get(row.key);
    if (held === undefined || row.set_at > held.set_at)
      newest.set(row.key, row);
  }
  return newest;
}

/**
 * The environment is checked here, once, so a malformed variable stops
 * start-up naming itself instead of failing the first request that reads it.
 */
export function createSettingsStore(
  db: Db,
  environment: Environment,
): SettingsStore {
  for (const key of SETTING_KEYS) readEnvironment(key, environment);

  /**
   * The table holds one row per setting, so every row is read and the key is
   * matched here: a lookup through setting_pkey misses a row once the server's
   * collation has moved, until the next start rebuilds it, and the miss reads
   * as the default, which can be weaker than what an admin saved.
   */
  function readAll() {
    return db
      .select({
        key: setting.key,
        value: setting.value,
        set_at: setting.set_at,
      })
      .from(setting);
  }

  async function loadSaved(key: SettingKey): Promise<Saved | undefined> {
    return newestByKey(await readAll()).get(key);
  }

  /**
   * The registry may have tightened since a value was saved. Such a value is
   * kept as it was stored, with the reason, so the admin section can show it;
   * only a read that would answer from it refuses.
   */
  function fromDatabase<K extends SettingKey>(
    key: K,
    saved: Saved | undefined,
  ):
    | {
        value: SettingValue<K>;
        source: "database" | "default";
        problem: null;
      }
    | { value: unknown; source: "database"; problem: string } {
    if (saved === undefined)
      return {
        value: SETTINGS[key].default,
        source: "default",
        problem: null,
      };
    const parsed = SETTINGS[key].schema.safeParse(saved.value);
    if (!parsed.success) {
      return {
        value: saved.value,
        source: "database",
        problem: describeIssues(parsed.error),
      };
    }
    return { value: parsed.data, source: "database", problem: null };
  }

  const store: SettingsStore = {
    async get<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
      // A key the environment sets is answered without a query.
      const overridden = readEnvironment(key, environment);
      if (overridden !== undefined) return overridden;
      const found = fromDatabase(
        key,
        environmentOnly(key) ? undefined : await loadSaved(key),
      );
      if (found.problem !== null) {
        throw new Error(
          `The saved value of ${key} is no longer valid: ${found.problem}`,
        );
      }
      return found.value;
    },

    async set<K extends SettingKey>(
      key: K,
      value: SettingValue<K>,
      by: Principal,
    ): Promise<void> {
      if (isSetByEnvironment(key, environment)) {
        const variable = environmentVariable(key);
        throw new ServiceError(
          "conflict",
          `${key} is set by the environment (${variable}), so it cannot be changed here. Change the variable and restart.`,
          { key, environment_variable: variable },
        );
      }
      if (environmentOnly(key)) {
        const variable = environmentVariable(key);
        throw new ServiceError(
          "conflict",
          `${key} says where a secret is sent, so only the environment sets it. Set ${variable} and restart.`,
          { key, environment_variable: variable },
        );
      }
      const parsed = SETTINGS[key].schema.safeParse(value);
      if (!parsed.success) {
        throw new ServiceError(
          "invalid",
          `${key} is not valid: ${describeIssues(parsed.error)}.`,
          { key },
        );
      }
      // The database refuses it too (src/db/sql/tenant.sql); this answers the person in a sentence.
      if (key === "powerbi.tenant_id") {
        const bound = await boundTenant(db);
        if (
          bound !== null &&
          (typeof parsed.data !== "string" ||
            parsed.data.toLowerCase() !== bound.tenant_id)
        )
          throw new ServiceError(
            "invalid",
            `This deployment belongs to tenant ${bound.tenant_id}. A deployment keeps one tenant: run another tenant on a new database.`,
            { key },
          );
      }
      // JSON null is a value; a bound null would be SQL null, which the column refuses.
      const json = sql`${JSON.stringify(parsed.data)}::jsonb`;
      await db
        .insert(setting)
        .values({ key, value: json, set_by: by.id })
        .onConflictDoUpdate({
          target: setting.key,
          set: { value: json, set_by: by.id, set_at: sql`now()` },
        });
    },

    async source(key: SettingKey): Promise<SettingSource> {
      if (isSetByEnvironment(key, environment)) return "environment";
      if (environmentOnly(key)) return "default";
      return (await loadSaved(key)) === undefined ? "default" : "database";
    },

    async list(): Promise<SettingListing[]> {
      const saved = newestByKey(await readAll());
      return SETTING_KEYS.map((key) => {
        const overridden = readEnvironment(key, environment);
        const resolved =
          overridden === undefined
            ? fromDatabase(
                key,
                environmentOnly(key) ? undefined : saved.get(key),
              )
            : {
                value: overridden,
                source: "environment" as const,
                problem: null,
              };
        return {
          key,
          ...resolved,
          environment_variable: environmentVariable(key),
          description: SETTINGS[key].description,
          environment_only: environmentOnly(key),
        };
      });
    },
  };
  environments.set(store, environment);
  return store;
}
