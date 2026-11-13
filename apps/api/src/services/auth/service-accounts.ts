import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, gt, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import pg from "pg";
import type { AppDeps, ServiceContext } from "../../context.js";
import {
  serviceAccount,
  serviceAccountKey,
} from "../../db/schema/service-accounts.js";
import { request, searchLog } from "../../db/schema/usage.js";
import { ServiceError } from "../../errors.js";
import { queryResult } from "../../db/schema/queries.js";
import { writeAudit } from "../audit/write.js";
import { apiConfig } from "./better-auth.js";

/*
 * Service accounts and their API keys, made and ended by admins
 * (admin:manage_service_accounts). A key is shown once, when it is made, and
 * kept only as its SHA-256 digest: a digest that reaches a log or an error
 * names no key, since a key is 32 random bytes and authenticate takes only
 * the key itself.
 */

export const API_KEY_PREFIX = "pbmb_sk_";
/** pbmb_sk_ and 32 bytes in base64url. */
const KEY_FORM = /^pbmb_sk_[A-Za-z0-9_-]{43}$/;
const LAST_USED_EVERY_MS = 60_000;

export type ServiceAccount = typeof serviceAccount.$inferSelect;
export type ServiceAccountInput = {
  name: string;
  owner_email: string;
  roles: string[];
  workspace_ids?: string[];
  app_ids?: string[];
  source_cidrs?: string[];
  max_key_age_days?: number;
};
export type ServiceAccountChanges = Partial<Omit<ServiceAccountInput, "name">>;
/** A key as an admin sees it: never its digest. */
export type ApiKey = Omit<typeof serviceAccountKey.$inferSelect, "digest">;
const SHOWN = {
  id: serviceAccountKey.id,
  service_account: serviceAccountKey.service_account,
  prefix: serviceAccountKey.prefix,
  created_by: serviceAccountKey.created_by,
  created_at: serviceAccountKey.created_at,
  expires_at: serviceAccountKey.expires_at,
  last_used_at: serviceAccountKey.last_used_at,
  revoked_at: serviceAccountKey.revoked_at,
} satisfies Record<keyof ApiKey, unknown>;
/** What a valid key gives authenticate to build its principal from. */
export type KeyHolder = Pick<
  ServiceAccount,
  "name" | "roles" | "workspace_ids" | "app_ids"
>;

const CHECKS: Record<string, string> = {
  service_account_name:
    "A service account's name is 2 to 40 lower-case letters, digits and underscores, starting with a letter.",
  service_account_max_key_age_days: "max_key_age_days is between 1 and 90.",
  service_account_roles:
    "A service account's roles are lower-case names, and never admin: a service account never administers.",
};

/** Postgres decides what is valid; its refusals answer as the caller's mistake. */
async function checked<T>(statement: PromiseLike<T>): Promise<T> {
  try {
    return await statement;
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    if (!(cause instanceof pg.DatabaseError)) throw error;
    if (cause.code === "23505" && cause.constraint === "service_account_pkey")
      throw new ServiceError("conflict", "A service account has that name.");
    if (cause.code === "23503") throw noAccount();
    if (cause.code === "23514" && cause.constraint !== undefined)
      throw new ServiceError(
        "invalid",
        CHECKS[cause.constraint] ?? cause.message,
      );
    // A uuid or CIDR that does not parse; Postgres's message names the input.
    if (cause.code === "22P02")
      throw new ServiceError("invalid", cause.message);
    throw error;
  }
}

const noAccount = () =>
  new ServiceError("not_found", "No service account has that name.");

async function manage(context: ServiceContext): Promise<void> {
  await context.access.require(
    context.principal,
    { kind: "admin", id: "service_accounts", attr: {} },
    "manage_service_accounts",
  );
}

export function auditServiceAccount(
  context: ServiceContext,
  action: string,
  name: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  return writeAudit(context, {
    principal: context.principal,
    action: `service_account.${action}`,
    resource: { kind: "service_account", id: name },
    decision: "allow",
    detail,
  });
}

function only<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) throw noAccount();
  return row;
}

/**
 * The fields an admin sets, picked by name, so nothing else the input
 * carries reaches the row. A service account never holds pii_reader.
 * source_cidrs needs TRUSTED_PROXY: without it every request seems to come
 * from the proxy.
 */
function settable(context: ServiceContext, input: ServiceAccountChanges) {
  if (
    (input.source_cidrs ?? []).length > 0 &&
    apiConfig(context.config).trusted_proxy === null
  )
    throw new ServiceError(
      "invalid",
      "source_cidrs needs TRUSTED_PROXY: without it the api sees only the proxy's address, never the caller's. Set TRUSTED_PROXY to the proxy's address first. CLIENT_ADDRESS_HEADER=x-real-ip does not count: a key limited by address must not rest on a header nobody verified.",
    );
  if (input.roles?.includes("pii_reader"))
    throw new ServiceError(
      "invalid",
      "A service account never holds pii_reader: personal data is read by people only.",
    );
  return {
    owner_email: input.owner_email,
    roles: input.roles,
    workspace_ids: input.workspace_ids,
    app_ids: input.app_ids,
    source_cidrs: input.source_cidrs,
    max_key_age_days: input.max_key_age_days,
  };
}

