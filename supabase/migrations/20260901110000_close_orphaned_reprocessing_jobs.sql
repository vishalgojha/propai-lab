-- Phase 7 queue hygiene.
-- These five jobs were queued for source rows that no longer exist. Closing
-- only this exact, still-queued set prevents infinite retries without touching
-- any typed row or raw message.

update public.extraction_reprocessing_jobs
set status = 'no_source',
    last_error = 'Source row no longer exists; retry is not possible',
    result = jsonb_build_object('reason', 'source_row_missing', 'closed_by', 'phase7_queue_hygiene'),
    completed_at = now(),
    updated_at = now()
where status = 'queued'
  and source_table = 'residential_sale_listings'
  and source_row_id in (4049, 814, 4065, 20230, 4050)
  and not exists (
    select 1 from public.residential_sale_listings source_row
    where source_row.id = extraction_reprocessing_jobs.source_row_id
  );
