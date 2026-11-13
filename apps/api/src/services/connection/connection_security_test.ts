import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { request } from "undici";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  closeTestPools,
  principals,
  TEST_PUBLIC_BASE_URL,
  testPool,
} from "../../../test/deps.js";
import { softwarePasskey } from "../../../test/passkey-support.js";
import { rolledBack } from "../../../test/sample-mirror.js";
import { newIdentity } from "../../../test/secrets-support.js";
import {
  cookies,
  followConnect,
  OIDC,
  type SignInFixture,
  startSignIn,
} from "../../../test/sign-in-support.js";
import { type AppEnv, createApp } from "../../app.js";
import { createDb } from "../../db/client.js";
import { user } from "../../db/schema/auth.js";
import { auditEvent } from "../../db/schema/audit.js";
import {
  powerbiConnection,
  powerbiConnectState,
} from "../../db/schema/connection.js";
import { personIdentity } from "../../db/schema/mirror.js";
import { assignRole } from "../auth/roles.js";
import { decryptWith } from "../secrets/age.js";
import type { LoadedIdentity } from "../secrets/identities.js";
import { hidingValues } from "./store.js";

/*
 * The boundary around a person's Power BI tokens (threat model B7), against
 * the mock's Microsoft identity routes: what is stored, and who may connect
 * which account.
 */

let f: SignInFixture;
let app: Hono<AppEnv>;
let api: LoadedIdentity;
/** Every access and refresh token the mock's token endpoint answered the api. */
const issued: string[] = [];
/** When set, claims the ID token the api reads says in place of the mock's. */
let idTokenSays: Record<string, unknown> | null = null;

function withClaims(idToken: string, says: Record<string, unknown>): string {
  const [header = "", payload = "", signature = ""] = idToken.split(".");
  const claims: unknown = JSON.parse(
    Buffer.from(payload, "base64url").toString(),
  );
  const changed = Buffer.from(JSON.stringify({ ...Object(claims), ...says }));
  return [header, changed.toString("base64url"), signature].join(".");
}

beforeAll(async () => {
  api = await newIdentity();
  f = await startSignIn({ identity: api });
  // These sign-ins reach their people through the default role.
  await f.settings.set("access.default_role", "viewer");
  const fetcher = f.deps.fetcher;
  app = createApp({
    ...f.deps,
    fetcher: {
      ...f.deps.fetcher,
      fetchFixed: async (url, init) => {
        const answer = await fetcher.fetchFixed(url, init);
        if (!String(url).endsWith("/oauth2/v2.0/token") || !answer.ok)
          return answer;
        const body = (await answer.json()) as Record<string, unknown>;
        for (const token of [body.access_token, body.refresh_token])
          if (typeof token === "string") issued.push(token);
        if (idTokenSays !== null && typeof body.id_token === "string")
          body.id_token = withClaims(body.id_token, idTokenSays);
        return Response.json(body);
      },
    },
  });
});

afterAll(async () => {
  await f.close();
  await closeTestPools();
});

async function signedIn(mailbox: string, provider = "microsoft") {
  const who = f.person(mailbox);
  if (provider !== "microsoft")
    await assignRole(
      f.deps.db,
      { role: "viewer", subject_kind: "person", subject: who.email },
      principals.admin,
    );
  const { cookie } = await f.signIn(who, provider);
  return { cookie, id: await f.userId(who.email) };
}

async function connectionOf(userId: string) {
  const [row] = await f.deps.db
    .select()
    .from(powerbiConnection)
    .where(eq(powerbiConnection.user_id, userId));
  return row;
}

async function refusal(answer: Response, status: number, message: RegExp) {
  expect(answer.status).toBe(status);
  expect(((await answer.json()) as { message: string }).message).toMatch(
    message,
  );
}

describe("a person's Power BI tokens", () => {
  it("leave no token in clear in any column of the person's connection", async () => {
    const leader = await signedIn("leader");
    expect((await followConnect(app, leader.cookie)).answer.status).toBe(302);
    // The redeem's refresh token, then the one Graph's refresh answered.
    expect(issued.length).toBeGreaterThanOrEqual(4);
    const { rows } = await f.deps.pool.query<Record<string, unknown>>(
      "select * from powerbi_connection where user_id = $1",
      [leader.id],
    );
    const columns = Object.entries(rows[0] ?? {});
    expect(columns.filter(([, value]) => Buffer.isBuffer(value))).toHaveLength(
      2,
    );
    for (const [name, value] of columns) {
      const text = Buffer.isBuffer(value)
        ? value.toString("latin1")
        : JSON.stringify(value);
      for (const token of issued) expect(text, name).not.toContain(token);
    }
  });

  it("are encrypted for the api's identity alone, which the worker's is not", async () => {
    const viewer = await signedIn("sales-viewer");
    expect((await followConnect(app, viewer.cookie)).answer.status).toBe(302);
    const row = await connectionOf(viewer.id);
    const worker = await newIdentity();
    for (const ciphertext of [
      row?.access_token_ciphertext ?? new Uint8Array(),
      row?.refresh_token_ciphertext ?? new Uint8Array(),
    ]) {
      const stanzas = Buffer.from(ciphertext)
        .toString("latin1")
        .match(/^-> /gm);
      expect(stanzas).toHaveLength(1);
      expect(issued).toContain(await decryptWith(api.identity, ciphertext));
      await expect(decryptWith(worker.identity, ciphertext)).rejects.toThrow();
    }
    expect(row?.recipient).toBe(api.recipient);
  });
});

