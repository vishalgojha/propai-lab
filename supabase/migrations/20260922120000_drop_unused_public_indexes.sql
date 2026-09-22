-- One-time disk cleanup: drop plain (non-constraint) public indexes with zero
-- scans in pg_stat_user_indexes (observability snapshot 2026-09-22). Total
-- reclaimed ~1.25 GB. Kept pending verification: idx_raw_messages_group_covering,
-- idx_raw_messages_group_activity, and all constraint-backed (_key/_pkey) indexes.
-- Every index below is a plain CREATE INDEX ... and can be recreated from git history.

drop index if exists public.semantic_embeddings_hnsw_idx;
drop index if exists public.idx_whatsapp_events_message_ids;
drop index if exists public.idx_whatsapp_events_tenant_time;
drop index if exists public.idx_raw_messages_unprocessed_timestamp_id;
drop index if exists public.idx_raw_messages_hash_processed;
drop index if exists public.idx_group_members_phone;
drop index if exists public.idx_raw_messages_hash;
drop index if exists public.idx_rm_group_name_gus;
drop index if exists public.idx_raw_messages_is_group;
drop index if exists public.idx_ai_usage_log_extraction_tenant_created;
drop index if exists public.idx_ai_usage_log_source_stage;
drop index if exists public.idx_ai_usage_log_created;