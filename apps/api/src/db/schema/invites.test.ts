import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BASE_DATABASE,
  dropDatabase,
  makeDatabase,
  withAdmin,
} from "../../../test/database.js";
import { closeTestPools, principals, testPool } from "../../../test/deps.js";
import {
  joined,
  startSetup,
  type SetupFixture,
} from "../../../test/setup-support.js";
import { cookies } from "../../../test/sign-in-support.js";
import { createSettingsStore } from "../../services/settings/store.js";
import { migrateDatabase } from "../migrate.js";
import * as schema from "./index.js";

/*
 * The migrations that gave invites an id, a delivery and an end of each kind,
 * and src/db/sql/upgrade_invites.sql that cleans up the invites made before
 * them, run on a database a deployment had before them: its invites and its
 * setting of who gets in by default. 0001 is the last migration such a
 * database had. Its invites are unused: one the release before 0003 ended
 * through used_at was turned into an end by the release with 0003, and a
 * start with 0004 refuses while such an end is not recorded.
 */

const FOLDER = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const LAST_BEFORE = "0001_sour_taskmaster";
const DIGEST = (n: number) => String(n).padStart(64, "0");

const made: string[] = [];
afterAll(async () => {
  await closeTestPools();
  await withAdmin(async (admin) => {
    for (const name of made) await dropDatabase(admin, name);
  });
});

/** A database at the migrations up to `last`, as a deployment had it. */
async function databaseBefore(last_tag = LAST_BEFORE): Promise<string> {
  const { name, url } = await makeDatabase(
    `template ${pg.escapeIdentifier(BASE_DATABASE)} strategy file_copy`,
  );
  made.push(name);
  const copy = await mkdtemp(join(tmpdir(), "pbmb-invite-migration-"));
  try {
    await cp(FOLDER, copy, { recursive: true });
    const path = join(copy, "meta/_journal.json");
    const journal = JSON.parse(await readFile(path, "utf8")) as {
      entries: { tag: string }[];
    };
    const last = journal.entries.findIndex((e) => e.tag === last_tag);
    journal.entries = journal.entries.slice(0, last + 1);
    await writeFile(path, JSON.stringify(journal));
    await onDatabase(url, async (client) => {
      await migrate(drizzle({ client }), { migrationsFolder: copy });
      // As tenant.sql made it then; every start since before 0001 ran it.
      await client.query(
        `create function deployment_has_admin() returns boolean language sql stable
           as $$ select exists (select from role_assignment where role = 'admin' and subject_kind = 'person') $$`,
      );
    });
  } finally {
    await rm(copy, { recursive: true });
  }
  return url;
}