/**
 * The account made without an access check or an audit line, for a caller
 * that checked admin:manage_service_accounts and audits once its
 * transaction commits (the book.yml import).
 */
export async function insertServiceAccount(
  context: ServiceContext,
  input: ServiceAccountInput,
) {
  const fields = settable(context, input);
  const row = only(
    await checked(
      context.db
        .insert(serviceAccount)
        .values({
          ...fields,
          name: input.name,
          owner_email: input.owner_email,
          roles: input.roles,
          created_by: context.principal.id,
        })
        .returning(),
    ),
  );
  return { row, fields };
}

export async function createServiceAccount(
  context: ServiceContext,
  input: ServiceAccountInput,
): Promise<ServiceAccount> {
  await manage(context);
  const { row, fields } = await insertServiceAccount(context, input);
  await auditServiceAccount(context, "create", row.name, fields);
  return row;
}

/** As insertServiceAccount: no access check and no audit line. */
export async function changeServiceAccount(
  context: ServiceContext,
  name: string,
  changes: ServiceAccountChanges,
) {
  const fields = settable(context, changes);
  if (Object.values(fields).every((value) => value === undefined))
    throw new ServiceError("invalid", "Name at least one field to change.");
  const row = only(
    await checked(
      context.db
        .update(serviceAccount)
        .set(fields)
        .where(eq(serviceAccount.name, name))
        .returning(),
    ),
  );
  return { row, fields };
}

export async function updateServiceAccount(
  context: ServiceContext,
  name: string,
  changes: ServiceAccountChanges,
): Promise<ServiceAccount> {
  await manage(context);
  const { row, fields } = await changeServiceAccount(context, name, changes);
  await auditServiceAccount(context, "update", name, fields);
  return row;
}

/** Lets the account's keys work again, those not expired or revoked. */
export async function enableServiceAccount(
  context: ServiceContext,
  name: string,
): Promise<void> {
  await manage(context);
  only(
    await context.db
      .update(serviceAccount)
      .set({ disabled_at: null })
      .where(eq(serviceAccount.name, name))
      .returning({ name: serviceAccount.name }),
  );
  await auditServiceAccount(context, "enable", name);
}

/** Stops every key of the account on its next request. */
export async function disableServiceAccount(
  context: ServiceContext,
  name: string,
): Promise<void> {
  await manage(context);
  only(
    await context.db
      .update(serviceAccount)
      .set({
        disabled_at: sql`coalesce(${serviceAccount.disabled_at}, ${context.clock()})`,
      })
      .where(eq(serviceAccount.name, name))
      .returning({ name: serviceAccount.name }),
  );
  await auditServiceAccount(context, "disable", name);
}

/** Deletes the account, every key, result, request and search it owns, so a new account with the same name inherits nothing. */
export async function deleteServiceAccount(
  context: ServiceContext,
  name: string,
): Promise<void> {
  await manage(context);
  await context.db.transaction(async (tx) => {
    only(
      await tx
        .delete(serviceAccount)
        .where(eq(serviceAccount.name, name))
        .returning({ name: serviceAccount.name }),
    );
    for (const table of [request, searchLog]) {
      await tx
        .delete(table)
        .where(
          and(
            eq(table.principal_kind, "service_account"),
            eq(table.principal_id, name),
          ),
        );
    }
    await tx
      .delete(queryResult)
      .where(
        and(
          eq(queryResult.owner_kind, "service_account"),
          eq(queryResult.owner_id, name),
        ),
      );
  });
  await auditServiceAccount(context, "delete", name);
}

export async function listServiceAccounts(
  context: ServiceContext,
): Promise<ServiceAccount[]> {
  await manage(context);
  return context.db
    .select()
    .from(serviceAccount)
    .orderBy(asc(serviceAccount.name));
}

export async function getServiceAccount(
  context: ServiceContext,
  name: string,
): Promise<ServiceAccount> {
  await manage(context);
  return accountNamed(context, name);
}

function accountNamed(context: ServiceContext, name: string) {
  return context.db
    .select()
    .from(serviceAccount)
    .where(eq(serviceAccount.name, name))
    .then(only);
}

function digestOf(key: string): Buffer {
  return createHash("sha256").update(key).digest();
}

/**
 * Makes a key and answers it once; only its digest and the first 8
 * characters after pbmb_sk_ are kept. Its expiry is reckoned from the
 * database's clock, as the 90-day check is.
 */
