import { chosenBySettings } from "../sync/selection.js";
import { setTimeout as sleep } from "node:timers/promises";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { AppDeps, ServiceContext } from "../../context.js";
import {
  settingCheck,
  SETTING_CHECK_DETAILS_MAX_BYTES,
} from "../../db/schema/admin.js";
import { jobRequest } from "../../db/schema/jobs.js";
import { ServiceError } from "../../errors.js";
import { ADMIN_API, listWorkspaces } from "../../powerbi/admin.js";
import { scannerToken } from "../../powerbi/identity.js";
import {
  modifiedWorkspaces,
  SCAN_UNFINISHED,
  scanResult,
  startScan,
  waitForScan,
} from "../../powerbi/scanner.js";
import { screened, storeCheck } from "../admin/checks.js";
import { enqueueUnlessActive } from "../jobs/queue.js";
import { registerJob } from "../jobs/registry.js";
import { rolesProblem } from "./app-registration-check.js";
import {
  fail,
  pass,
  type StepResult,
  tokenRefusal,
  WorkspaceDetails,
} from "./checks.js";

/*
 * The checks that need the scanner's secret, which only the worker reads.
 * The api queues a check job for the worker, which runs the check, stores
 * its result screened against the secret it holds, and finishes; the api
 * then answers with what was stored.
 *
 * The scanner's credentials are a second check on the scanner's step, with no
 * step or stored row of their own: row level security keeps the worker to the
 * rows of the steps above, so a refusal ends the job as failed, with its
 * sentence on the job's row, and the job is where the api reads the answer.
 */

const WORKER_STEPS = ["scanner", "what_to_sync"] as const;
export type WorkerStep = (typeof WORKER_STEPS)[number];
export const CREDENTIALS = "scanner_credentials";
const WORKER_CHECKS = [...WORKER_STEPS, CREDENTIALS] as const;
export type WorkerCheck = (typeof WORKER_CHECKS)[number];

const WAIT_MS = 90_000;
/** What `setting_check.message` holds. A job's error has no such limit. */
const SHOWN_MAX = 300;
const POLL_MS = 250;
/** Up to 100 fit one scan; enough to find a table, and one quick call. */
const WORKSPACES_CHECKED = 10;
/**
 * Marks a job's error as the credentials check's own sentence. Any other
 * error, a fault in the job, says what it says and is never shown.
 */
const REFUSED = "scanner_credentials refused: ";

const ADMIN_APIS_REFUSED =
  "Power BI refused admin APIs to this service principal: add it to the security group named in Admin API settings.";
const DETAILED_OFF =
  "Tables came back without columns and measures: turn on the tenant setting Enhance admin APIs responses with detailed metadata, for the scanner's security group.";
const DAX_OFF =
  "Measures came back without DAX: turn on the tenant setting Enhance admin APIs responses with DAX and mashup expressions, for the scanner's security group.";

export async function stepDetails(
  deps: AppDeps,
  step: string,
  check: Pick<StepResult, "status" | "message"> & { details?: unknown },
): Promise<
  z.infer<typeof WorkspaceDetails> | { reason: "tenant_settings" } | undefined
> {
  if (step === "what_to_sync" && check.details != null) {
    const parsed = WorkspaceDetails.safeParse(check.details);
    if (!parsed.success) {
      deps.logger.warn("Stored setup check details are invalid.", {
        key: step,
      });
      return undefined;
    }
    if (!(await deps.settings.get("powerbi.sync.workspaces.personal")))
      parsed.data.workspaces = parsed.data.workspaces.filter(
        ({ personal }) => !personal,
      );
    return parsed.data;
  }
  return step === "scanner" &&
    check.status === "failing" &&
    [ADMIN_APIS_REFUSED, DETAILED_OFF, DAX_OFF].includes(check.message ?? "")
    ? { reason: "tenant_settings" }
    : undefined;
}

/**
 * The sentence for a failed check, always one written here: a token the
 * scanner could not get is the registration's to fix; a 401 or 403 from the
 * admin API is the tenant setting's; a limit says its wait, a number of
 * seconds the api itself wrote. Microsoft's own sentence never reaches the
 * check, which is stored and shown, nor the log: the log gets the kind, the
 * status, Microsoft's error code, and where an answer's shape differed
 * (paths, never values).
 */
