import { and, isNull, sql } from "drizzle-orm";
import {
  check,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { declareGrants } from "../grants.js";
import { user } from "./auth.js";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

/**
 * An invite to one email with one role. It is open until it is accepted or
 * revoked, never both; resending replaces its token and moves last_sent_at.
 * token_sha256 is the primary key and id is unique beside it: drizzle-kit
 * cannot move a key declared on a column (docs/decisions/architecture.md).
 */
export const invite = pgTable(
  "invite",
  {
    token_sha256: text("token_sha256").primaryKey(),
    id: uuid("id").notNull().unique().defaultRandom(),
    email: text("email").notNull(),
    role: text("role").notNull(),
    // Every invite made before delivery was recorded was emailed.
    delivery: text("delivery", { enum: ["email", "link"] })
      .notNull()
      .default("email"),
    invited_by: text("invited_by").notNull(),
    created_at: timestamptz("created_at").notNull().defaultNow(),
    // Null on an invite made before last_sent_at, which also assigned its
    // role when it was sent; src/db/sql/upgrade_invites.sql cleans those up once and
    // sets it. Every invite the app makes or sends writes it.
    last_sent_at: timestamptz("last_sent_at"),
    expires_at: timestamptz("expires_at").notNull(),
    accepted_at: timestamptz("accepted_at"),
    accepted_user_id: text("accepted_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    revoked_at: timestamptz("revoked_at"),
    revoked_by: text("revoked_by"),
  },
  (t) => [
    uniqueIndex("invite_open_email")
      .on(t.email)
      .where(sql`${t.accepted_at} is null and ${t.revoked_at} is null`),
    check(
      "invite_email",
      sql`${t.email} = lower(${t.email}) and ${t.email} ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'`,
    ),
    check("invite_digest", sql`${t.token_sha256} ~ '^[0-9a-f]{64}$'`),
    // As role_assignment_role: accepting the invite assigns this role.
    check(
      "invite_role",
      sql`${t.role} ~ '^[a-z][a-z0-9_]*$' and ${t.role} <> 'none'`,
    ),
    check("invite_delivery", sql`${t.delivery} in ('email', 'link')`),
    check(
      "invite_accepted_or_revoked",
      sql`${t.accepted_at} is null or ${t.revoked_at} is null`,
    ),
  ],
);
/** An invite neither accepted nor revoked; it may have expired. */
export const openInvite = and(
  isNull(invite.accepted_at),
  isNull(invite.revoked_at),
);

declareGrants({
  invite: {
    api_rw: ["select", "insert", "update"],
    worker_rw: [],
    audit_writer: [],
  },
});
