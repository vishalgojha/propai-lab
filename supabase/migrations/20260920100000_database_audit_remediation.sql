-- Database deep-audit remediation (2026-09-20).
-- P0 security + P1 performance fixes from the Supabase advisory run.

-- ---------------------------------------------------------------------------
-- P0-1: RLS policies so no table is "RLS enabled with no policies".
--       These tables are service-role/backend-only; keep anon + authenticated
--       locked out (matching repo convention "service_role_all_<table>").
-- ---------------------------------------------------------------------------
create policy "service_role_all_chariot_leads"
  on public.chariot_leads for all to service_role using (true) with check (true);

create policy "service_role_all_listing_reports"
  on public.listing_reports for all to service_role using (true) with check (true);

-- ---------------------------------------------------------------------------
-- P0-2: Fix mutable search_path on worker evidence function.
--       (Uses pg_catalog built-ins + schema-qualified public references.)
-- ---------------------------------------------------------------------------
alter function public.get_building_enrichment_worker_evidence()
  set search_path to 'pg_catalog', 'public';

-- ---------------------------------------------------------------------------
-- P1-1: Re-write policies that call auth.*() per row (auth_rls_initplan).
--       Wrap auth.uid() / auth.role() in a subselect so the planner can use
--       an initplan instead of re-evaluating for every row.
-- ---------------------------------------------------------------------------
drop policy if exists "super_admin read" on public.provider_outage_log;
create policy "super_admin read"
  on public.provider_outage_log for select to public
  using (
    exists (
      select 1 from public.super_admins sa
      where sa.user_id = (select auth.uid())
    )
  );

drop policy if exists "organization members can read social flow meta settings"
  on public.social_flow_meta_settings;
create policy "organization members can read social flow meta settings"
  on public.social_flow_meta_settings for select to authenticated
  using (
    exists (
      select 1 from public.organization_members member
      where member.organization_id = social_flow_meta_settings.tenant_id
        and member.user_id = (select auth.uid())
        and member.is_active = true
    )
  );

drop policy if exists "entity_enrichment_cache_service_only" on public.entity_enrichment_cache;
create policy "entity_enrichment_cache_service_only"
  on public.entity_enrichment_cache for all to public
  using ((select auth.role()) = 'service_role'::text)
  with check ((select auth.role()) = 'service_role'::text);

drop policy if exists "operations_agent_memory_owner" on public.operations_agent_memory;
create policy "operations_agent_memory_owner"
  on public.operations_agent_memory for all to public
  using (
    is_super_admin()
    or (tenant_id in (select user_tenant_ids()) and user_id = (select auth.uid()))
  )
  with check (
    is_super_admin()
    or (tenant_id in (select user_tenant_ids()) and user_id = (select auth.uid()))
  );

drop policy if exists "operations_agent_tasks_owner" on public.operations_agent_tasks;
create policy "operations_agent_tasks_owner"
  on public.operations_agent_tasks for all to public
  using (
    is_super_admin()
    or (tenant_id in (select user_tenant_ids()) and user_id = (select auth.uid()))
  )
  with check (
    is_super_admin()
    or (tenant_id in (select user_tenant_ids()) and user_id = (select auth.uid()))
  );

drop policy if exists "operations_agent_sessions_owner" on public.operations_agent_sessions;
create policy "operations_agent_sessions_owner"
  on public.operations_agent_sessions for all to public
  using (
    is_super_admin()
    or (tenant_id in (select user_tenant_ids()) and user_id = (select auth.uid()))
  )
  with check (
    is_super_admin()
    or (tenant_id in (select user_tenant_ids()) and user_id = (select auth.uid()))
  );

drop policy if exists "operations_agent_runs_owner" on public.operations_agent_runs;
create policy "operations_agent_runs_owner"
  on public.operations_agent_runs for all to public
  using (
    is_super_admin()
    or (tenant_id in (select user_tenant_ids()) and user_id = (select auth.uid()))
  )
  with check (
    is_super_admin()
    or (tenant_id in (select user_tenant_ids()) and user_id = (select auth.uid()))
  );

