-- The item-aware Market Inbox RPC unions eight typed tables and filters by
-- normalized broker phone.  Without expression indexes Postgres scans every
-- typed table before applying the phone filter, which makes the inbox's
-- selected-broker refresh hit the frontend timeout.

create index if not exists residential_sale_listings_broker_phone_seen_idx
  on public.residential_sale_listings
  (right(regexp_replace(coalesce(broker_phone, ''), '\D', '', 'g'), 10), created_at desc);
create index if not exists residential_rent_listings_broker_phone_seen_idx
  on public.residential_rent_listings
  (right(regexp_replace(coalesce(broker_phone, ''), '\D', '', 'g'), 10), created_at desc);
create index if not exists commercial_sale_listings_broker_phone_seen_idx
  on public.commercial_sale_listings
  (right(regexp_replace(coalesce(broker_phone, ''), '\D', '', 'g'), 10), created_at desc);
create index if not exists commercial_rent_listings_broker_phone_seen_idx
  on public.commercial_rent_listings
  (right(regexp_replace(coalesce(broker_phone, ''), '\D', '', 'g'), 10), created_at desc);
create index if not exists residential_sale_requirements_broker_phone_seen_idx
  on public.residential_sale_requirements
  (right(regexp_replace(coalesce(broker_phone, ''), '\D', '', 'g'), 10), created_at desc);
create index if not exists residential_rent_requirements_broker_phone_seen_idx
  on public.residential_rent_requirements
  (right(regexp_replace(coalesce(broker_phone, ''), '\D', '', 'g'), 10), created_at desc);
create index if not exists commercial_sale_requirements_broker_phone_seen_idx
  on public.commercial_sale_requirements
  (right(regexp_replace(coalesce(broker_phone, ''), '\D', '', 'g'), 10), created_at desc);
create index if not exists commercial_rent_requirements_broker_phone_seen_idx
  on public.commercial_rent_requirements
  (right(regexp_replace(coalesce(broker_phone, ''), '\D', '', 'g'), 10), created_at desc);

notify pgrst, 'reload schema';