async function onDatabase<T>(
  url: string,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

const INVITES = `select email, delivery, last_sent_at = created_at as sent_when_made,
                          id is not null as has_id,
                          accepted_at, accepted_user_id, revoked_at
                     from invite order by email, created_at`;
const ASSIGNED = `select subject, role, granted_by from role_assignment order by subject`;
const REVOKES = `select principal_kind, principal_id, via, action, resource_kind, detail
                   from audit_event where principal_id = 'upgrade_invites.sql'
                    and action = 'admin.role.revoke' order by detail->>'subject'`;
const ENDS = `select principal_kind, via, action, resource_kind, resource_id, detail
                from audit_event where principal_id = 'upgrade_invites.sql'
                 and action <> 'admin.role.revoke' order by resource_id, action`;
const READS = [INVITES, ASSIGNED, REVOKES, ENDS];
async function read(client: pg.Client) {
  const rows: Record<string, unknown>[][] = [];
  for (const q of READS)
    rows.push((await client.query<Record<string, unknown>>(q)).rows);
  return rows;
}
/** Unused 0001 invites by admin, each as email name, role, made and expires. */
function insertLegacy(
  client: pg.Client,
  rows: [string, string, string, string][],
) {
  return client.query(
    `insert into invite (token_sha256, email, role, expires_at, invited_by, created_at)
     select digest, name || '@example.com', role, expires, 'admin', made
       from unnest($1::text[], $2::text[], $3::text[], $4::timestamptz[], $5::timestamptz[])
         as row (digest, name, role, made, expires)`,
    [
      rows.map((_, i) => DIGEST(i + 1)),
      rows.map(([name]) => name),
      rows.map(([, role]) => role),
      rows.map(([, , made]) => made),
      rows.map(([, , , expires]) => expires),
    ],
  );
}
/** Person assignments, each as role, email name, granted by and granted at. */
function insertAssignments(
  client: pg.Client,
  rows: [string, string, string, string][],
) {
  return client.query(
    `insert into role_assignment (role, subject_kind, subject, granted_by, granted_at)
     select role, 'person', name || '@example.com', granted_by, granted_at
       from unnest($1::text[], $2::text[], $3::text[], $4::timestamptz[])
         as row (role, name, granted_by, granted_at)`,
    [
      rows.map(([role]) => role),
      rows.map(([, name]) => name),
      rows.map(([, , by]) => by),
      rows.map(([, , , at]) => at),
    ],
  );
}
const SENT = "2026-11-01 00:00:00.03";
const ended = (
  email: string,
  ends: {
    accepted_at?: Date;
    accepted_user_id?: string;
    revoked_at?: unknown;
  } = {},
) => ({
  email: `${email}@example.com`,
  delivery: "email",
  sent_when_made: true,
  has_id: true,
  accepted_at: null,
  accepted_user_id: null,
  revoked_at: null,
  ...ends,
});
const revoke = (subject: string, role: string) => ({
  principal_kind: "system",
  principal_id: "upgrade_invites.sql",
  via: "migration",
  action: "admin.role.revoke",
  resource_kind: "role_assignment",
  detail: { role, subject: `${subject}@example.com` },
});

/** The audit row of an invite the file ended, as the app records an accept or a revoke. */
const end = (name: string, ended: "accept" | "revoke") => ({
  principal_kind: "system",
  via: "migration",
  action:
    ended === "accept" ? "people.invite_accept" : "admin.people.invite_revoke",
  resource_kind: "person",
  resource_id: `${name}@example.com`,
  detail: { email: `${name}@example.com` },
});

describe("the migration of a deployment's invites", () => {
  it("ends the invites of people already signed in, drops what sending assigned while nobody signed in, and touches each invite once", async () => {
    const url = await databaseBefore();
    await onDatabase(url, async (client) => {
      await client.query(
        `insert into "user" (id, name, email, email_verified, created_at) values
           ('u_microsoft', 'Bo', 'bo@example.com', true, now()),
           ('u_ed', 'Ed', 'ed@example.com', true, '2026-11-02'),
           ('u_fy', 'Fy', 'fy@example.com', true, '2026-11-02')`,
      );
      await client.query(
        `insert into account (id, account_id, provider_id, user_id, updated_at) values
           ('a2', 'object-id', 'microsoft', 'u_microsoft', now()),
           ('a3', 'object-id-ed', 'microsoft', 'u_ed', now())`,
      );
      // Sending assigned the role at once. di's was assigned by the same admin
      // a day later, iv's by another admin, and jo's admin is the only one.
      await insertAssignments(client, [
        ["curator", "bo", "admin", SENT],
        ["viewer", "cy", "admin", SENT],
        ["viewer", "di", "admin", "2026-11-08"],
        ["curator", "ed", "admin", SENT],
        ["viewer", "gu", "admin", SENT],
        ["viewer", "hy", "admin", "2026-11-07 00:00:00.03"],
        ["viewer", "iv", "other_admin", SENT],
        ["admin", "jo", "admin", SENT],
      ]);
      // bo, a user with an assignment and no invite, keeps the assignment.
      await insertLegacy(client, [
        ["cy", "viewer", "2026-11-01", "2026-11-10"],
        ["di", "viewer", "2026-11-07", "2026-11-10"],
        ["ed", "curator", "2026-11-01", "2026-11-04"],
        ["fy", "viewer", "2026-11-01", "2026-11-04"],
        ["gu", "viewer", "2026-11-01", "2026-11-04"],
        ["hy", "viewer", "2026-11-07", "2099-01-01"],
        ["iv", "viewer", "2026-11-01", "2026-11-04"],
        ["jo", "admin", "2026-11-01", "2026-11-04"],
      ]);
    });

    await migrateDatabase(url);

    const after = await onDatabase(url, async (client) => {
      const [invites, assigned, revokes, ends] = await read(client);
      // fy's invite is revoked at the time the file runs.
      const revoked = invites?.find(
        (r) => r.email === "fy@example.com",
      )?.revoked_at;
      expect(revoked).toBeInstanceOf(Date);
      const day = (d: number) => new Date(`2026-11-0${String(d)}T00:00:00Z`);
      expect(invites).toEqual([
        ended("cy"),
        ended("di"),
        ended("ed", { accepted_at: day(2), accepted_user_id: "u_ed" }),
        ended("fy", { revoked_at: revoked }),
        ended("gu"),
        ended("hy"),
        ended("iv"),
        ended("jo"),
      ]);
      expect(assigned).toEqual([
        { subject: "bo@example.com", role: "curator", granted_by: "admin" },
        { subject: "di@example.com", role: "viewer", granted_by: "admin" },
        { subject: "ed@example.com", role: "curator", granted_by: "admin" },
        {
          subject: "iv@example.com",
          role: "viewer",
          granted_by: "other_admin",
        },
        { subject: "jo@example.com", role: "admin", granted_by: "admin" },
      ]);
      expect(revokes).toEqual([
        revoke("cy", "viewer"),
        revoke("gu", "viewer"),
        revoke("hy", "viewer"),
      ]);
      expect(ends).toEqual([end("ed", "accept"), end("fy", "revoke")]);
      // The open invite holds its email through the index 0004 rebuilt
      // without used_at: a second open one is refused.
      await expect(
        client.query(
          `insert into invite (token_sha256, email, role, expires_at, invited_by) values ($1, 'cy@example.com', 'viewer', '2026-11-20', 'admin')`,
          [DIGEST(99)],
        ),
      ).rejects.toThrow(/invite_open_email/);
      // An invite the app made, revoked, beside an assignment by hand in the same second.
      await client.query(
        `insert into invite (token_sha256, email, role, expires_at, invited_by, created_at, last_sent_at, revoked_at)
           values ($1, 'ny@example.com', 'viewer', '2026-11-20', 'admin', $2, $2, '2026-11-02')`,
        [DIGEST(98), SENT],
      );
      await insertAssignments(client, [["viewer", "ny", "admin", SENT]]);
      return read(client);
    });

    await migrateDatabase(url);

    await onDatabase(url, async (client) => {
      expect(await read(client)).toEqual(after);
    });
  });

  it("drops an admin assignment that sending made while another admin is left", async () => {
    const url = await databaseBefore();
    await onDatabase(url, async (client) => {
      await insertAssignments(client, [
        ["admin", "jo", "admin", SENT],
        ["admin", "boss", "admin", "2026-10-01"],
      ]);
      await insertLegacy(client, [["jo", "admin", "2026-11-01", "2026-11-04"]]);
    });
    await migrateDatabase(url);
    await onDatabase(url, async (client) => {
      const [, assigned, revokes] = await read(client);
      expect(assigned).toEqual([
        { subject: "boss@example.com", role: "admin", granted_by: "admin" },
      ]);
      expect(revokes).toEqual([revoke("jo", "admin")]);
    });
  });
});

/** Which of used_at and accepted_at the invite table has. */
async function inviteColumns(url: string): Promise<string[]> {
  return onDatabase(url, async (client) => {
    const { rows } = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_name = 'invite' and column_name in ('used_at', 'accepted_at')
        order by column_name`,
    );
    return rows.map((r) => r.column_name);
  });
}
const SKIPPED = /Deploy 5b3701c4 \(pull request 66\) first/;

describe("the start that drops invite.used_at", () => {
  it("refuses a deployment that skipped 0003's release while an invite's end is only in used_at, and applies nothing", async () => {
    const url = await databaseBefore();
    // A used invite beside a newer open one, which 0001's index allowed.
    await onDatabase(url, (client) =>
      client.query(
        `insert into invite (token_sha256, email, role, expires_at, used_at, invited_by, created_at) values
           ($1, 'cy@example.com', 'viewer', '2026-11-04', '2026-11-02', 'admin', '2026-11-01'),
           ($2, 'cy@example.com', 'viewer', '2026-11-10', null, 'admin', '2026-11-03')`,
        [DIGEST(1), DIGEST(2)],
      ),
    );
    await expect(migrateDatabase(url)).rejects.toThrow(SKIPPED);
    expect(await inviteColumns(url)).toEqual(["used_at"]);
  });

  it("refuses at 0003 an invite whose end is only in used_at", async () => {
    const url = await databaseBefore("0003_sour_puck");
    await onDatabase(url, (client) =>
      client.query(
        `insert into invite (token_sha256, email, role, expires_at, used_at, invited_by)
           values ($1, 'kim@example.com', 'viewer', '2026-11-20', '2026-11-08', 'admin')`,
        [DIGEST(1)],
      ),
    );
    await expect(migrateDatabase(url)).rejects.toThrow(SKIPPED);
    expect(await inviteColumns(url)).toEqual(["accepted_at", "used_at"]);
  });

  it("drops used_at at 0003 once every end it holds is recorded", async () => {
    const url = await databaseBefore("0003_sour_puck");
    await onDatabase(url, (client) =>
      client.query(
        `insert into invite (token_sha256, email, role, expires_at, used_at, revoked_at, invited_by)
           values ($1, 'lu@example.com', 'viewer', '2026-11-20', '2026-11-08', '2026-11-08', 'admin')`,
        [DIGEST(1)],
      ),
    );
    await migrateDatabase(url);
    expect(await inviteColumns(url)).toEqual(["accepted_at"]);
    await onDatabase(url, async (client) => {
      const { rows } = await client.query<{ revoked: boolean }>(
        `select revoked_at is not null as revoked from invite`,
      );
      expect(rows).toEqual([{ revoked: true }]);
    });
  });
});

describe("who gets in by default", () => {
  it("answers viewer on a deployment that stored no choice", async () => {
    const url = await databaseBefore();
    await migrateDatabase(url);
    await onDatabase(url, async (client) => {
      const settings = createSettingsStore(drizzle({ client, schema }), {});
      expect(await settings.get("access.default_role")).toBe("viewer");
    });
  });

  it("keeps a default role a deployment stored", async () => {
    const url = await databaseBefore();
    await onDatabase(url, (client) =>
      client.query(
        `insert into setting (key, value, set_by) values ('access.default_role', '"curator"', 'admin')`,
      ),
    );
    await migrateDatabase(url);
    await onDatabase(url, async (client) => {
      const settings = createSettingsStore(drizzle({ client, schema }), {});
      expect(await settings.get("access.default_role")).toBe("curator");
    });
  });

  describe("on a new deployment, when setup binds its tenant", () => {
    let setup: SetupFixture;
    beforeAll(async () => {
      setup = await startSetup();
    });
    afterAll(() => setup.close());

    const step = "/api/setup/steps/app_registration";
    const EMAIL = "admin@sample.example";

    /** The app registration saved, the first admin signed in and confirmed. */
    async function finishFirstAdmin(setup: SetupFixture): Promise<void> {
      const app = setup.tenant.apps_registrations[0];
      const session = await setup.openSession();
      const registered = await setup.post(step, session, {
        settings: {
          "powerbi.tenant_id": setup.tenant.tenant_id,
          "powerbi.app_client_id": app?.client_id,
        },
        secrets: {
          powerbi_app_client_secret: { value: app?.secret, expires_at: null },
        },
      });
      expect(registered.status).toBe(200);
      const done = await setup.signIn(
        setup.person("admin"),
        joined(session, cookies(registered)),
      );
      const confirmed = await setup.post(step, done.cookie, {
        confirm_email: EMAIL,
      });
      expect(confirmed.status).toBe(200);
    }
    /** As before setup's first admin: nothing bound, assigned, linked or stored. */
    const reset = async () => {
      const migrator = testPool("migrator");
      await migrator.query("delete from deployment_tenant");
      await migrator.query("delete from role_assignment");
      await migrator.query("delete from setup_link");
      await migrator.query("delete from setting");
    };

    it("stores none", async () => {
      await reset();
      await finishFirstAdmin(setup);
      expect(await setup.api.settings.source("access.default_role")).toBe(
        "database",
      );
      expect(await setup.api.settings.get("access.default_role")).toBe("none");
    });

    it("keeps a choice stored before it", async () => {
      await reset();
      await setup.api.settings.set(
        "access.default_role",
        "curator",
        principals.admin,
      );
      await finishFirstAdmin(setup);
      expect(await setup.api.settings.get("access.default_role")).toBe(
        "curator",
      );
    });

    it("stores nothing over a choice the environment sets", async () => {
      await reset();
      // Its api has an identity of its own, so a secret sealed for the other's would not open.
      await testPool("migrator").query("delete from secret_ciphertext");
      await testPool("migrator").query("delete from secret");
      const configured = await startSetup({ ACCESS_DEFAULT_ROLE: "curator" });
      try {
        await finishFirstAdmin(configured);
        expect(
          await configured.api.settings.source("access.default_role"),
        ).toBe("environment");
        const stored = await testPool("migrator").query(
          `select 1 from setting where key = 'access.default_role'`,
        );
        expect(stored.rows).toEqual([]);
      } finally {
        await configured.close();
      }
    });
  });
});
