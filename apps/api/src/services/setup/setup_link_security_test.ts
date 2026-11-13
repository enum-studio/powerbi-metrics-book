import { and, eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeTestPools,
  principals,
  TEST_PUBLIC_BASE_URL,
} from "../../../test/deps.js";
import {
  joined,
  startSetup,
  type SetupFixture,
  tokenOf,
} from "../../../test/setup-support.js";
import { cookies, freshPeer } from "../../../test/sign-in-support.js";
import { createApp } from "../../app.js";
import { settingCheck } from "../../db/schema/admin.js";
import { auditEvent } from "../../db/schema/audit.js";
import { jobRequest } from "../../db/schema/jobs.js";
import { roleAssignment } from "../../db/schema/roles.js";
import { secret, secret_ciphertext } from "../../db/schema/secrets.js";
import { setupLink } from "../../db/schema/setup.js";
import { PUBLIC_PATHS } from "../../http/public-paths.js";
import { createLogger } from "../../log.js";
import { storeCheck } from "../admin/checks.js";
import { hasAdmin } from "../admin/people.js";
import { announceSetupLink, newSetupLink } from "./link.js";
import { SETUP_SESSION_STEPS, STEPS } from "./steps.js";

/*
 * The first-run door (threat model B9): a link works once, for 24 hours,
 * and only while no admin exists; its session lasts 12 hours, runs the
 * allowed setup steps only, and may start one Microsoft sign-in, which sign-in
 * admits for the flow that session's browser started; the person it made
 * becomes admin only once confirmed by email.
 */

let setup: SetupFixture;
beforeAll(async () => {
  setup = await startSetup();
});
afterAll(async () => {
  await setup.close();
  await closeTestPools();
});
beforeEach(async () => {
  await setup.api.db.delete(roleAssignment);
  await setup.api.db.delete(setupLink);
  await setup.api.settings.set("access.default_role", "none", principals.admin);
});

const spend = (token: string) =>
  setup.post("/api/setup/session", "", { token });
const link = (options = { revoke_earlier: false }) =>
  newSetupLink(setup.api, options);
const someAdmin = () =>
  setup.api.db.insert(roleAssignment).values({
    role: "admin",
    subject_kind: "person",
    subject: "someone@sample.example",
    granted_by: principals.admin.id,
  });
function refused(callback: Response): void {
  expect(callback.headers.get("location")).toContain("error=not_assigned");
}

/** Every setup route, asked as the setup's screen asks it. */
const setupRoutes = PUBLIC_PATHS.map((entry) =>
  entry.replace(/^[A-Z]+ /, ""),
).filter((path) => path.startsWith("/api/setup"));
const ask = (path: string, cookie: string) =>
  path === "/api/setup"
    ? setup.request(path, { headers: { cookie } })
    : setup.post(path, cookie, { token: "x" });

/** The step that saves the app registration, which answers with the sign-in's marker. */
async function registerApp(cookie: string): Promise<string> {
  const sample = setup.tenant.apps_registrations[0];
  const answer = await setup.post("/api/setup/steps/app_registration", cookie, {
    settings: {
      "powerbi.tenant_id": setup.tenant.tenant_id,
      "powerbi.app_client_id": sample?.client_id,
    },
    secrets: {
      powerbi_app_client_secret: { value: sample?.secret, expires_at: null },
    },
  });
  expect(answer.status).toBe(200);
  expect(((await answer.json()) as { action: string }).action).toBe("sign_in");
  return joined(cookie, cookies(answer));
}

