import { and, asc, desc, eq, inArray, isNotNull, lte } from "drizzle-orm";
import type { Db, ServiceContext } from "../../context.js";
import { user } from "../../db/schema/auth.js";
import { powerbiConnection } from "../../db/schema/connection.js";
import { syncRun } from "../../db/schema/mirror.js";
import { secret } from "../../db/schema/secrets.js";
import { VERSION } from "../../version.js";
import { securityItems } from "../setup/checks.js";
import { mayAdmin, requireAdmin } from "./guard.js";
import { secretInWords } from "./secret-words.js";
import { storedChecks } from "./settings.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** The spec warns 30 days and again 7 days before a secret expires. */
const WARN_DAYS = 30;
const URGENT_DAYS = 7;
/**
 * Stored checks that are not listed as failing. No agent having signed in yet
 * is a next step, not a fault, and the checklist is read fresh below, item by
 * item, so a date just entered clears at once.
 */
const NOT_LISTED = new Set(["agents", "security"]);

export type ExpiringSecret = {
  name: string;
  expires_at: Date;
  /** Whole days left, rounded up; 0 or less once it has expired. */
  days_left: number;
  urgent: boolean;
  warning: string;
};

/** Secrets that expire within 30 days, soonest first, each with the sentence an admin reads. */
export async function expiringSecrets(
  db: Db,
  now: Date,
): Promise<ExpiringSecret[]> {
  const rows = await db
    .select({ name: secret.name, expires_at: secret.expires_at })
    .from(secret)
    .where(
      and(
        isNotNull(secret.expires_at),
        lte(secret.expires_at, new Date(now.getTime() + WARN_DAYS * DAY_MS)),
      ),
    )
    .orderBy(asc(secret.expires_at));
  return rows.flatMap(({ name, expires_at }) => {
    if (expires_at === null) return [];
    const days_left = Math.ceil(
      (expires_at.getTime() - now.getTime()) / DAY_MS,
    );
    const date = expires_at.toISOString().slice(0, 10);
    const secretName = secretInWords(name);
    const warning =
      days_left <= 0
        ? `${secretName} expired on ${date}. Enter a new one in the admin section.`
        : `${secretName} expires in ${String(days_left)} days, on ${date}. Enter a new one in the admin section${days_left <= URGENT_DAYS ? " now" : ""}.`;
    return [
      {
        name,
        expires_at,
        days_left,
        urgent: days_left <= URGENT_DAYS,
        warning,
      },
    ];
  });
}

/**
 * A full sync that failed, until a newer one succeeds. An incremental sync
 * reads neither a workspace nothing changed in nor an app's audience, so the
 * ones after it can succeed with what the full sync left still out of date.
 */
async function failedFullSync(db: Db) {
  const [full] = await db
    .select({
      status: syncRun.status,
      started_at: syncRun.started_at,
      finished_at: syncRun.finished_at,
    })
    .from(syncRun)
    .where(
      and(
        eq(syncRun.kind, "full"),
        inArray(syncRun.status, ["succeeded", "failed"]),
      ),
    )
    .orderBy(desc(syncRun.started_at))
    .limit(1);
  if (full?.status !== "failed") return [];
  const date = full.started_at.toISOString().slice(0, 10);
  return [
    {
      name: "full_sync",
      message: `The full sync of ${date} failed. An incremental sync does not read again what it left, so that stays as it was until a full sync succeeds. Run pbmb sync run --full, and pbmb sync status then says what failed.`,
      checked_at: full.finished_at,
    },
  ];
}

/**
 * What `pbmb admin status` and the admin's status page show. Decided as
 * admin:read_status, which a deployment may give a read-only role.
 */
export async function adminStatus(context: ServiceContext) {
  await requireAdmin(context, "read_status");
  const { db } = context;
  const [lastSync] = await db
    .select({
      kind: syncRun.kind,
      status: syncRun.status,
      started_at: syncRun.started_at,
      finished_at: syncRun.finished_at,
      error: syncRun.error,
    })
    .from(syncRun)
    .orderBy(desc(syncRun.started_at))
    .limit(1);
  const failingSecrets = await db
    .select({
      name: secret.name,
      message: secret.check_message,
      checked_at: secret.checked_at,
    })
    .from(secret)
    .where(eq(secret.check_status, "failing"));
  const failingKeys = [...(await storedChecks(db))]
    .filter(
      ([name, { status }]) => status === "failing" && !NOT_LISTED.has(name),
    )
    .map(([name, { message, checked_at }]) => ({ name, message, checked_at }));
  const failingItems = (await securityItems(context))
    .filter(({ status }) => status === "failing")
    .map(({ item, sentence }) => ({
      name: item,
      message: sentence,
      checked_at: context.clock(),
    }));
  const reconnect = await db
    .select({ user_id: user.id, email: user.email })
    .from(powerbiConnection)
    .innerJoin(user, eq(user.id, powerbiConnection.user_id))
    .where(eq(powerbiConnection.status, "needs_reconnect"))
    .orderBy(asc(user.email));
  const shared = {
    connections_needing_reconnect: reconnect.length,
    version: VERSION,
    git_sha: context.config.git_sha,
  };
  const stored = [
    ...failingSecrets,
    ...failingKeys,
    ...(await failedFullSync(db)),
  ];
  const expiring = await expiringSecrets(db, context.clock());
  if (await mayAdmin(context, "manage_settings"))
    return {
      ...shared,
      last_sync: lastSync ?? null,
      failing_checks: [...stored, ...failingItems],
      secrets_expiring: expiring,
      people_to_reconnect: reconnect,
    };
  // A read-only caller learns what needs doing, not the detail. An item's name
  // describes a weakness, so the checklist is one name for them.
  return {
    ...shared,
    last_sync:
      lastSync === undefined
        ? null
        : {
            status: lastSync.status,
            started_at: lastSync.started_at,
            finished_at: lastSync.finished_at,
          },
    failing_checks: [
      ...stored.map(({ name }) => ({ name })),
      ...(failingItems.length > 0 ? [{ name: "security" }] : []),
    ],
    secrets_expiring: expiring.map(({ name, expires_at }) => ({
      name,
      expires_at,
    })),
  };
}
