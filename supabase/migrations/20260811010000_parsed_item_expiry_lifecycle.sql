-- Keep parsed opportunities fresh without deleting the evidence behind them.
-- A row expires after 30 days without being surfaced again by ingestion.

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'residential_sale_listings',
    'residential_rent_listings',
    'commercial_sale_listings',
    'commercial_rent_listings',
    'residential_sale_requirements',
    'residential_rent_requirements',
    'commercial_sale_requirements',
    'commercial_rent_requirements'
  ] loop
    execute format('alter table public.%I add column if not exists last_seen_at timestamptz', table_name);
    execute format('alter table public.%I add column if not exists expires_at timestamptz', table_name);
    execute format($sql$
      update public.%I
         set last_seen_at = coalesce(last_seen_at, updated_at, created_at, now()),
             expires_at = coalesce(expires_at, coalesce(last_seen_at, updated_at, created_at, now()) + interval '30 days')
       where last_seen_at is null or expires_at is null
    $sql$, table_name);
    execute format('alter table public.%I alter column last_seen_at set default now()', table_name);
    execute format('alter table public.%I alter column last_seen_at set not null', table_name);
    execute format('alter table public.%I alter column expires_at set default (now() + interval ''30 days'')', table_name);
    execute format('alter table public.%I alter column expires_at set not null', table_name);
  end loop;
end $$;

comment on column public.residential_sale_listings.last_seen_at is 'Most recent ingestion/surfacing time for this opportunity';
comment on column public.residential_sale_listings.expires_at is 'Automatic freshness expiry; refreshed when the opportunity is surfaced again';
