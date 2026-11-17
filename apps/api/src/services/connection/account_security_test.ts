import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeTestPools, principals, testPool } from "../../../test/deps.js";
import {
  OIDC,
  followConnect,
  startSignIn,
  type SignInFixture,
} from "../../../test/sign-in-support.js";
import { createDb } from "../../db/client.js";
import { auditEvent } from "../../db/schema/audit.js";
import { powerbiConnection } from "../../db/schema/connection.js";
import { personIdentity, powerbiAccess } from "../../db/schema/mirror.js";
import { personPrincipal } from "../auth/principal.js";
import {
  assignRole,
  MICROSOFT,
  roleSubject,
  readIdentity,
  SIGN_IN_FRESH_MS,
} from "../auth/roles.js";
import { readGroups, refreshStaleGroups } from "./groups.js";
import { refreshIdleConnections } from "./jobs.js";
import { endConnection } from "./store.js";
import { personPowerBiGrant } from "./tokens.js";

let f: SignInFixture;
beforeEach(async () => {
  f = await startSignIn();
  // These sign-ins reach their people through the default role.
  await f.settings.set("access.default_role", "viewer");
});
afterEach(async () => {
  await f.settings.set("powerbi.connection_requires_matching_email", false);
  await f.close();
  await closeTestPools();
});

async function connect(provider: string) {
  const who = f.person("analyst");
  if (provider === OIDC) who.group_ids = [];
  await assignRole(
    f.deps.db,
    { role: "viewer", subject_kind: "person", subject: who.email },
    principals.admin,
  );
  const { cookie } = await f.signIn(who, provider);
  const id = await f.userId(who.email);
  const shared = f.person("leader");
  const ownIdentity = await readIdentity(f.deps.db, id);
  f.actAs(shared);
  expect((await followConnect(f.app, cookie)).answer.status).toBe(302);
  return { who, shared, id, cookie, ownIdentity };
}

async function connectionOf(id: string) {
  const [row] = await f.deps.db
    .select()
    .from(powerbiConnection)
    .where(eq(powerbiConnection.user_id, id));
  return row;
}

const principalFor = (id: string, email: string) =>
  personPrincipal(
    f.deps,
    { id, email, email_verified: true },
    { via: "browser", client_id: null },
  );
const adminGroup = (subject: string) =>
  assignRole(
    f.deps.db,
    { role: "admin", subject_kind: "group", provider: MICROSOFT, subject },
    principals.admin,
  );

it("lets a Microsoft sign-in connect another account without changing its identity", async () => {
  const { who, shared, id, cookie, ownIdentity } = await connect(MICROSOFT);
  const identity = await readIdentity(f.deps.db, id);
  expect(identity?.microsoft_object_id).toBe(who.object_id);
  expect(identity).toMatchObject({
    group_object_ids: ownIdentity?.group_object_ids,
    groups_read_at: null,
  });
  await adminGroup(shared.group_ids[0] ?? "");
  expect((await principalFor(id, who.email)).roles).toEqual(["viewer"]);
  const connection = await connectionOf(id);
  expect(connection).toMatchObject({
    microsoft_object_id: shared.object_id,
    group_object_ids: shared.group_ids,
  });
  expect(connection?.groups_read_at).toBeInstanceOf(Date);
  f.actAs(who);
  f.failNext("/graph", 503);
  expect((await followConnect(f.app, cookie)).answer.status).toBe(502);
  expect(await connectionOf(id)).toMatchObject({
    microsoft_object_id: who.object_id,
    group_object_ids: [],
    groups_read_at: null,
  });
});

it("keeps no groups of an ended connection when the same account connects again", async () => {
  const who = f.person("analyst");
  const { cookie } = await f.signIn(who, MICROSOFT);
  expect((await followConnect(f.app, cookie)).answer.status).toBe(302);
  const id = await f.userId(who.email);
  expect((await connectionOf(id))?.group_object_ids).toEqual(who.group_ids);
  // Ended with its read left standing: only a connection that is connected
  // carries its groups over a reconnect, whatever endConnection clears.
  await f.deps.db
    .update(powerbiConnection)
    .set({
      status: "needs_reconnect",
      access_token_ciphertext: null,
      access_token_expires_at: null,
      refresh_token_ciphertext: null,
      recipient: null,
    })
    .where(eq(powerbiConnection.user_id, id));
  f.failNext("/graph", 503);
  expect((await followConnect(f.app, cookie)).answer.status).toBe(502);
  expect(await connectionOf(id)).toMatchObject({
    status: "connected",
    microsoft_object_id: who.object_id,
    group_object_ids: [],
    groups_read_at: null,
  });
});

