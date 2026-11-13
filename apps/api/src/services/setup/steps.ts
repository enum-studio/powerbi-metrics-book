import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { AppDeps, ServiceContext, SettingKey } from "../../context.js";
import { jobRequest } from "../../db/schema/jobs.js";
import { secret } from "../../db/schema/secrets.js";
import { ServiceError } from "../../errors.js";
import {
  type CheckResult,
  clearCheck,
  isSecretName,
  registerCheck,
  storeCheck,
} from "../admin/checks.js";
import { audited } from "../admin/guard.js";
import { assignRole } from "../admin/people.js";
import {
  SECRET_VALUE_MAX,
  setSecret,
  setSecretExpiry,
} from "../admin/secrets.js";
import { setSetting, storedChecks } from "../admin/settings.js";
import { startSync } from "../admin/sync.js";
import { enqueue } from "../jobs/queue.js";
import { syncStarted } from "../sync/run.js";
import {
  address,
  AddressDetails,
  agents,
  appRegistration,
  firstSync,
  NO_SYNC_YET,
  search,
  security,
  signIn,
  type StepCheck,
  type StepRequest,
  type StepResult,
  whoGetsIn,
} from "./checks.js";
import { firstAdmin, type SetupSession } from "./link.js";
import {
  checkInWorker,
  CREDENTIALS,
  credentialsStanding,
  isWorkerStep,
  queueCheckInWorker,
  stepDetails,
  workerCheckState,
} from "./worker-checks.js";

/*
 * The ten setup and admin steps. Each saves its settings and
 * secrets, runs its check, and counts as done while the check passes. Their
 * checks are registered with the admin's, so /admin and the daily check job
 * run them again.
 */

type Field =
  { kind: "setting"; key: SettingKey } | { kind: "secret"; name: string };
export type Step = {
  id: string;
  title: string;
  fields: Field[];
  docs_path: string;
  check: StepCheck;
};

const setting = (key: SettingKey): Field => ({ kind: "setting", key });
const secretField = (name: string): Field => ({ kind: "secret", name });
const docs = (page: string) => `/docs/set-up/${page}/`;
/** The guide's page on what to do when a check fails, which the setup's screen links beside every step. */
export const FAILURE_DOCS_PATH = docs("when-a-check-fails");

export const STEPS: readonly Step[] = [
  {
    id: "address",
    title: "Address",
    fields: [],
    docs_path: docs("address"),
    check: address,
  },
  {
    id: "app_registration",
    title: "The app registration",
    fields: [
      setting("powerbi.tenant_id"),
      setting("powerbi.app_client_id"),
      secretField("powerbi_app_client_secret"),
    ],
    docs_path: docs("app-registration"),
    check: appRegistration,
  },
  {
    id: "scanner",
    title: "The scanner",
    fields: [
      setting("powerbi.scanner_client_id"),
      secretField("powerbi_scanner_client_secret"),
    ],
    docs_path: docs("scanner"),
    check: (deps) => checkInWorker(deps, "scanner"),
  },
  {
    id: "what_to_sync",
    title: "What to sync",
    fields: [
      setting("powerbi.sync.workspaces.include"),
      setting("powerbi.sync.workspaces.exclude"),
      setting("powerbi.sync.workspaces.personal"),
      setting("powerbi.sync.schedule"),
    ],
    docs_path: docs("what-to-sync"),
    check: (deps) => checkInWorker(deps, "what_to_sync"),
  },
  {
    id: "sign_in",
    title: "Sign-in",
    // And each provider's sign_in_<id>_client_secret.
    fields: [setting("sign_in.providers"), setting("sign_in.passkeys")],
    docs_path: docs("sign-in"),
    check: signIn,
  },
  {
    id: "who_gets_in",
    title: "Who gets in",
    fields: [
      setting("access.default_role"),
      setting("access.metadata_visibility"),
    ],
    docs_path: docs("who-gets-in"),
    check: whoGetsIn,
  },
  {
    id: "search",
    title: "Search",
    fields: [
      setting("search.provider"),
      setting("search.model"),
      secretField("openai_api_key"),
      secretField("gemini_api_key"),
    ],
    docs_path: docs("search"),
    check: search,
  },
  {
    id: "agents",
    title: "Agents",
    fields: [],
    docs_path: docs("agents"),
    check: agents,
  },
  {
    id: "first_sync",
    title: "First sync",
    fields: [],
    docs_path: docs("first-sync"),
    check: firstSync,
  },
  {
    id: "security",
    title: "Security",
    fields: [],
    docs_path: docs("security"),
    check: security,
  },
];

