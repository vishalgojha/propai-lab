-- Alias enrichment is resolved by the worker from the linked canonical row;
-- requeue aliases even when only the canonical row was corrected.
update public.semantic_embedding_jobs
set status = 'pending',
    attempts = 0,
    last_error = null,
    scheduled_after = now(),
    started_at = null,
    completed_at = null,
    updated_at = now()
where entity_type in ('building_alias', 'broker_alias');
