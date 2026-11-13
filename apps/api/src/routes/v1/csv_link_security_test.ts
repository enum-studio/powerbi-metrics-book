import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cerbosAccess,
  principals,
  TEST_PUBLIC_BASE_URL,
  testConfig,
  testPool,
} from "../../../test/deps.js";
import { id, useMirror } from "../../../test/mirror-fixtures.js";
import { MemorySecrets, MemorySettings } from "../../../test/doubles.js";
import { freshPeer, startOAuth } from "../../../test/sign-in-support.js";
import { createApp } from "../../app.js";
import { createDb } from "../../db/client.js";
import { auditEvent } from "../../db/schema/audit.js";
import { queryResult } from "../../db/schema/queries.js";
import {
  assignRole,
  listAssignments,
  revokeRole,
} from "../../services/auth/roles.js";
import {
  createKey,
  createServiceAccount,
  deleteServiceAccount,
  disableServiceAccount,
  updateServiceAccount,
} from "../../services/auth/service-accounts.js";
import { csvLink } from "../../services/queries/links.js";
import { createResultStore } from "../../services/queries/store.js";

/*
 * The CSV route is public for GET with a signed link, so these tests hold
 * what keeps that safe: the link's reach, who stands behind it, what is
 * recorded, and the limits. They also hold the API-key and Origin refusals of
 * the admin and approval routes, which no role of a service account allows.
 */

useMirror();

const PROXY = "10.99.0.1";
const settings = new MemorySettings({
  "access.metadata_visibility": "everyone",
});
let skew = 0;
/** Where the clock stands still, when it does. */
let held: Date | undefined;
const oauth = startOAuth({
  settings,
  access: cerbosAccess(settings),
  secrets: new MemorySecrets([["result_link_key", "csv-link-security-key"]]),
  config: testConfig("api", { ALLOW_DEV_SIGN_IN: "1", TRUSTED_PROXY: PROXY }),
  clock: () => held ?? new Date(Date.now() + skew),
});
const { deps } = oauth;
const app = createApp(deps);
const admin = { ...deps, principal: principals.admin };

const from = (peer: string) => ({
  incoming: { socket: { remoteAddress: peer } },
});
const get = (
  path: string,
  headers: Record<string, string> = {},
  peer = freshPeer(),
) => app.request(path, { headers }, from(peer));
const pathOf = (url: string) => new URL(url).pathname + new URL(url).search;

type Owner = { kind: "person" | "service_account"; id: string };

async function resultOf(owner: Owner): Promise<string> {
  const anchor = await createResultStore(deps).save(
    {
      query_id: randomUUID(),
      owner,
      dataset: { id: id.sales, name: "Sales" },
      columns: [{ name: "Amount", type: "number" }],
      truncation_note: null,
      preview_rows: 5,
    },
    [[1], [2]],
  );
  return anchor.result_id;
}

/** The link with its signature's first character changed, so it is a bad signature of the right length every time. */
const tamper = (link: string) =>
  link.replace(
    /signature=(.)/,
    (_, first: string) => `signature=${first === "A" ? "B" : "A"}`,
  );

const linkTo = async (id: string, owner: Owner) =>
  pathOf(
    (await csvLink(deps, { id, owner_kind: owner.kind, owner_id: owner.id }))
      .csv_url,
  );

async function audits(result: string) {
  return createDb(testPool("api_rw"))
    .select()
    .from(auditEvent)
    .where(eq(auditEvent.resource_id, result))
    .orderBy(asc(auditEvent.id));
}

/** A person with a role, signed in: their owner key and cookie. */
async function person(role?: "curator") {
  const signedIn = await oauth.person();
  if (role !== undefined)
    await assignRole(
      deps.db,
      { role, subject_kind: "person", subject: signedIn.email },
      principals.admin,
    );
  return {
    owner: { kind: "person", id: signedIn.id } as Owner,
    email: signedIn.email,
    cookie: signedIn.cookie,
  };
}

async function account(roles = ["viewer"], source_cidrs: string[] = []) {
  const name = `csv_${randomUUID().slice(0, 8).replaceAll("-", "")}`;
  await createServiceAccount(admin, {
    name,
    owner_email: "o@example.test",
    roles,
    source_cidrs,
  });
  return { name, owner: { kind: "service_account", id: name } as Owner };
}

