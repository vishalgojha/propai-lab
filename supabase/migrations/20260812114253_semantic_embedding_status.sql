create or replace function public.get_semantic_embedding_status()
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with job_totals as (
    select
      count(*)::bigint as total,
      count(*) filter (where status = 'pending')::bigint as pending,
      count(*) filter (where status = 'running')::bigint as running,
      count(*) filter (where status = 'completed')::bigint as completed,
      count(*) filter (where status = 'failed')::bigint as failed,
      count(*) filter (
        where status = 'failed' and attempts >= 5
      )::bigint as exhausted,
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
    select entity_type, count(*)::bigint as embedded
    from public.semantic_embeddings
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
  ),
  latest_vector as (
    select model, dimensions
    from public.semantic_embeddings
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
    'generated_at', now()
  )
  from job_totals jt
  cross join vector_totals vt
  cross join entity_breakdown eb
  left join latest_failure lf on true
  left join latest_vector lv on true;
$$;

revoke all on function public.get_semantic_embedding_status()
  from public, anon, authenticated;
grant execute on function public.get_semantic_embedding_status()
  to service_role;
