-- The original observability function performs information_schema lookups and
-- exact scans inside a loop for every public table. That is useful for a
-- forensic run but too expensive for an interactive admin page. Keep the
-- forensic function intact and expose a set-based, bounded dashboard snapshot.
create or replace function public.admin_supabase_observability_fast()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_queue jsonb := '{}'::jsonb;
  v_attempts jsonb := '{}'::jsonb;
  v_heartbeats jsonb := '[]'::jsonb;
  v_quality jsonb := '[]'::jsonb;
  v_locality jsonb := '{}'::jsonb;
begin
  perform set_config('statement_timeout', '60000', true);

  select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
    into v_queue
    from (
      select status, count(*)::bigint as n
      from public.extraction_reprocessing_jobs
      group by status
    ) q;

  select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
    into v_attempts
    from (
      select status, count(*)::bigint as n
      from public.extraction_attempt_log
      group by status
    ) q;
  v_queue := v_queue || jsonb_build_object('attempt_log', v_attempts);

  if to_regclass('public.tenant_boundary_review_queue') is not null then
    execute 'select jsonb_build_object(''tenant_boundary_pending'', count(*)) from public.tenant_boundary_review_queue where decision = ''pending'''
      into v_attempts;
    v_queue := v_queue || v_attempts;
  end if;
  if to_regclass('public.worker_heartbeats') is not null then
    execute 'select coalesce(jsonb_agg(to_jsonb(h) order by h.worker_name), ''[]''::jsonb) from public.worker_heartbeats h'
      into v_heartbeats;
    v_queue := v_queue || jsonb_build_object('heartbeats', v_heartbeats);
  end if;

  -- Exact quality signals are limited to the typed tables. This preserves
  -- source-grounding checks without repeatedly scanning the entire catalog.
  select coalesce(jsonb_agg(row_to_json(q)::jsonb order by q.table_name), '[]'::jsonb)
    into v_quality
    from (
      select 'residential_sale_listings'::text as table_name,
        (select count(*) from public.residential_sale_listings x where x.raw_message_id is not null and not exists (select 1 from public.raw_messages r where r.id=x.raw_message_id)) as missing_source_rows,
        (select count(*) from (select tenant_id, raw_message_id from public.residential_sale_listings where raw_message_id is not null group by tenant_id, raw_message_id having count(*) > 1) d) as duplicate_key_groups,
        (select count(*) from public.residential_sale_listings where needs_review is true) as needs_review,
        (select count(*) from public.residential_sale_listings where duplicate_status = 'flagged') as duplicate_flagged
      union all select 'residential_rent_listings',
        (select count(*) from public.residential_rent_listings x where x.raw_message_id is not null and not exists (select 1 from public.raw_messages r where r.id=x.raw_message_id)),
        (select count(*) from (select tenant_id, raw_message_id from public.residential_rent_listings where raw_message_id is not null group by tenant_id, raw_message_id having count(*) > 1) d),
        (select count(*) from public.residential_rent_listings where needs_review is true),
        (select count(*) from public.residential_rent_listings where duplicate_status = 'flagged')
      union all select 'commercial_sale_listings',
        (select count(*) from public.commercial_sale_listings x where x.raw_message_id is not null and not exists (select 1 from public.raw_messages r where r.id=x.raw_message_id)),
        (select count(*) from (select tenant_id, raw_message_id from public.commercial_sale_listings where raw_message_id is not null group by tenant_id, raw_message_id having count(*) > 1) d),
        (select count(*) from public.commercial_sale_listings where needs_review is true),
        (select count(*) from public.commercial_sale_listings where duplicate_status = 'flagged')
      union all select 'commercial_rent_listings',
        (select count(*) from public.commercial_rent_listings x where x.raw_message_id is not null and not exists (select 1 from public.raw_messages r where r.id=x.raw_message_id)),
        (select count(*) from (select tenant_id, raw_message_id from public.commercial_rent_listings where raw_message_id is not null group by tenant_id, raw_message_id having count(*) > 1) d),
        (select count(*) from public.commercial_rent_listings where needs_review is true),
        (select count(*) from public.commercial_rent_listings where duplicate_status = 'flagged')
    ) q;

  select jsonb_build_object(
    'resolved_rows', 0, 'total_rows', 0, 'rate_pct', null,
    'listing_label_rows', null, 'listing_canonical_rows', null,
    'listing_total_rows', null, 'listing_label_rate_pct', null,
    'listing_canonical_rate_pct', null
  ) into v_locality;

  return jsonb_build_object(
    'generated_at', clock_timestamp(),
    'tables', coalesce((select jsonb_agg(jsonb_build_object(
      'name', c.relname,
      'group_name', case
        when c.relname in ('listings_legacy', 'parsed_output_legacy', 'market_requirements_legacy') then 'legacy'
        when c.relname ~ '(listing|requirement|observation)' then 'extraction / typed listings'
        when c.relname ~ '(whatsapp|raw_message|conversation|waba|group|sync|event)' then 'WhatsApp ingestion'
        when c.relname ~ '(broker|client|crm|deal|organization|member|profile)' then 'broker / CRM'
        when c.relname ~ '(embedding|semantic|vector|retrieval)' then 'embeddings / semantic'
        when c.relname ~ '(job|queue|attempt|repair|enrichment|heartbeat|outbox)' then 'jobs / queues'
        when c.relname ~ '(auth|permission|role|tenant)' then 'auth / org'
        else 'other' end,
      'row_count', greatest(c.reltuples, 0)::bigint,
      'rls_enabled', c.relrowsecurity,
      'policy_count', (select count(*) from pg_policy p where p.polrelid = c.oid),
      'last_analyzed_at', coalesce(s.last_autoanalyze, s.last_analyze),
      'approximate_size_bytes', pg_total_relation_size(c.oid),
      'is_legacy', c.relname in ('listings_legacy', 'parsed_output_legacy', 'market_requirements_legacy')
    ) order by c.relname), '[]'::jsonb) from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_stat_all_tables s on s.relid = c.oid
    where n.nspname = 'public' and c.relkind in ('r', 'p')), '[]'::jsonb),
    'rls_zero_policy', coalesce((select jsonb_agg(jsonb_build_object('name', c.relname, 'row_count', greatest(c.reltuples, 0)::bigint) order by c.relname)
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in ('r','p') and c.relrowsecurity and not exists (select 1 from pg_policy p where p.polrelid=c.oid)), '[]'::jsonb),
    'functions', coalesce((select jsonb_agg(jsonb_build_object('name', p.proname, 'arguments', pg_get_function_identity_arguments(p.oid), 'security_definer', p.prosecdef, 'anon_execute', has_function_privilege('anon', p.oid, 'execute'), 'authenticated_execute', has_function_privilege('authenticated', p.oid, 'execute'), 'service_role_execute', has_function_privilege('service_role', p.oid, 'execute'), 'should_be_public', false) order by p.proname, p.oid)
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f'), '[]'::jsonb),
    'queues', v_queue,
    'quality', v_quality,
    'locality_resolution', v_locality,
    'indexes', jsonb_build_object(
      'unused', coalesce((select jsonb_agg(jsonb_build_object('table_name', relname, 'index_name', indexrelname, 'scans', idx_scan, 'size_bytes', pg_relation_size(indexrelid)) order by pg_relation_size(indexrelid) desc) from pg_stat_user_indexes where idx_scan=0 and indexrelname not like '%_pkey'), '[]'::jsonb),
      'duplicate', '[]'::jsonb,
      'missing_fk_indexes', '[]'::jsonb
    )
  );
end;
$$;

revoke all on function public.admin_supabase_observability_fast() from public, anon, authenticated;
grant execute on function public.admin_supabase_observability_fast() to service_role;