describe("the setup link", () => {
  it("refuses a token the second time it is used", async () => {
    const token = tokenOf(await link());
    expect((await spend(token)).status).toBe(204);
    expect((await spend(token)).status).toBe(404);
  });

  it("lets one of two spends at once win, and only one", async () => {
    const token = tokenOf(await link());
    const answers = await Promise.all([spend(token), spend(token)]);
    expect(answers.map((a) => a.status).sort()).toEqual([204, 404]);
  });

  it("refuses a token 24 hours after it was made", async () => {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000 - 1000);
    const token = tokenOf(
      await newSetupLink(
        { ...setup.api, clock: () => dayAgo },
        { revoke_earlier: false },
      ),
    );
    expect((await spend(token)).status).toBe(404);
  });

  it("ends a setup session 12 hours after its link was spent", async () => {
    const cookie = await setup.openSession();
    expect((await ask("/api/setup", cookie)).status).toBe(200);
    await setup.api.db
      .update(setupLink)
      .set({ session_expires_at: new Date(Date.now() - 1000) });
    expect((await ask("/api/setup", cookie)).status).toBe(404);
  });

  it("ends every earlier link and session when server setup-link makes a new one", async () => {
    const unused = tokenOf(await link());
    const cookie = await setup.openSession();
    await link({ revoke_earlier: true });
    expect((await ask("/api/setup", cookie)).status).toBe(404);
    expect((await spend(unused)).status).toBe(404);
  });

  it("leaves at start only the new link's token working, and an open session open", async () => {
    const earlier = tokenOf(await link());
    const session = await setup.openSession();
    const latest = tokenOf(await link());
    expect((await spend(earlier)).status).toBe(404);
    expect((await ask("/api/setup", session)).status).toBe(200);
    expect((await spend(latest)).status).toBe(204);
  });

  it("says at start that a link can be printed, and logs no link and no token", async () => {
    const lines: string[] = [];
    const logger = createLogger("debug", (line) => lines.push(line));
    await announceSetupLink({ ...setup.api, logger });
    expect(await setup.api.db.select().from(setupLink)).toEqual([]);
    const logged = lines.join("\n");
    expect(logged).toContain("server setup-link");
    expect(logged).not.toMatch(/token|setup_link|\/setup#/);
    await someAdmin();
    lines.length = 0;
    await announceSetupLink({ ...setup.api, logger });
    expect(lines).toEqual([]);
  });

  it("answers 404 on every setup route without a setup session", async () => {
    expect(setupRoutes).toContain("/api/setup/tenant");
    for (const path of setupRoutes)
      expect((await ask(path, "")).status, path).toBe(404);
  });

  it("answers 404 to the scanner's credentials check without a setup session, and queues nothing", async () => {
    const jobs = () =>
      setup.api.db.select({ id: jobRequest.id }).from(jobRequest);
    const before = (await jobs()).length;
    const answer = await setup.post("/api/setup/steps/scanner", "", {
      credentials_only: true,
      start_check: true,
    });
    expect(answer.status).toBe(404);
    expect(await jobs()).toHaveLength(before);
  });

  it("lets the setup session read the state and run only its allowed steps", async () => {
    expect([...SETUP_SESSION_STEPS].sort()).toEqual([
      "address",
      "app_registration",
      "scanner",
    ]);
    expect(STEPS.map((step) => step.id)).toEqual([
      "address",
      "app_registration",
      "scanner",
      "what_to_sync",
      "sign_in",
      "who_gets_in",
      "search",
      "agents",
      "first_sync",
      "security",
    ]);
    const cookie = await setup.openSession();
    expect((await ask("/api/setup", cookie)).status).toBe(200);
    expect((await setup.post("/api/setup/steps/address", cookie)).status).toBe(
      200,
    );
    for (const step of [
      "what_to_sync",
      "sign_in",
      "who_gets_in",
      "search",
      "agents",
      "first_sync",
      "security",
    ])
      for (const body of [{ settings: { "access.default_role": "admin" } }, {}])
        expect(
          (await setup.post(`/api/setup/steps/${step}`, cookie, body)).status,
          step,
        ).toBe(404);
  });

  it("takes a date alone only for a secret of the step it was sent to", async () => {
    const cookie = await setup.openSession();
    const dated = { expires_at: "2027-06-30T23:59:59.000Z" };
    for (const [step, name] of [
      ["address", "powerbi_app_client_secret"],
      ["scanner", "powerbi_app_client_secret"],
      ["app_registration", "powerbi_scanner_client_secret"],
      ["app_registration", "openai_api_key"],
    ] as const) {
      const answer = await setup.post(`/api/setup/steps/${step}`, cookie, {
        secrets: { [name]: dated },
      });
      expect(answer.status, `${step} ${name}`).toBe(400);
    }
    expect(
      await setup.api.db
        .select({ name: secret.name })
        .from(secret)
        .where(isNotNull(secret.expires_at)),
    ).toEqual([]);
  });

  it("runs and polls scanner as the setup principal only before an admin exists", async () => {
    const cookie = await registerApp(await setup.openSession());
    const scanner = setup.tenant.service_principals.find(
      (sp) => sp.may_call_admin_apis,
    );
    if (scanner === undefined)
      throw new Error("The sample scanner is missing.");
    const body = {
      settings: { "powerbi.scanner_client_id": scanner.app_id },
      secrets: {
        powerbi_scanner_client_secret: {
          value: scanner.secret,
          expires_at: null,
        },
      },
    };
    const path = "/api/setup/steps/scanner";
    const saved = await setup.post(path, cookie, body);
    expect(saved.status).toBe(200);
    expect((await saved.clone().text()).includes(scanner.secret)).toBe(false);
    const readers = await setup.api.db
      .select({ reader: secret_ciphertext.reader })
      .from(secret_ciphertext)
      .where(eq(secret_ciphertext.name, "powerbi_scanner_client_secret"));
    expect(readers.map((row) => row.reader)).toEqual(["worker"]);
    expect(await saved.json()).toMatchObject({
      step: "scanner",
      pending: true,
    });
    const polled = await setup.post(path, cookie);
    expect(polled.status).toBe(200);
    expect((await polled.clone().text()).includes(scanner.secret)).toBe(false);
    expect(await polled.json()).toMatchObject({
      step: "scanner",
      pending: true,
    });
    const jobs = await setup.api.db
      .select()
      .from(jobRequest)
      .where(eq(jobRequest.requested_by, "setup_link"));
    expect(jobs).toMatchObject([
      {
        job: "check",
        runner: "worker",
        args: { step: "scanner" },
        status: "queued",
      },
    ]);
    expect(
      await setup.api.db
        .select()
        .from(auditEvent)
        .where(
          and(
            eq(auditEvent.action, "admin.check.run"),
            eq(auditEvent.resource_id, "scanner"),
          ),
        ),
    ).toMatchObject([
      {
        principal_kind: "person",
        principal_id: "setup_link",
        via: "browser",
        decision: "allow",
      },
    ]);
    const pollingLeaks: boolean[] = [];
    setup.startWorker();
    await expect
      .poll(
        async () => {
          const answer = await setup.post(path, cookie);
          expect(answer.status).toBe(200);
          pollingLeaks.push(
            (await answer.clone().text()).includes(scanner.secret),
          );
          return answer.json();
        },
        { timeout: 30_000 },
      )
      .toMatchObject({ step: "scanner", status: "passing" });
    expect(pollingLeaks).not.toContain(true);
    await setup.stopWorker();
    expect(
      await setup.api.db
        .select()
        .from(jobRequest)
        .where(eq(jobRequest.id, jobs[0]?.id ?? "")),
    ).toMatchObject([{ status: "succeeded", requested_by: "setup_link" }]);
    await someAdmin();
    for (const input of [body, {}]) {
      const refused = await setup.post(path, cookie, input);
      expect(refused.status).toBe(404);
      expect((await refused.text()).includes(scanner.secret)).toBe(false);
    }
  });

  it("closes every setup route once an admin exists, to a stale setup session and to a viewer", async () => {
    expect(setupRoutes).toContain("/api/setup/tenant");
    const unused = tokenOf(await link());
    const session = await registerApp(await setup.openSession());
    await setup.api.settings.set(
      "access.default_role",
      "viewer",
      principals.admin,
    );
    const viewer = await setup.signIn(setup.person("viewer"), "");
    expect(viewer.callback.headers.get("location")).toBe("/setup");
    expect(
      (
        await setup.post("/api/setup/tenant", session, {
          email: "admin@sample.example",
        })
      ).status,
    ).toBe(200);
    await someAdmin();
    for (const cookie of [session, cookies(viewer.callback)])
      for (const path of setupRoutes)
        expect((await ask(path, cookie)).status, path).toBe(404);
    expect(await link()).toBeNull();
    expect((await spend(unused)).status).toBe(404);
    expect(await setup.api.db.select().from(setupLink)).toEqual([]);
  });
});

