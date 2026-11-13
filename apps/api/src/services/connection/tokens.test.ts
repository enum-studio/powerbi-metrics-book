import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  closeTestPools,
  principals,
  TEST_PUBLIC_BASE_URL,
} from "../../../test/deps.js";
import {
  followConnect,
  OIDC,
  type SignInFixture,
  startSignIn,
} from "../../../test/sign-in-support.js";
import type { ServiceContext } from "../../context.js";
import { powerbiConnection } from "../../db/schema/connection.js";
import { personIdentity } from "../../db/schema/mirror.js";
import { personPrincipal } from "../auth/principal.js";
import {
  assignRole,
  MICROSOFT,
  resolveRoles,
  revokeRole,
  roleSubject,
} from "../auth/roles.js";
import { readGroups } from "./groups.js";
import { endConnection } from "./store.js";
import { personPowerBiGrant } from "./tokens.js";

/*
 * personPowerBiGrant against the mock: refreshing under the row lock,
 * Microsoft refusing a revoked person, and the groups read again on use.
 */

const PAGE = `${TEST_PUBLIC_BASE_URL}/settings/connections`;
const MINUTE = 60_000;

let f: SignInFixture;
/** Refresh grants the api sent to the mock's token endpoint. */
let refreshes = 0;

beforeAll(async () => {
  f = await startSignIn();
  // These sign-ins reach their people through the default role.
  await f.settings.set("access.default_role", "viewer");
});

afterAll(async () => {
  await f.close();
  await closeTestPools();
});

/** Signs the person in, connects them, and answers their context with a clock `ahead` of now. */
async function connected(mailbox: string, ahead = 0): Promise<ServiceContext> {
  const who = f.person(mailbox);
  const { cookie } = await f.signIn(who, MICROSOFT);
  expect((await followConnect(f.app, cookie)).answer.status).toBe(302);
  const fetcher = f.deps.fetcher;
  return {
    ...f.deps,
    clock: () => new Date(Date.now() + ahead),
    fetcher: {
      ...f.deps.fetcher,
      fetchFixed: (url, init) => {
        const form = init?.body;
        if (
          form instanceof URLSearchParams &&
          form.get("grant_type") === "refresh_token"
        )
          refreshes += 1;
        return fetcher.fetchFixed(url, init);
      },
    },
    principal: { ...principals.viewer, id: await f.userId(who.email) },
  };
}

async function connectionOf(context: ServiceContext) {
  const [row] = await f.deps.db
    .select()
    .from(powerbiConnection)
    .where(eq(powerbiConnection.user_id, context.principal.id));
  return row;
}

afterEach(async () => {
  await f.settings.set("powerbi.connection_requires_matching_email", false);
});