describe("connecting an account", () => {
  beforeEach(async () => {
    await f.settings.set("powerbi.connection_requires_matching_email", true);
  });
  afterEach(async () => {
    await f.settings.set("powerbi.connection_requires_matching_email", false);
  });
  const invalidTokens = [
    [
      "another tenant",
      { tid: randomUUID() },
      /not in the company's Power BI tenant/,
    ],
    ["another app", { aud: randomUUID() }, /not issued for this app/],
    [
      "another issuer",
      { iss: "https://elsewhere.example/v2.0" },
      /not issued for this app/,
    ],
    [
      "an expired one",
      { exp: Math.floor(Date.now() / 1000) - 60 },
      /has expired/,
    ],
  ] as const;
  it.each(
    invalidTokens.flatMap(([name, says, reason]) =>
      [false, true].map((strict) => [strict, name, says, reason] as const),
    ),
  )(
    "with strict %s refuses an ID token from %s, and audits the refusal",
    async (strict, _, says, reason) => {
      await f.settings.set(
        "powerbi.connection_requires_matching_email",
        strict,
      );
      const admin = await signedIn("admin");
      idTokenSays = says;
      try {
        const { answer } = await followConnect(app, admin.cookie);
        await refusal(answer, 403, reason);
      } finally {
        idTokenSays = null;
      }
      expect(await connectionOf(admin.id)).toBeUndefined();
      const audited = await createDb(testPool("migrator"))
        .select()
        .from(auditEvent)
        .where(eq(auditEvent.principal_id, admin.id))
        .orderBy(desc(auditEvent.id))
        .limit(1);
      expect(audited[0]).toMatchObject({
        action: "powerbi.connect",
        decision: "deny",
        reason: expect.stringMatching(reason) as unknown,
      });
    },
  );

  it("refuses a person signed in with Microsoft who connects another account", async () => {
    const analyst = await signedIn("analyst");
    f.actAs(f.person("viewer"));
    const { answer } = await followConnect(app, analyst.cookie);
    await refusal(answer, 403, /the Microsoft account you signed in with/);
    expect(await connectionOf(analyst.id)).toBeUndefined();
  });

  it("holds a person who signed in with Microsoft to that account after a passkey sign-in too", async () => {
    const admin = await signedIn("admin");
    await f.settings.set("sign_in.passkeys", true);
    f.advance(31_000);
    try {
      const key = softwarePasskey(
        new URL(TEST_PUBLIC_BASE_URL).hostname,
        TEST_PUBLIC_BASE_URL,
      );
      const json = {
        "content-type": "application/json",
        origin: TEST_PUBLIC_BASE_URL,
      };
      const ceremony = async (
        start: string,
        finish: string,
        cookie: string,
        body: (challenge: string) => unknown,
      ) => {
        const options = await f.request(start, { headers: { cookie } });
        const { challenge } = (await options.json()) as { challenge: string };
        return f.request(finish, {
          method: "POST",
          headers: {
            ...json,
            cookie: [cookie, cookies(options)].filter(Boolean).join("; "),
          },
          body: JSON.stringify(body(challenge)),
        });
      };
      const registered = await ceremony(
        "/api/auth/passkey/generate-register-options",
        "/api/auth/passkey/verify-registration",
        admin.cookie,
        (challenge) => key.registration(challenge, true),
      );
      expect(registered.status).toBe(200);
      const passkey = await ceremony(
        "/api/auth/passkey/generate-authenticate-options",
        "/api/auth/passkey/verify-authentication",
        "",
        (challenge) => key.assertion(challenge, true),
      );
      expect(passkey.status).toBe(200);

      f.actAs(f.person("outsider"));
      const { answer } = await followConnect(app, cookies(passkey));
      await refusal(answer, 403, /the Microsoft account you signed in with/);
    } finally {
      await f.settings.set("sign_in.passkeys", false);
      f.advance(31_000);
    }
    expect(await connectionOf(admin.id)).toBeUndefined();
  });

  it("refuses an account another person has connected", async () => {
    const owner = await signedIn("app-reader");
    expect((await followConnect(app, owner.cookie)).answer.status).toBe(302);
    const other = await signedIn("outsider", OIDC);
    f.actAs(f.person("app-reader"));
    idTokenSays = { email: f.person("outsider").email };
    try {
      const { answer } = await followConnect(app, other.cookie);
      await refusal(answer, 409, /connected to another person already/);
    } finally {
      idTokenSays = null;
    }
    expect(await connectionOf(other.id)).toBeUndefined();
  });

  it("refuses, after another sign-in, an account whose email is not the person's", async () => {
    const viewer = await signedIn("viewer", OIDC);
    f.actAs(f.person("admin"));
    const { answer } = await followConnect(app, viewer.cookie);
    await refusal(answer, 403, /whose email address is yours/);
    expect(await connectionOf(viewer.id)).toBeUndefined();
    f.actAs(f.person("viewer"));
    expect((await followConnect(app, viewer.cookie)).answer.status).toBe(302);
  });
});

