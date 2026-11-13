-- The indexes the book's reads lean on, here and not in the schema because
-- they came when a deployed database could take no new migration. A new index
-- goes in the schema. Each here is asked after by name, because `create index if not exists` takes the table's share lock
-- before it looks: every start would wait on an open sync and hold up writes.
-- powerbi_measure comes first, as the drafter writes it and then metric: the
-- other way round, a first start and a draft run would deadlock.
do $$
begin
  -- A likely merge finds the measures a name can pair with by the words of the
  -- name, as suggestMerges compares them, and not by reading every measure.
  if to_regclass('powerbi_measure_name_words_idx') is null then
    create index powerbi_measure_name_words_idx on powerbi_measure (
      btrim(regexp_replace(lower(name), '[^[:alnum:]%]+', ' ', 'g'))
    );
  end if;

  -- And the measures the DAX proves the same calculation as a draft's, as
  -- suggestSameNames pairs them, and not by reading every measure either.
  if to_regclass('powerbi_measure_fingerprint_idx') is null then
    create index powerbi_measure_fingerprint_idx on powerbi_measure (fingerprint);
  end if;

  -- Finds what is close to a draft (the % operator), and the labels that may
  -- share a word (ilike), without comparing every metric.
  if to_regclass('metric_name_trgm_idx') is null then
    create index metric_name_trgm_idx on metric using gin (name gin_trgm_ops);
  end if;
  if to_regclass('metric_label_trgm_idx') is null then
    create index metric_label_trgm_idx on metric using gin (label gin_trgm_ops);
  end if;
end
$$;
