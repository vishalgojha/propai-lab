-- The remaining Platinum Life registry row has no source address or place ID
-- and therefore cannot be safely merged with the enriched row. Keep it as a
-- separate identity with a stable registry suffix, without deleting data.
update public.buildings
set canonical_name = 'Platinum Life · registry 17911', updated_at = now()
where id = 17911
  and canonical_name = '*platinum Life*';
