-- Keep the operator dashboard responsive as source inventory grows.
-- The previous status RPC repeatedly materialized every source table for each
-- quality metric. Jobs already identify the bounded set of entities being
-- indexed, so measure queue/vector alignment without rescanning source tables.
create or replace function public.get_semantic_embedding_status()
returns jsonb
language sql
stable
security invoker
set search_path = public, extensions, pg_temp
as $$
  with job_rows as materialized (
    select * from public.semantic_embedding_jobs
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
    from job_rows
  ),
  vector_totals as (
    select count(*)::bigint as total, count(distinct model)::integer as model_count,
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
    select entity_type, count(*)::bigint as total,
           count(*) filter (where status = 'pending')::bigint as pending,
           count(*) filter (where status = 'running')::bigint as running,
           count(*) filter (where status = 'completed')::bigint as completed,
           count(*) filter (where status = 'failed')::bigint as failed
    from job_rows
    group by entity_type
  ),
  entity_vectors as (
    select entity_type, count(distinct (source_table, source_id))::bigint as embedded
    from public.semantic_embeddings
    where model = (select model from latest_vector)
    group by entity_type
  ),
  entity_breakdown as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'entity_type', j.entity_type,
      'total', j.total,
      'pending', j.pending,
      'running', j.running,
      'completed', j.completed,
      'failed', j.failed,
      'embedded', coalesce(v.embedded, 0)
    ) order by j.entity_type), '[]'::jsonb) as rows
    from entity_jobs j
    left join entity_vectors v using (entity_type)
  ),
  structural_quality as (
    select
      (select count(distinct (v.source_table, v.source_id))::bigint
       from public.semantic_embeddings v
       join job_rows j using (source_table, source_id)
       where v.model = (select model from latest_vector)) as indexed_entities,
      (select count(distinct (v.source_table, v.source_id))::bigint
       from public.semantic_embeddings v
       join job_rows j using (source_table, source_id)
       where j.status <> 'completed') as stale_entities,
      (select count(*)::bigint
       from public.semantic_embeddings v
       where not exists (
         select 1 from job_rows j where j.source_table = v.source_table and j.source_id = v.source_id
       )) as orphan_vectors,
      null::bigint as unresolved_jobs,
      (select count(*)::bigint from public.semantic_embeddings
       where length(trim(content)) = 0 or length(content_hash) <> 64) as invalid_documents,
      (select greatest(count(*) - count(distinct (source_table, source_id)), 0)::bigint
       from public.semantic_embeddings) as duplicate_model_rows,
      (select count(distinct (source_table, source_id))::bigint from job_rows) as expected_entities
  ),
  alias_vectors as (
    select v.entity_type, v.source_table, v.source_id,
           (v.metadata->>'building_id')::bigint as expected_id, v.embedding, v.model
    from (
      select v.* from public.semantic_embeddings v
      where v.entity_type = 'building_alias' and v.metadata ? 'building_id'
        and v.model = (select model from latest_vector)
      order by v.source_id desc limit 10
    ) v
    union all
    select v.entity_type, v.source_table, v.source_id,
           (v.metadata->>'broker_id')::bigint as expected_id, v.embedding, v.model
    from (
      select v.* from public.semantic_embeddings v
      where v.entity_type = 'broker_alias' and v.metadata ? 'broker_id'
        and v.model = (select model from latest_vector)
      order by v.source_id desc limit 10
    ) v
  ),
  alias_ranks as (
    select a.entity_type, a.source_table, a.source_id, a.expected_id,
           c.source_id as candidate_id, c.rank
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
      'entity_type', entity_type, 'source_table', source_table, 'source_id', source_id,
      'attempts', attempts, 'last_error', left(last_error, 500), 'updated_at', updated_at
    ) as row
    from public.semantic_embedding_jobs
    where status = 'failed'
    order by updated_at desc
    limit 1
  )
  select jsonb_build_object(
    'jobs', jsonb_build_object('total', jt.total, 'pending', jt.pending, 'running', jt.running,
      'completed', jt.completed, 'failed', jt.failed, 'exhausted', jt.exhausted),
    'vectors', jsonb_build_object('total', vt.total, 'model_count', vt.model_count),
    'model', coalesce(lv.model, 'nvidia/nemotron-3-embed-1b:free'),
    'dimensions', coalesce(lv.dimensions, 1024),
    'last_completed_at', jt.last_completed_at, 'last_stored_at', vt.last_stored_at,
    'latest_failure', lf.row, 'by_entity', eb.rows,
    'quality', jsonb_build_object(
      'expected_entities', sq.expected_entities, 'indexed_entities', sq.indexed_entities,
      'coverage_pct', coalesce(round((100.0 * sq.indexed_entities / nullif(sq.expected_entities, 0))::numeric, 1), 0),
      'stale_entities', sq.stale_entities, 'orphan_vectors', sq.orphan_vectors,
      'unresolved_jobs', sq.unresolved_jobs, 'invalid_documents', sq.invalid_documents,
      'duplicate_model_rows', sq.duplicate_model_rows, 'alias_checks', aq.value
    ),
    'generated_at', now()
  )
  from job_totals jt
  cross join vector_totals vt
  left join latest_vector lv on true
  cross join entity_breakdown eb
  cross join structural_quality sq
  cross join alias_quality aq
  left join latest_failure lf on true;
$$;

revoke all on function public.get_semantic_embedding_status() from public, anon, authenticated;
grant execute on function public.get_semantic_embedding_status() to service_role;
