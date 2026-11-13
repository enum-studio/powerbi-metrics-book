import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { declareGrants } from "../grants.js";
import { user } from "./auth.js";

export const SUBJECT_KINDS = [
  "person",
  "email_domain",
  "group",
  "everyone_in_tenant",
] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

/**
 * Who holds a role: a person by email, everyone at an email domain, a group
 * one sign-in provider names, or everyone in the Power BI tenant. Roles are
 * resolved from these rows on every request, never kept in a session.
 */
export const roleAssignment = pgTable(
  "role_assignment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    role: text("role").notNull(),
    subject_kind: text("subject_kind", { enum: SUBJECT_KINDS }).notNull(),
    /** An email, a domain or a group id; null for everyone in the tenant. */
    subject: text("subject"),
    /** For a group: the provider whose tokens name it, `microsoft` for Entra. */
    provider: text("provider"),
    granted_by: text("granted_by").notNull(),
    granted_at: timestamptz("granted_at").notNull().defaultNow(),
  },
  (t) => [
    unique("role_assignment_once")
      .on(t.role, t.subject_kind, t.provider, t.subject)
      .nullsNotDistinct(),
    check(
      "role_assignment_subject_kind",
      sql`${t.subject_kind} in ('person', 'email_domain', 'group', 'everyone_in_tenant')`,
    ),
    // "none" is how access.default_role says nobody, so no assignment may grant it.
    check(
      "role_assignment_role",
      sql`${t.role} ~ '^[a-z][a-z0-9_]*$' and ${t.role} <> 'none'`,
    ),
    // Everyone in the tenant or at a domain would be admins, or readers of
    // personal data, nobody chose.
    check(
      "role_assignment_privileged_subject",
      sql`${t.role} not in ('admin', 'pii_reader') or ${t.subject_kind} in ('person', 'group')`,
    ),
    check(
      "role_assignment_subject",
      sql`(${t.subject_kind} = 'everyone_in_tenant') = (${t.subject} is null)`,
    ),
    // A group id means something only at the provider that issued it.
    check(
      "role_assignment_provider",
      sql`(${t.subject_kind} = 'group') = (${t.provider} is not null) and (${t.provider} is null or ${t.provider} ~ '^[a-z][a-z0-9_]*$')`,
    ),
    // Emails and domains are compared in lower case, so they are kept that way.
    check(
      "role_assignment_subject_lower_case",
      sql`${t.subject_kind} not in ('person', 'email_domain') or ${t.subject} = lower(${t.subject})`,
    ),
  ],
);

/**
 * A person's last sign-in through each provider, with the group ids its
 * token named (null: none) and whether it vouched for the email's domain.
 * Both count for roles, and a passkey signs in, only while the provider
 * sign-in behind them is recent.
 */
export const personSignIn = pgTable(
  "person_sign_in",
  {
    user_id: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    signed_in_at: timestamptz("signed_in_at").notNull(),
    group_ids: text("group_ids").array(),
    /** Whether this sign-in vouched for the email's domain as the organisation's. */
    domain_verified: boolean("domain_verified").notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.user_id, t.provider] }),
    check("person_sign_in_provider", sql`${t.provider} ~ '^[a-z][a-z0-9_]*$'`),
  ],
);

declareGrants({
  role_assignment: {
    api_rw: ["select", "insert", "delete"],
    worker_rw: [],
    audit_writer: [],
  },
  person_sign_in: {
    api_rw: ["select", "insert", "update"],
    worker_rw: [],
    audit_writer: [],
  },
});