export const FIRST_RUN: readonly string[] = [
  "address",
  "app_registration",
  "scanner",
  "what_to_sync",
  "first_sync",
];

// The daily check job waits on the worker in-process; an admin's run is queued and polled.
for (const step of STEPS) {
  const { id } = step;
  registerCheck(
    id,
    (deps) =>
      step.check(deps, { principal: null, person_id: null, host: null }),
    isWorkerStep(id)
      ? {
          start: (deps) => queueCheckInWorker(deps, id),
          state: (deps) => workerCheckState(deps, id),
        }
      : undefined,
  );
}

/** The steps a setup session runs; every later one needs an admin's browser session. */
export const SETUP_SESSION_STEPS: readonly string[] = [
  "address",
  "app_registration",
  "scanner",
];

const SCANNER_SAME_APP =
  "These are the same app. The scanner needs its own registration.";

const CONFIRM =
  "Confirm the person who signed in. They become the first admin, and the setup's link and session end.";

const accepts = (step: Step, kind: Field["kind"], name: string) =>
  step.fields.some(
    (field) =>
      field.kind === kind &&
      (field.kind === "setting" ? field.key : field.name) === name,
  ) ||
  (kind === "secret" &&
    step.id === "sign_in" &&
    /^sign_in_.+_client_secret$/.test(name));

export const stepInput = z.strictObject({
  /** The app registration step's second POST: the email of the person to make the first admin. */
  confirm_email: z.string().optional(),
  /** The first sync step: start a sync, unless one waits or runs. Without it the step only checks, so polling it starts nothing. */
  start_sync: z.literal(true).optional(),
  /** The scanner and what to sync steps: queue the check in the worker without saving anything. A save queues it too; without either the step only reads where it stands. */
  start_check: z.literal(true).optional(),
  /** The scanner step: this request is about the check of its credentials alone, which a save or start_check queues and an empty request reads. Without it, the full check. */
  credentials_only: z.literal(true).optional(),
  settings: z.record(z.string(), z.unknown()).default({}),
  secrets: z
    .record(
      z.string(),
      z.strictObject({
        /** Left out, only the date of the secret already saved changes. */
        value: z.string().min(1).max(SECRET_VALUE_MAX).optional(),
        expires_at: z.iso.datetime().nullable(),
      }),
    )
    .default({}),
  /** Who gets in: role assignments, as /admin makes them. */
  assignments: z
    .array(
      z.union([
        z.strictObject({
          role: z.string(),
          subject_kind: z.enum(["person", "email_domain"]),
          subject: z.string(),
        }),
        z.strictObject({
          role: z.string(),
          subject_kind: z.literal("group"),
          provider: z.string(),
          subject: z.string(),
        }),
        z.strictObject({
          role: z.string(),
          subject_kind: z.literal("everyone_in_tenant"),
        }),
      ]),
    )
    .default([]),
});
export type StepInput = z.output<typeof stepInput>;

