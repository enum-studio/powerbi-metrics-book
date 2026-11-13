import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { and, desc, eq, gt, ne, sql } from "drizzle-orm";
import pg from "pg";
import { z } from "zod";
import type { AppDeps, Db, ServiceContext } from "../../context.js";
import { account, session, user } from "../../db/schema/auth.js";
import { invite, openInvite } from "../../db/schema/invites.js";
import { personDeactivation } from "../../db/schema/people.js";
import { ServiceError } from "../../errors.js";
import { logError } from "../../http/error-log.js";
import { isShippedRole, SHIPPED_ROLES } from "../access/shipped-roles.js";
import { audited, requireAdmin } from "../admin/guard.js";
import {
  auditRevokedInvites,
  invitingAdmins,
  revokeDemotedInvites,
  withAdminLock,
} from "../admin/people.js";
import { countRequest } from "../rate-limit.js";
import {
  acceptOpenInvite,
  auditInviteAccepted,
  lockEmail,
} from "./accept-invite.js";
import { requireEmail, sendInviteEmail, sendPasswordLink } from "./email.js";
import { revokeGrantsOf } from "./grants.js";
import { PASSWORD_PATHS } from "./password-paths.js";
import { namesOf, REMOVED_PERSON, whoKey } from "./people.js";
import { type Person, resolveRoles, roleSubject } from "./roles.js";

const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");
/** Every invite token, since the first: 32 random bytes in base64url (freshToken). */
export const INVITE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** A user the invite's link has just verified. */
const verified = (row: { id: string; email: string }): Person => ({
  id: row.id,
  email: row.email,
  email_verified: true,
});
async function hasProvider(db: Db, email: string) {
  const rows = await db
    .select({ id: account.id })
    .from(account)
    .innerJoin(user, eq(user.id, account.userId))
    .where(and(eq(user.email, email), ne(account.providerId, "credential")))
    .limit(1);
  return rows.length > 0;
}

const INVALID_TOKEN = {
  code: "INVALID_TOKEN",
  message: "This invite is invalid or has expired; ask an admin for another.",
};
const ROLE_LABELS: Record<string, string> = {
  viewer: "Viewer",
  curator: "Curator",
  admin: "Admin",
};
const RESEND_RULES = [
  { window_seconds: 60, max: 1 },
  { window_seconds: 86400, max: 10 },
];

/** Refuses sending one invite again more than RESEND_RULES allow, by resend or by inviting its email. */
async function limitSending(db: Db, id: string, now: Date) {
  for (const rule of RESEND_RULES) {
    const key = `invite_resend:${id}:${String(rule.window_seconds)}`;
    const verdict = await countRequest(db, key, rule, now);
    if (!verdict.allowed)
      throw new ServiceError(
        "rate_limited",
        `This invite was sent too often. Try again in ${String(verdict.retry_after_seconds)} seconds.`,
        { retry_after_seconds: verdict.retry_after_seconds },
      );
  }
}

const EMAIL_RULE = { window_seconds: 86400, max: 200 };

/** Refuses one admin's emailed invite past EMAIL_RULE; each invite counts, a link none. */
async function limitEmailing(db: Db, principal: string, now: Date) {
  const key = `invite_email:${principal}`;
  const verdict = await countRequest(db, key, EMAIL_RULE, now);
  if (verdict.allowed) return;
  const resets = new Date(now.getTime() + verdict.retry_after_seconds * 1000);
  const at = resets.toISOString().slice(0, 16).replace("T", " ");
  throw new ServiceError(
    "rate_limited",
    `You can email ${String(EMAIL_RULE.max)} invites a day. The count resets at ${at} UTC; until then, invite by link.`,
    { retry_after_seconds: verdict.retry_after_seconds },
  );
}

/** A new token, of which only the digest is stored, valid for 7 days from now. */
function freshToken(now: Date) {
  const token = randomBytes(32).toString("base64url");
  const values = {
    token_sha256: digest(token),
    last_sent_at: now,
    expires_at: new Date(now.getTime() + 7 * 86400_000),
  };
  return { token, values };
}

async function inviterName(db: Db, id: string) {
  const who = { kind: "person" as const, id };
  return (await namesOf(db, [who], "name")).get(whoKey(who)) ?? REMOVED_PERSON;
}

