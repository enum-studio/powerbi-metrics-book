import { sql } from "drizzle-orm";
import {
  check,
  cidr,
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { declareGrants } from "../grants.js";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

/** A key's SHA-256 digest, as node:crypto hands it over. */
const digestBytes = customType<{ data: Buffer }>({
  dataType: () => "bytea",
});

/**
 * A caller with no person behind it: its roles, and the workspaces and apps
 * it may reach, given by an admin. Its credential is an API key.
 */
export const serviceAccount = pgTable(
  "service_account",
  {
    name: text("name").primaryKey(),
    owner_email: text("owner_email").notNull(),
    roles: text("roles").array().notNull().default([]),
    workspace_ids: uuid("workspace_ids").array().notNull().default([]),
    app_ids: uuid("app_ids").array().notNull().default([]),
    /** Where its requests may come from; empty is anywhere. */
    source_cidrs: cidr("source_cidrs").array().notNull().default([]),
    max_key_age_days: integer("max_key_age_days").notNull().default(90),
    disabled_at: timestamptz("disabled_at"),
    created_by: text("created_by").notNull(),
    created_at: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("service_account_name", sql`${t.name} ~ '^[a-z][a-z0-9_]{1,39}$'`),
    // Each role well formed, as role_assignment's. JSON quotes every name, so
    // none can hide a separator. A service account never administers: a
    // leaked key could otherwise make itself keys and grant itself anything.
    // Nor reads personal data: pii_reader is for people only.
    check(
      "service_account_roles",
      sql`array_to_json(${t.roles})::text ~ '^\\[("[a-z][a-z0-9_]*"(,"[a-z][a-z0-9_]*")*)?\\]$'
        and not (${t.roles} && array['admin', 'none', 'pii_reader'])`,
    ),
    check(
      "service_account_max_key_age_days",
      sql`${t.max_key_age_days} between 1 and 90`,
    ),
  ],
);

/**
 * An API key, kept only as the SHA-256 digest of the key and the first
 * characters after pbmb_sk_, for an admin to tell keys apart.
 */
export const serviceAccountKey = pgTable(
  "service_account_key",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    service_account: text("service_account")
      .notNull()
      .references(() => serviceAccount.name, { onDelete: "cascade" }),
    prefix: text("prefix").notNull(),
    digest: digestBytes("digest").notNull().unique(),
    created_by: text("created_by").notNull(),
    created_at: timestamptz("created_at").notNull().defaultNow(),
    expires_at: timestamptz("expires_at").notNull(),
    last_used_at: timestamptz("last_used_at"),
    revoked_at: timestamptz("revoked_at"),
  },
  (t) => [
    check(
      "service_account_key_expiry",
      sql`${t.expires_at} > ${t.created_at} and ${t.expires_at} <= ${t.created_at} + interval '90 days'`,
    ),
    index("service_account_key_service_account").on(t.service_account),
  ],
);

// created_at is left to the database's clock, so no writer can date a key
// ahead and stretch it past 90 days; a key changes only when used or revoked.
declareGrants({
  service_account: {
    api_rw: ["select", "insert", "update", "delete"],
    worker_rw: [],
    audit_writer: [],
  },
  service_account_key: {
    api_rw: [
      "select",
      "insert(id, service_account, prefix, digest, created_by, expires_at)",
      "update(last_used_at, revoked_at)",
    ],
    worker_rw: [],
    audit_writer: [],
  },
});
