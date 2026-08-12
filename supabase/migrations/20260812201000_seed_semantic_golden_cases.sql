-- Seed baseline cases from existing canonical relationships and real typed
-- inventory. These are evaluation candidates grounded in stored source rows;
-- operators can remove any case whose expected identity is not accepted.
insert into public.semantic_retrieval_eval_cases
  (tenant_id, query, entity_type, source_table, source_id, top_k)
select j.tenant_id, trim(a.alias), 'building_alias', 'buildings', a.building_id, 5
from public.building_name_aliases a
join public.buildings b on b.id = a.building_id
left join public.semantic_embedding_jobs j
  on j.source_table = 'building_name_aliases' and j.source_id = a.id
where length(trim(a.alias)) between 4 and 100
  and lower(trim(a.alias)) <> lower(trim(b.canonical_name))
  and lower(a.alias) not like '%configuration%'
  and lower(a.alias) not like '%for more%'
order by a.id desc
limit 10
on conflict (tenant_id, query, source_table, source_id) do nothing;

insert into public.semantic_retrieval_eval_cases
  (tenant_id, query, entity_type, source_table, source_id, top_k)
select j.tenant_id, trim(a.alias), 'broker_alias', 'brokers', a.broker_id, 5
from public.broker_aliases a
join public.brokers b on b.id = a.broker_id
left join public.semantic_embedding_jobs j
  on j.source_table = 'broker_aliases' and j.source_id = a.id
where length(trim(a.alias)) between 6 and 80
  and a.alias ~ '[A-Za-z]{3}'
  and a.alias !~ '[0-9]{4}'
  and lower(trim(a.alias)) <> lower(trim(b.canonical_name))
  and lower(a.alias) !~ '(for more|details|student|welcome|looking|contact|call|whatsapp|multiple options|regards|ready to move|configuration|negotiable|air conditioned|sea view)'
order by a.observation_count desc nulls last, a.id desc
limit 10
on conflict (tenant_id, query, source_table, source_id) do nothing;

insert into public.semantic_retrieval_eval_cases
  (tenant_id, query, entity_type, source_table, source_id, top_k)
select j.tenant_id, trim(b.canonical_name), 'building', 'buildings', b.id, 5
from public.buildings b
left join public.semantic_embedding_jobs j
  on j.source_table = 'buildings' and j.source_id = b.id
where length(trim(b.canonical_name)) between 5 and 120
order by b.updated_at desc nulls last, b.id desc
limit 10
on conflict (tenant_id, query, source_table, source_id) do nothing;

insert into public.semantic_retrieval_eval_cases
  (tenant_id, query, entity_type, source_table, source_id, top_k)
select j.tenant_id, trim(b.canonical_name), 'broker', 'brokers', b.id, 5
from public.brokers b
left join public.semantic_embedding_jobs j
  on j.source_table = 'brokers' and j.source_id = b.id
where length(trim(b.canonical_name)) between 5 and 120
  and b.canonical_name !~ '^[0-9 +().-]+$'
order by b.updated_at desc nulls last, b.id desc
limit 10
on conflict (tenant_id, query, source_table, source_id) do nothing;

insert into public.semantic_retrieval_eval_cases
  (tenant_id, query, entity_type, source_table, source_id, top_k)
select r.tenant_id,
       trim(r.summary_title || ' ' || coalesce(r.building_name, '') || ' ' || coalesce(r.micro_market, '')),
       'listing', 'residential_rent_listings', r.id, 10
from public.residential_rent_listings r
where length(trim(coalesce(r.summary_title, '') || ' ' || coalesce(r.building_name, '') || ' ' || coalesce(r.micro_market, ''))) between 12 and 500
  and r.summary_title ilike '%bhk%'
order by r.id desc
limit 10
on conflict (tenant_id, query, source_table, source_id) do nothing;

insert into public.semantic_retrieval_eval_cases
  (tenant_id, query, entity_type, source_table, source_id, top_k)
select null, trim(l.sub_locality || ' ' || coalesce(l.parent_locality, '') || ' ' || coalesce(l.city, '')), 'locality', 'locality_reference', l.id, 5
from public.locality_reference l
where length(trim(coalesce(l.sub_locality, '') || ' ' || coalesce(l.parent_locality, '') || ' ' || coalesce(l.city, ''))) between 5 and 180
order by l.updated_at desc nulls last, l.id desc
limit 10
on conflict (tenant_id, query, source_table, source_id) do nothing;

insert into public.semantic_retrieval_eval_cases
  (tenant_id, query, entity_type, source_table, source_id, top_k)
select r.tenant_id,
       trim(r.summary_title || ' ' || coalesce(r.micro_market, '')),
       'requirement', 'residential_rent_requirements', r.id, 10
from public.residential_rent_requirements r
where length(trim(coalesce(r.summary_title, '') || ' ' || coalesce(r.micro_market, ''))) between 12 and 500
  and r.summary_title ~* '[0-9]+[[:space:]]*BHK'
  and coalesce(r.micro_market, '') <> ''
order by r.id desc
limit 10
on conflict (tenant_id, query, source_table, source_id) do nothing;
