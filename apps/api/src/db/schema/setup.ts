import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { declareGrants } from "../grants.js";
import { user } from "./auth.js";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

/**
 * A setup link and the setup session it opened, which serve only while no
 * admin exists. Each digest is SHA-256, hex, of a random value only its
 * holder has: the link's token (in the api's log), the session's cookie,
 * and the marker of the one Microsoft sign-in the session started. Each
 * value is spent once. Every row goes once an admin exists.
 */
export const setupLink = pgTable("setup_link", {
  token_digest: text("token_digest").primaryKey(),
  expires_at: timestamptz("expires_at").notNull(),
  /** Set when the link is used: the link opens one session, once, for 12 hours. */
  session_digest: text("session_digest").unique(),
  session_expires_at: timestamptz("session_expires_at"),
  sign_in_digest: text("sign_in_digest").unique(),
  sign_in_expires_at: timestamptz("sign_in_expires_at"),
  /** The state of the OAuth flow the marker's holder started: only its callback is admitted. */
  sign_in_state_digest: text("sign_in_state_digest"),
  /** The person the session's Microsoft sign-in made, who becomes the first admin. */
  admitted_user_id: text("admitted_user_id").references(() => user.id, {
    onDelete: "cascade",
  }),
  /** The tenant id and the side of the mock the stack had when that sign-in was spent; the first admin binds these. */
  signed_in_tenant_id: uuid("signed_in_tenant_id"),
  signed_in_sample: boolean("signed_in_sample"),
});

// The worker has no part in the setup.
declareGrants({
  setup_link: {
    api_rw: ["select", "insert", "update", "delete"],
    worker_rw: [],
    audit_writer: [],
  },
});
