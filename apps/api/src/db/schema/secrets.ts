import { sql } from "drizzle-orm";
import {
  check,
  customType,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { SecretName } from "../../context.js";
import { declareGrants } from "../grants.js";

const CONTAINERS = ["api", "worker"] as const;

/** pg hands bytea back as a Buffer; the age library takes a plain Uint8Array. */
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver: (value) => Buffer.from(value),
  fromDriver: (value) => new Uint8Array(value),
});

/** What the admin section shows of a secret. The value itself is only ever in secret_ciphertext. */
export const secret = pgTable(
  "secret",
  {
    name: text("name").$type<SecretName>().primaryKey(),
    readers: text("readers", { enum: CONTAINERS }).array().notNull(),
    /** The value's last four characters, or null when it is too short to show any. */
    hint: text("hint"),
    /** The principal's id; null when the stack made the secret itself. */
    set_by: text("set_by"),
    set_at: timestamp("set_at", { withTimezone: true }).notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }),
    checked_at: timestamp("checked_at", { withTimezone: true }),
    check_status: text("check_status", {
      enum: ["passing", "failing", "unchecked"],
    })
      .notNull()
      .default("unchecked"),
    check_message: text("check_message"),
  },
  (table) => [
    check(
      "secret_readers",
      sql`cardinality(${table.readers}) > 0 and ${table.readers} <@ array['api', 'worker']`,
    ),
    check(
      "secret_check_status",
      sql`${table.check_status} in ('passing', 'failing', 'unchecked')`,
    ),
    // A check answers a fixed sentence, never upstream text (services/admin/checks.ts).
    check(
      "secret_check_message",
      sql`char_length(${table.check_message}) <= 300`,
    ),
  ],
);

/** One age ciphertext per reader, each encrypted to that reader's recipient alone. */
export const secret_ciphertext = pgTable(
  "secret_ciphertext",
  {
    name: text("name")
      .notNull()
      .references(() => secret.name, { onDelete: "cascade" }),
    reader: text("reader", { enum: CONTAINERS }).notNull(),
    recipient: text("recipient").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.name, table.reader] }),
    check(
      "secret_ciphertext_reader",
      sql`${table.reader} in ('api', 'worker')`,
    ),
  ],
);

/** The public half of each container's age identity; one current row per container. */
export const container_identity = pgTable(
  "container_identity",
  {
    container: text("container", { enum: CONTAINERS }).notNull(),
    recipient: text("recipient").notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    retired_at: timestamp("retired_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.container, table.recipient] }),
    uniqueIndex("container_identity_current")
      .on(table.container)
      .where(sql`${table.retired_at} is null`),
    check(
      "container_identity_container",
      sql`${table.container} in ('api', 'worker')`,
    ),
  ],
);

// The api writes every secret, the worker's ciphertext included. The worker
// writes only to re-encrypt its own rows when it rotates its identity: row
// level security in src/db/sql/secrets.sql keeps it to the rows that are its
// own, so it can never replace a value the api reads (result_link_key).
declareGrants({
  secret: {
    api_rw: ["select", "insert", "update", "delete"],
    worker_rw: ["select"],
    audit_writer: [],
  },
  secret_ciphertext: {
    api_rw: ["select", "insert", "update", "delete"],
    worker_rw: ["select", "update(recipient, ciphertext)"],
    audit_writer: [],
  },
  container_identity: {
    api_rw: ["select", "insert", "update"],
    worker_rw: ["select", "insert", "update(retired_at)"],
    audit_writer: [],
  },
});
