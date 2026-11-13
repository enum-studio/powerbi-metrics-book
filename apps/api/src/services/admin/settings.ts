import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type {
  Db,
  SecretName,
  ServiceContext,
  SettingKey,
  SettingListing,
  SettingValue,
  SignInProvider,
} from "../../context.js";
import { account, session } from "../../db/schema/auth.js";
import { personSignIn } from "../../db/schema/roles.js";
import { settingCheck } from "../../db/schema/admin.js";
import { secret } from "../../db/schema/secrets.js";
import { ServiceError } from "../../errors.js";
import {
  describeIssues,
  isSettingKey,
  SETTINGS,
} from "../settings/registry.js";
import {
  type CheckResult,
  checkFor,
  clearCheck,
  screened,
  storeCheck,
} from "./checks.js";
import { inSignInConfig, signInConfigChanged } from "../auth/sign-in-config.js";
import { signOutEverywhere } from "../auth/grants.js";
import { MICROSOFT } from "../auth/roles.js";
import { sessionEnd } from "../auth/sign-in.js";
import { requireEmail } from "../auth/email.js";
import { inTransaction } from "../settings/store.js";
import { audited, requireAdmin } from "./guard.js";

export type AdminSetting = SettingListing & {
  /** The last result of the key's check; null when it has none or it never ran. */
  check: (CheckResult & { checked_at: Date }) | null;
  /**
   * For the sign-in providers: the redirect URIs each way of signing in is
   * told to send people back to, ready to copy, by "microsoft", "google" and
   * "oidc" (an OpenID Connect provider's); null for every other key.
   */
  redirect_uris: Record<"microsoft" | "google" | "oidc", string[]> | null;
};

/** The addresses a provider's console is given, from the public base URL as connect.ts builds its own. */
function redirectUris(base: URL) {
  const at = (path: string) => `${base.href.replace(/\/$/, "")}${path}`;
  return {
    microsoft: [
      at("/api/auth/callback/microsoft"),
      at("/api/v1/powerbi/callback"),
    ],
    google: [at("/api/auth/callback/google")],
    oidc: [at("/api/auth/sso/callback")],
  };
}

export async function storedChecks(db: Db) {
  const rows = await db.select().from(settingCheck);
  return new Map(
    rows.map(({ key, details, ...row }) => [
      key,
      { ...row, details: details ?? undefined },
    ]),
  );
}

/** Every key with its value, source, description and last check. */
export async function listSettings(
  context: ServiceContext,
): Promise<AdminSetting[]> {
  await requireAdmin(context, "manage_settings");
  const checks = await storedChecks(context.db);
  return (await context.settings.list()).map((listing) => ({
    ...listing,
    check: checks.get(listing.key) ?? null,
    redirect_uris:
      listing.key === "sign_in.providers"
        ? redirectUris(context.config.public_base_url)
        : null,
  }));
}

/** One key as the settings page lists it; a name no setting has is not found. */
export async function getSetting(
  context: ServiceContext,
  key: string,
): Promise<AdminSetting> {
  const found = (await listSettings(context)).find((s) => s.key === key);
  if (found === undefined)
    throw new ServiceError("not_found", `There is no setting named ${key}.`);
  return found;
}

/** A key's value checked against its schema, as the store will check it again on saving. */
export function parseSetting(key: string, value: unknown) {
  if (key.startsWith("setup."))
    throw new ServiceError("invalid", `Only the setup's checks write ${key}.`);
  if (!isSettingKey(key))
    throw new ServiceError("invalid", `There is no setting named ${key}.`);
  const parsed = SETTINGS[key].schema.safeParse(value);
  if (!parsed.success)
    throw new ServiceError(
      "invalid",
      `${key} is not valid: ${describeIssues(parsed.error)}.`,
      { key },
    );
  return { key, value: parsed.data };
}

/** The key's check run on a value not saved yet, screened against it; null when the key has none. */
export async function checkSetting(
  context: ServiceContext,
  key: SettingKey,
  value: unknown,
): Promise<CheckResult | null> {
  const check = checkFor(key);
  return check === undefined
    ? null
    : screened(key, await check(context, value), value);
}