/** The database decides a valid email and role; its refusal answers as the caller's mistake. */
async function checked<T>(statement: Promise<T>, email: string, role: string) {
  try {
    return await statement;
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    if (!(cause instanceof pg.DatabaseError) || cause.code !== "23514")
      throw error;
    const sentence = {
      invite_email: `${email} is not an email address.`,
      invite_role: `${role} is not a role name: lower case letters, digits and underscores.`,
    }[cause.constraint ?? ""];
    if (sentence === undefined) throw error;
    throw new ServiceError("invalid", sentence);
  }
}

/** What sending reads, by name, so a column a later migration drops is never selected. */
const SENT = {
  id: invite.id,
  email: invite.email,
  role: invite.role,
  delivery: invite.delivery,
  invited_by: invite.invited_by,
  expires_at: invite.expires_at,
};
type Sent = Pick<typeof invite.$inferSelect, keyof typeof SENT> & {
  token: string;
};

/** Emails the invite, or answers its link for the admin to send themselves. */
async function deliver(context: ServiceContext, sent: Sent, inviter: string) {
  const link = new URL("/invite", context.config.public_base_url);
  link.hash = new URLSearchParams({ token: sent.token }).toString();
  if (sent.delivery === "link") return link.href;
  await sendInviteEmail(context, {
    to: sent.email,
    inviter_name: inviter,
    role_label: ROLE_LABELS[sent.role] ?? sent.role,
    link: link.href,
    expires_at: sent.expires_at,
  });
  return null;
}

/**
 * Invites each email with one role. An email with an open invite has it sent
 * again with this role; one that is already a user is refused. The role is
 * assigned when the invite is accepted (accept-invite.ts), not here.
 */
export async function invitePeople(
  context: ServiceContext,
  input: {
    emails: string[];
    role: string;
    delivery: "email" | "link";
    custom?: boolean;
  },
): Promise<{
  invites: {
    id: string;
    email: string;
    expires_at: Date;
    link: string | null;
  }[];
}> {
  await requireAdmin(context, "manage_people");
  const emails = [...new Set(input.emails.map((e) => e.toLowerCase()))];
  const { role, delivery } = input;
  if (emails.length < 1 || emails.length > 50)
    throw new ServiceError("invalid", "Invite 1 to 50 emails at a time.");
  if (role === "pii_reader")
    throw new ServiceError(
      "invalid",
      "Give PII on the person once they have joined.",
    );
  if (!isShippedRole(role) && input.custom !== true)
    throw new ServiceError(
      "invalid",
      `${role} is not a shipped role (${SHIPPED_ROLES.join(", ")}). To invite with a role your own Cerbos policies define, say it is custom (--custom).`,
    );
  if (delivery === "email") await requireEmail(context);
  const now = context.clock();
  // An inviter's deactivation revokes their open invites under the same
  // lock, so one that won it before this invite is refused here.
  const sent = await withAdminLock(context, async (db) => {
    const rows: Sent[] = [];
    for (const email of emails) {
      await lockEmail(db, email);
      const [known] = await db
        .select({ deactivated: personDeactivation.user_id })
        .from(user)
        .leftJoin(personDeactivation, eq(personDeactivation.user_id, user.id))
        .where(sql`lower(${user.email}) = ${email}`);
      if (known)
        throw new ServiceError(
          "conflict",
          known.deactivated === null
            ? `${email} is already a user. Change their role instead.`
            : `Reactivate ${email} instead.`,
        );
      if (delivery === "email")
        await limitEmailing(db, context.principal.id, now);
      const [open] = await db
        .select({ id: invite.id })
        .from(invite)
        .where(and(eq(invite.email, email), openInvite));
      if (open) await limitSending(db, open.id, now);
      const { token, values } = freshToken(now);
      const changes = {
        ...values,
        role,
        delivery,
        invited_by: context.principal.id,
      };
      const [renewed] = await checked(
        db
          .update(invite)
          .set(changes)
          .where(and(eq(invite.email, email), openInvite))
          .returning(SENT),
        email,
        role,
      );
      const [row] = renewed
        ? [renewed]
        : await checked(
            db
              .insert(invite)
              .values({ ...changes, email, created_at: now })
              .returning(SENT),
            email,
            role,
          );
      if (!row) throw new Error("The invite was not saved.");
      rows.push({ ...row, token });
    }
    return rows;
  });
  const inviter = await inviterName(context.db, context.principal.id);
  const invites = [];
  // Every invite saved is audited before any is delivered, so a failed email
  // leaves no later invite without its record.
  for (const row of sent)
    await audited(
      context,
      "people.invite",
      { kind: "person", id: row.email },
      { email: row.email, role, delivery },
    );
  for (const row of sent) {
    const link = await deliver(context, row, inviter);
    invites.push({
      id: row.id,
      email: row.email,
      expires_at: row.expires_at,
      link,
    });
  }
  return { invites };
}