/** What the screen needs: every step, its fields with what they hold (never a secret's value), and its last check. */
export async function setupState(deps: AppDeps) {
  const checks = await storedChecks(deps.db);
  const completed = await deps.settings.get("setup.completed_steps");
  const secrets = new Map(
    (
      await deps.db
        .select({ name: secret.name, expires_at: secret.expires_at })
        .from(secret)
    ).map((row) => [row.name as string, row.expires_at]),
  );
  const steps = [];
  for (const step of STEPS.filter((step) =>
    FIRST_RUN.includes(step.id),
  ).toSorted((a, b) => FIRST_RUN.indexOf(a.id) - FIRST_RUN.indexOf(b.id))) {
    const fields = [];
    for (const field of step.fields)
      fields.push(
        field.kind === "setting"
          ? { ...field, value: await deps.settings.get(field.key) }
          : {
              ...field,
              set: secrets.has(field.name),
              expires_at: secrets.get(field.name)?.toISOString() ?? null,
            },
      );
    const { id, title, docs_path } = step;
    const worker = isWorkerStep(id) ? await workerCheckState(deps, id) : null;
    const sync =
      id === "first_sync"
        ? await firstSync(deps, {
            principal: null,
            person_id: null,
            host: null,
          })
        : null;
    const pending =
      worker !== null ? worker.pending === true : sync?.pending === true;
    // The first sync's check is what is true now. The daily job stores a failure
    // for a sync nobody started, and nothing stores the end of one nobody watched.
    const check =
      sync === null
        ? checks.get(id)
        : sync.message === NO_SYNC_YET
          ? undefined
          : {
              status: sync.status,
              message: sync.message,
              checked_at: deps.clock(),
              details: undefined,
            };
    steps.push({
      id,
      title,
      docs_path,
      fields,
      passed: completed.includes(id),
      pending,
      ...(id === "scanner"
        ? { credentials: await credentialsStanding(deps) }
        : {}),
      action:
        id === "app_registration" ? (checks.get(id)?.action ?? null) : null,
      check:
        check === undefined
          ? null
          : {
              ...check,
              details:
                id === "address" && check.details !== undefined
                  ? AddressDetails.parse(check.details)
                  : await stepDetails(deps, id, check),
            },
    });
  }
  return {
    steps,
    completed_at: await deps.settings.get("setup.completed_at"),
    failure_docs_path: FAILURE_DOCS_PATH,
  };
}

async function markStep(
  context: ServiceContext,
  id: string,
  result: CheckResult,
): Promise<void> {
  const before = await context.settings.get("setup.completed_steps");
  const others = before.filter((done) => done !== id);
  const after = result.status === "passing" ? [...others, id] : others;
  // The same mark again changes nothing, so it writes nothing.
  if (
    after.length !== before.length ||
    after.some((done) => !before.includes(done))
  )
    await context.settings.set(
      "setup.completed_steps",
      after,
      context.principal,
    );
  if (
    FIRST_RUN.every((id) => after.includes(id)) &&
    (await context.settings.get("setup.completed_at")) === null
  )
    await context.settings.set(
      "setup.completed_at",
      context.clock().toISOString(),
      context.principal,
    );
}

/**
 * Queues the first sync. A deploy's or the schedule's sync standing in the
 * queue skips itself until a person starts one (services/sync/run.ts), so it
 * cannot stand for this one, and the person's goes in behind it.
 */
