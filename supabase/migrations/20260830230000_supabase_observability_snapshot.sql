-- Read-only platform observability snapshot for the super-admin dashboard.
-- The function is intentionally service-role-only: it exposes catalog metadata
-- and exact counts that must never be available to anon/authenticated clients.
create or replace function public.admin_supabase_observability()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  t record;
  f record;
  v_count bigint;
  v_policies integer;
  v_resolved bigint := 0;
  v_locality_resolved bigint := 0;
  v_locality_total bigint := 0;
  v_table_metrics jsonb := '[]'::jsonb;
  v_zero_policy jsonb := '[]'::jsonb;
  v_functions jsonb := '[]'::jsonb;
  v_quality jsonb := '[]'::jsonb;
  v_tables jsonb := '[]'::jsonb;
  v_queue jsonb := '{}'::jsonb;
  v_fragment jsonb := '{}'::jsonb;
  v_indexes jsonb := '{}'::jsonb;
  v_group text;
  v_legacy boolean;
  v_has_raw boolean;
  v_has_locality boolean;
  v_has_review boolean;
  v_has_duplicate boolean;
  v_locality_expr text;
  v_missing_source bigint := 0;
  v_duplicate_keys bigint := 0;
  v_needs_review bigint := 0;
  v_flagged bigint := 0;
