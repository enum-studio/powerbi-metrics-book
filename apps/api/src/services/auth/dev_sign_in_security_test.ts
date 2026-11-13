import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeTestPools,
  createTestDeps,
  principals,
  TEST_PUBLIC_BASE_URL,
  testConfig,
} from "../../../test/deps.js";
import {
  type SignInFixture,
  startSignIn,
} from "../../../test/sign-in-support.js";
import { createApp } from "../../app.js";
import { account, user } from "../../db/schema/auth.js";
import { DEV_SIGN_IN_SCOPE } from "./dev-sign-in.js";
import { assignRole } from "./roles.js";

afterAll(closeTestPools);

const email = `dev-sign-in-${randomUUID()}@example.test`;

beforeAll(async () => {
  await assignRole(
    createTestDeps().db,
    { role: "viewer", subject_kind: "person", subject: email },
    principals.admin,
  );
});

async function devSignIn(
  env: Record<string, string>,
  extra: object = {},
): Promise<Response> {
  const app = createApp(createTestDeps({ config: testConfig("api", env) }));
  return app.request("/api/auth/dev/sign-in", {
    method: "POST",
    headers: {
      origin: TEST_PUBLIC_BASE_URL,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email, ...extra }),
  });
}

describe("the dev sign-in", () => {
  it("answers 404 in production even with ALLOW_DEV_SIGN_IN=1", async () => {
    const response = await devSignIn({
      NODE_ENV: "production",
      ALLOW_DEV_SIGN_IN: "1",
    });
    expect(response.status).toBe(404);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("answers 404 in test without ALLOW_DEV_SIGN_IN=1", async () => {
    for (const flag of ["0", ""]) {
      const response = await devSignIn({
        NODE_ENV: "test",
        ALLOW_DEV_SIGN_IN: flag,
      });
      expect(response.status, `ALLOW_DEV_SIGN_IN=${flag}`).toBe(404);
      expect(response.headers.getSetCookie()).toEqual([]);
    }
  });

  it("signs the person in when both locks are open", async () => {
    for (const NODE_ENV of ["test", "development"]) {
      const response = await devSignIn({ NODE_ENV, ALLOW_DEV_SIGN_IN: "1" });
      expect(response.status, NODE_ENV).toBe(200);
      expect(response.headers.getSetCookie().join(";")).toMatch(
        /session_token=/,
      );
    }
  });

  it("stays absent with an object id too, and makes no account", async () => {
    const object_id = randomUUID();
    for (const env of [
      { NODE_ENV: "production", ALLOW_DEV_SIGN_IN: "1" },
      { NODE_ENV: "test", ALLOW_DEV_SIGN_IN: "0" },
    ]) {
      const response = await devSignIn(env, { object_id });
      expect(response.status, env.NODE_ENV).toBe(404);
      expect(response.headers.getSetCookie()).toEqual([]);
    }
    const made = await createTestDeps()
      .db.select({ id: account.id })
      .from(account)
      .where(eq(account.accountId, object_id));
    expect(made).toEqual([]);
  });
});

describe("the dev sign-in with an Entra object id", () => {
  let f: SignInFixture;
  beforeAll(async () => {
    f = await startSignIn({ env: { ALLOW_DEV_SIGN_IN: "1" } });
  });
  afterAll(async () => {
    await f.close();
  });

  const signIn = (body: object) =>
    f.request("/api/auth/dev/sign-in", {
      method: "POST",
      headers: {
        origin: TEST_PUBLIC_BASE_URL,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const sessionUser = async (cookie: string) => {
    const session = await f.request("/api/auth/get-session", {
      headers: { cookie },
    });
    return ((await session.json()) as { user: { id: string } }).user.id;
  };

  it("makes the person Microsoft's sign-in then finds, with no linking", async () => {
    const who = f.person("viewer");
    await assignRole(
      f.deps.db,
      { role: "viewer", subject_kind: "person", subject: who.email },
      principals.admin,
    );
    const dev = await signIn({ email: who.email, object_id: who.object_id });
    expect(dev.status).toBe(200);
    const { user_id } = (await dev.json()) as { user_id: string };

    const { callback, cookie } = await f.signIn(who, "microsoft");
    expect(callback.status).toBe(302);
    const back = new URL(
      String(callback.headers.get("location")),
      TEST_PUBLIC_BASE_URL,
    );
    expect(back.searchParams.get("error")).toBeNull();
    expect(await sessionUser(cookie)).toBe(user_id);
  });

  it("refuses an object id another person's Microsoft account holds", async () => {
    const [first, second] = [f.person("analyst"), f.person("leader")];
    for (const who of [first, second])
      await assignRole(
        f.deps.db,
        { role: "viewer", subject_kind: "person", subject: who.email },
        principals.admin,
      );
    const taken = await signIn({
      email: first.email,
      object_id: first.object_id,
    });
    expect(taken.status).toBe(200);
    const refused = await signIn({
      email: second.email,
      object_id: first.object_id,
    });
    expect(refused.status).toBe(409);
    expect(refused.headers.getSetCookie()).toEqual([]);
    // The same object id in capitals is the same account.
    const shouted = await signIn({
      email: second.email,
      object_id: first.object_id.toUpperCase(),
    });
    expect(shouted.status).toBe(409);
  });

  it("refuses a user who holds another Microsoft account", async () => {
    const who = f.person("revoked");
    await assignRole(
      f.deps.db,
      { role: "viewer", subject_kind: "person", subject: who.email },
      principals.admin,
    );
    const bound = await signIn({ email: who.email, object_id: who.object_id });
    expect(bound.status).toBe(200);
    const other = await signIn({ email: who.email, object_id: randomUUID() });
    expect(other.status).toBe(409);
    expect(other.headers.getSetCookie()).toEqual([]);
  });

  it("makes one user and one marked account for sign-ins that arrive at once", async () => {
    const who = f.person("outsider");
    await assignRole(
      f.deps.db,
      { role: "viewer", subject_kind: "person", subject: who.email },
      principals.admin,
    );
    const answers = await Promise.all(
      Array.from({ length: 16 }, () =>
        signIn({ email: who.email, object_id: who.object_id }),
      ),
    );
    expect(answers.map((answer) => answer.status)).toEqual(
      Array.from({ length: 16 }, () => 200),
    );
    const users = await f.deps.db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, who.email));
    expect(users).toHaveLength(1);
    const accounts = await f.deps.db
      .select({ userId: account.userId, scope: account.scope })
      .from(account)
      .where(eq(account.accountId, who.object_id));
    expect(accounts).toEqual([
      { userId: users[0]?.id, scope: DEV_SIGN_IN_SCOPE },
    ]);
  });
});
