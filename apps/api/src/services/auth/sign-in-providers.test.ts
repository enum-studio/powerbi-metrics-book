import { request } from "undici";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTestPools, principals } from "../../../test/deps.js";
import {
  OIDC,
  type SignInFixture,
  startSignIn,
} from "../../../test/sign-in-support.js";
import { account, user } from "../../db/schema/auth.js";
import { personIdentity } from "../../db/schema/mirror.js";
import { assignRole, MICROSOFT, NOT_ASSIGNED, revokeRole } from "./roles.js";

/*
 * Sign-in end to end through the mock's Microsoft identity routes and its
 * second OpenID Connect provider: start, the provider's authorize, the
 * callback, the session, /api/v1/me.
 */

let f: SignInFixture;

beforeAll(async () => {
  f = await startSignIn();
  // These sign-ins reach their people through the default role.
  await f.settings.set("access.default_role", "viewer");
});

afterAll(async () => {
  await f.close();
  await closeTestPools();
});

async function me(cookie: string): Promise<Record<string, unknown>> {
  const response = await f.request("/api/v1/me", { headers: { cookie } });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

function refusal(callback: Response): URL {
  expect(callback.status).toBe(302);
  return new URL(String(callback.headers.get("location")));
}

async function userId(email: string): Promise<string | undefined> {
  const [row] = await f.deps.db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email));
  return row?.id;
}

