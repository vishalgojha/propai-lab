-- Durable, evidence-carrying queue for building identity conflicts.
-- This queue is intentionally separate from listings: review may relink a
-- listing to a building, but never merges listing opportunities or units.
create table if not exists public.building_identity_review_queue (
  id bigint generated always as identity primary key,
  normalized_observed_name text not null,
  observed_name text not null,
  locality_context text not null default '',
  candidate_building_ids bigint[] not null default '{}',
  candidate_localities text[] not null default '{}',
  evidence jsonb not null default '{}',
  reason text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected','needs_more_evidence')),
  decision_notes text,
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (normalized_observed_name, locality_context)
);

create index if not exists idx_building_identity_review_queue_status
  on public.building_identity_review_queue(status, updated_at);

create or replace function public.refresh_building_identity_review_queue()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_count integer := 0;
  affected_count integer := 0;
begin
  -- Alias conflicts: retain all candidate buildings and their location facts
  -- so an AI or operator can compare context instead of guessing from text.
  with conflicts as (
    select lower(trim(a.alias)) as name_key,
           min(a.alias) as observed_name,
           lower(trim(coalesce(b.micro_market, ''))) as locality_key,
           array_agg(distinct a.building_id order by a.building_id) as candidate_ids,
           array_agg(distinct coalesce(b.micro_market, '[none]') order by coalesce(b.micro_market, '[none]')) as candidate_localities,
           jsonb_agg(distinct jsonb_build_object(
             'building_id', b.id,
             'canonical_name', b.canonical_name,
             'micro_market', b.micro_market,
             'address', b.address,
             'geocode_source', b.geocode_source,
             'enrichment_confidence', b.enrichment_confidence,
             'alias_source', a.source
           )) as evidence
      from public.building_name_aliases a
      join public.buildings b on b.id = a.building_id
     where nullif(trim(a.alias), '') is not null
     group by lower(trim(a.alias)), lower(trim(coalesce(b.micro_market, '')))
    having count(distinct a.building_id) > 1
  )
  insert into public.building_identity_review_queue
    (normalized_observed_name, observed_name, locality_context,
     candidate_building_ids, candidate_localities, evidence, reason)
  select name_key, observed_name, locality_key, candidate_ids,
         candidate_localities, jsonb_build_object('candidates', evidence),
         'alias_conflict'
    from conflicts
  on conflict (normalized_observed_name, locality_context) do update
    set observed_name = excluded.observed_name,
        candidate_building_ids = excluded.candidate_building_ids,
        candidate_localities = excluded.candidate_localities,
        evidence = excluded.evidence,
        updated_at = now()
  where public.building_identity_review_queue.status = 'pending';
  get diagnostics inserted_count = row_count;

  -- Named listings without a building link are also review work. Their typed
  -- source table remains the evidence boundary; this queue only summarizes it.
  with unlinked as (
    select lower(trim(building_name)) as name_key,
           min(trim(building_name)) as observed_name,
           lower(trim(coalesce(micro_market, ''))) as locality_key,
           count(*)::int as row_count,
           array_agg(distinct table_name order by table_name) as source_tables
      from (
        select 'residential_sale_listings' table_name, building_name, micro_market, building_id from public.residential_sale_listings
        union all select 'residential_rent_listings', building_name, micro_market, building_id from public.residential_rent_listings
        union all select 'commercial_sale_listings', building_name, micro_market, building_id from public.commercial_sale_listings
        union all select 'commercial_rent_listings', building_name, micro_market, building_id from public.commercial_rent_listings
      ) source_rows
     where nullif(trim(building_name), '') is not null and building_id is null
     group by lower(trim(building_name)), lower(trim(coalesce(micro_market, '')))
  )
  insert into public.building_identity_review_queue
    (normalized_observed_name, observed_name, locality_context, evidence, reason)
  select name_key, observed_name, locality_key,
         jsonb_build_object('unlinked_listing_rows', row_count, 'source_tables', source_tables),
         'unlinked_listing_name'
    from unlinked
  on conflict (normalized_observed_name, locality_context) do update
    set evidence = public.building_identity_review_queue.evidence || excluded.evidence,
        updated_at = now()
  where public.building_identity_review_queue.status = 'pending';
  get diagnostics affected_count = row_count;
  inserted_count := inserted_count + affected_count;

  return inserted_count;
end;
$$;

grant execute on function public.refresh_building_identity_review_queue() to service_role;
select public.refresh_building_identity_review_queue();
