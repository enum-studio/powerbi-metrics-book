-- Keeps search_document.search_tsv over the name, the label and the text meant
-- for meaning. The 'simple' configuration stems nothing, because a company's
-- names are in whatever language it writes in. A trigger function fires with
-- no execute grant, so the worker's write alone keeps it current.

create or replace function search_document_set_search_tsv() returns trigger
language plpgsql as $$
begin
  new.search_tsv := to_tsvector(
    'simple',
    concat_ws(' ', new.name, new.label, new.search_text)
  );
  return new;
end
$$;

revoke all on function search_document_set_search_tsv() from public;

drop trigger if exists search_document_search_tsv on search_document;
create trigger search_document_search_tsv
  before insert or update of name, label, search_text on search_document
  for each row execute function search_document_set_search_tsv();

-- The HNSW index is built here and not in the migration, so that its memory is
-- set by this file: the database may share a small host, and Postgres would
-- otherwise take the server's maintenance_work_mem for it. A simple query with
-- several statements is one transaction, so `set local` ends with it.
set local maintenance_work_mem = '32MB';
create index if not exists search_document_embedding_idx
  on search_document using hnsw (embedding vector_cosine_ops);

-- Search finds a name or label typed with a letter wrong by pg_trgm's `%`.
-- Each index is asked after by name, as in book.sql: `create index if not
-- exists` takes the table's share lock before it looks, and every start would
-- wait on an embed run writing documents.
do $$
begin
  if to_regclass('search_document_name_trgm_idx') is null then
    create index search_document_name_trgm_idx
      on search_document using gin (name gin_trgm_ops);
  end if;
  if to_regclass('search_document_label_trgm_idx') is null then
    create index search_document_label_trgm_idx
      on search_document using gin (label gin_trgm_ops);
  end if;
end
$$;
