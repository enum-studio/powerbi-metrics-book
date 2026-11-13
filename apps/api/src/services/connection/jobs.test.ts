import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeTestPools } from "../../../test/deps.js";
import { rolledBack } from "../../../test/sample-mirror.js";
import { newIdentity } from "../../../test/secrets-support.js";
import {
  followConnect,
  type SignInFixture,
  startSignIn,
} from "../../../test/sign-in-support.js";
import { user } from "../../db/schema/auth.js";
import { powerbiConnection } from "../../db/schema/connection.js";
import { jobRequest } from "../../db/schema/jobs.js";
import { personIdentity } from "../../db/schema/mirror.js";
import { personSignIn } from "../../db/schema/roles.js";
import { MICROSOFT, resolveRoles, roleSubject } from "../auth/roles.js";
import { personById } from "../auth/sign-in.js";
import { decryptWith } from "../secrets/age.js";
import {
  type LoadedIdentity,
  readIdentityFile,
} from "../secrets/identities.js";
import { rotateIdentity } from "../secrets/rotate.js";
import {
  queueRekeyAtStart,
  rekeyTokens,
  refreshIdleConnections,
} from "./jobs.js";
import { createVault } from "./vault.js";

/*
 * The api's two token jobs against the mock, with the api's identity in a
 * key file of its own, as rotate-identity finds it in the container.
 */

const DAY = 24 * 60 * 60_000;
let f: SignInFixture;
let dir: string;
let old: LoadedIdentity;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pbmb-connection-"));
  old = await newIdentity();
  await writeFile(join(dir, "api.key"), `${old.identity}\n`, { mode: 0o400 });
  f = await startSignIn({ env: { IDENTITY_DIR: dir }, identity: old });
  // These sign-ins reach their people through the default role.
  await f.settings.set("access.default_role", "viewer");
});

afterAll(async () => {
  await f.close();
  await closeTestPools();
  await rm(dir, { recursive: true, force: true });
});

async function connected(mailbox: string): Promise<string> {
  const who = f.person(mailbox);
  const { cookie } = await f.signIn(who, MICROSOFT);
  expect((await followConnect(f.app, cookie)).answer.status).toBe(302);
  return f.userId(who.email);
}

describe("rekey_tokens", () => {
  it("is refused by the api not yet restarted, then run by the restarted one, which ends a row no key opens and removes the old key", async () => {
    const id = await connected("admin");
    await rolledBack("api_rw", async (db) => {
      const rotated = await rotateIdentity({ ...f.deps, db, identity: old });
      const connection = async () => {
        const [row] = await db
          .select()
          .from(powerbiConnection)
          .where(eq(powerbiConnection.user_id, id));
        return {
          recipient: row?.recipient,
          ciphertexts: [
            row?.access_token_ciphertext ?? new Uint8Array(),
            row?.refresh_token_ciphertext ?? new Uint8Array(),
          ],
        };
      };

      // f.deps.vault still holds the old identity, as the api does until it restarts.
      await expect(rekeyTokens({ ...f.deps, db })).rejects.toThrow(
        "Restart the api, then run rekey_tokens",
      );
      expect(await readdir(dir)).toHaveLength(2);
      expect((await connection()).recipient).toBe(old.recipient);

      const restarted = createVault(f.deps.config, {
        identity: await readIdentityFile(join(dir, "api.key")),
        recipient: rotated.recipient,
      });
      for (const ciphertext of (await connection()).ciphertexts)
        await expect(restarted.open(ciphertext)).resolves.toEqual(
          expect.any(String),
        );

      // A row sealed for the old key that no key opens.
      const corrupt = `corrupt-${randomUUID()}`;
      await db.insert(user).values({
        id: corrupt,
        name: "corrupt",
        email: `${corrupt}@sample.example`,
      });
      await db.insert(powerbiConnection).values({
        user_id: corrupt,
        microsoft_object_id: randomUUID(),
        access_token_ciphertext: randomBytes(64),
        access_token_expires_at: new Date(),
        refresh_token_ciphertext: randomBytes(64),
        recipient: old.recipient,
        status: "connected",
        connected_at: new Date(),
      });

      await rekeyTokens({ ...f.deps, db, vault: restarted });
      const [ended] = await db
        .select()
        .from(powerbiConnection)
        .where(eq(powerbiConnection.user_id, corrupt));
      expect(ended).toMatchObject({
        status: "needs_reconnect",
        access_token_ciphertext: null,
        recipient: null,
      });
      const after = await connection();
      expect(after.recipient).toBe(rotated.recipient);
      for (const ciphertext of after.ciphertexts) {
        await expect(restarted.open(ciphertext)).resolves.toEqual(
          expect.any(String),
        );
        await expect(decryptWith(old.identity, ciphertext)).rejects.toThrow();
      }
      expect(await readdir(dir)).toEqual(["api.key"]);
    });
  });
});

describe("queueRekeyAtStart", () => {
  it("queues rekey_tokens when a retired key is on disk, and nothing when none is", () =>
    rolledBack("api_rw", async (db) => {
      const keys = await mkdtemp(join(tmpdir(), "pbmb-start-"));
      try {
        const deps = {
          ...f.deps,
          config: { ...f.deps.config, identity_dir: keys },
          db,
        };
        const key = async (name: string) =>
          writeFile(join(keys, name), `${(await newIdentity()).identity}\n`, {
            mode: 0o400,
          });
        const queued = async () =>
          (
            await db
              .select()
              .from(jobRequest)
              .where(
                and(
                  eq(jobRequest.job, "rekey_tokens"),
                  eq(jobRequest.status, "queued"),
                ),
              )
          ).length;
        const before = await queued();
        await key("api.key");
        await queueRekeyAtStart(deps);
        expect(await queued()).toBe(before);
        await key("api.key.retired-2026-10-25T00-00-00-000Z");
        await queueRekeyAtStart(deps);
        expect(await queued()).toBe(before + 1);
      } finally {
        await rm(keys, { recursive: true, force: true });
      }
    }));
});

