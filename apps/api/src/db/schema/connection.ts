import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { declareGrants } from "../grants.js";
import { session, user } from "./auth.js";

export const CONNECTION_STATUSES = [
  "connected",
  "needs_reconnect",
  "disconnected",
] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

/** pg hands bytea back as a Buffer; the age library takes a plain Uint8Array. */
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver: (value) => Buffer.from(value),
  fromDriver: (value) => new Uint8Array(value),
});

/**
 * A person's delegated Power BI grant, one row per person. Both tokens are
 * age ciphertext for the api's recipient, and exist only while connected.
 */
export const powerbiConnection = pgTable(
  "powerbi_connection",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    user_id: text("user_id")
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: "cascade" }),
    microsoft_object_id: uuid("microsoft_object_id").notNull(),
    user_principal_name: text("user_principal_name"),
    group_object_ids: uuid("group_object_ids").array().notNull().default([]),
    groups_read_at: timestamptz("groups_read_at"),
    groups_attempted_at: timestamptz("groups_attempted_at"),
    scopes: text("scopes").array().notNull().default([]),
    access_token_ciphertext: bytea("access_token_ciphertext"),
    access_token_expires_at: timestamptz("access_token_expires_at"),
    refresh_token_ciphertext: bytea("refresh_token_ciphertext"),
    recipient: text("recipient"),
    status: text("status", { enum: CONNECTION_STATUSES }).notNull(),
    connected_at: timestamptz("connected_at").notNull(),
    refreshed_at: timestamptz("refreshed_at"),
    last_used_at: timestamptz("last_used_at"),
    last_error: text("last_error"),
  },
  (t) => [
    index("powerbi_connection_microsoft_object_id_idx").on(
      t.microsoft_object_id,
    ),
    check(
      "powerbi_connection_status",
      sql`${t.status} in ('connected', 'needs_reconnect', 'disconnected')`,
    ),
    check(
      "powerbi_connection_tokens_while_connected",
      sql`(${t.status} = 'connected') = (${t.access_token_ciphertext} is not null
        and ${t.access_token_expires_at} is not null
        and ${t.refresh_token_ciphertext} is not null
        and ${t.recipient} is not null)`,
    ),
  ],
);

/**
 * A connection under way: its state, single use, bound to the session that
 * started it, with the PKCE verifier the callback redeems the code with.
 */
export const powerbiConnectState = pgTable(
  "powerbi_connect_state",
  {
    /** SHA-256 of the state, hex: the state itself goes only to the browser. */
    state_digest: text("state_digest").primaryKey(),
    session_id: text("session_id")
      .notNull()
      .references(() => session.id, { onDelete: "cascade" }),
    code_verifier: text("code_verifier").notNull(),
    /** Where the browser goes back to, already through the allowlist. */
    next: text("next").notNull(),
    expires_at: timestamptz("expires_at").notNull(),
  },
  (t) => [
    index("powerbi_connect_state_expires_at").on(t.expires_at),
    index("powerbi_connect_state_session_id").on(t.session_id),
  ],
);

// The worker never holds the token key, so it reads neither table.
declareGrants({
  powerbi_connection: {
    api_rw: ["select", "insert", "update"],
    worker_rw: [],
    audit_writer: [],
  },
  powerbi_connect_state: {
    api_rw: ["select", "insert", "delete"],
    worker_rw: [],
    audit_writer: [],
  },
});
