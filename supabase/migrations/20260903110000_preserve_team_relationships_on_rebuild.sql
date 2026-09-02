-- Rebuilds must be repeatable without deleting confirmed team relationships or
-- their raw-message evidence. The earlier repair migration used a destructive
-- delete because the tables were initially derived-only; membership is now an
-- operator-reviewed relationship and must survive a refresh.
do $$
declare
  fn_definition text;
begin
  select pg_get_functiondef(p.oid)
    into fn_definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'rebuild_broker_team_intelligence'
    and p.proargtypes = ''::oidvector;

  if fn_definition is null then
    return;
  end if;

  fn_definition := replace(
    fn_definition,
    '    delete from public.broker_teams;',
    '    -- Preserve existing teams, evidence, and operator-reviewed members.'
  );

  if position('on conflict (tenant_id, normalized_name)' in lower(fn_definition)) = 0 then
    fn_definition := replace(
      fn_definition,
      '    group by tenant_id, normalized_name;',
      '    group by tenant_id, normalized_name
    on conflict (tenant_id, normalized_name) do update
      set canonical_name = excluded.canonical_name,
          confidence = greatest(public.broker_teams.confidence, excluded.confidence),
          updated_at = now();'
    );
  end if;

  execute fn_definition;
end $$;

revoke all on function public.rebuild_broker_team_intelligence() from public, anon, authenticated;
grant execute on function public.rebuild_broker_team_intelligence() to service_role;