drop policy if exists "operations_agent_messages_owner" on public.operations_agent_messages;
create policy "operations_agent_messages_owner"
  on public.operations_agent_messages for all to public
  using (
    is_super_admin()
    or (
      tenant_id in (select user_tenant_ids())
      and exists (
        select 1 from public.operations_agent_sessions s
        where s.id = operations_agent_messages.session_id
          and s.user_id = (select auth.uid())
      )
    )
  )
  with check (
    is_super_admin()
    or (
      tenant_id in (select user_tenant_ids())
      and exists (
        select 1 from public.operations_agent_sessions s
        where s.id = operations_agent_messages.session_id
          and s.user_id = (select auth.uid())
      )
    )
  );

-- ---------------------------------------------------------------------------
-- P1-2: Drop unused indexes on legacy, effectively-empty tables.
--       (parsed_output_legacy / listings_legacy are superseded; the typed
--       extract_cards_* tables are the live write path. semantic_embeddings
--       HNSW index is intentionally KEPT: match_semantic_embeddings() orders
--       by <=> so it is load-bearing for the retrieval evals.)
-- ---------------------------------------------------------------------------
drop index if exists idx_parsed_raw_group_broker;
drop index if exists idx_parsed_output_ai_extraction_source;
drop index if exists idx_parsed_output_ai_needs_review;
drop index if exists idx_parsed_output_broker_id;
drop index if exists idx_parsed_output_tenant_created_id;
drop index if exists idx_parsed_broker_feed_covering;
drop index if exists idx_parsed_output_group_name;
drop index if exists idx_parsed_normalized_message;
drop index if exists idx_parsed_output_micro_market_trgm;
drop index if exists idx_parsed_output_building_name_trgm;
drop index if exists idx_parsed_output_area_trgm;
drop index if exists idx_parsed_micro_market;
drop index if exists idx_parsed_building_name;
drop index if exists idx_parsed_broker_phone;
drop index if exists idx_parsed_intent;
drop index if exists idx_parsed_created_at;
drop index if exists idx_parsed_principal;
drop index if exists idx_parsed_output_tenant;
drop index if exists idx_parsed_output_uncorrected_confidence;
drop index if exists idx_parsed_output_correction_hash;
drop index if exists idx_parsed_output_uncorrected_partial;
drop index if exists idx_parsed_asset_type;
drop index if exists idx_parsed_property_type;
drop index if exists idx_parsed_transaction_type;
drop index if exists idx_parsed_output_legacy_broker_id;

drop index if exists idx_listings_deal_tags;
drop index if exists idx_listings_building_name_trgm;
drop index if exists idx_listings_micro_market_trgm;
drop index if exists idx_listings_location_label_trgm;
drop index if exists idx_listings_landmark_name_trgm;
drop index if exists idx_listings_micro_market;
drop index if exists idx_listings_building_name;
drop index if exists idx_listings_price_model;
drop index if exists idx_listings_canonical_micro_market_slug;
drop index if exists idx_listings_broker_phone;
drop index if exists idx_listings_intent;
drop index if exists idx_listings_bhk;
drop index if exists idx_listings_last_seen;
drop index if exists idx_listings_created_at;
drop index if exists idx_listings_tenant;
drop index if exists idx_listings_asset_type;
drop index if exists idx_listings_property_type;
drop index if exists idx_listings_rep_pair;
drop index if exists idx_listings_latest_raw_message_id;
drop index if exists idx_listings_fingerprint;

-- ---------------------------------------------------------------------------
-- P1-3: Cover the FKs the linter flagged as unindexed.
-- ---------------------------------------------------------------------------
create index if not exists google_drive_exports_connection_id_idx
  on public.google_drive_exports (connection_id);
create index if not exists google_drive_oauth_states_tenant_id_idx
  on public.google_drive_oauth_states (tenant_id);
create index if not exists google_drive_sync_jobs_tenant_id_idx
  on public.google_drive_sync_jobs (tenant_id);
create index if not exists match_buckets_client_id_idx
  on public.match_buckets (client_id);
create index if not exists matching_item_approvals_client_id_idx
  on public.matching_item_approvals (client_id);
create index if not exists operations_agent_runs_session_id_idx
  on public.operations_agent_runs (session_id);
create index if not exists operations_agent_runs_user_id_idx
  on public.operations_agent_runs (user_id);
create index if not exists shared_extraction_claims_first_raw_message_id_idx
  on public.shared_extraction_claims (first_raw_message_id);
create index if not exists shared_extraction_claims_tenant_id_idx
  on public.shared_extraction_claims (tenant_id);
create index if not exists workspace_hidden_deals_hidden_by_idx
  on public.workspace_hidden_deals (hidden_by);