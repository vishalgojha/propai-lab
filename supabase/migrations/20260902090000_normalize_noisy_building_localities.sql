-- Normalize an unambiguous known Mumbai locality embedded in polluted
-- WhatsApp context before it becomes a building identity key.
-- Example: "Near Lilavati Hospital, Reclamation, Bandra West Fully Furnished"
-- becomes "Bandra West". Raw locality evidence on typed rows is untouched.
create temporary table _normalized_building_localities on commit drop as
with locality_candidates(label) as (
  values
    ('Andheri East'), ('Andheri West'), ('Bandra East'), ('Bandra West'),
    ('Bandra Kurla Complex'), ('Borivali West'), ('Chembur'), ('Colaba'),
    ('Dadar'), ('Goregaon East'), ('Goregaon West'), ('Juhu'),
    ('Khar East'), ('Khar West'), ('Lower Parel'), ('Malad East'),
    ('Malad West'), ('Mahim'), ('Mahalaxmi'), ('Marine Lines'),
    ('Matunga'), ('Pali Hill'), ('Powai'), ('Prabhadevi'),
    ('Santacruz East'), ('Santacruz West'), ('Tardeo'), ('Thane'),
    ('Vile Parle East'), ('Vile Parle West'), ('Worli')
), matches as (
  select b.id, b.tenant_id, b.canonical_name, c.label,
         count(*) over (partition by b.id) as candidate_count,
         row_number() over (partition by b.id order by length(c.label) desc) as candidate_rank
    from public.buildings b
    join locality_candidates c
      on lower(b.micro_market) ~ ('(^|[^a-z])' || lower(c.label) || '([^a-z]|$)')
   where b.micro_market is not null
     and lower(trim(b.micro_market)) <> lower(c.label)
     and length(trim(b.micro_market)) > length(c.label) + 8
), eligible as (
  select m.*,
         regexp_replace(lower(m.label), '[^a-z0-9]+', '-', 'g') as locality_slug
    from matches m
   where m.candidate_count = 1 and m.candidate_rank = 1
     and not exists (
       select 1
         from public.buildings same_name
        where same_name.id <> m.id
          and same_name.tenant_id is not distinct from m.tenant_id
          and lower(trim(same_name.canonical_name)) = lower(trim(m.canonical_name))
          and same_name.canonical_micro_market_slug = regexp_replace(lower(m.label), '[^a-z0-9]+', '-', 'g')
     )
)
select id, label, locality_slug from eligible;

update public.buildings b
   set micro_market = n.label,
       canonical_micro_market_slug = n.locality_slug,
       updated_at = now()
  from _normalized_building_localities n
 where b.id = n.id;

-- A normalized discovered building should be eligible for its existing
-- provider job again; this does not call Google itself.
update public.building_enrichment_jobs j
   set status = 'pending', attempts = 0, last_error = null,
       scheduled_after = now(), started_at = null, completed_at = null,
       priority = greatest(coalesce(priority, 0), 20)
  from _normalized_building_localities n
 where j.building_id = n.id
   and j.provider = 'google_places'
   and j.status not in ('pending', 'running')
   and not exists (
     select 1
       from public.building_enrichment_jobs active
      where active.building_id = j.building_id
        and active.provider = j.provider
        and active.status in ('pending', 'running')
        and active.id <> j.id
   )
   and j.id = (
     select max(latest.id)
       from public.building_enrichment_jobs latest
      where latest.building_id = j.building_id
        and latest.provider = j.provider
        and latest.status not in ('pending', 'running')
   );

select public.refresh_building_identity_review_queue();
