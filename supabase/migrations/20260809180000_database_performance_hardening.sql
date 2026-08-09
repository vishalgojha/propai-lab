-- Database performance hardening.
--
-- This migration only removes indexes that are unused or superseded by a
-- newer, heavily-used index.  The low-scan group/hash indexes are retained:
-- pg_stat_user_indexes shows they still serve real reads, so dropping them
-- would trade write relief for slower group/hash lookups.

create extension if not exists pg_trgm;

-- raw_messages: remove dead write amplification and the redundant partial
-- message_uid index. The unique index is the active constraint and is used
-- heavily by ingestion deduplication.
drop index if exists public.idx_raw_messages_fts;
drop index if exists public.idx_raw_messages_event_id;
drop index if exists public.idx_raw_messages_extraction_queue;
drop index if exists public.idx_raw_messages_sender_phone_backfill;
drop index if exists public.idx_raw_messages_group_no_gus;
drop index if exists public.idx_raw_messages_message_uid;

-- ILIKE '%...%' cannot use the existing B-tree locality indexes. These
-- indexes support the shared market/search paths without changing their
-- source-of-truth typed tables.
create index if not exists idx_res_sale_micro_market_trgm
  on public.residential_sale_listings using gin (micro_market gin_trgm_ops);
create index if not exists idx_res_sale_locality_raw_trgm
  on public.residential_sale_listings using gin (locality_raw gin_trgm_ops);
create index if not exists idx_res_sale_building_name_trgm
  on public.residential_sale_listings using gin (building_name gin_trgm_ops);

create index if not exists idx_res_rent_micro_market_trgm
  on public.residential_rent_listings using gin (micro_market gin_trgm_ops);
create index if not exists idx_res_rent_locality_raw_trgm
  on public.residential_rent_listings using gin (locality_raw gin_trgm_ops);
create index if not exists idx_res_rent_building_name_trgm
  on public.residential_rent_listings using gin (building_name gin_trgm_ops);

create index if not exists idx_com_sale_micro_market_trgm
  on public.commercial_sale_listings using gin (micro_market gin_trgm_ops);
create index if not exists idx_com_sale_locality_raw_trgm
  on public.commercial_sale_listings using gin (locality_raw gin_trgm_ops);
create index if not exists idx_com_sale_building_name_trgm
  on public.commercial_sale_listings using gin (building_name gin_trgm_ops);

create index if not exists idx_com_rent_micro_market_trgm
  on public.commercial_rent_listings using gin (micro_market gin_trgm_ops);
create index if not exists idx_com_rent_locality_raw_trgm
  on public.commercial_rent_listings using gin (locality_raw gin_trgm_ops);
create index if not exists idx_com_rent_building_name_trgm
  on public.commercial_rent_listings using gin (building_name gin_trgm_ops);

-- The previous index was on lower(coalesce(canonical_name, '')), which does
-- not match the PostgREST ILIKE predicate. Replace it with a direct trigram
-- index that PostgreSQL can use for the actual query shape.
drop index if exists public.idx_buildings_canonical_name_trgm;
create index if not exists idx_buildings_canonical_name_trgm
  on public.buildings using gin (canonical_name gin_trgm_ops);
create index if not exists idx_building_name_aliases_alias_trgm
  on public.building_name_aliases using gin (alias gin_trgm_ops);

-- Webhook delivery attempts are operational data, not business evidence.
-- Keep the cleanup in a function so it can be scheduled safely and rerun.
create or replace function public.cleanup_whatsapp_webhook_outbox(
  p_retention interval default interval '7 days'
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count bigint;
begin
  delete from public.whatsapp_webhook_outbox
   where next_attempt_at < now() - p_retention;
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.cleanup_whatsapp_webhook_outbox(interval) from public;
grant execute on function public.cleanup_whatsapp_webhook_outbox(interval) to service_role;

-- Apply the retention policy immediately for the known stale backlog.
select public.cleanup_whatsapp_webhook_outbox(interval '7 days');

-- Supabase projects with pg_cron installed get the recurring job. On
-- projects without it, the function remains available for an external
-- scheduler; the guarded block deliberately keeps the migration portable.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      execute $cron$select cron.schedule(
        'propai-whatsapp-webhook-outbox-retention',
        '15 * * * *',
        'select public.cleanup_whatsapp_webhook_outbox(interval ''7 days'')'
      )$cron$;
    exception when others then
      -- Existing job or unavailable cron permissions must not invalidate the
      -- schema/index portion of this migration.
      null;
    end;
  end if;
end;
$$;

-- Historical archives remain intentionally queryable until the compatibility
-- bridge and agent_tools runtime reference are removed in a separate change.
comment on table public.parsed_output_legacy is
  'Historical archive only. New application code must not read or write this table; drop after compatibility bridge removal.';
comment on table public.listings_legacy is
  'Historical archive only. New application code must not read or write this table; drop after compatibility bridge removal.';
comment on table public.market_requirements_legacy is
  'Historical archive only. New application code must not read or write this table; drop after compatibility bridge removal.';
