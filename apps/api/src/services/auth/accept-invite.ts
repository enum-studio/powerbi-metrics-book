import { and, eq, gt, sql } from "drizzle-orm";
import type { Db } from "../../context.js";
import { invite, openInvite } from "../../db/schema/invites.js";
import { roleAssignment } from "../../db/schema/roles.js";
import { writeAudit } from "../audit/write.js";
import { assignRole, type Person } from "./roles.js";

/** One email's invites change one at a time: sending, resending, revoking and accepting each take this. */
export const lockEmail = (db: Db, email: string) =>
  db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${email}, 0))`);

/**
 * Accepting an invite turns it into a person assignment of its role to the
 * stored email, granted by whoever invited. A person accepts by signing in
 * with a verified email that has an open, unexpired invite. Returns whether
 * an invite was accepted.
 */
export async function acceptOpenInvite(
  db: Db,
  person: Person,
  now: Date,
): Promise<boolean> {
  if (!person.email_verified) return false;
  const email = person.email.toLowerCase();
  return db.transaction(async (tx) => {
    // A resend or revoke waits for this.
    await lockEmail(tx, email);
    const [accepted] = await tx
      .update(invite)
      .set({ accepted_at: now, accepted_user_id: person.id })
      .where(
        and(eq(invite.email, email), openInvite, gt(invite.expires_at, now)),
      )
      .returning({ role: invite.role, invited_by: invite.invited_by });
    if (accepted === undefined) return false;
    const [equal] = await tx
      .select({ id: roleAssignment.id })
      .from(roleAssignment)
      .where(
        and(
          eq(roleAssignment.role, accepted.role),
          eq(roleAssignment.subject_kind, "person"),
          eq(roleAssignment.subject, email),
        ),
      );
    if (equal === undefined)
      await assignRole(
        tx,
        { role: accepted.role, subject_kind: "person", subject: email },
        { id: accepted.invited_by },
      );
    return true;
  });
}

/** The audit row of an accepted invite, with the person who accepted it as the actor. */
export function auditInviteAccepted(
  deps: Parameters<typeof writeAudit>[0],
  person: Person,
  roles: string[],
): Promise<void> {
  return writeAudit(deps, {
    principal: {
      kind: "person",
      id: person.id,
      roles,
      attributes: {},
      via: "browser",
      client_id: null,
    },
    action: "people.invite_accept",
    resource: { kind: "person", id: person.email.toLowerCase() },
    decision: "allow",
  });
}