describe("what a signed link reaches", () => {
  it("opens GET on the CSV path and nothing else, whatever its query string is carried on", async () => {
    const { owner } = await person();
    const id = await resultOf(owner);
    const link = await linkTo(id, owner);
    const query = link.slice(link.indexOf("?"));
    expect((await get(link)).status).toBe(200);
    for (const other of [
      `/api/v1/results/${id}`,
      `/api/v1/results/${id}/csv-link`,
      "/api/v1/queries",
      "/api/v1/threads",
    ])
      expect((await get(other + query)).status, other).toBe(401);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const answer = await app.request(
        link,
        { method, headers: { origin: TEST_PUBLIC_BASE_URL } },
        from(freshPeer()),
      );
      expect(answer.status, method).toBe(401);
    }
  });

  it("refuses a link for one result on another, even of the same owner", async () => {
    const { owner } = await person();
    const [a, b] = [await resultOf(owner), await resultOf(owner)];
    const link = await linkTo(a, owner);
    expect((await get(link.replace(a, b))).status).toBe(403);
  });

  it("answers a token the api did not take with 401 and its challenge when no link is sent", async () => {
    const { owner } = await person();
    const id = await resultOf(owner);
    const forged = { authorization: "Bearer not-a-token" };
    const refused = await get(`/api/v1/results/${id}/csv`, forged);
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toContain(
      'error="invalid_token"',
    );
    // The link is the credential, so it still opens beside a refused token.
    expect((await get(await linkTo(id, owner), forged)).status).toBe(200);
  });
});

describe("the limits", () => {
  // The limits count in fixed windows on the clock minute, and a burst that
  // crossed one would split its count and never reach a 429.
  beforeEach(() => {
    held = deps.clock();
  });
  afterEach(() => {
    held = undefined;
  });

  const bad = async (
    n: number,
    headers: () => Record<string, string>,
    peer: string,
  ) => {
    const { owner } = await person();
    const link = await linkTo(await resultOf(owner), owner);
    const tampered = tamper(link);
    const seen = new Set<number>();
    for (let i = 0; i < n; i += 1)
      seen.add((await get(tampered, headers(), peer)).status);
    return seen;
  };

  it("counts a link per address, and takes X-Forwarded-For only from TRUSTED_PROXY", async () => {
    let n = 0;
    const spoofed = () => ({
      "x-forwarded-for": `203.0.113.${String(n++ % 250)}`,
    });
    expect(await bad(65, spoofed, freshPeer())).toEqual(new Set([403, 429]));
    // From the proxy, the header names the client: another client is not limited.
    const asked = (address: string) => ({ "x-forwarded-for": address });
    expect(await bad(65, () => asked("198.51.100.7"), PROXY)).toEqual(
      new Set([403, 429]),
    );
    expect(await bad(1, () => asked("198.51.100.8"), PROXY)).toEqual(
      new Set([403]),
    );
  });

  it("counts an IPv4-mapped forwarded address, in either spelling, as its IPv4 client", async () => {
    const asked = (address: string) => ({ "x-forwarded-for": address });
    const dotted = await bad(40, () => asked("::ffff:198.51.100.17"), PROXY);
    const hex = await bad(40, () => asked("::FFFF:c633:6411"), PROXY);
    // 80 tries between them: the two spellings are one client.
    expect(new Set([...dotted, ...hex])).toEqual(new Set([403, 429]));
    expect(await bad(1, () => asked("::ffff:198.51.100.18"), PROXY)).toEqual(
      new Set([403]),
    );
    expect(await bad(1, () => asked("198.51.100.18"), PROXY)).toEqual(
      new Set([403]),
    );
  });

  it("counts one budget per owner for credential and link downloads, and audits no refused burst", async () => {
    const { owner, cookie } = await person();
    const id = await resultOf(owner);
    const link = await linkTo(id, owner);
    const path = `/api/v1/results/${id}/csv`;
    const statuses = new Set<number>();
    for (let i = 0; i < 31; i += 1)
      statuses.add((await get(path, { cookie })).status);
    expect(statuses).toEqual(new Set([200, 429]));
    expect((await get(link)).status).toBe(429);
    // Only the 30 downloads that were served wrote a row.
    expect(await audits(id)).toHaveLength(30);
  });

  it("counts an IPv6 client by its /64", async () => {
    const [a, b] = ["2001:db8:1:2::1", "2001:db8:1:2:ffff::9"];
    const { owner } = await person();
    const tampered = tamper(await linkTo(await resultOf(owner), owner));
    const seen = new Set<number>();
    for (let i = 0; i < 65; i += 1)
      seen.add((await get(tampered, {}, i % 2 === 0 ? a : b)).status);
    expect(seen).toEqual(new Set([403, 429]));
    expect((await get(tampered, {}, "2001:db8:1:3::1")).status).toBe(403);
  });

  it("keeps each count to the last second of its minute, and starts over at the next", async () => {
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    const standAt = (seconds: number) => {
      held = new Date(minute + seconds * 1000);
    };
    standAt(0);
    const { owner, cookie } = await person();
    const id = await resultOf(owner);
    const tampered = tamper(await linkTo(id, owner));
    const path = `/api/v1/results/${id}/csv`;
    const peer = freshPeer();
    for (let i = 0; i < 60; i += 1)
      expect((await get(tampered, {}, peer)).status).toBe(403);
    for (let i = 0; i < 30; i += 1)
      expect((await get(path, { cookie })).status).toBe(200);
    standAt(59);
    expect((await get(tampered, {}, peer)).status).toBe(429);
    expect((await get(path, { cookie })).status).toBe(429);
    standAt(60);
    expect((await get(tampered, {}, peer)).status).toBe(403);
    expect((await get(path, { cookie })).status).toBe(200);
  });
});

