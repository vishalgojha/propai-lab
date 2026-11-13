-- Connection-level publication gate for the selected WhatsApp account.
create table if not exists public.public_market_publication_allowlist (
  tenant_id uuid primary key references public.organizations(id) on delete cascade,
  whatsapp_connection_id bigint not null references public.org_whatsapp_connections(id) on delete cascade,
  enabled boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (whatsapp_connection_id)
);
alter table public.public_market_publication_allowlist enable row level security;
revoke all on public.public_market_publication_allowlist from anon, authenticated;
create index if not exists idx_public_market_allowlist_connection on public.public_market_publication_allowlist(whatsapp_connection_id) where enabled = true;

create or replace function public.raw_message_has_public_group_source(p_raw_message_id bigint)
returns boolean language sql stable security definer set search_path = public, pg_temp
as $fn$
  select exists (
    select 1 from public.raw_messages raw
    join public.organization_group_connections group_source
      on group_source.organization_id = raw.tenant_id
     and (group_source.group_jid = coalesce(raw.raw_payload -> 'key' ->> 'remoteJid', raw.raw_payload ->> 'remoteJid', '') or group_source.group_name = coalesce(raw.group_name, ''))
    join public.public_market_publication_allowlist publication
      on publication.tenant_id = raw.tenant_id and publication.whatsapp_connection_id = group_source.whatsapp_connection_id and publication.enabled = true
    where raw.id = p_raw_message_id and raw.is_group = true and group_source.is_active = true and group_source.opted_out = false and group_source.public_market_source = true
  );
$fn$;
revoke all on function public.raw_message_has_public_group_source(bigint) from public, anon, authenticated;
-- The function returns only a boolean and is used by the anonymous projection;
-- it never returns raw text or source identity.
grant execute on function public.raw_message_has_public_group_source(bigint) to anon, authenticated, service_role;

create or replace view public.listings_unified_public as
select l.card_type, l.id, l.building_name, l.micro_market, l.bhk, l.area_sqft, l.price, l.price_unit, l.price_model, l.price_per_sqft, l.price_raw_text, l.price_qualifier, l.furnishing, l.furnishing_status, l.fitout_status, l.floor_description, l.view, l.property_view, l.location_label, l.locality_raw, l.locality_resolved, l.locality_confidence, l.landmark_name, l.street_name, l.summary_title, l.deal_tags, l.additional_charges, l.needs_review, l.created_at, l.updated_at, l.first_seen, l.last_seen, l.observation_count, l.group_count, l.representative_listing_index, l.canonical_micro_market_slug, l.source_fingerprint, l.asset_type, l.property_type, l.intent, l.transaction_type, l.transaction_nature, l.broker_id, l.fingerprint, l.developer, l.orientation, l.listing_source, l.location_raw, l.opportunity_key, l.broker_name
from public.listings_unified_public_legacy l
where exists (select 1 from public.residential_sale_listings r where l.card_type='residential_sale' and r.id=l.id and r.visibility='shared_market' and public.raw_message_has_public_group_source(r.raw_message_id))
   or exists (select 1 from public.residential_rent_listings r where l.card_type='residential_rent' and r.id=l.id and r.visibility='shared_market' and public.raw_message_has_public_group_source(r.raw_message_id))
   or exists (select 1 from public.commercial_sale_listings r where l.card_type='commercial_sale' and r.id=l.id and r.visibility='shared_market' and public.raw_message_has_public_group_source(r.raw_message_id))
   or exists (select 1 from public.commercial_rent_listings r where l.card_type='commercial_rent' and r.id=l.id and r.visibility='shared_market' and public.raw_message_has_public_group_source(r.raw_message_id));
grant select on public.listings_unified_public to anon, authenticated;
notify pgrst, 'reload schema';

insert into public.public_market_publication_allowlist (tenant_id, whatsapp_connection_id, enabled)
values ('b841327d-081c-4632-932e-8fba73b2061a', 41, true)
on conflict (tenant_id) do update set whatsapp_connection_id=excluded.whatsapp_connection_id, enabled=excluded.enabled, updated_at=now();

update public.external_agent_api_keys
set scopes = (select array_agg(distinct scope order by scope) from unnest(coalesce(scopes, '{}'::text[]) || array['raw_messages:extract']::text[]) as scope)
where revoked_at is null and lower(label) = 'instinct';
