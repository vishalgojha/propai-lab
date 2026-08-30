-- Keep anonymous execution limited to the public read RPCs used by www.
-- Internal helpers, trigger functions, maintenance functions, and dashboard
-- RPCs must not inherit execute through PUBLIC.
do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure::text as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and has_function_privilege('anon', p.oid, 'execute')
      and not (
        (p.proname = 'get_public_counts' and pg_get_function_identity_arguments(p.oid) = '')
        or (p.proname = 'get_locality_counts' and pg_get_function_identity_arguments(p.oid) = '')
        or (p.proname = 'get_locality_summary' and pg_get_function_identity_arguments(p.oid) = 'p_slug text')
      )
  loop
    execute format('revoke execute on function %s from public, anon', fn.signature);
  end loop;
end
$$;

grant execute on function public.get_public_counts() to anon;
grant execute on function public.get_locality_counts() to anon;
grant execute on function public.get_locality_summary(text) to anon;