describe("who stands behind a link", () => {
  it("refuses a person no role reaches any more", async () => {
    const { owner, email } = await person();
    const id = await resultOf(owner);
    const link = await linkTo(id, owner);
    expect((await get(link)).status).toBe(200);
    for (const assignment of await listAssignments(deps.db))
      if (assignment.subject === email)
        await revokeRole(deps.db, assignment.id);
    const answered = await get(link);
    expect(answered.status).toBe(403);
    // The same refusal a bad signature gets, word for word.
    const bad = await get(tamper(link));
    expect([answered.status, await answered.json()]).toEqual([
      bad.status,
      await bad.json(),
    ]);
    const [, refused] = await audits(id);
    expect([refused?.decision, refused?.reason, refused?.detail.why]).toEqual([
      "deny",
      "refused",
      "no_role",
    ]);
  });

  it("refuses a service account that is disabled, deleted or off its addresses, and serves it where allowed", async () => {
    const inside = freshPeer();
    const { name, owner } = await account(["viewer"], ["198.18.0.0/15"]);
    const id = await resultOf(owner);
    const link = await linkTo(id, owner);
    expect((await get(link, {}, inside)).status).toBe(200);
    expect((await get(link, {}, "192.0.2.9")).status).toBe(403);
    await updateServiceAccount(admin, name, { source_cidrs: [] });
    expect((await get(link, {}, "192.0.2.9")).status).toBe(200);
    await disableServiceAccount(admin, name);
    expect((await get(link)).status).toBe(403);
    const gone = await account();
    const goneLink = await linkTo(await resultOf(gone.owner), gone.owner);
    expect((await get(goneLink)).status).toBe(200);
    await deleteServiceAccount(admin, gone.name);
    // Its results went with it, so the link names nothing and is refused as an invalid one.
    expect((await get(goneLink)).status).toBe(403);
  });

  it("keeps no result for a service account that is gone when its query is saved", async () => {
    const { name, owner } = await account();
    await deleteServiceAccount(admin, name);
    await expect(resultOf(owner)).rejects.toMatchObject({ kind: "not_found" });
    const left = await createDb(testPool("api_rw"))
      .select({ id: queryResult.id })
      .from(queryResult)
      .where(eq(queryResult.owner_id, name));
    expect(left).toEqual([]);
  });

  it("leaves a new account with a reused name none of the old one's results", async () => {
    const { name, owner } = await account();
    const id = await resultOf(owner);
    const link = await linkTo(id, owner);
    await deleteServiceAccount(admin, name);
    await createServiceAccount(admin, {
      name,
      owner_email: "o@example.test",
      roles: ["viewer"],
    });
    // The result went with its owner, so the link names nothing, and no row is left to inherit.
    expect((await get(link)).status).toBe(403);
    const left = await createDb(testPool("api_rw"))
      .select({ id: queryResult.id })
      .from(queryResult)
      .where(eq(queryResult.owner_id, name));
    expect(left).toEqual([]);
  });
});

