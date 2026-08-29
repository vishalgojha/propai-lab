-- Backfill the atomic exact-repost claims from existing parsed evidence.
-- Prefer the earliest raw event that has typed output; do not claim a group
-- whose historical baseline never produced parsed evidence.
with typed_raw as (
    select distinct raw_message_id
    from public.residential_sale_listings
    union all select distinct raw_message_id from public.residential_rent_listings
    union all select distinct raw_message_id from public.commercial_sale_listings
    union all select distinct raw_message_id from public.commercial_rent_listings
    union all select distinct raw_message_id from public.residential_sale_requirements
    union all select distinct raw_message_id from public.residential_rent_requirements
    union all select distinct raw_message_id from public.commercial_sale_requirements
    union all select distinct raw_message_id from public.commercial_rent_requirements
), baselines as (
    select distinct on (r.tenant_id, r.author_content_fingerprint)
        r.tenant_id,
        r.author_content_fingerprint,
        r.id as first_raw_message_id
    from public.raw_messages r
    join typed_raw t on t.raw_message_id = r.id
    where r.author_content_fingerprint is not null
    order by r.tenant_id, r.author_content_fingerprint, r.id
)
insert into public.raw_message_dedupe_claims (
    tenant_id, author_content_fingerprint, first_raw_message_id
)
select tenant_id, author_content_fingerprint, first_raw_message_id
from baselines
on conflict (tenant_id, author_content_fingerprint) do nothing;

with typed_raw as (
    select distinct raw_message_id
    from public.residential_sale_listings
    union all select distinct raw_message_id from public.residential_rent_listings
    union all select distinct raw_message_id from public.commercial_sale_listings
    union all select distinct raw_message_id from public.commercial_rent_listings
    union all select distinct raw_message_id from public.residential_sale_requirements
    union all select distinct raw_message_id from public.residential_rent_requirements
    union all select distinct raw_message_id from public.commercial_sale_requirements
    union all select distinct raw_message_id from public.commercial_rent_requirements
), baselines as (
    select tenant_id, author_content_fingerprint, first_raw_message_id
    from public.raw_message_dedupe_claims
)
update public.raw_messages r
set repeat_of_raw_message_id = b.first_raw_message_id,
    processed = true,
    processed_at = coalesce(r.processed_at, now()),
    extraction_outcome = 'repeat_observation'
from baselines b
where r.tenant_id = b.tenant_id
  and r.author_content_fingerprint = b.author_content_fingerprint
  and r.id > b.first_raw_message_id
  and r.parent_message_id is null
  and r.repeat_of_raw_message_id is null;