/** The invites neither accepted nor revoked, expired ones too, the latest sent first. */
export async function listInvites(context: ServiceContext) {
  await requireAdmin(context, "manage_people");
  // upgrade_invites.sql sets last_sent_at on every invite at start; the column still allows null.
  const lastSent = sql`coalesce(${invite.last_sent_at}, ${invite.created_at})`;
  const rows = await context.db
    .select({
      id: invite.id,
      email: invite.email,
      role: invite.role,
      delivery: invite.delivery,
      invited_by: invite.invited_by,
      last_sent_at: lastSent.mapWith(invite.created_at),
      expires_at: invite.expires_at,
    })
    .from(invite)
    .where(openInvite)
    .orderBy(desc(lastSent));
  const inviter = (row: (typeof rows)[number]) => ({
    kind: "person" as const,
    id: row.invited_by,
  });
  const names = await namesOf(context.db, rows.map(inviter), "name");
  const now = context.clock();
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    role: row.role,
    delivery: row.delivery,
    inviter_name: names.get(whoKey(inviter(row))) ?? REMOVED_PERSON,
    last_sent_at: row.last_sent_at,
    expires_at: row.expires_at,
    expired: row.expires_at <= now,
  }));
}

/** Changes an open invite under its email's lock, in the caller's transaction; not_found when there is none. */
async function changeOpen(
  db: Db,
  id: string,
  changes: Partial<typeof invite.$inferInsert>,
) {
  const missing = new ServiceError("not_found", "No open invite has that id.");
  if (!z.uuid().safeParse(id).success) throw missing;
  const [open] = await db
    .select({ email: invite.email })
    .from(invite)
    .where(and(eq(invite.id, id), openInvite));
  if (!open) throw missing;
  await lockEmail(db, open.email);
  const [changed] = await db
    .update(invite)
    .set(changes)
    .where(and(eq(invite.id, id), openInvite))
    .returning(SENT);
  if (!changed) throw missing;
  return changed;
}

/** A new token and 7 more days for an open invite, sent again by its delivery. */
export async function resendInvite(
  context: ServiceContext,
  id: string,
): Promise<{ expires_at: Date; link: string | null }> {
  await requireAdmin(context, "manage_people");
  const now = context.clock();
  const { token, values } = freshToken(now);
  const row = await withAdminLock(context, async (db) => {
    await limitSending(db, id, now);
    const changed = await changeOpen(db, id, values);
    if (changed.delivery === "email")
      await limitEmailing(db, context.principal.id, now);
    return changed;
  });
  await audited(
    context,
    "people.invite_resend",
    { kind: "person", id: row.email },
    { email: row.email, role: row.role, delivery: row.delivery },
  );
  const inviter = await inviterName(context.db, row.invited_by);
  const link = await deliver(context, { ...row, token }, inviter);
  return { expires_at: row.expires_at, link };
}

/**
 * Ends an open invite: its link and its email's sign-in stop admitting at
 * once. An open admin invite makes a user of its email an admin until it is
 * accepted, so ending it ends the invites that user sent, as a demotion does.
 */
export async function revokeInvite(
  context: ServiceContext,
  id: string,
): Promise<void> {
  await requireAdmin(context, "manage_people");
  const { row, invites } = await withAdminLock(context, async (db, held) => {
    const admins = await invitingAdmins(context, db, held);
    const row = await changeOpen(db, id, {
      revoked_at: context.clock(),
      revoked_by: context.principal.id,
    });
    const invites = await revokeDemotedInvites(context, db, held, admins);
    return { row, invites };
  });
  await audited(
    context,
    "people.invite_revoke",
    { kind: "person", id: row.email },
    { email: row.email },
  );
  await auditRevokedInvites(context, invites);
}

