-- An index keeps the keys and the order it was built with. A glibc upgrade can
-- move lower() and the order of text, and a Postgres major can move normalize(),
-- and a lookup through the old index then misses what is there: a setting's row,
-- a name, a unique key that should have refused a second row.
-- docs/decisions/architecture.md has the runs. So when the server has moved, this
-- rebuilds every index that depends on the collation, as Postgres's own warning
-- asks, and only then refreshes the version that warning compares: refreshing
-- after less would silence it for the rest.
--
-- Unlike every other file here it runs before migrate.ts opens its transaction,
-- because it commits after each index: a rebuild that waits then holds up one table,
-- never the others. That table's writers wait, and its reads too if a transaction
-- that already read it stays open, since the rebuild then holds the table and waits
-- for the index.
--
-- A sync holds its locks for a whole workspace, and can read a table before it writes
-- it, which deadlocks with that wait. So each of the two locks waits 400 ms: the
-- rebuild has let go within 800 ms, before Postgres's default deadlock_timeout of a
-- second can end the sync, which would end its run. It then goes on to the other
-- indexes and comes back. A minute with no index rebuilt fails the start. Then, or if
-- a start dies part way, the record below is unchanged, so the next start does the
-- whole rebuild again.
--
-- The record is the comment on pii_rule_name_idx, since a table for it would change
-- the one migration, which a deployed database would then run again. version()
-- moves with the major, the minor and the distribution's build. The collation
-- version is there too, so that a refresh run by hand does not pass for a rebuild.
-- No record, as on the first start with this file, counts as moved, because nothing
-- says what the indexes were built under. Where nothing moved this reads two
-- catalogs and locks no table.
--
-- A duplicate that a stale unique index let in stops the rebuild of that index. The
-- start then fails naming each such index and never a key, since a key can be an
-- email address: this catches the error Postgres's message would carry it in, so
-- neither the api's log nor the server's holds it. A parallel worker would log that
-- error itself before anything could catch it, so these builds use none.
do $$
declare
  built_under text;
  collation_moved boolean;
  dependent regclass;
  duplicated text[] := '{}';
  give_up timestamptz := clock_timestamp() + interval '1 minute';
  next_up integer := 1;
  rebuilds regclass[];
begin
  select format(
      'Built under %s, collation version %s.',
      version(),
      coalesce(pg_database_collation_actual_version(oid), 'none')
    ),
    datcollversion <> pg_database_collation_actual_version(oid)
    into built_under, collation_moved
    from pg_database
    where datname = current_database();

  if collation_moved is not true
    and obj_description('pii_rule_name_idx'::regclass, 'pg_class') is not distinct from built_under
  then
    return;
  end if;

  rebuilds := array(
    select indexrelid::regclass
      from pg_index
      join pg_class on pg_class.oid = indexrelid
      where relnamespace = 'public'::regnamespace
        and (indexprs is not null
          or indpred is not null
          or 'default'::regcollation = any(indcollation::oid[]))
  );

  while next_up <= cardinality(rebuilds) and clock_timestamp() < give_up loop
    dependent := rebuilds[next_up];
    begin
      -- For this transaction, which ends with this index.
      perform set_config('lock_timeout', '400ms', true);
      perform set_config('max_parallel_maintenance_workers', '0', true);
      execute format('reindex index %s', dependent);
      give_up := clock_timestamp() + interval '1 minute';
    exception
      when unique_violation then
        duplicated := duplicated || dependent::text;
        give_up := clock_timestamp() + interval '1 minute';
      when lock_not_available then
        rebuilds := rebuilds || dependent;
    end;
    commit;
    next_up := next_up + 1;
  end loop;

  if cardinality(duplicated) > 0 then
    raise exception 'Two rows share a key in %, so these cannot be rebuilt for the server this database has moved to.',
      array_to_string(duplicated, ', ')
      using
        errcode = 'unique_violation',
        hint = 'As the migrator, run reindex index on each to see its key, look the rows up with enable_indexscan and enable_bitmapscan off, since the stale index can hide one, delete the extra row, and start the api again. The VM guide, under Upgrading, has the steps.';
  end if;

  if next_up <= cardinality(rebuilds) then
    raise exception 'Other transactions held % for a minute, so the next start rebuilds again.',
      array_to_string(rebuilds[next_up:], ', ')
      using errcode = 'lock_not_available';
  end if;

  if collation_moved then
    execute format('alter database %I refresh collation version', current_database());
  end if;
  execute format('comment on index pii_rule_name_idx is %L', built_under);
end
$$;