it("lets another provider connect a different email without gaining roles or tenant membership", async () => {
  const { shared, id, who } = await connect(OIDC);
  const person = { id, email: who.email, email_verified: true };
  const [group] = shared.group_ids;
  if (group === undefined) throw new Error("the shared account needs a group");
  await assignRole(
    f.deps.db,
    {
      role: "admin",
      subject_kind: "group",
      provider: MICROSOFT,
      subject: group,
    },
    principals.admin,
  );
  const direct = randomUUID();
  const grouped = randomUUID();
  await createDb(testPool("worker_rw"))
    .insert(powerbiAccess)
    .values([
      {
        object_kind: "dataset",
        object_id: direct,
        principal_type: "user",
        principal_object_id: shared.object_id,
        access_right: "Read",
      },
      {
        object_kind: "dataset",
        object_id: grouped,
        principal_type: "group",
        principal_object_id: group,
        access_right: "Read",
      },
    ]);
  expect(
    await f.deps.db
      .select()
      .from(personIdentity)
      .where(eq(personIdentity.user_id, id)),
  ).toEqual([]);
  expect(await roleSubject(f.deps.db, person, f.deps.clock())).toMatchObject({
    tenant_member: false,
    groups: [],
  });
  const principal = () =>
    personPrincipal(f.deps, person, { via: "browser", client_id: null });
  const visibleDatasets: unknown = expect.arrayContaining([direct, grouped]);
  expect(await principal()).toMatchObject({
    roles: ["viewer"],
    attributes: {
      powerbi_dataset_ids: visibleDatasets,
    },
  });
  f.advance(SIGN_IN_FRESH_MS);
  f.failNext("/graph", 503);
  expect((await principal()).attributes.powerbi_dataset_ids).toEqual([]);
  f.advance(5 * 60_000);
  await refreshStaleGroups(f.deps, id);
  expect((await principal()).attributes.powerbi_dataset_ids).toEqual(
    [direct, grouped].sort(),
  );
  await f.deps.db.transaction((tx) =>
    endConnection(tx, id, { status: "disconnected" }),
  );
  expect((await principal()).attributes.powerbi_dataset_ids).toEqual([]);
  const ended = await connectionOf(id);
  expect(ended?.groups_read_at).toBeNull();
});

it("refuses to promote a lax connection into the person's identity when strict matching starts", async () => {
  const { id, cookie, shared, who } = await connect(OIDC);
  await adminGroup(shared.group_ids[0] ?? "");
  await f.settings.set("powerbi.connection_requires_matching_email", true);
  const { answer } = await followConnect(f.app, cookie);
  expect(answer.status).toBe(403);
  expect(((await answer.json()) as { message: string }).message).toMatch(
    /whose email address is yours/,
  );
  expect(await readIdentity(f.deps.db, id)).toBeNull();
  expect((await principalFor(id, who.email)).roles).toEqual(["viewer"]);
});

it.each(["query", "visibility"])(
  "ends a foreign connection for %s when strict matching starts",
  async (use) => {
    const { id, shared, who } = await connect(MICROSOFT);
    const dataset = randomUUID();
    await createDb(testPool("worker_rw")).insert(powerbiAccess).values({
      object_kind: "dataset",
      object_id: dataset,
      principal_type: "user",
      principal_object_id: shared.object_id,
      access_right: "Read",
    });
    const principal = () => principalFor(id, who.email);
    const before = await principal();
    expect(before.attributes.powerbi_dataset_ids).toContain(dataset);
    await f.settings.set("powerbi.connection_requires_matching_email", true);
    const message: unknown = expect.stringMatching(
      /now requires.*own Microsoft account.*Connect Power BI again at https:\/\/metrics\.example\.com\/settings\/connections, then run this again\./,
    );
    if (use === "query")
      await expect(
        personPowerBiGrant({ ...f.deps, principal: before }),
      ).rejects.toMatchObject({
        kind: "needs_connection",
        message,
      });
    expect((await principal()).attributes.powerbi_dataset_ids).toEqual([]);
    expect(await connectionOf(id)).toMatchObject({
      status: "needs_reconnect",
      groups_read_at: null,
      access_token_ciphertext: null,
      refresh_token_ciphertext: null,
    });
  },
);

it("keeps an own account's groups when a foreign connection ends, and ignores a late Graph read", async () => {
  const { id } = await connect(MICROSOFT);
  const before = await readIdentity(f.deps.db, id);
  const fetcher = f.deps.fetcher;
  await readGroups(
    {
      ...f.deps,
      fetcher: {
        ...fetcher,
        fetchFixed: async (url, init) => {
          const answer = await fetcher.fetchFixed(url, init);
          if (String(url).includes("/me/transitiveMemberOf"))
            await f.deps.db.transaction((tx) =>
              endConnection(tx, id, { status: "disconnected" }),
            );
          return answer;
        },
      },
    },
    id,
  );
  expect(await readIdentity(f.deps.db, id)).toEqual(before);
  expect(await connectionOf(id)).toMatchObject({
    status: "disconnected",
    groups_read_at: null,
  });
});