describe("the setup API's rate limit", () => {
  it("refuses an address's 61st request on any route, leaves other addresses alone, and starts over at the next minute", async () => {
    // The limit counts in fixed windows on the clock minute, and a burst that
    // crossed one would split its count and never reach a 429. The start of a
    // day is the start of every longer window too, so second 60 frees only a
    // limit that counts by the minute; a burst from second 30 frees only one
    // that counts on the clock.
    const day = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    let held = new Date(day);
    const standAt = (seconds: number) => {
      held = new Date(day + seconds * 1000);
    };
    const app = createApp({ ...setup.api, clock: () => held });
    const knock = (
      path: string,
      peer: string,
      { cookie = "", body = {} }: { cookie?: string; body?: object } = {},
    ) =>
      app.request(
        path,
        path === "/api/setup"
          ? { headers: { cookie } }
          : {
              method: "POST",
              headers: {
                cookie,
                origin: TEST_PUBLIC_BASE_URL,
                "content-type": "application/json",
              },
              body: JSON.stringify({ token: "x", ...body }),
            },
        { incoming: { socket: { remoteAddress: peer } } },
      );
    expect(setupRoutes).toContain("/api/setup");
    expect(setupRoutes).toContain("/api/setup/session");
    const session = await setup.openSession();
    const peer = freshPeer();
    standAt(30);
    for (let i = 0; i < 60; i += 1) {
      const path = setupRoutes[i % setupRoutes.length] ?? "";
      expect((await knock(path, peer)).status, path).toBe(404);
    }
    const refused = await knock("/api/setup", peer);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ error: "rate_limited" });
    for (const path of setupRoutes)
      expect((await knock(path, peer)).status, path).toBe(429);
    // Ahead of the credential and the validator: a holder and a bad body count too.
    expect((await knock("/api/setup", peer, { cookie: session })).status).toBe(
      429,
    );
    expect(
      (await knock("/api/setup/session", peer, { body: { extra: 1 } })).status,
    ).toBe(429);
    standAt(59);
    expect((await knock("/api/setup", peer)).status).toBe(429);
    expect((await knock("/api/setup", freshPeer())).status).toBe(404);
    standAt(60);
    for (const path of setupRoutes)
      expect((await knock(path, peer)).status, path).toBe(404);
    expect((await knock("/api/setup", peer, { cookie: session })).status).toBe(
      200,
    );
  });
});