export type InviteLookup =
  | {
      state: "open";
      email: string;
      role: string;
      inviter_name: string;
      expires_at: Date;
      password_allowed: boolean;
    }
  | { state: "expired"; inviter_name: string; expires_at: Date }
  | { state: "invalid" };

/** What the invite page shows for a token. Revoked, accepted and unknown answer the same. */
export async function lookupInvite(
  deps: AppDeps,
  token: string,
): Promise<InviteLookup> {
  // No digest of a string no invite could have: it answers as an unknown one.
  if (!INVITE_TOKEN.test(token)) return { state: "invalid" };
  const [row] = await deps.db
    .select({
      email: invite.email,
      role: invite.role,
      delivery: invite.delivery,
      invited_by: invite.invited_by,
      expires_at: invite.expires_at,
    })
    .from(invite)
    .where(and(eq(invite.token_sha256, digest(token)), openInvite));
  if (!row) return { state: "invalid" };
  const inviter_name = await inviterName(deps.db, row.invited_by);
  const { email, role, expires_at } = row;
  if (expires_at <= deps.clock())
    return { state: "expired", inviter_name, expires_at };
  const password_allowed =
    row.delivery === "email" &&
    (await deps.settings.get("sign_in.email_password")) &&
    !(await hasProvider(deps.db, email));
  return {
    state: "open",
    email,
    role,
    inviter_name,
    expires_at,
    password_allowed,
  };
}

/** The invite page's lookup, served whether or not password sign-in is on. */
export function inviteLookupEndpoint(deps: AppDeps): BetterAuthPlugin {
  return {
    id: "invite-lookup",
    endpoints: {
      lookupInvite: createAuthEndpoint(
        "/invites/lookup",
        { method: "POST", body: z.object({ token: z.string() }) },
        async (c) => {
          // A token in the address would reach logs and history.
          const url = c.request?.url;
          if (url !== undefined && new URL(url).search !== "")
            throw new APIError("BAD_REQUEST", {
              message: "Send the token in the body, never the address.",
            });
          // createAuth's handle set this from clientAddress (client-address.ts).
          const address = c.request?.headers.get("x-forwarded-for") ?? null;
          const verdict = await countRequest(
            deps.db,
            `invite_lookup:${address ?? "in-process"}`,
            { window_seconds: 60, max: 20 },
            deps.clock(),
          );
          if (!verdict.allowed)
            throw new APIError("TOO_MANY_REQUESTS", {
              message: "Too many invite lookups; try again in a minute.",
            });
          return c.json(await lookupInvite(deps, c.body.token));
        },
      ),
    },
  };
}

