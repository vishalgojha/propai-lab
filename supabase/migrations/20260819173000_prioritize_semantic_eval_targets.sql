-- Golden retrieval cases must not wait behind the unbounded historical
-- embedding backfill. Priority is an operational queue hint only; it does
-- not change entity visibility or retrieval ranking.
alter table public.semantic_embedding_jobs
  add column if not exists priority integer not null default 0;

update public.semantic_embedding_jobs j
set priority = greatest(j.priority, 100),
    updated_at = now()
from public.semantic_retrieval_eval_cases c
where c.active = true
  and j.source_table = c.target_source_table
  and j.source_id = c.target_source_id;