export function refuseFailing(
  key: string,
  result: CheckResult | null,
  options: { save_failing?: boolean },
): void {
  if (result?.status === "failing" && options.save_failing !== true)
    throw new ServiceError(
      "invalid",
      `${key} failed its check: ${result.message ?? "no reason given"}. Save it with save_failing to keep it anyway.`,
      { key, check: result, save_failing_allowed: true },
    );
}

/** The ids of the providers that are removed, or whose kind or issuer changes. */
function movedProviders(
  before: readonly SignInProvider[],
  after: readonly SignInProvider[],
): string[] {
  const now = new Map(after.map((provider) => [provider.id, provider]));
  return before
    .filter(({ id, kind, issuer }) => {
      const same = now.get(id);
      return same?.kind !== kind || same.issuer !== issuer;
    })
    .map(({ id }) => id);
}

/**
 * The account kinds that still sign a person in: Microsoft's, each OpenID
 * Connect provider's that keeps its kind and issuer, Google's while a Google
 * provider remains, and a password's while it is turned on.
 */
function enabledAccounts(
  providers: readonly SignInProvider[],
  moved: readonly string[],
  email_password: boolean,
): string[] {
  return [
    MICROSOFT,
    ...providers
      .filter(({ id, kind }) => kind === "oidc" && !moved.includes(id))
      .map(({ id }) => id),
    ...(providers.some(({ kind }) => kind === "google") ? ["google"] : []),
    ...(email_password ? ["credential"] : []),
  ];
}

/**
 * Signs out everywhere the people with an account and none of an enabled
 * kind: no way of signing in still on is theirs, so every session of theirs
 * ends, a passkey's too, and their MCP and CLI grants. Everyone is swept, not
 * only the holders of the kind that just went, so a person stranded by an
 * earlier change, or before this sweep existed, is caught on the next one.
 * Adds them to `signed_out`.
 */
async function signOutStranded(
  db: Db,
  enabled: readonly string[],
  signed_out: string[],
): Promise<void> {
  const people = await db
    .select({ id: account.userId })
    .from(account)
    .groupBy(account.userId)
    .having(sql`not bool_or(${inArray(account.providerId, [...enabled])})`);
  for (const { id } of people) {
    if (!signed_out.includes(id)) signed_out.push(id);
    await signOutEverywhere(db, id);
  }
}

/**
 * A sign-in provider's secret was entered for the issuer it was set with.
 * The secrets of moved providers are deleted, so nobody who may only edit
 * settings can send a secret to an issuer of their own. Returns the names
 * deleted.
 */
async function forgetProviderSecrets(
  db: Db,
  moved: readonly string[],
): Promise<string[]> {
  const names = moved.map((id): SecretName => `sign_in_${id}_client_secret`);
  if (names.length === 0) return [];
  const deleted = await db
    .delete(secret)
    .where(inArray(secret.name, names))
    .returning({ name: secret.name });
  for (const { name } of deleted) await clearCheck(db, name);
  return deleted.map((row) => row.name);
}

/**
 * Ends the sessions these ways of signing in made, and moves their
 * sign-ins to the epoch so their groups and a passkey's freshness stop
 * counting. A passkey session of the same people then ends no later than
 * sessionEnd says from the sign-ins left, at once when that is past. Adds
 * whose sessions ended to `signed_out`.
 */
async function endSignIns(
  db: Db,
  methods: readonly string[],
  now: Date,
  signed_out: string[],
): Promise<void> {
  if (methods.length === 0) return;
  const ended = await db
    .delete(session)
    .where(inArray(session.sign_in_method, [...methods]))
    .returning({ id: session.userId });
  for (const { id } of ended) if (!signed_out.includes(id)) signed_out.push(id);
  const reset = await db
    .update(personSignIn)
    .set({ signed_in_at: new Date(0) })
    .where(inArray(personSignIn.provider, [...methods]))
    .returning({ id: personSignIn.user_id });
  if (reset.length === 0) return;
  const passkeys = await db
    .select({ id: session.id, userId: session.userId, end: session.expiresAt })
    .from(session)
    .where(
      and(
        eq(session.sign_in_method, "passkey"),
        gt(session.expiresAt, now),
        inArray(session.userId, [...new Set(reset.map(({ id }) => id))]),
      ),
    );
  for (const passkey of passkeys) {
    const end = await sessionEnd(db, passkey.userId, "passkey", passkey.end);
    if (end.getTime() <= now.getTime()) {
      await db.delete(session).where(eq(session.id, passkey.id));
      if (!signed_out.includes(passkey.userId)) signed_out.push(passkey.userId);
    } else if (end.getTime() < passkey.end.getTime())
      await db
        .update(session)
        .set({ expiresAt: end })
        .where(eq(session.id, passkey.id));
  }
}

