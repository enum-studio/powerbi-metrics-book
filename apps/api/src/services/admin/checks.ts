import { eq, sql } from "drizzle-orm";
import type { AppDeps, Db, SecretName, ServiceContext } from "../../context.js";
import { settingCheck } from "../../db/schema/admin.js";
import { secret } from "../../db/schema/secrets.js";
import { ServiceError } from "../../errors.js";
import { registerJob } from "../jobs/registry.js";
import { readersOf } from "../secrets/readers.js";
import { isSettingKey } from "../settings/registry.js";
import { audited, requireAdmin } from "./guard.js";

/*
 * Checks prove a setting, a secret or a setup step with a real call. The setup
 * registers them; saving a setting or a secret runs its own, an admin runs one
 * by name, and the daily check job runs them all again. A check that needs
 * the worker (the scanner's secret) enqueues its own worker job.
 */

export type CheckResult = {
  status: "passing" | "failing";
  /**
   * What is wrong and the one thing to change, null when it passes: a fixed
   * sentence for each known failure, never text from upstream, which could
   * repeat the value. At most 300 characters. storeCheck screens it against
   * the value it is handed: the api hands over what it reads, and a check of
   * a secret only the worker reads runs in the worker, which hands over the
   * value it holds.
   */
  message: string | null;
  /**
   * What the check found, as the setup step's answer shows it: for the
   * security check, every checklist item. Never a secret's value, only names,
   * counts, addresses and fixed sentences.
   */
  details?: Record<string, unknown>;
};

const MESSAGE_MAX = 300;
const ECHOED =
  "The check's answer repeated part of the value, so it is not shown. Look at the value where it was issued.";

/**
 * The result as it may be kept and shown: a message repeating the value, or
 * any 8 characters of it, becomes a fixed sentence. A longer message than
 * the database keeps is a fault in the check.
 */
export function screened<Result extends CheckResult>(
  name: string,
  result: Result,
  value?: unknown,
): Result {
  const { message } = result;
  if (message === null) return result;
  if (message.length > MESSAGE_MAX)
    throw new Error(
      `the check ${name} answered over ${String(MESSAGE_MAX)} characters`,
    );
  if (value === undefined) return result;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const pieces = Array.from({ length: Math.max(1, text.length - 7) }, (_, i) =>
    text.slice(i, i + 8),
  );
  return pieces.some((piece) => message.includes(piece))
    ? { ...result, message: ECHOED }
    : result;
}

/** A setting key's check is handed the value to check: the one being saved, or the one in force. */
export type Check = (deps: AppDeps, value?: unknown) => Promise<CheckResult>;

/**
 * A check only the worker runs, as an admin's request starts it: queued,
 * answered at once with where it stands (pending until the worker is done),
 * and asked again by state() as the page polls. The worker stores its result.
 */
export type Queued = {
  start: (context: ServiceContext) => Promise<unknown>;
  state: (deps: AppDeps) => Promise<CheckResult & { pending?: true }>;
};

const registered = new Map<string, Check>();
const queuedChecks = new Map<string, Queued>();

/** Called once per check, at the top level of the module that owns it. */
export function registerCheck(
  stepOrKey: string,
  run: Check,
  queued?: Queued,
): void {
  if (registered.has(stepOrKey))
    throw new Error(`the check ${stepOrKey} is registered twice`);
  registered.set(stepOrKey, run);
  if (queued !== undefined) queuedChecks.set(stepOrKey, queued);
}

export function checkFor(name: string): Check | undefined {
  return registered.get(name);
}

/** readersOf holds the rule for what names a secret; any other refusal is a fault. */
export function isSecretName(name: string): name is SecretName {
  try {
    readersOf(name);
    return true;
  } catch (error) {
    if (error instanceof ServiceError && error.kind === "invalid") return false;
    throw error;
  }
}

/**
 * Every result is kept through here, screened against the value when the
 * caller holds it: on the secret's row, or in setting_check for a setting or
 * a step. A secret nobody has set has no row, so its result is not kept.
 */
export async function storeCheck<
  Result extends CheckResult & { action?: "sign_in" | "connect" },
>(
  deps: Pick<AppDeps, "db">,
  name: string,
  checked: Result,
  value?: unknown,
): Promise<Result> {
  const result = screened(name, checked, value);
  // The database's clock, as the stamps it compares this with are: a
  // container's own clock may differ from another's.
  const checked_at = sql`now()`;
  if (isSecretName(name)) {
    await deps.db
      .update(secret)
      .set({
        check_status: result.status,
        check_message: result.message,
        checked_at,
      })
      .where(eq(secret.name, name));
    return result;
  }
  const row = {
    status: result.status,
    message: result.message,
    details: result.details ?? null,
    action: checked.action ?? null,
    checked_at,
  };
  await deps.db
    .insert(settingCheck)
    .values({ key: name, ...row })
    .onConflictDoUpdate({ target: settingCheck.key, set: row });
  return result;
}

/** A setting whose new value has no check keeps no result from an old one. */
export async function clearCheck(db: Db, key: string): Promise<void> {
  await db.delete(settingCheck).where(eq(settingCheck.key, key));
}

async function perform(deps: AppDeps, name: string): Promise<CheckResult> {
  const run = registered.get(name);
  if (run === undefined)
    throw new ServiceError("not_found", `There is no check named ${name}.`);
  const value = isSettingKey(name) ? await deps.settings.get(name) : undefined;
  const result = await run(deps, value);
  // A secret this container reads is screened for as well.
  const secretValue =
    isSecretName(name) && readersOf(name).includes(deps.container)
      ? ((await deps.secrets.read(name)) ?? undefined)
      : undefined;
  return storeCheck(deps, name, result, value ?? secretValue);
}

/** An admin runs a check: one the worker runs is queued and answered pending at once, so no request waits on the worker. */
export async function runCheck(
  context: ServiceContext,
  name: string,
): Promise<CheckResult & { pending?: true }> {
  await requireAdmin(context, "run_check");
  const queued = queuedChecks.get(name);
  if (queued !== undefined) await queued.start(context);
  const result: CheckResult & { pending?: true } =
    queued === undefined
      ? await perform(context, name)
      : await queued.state(context);
  await audited(
    context,
    "check.run",
    { kind: "check", id: name },
    { status: result.pending === true ? "pending" : result.status },
  );
  return result;
}

/** Where a queued check stands, as the admin's page polls it; it starts nothing. */
export async function checkState(
  context: ServiceContext,
  name: string,
): Promise<CheckResult & { pending?: true }> {
  await requireAdmin(context, "run_check");
  const queued = queuedChecks.get(name);
  if (queued === undefined)
    throw new ServiceError(
      "not_found",
      `There is no check named ${name} that runs in the worker. Run it to see its result.`,
    );
  return queued.state(context);
}

/** Every check, each on its own: one that throws does not stop the rest, and fails the job after them. */
export async function runAllChecks(deps: AppDeps): Promise<void> {
  const failures: unknown[] = [];
  for (const name of registered.keys())
    await perform(deps, name).catch((error: unknown) => failures.push(error));
  if (failures.length > 0)
    throw new AggregateError(failures, "Some checks could not run.");
}

registerJob("check", "api", runAllChecks);
