-- The live safe-update guard rejects UPDATE statements without a WHERE clause.
-- The counter recompute intentionally updates every building, so make that
-- intent explicit while preserving the existing statement-level trigger.
create or replace function public.recompute_building_observed_listings()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.buildings b
     set observed_listings = (
       select count(*) from (
         select l.building_name from public.residential_sale_listings l
          where l.building_name is not null and (b.tenant_id is null or l.tenant_id=b.tenant_id) and (lower(trim(l.building_name)) = lower(trim(b.canonical_name)) or exists (select 1 from public.building_name_aliases a where a.building_id=b.id and lower(trim(a.alias))=lower(trim(l.building_name))))
         union all select l.building_name from public.residential_rent_listings l
          where l.building_name is not null and (b.tenant_id is null or l.tenant_id=b.tenant_id) and (lower(trim(l.building_name)) = lower(trim(b.canonical_name)) or exists (select 1 from public.building_name_aliases a where a.building_id=b.id and lower(trim(a.alias))=lower(trim(l.building_name))))
         union all select l.building_name from public.commercial_sale_listings l
          where l.building_name is not null and (b.tenant_id is null or l.tenant_id=b.tenant_id) and (lower(trim(l.building_name)) = lower(trim(b.canonical_name)) or exists (select 1 from public.building_name_aliases a where a.building_id=b.id and lower(trim(a.alias))=lower(trim(l.building_name))))
         union all select l.building_name from public.commercial_rent_listings l
          where l.building_name is not null and (b.tenant_id is null or l.tenant_id=b.tenant_id) and (lower(trim(l.building_name)) = lower(trim(b.canonical_name)) or exists (select 1 from public.building_name_aliases a where a.building_id=b.id and lower(trim(a.alias))=lower(trim(l.building_name))))
       ) names
     )
   where b.id is not null;
end $$;
