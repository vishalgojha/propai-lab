-- Structured Crawl4AI evidence is stored separately and only promoted after
-- review/verification. These columns provide a durable destination for the
-- fields that can later be approved into the canonical building profile.
alter table public.buildings add column if not exists rera_number text;
alter table public.buildings add column if not exists amenities text[] not null default '{}';
alter table public.buildings add column if not exists completion_status text;
alter table public.buildings add column if not exists building_type text;
