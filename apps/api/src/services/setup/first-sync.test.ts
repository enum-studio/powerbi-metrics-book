import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { closeTestPools, principals, testPool } from "../../../test/deps.js";
import { type SetupFixture, startSetup } from "../../../test/setup-support.js";
import { jobRequest } from "../../db/schema/jobs.js";
import { syncRun } from "../../db/schema/mirror.js";
import { setSecret } from "../admin/secrets.js";
import { enqueue, enqueueUnlessActive } from "../jobs/queue.js";
import { handlerFor } from "../jobs/registry.js";
import { runSync } from "../sync/run.js";
import { runStep, STEPS, stepInput } from "./steps.js";

/*
 * Start on the first sync's step, with a sync of the worker's own already in
 * the queue. Such a sync skips itself until a person starts one, so it cannot
 * stand for the person's Start.
 */

let setup: SetupFixture;
beforeAll(async () => {
  setup = await startSetup();
  const scanner = setup.tenant.service_principals.find(
    (app) => app.may_call_admin_apis,
  );
  if (scanner === undefined) throw new Error("No sample scanner");
  const admin = principals.admin;
  await setup.api.settings.set(
    "powerbi.scanner_client_id",
    scanner.app_id,
    admin,
  );
  await setup.api.settings.set(
    "powerbi.tenant_id",
    setup.tenant.tenant_id,
    admin,
  );
  await setSecret(
    { ...setup.api, principal: admin },
    "powerbi_scanner_client_secret",
    scanner.secret,
    { expires_at: null },
  );
});
afterAll(async () => {
  await setup.close();
  await closeTestPools();
});
beforeEach(async () => {
  await testPool("migrator").query(
    "delete from job_request where job = 'sync'",
  );
  await testPool("migrator").query("delete from sync_run");
});

const FIRST_SYNC = STEPS.find((step) => step.id === "first_sync");
if (FIRST_SYNC === undefined) throw new Error("No first sync step");
const firstSyncStep = FIRST_SYNC;

const pressStart = () =>
  runStep(
    { ...setup.api, principal: principals.admin },
    firstSyncStep,
    stepInput.parse({ start_sync: true }),
    { principal: principals.admin, person_id: null, host: null },
    null,
  );

const queuedSyncs = () =>
  setup.api.db
    .select({
      id: jobRequest.id,
      trigger: jobRequest.trigger,
      requested_by: jobRequest.requested_by,
    })
    .from(jobRequest)
    .where(and(eq(jobRequest.job, "sync"), eq(jobRequest.status, "queued")))
    .orderBy(asc(jobRequest.requested_at));

const runs = () =>
  setup.api.db
    .select({
      trigger: syncRun.trigger,
      status: syncRun.status,
      error: syncRun.error,
    })
    .from(syncRun)
    .orderBy(asc(syncRun.started_at));

it.each(["deploy", "schedule"] as const)(
  "runs the person's Start though a %s sync already stands in the queue",
  async (trigger) => {
    const standing = await enqueue(setup.worker.db, {
      job: "sync",
      runner: "worker",
      args: { kind: "incremental" },
      trigger,
    });
    const { result } = await pressStart();
    expect(result.pending).toBe(true);
    const queued = await queuedSyncs();
    expect(queued).toMatchObject([
      { id: standing, trigger },
      { trigger: "manual", requested_by: principals.admin.id },
    ]);

    // Pressing Start again queues no third.
    await pressStart();
    expect(await queuedSyncs()).toHaveLength(2);

    // As the worker takes them, oldest first, without the wait on the mock's scans.
    const job = handlerFor("sync", "worker");
    if (job === undefined) throw new Error("no sync job is registered");
    await job.handler(setup.worker, { kind: "incremental" }, trigger);
    await runSync(setup.worker, {
      kind: "full",
      trigger: "manual",
      poll_ms: 5,
    });
    expect(await runs()).toMatchObject([
      { trigger, status: "skipped" },
      { trigger: "manual", status: "succeeded" },
    ]);
  },
);

it("queues one sync when nothing stands in the queue", async () => {
  await pressStart();
  expect(await queuedSyncs()).toMatchObject([
    { trigger: "manual", requested_by: principals.admin.id },
  ]);
});

it("lets a person's sync that stands in the queue stand for Start", async () => {
  const { id } = await enqueueUnlessActive(setup.api.db, {
    job: "sync",
    runner: "worker",
    args: { kind: "full" },
    trigger: "manual",
    requested_by: "someone",
  });
  await pressStart();
  expect(await queuedSyncs()).toMatchObject([{ id }]);
});

it("lets a scheduled sync stand for Start once a sync has run, as it will run", async () => {
  await setup.worker.db.insert(syncRun).values({
    kind: "full",
    trigger: "manual",
    status: "failed",
    started_at: new Date(),
  });
  const { id } = await enqueueUnlessActive(setup.api.db, {
    job: "sync",
    runner: "worker",
    args: { kind: "incremental" },
    trigger: "schedule",
  });
  await pressStart();
  expect(await queuedSyncs()).toMatchObject([{ id }]);
});
