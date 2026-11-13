import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { inRollback, ROLES, roleUrl } from "../../test/database.js";
import {
  applyGrants,
  type Declarations,
  declaredGrants,
  declareGrants,
  GRANTED_ROLES,
  type Privilege,
  type TableGrants,
} from "./grants.js";
import "./schema/index.js";

const migrator = new pg.Pool({ connectionString: roleUrl("migrator") });
afterAll(() => migrator.end());

// Hand-written routine grants in db/sql/tenant.sql are declarations too.
const DECLARED_ROUTINE_PRIVILEGES = [
  "deployment_has_admin(): api_rw execute",
  "deployment_has_admin(): worker_rw execute",
];

/**
 * Every privilege the three roles and public hold on schema public, read from
 * the catalog rather than from what grants.ts meant to do: one entry per table
 * privilege ("table: role select"), per column privilege
 * ("table: role update(column)") and per routine privilege
 * ("name(): public execute"), sequences and views included. A grant to public
 * is listed under public, since every role holds it too. Routines that belong
 * to an extension are left out, as applyGrants leaves them.
 */
async function heldPrivileges(client: pg.ClientBase): Promise<string[]> {
  const { rows } = await client.query<{ privilege: string }>(
    `with granted as (
       select class.relname as object, acl.grantee, lower(acl.privilege_type) as privilege
         from pg_class as class
        cross join lateral aclexplode(class.relacl) as acl
        where class.relnamespace = 'public'::regnamespace
       union all
       select class.relname, acl.grantee, lower(acl.privilege_type) || '(' || attribute.attname || ')'
         from pg_attribute as attribute
         join pg_class as class on class.oid = attribute.attrelid
        cross join lateral aclexplode(attribute.attacl) as acl
        where class.relnamespace = 'public'::regnamespace and not attribute.attisdropped
       union all
       -- A routine with no ACL of its own has the default one, which lets public execute it.
       select routine.oid::regprocedure::text, acl.grantee, lower(acl.privilege_type)
         from pg_proc as routine
        cross join lateral aclexplode(coalesce(routine.proacl, acldefault('f', routine.proowner))) as acl
        where routine.pronamespace = 'public'::regnamespace
          and not exists (select from pg_depend as dependency
                           where dependency.classid = 'pg_proc'::regclass
                             and dependency.objid = routine.oid and dependency.deptype = 'e')
     )
     select object || ': ' || grantee || ' ' || privilege as privilege
       from (select object, privilege,
                    case granted.grantee when 0 then 'public' else pg_get_userbyid(granted.grantee) end as grantee
               from granted)
      where grantee = any($1)`,
    [[...GRANTED_ROLES, "public"]],
  );
  return rows.map((row) => row.privilege).sort();
}

/*
 * heldPrivileges and applyGrants read schema public alone, so a table anywhere
 * else would keep whatever a migration granted it. Drizzle's record is the one
 * schema of ours besides public, and a row a role wrote there could make every
 * later migration skip or run again.
 */
describe("the database's schemas", () => {
  it("leave Drizzle's record to its owner", async () => {
    const { rows } = await migrator.query<{ held: string }>(
      `with granted as (
         select namespace.nspname as object, acl.grantee
           from pg_namespace as namespace
          cross join lateral aclexplode(namespace.nspacl) as acl
          where namespace.nspname = 'drizzle'
         union all
         select class.relname, acl.grantee
           from pg_class as class
          cross join lateral aclexplode(class.relacl) as acl
          where class.relnamespace = 'drizzle'::regnamespace
       )
       select object || ': ' || grantee as held
         from (select object,
                      case grantee when 0 then 'public' else pg_get_userbyid(grantee) end as grantee
                 from granted)
        where grantee = any($1)`,
      [[...GRANTED_ROLES, "public"]],
    );
    expect(rows).toEqual([]);
  });

  it("are public and Drizzle's record, and no other", async () => {
    const { rows } = await migrator.query<{ name: string }>(
      `select nspname as name from pg_namespace
        where nspname !~ '^pg_' and nspname <> 'information_schema'
        order by nspname`,
    );
    expect(rows.map((row) => row.name)).toEqual(["drizzle", "public"]);
  });
});

/** The declarations written the way heldPrivileges reads the catalog. */
function declaredPrivileges(declarations: Declarations): string[] {
  const privileges: string[] = [];
  for (const [table, grants] of declarations) {
    for (const role of GRANTED_ROLES) {
      for (const privilege of grants[role]) {
        const [, verb, columns] = /^(\w+)(?:\((.*)\))?$/.exec(privilege) ?? [];
        if (verb === undefined)
          throw new Error(`${table}: cannot read "${privilege}"`);
        const parts =
          columns === undefined
            ? [verb]
            : columns.split(",").map((column) => `${verb}(${column.trim()})`);
        for (const part of parts) privileges.push(`${table}: ${role} ${part}`);
      }
    }
  }
  return privileges.sort();
}

/** Tables and views in schema public that no declaration covers. */
async function undeclaredTables(
  client: pg.ClientBase,
  declarations: Declarations,
): Promise<string[]> {
  const { rows } = await client.query<{ relname: string }>(
    `select class.relname from pg_class as class
       join pg_namespace as namespace on namespace.oid = class.relnamespace
      where namespace.nspname = 'public' and class.relkind in ('r', 'p', 'v', 'm', 'f')
      order by class.relname`,
  );
  return rows
    .map((row) => row.relname)
    .filter((table) => !declarations.has(table));
}

