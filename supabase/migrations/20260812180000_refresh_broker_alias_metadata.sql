-- Refresh broker alias metadata so authenticated quality probes can show the
-- linked broker's full primary phone. Phone numbers remain excluded from the
-- embedded retrieval text; this only refreshes operator-facing metadata.
update public.semantic_embedding_jobs
   set status = 'pending',
       attempts = 0,
       last_error = null,
       scheduled_after = now(),
       started_at = null,
       completed_at = null,
       updated_at = now()
 where source_table = 'broker_aliases';
