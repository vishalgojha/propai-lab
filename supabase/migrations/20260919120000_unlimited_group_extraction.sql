alter table public.organizations
  add column if not exists unlimited_group_extraction boolean not null default false;

comment on column public.organizations.unlimited_group_extraction is
  'Flagged workspaces parse every group on their primary WhatsApp connection without per-group selection.';