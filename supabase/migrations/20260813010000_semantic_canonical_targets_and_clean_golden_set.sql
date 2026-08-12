-- Retrieval cases distinguish the query/document entity from the canonical
-- entity that must be returned. Alias queries are evaluated against canonical
-- buildings/brokers, not against the alias rows themselves.
alter table public.semantic_retrieval_eval_cases
  add column if not exists target_entity_type text;

update public.semantic_retrieval_eval_cases
set target_entity_type = case
  when entity_type = 'building_alias' then 'building'
  when entity_type = 'broker_alias' then 'broker'
  else entity_type
end
where target_entity_type is null;

alter table public.semantic_retrieval_eval_cases
  alter column target_entity_type set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'semantic_retrieval_eval_target_entity_type_check'
  ) then
    alter table public.semantic_retrieval_eval_cases
      add constraint semantic_retrieval_eval_target_entity_type_check
      check (target_entity_type in (
        'listing', 'requirement', 'building', 'locality', 'broker'
      ));
  end if;
end $$;

-- Correct a known imported record where the locality was incorrectly folded
-- into the building name. Keep the building row and its raw aliases intact;
-- restore the relational representation instead of inventing a merged entity.
update public.buildings
set canonical_name = 'RNA Mirage',
    micro_market = 'Worli',
    updated_at = now()
where lower(btrim(canonical_name)) = 'rna mirage worli'
  and nullif(btrim(micro_market), '') is null
  and lower(coalesce(address, '')) like '%rna mirage%'
  and lower(coalesce(address, '')) like '%worli%';

update public.building_name_aliases
set canonical_name = 'RNA Mirage'
where lower(btrim(canonical_name)) = 'rna mirage worli'
  and exists (
    select 1
    from public.buildings b
    where b.id = building_name_aliases.building_id
      and b.canonical_name = 'RNA Mirage'
      and b.micro_market = 'Worli'
  );

-- Existing rows were generated before the target/source distinction and were
-- not reviewed. Keep them for auditability, but exclude them from evaluation.
update public.semantic_retrieval_eval_cases
set active = false,
    last_status = 'never_run',
    last_rank = null,
    last_similarity = null,
    last_error = null,
    last_model = null,
    last_run_at = null,
    updated_at = now();

-- Building aliases: clean the query, retain the raw alias in the source row,
-- and evaluate the linked canonical building with deterministic context.
with candidates as (
  select j.tenant_id, b.id as target_id,
    trim(regexp_replace(regexp_replace(trim(a.alias), '[^[:alnum:][:space:]&./-]', '', 'g'), '\s+', ' ', 'g')) as query,
    trim(regexp_replace(regexp_replace(trim(b.canonical_name), '[^[:alnum:][:space:]&./-]', '', 'g'), '\s+', ' ', 'g')) as canonical
  from public.building_name_aliases a
  join public.buildings b on b.id = a.building_id
  left join public.semantic_embedding_jobs j
    on j.source_table = 'building_name_aliases' and j.source_id = a.id
  where b.micro_market is not null
    and length(trim(a.alias)) between 5 and 100
    and a.alias !~ '[0-9]'
    and a.alias ~* '[[:alpha:]]{3}'
    and a.alias ~ '[[:space:]]'
    and b.canonical_name ~ '[[:space:]]'
    and lower(a.alias) !~* '(bhk|tax|rent|sale|available|configuration|for more|contact|details|family|bachelor|location|views|near metro|society dues|modular kitchen|independent building|preferred|prime location)'
)
insert into public.semantic_retrieval_eval_cases
  (tenant_id, query, entity_type, target_entity_type, source_table, source_id, top_k)
select tenant_id, query, 'building_alias', 'building', 'buildings', target_id, 5
from candidates
where length(query) between 5 and 100
  and lower(query) <> lower(canonical)
order by target_id desc
limit 10
on conflict (tenant_id, query, source_table, source_id) do update
set active = true, target_entity_type = excluded.target_entity_type,
    last_status = 'never_run', last_rank = null, last_similarity = null,
    last_error = null, last_model = null, last_run_at = null, updated_at = now();

-- Broker aliases: require a plausible multi-word name and repeated observation;
-- generic listing text is not a broker identity test case.
with candidates as (
  select j.tenant_id, b.id as target_id,
    trim(regexp_replace(regexp_replace(trim(a.alias), '[^[:alnum:][:space:].&-]', '', 'g'), '\s+', ' ', 'g')) as query,
    trim(b.canonical_name) as canonical
  from public.broker_aliases a
  join public.brokers b on b.id = a.broker_id
  left join public.semantic_embedding_jobs j
    on j.source_table = 'broker_aliases' and j.source_id = a.id
  where length(trim(a.alias)) between 5 and 80
    and a.alias ~* '[[:alpha:]]{3}'
    and a.alias ~ '[[:space:]]'
    and b.canonical_name ~ '[[:space:]]'
    and a.observation_count >= 2
    and lower(a.alias) <> lower(trim(b.canonical_name))
    and lower(a.alias) !~* '(for more|contact|call|whatsapp|multiple options|regards|ready to move|configuration|negotiable|air conditioned|sea view|student|looking|rent|sale|available|family|bachelor|property type)'
)
insert into public.semantic_retrieval_eval_cases
  (tenant_id, query, entity_type, target_entity_type, source_table, source_id, top_k)
