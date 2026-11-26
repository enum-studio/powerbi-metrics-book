-- The shipped preset is loaded by the migrator from the same YAML the API
-- reads. A company's newest override wins, including an empty allowed list.
create or replace function validate_metric_documentation() returns trigger
language plpgsql as $$
declare
  company jsonb;
  defaults jsonb;
  field text;
  allowed jsonb;
  value text;
begin
  select document into company from conventions order by version desc limit 1;
  select document into defaults from conventions_preset
    where name = coalesce(company->>'preset', 'metrics_book');
  foreach field in array array['tier', 'importance', 'direction'] loop
    value := to_jsonb(new)->>field;
    if tg_op = 'UPDATE' and value = to_jsonb(old)->>field then continue; end if;
    allowed := coalesce(company #> array['metric_fields',field,'values'], defaults #> array['metric_fields',field,'values']);
    if value <> '' and (allowed is null or not allowed ? value) then
      raise exception 'Choose a value allowed by the current conventions.'
        using errcode = '23514', constraint = 'metric_documentation_choice_check';
    end if;
  end loop;
  return new;
end
$$;
revoke all on function validate_metric_documentation() from public;
do $$ begin
  if not exists (select from pg_trigger where tgrelid = 'metric'::regclass and tgname = 'metric_documentation_check') then
    create trigger metric_documentation_check before insert or update on metric
      for each row execute function validate_metric_documentation();
  end if;
end $$;

-- The trigger also protects direct writes at READ COMMITTED. Its volatile
-- queries run after the graph lock; service writes lock before their statement.
create or replace function validate_metric_edge() returns trigger
language plpgsql as $$
begin
  -- A fixed transaction snapshot cannot see the writer that released the
  -- graph lock. Refuse that isolation rather than validate stale edges.
  if current_setting('transaction_isolation') not in ('read committed', 'read uncommitted') then
    raise exception 'Metric graph writes require READ COMMITTED isolation.'
      using errcode = '23514', constraint = 'metric_edge_isolation_check';
  end if;
  perform pg_advisory_xact_lock(hashtext('metric_relations'));
  if exists(with recursive descendants(id) as (
    select child_id from metric_edge where parent_id = new.child_id
    union select e.child_id from metric_edge e join descendants d on e.parent_id = d.id
  ) select from descendants where id = new.parent_id) then
    raise exception 'A metric edge cannot make a cycle.' using errcode = '23514', constraint = 'metric_edge_cycle_check';
  end if;
  if exists(select from metric_edge where parent_id = new.parent_id and operation <> new.operation) then
    raise exception 'A parent uses one operation.' using errcode = '23514', constraint = 'metric_edge_operation_consistency_check';
  end if;
  return new;
end
$$;
revoke all on function validate_metric_edge() from public;
do $$ begin
  if not exists (select from pg_trigger where tgrelid = 'metric_edge'::regclass and tgname = 'metric_edge_cycle_check') then
    create constraint trigger metric_edge_cycle_check after insert or update on metric_edge
      deferrable initially immediate for each row execute function validate_metric_edge();
  end if;
end $$;