it("lets an account's owner connect under strict rules after another person shared it", async () => {
  const { id, shared } = await connect(MICROSOFT);
  const { cookie } = await f.signIn(shared, MICROSOFT);
  await f.settings.set("powerbi.connection_requires_matching_email", true);
  expect((await followConnect(f.app, cookie)).answer.status).toBe(302);
  const lastError: unknown = expect.stringMatching(
    /now requires.*own Microsoft account/,
  );
  expect(await connectionOf(id)).toMatchObject({
    status: "needs_reconnect",
    groups_read_at: null,
    access_token_ciphertext: null,
    refresh_token_ciphertext: null,
    last_error: lastError,
  });
});

it.each([false, true])(
  "takes no transaction for a matching principal with strict mode %s",
  async (strict) => {
    const { id, shared } = await connect(MICROSOFT);
    const owner = await f.signIn(shared, MICROSOFT);
    expect((await followConnect(f.app, owner.cookie)).answer.status).toBe(302);
    const ownerId = await f.userId(shared.email);
    await f.settings.set("powerbi.connection_requires_matching_email", strict);
    const transaction = vi.spyOn(f.deps.db, "transaction");
    try {
      await principalFor(ownerId, shared.email);
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      transaction.mockRestore();
    }
    expect(await connectionOf(id)).toBeDefined();
  },
);

it.each(["groups", "idle"])(
  "ends a foreign connection before %s can renew its tokens",
  async (use) => {
    const { id } = await connect(MICROSOFT);
    await f.settings.set("powerbi.connection_requires_matching_email", true);
    await f.settings.set("powerbi.keep_connections_alive_days", 1);
    await f.deps.db
      .update(powerbiConnection)
      .set({
        refreshed_at: new Date(f.deps.clock().getTime() - 2 * 24 * 60 * 60_000),
      })
      .where(eq(powerbiConnection.user_id, id));
    const fetch = vi.spyOn(f.deps.fetcher, "fetchFixed");
    try {
      if (use === "groups") await readGroups(f.deps, id);
      else await refreshIdleConnections(f.deps);
      expect(fetch.mock.calls.length).toBe(0);
      expect(await connectionOf(id)).toMatchObject({
        status: "needs_reconnect",
        groups_read_at: null,
      });
    } finally {
      fetch.mockRestore();
    }
  },
);

it("collapses five stale principal refreshes without waiting on the token lock", async () => {
  const { id, who } = await connect(MICROSOFT);
  f.advance(2 * 24 * 60 * 60_000);
  const gate = Promise.withResolvers<undefined>();
  const fetchFixed = f.deps.fetcher.fetchFixed.bind(f.deps.fetcher);
  let tokens = 0;
  let graph = 0;
  f.deps.fetcher.fetchFixed = async (url, init) => {
    if (String(url).endsWith("/token")) {
      tokens += 1;
      await gate.promise;
    }
    if (String(url).includes("/graph/")) graph += 1;
    return fetchFixed(url, init);
  };
  const first = principalFor(id, who.email);
  let finished = 0;
  await vi.waitFor(() => {
    expect(tokens).toBe(1);
  });
  const others = Promise.all(
    Array.from({ length: 4 }, async () => {
      await principalFor(id, who.email);
      finished += 1;
    }),
  );
  try {
    await vi.waitFor(() => {
      expect(finished).toBe(4);
    });
  } finally {
    gate.resolve(undefined);
    await Promise.all([first, others]);
  }
  expect([tokens, graph]).toEqual([1, 1]);
});

it.each([503, 403])(
  "backs off after Graph %s and ends a refused connection",
  async (status) => {
    const { id, who } = await connect(MICROSOFT);
    f.advance(2 * 24 * 60 * 60_000);
    f.failNext("/graph", status);
    await principalFor(id, who.email);
    const fetch = vi.spyOn(f.deps.fetcher, "fetchFixed");
    try {
      await principalFor(id, who.email);
      expect(fetch.mock.calls.length).toBe(0);
      expect(await connectionOf(id)).toMatchObject({
        status: status === 403 ? "needs_reconnect" : "connected",
      });
    } finally {
      fetch.mockRestore();
    }
  },
);

it.each(["connected", "disconnected"] as const)(
  "audits only a connected holder when the owner claims an account from %s",
  async (status) => {
    const { id, shared } = await connect(MICROSOFT);
    if (status === "disconnected")
      await f.deps.db.transaction((tx) => endConnection(tx, id, { status }));
    const { cookie } = await f.signIn(shared, MICROSOFT);
    await f.settings.set("powerbi.connection_requires_matching_email", true);
    expect((await followConnect(f.app, cookie)).answer.status).toBe(302);
    const audit = await createDb(testPool("migrator"))
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.resource_id, id));
    expect(
      audit
        .filter((row) => row.action === "powerbi.disconnect")
        .map((row) => row.reason),
    ).toEqual(
      status === "connected"
        ? ["account claimed by its owner under strict matching"]
        : [],
    );
    expect((await connectionOf(id))?.status).toBe(
      status === "connected" ? "needs_reconnect" : "disconnected",
    );
  },
);
