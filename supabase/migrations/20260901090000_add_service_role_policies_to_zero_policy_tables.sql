-- Phase 3 security hardening.
-- These tables already have RLS enabled and no policies, which denies all
-- PostgREST client roles but leaves the boundary implicit. Make the intended
-- server-only boundary explicit without granting anon/authenticated access.

do $$
declare
  table_name text;
  service_only_tables constant text[] := array[
    'ai_correction_runs',
    'broker_whatsapp_device_history',
    'broker_whatsapp_devices',
    'building_identity_review_queue',
    'cleanup_audit_log',
    'data_quality_backfill_runs',
    'developer_project_crawl_runs',
    'extraction_attempt_log',
    'extraction_backfill_audit',
    'extraction_cache',
    'extraction_learning_examples',
    'extraction_repair_jobs',
    'extraction_reprocessing_jobs',
    'extraction_reprocessing_runs',
    'group_members',
    'internal_notes',
    'llm_routing_log',
    'locality_assignment_repair_audit',
    'locality_reference',
    'mcp_data_quality_events',
    'mcp_oauth_clients',
    'mcp_oauth_codes',
    'org_whatsapp_connections',
    'org_whatsapp_phone_directory',
    'organization_members',
    'organizations',
    'role_permissions',
    'roles',
    'semantic_embedding_jobs',
    'semantic_embeddings',
    'semantic_retrieval_eval_cases',
    'semantic_retrieval_eval_runs',
    'social_flow_meta_mcp_connections',
    'social_flow_meta_mcp_oauth_states',
    'super_admins',
    'sync_jobs',
    'tenant_boundary_review_queue',
    'waba_sessions',
    'web_analytics',
    'webhook_outbox_archive',
    'whatsapp_events',
    'whatsapp_webhook_outbox',
    'whatsmeow_app_state_mutation_macs',
    'whatsmeow_app_state_sync_keys',
    'whatsmeow_app_state_version',
    'whatsmeow_chat_settings',
    'whatsmeow_contacts',
    'whatsmeow_device',
    'whatsmeow_event_buffer',
    'whatsmeow_identity_keys',
    'whatsmeow_lid_map',
    'whatsmeow_message_secrets',
    'whatsmeow_nct_salt',
    'whatsmeow_pre_keys',
    'whatsmeow_privacy_tokens',
    'whatsmeow_retry_buffer',
    'whatsmeow_sender_keys',
    'whatsmeow_sessions',
    'whatsmeow_version',
    'worker_heartbeats'
  ];
begin
  foreach table_name in array service_only_tables loop
    if to_regclass(format('public.%I', table_name)) is null then
      continue;
    end if;

    execute format('alter table public.%I enable row level security', table_name);

    if not exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename = table_name
        and policyname = format('service_role_all_%s', table_name)
    ) then
      execute format(
        'create policy %I on public.%I for all to service_role using (true) with check (true)',
        format('service_role_all_%s', table_name), table_name
      );
    end if;
  end loop;
end $$;
