-- JIT stays off for this database: docs/decisions/architecture.md says why. A
-- setting of the database and not of the server, so it reaches a deployment
-- that is already running and one on a managed Postgres. The migrator owns the
-- database, which is all it takes. New sessions read it.
do $$
begin
  execute format('alter database %I set jit = off', current_database());
end
$$;
