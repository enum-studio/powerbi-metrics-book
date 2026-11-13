import { escapeIdentifier, type ClientBase } from "pg";

/*
 * Who may do what to each table, declared beside the table in its schema
 * module and applied by migrate.ts after the migrations. The migrator owns
 * every table and is not listed: an owner holds every right on what it owns.
 */

export const GRANTED_ROLES = ["api_rw", "worker_rw", "audit_writer"] as const;
export type GrantedRole = (typeof GRANTED_ROLES)[number];

const VERBS = ["select", "insert", "update", "delete"] as const;
type Verb = (typeof VERBS)[number];
/** Postgres has no column-level delete. */
type ColumnVerb = Exclude<Verb, "delete">;
/** A whole-table privilege, or one limited to columns: "update(description, custom)". */
export type Privilege = Verb | `${ColumnVerb}(${string})`;

/** Every role is named, an empty list included, so each declaration says what each role may do. */
export type TableGrants = Record<GrantedRole, readonly Privilege[]>;
export type Declarations = ReadonlyMap<string, TableGrants>;

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const PRIVILEGE =
  /^(select|insert|update|delete)(?:\(\s*([a-z_][a-z0-9_]*(?:\s*,\s*[a-z_][a-z0-9_]*)*)\s*\))?$/;

const declared = new Map<string, TableGrants>();

/** Called once per table, at the top level of its schema module. */
export function declareGrants(tables: Record<string, TableGrants>): void {
  for (const [table, grants] of Object.entries(tables)) {
    if (!IDENTIFIER.test(table))
      throw new Error(`grants for "${table}": not a table name`);
    if (declared.has(table))
      throw new Error(`grants for ${table} are declared twice`);
    for (const role of GRANTED_ROLES) {
      for (const privilege of grants[role]) parsePrivilege(table, privilege);
    }
    declared.set(table, grants);
  }
}

export function declaredGrants(): Declarations {
  return declared;
}

type ParsedPrivilege = { verb: Verb; columns: string[] | null };

function parsePrivilege(table: string, privilege: string): ParsedPrivilege {
  const match = PRIVILEGE.exec(privilege);
  const verb = VERBS.find((candidate) => candidate === match?.[1]);
  const columns = match?.[2];
  if (verb === undefined || (verb === "delete" && columns !== undefined))
    throw new Error(`grants for ${table}: "${privilege}" is not a privilege`);
  return {
    verb,
    columns:
      columns === undefined
        ? null
        : columns.split(",").map((column) => column.trim()),
  };
}

/**
 * Makes the three roles' privileges on schema public exactly the declared
 * ones: everything is revoked first, from the three roles and from public, on
 * every table, sequence and routine, declared or not, then the declarations
 * are granted. A grant to public is held by every role, so leaving one would
 * let audit_writer delete. A table created without a declaration is so left
 * unreadable by every role but its owner. Revoking a table's privileges
 * revokes its column privileges with it.
 *
 * An extension's routines are left alone: the superuser owns them, so the
 * migrator could not revoke them, and the roles need them (pgvector's
 * operators).
 *
 * Run it inside a transaction, so no request sees the moment between the
 * revoke and the grants.
 */
export async function applyGrants(
  client: ClientBase,
  declarations: Declarations = declaredGrants(),
): Promise<void> {
  const grantees = [...GRANTED_ROLES.map(escapeIdentifier), "public"].join(
    ", ",
  );
  await client.query(
    // nosemgrep: no-sql-built-by-string-formatting-typescript grantees is GRANTED_ROLES from code, each through pg.escapeIdentifier, plus public; DDL takes no parameters
    `revoke all on all tables in schema public from ${grantees}`,
  );
  await client.query(
    // nosemgrep: no-sql-built-by-string-formatting-typescript grantees is GRANTED_ROLES from code, each through pg.escapeIdentifier, plus public; DDL takes no parameters
    `revoke all on all sequences in schema public from ${grantees}`,
  );
  // The server writes each statement: format's %s of a regprocedure gives the
  // routine's name and argument types quoted as an identifier needs.
  const { rows } = await client.query<{ statement: string }>(
    `select format('revoke all on routine %s from %s', routine.oid::regprocedure, $1::text) as statement
       from pg_proc as routine
      where routine.pronamespace = 'public'::regnamespace
        and not exists (select from pg_depend as dependency
                         where dependency.classid = 'pg_proc'::regclass
                           and dependency.objid = routine.oid and dependency.deptype = 'e')`,
    [grantees],
  );
  for (const { statement } of rows) await client.query(statement);
  for (const [table, grants] of declarations) {
    for (const role of GRANTED_ROLES) {
      for (const privilege of grants[role]) {
        const { verb, columns } = parsePrivilege(table, privilege);
        const what =
          columns === null
            ? verb
            : `${verb} (${columns.map(escapeIdentifier).join(", ")})`;
        await client.query(
          // nosemgrep: no-sql-built-by-string-formatting-typescript verb is one of VERBS, columns, table and role go through pg.escapeIdentifier, all declared in code; DDL takes no parameters
          `grant ${what} on table public.${escapeIdentifier(table)} to ${escapeIdentifier(role)}`,
        );
      }
    }
  }
}
