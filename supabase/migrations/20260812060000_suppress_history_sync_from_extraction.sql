-- WhatsMeow history sync is retained for conversation evidence, but it is
-- not a parsing input. Pairing/reconnects can otherwise enqueue a large
-- historical corpus and starve live extraction and MCP queries.
UPDATE public.raw_messages
SET processed = true,
    processed_at = COALESCE(processed_at, synced_at, NOW()),
    extraction_suppressed = true,
    pipeline_version = 'history-sync-suppressed'
WHERE processed = false
  AND lower(COALESCE(
        raw_payload->'data'->>'source',
        raw_payload->>'source',
        ''
      )) = 'history_sync';
