-- A thread's search_tsv holds its title and body. The 'simple' configuration
-- stems nothing, because a company's questions are in whatever language it
-- writes in. Runs on every start: the function is replaced and the trigger
-- dropped first.

create or replace function thread_set_search_tsv() returns trigger
language plpgsql as $$
begin
  new.search_tsv := to_tsvector('simple', coalesce(new.title, '') || ' ' || new.body);
  return new;
end
$$;

-- A trigger fires without a right to execute its function, so no role needs one.
revoke all on function thread_set_search_tsv() from public;

drop trigger if exists thread_search_tsv on thread;
create trigger thread_search_tsv
  before insert or update of title, body on thread
  for each row execute function thread_set_search_tsv();
