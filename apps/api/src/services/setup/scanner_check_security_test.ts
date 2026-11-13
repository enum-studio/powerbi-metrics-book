import { eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { closeTestPools, principals, testPool } from "../../../test/deps.js";
import { type SetupFixture, startSetup } from "../../../test/setup-support.js";
import { settingCheck } from "../../db/schema/admin.js";
import { setSecret } from "../admin/secrets.js";
import { handlerFor } from "../jobs/registry.js";
import { queueCheckInWorker, workerCheckState } from "./worker-checks.js";

/*
 * Boundary B6, the scanner's checks: what Microsoft answers is data, and a
 * check's message is stored and shown to every admin. Whatever Microsoft
 * says when a call fails, the stored check holds a sentence written here,
 * and the log holds none of Microsoft's text either.
 */

const HOUR = 60 * 60 * 1000;
const TENANT_PHRASES = ["Contoso", "Q3-secret", "unavailable", "AADSTS99999"];
const TENANT_TEXT =
  "Contoso finance workspace Q3-secret is unavailable. Trace AADSTS99999";
const TENANT_CODE = "WorkspaceGone";

let setup: SetupFixture;
// A token is kept until five minutes before it expires: each run that must ask Microsoft again runs later.
let later = 0;

beforeAll(async () => {
  setup = await startSetup();
});
afterAll(async () => {
  await setup.close();
  await closeTestPools();
});
beforeEach(async () => {
  await testPool("migrator").query(
    "delete from job_request where job = 'check'",
  );
  await setup.api.db.delete(settingCheck);
});

async function configureScanner(): Promise<void> {
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
}

/** Where Microsoft's answer is replaced, and by what. */
type Answer = { path: string; response: () => Response };

/** Runs the scanner check in the worker with Microsoft answering as given; what the check stored, and what the worker logged. */
async function checkWith(answer: Answer, step: "scanner" | "what_to_sync") {
  await configureScanner();
  later += 2 * HOUR;
  const real = setup.worker.fetcher.fetchFixed.bind(setup.worker.fetcher);
  const fetch = vi
    .spyOn(setup.worker.fetcher, "fetchFixed")
    .mockImplementation((url, init) =>
      String(url).includes(answer.path)
        ? Promise.resolve(answer.response())
        : real(url, init),
    );
  const logs = [
    vi.spyOn(setup.worker.logger, "warn"),
    vi.spyOn(setup.worker.logger, "error"),
    vi.spyOn(setup.worker.logger, "info"),
  ];
  try {
    const worker = {
      ...setup.worker,
      clock: () => new Date(Date.now() + later),
    };
    await handlerFor("check", "worker")?.handler(worker, { step }, "manual");
    const [stored] = await setup.api.db
      .select()
      .from(settingCheck)
      .where(eq(settingCheck.key, step));
    const state = await workerCheckState(setup.api, step);
    return {
      stored: JSON.stringify(stored),
      shown: JSON.stringify(state),
      logged: JSON.stringify(logs.map((log) => log.mock.calls)),
    };
  } finally {
    fetch.mockRestore();
    for (const log of logs) log.mockRestore();
  }
}

const microsoftError =
  (status: number): Answer["response"] =>
  () =>
    Response.json(
      {
        error: { code: TENANT_CODE, message: TENANT_TEXT },
        error_description: TENANT_TEXT,
      },
      { status },
    );

describe("Microsoft's error text never reaches a stored scanner check", () => {
  const cases: [string, "scanner" | "what_to_sync", Answer][] = [
    [
      "a 500 from workspaces/modified",
      "scanner",
      { path: "/workspaces/modified", response: microsoftError(500) },
    ],
    [
      "a 404 from workspaces/modified",
      "scanner",
      { path: "/workspaces/modified", response: microsoftError(404) },
    ],
    [
      "a 403 from workspaces/modified",
      "scanner",
      { path: "/workspaces/modified", response: microsoftError(403) },
    ],
    [
      "a 500 from groups, for What to sync",
      "what_to_sync",
      { path: "/groups", response: microsoftError(500) },
    ],
    [
      "a failed scan",
      "scanner",
      {
        path: "/workspaces/scanStatus/",
        response: () =>
          Response.json({
            id: "scan",
            status: "Failed",
            error: { code: TENANT_CODE, message: TENANT_TEXT },
          }),
      },
    ],
    [
      "a token request Microsoft refuses",
      "scanner",
      { path: "/oauth2/v2.0/token", response: microsoftError(400) },
    ],
  ];

  it.each(cases)(
    "holds none of it after %s, in the row, in what the api shows, or in the log",
    async (_label, step, answer) => {
      const { stored, shown, logged } = await checkWith(answer, step);
      for (const text of [stored, shown, logged])
        for (const phrase of [...TENANT_PHRASES, "Trace"])
          expect(text).not.toContain(phrase);
      expect(stored).toContain('"status":"failing"');
    },
  );

  it("holds none of it after a token request Microsoft refuses on the credentials check, in the job, in what the api shows, or in the log", async () => {
    await configureScanner();
    // A secret no token is kept for, as the real runner keeps the real clock.
    await setSecret(
      { ...setup.api, principal: principals.admin },
      "powerbi_scanner_client_secret",
      "a-secret-with-no-token-kept",
      { expires_at: null },
    );
    const real = setup.worker.fetcher.fetchFixed.bind(setup.worker.fetcher);
    const fetch = vi
      .spyOn(setup.worker.fetcher, "fetchFixed")
      .mockImplementation((url, init) =>
        String(url).includes("/oauth2/v2.0/token")
          ? Promise.resolve(microsoftError(400)())
          : real(url, init),
      );
    const logs = [
      vi.spyOn(setup.worker.logger, "warn"),
      vi.spyOn(setup.worker.logger, "error"),
      vi.spyOn(setup.worker.logger, "info"),
    ];
    setup.startWorker();
    try {
      const step = "scanner_credentials";
      await queueCheckInWorker(
        { ...setup.api, principal: principals.admin },
        step,
      );
      await expect
        .poll(async () => (await workerCheckState(setup.api, step)).pending, {
          timeout: 20_000,
        })
        .toBeUndefined();
      const state = await workerCheckState(setup.api, step);
      expect(state.status).toBe("failing");
      const { rows } = await testPool("migrator").query(
        "select error from job_request where args->>'step' = $1",
        [step],
      );
      expect(rows).toHaveLength(1);
      const shown = [JSON.stringify(rows), JSON.stringify(state)];
      for (const text of shown) expect(text).not.toContain(TENANT_CODE);
      for (const text of [
        ...shown,
        JSON.stringify(logs.map((log) => log.mock.calls)),
      ])
        for (const phrase of [...TENANT_PHRASES, "Trace"])
          expect(text).not.toContain(phrase);
    } finally {
      await setup.stopWorker();
      fetch.mockRestore();
      for (const log of logs) log.mockRestore();
    }
  });
});
