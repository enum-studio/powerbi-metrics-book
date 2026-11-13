# Hand-written SQL

SQL that Drizzle cannot express, such as a trigger that keeps a `tsvector`
column current, goes here as `<area>.sql`. A new index goes in the schema, so
that a migration adds it once. `src/db/migrate.ts` runs every
`.sql` file in this folder in name order, after the migrations and the
grants, on every start of the api. The grants and every file run in one
transaction: the grants revoke every routine's privileges first, so a
function a file grants again is never seen without its grant.

Because every file runs on every start, each must be idempotent: use
`create or replace function`, `drop trigger if exists` before
`create trigger`, and `if not exists` wherever Postgres offers it. An index
on a table a sync or a curator writes is the exception: `create index if not
exists` takes the table's share lock before it looks, so every start would
wait on an open sync. Ask `to_regclass` first, as `book.sql` does.

Extensions are not created here. The Postgres init script creates them
(`stack/postgres/init/`).

`collation.sql` is the exception to the one transaction. It rebuilds the
indexes that depend on the collation when the server has moved since they were
built, and commits after each, so `migrate.ts` runs it first and on its own.
Where nothing moved it locks no table.
