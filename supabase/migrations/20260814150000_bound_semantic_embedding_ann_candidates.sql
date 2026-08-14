-- Keep the HNSW scan bounded even when the similarity cutoff would otherwise
-- force pgvector to search for more qualifying rows.
create or replace function public.match_semantic_embeddings(
  p_query_embedding text,
  p_entity_types text[] default null,
  p_tenant_id uuid default null,
  p_limit integer default 20,
  p_min_similarity real default 0.25,
  p_model text default null
)
returns table (
  entity_type text,
  source_table text,
  source_id bigint,
  tenant_id uuid,
  similarity real,
  content text,
  metadata jsonb
)
language sql
stable
security invoker
set search_path = public, extensions, pg_temp
as $function$
  with candidates as materialized (
    select e.entity_type, e.source_table, e.source_id, e.tenant_id,
           (1 - (e.embedding <=> p_query_embedding::extensions.vector))::real as similarity,
           e.content, e.metadata
      from public.semantic_embeddings e
     where (p_entity_types is null or e.entity_type = any(p_entity_types))
       and (
         e.tenant_id is null
         or e.tenant_id = p_tenant_id
         or (
           e.entity_type in ('listing', 'requirement')
           and e.metadata->>'visibility' = 'shared_market'
         )
       )
       and (p_model is null or e.model = p_model)
     order by e.embedding <=> p_query_embedding::extensions.vector
     limit least(greatest(coalesce(p_limit, 20), 1), 100)
  )
  select entity_type, source_table, source_id, tenant_id, similarity, content, metadata
    from candidates
   where similarity >= p_min_similarity
   order by similarity desc
$function$;

revoke all on function public.match_semantic_embeddings(text,text[],uuid,integer,real,text)
  from public, anon, authenticated;
grant execute on function public.match_semantic_embeddings(text,text[],uuid,integer,real,text)
  to service_role;
