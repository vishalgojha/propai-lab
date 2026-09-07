-- Match the extraction worker's tenant-scoped FIFO queue read.
--
-- The worker filters on the partial queue predicates, then narrows by
-- tenant_id and timestamp before ordering by timestamp and id. The existing
-- tenant+id index supports the historical FIFO, while the global timestamp
-- index does not avoid scanning other tenants for the recent lane.
create index if not exists idx_raw_messages_pending_tenant_timestamp_id
  on public.raw_messages (tenant_id, "timestamp", id)
  where processed = false
    and extraction_suppressed = false
    and is_group = true;