export function passwordEndpoints(deps: AppDeps): BetterAuthPlugin {
  return {
    id: "invited-password",
    hooks: {
      after: [
        {
          matcher: (c) => c.path === "/change-password",
          handler: createAuthMiddleware(async (c) => {
            if (c.context.newSession)
              await revokeGrantsOf(deps.db, c.context.newSession.user.id);
          }),
        },
      ],
      before: [
        {
          matcher: (c) => PASSWORD_PATHS.some((path) => path === c.path),
          handler: createAuthMiddleware(async (c) => {
            if (c.path === "/reset-password") {
              const body = z.object({ token: z.string() }).safeParse(c.body);
              const value = body.success
                ? await c.context.internalAdapter.findVerificationValue(
                    `reset-password:${body.data.token}`,
                  )
                : null;
              const accounts = value
                ? await c.context.internalAdapter.findAccounts(value.value)
                : [];
              if (
                !accounts.some((a) => a.providerId === "credential") ||
                accounts.some((a) => a.providerId !== "credential")
              )
                throw new APIError("BAD_REQUEST", {
                  code: "INVALID_TOKEN",
                  message: "Invalid token",
                });
            }
            if (c.path === "/change-password") {
              const signed = await getSessionFromCtx(c);
              if (signed && (await hasProvider(deps.db, signed.user.email)))
                throw new APIError("BAD_REQUEST", {
                  message: "Use your existing sign-in provider.",
                });
              const body = z.record(z.string(), z.unknown()).safeParse(c.body);
              if (body.success)
                return {
                  context: {
                    body: { ...body.data, revokeOtherSessions: true },
                  },
                };
              return;
            }
            const parsed = z.object({ email: z.email() }).safeParse(c.body);
            if (
              parsed.success &&
              !(
                await countRequest(
                  deps.db,
                  `password:${digest(parsed.data.email.toLowerCase())}`,
                  { window_seconds: 60, max: 5 },
                  deps.clock(),
                )
              ).allowed
            )
              throw new APIError("TOO_MANY_REQUESTS", {
                message: "Too many attempts; try again in a minute.",
              });
          }),
        },
      ],
    },
    endpoints: {
      acceptInvite: createAuthEndpoint(
        "/invites/accept",
        {
          method: "POST",
          body: z.object({
            token: z.string().regex(INVITE_TOKEN),
            password: z.string().min(12).max(128),
          }),
        },
        async (c) => {
          const now = deps.clock();
          // A link the admin saw proves nothing about the mailbox.
          const valid = and(
            eq(invite.token_sha256, digest(c.body.token)),
            openInvite,
            gt(invite.expires_at, now),
            eq(invite.delivery, "email"),
          );
          // Only a valid token costs a password hash; the locked read below decides.
          const [found] = await deps.db
            .select({ email: invite.email })
            .from(invite)
            .where(valid);
          if (!found) throw new APIError("BAD_REQUEST", INVALID_TOKEN);
          const hash = await c.context.password.hash(c.body.password);
          const person = await deps.db.transaction(async (db) => {
            await lockEmail(db, found.email);
            const [link] = await db
              .select({ email: invite.email })
              .from(invite)
              .where(valid);
            if (!link || (await hasProvider(db, link.email)))
              throw new APIError("BAD_REQUEST", INVALID_TOKEN);
            const [person] = await db
              .insert(user)
              .values({
                id: randomUUID(),
                email: link.email,
                name: link.email,
                emailVerified: true,
              })
              .onConflictDoUpdate({
                target: user.email,
                set: { emailVerified: true },
              })
              .returning();
            if (!person) throw new Error("The invited user was not saved.");
            if (await hasProvider(db, person.email))
              throw new APIError("BAD_REQUEST", INVALID_TOKEN);
            // Under the lock this is the invite just read: it assigns its role.
            if (!(await acceptOpenInvite(db, verified(person), now)))
              throw new Error("The open invite was not accepted.");
            await revokeGrantsOf(db, person.id);
            await db.delete(session).where(eq(session.userId, person.id));
            await db
              .insert(account)
              .values({
                id: randomUUID(),
                userId: person.id,
                providerId: "credential",
                accountId: person.id,
                password: hash,
              })
              .onConflictDoUpdate({
                target: [account.providerId, account.accountId],
                set: { password: hash },
              });
            return person;
          });
          // As admitSession audits an invite a provider's sign-in accepts.
          const roles = await resolveRoles(
            deps,
            await roleSubject(deps.db, verified(person), now),
          );
          await auditInviteAccepted(deps, verified(person), roles);
          const made = await c.context.internalAdapter.createSession(person.id);
          await setSessionCookie(c, { session: made, user: person });
          return c.json({ user_id: person.id });
        },
      ),
      forgotPassword: createAuthEndpoint(
        "/email/forgot-password",
        { method: "POST", body: z.object({ email: z.email() }) },
        async (c) => {
          await requireEmail(deps);
          // The answer must not wait on sending, so its timing does not reveal an account.
          void new Promise<void>((resolve) => setImmediate(resolve))
            .then(async () => {
              const found = await c.context.internalAdapter.findUserByEmail(
                c.body.email.toLowerCase(),
                { includeAccounts: true },
              );
              if (
                !found ||
                !found.accounts.some((a) => a.providerId === "credential") ||
                found.accounts.some((a) => a.providerId !== "credential")
              )
                return;
              const token = randomBytes(32).toString("base64url");
              await c.context.internalAdapter.createVerificationValue({
                identifier: `reset-password:${token}`,
                value: found.user.id,
                expiresAt: new Date(deps.clock().getTime() + 3600_000),
              });
              await sendPasswordLink(deps, found.user.email, token);
            })
            .catch((error: unknown) => {
              logError(deps.logger, "Password reset email failed.", error, {
                request_id: c.request?.headers.get("x-request-id") ?? null,
              });
            });
          return c.json({
            status: true,
            message: "Check your email for a password reset link.",
          });
        },
      ),
    },
  };
}
