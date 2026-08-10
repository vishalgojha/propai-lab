-- Do not attach a street to an unrelated Bandra sub-locality merely because
-- its parent is Bandra West. Preserve those source values as ambiguous.
update public.locality_reference
   set alternate_names = array_remove(array_remove(
       coalesce(alternate_names, array[]::text[]),
       'Bandra (16th Road)'),
       'Pali Mala Road, Bandra'),
       updated_at = now()
 where id = 15;

do $$
declare
  t text;
begin
  foreach t in array array[
    'residential_sale_listings', 'residential_rent_listings',
    'commercial_sale_listings', 'commercial_rent_listings'
  ] loop
    execute format($sql$
      update public.%I l
         set locality_id = null,
             locality_match_status = 'ambiguous'
       where upper(btrim(coalesce(l.locality_resolved, ''))) in
             ('BANDRA (16TH ROAD)', 'PALI MALA ROAD, BANDRA')
    $sql$, t);
  end loop;
end;
$$;

insert into public.data_quality_backfill_runs(run_name, details)
values ('correct_locality_alias_target', jsonb_build_object(
  'removed_aliases', jsonb_build_array('Bandra (16th Road)', 'Pali Mala Road, Bandra'),
  'reason', 'No exact reference sub-locality; parent-only match would mislabel the record'
));
