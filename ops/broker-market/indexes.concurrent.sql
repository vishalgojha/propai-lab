-- psql only, AUTOCOMMIT on, no BEGIN, no --single-transaction.
\set ON_ERROR_STOP on
set lock_timeout = '2s';
set statement_timeout = '15min';
-- Query support without copying text or building embeddings.
create index concurrently broker_market_source_time_idx on public.raw_messages
 (tenant_id, (split_part(event_id,':',1)), ((raw_payload #>> '{data,key,remoteJid}')), timestamp desc,id desc)
 where is_group is true and source='WHATSAPP' and pipeline_version='go-ingestor';
create index concurrently broker_market_text_fts_idx on public.raw_messages using gin (to_tsvector('english',message))
 where is_group is true and source='WHATSAPP' and pipeline_version='go-ingestor';


select indexrelid::regclass,indisvalid,indisready from pg_index where indexrelid in ('public.broker_market_source_time_idx'::regclass,'public.broker_market_text_fts_idx'::regclass);
