-- The extraction worker's recent lane filters by tenant and timestamp while
-- ordering FIFO. The existing single-column indexes cannot satisfy that
-- shape efficiently on the large raw_messages queue.
-- Run outside a transaction (CREATE INDEX CONCURRENTLY requirement).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_raw_messages_pending_tenant_timestamp_id
ON public.raw_messages (tenant_id, "timestamp", id)
WHERE processed = false
  AND extraction_suppressed = false
  AND is_group = true;