select tenant_id, query, 'broker_alias', 'broker', 'brokers', target_id, 5
from candidates
where length(query) between 5 and 80
order by target_id desc
limit 10
on conflict (tenant_id, query, source_table, source_id) do update
set active = true, target_entity_type = excluded.target_entity_type,
    last_status = 'never_run', last_rank = null, last_similarity = null,
    last_error = null, last_model = null, last_run_at = null, updated_at = now();

insert into public.semantic_retrieval_eval_cases
  (tenant_id, query, entity_type, target_entity_type, source_table, source_id, top_k)
select j.tenant_id,
  trim(regexp_replace(regexp_replace(trim(b.canonical_name), '[^[:alnum:][:space:].&-]', '', 'g'), '\s+', ' ', 'g')),
  'building', 'building', 'buildings', b.id, 5
from public.buildings b
left join public.semantic_embedding_jobs j on j.source_table = 'buildings' and j.source_id = b.id
where b.micro_market is not null
  and length(trim(b.canonical_name)) between 5 and 100
  and b.canonical_name ~ '[[:space:]]'
  and b.canonical_name !~ '[0-9]'
  and b.canonical_name ~* '[[:alpha:]]{3}'
  and lower(b.canonical_name) !~* '(bhk|tax|rent|sale|available|configuration|for more|contact|details|family|bachelor|location|views|near metro|society dues|modular kitchen|independent building|preferred|prime location|residential space|shopping centre|colony|bungalow)'
order by b.updated_at desc nulls last, b.id desc
limit 10
on conflict (tenant_id, query, source_table, source_id) do update
set active = true, target_entity_type = excluded.target_entity_type,
    last_status = 'never_run', last_rank = null, last_similarity = null,
    last_error = null, last_model = null, last_run_at = null, updated_at = now();

insert into public.semantic_retrieval_eval_cases
  (tenant_id, query, entity_type, target_entity_type, source_table, source_id, top_k)
select j.tenant_id, trim(b.canonical_name), 'broker', 'broker', 'brokers', b.id, 5
from public.brokers b
left join public.semantic_embedding_jobs j on j.source_table = 'brokers' and j.source_id = b.id
where length(trim(b.canonical_name)) between 5 and 100
  and b.canonical_name ~ '[[:space:]]'
  and b.canonical_name !~ '[0-9@]'
  and b.canonical_name ~* '[[:alpha:]]{3}'
  and coalesce(b.listing_count, 0) + coalesce(b.requirement_count, 0) > 0
  and lower(b.canonical_name) !~* '(for more|contact|call|whatsapp|rent|sale|available|configuration|property type|andheri west|bandra west)'
order by b.updated_at desc nulls last, b.id desc
limit 10
on conflict (tenant_id, query, source_table, source_id) do update
set active = true, target_entity_type = excluded.target_entity_type,
    last_status = 'never_run', last_rank = null, last_similarity = null,
    last_error = null, last_model = null, last_run_at = null, updated_at = now();

insert into public.semantic_retrieval_eval_cases
  (tenant_id, query, entity_type, target_entity_type, source_table, source_id, top_k)
select r.tenant_id,
  trim(r.summary_title || ' ' || coalesce(r.building_name, '') || ' ' || coalesce(r.micro_market, '')),
  'listing', 'listing', 'residential_rent_listings', r.id, 10
from public.residential_rent_listings r
where length(trim(coalesce(r.summary_title, '') || ' ' || coalesce(r.building_name, '') || ' ' || coalesce(r.micro_market, ''))) between 12 and 500
  and r.summary_title ilike '%bhk%'
  and (coalesce(r.building_name, '') <> '' or coalesce(r.micro_market, '') <> '')
order by r.id desc
limit 10
on conflict (tenant_id, query, source_table, source_id) do update
set active = true, target_entity_type = excluded.target_entity_type,
    last_status = 'never_run', last_rank = null, last_similarity = null,
    last_error = null, last_model = null, last_run_at = null, updated_at = now();

insert into public.semantic_retrieval_eval_cases
  (tenant_id, query, entity_type, target_entity_type, source_table, source_id, top_k)
select null, trim(l.sub_locality || ' ' || coalesce(l.parent_locality, '') || ' ' || coalesce(l.city, '')),
  'locality', 'locality', 'locality_reference', l.id, 5
from public.locality_reference l
where length(trim(coalesce(l.sub_locality, '') || ' ' || coalesce(l.parent_locality, '') || ' ' || coalesce(l.city, ''))) between 5 and 180
  and l.sub_locality is not null
order by l.updated_at desc nulls last, l.id desc
limit 10
on conflict (tenant_id, query, source_table, source_id) do update
set active = true, target_entity_type = excluded.target_entity_type,
    last_status = 'never_run', last_rank = null, last_similarity = null,
    last_error = null, last_model = null, last_run_at = null, updated_at = now();

insert into public.semantic_retrieval_eval_cases
  (tenant_id, query, entity_type, target_entity_type, source_table, source_id, top_k)
select r.tenant_id, trim(r.summary_title || ' ' || coalesce(r.micro_market, '')),
  'requirement', 'requirement', 'residential_rent_requirements', r.id, 10
from public.residential_rent_requirements r
where length(trim(coalesce(r.summary_title, '') || ' ' || coalesce(r.micro_market, ''))) between 12 and 500
  and r.summary_title ~* '[0-9]+[[:space:]]*BHK'
  and coalesce(r.micro_market, '') <> ''
order by r.id desc
limit 10
on conflict (tenant_id, query, source_table, source_id) do update
set active = true, target_entity_type = excluded.target_entity_type,
    last_status = 'never_run', last_rank = null, last_similarity = null,
    last_error = null, last_model = null, last_run_at = null, updated_at = now();