begin
  -- Keep the request path bounded. reltuples is the catalog's live estimate;
  -- the quality and locality signals below still use exact counts where they
  -- affect an operator decision.
  for t in
    select c.oid, c.relname, c.relrowsecurity, greatest(c.reltuples, 0)::bigint as estimated_rows,
           pg_total_relation_size(c.oid) as bytes,
           st.last_analyze, st.last_autoanalyze
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_stat_all_tables st on st.relid = c.oid
     where n.nspname = 'public' and c.relkind in ('r', 'p')
     order by c.relname
  loop
    v_count := t.estimated_rows;
    select count(*)::integer into v_policies from pg_policy where polrelid = t.oid;
    v_legacy := t.relname in ('listings_legacy', 'parsed_output_legacy', 'market_requirements_legacy');
    v_group := case
      when v_legacy then 'legacy'
      when t.relname ~ '(listing|requirement|observation)' then 'extraction / typed listings'
      when t.relname ~ '(whatsapp|raw_message|conversation|waba|group|sync|event)' then 'WhatsApp ingestion'
      when t.relname ~ '(broker|client|crm|deal|organization|member|profile)' then 'broker / CRM'
      when t.relname ~ '(embedding|semantic|vector|retrieval)' then 'embeddings / semantic'
      when t.relname ~ '(job|queue|attempt|repair|enrichment|heartbeat|outbox)' then 'jobs / queues'
      when t.relname ~ '(auth|permission|role|tenant)' then 'auth / org'
      else 'other'
    end;
    v_tables := v_tables || jsonb_build_array(jsonb_build_object(
      'name', t.relname,
      'group_name', v_group,
      'row_count', v_count,
      'rls_enabled', t.relrowsecurity,
      'policy_count', v_policies,
      'last_analyzed_at', coalesce(t.last_autoanalyze, t.last_analyze),
      'approximate_size_bytes', t.bytes,
      'is_legacy', v_legacy
    ));
    if t.relrowsecurity and v_policies = 0 then
      v_zero_policy := v_zero_policy || jsonb_build_array(jsonb_build_object('name', t.relname, 'row_count', v_count));
    end if;

    select exists(select 1 from information_schema.columns where table_schema='public' and table_name=t.relname and column_name='raw_message_id') into v_has_raw;
    select exists(select 1 from information_schema.columns where table_schema='public' and table_name=t.relname and column_name in ('locality_resolved','micro_market')) into v_has_locality;
    select exists(select 1 from information_schema.columns where table_schema='public' and table_name=t.relname and column_name='needs_review') into v_has_review;
    select exists(select 1 from information_schema.columns where table_schema='public' and table_name=t.relname and column_name='duplicate_status') into v_has_duplicate;
    if t.relname ~ '(listings|requirements)$' and v_has_raw then
      execute format('select count(*) from public.%I x where x.raw_message_id is not null and not exists (select 1 from public.raw_messages r where r.id=x.raw_message_id)', t.relname) into v_missing_source;
      execute format('select count(*) from (select tenant_id, raw_message_id from public.%I where raw_message_id is not null group by tenant_id, raw_message_id having count(*) > 1) d', t.relname) into v_duplicate_keys;
      if v_has_review then execute format('select count(*) from public.%I where needs_review is true', t.relname) into v_needs_review; else v_needs_review := 0; end if;
      if v_has_duplicate then execute format('select count(*) from public.%I where duplicate_status = ''flagged''', t.relname) into v_flagged; else v_flagged := 0; end if;
      v_quality := v_quality || jsonb_build_array(jsonb_build_object('table_name',t.relname,'missing_source_rows',v_missing_source,'duplicate_key_groups',v_duplicate_keys,'needs_review',v_needs_review,'duplicate_flagged',v_flagged));
    end if;
    if v_has_locality and t.relname ~ '(listings|requirements)$' then
      select case when exists(select 1 from information_schema.columns where table_schema='public' and table_name=t.relname and column_name='locality_resolved') then 'locality_resolved' else 'micro_market' end into v_locality_expr;
      execute format('select count(*) from public.%I where nullif(btrim(coalesce(%s, '''')), '''') is not null', t.relname, v_locality_expr) into v_resolved;
      execute format('select count(*) from public.%I', t.relname) into v_count;
      v_locality_resolved := v_locality_resolved + v_resolved;
      v_locality_total := v_locality_total + v_count;
      -- v_resolved is added to the total through a JSON-safe scalar below.
      v_quality := v_quality || jsonb_build_array(jsonb_build_object('table_name',t.relname,'locality_resolved_rows',v_resolved,'locality_total_rows',v_count));
    end if;
  end loop;

  for f in
    select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as args,
           p.prosecdef, has_function_privilege('anon', p.oid, 'execute') as anon_execute,
           has_function_privilege('authenticated', p.oid, 'execute') as authenticated_execute,
           has_function_privilege('service_role', p.oid, 'execute') as service_role_execute
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.prokind='f'
     order by p.proname, args
  loop
    v_functions := v_functions || jsonb_build_array(jsonb_build_object(
      'name', f.proname, 'arguments', f.args, 'security_definer', f.prosecdef,
      'anon_execute', f.anon_execute, 'authenticated_execute', f.authenticated_execute,
      'service_role_execute', f.service_role_execute,
      'should_be_public', case when f.prosecdef and (f.anon_execute or f.authenticated_execute) then true else false end
    ));
  end loop;

  if to_regclass('public.extraction_reprocessing_jobs') is not null then
    execute 'select coalesce(jsonb_object_agg(status, n), ''{}''::jsonb) from (select status, count(*) n from public.extraction_reprocessing_jobs group by status) x' into v_queue;
  end if;
  if to_regclass('public.extraction_attempt_log') is not null then
    execute 'select coalesce((select jsonb_object_agg(status,n) from (select status,count(*) n from public.extraction_attempt_log group by status) x), ''{}''::jsonb)' into v_fragment;
    v_queue := v_queue || jsonb_build_object('attempt_log', v_fragment);
  end if;
  if to_regclass('public.tenant_boundary_review_queue') is not null then
    execute 'select count(*) from public.tenant_boundary_review_queue where decision = ''pending''' into v_count;
    v_queue := v_queue || jsonb_build_object('tenant_boundary_pending', v_count);
  end if;
  if to_regclass('public.worker_heartbeats') is not null then
    execute 'select coalesce((select jsonb_agg(to_jsonb(h) order by h.worker_name) from public.worker_heartbeats h), ''[]''::jsonb)' into v_fragment;
    v_queue := v_queue || jsonb_build_object('heartbeats', v_fragment);
  end if;

  execute $sql$
    select jsonb_build_object(
      'unused', coalesce((select jsonb_agg(jsonb_build_object('table_name',relname,'index_name',indexrelname,'scans',idx_scan,'size_bytes',pg_relation_size(indexrelid)) order by pg_relation_size(indexrelid) desc) from pg_stat_user_indexes where idx_scan=0 and indexrelname not like '%_pkey'), '[]'::jsonb),
      'duplicate', coalesce((select jsonb_agg(x) from (select min(indexrelname) as index_name, relname, pg_get_indexdef(min(indexrelid)) as definition, count(*) as duplicate_count from pg_stat_user_indexes group by relname, pg_get_indexdef(indexrelid) having count(*) > 1) x), '[]'::jsonb),
      'missing_fk_indexes', coalesce((select jsonb_agg(jsonb_build_object('table_name',relname,'column_name',attname,'constraint_name',conname)) from (select distinct c.relname, a.attname, con.conname from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_attribute a on a.attrelid=c.oid and a.attnum=any(con.conkey) where con.contype='f' and not exists (select 1 from pg_index i where i.indrelid=c.oid and a.attnum=any(i.indkey))) x), '[]'::jsonb)
    )
  $sql$ into v_indexes;

  return jsonb_build_object(
    'generated_at', clock_timestamp(),
    'tables', v_tables,
    'rls_zero_policy', v_zero_policy,
    'functions', v_functions,
    'queues', v_queue,
    'quality', v_quality,
    'locality_resolution', jsonb_build_object('resolved_rows', v_locality_resolved, 'total_rows', v_locality_total, 'rate_pct', case when v_locality_total=0 then null else round((v_locality_resolved::numeric / v_locality_total::numeric)*100,2) end),
    'indexes', v_indexes
  );
end;
$$;

revoke all on function public.admin_supabase_observability() from public, anon, authenticated;
grant execute on function public.admin_supabase_observability() to service_role;