describe("personPowerBiGrant", () => {
  it("tells a person with no connection where to connect", async () => {
    const context = {
      ...f.deps,
      principal: { ...principals.viewer, id: `nobody-${randomUUID()}` },
    };
    await expect(personPowerBiGrant(context)).rejects.toMatchObject({
      kind: "needs_connection",
      message: `Connect Power BI at ${PAGE}`,
    });
  });

  it("spends one refresh token when two queries need a fresh token at once", async () => {
    // The mock's tokens last an hour: 56 minutes on, both are within five minutes of it.
    const context = await connected("leader", 56 * MINUTE);
    const before = refreshes;
    const [first, second] = await Promise.all([
      personPowerBiGrant(context),
      personPowerBiGrant(context),
    ]);
    expect(refreshes - before).toBe(1);
    expect(second.token).toBe(first.token);
    expect(await connectionOf(context)).toMatchObject({
      status: "connected",
      last_used_at: expect.any(Date) as unknown,
    });
  });

  it("refreshes a fresh token only when forced, and once a minute at most", async () => {
    // Two minutes after connecting: the token is fresh, its last refresh is not.
    const context = await connected("admin", 2 * MINUTE);
    const before = refreshes;
    await personPowerBiGrant(context);
    expect(refreshes).toBe(before);
    await personPowerBiGrant(context, { force_refresh: true });
    await personPowerBiGrant(context, { force_refresh: true });
    expect(refreshes - before).toBe(1);
  });

  it("turns a revoked person's connection to needs_reconnect, without its tokens", async () => {
    const context = await connected("viewer", 2 * MINUTE);
    f.person("viewer").revoked = true;
    for (let attempt = 0; attempt < 2; attempt += 1)
      await expect(
        personPowerBiGrant(context, { force_refresh: true }),
      ).rejects.toMatchObject({
        kind: "needs_connection",
        message: `Your Power BI connection expired. Reconnect at ${PAGE}`,
      });
    expect(await connectionOf(context)).toMatchObject({
      status: "needs_reconnect",
      access_token_ciphertext: null,
      refresh_token_ciphertext: null,
      last_error: expect.any(String) as unknown,
    });
  });

  it("takes tenant membership away with the connection: no everyone_in_tenant, no default role", async () => {
    await f.settings.set("powerbi.connection_requires_matching_email", true);
    const outsider = f.person("outsider");
    const own = await assignRole(
      f.deps.db,
      { role: "curator", subject_kind: "person", subject: outsider.email },
      principals.admin,
    );
    const { cookie } = await f.signIn(outsider, OIDC);
    expect((await followConnect(f.app, cookie)).answer.status).toBe(302);
    await revokeRole(f.deps.db, own.id);
    const id = await f.userId(outsider.email);
    const subject = async () =>
      roleSubject(
        f.deps.db,
        { id, email: outsider.email, email_verified: true },
        new Date(),
      );
    expect((await subject()).tenant_member).toBe(true);
    expect(await resolveRoles(f.deps, await subject())).toEqual(["viewer"]);

    outsider.revoked = true;
    const context = {
      ...f.deps,
      clock: () => new Date(Date.now() + 2 * MINUTE),
      principal: { ...principals.viewer, id },
    };
    await expect(
      personPowerBiGrant(context, { force_refresh: true }),
    ).rejects.toMatchObject({ kind: "needs_connection" });
    expect((await subject()).tenant_member).toBe(false);
    expect(await resolveRoles(f.deps, await subject())).toEqual([]);
  });

  it("never undoes a disconnect that lands while Graph answers", async () => {
    const context = await connected("sales-viewer");
    const id = context.principal.id;
    const fetcher = f.deps.fetcher;
    await readGroups(
      {
        ...f.deps,
        fetcher: {
          ...fetcher,
          fetchFixed: async (url, init) => {
            if (String(url).includes("/me/transitiveMemberOf"))
              await f.deps.db.transaction((tx) =>
                endConnection(tx, id, { status: "disconnected" }),
              );
            return fetcher.fetchFixed(url, init);
          },
        },
      },
      id,
    );
    const [identity] = await f.deps.db
      .select()
      .from(personIdentity)
      .where(eq(personIdentity.user_id, id));
    expect(identity?.groups_read_at).toBeNull();
    expect((await connectionOf(context))?.status).toBe("disconnected");
  });

  it("reads the person's groups again on use once a day has passed", async () => {
    const context = await connected("analyst");
    const analyst = f.person("analyst");
    analyst.group_ids.push(f.group("Directors"));
    const stale = new Date(Date.now() - 25 * 60 * MINUTE);
    await f.deps.db
      .update(powerbiConnection)
      .set({ groups_read_at: stale })
      .where(eq(powerbiConnection.user_id, context.principal.id));
    f.advance(5 * MINUTE);
    context.principal = await personPrincipal(
      f.deps,
      { id: context.principal.id, email: analyst.email, email_verified: true },
      { via: "browser", client_id: null },
    );
    await personPowerBiGrant(context);
    const [identity] = await f.deps.db
      .select()
      .from(personIdentity)
      .where(eq(personIdentity.user_id, context.principal.id));
    expect(identity?.group_object_ids).toContain(f.group("Directors"));
    expect(identity?.groups_read_at?.getTime()).toBeGreaterThan(
      stale.getTime(),
    );
  });
});