describe("the round trip", () => {
  it("keeps one pending state per session: a new connect replaces the earlier one", async () => {
    const { cookie } = await signedIn("analyst");
    const authorized = async () => {
      const connect = await app.request("/api/v1/powerbi/connect", {
        headers: { cookie },
      });
      const answer = await request(String(connect.headers.get("location")));
      await answer.body.dump();
      const back = new URL(String(answer.headers.location));
      return `${back.pathname}${back.search}`;
    };
    const earlier = await authorized();
    const later = await authorized();
    const answer = await app.request(earlier, { headers: { cookie } });
    await refusal(answer, 403, /expired or was used already/);
    expect((await app.request(later, { headers: { cookie } })).status).toBe(
      302,
    );
  });

  it("names no PKCE verifier when a write fails, and answers a taken account as admit does", async () => {
    const verifier = `sample-verifier-${randomUUID()}`;
    await rolledBack("api_rw", async (db) => {
      const failed = hidingValues(
        db.insert(powerbiConnectState).values({
          state_digest: randomUUID(),
          session_id: `no-such-session-${randomUUID()}`,
          code_verifier: verifier,
          next: "/",
          expires_at: new Date(),
        }),
      );
      await expect(failed).rejects.toThrow(/foreign key/);
      await expect(failed).rejects.not.toThrow(verifier);
    });
    await rolledBack("api_rw", async (db) => {
      const oid = randomUUID();
      const ids = [`taken-${randomUUID()}`, `taker-${randomUUID()}`];
      const connect = async (id: string) => {
        await db.insert(user).values({
          id,
          name: "one account",
          email: `${id}@sample.example`,
        });
        await hidingValues(
          db.insert(powerbiConnection).values({
            user_id: id,
            microsoft_object_id: oid,
            status: "disconnected",
            connected_at: new Date(),
          }),
        );
        await hidingValues(
          db
            .insert(personIdentity)
            .values({ user_id: id, microsoft_object_id: oid }),
        );
      };
      await connect(ids[0] ?? "");
      await expect(connect(ids[1] ?? "")).rejects.toMatchObject({
        kind: "conflict",
        message:
          "This Microsoft account is connected to another person already.",
      });
    });
  });

  it("spends a state once, and only from the session that started it", async () => {
    const started = await signedIn("analyst");
    const otherSession = await signedIn("analyst");
    const connect = await app.request("/api/v1/powerbi/connect", {
      headers: { cookie: started.cookie },
    });
    const authorized = await request(String(connect.headers.get("location")));
    await authorized.body.dump();
    const back = new URL(String(authorized.headers.location));
    const callback = `${back.pathname}${back.search}`;
    for (const cookie of [otherSession.cookie, started.cookie]) {
      const answer = await app.request(callback, { headers: { cookie } });
      await refusal(answer, 403, /expired or was used already/);
    }
    const { answer, callback_url } = await followConnect(app, started.cookie);
    expect(answer.status).toBe(302);
    const replayed = await app.request(String(callback_url), {
      headers: { cookie: started.cookie },
    });
    await refusal(replayed, 403, /expired or was used already/);
  });

  it("sends the browser back only to a page of this app", async () => {
    const { cookie } = await signedIn("analyst");
    for (const next of [
      "https://elsewhere.example/settings",
      "//elsewhere.example/settings",
      "/\\elsewhere.example",
      "/api/v1/me",
      "javascript:alert(1)",
      "/%2F%2Felsewhere.example",
      "/settings/..//elsewhere.example",
      "/%5Celsewhere.example",
      "%2e%2e",
      "/settings\r\nLocation: https://elsewhere.example",
      "/settings\tx",
      "/catalogue",
    ]) {
      const answer = await app.request(
        `/api/v1/powerbi/connect?next=${encodeURIComponent(next)}`,
        { headers: { cookie } },
      );
      await refusal(answer, 400, /next must be a page of this app/);
    }
    const listed = await app.request(
      `/api/v1/powerbi/connect?next=${encodeURIComponent("/review/metrics/revenue?tab=dax")}`,
      { headers: { cookie } },
    );
    expect(listed.status).toBe(302);
    const catalog = await app.request(
      `/api/v1/powerbi/connect?next=${encodeURIComponent("/catalog/metrics/revenue")}`,
      { headers: { cookie } },
    );
    expect(catalog.status).toBe(302);
  });
});