export async function createKey(
  context: ServiceContext,
  name: string,
  options: { expires_in_days: number },
): Promise<ApiKey & { key: string }> {
  await manage(context);
  const account = await accountNamed(context, name);
  if (account.disabled_at !== null)
    throw new ServiceError("conflict", `${name} is disabled.`);
  const days = options.expires_in_days;
  if (!Number.isInteger(days) || days < 1 || days > account.max_key_age_days)
    throw new ServiceError(
      "invalid",
      `A key for ${name} expires in 1 to ${String(account.max_key_age_days)} days.`,
    );
  const secret = randomBytes(32).toString("base64url");
  const key = `${API_KEY_PREFIX}${secret}`;
  // Named columns only: api_rw may not write created_at, which the 90-day
  // check counts from, so no key is dated ahead to outlive it.
  const inserted = await checked(
    context.db.execute<{ id: string }>(sql`
      insert into service_account_key
        (service_account, prefix, digest, created_by, expires_at)
      values (${name}, ${secret.slice(0, 8)}, ${digestOf(key)},
        ${context.principal.id}, now() + make_interval(days => ${days}))
      returning id`),
  );
  const made = only(
    await context.db
      .select(SHOWN)
      .from(serviceAccountKey)
      .where(eq(serviceAccountKey.id, only(inserted.rows).id)),
  );
  await auditServiceAccount(context, "create_key", name, {
    key_id: made.id,
    expires_at: made.expires_at.toISOString(),
  });
  return { key, ...made };
}

export async function listKeys(
  context: ServiceContext,
  name: string,
): Promise<ApiKey[]> {
  await manage(context);
  await accountNamed(context, name);
  return context.db
    .select(SHOWN)
    .from(serviceAccountKey)
    .where(eq(serviceAccountKey.service_account, name))
    .orderBy(asc(serviceAccountKey.created_at));
}

/** Stops the key on its next request. */
export async function revokeKey(
  context: ServiceContext,
  name: string,
  id: string,
): Promise<void> {
  await manage(context);
  const revoked = await checked(
    context.db
      .update(serviceAccountKey)
      .set({
        revoked_at: sql`coalesce(${serviceAccountKey.revoked_at}, ${context.clock()})`,
      })
      .where(
        and(
          eq(serviceAccountKey.id, id),
          eq(serviceAccountKey.service_account, name),
        ),
      )
      .returning({ id: serviceAccountKey.id }),
  );
  if (revoked.length === 0)
    throw new ServiceError("not_found", `${name} has no key with that id.`);
  await auditServiceAccount(context, "revoke_key", name, { key_id: id });
}

/**
 * The condition on a service_account row that a request from `address` may
 * use the account: it lists no source_cidrs, or the address is inside one.
 */
export function usableFrom(address: string | null): SQL {
  const anywhere = sql`cardinality(${serviceAccount.source_cidrs}) = 0`;
  return address === null
    ? anywhere
    : sql`(${anywhere} or ${address}::inet <<= any(${serviceAccount.source_cidrs}))`;
}

/**
 * The account a key names, when the key is live and younger than the
 * account's max_key_age_days, the account enabled and the address inside
 * its source_cidrs; null otherwise. The key is found by
 * its digest through the unique index, never compared in code: a caller
 * timing the lookup learns about the digest of their own guess, which says
 * nothing about any stored key.
 */
export async function keyHolder(
  deps: AppDeps,
  key: string,
  address: string | null,
): Promise<KeyHolder | null> {
  if (!KEY_FORM.test(key)) return null;
  const now = deps.clock();
  const [found] = await deps.db
    .select({
      key_id: serviceAccountKey.id,
      last_used_at: serviceAccountKey.last_used_at,
      name: serviceAccount.name,
      roles: serviceAccount.roles,
      workspace_ids: serviceAccount.workspace_ids,
      app_ids: serviceAccount.app_ids,
    })
    .from(serviceAccountKey)
    .innerJoin(
      serviceAccount,
      eq(serviceAccount.name, serviceAccountKey.service_account),
    )
    .where(
      and(
        eq(serviceAccountKey.digest, digestOf(key)),
        isNull(serviceAccountKey.revoked_at),
        // The database's clock, which dated the key; and the account's
        // limit as it is now, so lowering it stops older keys at once.
        gt(serviceAccountKey.expires_at, sql`now()`),
        sql`${serviceAccountKey.created_at} > now() - make_interval(days => ${serviceAccount.max_key_age_days})`,
        isNull(serviceAccount.disabled_at),
        usableFrom(address),
      ),
    );
  if (found === undefined) return null;
  const { key_id, last_used_at, ...holder } = found;
  const stale = new Date(now.getTime() - LAST_USED_EVERY_MS);
  // Checked here to spare most requests a write, and in the statement so
  // replicas racing on one key write it once.
  if (last_used_at === null || last_used_at < stale)
    await deps.db
      .update(serviceAccountKey)
      .set({ last_used_at: now })
      .where(
        and(
          eq(serviceAccountKey.id, key_id),
          or(
            isNull(serviceAccountKey.last_used_at),
            lt(serviceAccountKey.last_used_at, stale),
          ),
        ),
      );
  return holder;
}
