-- The extraction worker's fast lane filters pending rows by message time.
-- Keep this partial index scoped to the queue so the query does not scan the
-- entire raw_messages table while the historical backlog is large.
CREATE INDEX IF NOT EXISTS idx_raw_messages_unprocessed_timestamp_id
  ON public.raw_messages ("timestamp" ASC, id ASC)
  WHERE processed = false;
