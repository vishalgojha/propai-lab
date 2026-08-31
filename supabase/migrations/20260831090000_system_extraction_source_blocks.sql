-- Global source suppression rules. Raw evidence is retained for audit, but
-- matching messages must never enter the typed extraction pipeline.
create table if not exists public.system_extraction_source_blocks (
  id bigint generated always as identity primary key,
  source_key text not null unique,
  display_name text not null,
  aliases jsonb not null default '[]'::jsonb,
  reason text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_system_extraction_source_blocks_active
  on public.system_extraction_source_blocks(active);

alter table public.system_extraction_source_blocks enable row level security;

drop policy if exists "super_admin_read_system_extraction_source_blocks" on public.system_extraction_source_blocks;
create policy "super_admin_read_system_extraction_source_blocks"
  on public.system_extraction_source_blocks for select
  using (public.is_super_admin());

-- Gurukrupa is a deliberate global opt-out. Include the spelling observed in
-- broker signatures so a typo in the source does not bypass the block.
insert into public.system_extraction_source_blocks
  (source_key, display_name, aliases, reason)
values
  ('gurukrupa', 'Gurukrupa', '["gurukirpa"]'::jsonb,
   'Global source exclusion requested by PropAI operator')
on conflict (source_key) do update set
  display_name = excluded.display_name,
  aliases = excluded.aliases,
  reason = excluded.reason,
  active = true,
  updated_at = now();