function scannerRefusal(deps: AppDeps, error: unknown): string {
  if (!(error instanceof ServiceError)) throw error;
  const { status, code, issues } = error.detail;
  deps.logger.warn("scanner check failed", {
    kind: error.kind,
    status: typeof status === "number" ? status : undefined,
    code: typeof code === "string" ? code : undefined,
    issues: issues === undefined ? undefined : JSON.stringify(issues),
  });
  if (error.kind === "conflict" || error.detail.token_request === true)
    return tokenRefusal(error, "scanner registration");
  if (error.kind === "rate_limited")
    return `${ADMIN_API} is limiting calls. Try again in ${String(error.detail.retry_after_seconds)} seconds.`;
  if (error.kind === "upstream") {
    if ([401, 403].includes(Number(status))) return ADMIN_APIS_REFUSED;
    if (issues !== undefined)
      return `${ADMIN_API} answered in a shape this version cannot read.`;
    if (typeof status === "number")
      return `${ADMIN_API} answered ${String(status)}. Try the check again in a few minutes.`;
    if (error.detail.scan === SCAN_UNFINISHED)
      return "Power BI's scan did not finish. Try the check again in a few minutes.";
  }
  return `${ADMIN_API} did not answer the scanner. Try the check again in a few minutes.`;
}

/** Only that Microsoft gives the scanner registration a token: no call to Power BI, and no tenant setting in it. */
async function credentialsCheck(deps: AppDeps): Promise<StepResult> {
  try {
    await scannerToken(deps);
    return pass("The scanner registration gets a token from Microsoft.");
  } catch (error) {
    return fail(scannerRefusal(deps, error));
  }
}

/** A token, workspaces/modified, then a scan of the first listed workspaces the settings choose, read for what the tenant settings leave out. */
async function scannerCheck(deps: AppDeps): Promise<StepResult> {
  try {
    // The admin APIs reach the scanner through the tenant setting, never a permission.
    const roles = rolesProblem(await scannerToken(deps), "scanner");
    if (roles !== null) return fail(roles);
    const listed = await modifiedWorkspaces(deps, { since: null });
    if (listed.length === 0)
      return fail(
        "Power BI lists no workspace to the scanner. Give it a workspace, or include personal ones.",
      );
    const scanned = listed
      .filter(await chosenBySettings(deps))
      .slice(0, WORKSPACES_CHECKED);
    // What to sync fails an empty selection. Failing here too would keep the person from that step.
    if (scanned.length === 0)
      return pass(
        "The tenant settings could not be proven, because your workspace selection leaves nothing to scan.",
      );
    const scan = await startScan(deps, scanned);
    await waitForScan(deps, scan, { poll_ms: 1000, timeout_ms: 60_000 });
    const tables = (await scanResult(deps, scan)).workspaces
      .flatMap((workspace) => workspace.datasets ?? [])
      .flatMap((dataset) => dataset.tables ?? []);
    if (
      tables.some(
        (table) => table.columns === undefined && table.measures === undefined,
      )
    )
      return fail(DETAILED_OFF);
    if (
      tables.some((table) =>
        (table.measures ?? []).some(
          (measure) => measure.expression === undefined,
        ),
      )
    )
      return fail(DAX_OFF);
    if (tables.length === 0)
      return pass(
        "The tenant settings could not be proven, because no scanned workspace has a table.",
      );
    return pass(
      `The scanner read ${String(scanned.length)} of the ${String(listed.length)} workspaces Power BI lists.`,
    );
  } catch (error) {
    return fail(scannerRefusal(deps, error));
  }
}

/** The first scan's size: the workspaces Power BI lists, as the include, exclude and personal settings choose them. */
async function whatToSyncCheck(deps: AppDeps): Promise<StepResult> {
  try {
    const listed = await listWorkspaces(deps, { top: 1001 });
    const personal = await deps.settings.get(
      "powerbi.sync.workspaces.personal",
    );
    const eligible = listed.filter(
      (workspace) => personal || !workspace.personal,
    );
    const details = WorkspaceDetails.parse({
      workspaces: eligible.slice(0, 1000).map(({ id, name, personal }) => ({
        id,
        name,
        personal,
      })),
      personal_count: listed.filter((workspace) => workspace.personal).length,
      truncated: listed.length > 1000,
    });
    let bytes = Buffer.byteLength(
      JSON.stringify({ ...details, workspaces: [] }, null, 1),
    );
    const firstTooLarge = details.workspaces.findIndex((workspace) => {
      bytes += Buffer.byteLength(JSON.stringify(workspace, null, 1)) + 2;
      return bytes > SETTING_CHECK_DETAILS_MAX_BYTES;
    });
    if (firstTooLarge !== -1) {
      details.workspaces.length = firstTooLarge;
      details.truncated = true;
    }
    const include = await deps.settings.get("powerbi.sync.workspaces.include");
    const isChosen = await chosenBySettings(deps);
    const chosen = eligible.filter(({ id }) => isChosen(id));
    if (chosen.length === 0 && listed.length <= 1000)
      return fail(
        "The first sync would scan no workspace. Include at least one that Power BI lists.",
        { details },
      );
    return pass(
      listed.length > 1000 && chosen.length === 0 && include !== "all"
        ? "The include list could not be checked against more than 1000 workspaces Power BI lists."
        : listed.length > 1000
          ? "Power BI lists more than 1000 workspaces. The first sync uses your workspace selection."
          : `The first sync scans ${String(chosen.length)} of the ${String(eligible.length)} workspaces Power BI lists.`,
      details,
    );
  } catch (error) {
    return fail(scannerRefusal(deps, error));
  }
}