describe("the migrated database", () => {
  it("has a grant declaration for every table", async () => {
    expect(
      await inRollback(migrator, (client) =>
        undeclaredTables(client, declaredGrants()),
      ),
    ).toEqual([]);
  });

  it("gives each role exactly the privileges declared for it", async () => {
    expect(await inRollback(migrator, heldPrivileges)).toEqual(
      [
        ...declaredPrivileges(declaredGrants()),
        ...DECLARED_ROUTINE_PRIVILEGES,
      ].sort(),
    );
  });
});

describe("applyGrants", () => {
  const PROBE: TableGrants = {
    api_rw: ["select", "update(description, custom)"],
    worker_rw: ["select", "insert", "update", "delete"],
    audit_writer: ["insert"],
  };

  it("grants exactly what is declared and revokes what is not, on declared and undeclared tables alike", async () => {
    const held = await inRollback(migrator, async (client) => {
      await client.query(
        "create table grants_probe (id int, description text, custom text, name text)",
      );
      await client.query("create table grants_stray (id serial)");
      await client.query(
        "grant delete, update on grants_probe to api_rw; grant update (name) on grants_probe to api_rw",
      );
      await client.query(
        "grant select on grants_stray to audit_writer; grant usage on sequence grants_stray_id_seq to worker_rw",
      );
      await applyGrants(client, new Map([["grants_probe", PROBE]]));
      return heldPrivileges(client);
    });
    expect(held).toEqual(
      declaredPrivileges(new Map([["grants_probe", PROBE]])),
    );
  });

  it("takes back what public was granted, so no role holds more through it", async () => {
    const [held, auditWriter] = await inRollback(migrator, async (client) => {
      await client.query(
        "create table grants_probe (id serial, description text, custom text, name text)",
      );
      await client.query(
        "create function grants_probe_count() returns bigint language sql as 'select count(*) from grants_probe'",
      );
      await client.query(
        "grant select, insert, update, delete on grants_probe to public; grant update (name) on grants_probe to public; grant usage on sequence grants_probe_id_seq to public",
      );
      await applyGrants(client, new Map([["grants_probe", PROBE]]));
      return Promise.all([
        heldPrivileges(client),
        client.query<{ privileges: string[] }>(
          `select array(
                    select privilege from unnest(array['select', 'insert', 'update', 'delete']) as privilege
                     where case privilege
                             when 'delete' then has_table_privilege('audit_writer', 'grants_probe', privilege)
                             else has_any_column_privilege('audit_writer', 'grants_probe', privilege)
                           end) as privileges`,
        ),
      ]);
    });
    expect(held.filter((privilege) => privilege.includes(": public "))).toEqual(
      [],
    );
    expect(auditWriter.rows).toEqual([{ privileges: ["insert"] }]);
  });

  it("is caught by the checks above when a table goes undeclared or a role holds more", async () => {
    const [undeclared, held] = await inRollback(migrator, async (client) => {
      await client.query("create table grants_forgotten (id int)");
      await client.query("grant select on grants_forgotten to api_rw");
      return Promise.all([
        undeclaredTables(client, declaredGrants()),
        heldPrivileges(client),
      ]);
    });
    expect(undeclared).toContain("grants_forgotten");
    expect(held).toContain("grants_forgotten: api_rw select");
  });
});

describe("declareGrants", () => {
  it.each<[string, Privilege]>([
    ["an empty column list", "select()"],
    ["a column name in capitals", "update(Name)"],
    [
      "a column list that smuggles SQL",
      "update(name) on x to y; drop table x)",
    ],
  ])("refuses %s", (_, privilege) => {
    expect(() => {
      declareGrants({
        grants_refused: {
          api_rw: [privilege],
          worker_rw: [],
          audit_writer: [],
        },
      });
    }).toThrow(`grants for grants_refused: "${privilege}" is not a privilege`);
  });
});

describe("the roles", () => {
  it("makes every role a login and none a superuser", async () => {
    const { rows } = await inRollback(migrator, (client) =>
      client.query(
        "select rolname, rolcanlogin, rolsuper from pg_roles where rolname = any($1) order by rolname",
        [ROLES],
      ),
    );
    expect(rows).toEqual(
      [...ROLES]
        .sort()
        .map((rolname) => ({ rolname, rolcanlogin: true, rolsuper: false })),
    );
  });

  it("lets no role but the migrator create in schema public, nor public connect", async () => {
    const { rows } = await inRollback(migrator, (client) =>
      client.query(
        `select has_database_privilege('public', 'powerbi_metrics_book', 'connect') as public_connects,
                array(select role from unnest($1::text[]) as role
                       where has_schema_privilege(role, 'public', 'create')) as creators`,
        [[...GRANTED_ROLES, "public"]],
      ),
    );
    expect(rows).toEqual([{ public_connects: false, creators: [] }]);
  });

  it("leaves no table, sequence or view owned by a role but the migrator", async () => {
    const { rows } = await inRollback(migrator, (client) =>
      client.query<{ relation: string; owner: string }>(
        `select namespace.nspname || '.' || class.relname as relation, pg_get_userbyid(class.relowner) as owner
           from pg_class as class
           join pg_namespace as namespace on namespace.oid = class.relnamespace
          where class.relkind in ('r', 'p', 'S', 'v', 'm', 'f')
            and namespace.nspname not in ('pg_catalog', 'information_schema')
            and namespace.nspname not like 'pg_toast%'
            and pg_get_userbyid(class.relowner) <> 'migrator'`,
      ),
    );
    expect(rows).toEqual([]);
  });

  it("has the vector extension, made by the init script", async () => {
    const { rows } = await inRollback(migrator, (client) =>
      client.query("select extname from pg_extension where extname = 'vector'"),
    );
    expect(rows).toEqual([{ extname: "vector" }]);
  });
});
