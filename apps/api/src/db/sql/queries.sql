-- Keeps query_log.search_tsv over the DAX, the purpose and the dataset name,
-- so the log is searchable by a word of any of them. The 'simple'
-- configuration lowercases and splits on punctuation without stemming, which
-- suits DAX names as well as the purpose's words. A trigger function fires
-- with no execute grant, so audit_writer's insert alone keeps it current.

create or replace function query_log_search_tsv() returns trigger
language plpgsql as $$
begin
  new.search_tsv := to_tsvector(
    'simple',
    concat_ws(' ', new.dax, new.purpose, new.dataset_name)
  );
  return new;
end
$$;

-- Runs after the grants, so the default execute for public is taken back here.
revoke execute on function query_log_search_tsv() from public;

drop trigger if exists query_log_search_tsv on query_log;
create trigger query_log_search_tsv
  before insert or update of dax, purpose, dataset_name on query_log
  for each row execute function query_log_search_tsv();