async function patchMock(path: string, body: object) {
  const answer = await request(
    `${await f.settings.get("powerbi.authority")}/_mock/${path}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  await answer.body.dump();
  expect(answer.statusCode).toBe(204);
}

describe("signing in with Microsoft", () => {
  it.each(["guest", "optional"])(
    "keeps the %s email claim ahead of the UPN",
    async (kind) => {
      const member = {
        ...f.person("outsider"),
        object_id: crypto.randomUUID(),
        email: `${kind}@sample.example`,
        user_principal_name: `${kind}-upn@sample.example`,
      };
      f.tenant.people.push(member);
      const app = `apps/${String(await f.settings.get("powerbi.app_client_id"))}`;
      await patchMock(
        kind === "guest" ? `people/${member.object_id}` : app,
        kind === "guest"
          ? { guest: true, home_address: "guest@partner.example" }
          : { email_optional_claim: true },
      );
      try {
        const { cookie } = await f.signIn(member, MICROSOFT, "/", {
          scopes: ["openid", "profile"],
        });
        expect(await me(cookie)).toMatchObject({ email: member.email });
      } finally {
        if (kind === "optional")
          await patchMock(app, { email_optional_claim: false });
      }
    },
  );

  it("uses a guest's home address when Microsoft sends no email claim", async () => {
    const guest = {
      ...f.person("outsider"),
      object_id: crypto.randomUUID(),
      email: "",
    };
    f.tenant.people.push(guest);
    await patchMock(`people/${guest.object_id}`, {
      guest: true,
      home_address: "no-claim@partner.example",
    });
    const { cookie } = await f.signIn(guest, MICROSOFT);
    expect(await me(cookie)).toMatchObject({
      email: "no-claim@partner.example",
    });
  });

  it("uses a member's email UPN when Microsoft sends no email claim", async () => {
    const member = {
      ...f.person("outsider"),
      object_id: crypto.randomUUID(),
      email: "",
      user_principal_name: "member-upn@sample.example",
    };
    f.tenant.people.push(member);
    const { cookie } = await f.signIn(member, MICROSOFT);
    expect(await me(cookie)).toMatchObject({
      email: member.user_principal_name,
    });
  });

  it("refuses a member with neither an email claim nor an email UPN", async () => {
    const member = {
      ...f.person("outsider"),
      object_id: crypto.randomUUID(),
      email: "",
      user_principal_name: "no-email",
    };
    f.tenant.people.push(member);
    const { callback } = await f.signIn(member, MICROSOFT);
    expect(
      new URL(
        String(callback.headers.get("location")),
        f.deps.config.public_base_url,
      ).searchParams.get("error"),
    ).toBe("email_not_found");
  });

  it("authorizes at the mock, makes a session and answers /api/v1/me", async () => {
    const admin = f.person("admin");
    const { callback, cookie } = await f.signIn(admin, MICROSOFT);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).not.toMatch(/error/);

    expect(await me(cookie)).toMatchObject({
      kind: "person",
      email: admin.email,
      roles: ["viewer"],
      sign_in_method: MICROSOFT,
      via: "browser",
      powerbi_connection: "not_connected",
    });
    const id = String(await userId(admin.email));
    const [identity] = await f.deps.db
      .select()
      .from(personIdentity)
      .where(eq(personIdentity.user_id, id));
    expect(identity?.microsoft_object_id).toBe(admin.object_id);
    // Sign-in keeps no provider token.
    const [stored] = await f.deps.db
      .select()
      .from(account)
      .where(eq(account.userId, id));
    expect([
      stored?.accessToken,
      stored?.refreshToken,
      stored?.idToken,
    ]).toEqual([null, null, null]);
  });

  it("refuses at the callback, before an account exists, a person no assignment reaches when the default role is none", async () => {
    await f.settings.set("access.default_role", "none");
    try {
      const outsider = f.person("outsider");
      const target = refusal((await f.signIn(outsider, MICROSOFT)).callback);
      expect(`${target.origin}${target.pathname}`).toBe(
        `${f.deps.config.public_base_url.origin}/sign-in`,
      );
      expect(target.searchParams.get("error")).toBe("not_assigned");
      expect(target.searchParams.get("error_description")).toBe(NOT_ASSIGNED);
      expect(await userId(outsider.email)).toBeUndefined();
    } finally {
      await f.settings.set("access.default_role", "viewer");
    }
  });

  it("gives the roles assigned to an Entra group the ID token names, and stores the groups", async () => {
    const leader = f.person("leader");
    await assignRole(
      f.deps.db,
      {
        role: "curator",
        subject_kind: "group",
        provider: MICROSOFT,
        subject: f.group("Directors"),
      },
      principals.admin,
    );
    const { cookie } = await f.signIn(leader, MICROSOFT);
    expect((await me(cookie)).roles).toEqual(["curator"]);
    const [identity] = await f.deps.db
      .select()
      .from(personIdentity)
      .where(eq(personIdentity.user_id, String(await userId(leader.email))));
    expect(identity?.group_object_ids.toSorted()).toEqual(
      leader.group_ids.toSorted(),
    );
  });

  it("resolves the principal's roles again on the next request after an assignment changes", async () => {
    const viewer = f.person("viewer");
    const { cookie } = await f.signIn(viewer, MICROSOFT);
    expect((await me(cookie)).roles).toEqual(["viewer"]);
    const granted = await assignRole(
      f.deps.db,
      { role: "admin", subject_kind: "person", subject: viewer.email },
      principals.admin,
    );
    expect((await me(cookie)).roles).toEqual(["admin"]);
    await revokeRole(f.deps.db, granted.id);
    expect((await me(cookie)).roles).toEqual(["viewer"]);
  });
});

describe("signing in with a second provider, through the mock's /oidc", () => {
  it("signs in a person a group assignment at that provider reaches", async () => {
    const analyst = f.person("analyst");
    await assignRole(
      f.deps.db,
      {
        role: "curator",
        subject_kind: "group",
        provider: OIDC,
        subject: f.group("Analysts"),
      },
      principals.admin,
    );
    const { callback, cookie } = await f.signIn(analyst, OIDC);
    expect(callback.headers.get("location")).not.toMatch(/error/);
    expect(await me(cookie)).toMatchObject({
      email: analyst.email,
      roles: ["curator"],
      sign_in_method: OIDC,
    });
  });

  it("never counts its token as membership of the Power BI tenant", async () => {
    // The default role reaches tenant members only; the mock's tokens all carry the tenant's tid.
    const salesViewer = f.person("sales-viewer");
    const target = refusal((await f.signIn(salesViewer, OIDC)).callback);
    expect(target.searchParams.get("error")).toBe("not_assigned");
    expect(await userId(salesViewer.email)).toBeUndefined();
  });
});

describe("passkeys", () => {
  it("exist only once sign_in.passkeys is on, and are registered by people already signed in", async () => {
    const options = "/api/auth/passkey/generate-authenticate-options";
    const register = "/api/auth/passkey/generate-register-options";
    expect((await f.request(options)).status).toBe(404);
    const { cookie } = await f.signIn(f.person("app-reader"), MICROSOFT);
    await f.settings.set("sign_in.passkeys", true);
    // Better Auth reads its settings again after 30 seconds.
    f.advance(31_000);
    try {
      expect((await f.request(options)).status).toBe(200);
      expect((await f.request(register)).status).toBe(401);
      expect((await f.request(register, { headers: { cookie } })).status).toBe(
        200,
      );
    } finally {
      await f.settings.set("sign_in.passkeys", false);
      f.advance(31_000);
    }
  });
});
