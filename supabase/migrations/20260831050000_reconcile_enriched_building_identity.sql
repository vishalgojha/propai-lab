-- Reconcile listings when the source message independently confirms the
-- enriched canonical building and its locality context. This is intentionally
-- evidence-based: it does not rename listings, merge opportunities, or use a
-- fuzzy name match by itself.
create or replace function public.reconcile_enriched_building_identity(
  target_building_id bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  queue_count integer := 0;
begin
  -- This is the recurring, safe entry point for the enrichment worker. It
  -- refreshes evidence for AI/operator review; relinking remains explicit and
  -- source-grounded rather than becoming a fuzzy bulk rewrite.
  perform public.refresh_building_identity_review_queue();
  select count(*) into queue_count
    from public.building_identity_review_queue q
   where q.status = 'pending'
     and (target_building_id is null or target_building_id = any(q.candidate_building_ids));
  return jsonb_build_object('pending_review_count', queue_count);
end;
$$;

-- The first production case has independent Hill Road / Bandra West evidence
-- in the source messages. Link only those rows; conflicting Dadar context and
-- malformed sale extractions remain in the review queue.
update public.residential_rent_listings l
   set building_id = 979,
       micro_market = coalesce(l.micro_market, 'Bandra West')
 where l.id in (743, 1012, 4216)
   and lower(coalesce(l.building_name, '')) like '%deepak silver%'
   and exists (
     select 1 from public.raw_messages rm
      where rm.id = l.raw_message_id
        and lower(rm.message) like '%bandra west%'
        and (lower(rm.message) like '%hill road%' or lower(rm.message) like '%mehboob studio%')
   );

select public.refresh_building_identity_review_queue();

grant execute on function public.reconcile_enriched_building_identity(bigint) to service_role;
