-- Follow-up correction: scope coverage to queued entities and avoid false stale counts.
create or replace function public.get_semantic_embedding_status()
returns jsonb
language sql
stable
security invoker
set search_path = public, extensions, pg_temp
as $$
  with source_rows as (
    select 'residential_sale_listings'::text as source_table, id as source_id, 'listing'::text as entity_type from public.residential_sale_listings
    union all select 'residential_rent_listings', id, 'listing' from public.residential_rent_listings
    union all select 'commercial_sale_listings', id, 'listing' from public.commercial_sale_listings
    union all select 'commercial_rent_listings', id, 'listing' from public.commercial_rent_listings
    union all select 'residential_sale_requirements', id, 'requirement' from public.residential_sale_requirements
    union all select 'residential_rent_requirements', id, 'requirement' from public.residential_rent_requirements
    union all select 'commercial_sale_requirements', id, 'requirement' from public.commercial_sale_requirements
    union all select 'commercial_rent_requirements', id, 'requirement' from public.commercial_rent_requirements
    union all select 'buildings', id, 'building' from public.buildings
    union all select 'building_name_aliases', id, 'building_alias' from public.building_name_aliases
    union all select 'locality_reference', id, 'locality' from public.locality_reference
    union all select 'brokers', id, 'broker' from public.brokers
    union all select 'broker_aliases', id, 'broker_alias' from public.broker_aliases
  ),
  job_totals as (
    select
      count(*)::bigint as total,
      count(*) filter (where status = 'pending')::bigint as pending,
      count(*) filter (where status = 'running')::bigint as running,
      count(*) filter (where status = 'completed')::bigint as completed,
      count(*) filter (where status = 'failed')::bigint as failed,
      count(*) filter (where status = 'failed' and attempts >= 5)::bigint as exhausted,
      max(completed_at) as last_completed_at
    from public.semantic_embedding_jobs
  ),
  vector_totals as (
    select
      count(*)::bigint as total,
      count(distinct model)::integer as model_count,
      max(updated_at) as last_stored_at
    from public.semantic_embeddings
  ),
  latest_vector as (
    select model, dimensions
    from public.semantic_embeddings
    order by updated_at desc nulls last, id desc
    limit 1
  ),
  entity_jobs as (
    select
      entity_type,
      count(*)::bigint as total,
      count(*) filter (where status = 'pending')::bigint as pending,
      count(*) filter (where status = 'running')::bigint as running,
      count(*) filter (where status = 'completed')::bigint as completed,
      count(*) filter (where status = 'failed')::bigint as failed
    from public.semantic_embedding_jobs
    group by entity_type
  ),
  entity_vectors as (
    select entity_type, count(distinct (source_table, source_id))::bigint as embedded
    from public.semantic_embeddings
    where model = (select model from latest_vector)
    group by entity_type
  ),
  entity_breakdown as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'entity_type', j.entity_type,
          'total', j.total,
          'pending', j.pending,
          'running', j.running,
          'completed', j.completed,
          'failed', j.failed,
          'embedded', coalesce(v.embedded, 0)
        ) order by j.entity_type
      ),
      '[]'::jsonb
    ) as rows
    from entity_jobs j
    left join entity_vectors v using (entity_type)
  ),
  source_totals_by_entity as (
    select coalesce(jsonb_object_agg(entity_type, total), '{}'::jsonb) as rows
    from (
      select entity_type, count(*)::bigint as total
      from source_rows
      group by entity_type
    ) s
  ),
  structural_quality as (
    select
      (select count(distinct (v.source_table, v.source_id))::bigint
         from public.semantic_embeddings v
        where v.model = (select model from latest_vector)
          and exists (
            select 1 from source_rows s
             where s.source_table = v.source_table and s.source_id = v.source_id
          )) as indexed_entities,
      (select count(distinct (v.source_table, v.source_id))::bigint
         from public.semantic_embeddings v
        where exists (
          select 1 from public.semantic_embedding_jobs j
           where j.source_table = v.source_table
             and j.source_id = v.source_id
             and j.status <> 'completed'
        )) as stale_entities,
      (select count(*)::bigint
         from public.semantic_embeddings v
        where not exists (
          select 1 from source_rows s
           where s.source_table = v.source_table and s.source_id = v.source_id
        )) as orphan_vectors,
      (select count(*)::bigint
         from public.semantic_embedding_jobs j
        where not exists (
          select 1 from source_rows s
           where s.source_table = j.source_table and s.source_id = j.source_id
        )) as unresolved_jobs,
      (select count(*)::bigint
         from public.semantic_embeddings v
        where length(trim(v.content)) = 0 or length(v.content_hash) <> 64) as invalid_documents,
      (select greatest(count(*) - count(distinct (source_table, source_id)), 0)::bigint
         from public.semantic_embeddings) as duplicate_model_rows,
      (select count(distinct (j.source_table, j.source_id))::bigint
         from public.semantic_embedding_jobs j
        where exists (
          select 1 from source_rows s
           where s.source_table = j.source_table and s.source_id = j.source_id
        )) as expected_entities
  ),
  alias_vectors as (
    select v.entity_type, v.source_table, v.source_id,
           (v.metadata->>'building_id')::bigint as expected_id,
           v.embedding, v.model
      from public.semantic_embeddings v
     where v.entity_type = 'building_alias'
       and v.metadata ? 'building_id'
       and v.model = (select model from latest_vector)
    union all
    select v.entity_type, v.source_table, v.source_id,
           (v.metadata->>'broker_id')::bigint as expected_id,
           v.embedding, v.model
      from public.semantic_embeddings v
     where v.entity_type = 'broker_alias'
       and v.metadata ? 'broker_id'
       and v.model = (select model from latest_vector)
  ),
  alias_ranks as (
    select a.entity_type, a.source_table, a.source_id, a.expected_id,
           c.source_id as candidate_id,
           c.rank
      from alias_vectors a
      cross join lateral (
        select candidate.source_id,
               row_number() over (order by candidate.embedding <=> a.embedding) as rank
          from public.semantic_embeddings candidate
         where candidate.model = a.model
           and candidate.source_table = case when a.entity_type = 'building_alias' then 'buildings' else 'brokers' end
         order by candidate.embedding <=> a.embedding
         limit 5
      ) c
  ),
  alias_best as (
    select entity_type, source_table, source_id, expected_id,
           min(rank) filter (where candidate_id = expected_id) as expected_rank
      from alias_ranks
     group by entity_type, source_table, source_id, expected_id
  ),
  alias_quality as (
    select jsonb_build_object(
      'building_aliases', jsonb_build_object(
        'tested', count(*) filter (where entity_type = 'building_alias'),
        'hit_at_5', count(*) filter (where entity_type = 'building_alias' and expected_rank <= 5),
        'hit_rate_at_5', coalesce(round((100.0 * count(*) filter (where entity_type = 'building_alias' and expected_rank <= 5) / nullif(count(*) filter (where entity_type = 'building_alias'), 0))::numeric, 1), 0)
      ),
      'broker_aliases', jsonb_build_object(
        'tested', count(*) filter (where entity_type = 'broker_alias'),
        'hit_at_5', count(*) filter (where entity_type = 'broker_alias' and expected_rank <= 5),
        'hit_rate_at_5', coalesce(round((100.0 * count(*) filter (where entity_type = 'broker_alias' and expected_rank <= 5) / nullif(count(*) filter (where entity_type = 'broker_alias'), 0))::numeric, 1), 0)
      )
    ) as value
    from alias_best
  ),
  latest_failure as (
    select jsonb_build_object(
      'entity_type', entity_type,
      'source_table', source_table,
      'source_id', source_id,
      'attempts', attempts,
      'last_error', left(last_error, 500),
      'updated_at', updated_at
    ) as row
    from public.semantic_embedding_jobs
    where status = 'failed'
    order by updated_at desc
    limit 1
  )
  select jsonb_build_object(
    'jobs', jsonb_build_object(
      'total', jt.total,
      'pending', jt.pending,
      'running', jt.running,
      'completed', jt.completed,
      'failed', jt.failed,
      'exhausted', jt.exhausted
    ),
    'vectors', jsonb_build_object(
      'total', vt.total,
      'model_count', vt.model_count
    ),
    'model', coalesce(lv.model, 'nvidia/nemotron-3-embed-1b:free'),
    'dimensions', coalesce(lv.dimensions, 1024),
    'last_completed_at', jt.last_completed_at,
    'last_stored_at', vt.last_stored_at,
    'latest_failure', lf.row,
    'by_entity', eb.rows,
    'source_totals', st.rows,
    'quality', jsonb_build_object(
      'expected_entities', sq.expected_entities,
      'indexed_entities', sq.indexed_entities,
      'coverage_pct', coalesce(round((100.0 * sq.indexed_entities / nullif(sq.expected_entities, 0))::numeric, 1), 0),
      'stale_entities', sq.stale_entities,
      'orphan_vectors', sq.orphan_vectors,
      'unresolved_jobs', sq.unresolved_jobs,
      'invalid_documents', sq.invalid_documents,
      'duplicate_model_rows', sq.duplicate_model_rows,
      'alias_checks', aq.value
    ),
    'generated_at', now()
  )
  from job_totals jt
  cross join vector_totals vt
  left join latest_vector lv on true
  cross join entity_breakdown eb
  cross join source_totals_by_entity st
  cross join structural_quality sq
  cross join alias_quality aq
  left join latest_failure lf on true;
$$;

revoke all on function public.get_semantic_embedding_status() from public, anon, authenticated;
grant execute on function public.get_semantic_embedding_status() to service_role;
