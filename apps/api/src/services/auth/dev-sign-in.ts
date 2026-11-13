import type { AuthContext, BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { and, count, eq } from "drizzle-orm";
import pg from "pg";
import * as z from "zod";
import type { Config } from "../../config.js";
import type { Db } from "../../context.js";
import { account } from "../../db/schema/auth.js";
import { personSignIn } from "../../db/schema/roles.js";
import { MICROSOFT } from "./roles.js";

/** The provisioning method Better Auth's validateUserInfo sees for a dev sign-in. */
export const DEV_SIGN_IN_METHOD = "dev";

/** The scope on every account row the dev sign-in makes, which no provider's sign-in writes. */
export const DEV_SIGN_IN_SCOPE = "dev-sign-in";

const USER_EMAIL = "user_email_unique";
const ACCOUNT_KEY = "account_providerId_accountId_uidx";

/**
 * Two locks, each enough on its own to keep the dev sign-in shut: the
 * environment must be development or test, and ALLOW_DEV_SIGN_IN must be 1.
 * The production image sets NODE_ENV=production.
 */
export function devSignInOpen(config: Config): boolean {
  return (
    (config.node_env === "development" || config.node_env === "test") &&
    config.allow_dev_sign_in
  );
}

/**
 * POST /api/auth/dev/sign-in { email, object_id? }: signs that person in
 * without a provider, for development and the tests. The plugin is added to
 * Better Auth only while devSignInOpen holds, so with either lock shut the
 * path does not exist. The email counts as verified: whoever may use this
 * route may be anyone. The person still passes the role gate like any other
 * sign-in.
 *
 * With object_id, their Entra object id, the user gets the Microsoft account
 * a Microsoft sign-in would make (the account id is the token's oid), so a
 * later sign-in through Microsoft finds that account and needs no linking:
 * linking by email stays refused. The row is marked DEV_SIGN_IN_SCOPE, which
 * the api refuses at start and at Microsoft's callback while the dev sign-in
 * is shut. An object id another user's account holds, or a user who holds
 * another Microsoft account, is refused with 409.
 */
export function devSignIn(): BetterAuthPlugin {
  return {
    id: "dev-sign-in",
    endpoints: {
      devSignIn: createAuthEndpoint(
        "/dev/sign-in",
        {
          method: "POST",
          body: z.object({
            email: z.email(),
            // Entra writes object ids in lower case; the account id must match the token's oid.
            object_id: z
              .uuid()
              .transform((id) => id.toLowerCase())
              .optional(),
          }),
        },
        async (endpoint) => {
          const users = endpoint.context.internalAdapter;
          const email = endpoint.body.email.toLowerCase();
          const objectId = endpoint.body.object_id;
          if (objectId !== undefined)
            await refuseHeldElsewhere(users, email, objectId);
          const user = await userFor(users, email);
          if (objectId !== undefined)
            await bindMicrosoft(users, user.id, email, objectId);
          const session = await users.createSession(user.id);
          await setSessionCookie(endpoint, { session, user });
          return endpoint.json({ user_id: user.id });
        },
      ),
    },
  };
}

type Users = AuthContext["internalAdapter"];

/** The user for email, made if new. A sign-in that made it first in the meantime wins. */
async function userFor(users: Users, email: string) {
  const found = await users.findUserByEmail(email);
  if (found !== null) return found.user;
  try {
    return await users.createUser(
      { email, name: email, emailVerified: true },
      { method: DEV_SIGN_IN_METHOD },
    );
  } catch (error) {
    if (!violated(error, USER_EMAIL)) throw error;
    const made = await users.findUserByEmail(email);
    if (made === null) throw error;
    return made.user;
  }
}

async function refuseHeldElsewhere(
  users: Users,
  email: string,
  objectId: string,
) {
  const owner = await users.findAccountOwnerByKey({
    providerId: MICROSOFT,
    accountId: objectId,
  });
  if (
    owner !== null &&
    (owner.kind === "orphaned" || owner.user.email !== email)
  )
    throw new APIError("CONFLICT", {
      message: `The Microsoft account ${objectId} is another user's.`,
    });
}

/**
 * The user's Microsoft account for objectId, made if they have none. When a
 * sign-in arriving at the same time binds the object id first, the unique
 * index refuses this one: done when it bound it to this person, 409 when not.
 */
async function bindMicrosoft(
  users: Users,
  userId: string,
  email: string,
  objectId: string,
) {
  const microsoft = (await users.findAccounts(userId)).find(
    (each) => each.providerId === MICROSOFT,
  );
  if (microsoft?.accountId === objectId) return;
  if (microsoft !== undefined)
    throw new APIError("CONFLICT", {
      message: `${email} signs in with another Microsoft account.`,
    });
  try {
    await users.createAccount({
      userId,
      providerId: MICROSOFT,
      accountId: objectId,
      scope: DEV_SIGN_IN_SCOPE,
    });
  } catch (error) {
    if (!violated(error, ACCOUNT_KEY)) throw error;
    await refuseHeldElsewhere(users, email, objectId);
  }
}

/** Whether Postgres refused a write for a duplicate in the named unique constraint or index. */
function violated(error: unknown, constraint: string): boolean {
  for (let at = error; at instanceof Error; at = at.cause)
    if (at instanceof pg.DatabaseError)
      return at.code === "23505" && at.constraint === constraint;
  return false;
}

/** Whether the dev sign-in made the Microsoft account for this object id. */
export async function devMadeAccount(db: Db, objectId: string) {
  const [made] = await db
    .select({ id: account.id })
    .from(account)
    .where(
      and(
        eq(account.providerId, MICROSOFT),
        eq(account.accountId, objectId),
        eq(account.scope, DEV_SIGN_IN_SCOPE),
      ),
    );
  return made !== undefined;
}

/**
 * With the dev sign-in shut, the api does not start on a database where it
 * left anything: a Microsoft account it made would sign whoever holds that
 * object id in as the email it was made for.
 */
export async function refuseDevSignInResidue(
  db: Db,
  config: Config,
): Promise<void> {
  if (devSignInOpen(config)) return;
  const [accounts] = await db
    .select({ found: count() })
    .from(account)
    .where(eq(account.scope, DEV_SIGN_IN_SCOPE));
  const [signIns] = await db
    .select({ found: count() })
    .from(personSignIn)
    .where(eq(personSignIn.provider, DEV_SIGN_IN_METHOD));
  const madeAccounts = accounts?.found ?? 0;
  const madeSignIns = signIns?.found ?? 0;
  if (madeAccounts === 0 && madeSignIns === 0) return;
  throw new Error(
    `The dev sign-in is shut, but this database holds what it made: ${String(madeAccounts)} account rows with scope '${DEV_SIGN_IN_SCOPE}' and ${String(madeSignIns)} person_sign_in rows with provider '${DEV_SIGN_IN_METHOD}'. ` +
      `A dev-made account would let whoever holds its Microsoft object id sign in as the email it was made for. ` +
      `Remove them as the migrator, then start the api again: delete from account where scope = '${DEV_SIGN_IN_SCOPE}'; delete from person_sign_in where provider = '${DEV_SIGN_IN_METHOD}';`,
  );
}