async function startFirstSync(context: ServiceContext): Promise<void> {
  const { queued } = await startSync(context, "full");
  if (queued || (await syncStarted(context))) return;
  const [personal] = await context.db
    .select({ id: jobRequest.id })
    .from(jobRequest)
    .where(
      and(
        eq(jobRequest.job, "sync"),
        eq(jobRequest.trigger, "manual"),
        inArray(jobRequest.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  if (personal !== undefined) return;
  const id = await enqueue(context.db, {
    job: "sync",
    runner: "worker",
    args: { kind: "full" },
    trigger: "manual",
    requested_by: context.principal.id,
  });
  await audited(context, "sync.start", { kind: "job", id }, { kind: "full" });
}

/**
 * Saves what the step was given, runs its check and keeps the result,
 * screened against the secrets just saved, and marks the step.
 */
export async function runStep(
  context: ServiceContext,
  step: Step,
  input: StepInput,
  request: StepRequest,
  session: SetupSession | null,
): Promise<{ result: StepResult; setup_ended: boolean }> {
  const takesConfirm = session !== null && step.id === "app_registration";
  if (input.confirm_email !== undefined && !takesConfirm)
    throw new ServiceError(
      "invalid",
      "Only the setup's app registration step takes confirm_email.",
    );
  if (input.start_sync !== undefined && step.id !== "first_sync")
    throw new ServiceError(
      "invalid",
      "Only the setup's first sync step takes start_sync.",
    );
  if (input.start_check !== undefined && !isWorkerStep(step.id))
    throw new ServiceError(
      "invalid",
      "Only the setup's scanner and what to sync steps take start_check.",
    );
  if (input.credentials_only !== undefined && step.id !== "scanner")
    throw new ServiceError(
      "invalid",
      "Only the setup's scanner step takes credentials_only.",
    );
  // The person the setup's sign-in admitted is confirmed before anything is saved.
  const first = takesConfirm
    ? await firstAdmin(context, session, request.person_id, input.confirm_email)
    : null;
  if (first !== null && "confirm" in first)
    return {
      result: { status: "failing", message: CONFIRM, confirm: first.confirm },
      setup_ended: false,
    };
  if (step.id === "scanner") {
    const scannerId =
      input.settings["powerbi.scanner_client_id"] ??
      (await context.settings.get("powerbi.scanner_client_id"));
    const appIds = [
      input.settings["powerbi.app_client_id"],
      await context.settings.get("powerbi.app_client_id"),
    ];
    if (
      typeof scannerId === "string" &&
      appIds.some(
        (id) =>
          typeof id === "string" &&
          id.toLowerCase() === scannerId.toLowerCase(),
      )
    )
      throw new ServiceError("invalid", SCANNER_SAME_APP);
  }
  const given = [
    ...Object.keys(input.settings).map((name) => ({
      kind: "setting" as const,
      name,
    })),
    ...Object.keys(input.secrets).map((name) => ({
      kind: "secret" as const,
      name,
    })),
    ...(step.id === "who_gets_in"
      ? []
      : input.assignments.map(() => ({
          kind: "setting" as const,
          name: "assignments",
        }))),
  ];
  for (const { kind, name } of given)
    if (!accepts(step, kind, name))
      throw new ServiceError(
        "invalid",
        `The ${step.id} step does not take ${name}.`,
      );
  // New credentials take from the full check what it proved. The same ones sent again leave it.
  const newCredentials =
    input.credentials_only === true &&
    (Object.values(input.secrets).some((each) => each.value !== undefined) ||
      ("powerbi.scanner_client_id" in input.settings &&
        input.settings["powerbi.scanner_client_id"] !==
          (await context.settings.get("powerbi.scanner_client_id"))));
  for (const [key, value] of Object.entries(input.settings))
    await setSetting(context, key, value, { save_failing: true });
  for (const [name, { value, expires_at }] of Object.entries(input.secrets)) {
    if (!isSecretName(name))
      throw new ServiceError("invalid", `There is no secret named ${name}.`);
    const date = expires_at === null ? null : new Date(expires_at);
    if (value === undefined) await setSecretExpiry(context, name, date);
    else await setSecret(context, name, value, { expires_at: date });
  }
  for (const assignment of input.assignments)
    await assignRole(context, assignment);
  if (input.start_sync === true) await startFirstSync(context);
  if (newCredentials) {
    await clearCheck(context.db, step.id);
    await markStep(context, step.id, { status: "failing", message: null });
  }
  // A check only the worker runs is queued by a save or start_check and
  // answered at once; a POST with nothing in it only reads where it stands.
  if (isWorkerStep(step.id)) {
    const check = input.credentials_only === true ? CREDENTIALS : step.id;
    if (given.length > 0 || input.start_check === true) {
      await queueCheckInWorker(context, check, { saved: given.length > 0 });
      await audited(
        context,
        "check.run",
        { kind: "check", id: check },
        { status: "pending" },
      );
    }
    const { own, ...result } = await workerCheckState(context, check);
    // Only the latest job's own result marks the step, stored by the worker
    // screened against the secret it holds; a look at an older one does not.
    if (own) await markStep(context, step.id, result);
    return { result, setup_ended: first !== null };
  }
  const result = await step.check(context, request);
  // Nothing is kept while the check waits on the worker: its end is what counts.
  if (result.pending === true) return { result, setup_ended: first !== null };
  const values = Object.values(input.secrets).flatMap((each) =>
    each.value === undefined ? [] : [each.value],
  );
  const stored = await storeCheck(
    context,
    step.id,
    result,
    values.length === 0 ? undefined : values.join(" "),
  );
  await markStep(context, step.id, stored);
  return {
    result: stored,
    setup_ended: first !== null,
  };
}