const NOT_RUN = "This check has not run yet. Run it on this step.";
const PENDING: Record<WorkerCheck, string> = {
  scanner:
    "The worker is checking the scanner: a token, the workspace list, then a scan of up to 10 workspaces. This takes up to a minute.",
  what_to_sync: "The worker is asking Power BI for the workspace list.",
  [CREDENTIALS]: "The worker is asking Microsoft for the scanner's token.",
};
const QUEUED = "The check is in the worker's queue and starts shortly.";
const BEHIND_SYNC =
  "The worker is finishing a sync. This check starts right after it.";
const BEHIND_JOB =
  "The worker is finishing another job. This check starts right after it.";
const UNTAKEN =
  "The worker has not started this check after 90 seconds, and no job of its is running. Check that the worker container is running.";

export const isWorkerStep = (id: string): id is WorkerStep =>
  (WORKER_STEPS as readonly string[]).includes(id);

type Job = {
  status: string;
  requested_at: Date;
  finished_at: Date | null;
  error: string | null;
  waited_ms: number;
};

/**
 * How long the job has waited, by the database's clock, which also stamped
 * requested_at and stamps the worker's result: the api's and the worker's own
 * clocks may differ.
 */
const WAITED_MS =
  sql<number>`extract(epoch from now() - ${jobRequest.requested_at}) * 1000`.mapWith(
    Number,
  );

const JOB = {
  status: jobRequest.status,
  requested_at: jobRequest.requested_at,
  finished_at: jobRequest.finished_at,
  error: jobRequest.error,
  waited_ms: WAITED_MS,
};

/** The check's latest job in the worker, if it ever had one. */
async function latestJob(
  deps: AppDeps,
  step: WorkerCheck,
): Promise<Job | undefined> {
  const [job] = await deps.db
    .select(JOB)
    .from(jobRequest)
    .where(
      and(
        eq(jobRequest.job, "check"),
        eq(jobRequest.runner, "worker"),
        sql`${jobRequest.args}->>'step' = ${step}`,
      ),
    )
    .orderBy(desc(jobRequest.requested_at))
    .limit(1);
  return job;
}

/**
 * What is true of a check that has no answer yet. The worker runs one job at a
 * time, so a queued check waits behind the one it is running, however long
 * that takes. Only with none running does a long wait suggest it has stopped.
 */
async function pendingSentence(
  deps: AppDeps,
  step: WorkerCheck,
  job: Job | undefined,
): Promise<string> {
  if (job?.status !== "queued") return PENDING[step];
  const [running] = await deps.db
    .select({ job: jobRequest.job })
    .from(jobRequest)
    .where(
      and(eq(jobRequest.runner, "worker"), eq(jobRequest.status, "running")),
    )
    .limit(1);
  if (running !== undefined)
    return running.job === "sync" ? BEHIND_SYNC : BEHIND_JOB;
  return job.waited_ms > WAIT_MS ? UNTAKEN : QUEUED;
}

/**
 * What the step's job leaves for it, and whether that is the job's own
 * result: null while it waits or runs. A stored result older than the job is
 * not its own; both stamps are the database's.
 */
