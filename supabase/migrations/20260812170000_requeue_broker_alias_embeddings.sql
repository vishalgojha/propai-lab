-- Broker alias documents now include their linked canonical broker name.
-- Re-run the existing alias jobs so stored vectors contain the improved text.
update public.semantic_embedding_jobs
   set status = 'pending',
       attempts = 0,
       last_error = null,
       scheduled_after = now(),
       started_at = null,
       completed_at = null,
       updated_at = now()
 where source_table = 'broker_aliases';