/** Held while a sign-in setting is saved, so two saves see each other's value. */
const SIGN_IN_CONFIG_LOCK = "powerbi_metrics_book.sign_in_config";

/** Saves the value and its check; returns the secrets deleted and people signed out. Runs in the caller's transaction when it has one. */
export async function saveSetting(
  context: ServiceContext,
  key: SettingKey,
  value: SettingValue<SettingKey>,
  result: CheckResult | null,
): Promise<{ secrets_removed: string[]; signed_out_user_ids: string[] }> {
  const signed_out_user_ids: string[] = [];
  // Two admins changing two sign-in settings at once would each read the
  // other's old value and miss the people stranded by both together.
  if (inSignInConfig(key))
    await context.db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${SIGN_IN_CONFIG_LOCK}, 0))`,
    );
  if (key === "sign_in.email_password" && value === true)
    await requireEmail(context);
  const before =
    key === "sign_in.providers"
      ? await context.settings.get("sign_in.providers")
      : [];
  const after =
    key === "sign_in.providers"
      ? SETTINGS["sign_in.providers"].schema.parse(value)
      : [];
  const now = context.clock();
  const moved = movedProviders(before, after);
  const removed = await forgetProviderSecrets(context.db, moved);
  await endSignIns(context.db, moved, now, signed_out_user_ids);
  if (moved.length > 0)
    await signOutStranded(
      context.db,
      enabledAccounts(
        after,
        moved,
        await context.settings.get("sign_in.email_password"),
      ),
      signed_out_user_ids,
    );
  await context.settings.set<SettingKey>(key, value, context.principal);
  if (key === "sign_in.passkeys" && value === false)
    await endSignIns(context.db, ["passkey"], now, signed_out_user_ids);
  if (key === "powerbi.sync.workspaces.personal" && value === false)
    await clearCheck(context.db, "what_to_sync");
  if (key === "sign_in.email_password" && value === false) {
    await signOutStranded(
      context.db,
      enabledAccounts(
        await context.settings.get("sign_in.providers"),
        [],
        false,
      ),
      signed_out_user_ids,
    );
    await endSignIns(context.db, ["credential"], now, signed_out_user_ids);
  }
  if (result === null) await clearCheck(context.db, key);
  else await storeCheck(context, key, result, value);
  return { secrets_removed: removed, signed_out_user_ids };
}

/**
 * Validates, runs the key's check when it has one, and saves a value that
 * fails it only when the admin says so; the failure stays on the key until a
 * value passes. The audit keeps both values: no setting holds a secret.
 */
export async function setSetting(
  context: ServiceContext,
  key: string,
  value: unknown,
  options: { save_failing: boolean },
): Promise<AdminSetting> {
  await requireAdmin(context, "manage_settings");
  const parsed = parseSetting(key, value);
  const result = await checkSetting(context, parsed.key, parsed.value);
  refuseFailing(key, result, options);
  const listed = await context.settings.list();
  const before = listed.find((s) => s.key === parsed.key)?.value ?? null;
  // One transaction: a provider's secret and sessions never end without its move, nor outlast it.
  const ended = await context.db.transaction((tx) =>
    saveSetting(
      { ...context, db: tx, settings: inTransaction(context.settings, tx) },
      parsed.key,
      parsed.value,
      result,
    ),
  );
  if (inSignInConfig(key)) signInConfigChanged(context.db);
  await audited(
    context,
    "setting.set",
    { kind: "setting", id: parsed.key },
    {
      before,
      after: parsed.value,
      check_status: result?.status ?? null,
      ...ended,
    },
  );
  const saved = (await listSettings(context)).find((s) => s.key === key);
  if (saved === undefined) throw new Error(`${key} was saved but not listed`);
  return saved;
}
