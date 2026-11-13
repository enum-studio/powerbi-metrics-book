-- The insert-only audit writer keeps request search text current through this trigger.
create or replace function request_search_tsv() returns trigger
language plpgsql as $$
begin
  new.search_tsv := to_tsvector('simple', concat_ws(' ', new.question, new.missing));
  return new;
end
$$;
revoke execute on function request_search_tsv() from public;
drop trigger if exists request_search_tsv on request;
create trigger request_search_tsv
  before insert or update of question, missing on request
  for each row execute function request_search_tsv();