describe("refresh_idle_connections", () => {
  /** The scope of each refresh the job sent the mock: Graph's or Power BI's. */
  const refreshed: ("graph" | "powerbi")[] = [];
  const job = () =>
    refreshIdleConnections({
      ...f.deps,
      fetcher: {
        ...f.deps.fetcher,
        fetchFixed: (url, init) => {
          const form = init?.body;
          if (
            form instanceof URLSearchParams &&
            form.get("grant_type") === "refresh_token"
          )
            refreshed.push(
              form.get("scope")?.includes("graph.microsoft.com") === true
                ? "graph"
                : "powerbi",
            );
          return f.deps.fetcher.fetchFixed(url, init);
        },
      },
    });

  /** Unused for 31 days: the connection, its last groups read and its last sign-in. */
  async function idleFor31Days(userIds: string[]): Promise<void> {
    const longAgo = new Date(Date.now() - 31 * DAY);
    await f.deps.db
      .update(powerbiConnection)
      .set({ connected_at: longAgo, refreshed_at: longAgo })
      .where(inArray(powerbiConnection.user_id, userIds));
    await f.deps.db
      .update(personIdentity)
      .set({ groups_read_at: longAgo })
      .where(inArray(personIdentity.user_id, userIds));
    await f.deps.db
      .update(personSignIn)
      .set({ signed_in_at: longAgo })
      .where(inArray(personSignIn.user_id, userIds));
  }

  /** No row of this test stays idle for a later one, or a later run whose mock this is not. */
  async function noLongerIdle(userIds: string[]): Promise<void> {
    await f.deps.db
      .update(powerbiConnection)
      .set({ refreshed_at: new Date() })
      .where(inArray(powerbiConnection.user_id, userIds));
  }

  async function standing(userId: string) {
    const [row] = await f.deps.db
      .select({ status: powerbiConnection.status })
      .from(powerbiConnection)
      .where(eq(powerbiConnection.user_id, userId));
    const subject = await roleSubject(
      f.deps.db,
      await personById(f.deps.db, userId),
      new Date(),
    );
    return {
      status: row?.status,
      member: subject.tenant_member,
      roles: await resolveRoles(f.deps, subject),
    };
  }

  it("returns at once while powerbi.keep_connections_alive_days is not set", async () => {
    const select = vi.spyOn(f.deps.db, "select");
    try {
      await refreshIdleConnections(f.deps);
      expect(select).not.toHaveBeenCalled();
    } finally {
      select.mockRestore();
    }
  });

  it("keeps a default-role person idle 30 days connected and a member", async () => {
    const id = await connected("leader");
    await idleFor31Days([id]);
    expect(await standing(id)).toEqual({
      status: "connected",
      member: false,
      roles: [],
    });
    await f.settings.set("powerbi.keep_connections_alive_days", 30);
    refreshed.length = 0;
    await job();
    expect(refreshed).toEqual(["graph", "powerbi"]);
    expect(await standing(id)).toEqual({
      status: "connected",
      member: true,
      roles: ["viewer"],
    });
    await noLongerIdle([id]);
  });

  it("ends the connection and the membership of an account Microsoft revoked", async () => {
    const id = await connected("viewer");
    await idleFor31Days([id]);
    f.person("viewer").revoked = true;
    await f.settings.set("powerbi.keep_connections_alive_days", 30);
    await job();
    expect(await standing(id)).toEqual({
      status: "needs_reconnect",
      member: false,
      roles: [],
    });
    const [identity] = await f.deps.db
      .select()
      .from(personIdentity)
      .where(eq(personIdentity.user_id, id));
    expect(identity?.groups_read_at).toBeNull();
  });

  it("reads the groups of a person no role reaches, and refreshes no Power BI token for them", async () => {
    const id = await connected("sales-viewer");
    await idleFor31Days([id]);
    await f.settings.set("powerbi.keep_connections_alive_days", 30);
    await f.settings.set("access.default_role", "none");
    refreshed.length = 0;
    try {
      await job();
    } finally {
      await f.settings.set("access.default_role", "viewer");
    }
    expect(refreshed).toEqual(["graph"]);
    expect(await standing(id)).toMatchObject({
      status: "connected",
      member: true,
    });
    await noLongerIdle([id]);
  });

  it("goes on past a row that fails", async () => {
    const idle = [await connected("analyst"), await connected("app-reader")];
    await idleFor31Days(idle);
    await f.settings.set("powerbi.keep_connections_alive_days", 30);
    f.failNext(`/${f.tenant.tenant_id}/oauth2/v2.0/token`, 503);
    refreshed.length = 0;
    await expect(job()).rejects.toThrow(
      /idle Power BI connections were not refreshed/,
    );
    // The first row's Graph refresh failed; the second's Graph and Power BI went through.
    expect(refreshed).toEqual(["graph", "graph", "powerbi"]);
    await noLongerIdle(idle);
  });
});