describe("the setup's Microsoft sign-in", () => {
  it("is refused without the marker, so another browser gets nothing from it", async () => {
    await registerApp(await setup.openSession());
    refused((await setup.signIn(setup.person("admin"), "")).callback);
  });

  it("admits one sign-in with the marker, and refuses a second", async () => {
    const cookie = await registerApp(await setup.openSession());
    const first = await setup.signIn(setup.person("admin"), cookie);
    expect(first.callback.headers.get("location")).toBe("/setup");
    expect(first.callback.headers.get("set-cookie")).toContain(
      "__Secure-pbmb_setup_sign_in=; Max-Age=0",
    );
    refused((await setup.signIn(setup.person("analyst"), cookie)).callback);
  });

  it("refuses a callback whose state the setup did not start, even with a live marker", async () => {
    const cookie = await registerApp(await setup.openSession());
    await setup.startSignIn(cookie);
    // Someone else's flow, its state cookie planted beside the live marker.
    const planted = await setup.startSignIn("");
    const callback = await setup.finishSignIn(
      setup.person("analyst"),
      planted.url,
      joined(cookie, planted.cookie),
    );
    refused(callback);
  });

  it("refuses a marker past its 10 minutes", async () => {
    const cookie = await registerApp(await setup.openSession());
    await setup.api.db
      .update(setupLink)
      .set({ sign_in_expires_at: new Date(Date.now() - 1000) });
    refused((await setup.signIn(setup.person("admin"), cookie)).callback);
  });

  it("makes the admitted person the first admin only when confirmed with their email", async () => {
    const cookie = await registerApp(await setup.openSession());
    const signedIn = await setup.signIn(setup.person("admin"), cookie);
    const step = "/api/setup/steps/app_registration";
    const asked = await setup.post(step, signedIn.cookie);
    expect(await asked.json()).toMatchObject({
      confirm: { email: "admin@sample.example" },
    });
    const wrong = await setup.post(step, signedIn.cookie, {
      confirm_email: "analyst@sample.example",
    });
    expect(wrong.status).toBe(400);
    expect(await hasAdmin(setup.api.db)).toBe(false);
    const right = await setup.post(step, signedIn.cookie, {
      confirm_email: "admin@sample.example",
    });
    expect(right.status).toBe(200);
    expect(await hasAdmin(setup.api.db)).toBe(true);
  });

  it("makes nobody admin for another person's session beside the setup cookie", async () => {
    const cookie = await registerApp(await setup.openSession());
    await setup.signIn(setup.person("admin"), cookie);
    await setup.api.settings.set(
      "access.default_role",
      "viewer",
      principals.admin,
    );
    const other = await setup.signIn(setup.person("analyst"), "");
    const setupCookie = cookie.split("; ")[0] ?? "";
    const answer = await setup.post(
      "/api/setup/steps/app_registration",
      joined(setupCookie, cookies(other.callback)),
      { confirm_email: "analyst@sample.example" },
    );
    expect(answer.status).toBe(200);
    expect(await hasAdmin(setup.api.db)).toBe(false);
  });

  it("is refused once an admin exists", async () => {
    const cookie = await registerApp(await setup.openSession());
    await someAdmin();
    refused((await setup.signIn(setup.person("admin"), cookie)).callback);
  });
});

describe("the worker's check results", () => {
  it("are written only on the rows of the checks the worker runs", async () => {
    const result = { status: "passing" as const, message: null };
    await storeCheck(setup.worker, "scanner", result);
    const refusal: unknown = await storeCheck(
      setup.worker,
      "app_registration",
      result,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(
      refusal instanceof Error && refusal.cause instanceof Error
        ? refusal.cause.message
        : refusal,
    ).toContain("row-level security");
    await storeCheck(setup.api, "app_registration", result);
    const seen = await setup.worker.db
      .select()
      .from(settingCheck)
      .where(eq(settingCheck.key, "app_registration"));
    expect(seen).toEqual([]);
  });
});