async function answerOf(
  deps: AppDeps,
  step: WorkerCheck,
  job: Job | undefined,
): Promise<{ result: StepResult; own: boolean } | null> {
  if (job?.status === "running" || job?.status === "queued") return null;
  if (step === CREDENTIALS && job?.status === "succeeded")
    return {
      result: pass("The scanner registration gets a token from Microsoft."),
      own: false,
    };
  if (step === CREDENTIALS && job?.error?.startsWith(REFUSED))
    return {
      result: fail(job.error.slice(REFUSED.length, REFUSED.length + SHOWN_MAX)),
      own: false,
    };
  if (job?.status === "failed" || job?.status === "skipped")
    return {
      result: fail(
        "The worker could not run this check. The worker's log says why.",
      ),
      own: step !== CREDENTIALS,
    };
  if (step === CREDENTIALS) return { result: fail(NOT_RUN), own: false };
  const [stored] = await deps.db
    .select()
    .from(settingCheck)
    .where(eq(settingCheck.key, step));
  if (stored !== undefined)
    return {
      result: {
        status: stored.status,
        message: stored.message,
        details: await stepDetails(deps, step, stored),
      },
      own: job !== undefined && stored.checked_at >= job.requested_at,
    };
  return { result: fail(NOT_RUN), own: false };
}

/**
 * Queues the step's check for the worker, unless one of that step already
 * waits or runs: one statement, so two requests at once queue one scan of
 * the tenant's admin API quota. After a save only a waiting one stands for
 * it, since a running one may have read the value the save replaced. The
 * request's id, and whether this call queued it.
 */
export function queueCheckInWorker(
  context: ServiceContext,
  step: WorkerCheck,
  { saved = false }: { saved?: boolean } = {},
): Promise<{ id: string; queued: boolean }> {
  return enqueueUnlessActive(
    context.db,
    {
      job: "check",
      runner: "worker",
      args: { step },
      trigger: "manual",
      requested_by: context.principal.id,
    },
    { sameArg: "step", queuedOnly: saved },
  );
}

/**
 * Where the step's check in the worker stands, at once: pending while its
 * job waits or runs, then what the worker stored. `own` says the result is
 * the latest job's, which is what may mark the step. The screen asks again
 * every few seconds, so no request waits on the worker.
 */
export async function workerCheckState(
  deps: AppDeps,
  step: WorkerCheck,
): Promise<StepResult & { own: boolean }> {
  const latest = await latestJob(deps, step);
  const answer = await answerOf(deps, step, latest);
  if (answer !== null) return { ...answer.result, own: answer.own };
  return {
    ...fail(await pendingSentence(deps, step, latest), { pending: true }),
    own: false,
  };
}

/** The credentials check as the setup's state shows it: its last answer, with no answer while it waits or runs or never ran. */
export async function credentialsStanding(deps: AppDeps) {
  const job = await latestJob(deps, CREDENTIALS);
  const answer = await answerOf(deps, CREDENTIALS, job);
  return {
    pending: answer === null,
    check:
      answer === null || job?.finished_at == null
        ? null
        : {
            status: answer.result.status,
            message: answer.result.message,
            checked_at: job.finished_at,
          },
  };
}

/** For the daily check job, which no request waits on: queues the check, unless one stands, and waits for the worker. */
export async function checkInWorker(
  deps: AppDeps,
  step: WorkerStep,
): Promise<StepResult> {
  const { id } = await enqueueUnlessActive(
    deps.db,
    { job: "check", runner: "worker", args: { step }, trigger: "schedule" },
    { sameArg: "step" },
  );
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const [job] = await deps.db
      .select(JOB)
      .from(jobRequest)
      .where(eq(jobRequest.id, id));
    const answer = await answerOf(deps, step, job);
    if (answer !== null) return answer.result;
    if (Date.now() > deadline)
      return fail(await pendingSentence(deps, step, job));
    await sleep(POLL_MS);
  }
}

registerJob("check", "worker", async (deps, parameters) => {
  const step = z.object({ step: z.enum(WORKER_CHECKS) }).parse(parameters).step;
  const value = await deps.secrets.read("powerbi_scanner_client_secret");
  const clientId = await deps.settings.get("powerbi.scanner_client_id");
  if (step === CREDENTIALS) {
    const { message, status } = screened(
      step,
      await credentialsCheck(deps),
      value ?? undefined,
    );
    if (status === "failing") throw new Error(`${REFUSED}${String(message)}`);
    return;
  }
  const result =
    step === "scanner" ? await scannerCheck(deps) : await whatToSyncCheck(deps);
  // A save cleared the full check's result while this ran on the old
  // credentials: keeping this one would pass it as the new ones' result. Set_at
  // cannot say so: a setting's moves when the same value is saved again, and a
  // secret's is the api's clock, not the database's.
  if (
    step === "scanner" &&
    ((await deps.settings.get("powerbi.scanner_client_id")) !== clientId ||
      (await deps.secrets.read("powerbi_scanner_client_secret")) !== value)
  ) {
    deps.logger.info(
      "scanner check dropped: the credentials changed as it ran",
    );
    return;
  }
  await storeCheck(deps, step, result, value ?? undefined);
});