describe("what is recorded", () => {
  it("tells a link download from a credential's, with the address, and records each refusal", async () => {
    const { owner, cookie } = await person();
    const stranger = await person();
    const id = await resultOf(owner);
    const link = await linkTo(id, owner);
    const peer = freshPeer();
    expect((await get(link, {}, peer)).status).toBe(200);
    expect((await get(`/api/v1/results/${id}/csv`, { cookie })).status).toBe(
      200,
    );
    // The link's holder with another person's credential, and that person with no link.
    expect((await get(link, { cookie: stranger.cookie })).status).toBe(404);
    expect(
      (await get(`/api/v1/results/${id}/csv`, { cookie: stranger.cookie }))
        .status,
    ).toBe(404);
    // A bad signature with no credential has no principal to record.
    const before = (await audits(id)).length;
    expect((await get(tamper(link))).status).toBe(403);
    const rows = await audits(id);
    expect(rows).toHaveLength(before);
    expect(
      rows.map((r) => [r.decision, r.reason, r.principal_id, r.detail.by]),
    ).toEqual([
      ["allow", null, owner.id, "csv_link"],
      ["allow", null, owner.id, "credential"],
      ["deny", "not_found", stranger.owner.id, "csv_link"],
      ["deny", "not_found", stranger.owner.id, "credential"],
    ]);
    // Someone else's link names its owner, so the row says whose it was.
    expect(rows[2]?.detail.link_owner).toEqual(owner);
    expect(rows[0]?.detail.address).toBe(peer);
    expect(rows[1]?.detail).not.toHaveProperty("address");
  });

  it("records a result that expired under a link still valid", async () => {
    const { name, owner } = await account();
    const id = await resultOf(owner);
    const day = 24 * 60 * 60_000;
    skew = day - 60_000;
    try {
      const link = await linkTo(id, owner);
      skew = day + 60_000;
      expect((await get(link)).status).toBe(404);
    } finally {
      skew = 0;
    }
    const [row] = await audits(id);
    expect([row?.decision, row?.reason, row?.principal_id]).toEqual([
      "deny",
      "not_found",
      name,
    ]);
  });
});

describe("the admin and approval routes", () => {
  it("refuse a service account's API key, and a browser from another origin", async () => {
    const curator = await person("curator");
    const metric = `approvals_${randomUUID().slice(0, 8)}`;
    const key = (await account(["curator"])).name;
    const { key: secret } = await createKey(admin, key, { expires_in_days: 1 });
    const token = {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    };
    const created = await oauth.request("/api/v1/metrics", {
      method: "POST",
      headers: {
        cookie: curator.cookie,
        origin: TEST_PUBLIC_BASE_URL,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: metric, label: "Approvals" }),
    });
    expect(created.status).toBe(201);
    for (const [method, path] of [
      ["PUT", "/conventions"],
      ["GET", "/conventions/versions"],
      ["POST", "/conventions/diff"],
      ["POST", `/metrics/${metric}/approve`],
    ] as const)
      expect(
        (
          await oauth.request(`/api/v1${path}`, {
            method,
            headers: token,
            ...(method === "GET" ? {} : { body: "{}" }),
          })
        ).status,
        `${method} ${path}`,
      ).toBe(403);
    const elsewhere = await oauth.request(`/api/v1/metrics/${metric}/approve`, {
      method: "POST",
      headers: { cookie: curator.cookie, origin: "https://evil.example" },
    });
    expect(elsewhere.status).toBe(403);
  });
});
