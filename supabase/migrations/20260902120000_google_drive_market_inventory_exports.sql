-- Allow one private Drive snapshot to contain broker-selected shared Market Inbox listings.
alter table public.google_drive_exports
  add column if not exists market_item_refs jsonb not null default '[]'::jsonb;
