import { randomUUID } from "node:crypto";
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
import type { Db } from "../../context.js";
import { account, user } from "../../db/schema/auth.js";
import { personSignIn } from "../../db/schema/roles.js";
import {
  DEV_SIGN_IN_METHOD,
  DEV_SIGN_IN_SCOPE,
  refuseDevSignInResidue,
} from "./dev-sign-in.js";
import { assignRole, MICROSOFT } from "./roles.js";

// Its own file, so its database is a fresh clone that nothing signed into yet.

afterAll(closeTestPools);

const SHUT = testConfig("api", { ALLOW_DEV_SIGN_IN: "0" });
const OPEN = testConfig("api", { ALLOW_DEV_SIGN_IN: "1" });

/** A user with the Microsoft account the dev sign-in makes for objectId. */
async function devMade(db: Db, email: string, objectId: string) {
  const id = randomUUID();
  await db.insert(user).values({ id, name: email, email, emailVerified: true });
  await db.insert(account).values({
    id: randomUUID(),
    userId: id,
    providerId: MICROSOFT,
    accountId: objectId,
    scope: DEV_SIGN_IN_SCOPE,
  });
  return id;
}

describe("the api's start with the dev sign-in shut", () => {
  const db = createTestDeps().db;

  it("starts on a database the dev sign-in never touched", async () => {
    await expect(refuseDevSignInResidue(db, SHUT)).resolves.toBeUndefined();
  });

  it("refuses to start on an account the dev sign-in made, and says how to remove it", async () => {
    await devMade(db, `residue-${randomUUID()}@example.test`, randomUUID());
    await expect(refuseDevSignInResidue(db, SHUT)).rejects.toThrow(
      /1 account rows with scope 'dev-sign-in' and 0 person_sign_in rows.*delete from account where scope = 'dev-sign-in'/,
    );
    // Open, the dev sign-in may keep what it made.
    await expect(refuseDevSignInResidue(db, OPEN)).resolves.toBeUndefined();
  });

  it("refuses to start on a sign-in the dev sign-in recorded", async () => {
    const [made] = await db.select({ id: user.id }).from(user).limit(1);
    if (made === undefined) throw new Error("the test before made a user");
    await db.insert(personSignIn).values({
      user_id: made.id,
      provider: DEV_SIGN_IN_METHOD,
      signed_in_at: new Date(),
    });
    await expect(refuseDevSignInResidue(db, SHUT)).rejects.toThrow(
      /1 person_sign_in rows with provider 'dev'.*delete from person_sign_in where provider = 'dev'/,
    );
  });
});

describe("Microsoft's callback with the dev sign-in shut", () => {
  let f: SignInFixture;
  beforeAll(async () => {
    f = await startSignIn({ env: { ALLOW_DEV_SIGN_IN: "0" } });
  });
  afterAll(async () => {
    await f.close();
  });

  it("signs nobody in through an account the dev sign-in made", async () => {
    const who = f.person("viewer");
    await assignRole(
      f.deps.db,
      { role: "viewer", subject_kind: "person", subject: who.email },
      principals.admin,
    );
    await devMade(f.deps.db, who.email, who.object_id);
    const { callback, cookie } = await f.signIn(who, "microsoft");
    expect(callback.status).toBe(302);
    const back = new URL(
      String(callback.headers.get("location")),
      TEST_PUBLIC_BASE_URL,
    );
    expect(back.searchParams.get("error")).toBe("dev_sign_in_account");
    expect(callback.headers.getSetCookie().join(";")).not.toMatch(
      /session_token=/,
    );
    const me = await f.request("/api/v1/me", { headers: { cookie } });
    expect(me.status).toBe(401);
  });
});
