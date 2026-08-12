-- Keep the query/source record separate from the canonical record being
-- evaluated. This is required for a genuine alias -> canonical test.
alter table public.semantic_retrieval_eval_cases
  add column if not exists target_source_table text,
  add column if not exists target_source_id bigint;

update public.semantic_retrieval_eval_cases
set target_source_table = source_table,
    target_source_id = source_id
where target_source_table is null or target_source_id is null;

alter table public.semantic_retrieval_eval_cases
  alter column target_source_table set not null,
  alter column target_source_id set not null;

-- The previous seed is retained as audit history but must not be part of the
-- quality gate. Re-seed only cases with a grounded source and target.
update public.semantic_retrieval_eval_cases
set active = false,
    last_status = 'never_run',
    last_rank = null,
    last_similarity = null,
    last_error = null,
    last_model = null,
    last_run_at = null,
    updated_at = now();

with candidates as (
  select j.tenant_id, a.id as alias_id, b.id as building_id,
    trim(regexp_replace(regexp_replace(trim(a.alias), '[^[:alnum:][:space:]&./-]', '', 'g'), '\s+', ' ', 'g')) as query
  from public.building_name_aliases a
  join public.buildings b on b.id = a.building_id
  left join public.semantic_embedding_jobs j
    on j.source_table = 'building_name_aliases' and j.source_id = a.id
  where b.micro_market is not null
    and length(trim(a.alias)) between 5 and 100
    and a.alias !~ '[0-9]'
    and a.alias ~* '[[:alpha:]]{3}'
    and a.alias ~ '[[:space:]]'
    and lower(a.alias) !~* '(bhk|tax|rent|sale|available|configuration|for more|contact|details|family|bachelor|location|views|near metro|society dues|modular kitchen|independent building|preferred|prime location|multiple options|ready to move)'
), ranked as (
  select *, row_number() over (partition by building_id order by alias_id desc) as rn
  from candidates
  where length(query) between 5 and 100
)
insert into public.semantic_retrieval_eval_cases
  (tenant_id, query, entity_type, target_entity_type, source_table, source_id,
   target_source_table, target_source_id, top_k)
select tenant_id, query, 'building_alias', 'building', 'building_name_aliases', alias_id,
  'buildings', building_id, 5
from ranked
where rn = 1
limit 10
on conflict (tenant_id, query, source_table, source_id) do update
set target_entity_type = excluded.target_entity_type,
    target_source_table = excluded.target_source_table,
    target_source_id = excluded.target_source_id,
    active = true,
    last_status = 'never_run', last_rank = null, last_similarity = null,
    last_error = null, last_model = null, last_run_at = null, updated_at = now();

with candidates as (
  select j.tenant_id, a.id as alias_id, b.id as broker_id,
    trim(regexp_replace(regexp_replace(trim(a.alias), '[^[:alnum:][:space:].&-]', '', 'g'), '\s+', ' ', 'g')) as query
  from public.broker_aliases a
  join public.brokers b on b.id = a.broker_id
  left join public.semantic_embedding_jobs j
    on j.source_table = 'broker_aliases' and j.source_id = a.id
  where length(trim(a.alias)) between 5 and 80
    and a.alias !~ '[0-9]'
    and a.alias ~* '[[:alpha:]]{3}'
    and a.alias ~ '[[:space:]]'
    and b.canonical_name ~ '[[:space:]]'
    and a.observation_count >= 2
    and lower(a.alias) <> lower(trim(b.canonical_name))
    and lower(a.alias) !~* '(for more|contact|call|whatsapp|multiple options|regards|ready to move|configuration|negotiable|air conditioned|sea view|student|looking|rent|sale|available|family|bachelor|property type|juhu|andheri west|bandra west)'
), ranked as (
  select *, row_number() over (partition by broker_id order by alias_id desc) as rn
  from candidates
  where length(query) between 5 and 80
)
insert into public.semantic_retrieval_eval_cases
  (tenant_id, query, entity_type, target_entity_type, source_table, source_id,
   target_source_table, target_source_id, top_k)
select tenant_id, query, 'broker_alias', 'broker', 'broker_aliases', alias_id,
  'brokers', broker_id, 5
from ranked
where rn = 1
limit 10
on conflict (tenant_id, query, source_table, source_id) do update
set target_entity_type = excluded.target_entity_type,
    target_source_table = excluded.target_source_table,
    target_source_id = excluded.target_source_id,
    active = true,
    last_status = 'never_run', last_rank = null, last_similarity = null,
    last_error = null, last_model = null, last_run_at = null, updated_at = now();
