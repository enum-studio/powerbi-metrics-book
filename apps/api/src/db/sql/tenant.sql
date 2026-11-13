-- A database belongs to one tenant, for life. Once deployment_tenant has its
-- row, the setting powerbi.tenant_id may only be saved as that tenant, so
-- neither the admin section nor the CLI nor book.yml can move a bound
-- database to another. The value is jsonb holding a JSON string or null. The
-- setting table has no delete grant, and a second trigger refuses any change
-- of a row's key, so a row cannot be renamed out of the first trigger's reach.
-- Functions pin their search_path and name their tables. Runs on every
-- start: the functions are replaced and the triggers dropped first.

-- Match hasAdmin() in services/admin/people.ts: admin assigned to a person,
-- unless the email is a user's who is deactivated or whose stored email is
-- unverified. An email no user holds yet counts.
-- migrate.ts runs this as migrator, which owns the function and can read role_assignment.
create or replace function deployment_has_admin() returns boolean
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.role_assignment a
    where a.role = 'admin' and a.subject_kind = 'person'
      and not exists (
        select 1 from public."user" u
        left join public.person_deactivation d on d.user_id = u.id
        where lower(u.email) = a.subject
          and (d.user_id is not null or not u.email_verified)
      )
  )
$$;

revoke all on function deployment_has_admin() from public;
grant execute on function deployment_has_admin() to api_rw, worker_rw;

create or replace function setting_keep_bound_tenant() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  bound uuid;
begin
  select tenant_id into bound from public.deployment_tenant;
  if bound is not null and lower(new.value #>> '{}') is distinct from bound::text then
    raise exception 'This deployment belongs to tenant %. A deployment keeps one tenant: run another tenant on a new database.', bound
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

-- A trigger fires without a right to execute its function, so no role needs one.
revoke all on function setting_keep_bound_tenant() from public;

create or replace function setting_keep_key() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception 'The key of a setting never changes.'
    using errcode = 'check_violation';
end
$$;

revoke all on function setting_keep_key() from public;

drop trigger if exists setting_keep_bound_tenant on setting;
create trigger setting_keep_bound_tenant
  before insert or update on setting
  for each row
  when (new.key = 'powerbi.tenant_id')
  execute function setting_keep_bound_tenant();

drop trigger if exists setting_keep_key on setting;
create trigger setting_keep_key
  before update of key on setting
  for each row
  when (new.key is distinct from old.key)
  execute function setting_keep_key();
